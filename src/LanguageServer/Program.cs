// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OmniSharp.Extensions.LanguageServer.Server;
using LanguageServerHost = OmniSharp.Extensions.LanguageServer.Server.LanguageServer;

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
        var logFile = System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows)
            ? Path.Combine(Path.GetTempPath(), "gsharp-lsp-debug.log")
            : "/tmp/gsharp-lsp-debug.log";

        File.AppendAllText(logFile, $"\n\n--- SERVER START ---\nArgs: {string.Join(" ", args)}\n");

        AppDomain.CurrentDomain.UnhandledException += (s, e) =>
        {
            File.AppendAllText(logFile, $"UNHANDLED EXCEPTION: {e.ExceptionObject}\n");
        };
        TaskScheduler.UnobservedTaskException += (s, e) =>
        {
            File.AppendAllText(logFile, $"UNOBSERVED TASK EXCEPTION: {e.Exception}\n");
            e.SetObserved();
        };

        var pipeName = GetPipeName(args);
        File.AppendAllText(logFile, $"Resolved pipe name: {pipeName ?? "NULL"}\n");

        try
        {
            if (pipeName != null)
            {
                await RunWithPipeTransportAsync(pipeName, logFile);
            }
            else
            {
                await RunWithStdioTransportAsync();
            }
        }
        catch (Exception ex)
        {
            File.AppendAllText(logFile, $"FATAL ERROR: {ex}\n");
            throw;
        }
    }

    private static async Task RunWithPipeTransportAsync(string pipeName, string logFile)
    {
        Stream stream;
        File.AppendAllText(logFile, "Starting pipe connection...\n");

        if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows))
        {
            // On Windows, vscode-languageclient creates a Windows Named Pipe at \\.\pipe\<name>.
            // NamedPipeClientStream expects just the pipe name (after \\.\pipe\).
            const string pipePrefix = @"\\.\pipe\";
            var name = pipeName.StartsWith(pipePrefix, StringComparison.OrdinalIgnoreCase)
                ? pipeName.Substring(pipePrefix.Length)
                : pipeName;

            File.AppendAllText(logFile, $"Windows Named Pipe connecting to: {name}\n");
            var pipeStream = new System.IO.Pipes.NamedPipeClientStream(".", name, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous);
            await pipeStream.ConnectAsync();
            stream = pipeStream;
        }
        else
        {
            // On Unix/macOS, vscode-languageclient creates a Unix domain socket at the given path.
            // We must connect with a raw socket, NOT NamedPipeClientStream (which prepends /tmp/CoreFxPipe_).
            File.AppendAllText(logFile, $"Unix socket connecting to: {pipeName}\n");
            var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.Unix, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Unspecified);
            var endpoint = new System.Net.Sockets.UnixDomainSocketEndPoint(pipeName);
            await socket.ConnectAsync(endpoint);
            stream = new System.Net.Sockets.NetworkStream(socket, ownsSocket: true);
        }

        File.AppendAllText(logFile, "Pipe connected successfully. Creating LanguageServerHost...\n");

        // Let's create two separate streams from the same socket/pipe to ensure clean thread-safe duplex
        Stream inputStream = new LoggingStream(stream, logFile, "IN");
        Stream outputStream = new LoggingStream(stream, logFile, "OUT");
        if (stream is System.Net.Sockets.NetworkStream ns)
        {
            // NetworkStream is duplex, but just in case OmniSharp assumes separate instances
            // Actually, NetworkStream is perfectly safe for simultaneous read/write.
        }

        var server = await CreateServerAsync(inputStream, outputStream);
        File.AppendAllText(logFile, "LanguageServerHost created. Waiting for exit...\n");
        await server.WaitForExit;
        File.AppendAllText(logFile, "Server exited gracefully.\n");
    }

    private static async Task RunWithStdioTransportAsync()
    {
        var server = await CreateServerAsync(Console.OpenStandardInput(), Console.OpenStandardOutput());
        await server.WaitForExit;
    }

    private static Task<LanguageServerHost> CreateServerAsync(Stream input, Stream output)
    {
        return LanguageServerHost.From(options =>
            options
                .WithInput(input)
                .WithOutput(output)
                .ConfigureLogging(builder =>
                {
                    // Only log warnings and above to avoid polluting the stdio transport
                    builder.SetMinimumLevel(LogLevel.Warning);
                })
                .WithServices(ConfigureServices)
                .WithHandler<DocumentSyncHandler>()
                .WithHandler<FoldingHandler>()
                .WithHandler<HoverHandler>()
                .WithHandler<DefinitionHandler>()
                .WithHandler<DocumentSymbolHandler>()
                .WithHandler<DocumentHighlightHandler>()
                .WithHandler<SignatureHelpHandler>()
                .WithHandler<CompletionHandler>()
                .WithHandler<ReferencesHandler>()
                .WithHandler<RenameHandler>()
                .WithHandler<CodeActionHandler>()
                .WithHandler<SemanticTokensHandler>()
                .WithHandler<WorkspaceSymbolHandler>()
                .WithHandler<InlayHintHandler>()
                .WithHandler<CodeLensHandler>()
                .WithHandler<FormattingHandler>()
                .WithHandler<RangeFormattingHandler>()
                .WithHandler<OnTypeFormattingHandler>()
                .WithHandler<PrepareRenameHandler>()
                .WithHandler<ImplementationHandler>()
                .WithHandler<TypeDefinitionHandler>()
                .WithHandler<SelectionRangeHandler>()
                .WithHandler<DiagnosticHandler>()
                .WithHandler<LinkedEditingRangeHandler>()
                .WithHandler<FileWatchHandler>()
                .OnInitialize((server, request, ct) =>
                {
                    var initializer = server.Services.GetRequiredService<WorkspaceInitializer>();
                    return initializer.OnInitialize(server, request, ct);
                }));
    }

    private static string GetPipeName(string[] args)
    {
        // vscode-languageclient passes --pipe=<name> for named pipe transport
        var pipeArg = args.FirstOrDefault(a => a.StartsWith("--pipe=", StringComparison.OrdinalIgnoreCase));
        return pipeArg != null ? pipeArg.Substring("--pipe=".Length) : null;
    }

    private static void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<DocumentContentService>();
        services.AddSingleton<WorkspaceState>();
        services.AddSingleton<WorkspaceInitializer>();
    }

    private class LoggingStream : Stream
    {
        private readonly Stream inner;
        private readonly string logFile;
        private readonly string prefix;
        private readonly object lockObj = new object();

        public LoggingStream(Stream inner, string logFile, string prefix)
        {
            this.inner = inner;
            this.logFile = logFile;
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
            this.LogRead(buffer, offset, read);
            return read;
        }

        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            int read = await this.inner.ReadAsync(buffer, offset, count, cancellationToken);
            this.LogRead(buffer, offset, read);
            return read;
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            this.inner.Write(buffer, offset, count);
            this.LogWrite(buffer, offset, count);
        }

        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            await this.inner.WriteAsync(buffer, offset, count, cancellationToken);
            this.LogWrite(buffer, offset, count);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                this.inner.Dispose();
            }

            base.Dispose(disposing);
        }

        private void LogRead(byte[] buffer, int offset, int count)
        {
            if (count > 0)
            {
                var text = System.Text.Encoding.UTF8.GetString(buffer, offset, count);
                lock (this.lockObj)
                {
                    File.AppendAllText(this.logFile, $"[{this.prefix} READ] {text}\n");
                }
            }
        }

        private void LogWrite(byte[] buffer, int offset, int count)
        {
            if (count > 0)
            {
                var text = System.Text.Encoding.UTF8.GetString(buffer, offset, count);
                lock (this.lockObj)
                {
                    File.AppendAllText(this.logFile, $"[{this.prefix} WRITE] {text}\n");
                }
            }
        }
    }
}
