// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using StreamJsonRpc;

namespace GSharp.LanguageServer;

/// <summary>
/// GSharp Language Server.
/// </summary>
public class Program
{
    /// <summary>
    /// Entry point for GSharp LanguageServer.
    /// </summary>
    /// <param name="args">Command line arguments.</param>
    /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
    public static async Task Main(string[] args)
    {
        if (ShouldWaitForDebugger(args))
        {
            await Console.Error.WriteLineAsync(
                $"Waiting for debugger attachment to process {Environment.ProcessId}.");
            while (!Debugger.IsAttached)
            {
                await Task.Delay(100);
            }

            Debugger.Break();
        }

        ILogger logger = NullLogger.Instance;
        var logFile = GetLogPath(
            args,
            Environment.GetEnvironmentVariable("GSHARP_LSP_TRACE_PATH"));
        if (logFile != null)
        {
            logger = new FileLogger(logFile);
            logger.LogInfo($"Server start. Args: {string.Join(" ", args)}");
        }

        AppDomain.CurrentDomain.UnhandledException += (s, e) =>
        {
            logger.LogError("Unhandled exception", e.ExceptionObject as Exception);
        };

        var pipeName = GetPipeName(args);

        Stream stream = null;
        Stream sending;
        Stream receiving;

        if (pipeName != null)
        {
            stream = await ConnectPipeAsync(pipeName);
            sending = stream;
            receiving = stream;
        }
        else
        {
            sending = Console.OpenStandardOutput();
            receiving = Console.OpenStandardInput();
        }

        if (logger.IsEnabled(LogLevel.Debug))
        {
            sending = new LoggingStream(sending, logger, "OUT");
            receiving = new LoggingStream(receiving, logger, "IN");
        }

        try
        {
            await RunAsync(sending, receiving, logger);
        }
        catch (Exception ex)
        {
            logger.LogError("Fatal error", ex);
            throw;
        }
        finally
        {
            if (stream != null)
            {
                await stream.DisposeAsync();
            }

            (logger as IDisposable)?.Dispose();
        }
    }

    internal static bool ShouldWaitForDebugger(string[] args)
        => args.Any(arg => string.Equals(arg, "--debug", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Resolves the debug log file path from the command line or protocol trace environment.
    /// </summary>
    /// <param name="args">The language-server command-line arguments.</param>
    /// <param name="tracePath">The optional trace path supplied by the host environment.</param>
    /// <returns>The requested log path, or <see langword="null"/> when logging is disabled.</returns>
    internal static string GetLogPath(string[] args, string tracePath = null)
    {
        var logArg = args.FirstOrDefault(a =>
            string.Equals(a, "--log", StringComparison.OrdinalIgnoreCase) ||
            a.StartsWith("--log=", StringComparison.OrdinalIgnoreCase));

        if (logArg == null)
        {
            return string.IsNullOrWhiteSpace(tracePath) ? null : tracePath.Trim();
        }

        var separatorIndex = logArg.IndexOf('=');
        if (separatorIndex >= 0)
        {
            var path = logArg.Substring(separatorIndex + 1).Trim();
            if (!string.IsNullOrEmpty(path))
            {
                return path;
            }
        }

        return DiagnosticLogPaths.GetDefaultFilePath("gsharp-lsp-debug.log");
    }

    private static async Task RunAsync(Stream sending, Stream receiving, ILogger logger)
    {
        var documentContentService = new DocumentContentService();
        var workspaceState = new WorkspaceState();
        var target = new LspServer(documentContentService, workspaceState, logger);

        var formatter = new SystemTextJsonFormatter { JsonSerializerOptions = LspJson.Options };
        var handler = new HeaderDelimitedMessageHandler(sending, receiving, formatter);
        var rpc = new JsonRpc(handler);
        rpc.AddLocalRpcTarget(target, new JsonRpcTargetOptions { DisposeOnDisconnect = false });
        target.Attach(rpc);
        rpc.StartListening();

        await target.WaitForExit;
    }

    private static async Task<Stream> ConnectPipeAsync(string pipeName)
    {
        if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows))
        {
            const string pipePrefix = @"\\.\pipe\";
            var name = pipeName.StartsWith(pipePrefix, StringComparison.OrdinalIgnoreCase)
                ? pipeName.Substring(pipePrefix.Length)
                : pipeName;

            var pipeStream = new System.IO.Pipes.NamedPipeClientStream(".", name, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous);
            await pipeStream.ConnectAsync();
            return pipeStream;
        }

        var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.Unix, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Unspecified);
        var endpoint = new System.Net.Sockets.UnixDomainSocketEndPoint(pipeName);
        await socket.ConnectAsync(endpoint);
        return new System.Net.Sockets.NetworkStream(socket, ownsSocket: true);
    }

    private static string GetPipeName(string[] args)
    {
        var pipeArg = args.FirstOrDefault(a => a.StartsWith("--pipe=", StringComparison.OrdinalIgnoreCase));
        return pipeArg != null ? pipeArg.Substring("--pipe=".Length) : null;
    }

    private sealed class LoggingStream : Stream
    {
        private readonly Stream inner;
        private readonly ILogger logger;
        private readonly string prefix;

        public LoggingStream(Stream inner, ILogger logger, string prefix)
        {
            this.inner = inner;
            this.logger = logger;
            this.prefix = prefix;
        }

        public override bool CanRead => this.inner.CanRead;

        public override bool CanSeek => this.inner.CanSeek;

        public override bool CanWrite => this.inner.CanWrite;

        public override long Length => this.inner.Length;

        public override long Position { get => this.inner.Position; set => this.inner.Position = value; }

        public override void Flush() => this.inner.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken) => this.inner.FlushAsync(cancellationToken);

        public override long Seek(long offset, SeekOrigin origin) => this.inner.Seek(offset, origin);

        public override void SetLength(long value) => this.inner.SetLength(value);

        public override int Read(byte[] buffer, int offset, int count)
        {
            int read = this.inner.Read(buffer, offset, count);
            this.Log(buffer, offset, read);
            return read;
        }

        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            int read = await this.inner.ReadAsync(buffer, offset, count, cancellationToken);
            this.Log(buffer, offset, read);
            return read;
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            this.inner.Write(buffer, offset, count);
            this.Log(buffer, offset, count);
        }

        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            await this.inner.WriteAsync(buffer, offset, count, cancellationToken);
            this.Log(buffer, offset, count);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                this.inner.Dispose();
            }

            base.Dispose(disposing);
        }

        private void Log(byte[] buffer, int offset, int count)
        {
            if (count <= 0)
            {
                return;
            }

            var text = System.Text.Encoding.UTF8.GetString(buffer, offset, count);
            this.logger.LogDebug($"[{this.prefix}] {text}");
        }
    }
}
