// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import GSharp.Core.CodeAnalysis.Diagnostics
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import StreamJsonRpc
import System.IO.Pipes
import System.Net.Sockets
import System.Runtime.InteropServices
import System.Text

/// GSharp Language Server.
open class Program {
    private class LoggingStream : Stream {
        private let inner Stream
        private let logger ILogger
        private let prefix string

        init(inner Stream, logger ILogger, prefix string) {
            this.inner = inner
            this.logger = logger
            this.prefix = prefix
        }

        override prop CanRead bool -> this.inner.CanRead
        override prop CanSeek bool -> this.inner.CanSeek
        override prop CanWrite bool -> this.inner.CanWrite
        override prop Length int64 -> this.inner.Length

        override prop Position int64 {
            get -> this.inner.Position
            set -> this.inner.Position = value
        }

        override func Flush() -> this.inner.Flush()

        override func FlushAsync(cancellationToken CancellationToken) Task -> this.inner.FlushAsync(cancellationToken)

        override func Seek(offset int64, origin SeekOrigin) int64 -> this.inner.Seek(offset, origin)

        override func SetLength(value int64) -> this.inner.SetLength(value)

        override func Read(buffer[]uint8, offset int32, count int32) int32 {
            let read = this.inner.Read(buffer, offset, count)
            this.Log(buffer, offset, read)
            return read
        }

        override async func ReadAsync(
            buffer[]uint8,
            offset int32,
            count int32,
            cancellationToken CancellationToken
        ) int32 {
            let read = await this.inner.ReadAsync(buffer, offset, count, cancellationToken)
            this.Log(buffer, offset, read)
            return read
        }

        override func Write(buffer[]uint8, offset int32, count int32) {
            this.inner.Write(buffer, offset, count)
            this.Log(buffer, offset, count)
        }

        override async func WriteAsync(buffer[]uint8, offset int32, count int32, cancellationToken CancellationToken) {
            await this.inner.WriteAsync(buffer, offset, count, cancellationToken)
            this.Log(buffer, offset, count)
        }

        protected override func Dispose(disposing bool) {
            if disposing {
                this.inner.Dispose()
            }
            base.Dispose(disposing)
        }

        private func Log(buffer[]uint8, offset int32, count int32) {
            if count <= 0 {
                return
            }
            let text = Encoding.UTF8.GetString(buffer, offset, count)
            this.logger.LogDebug("[${this.prefix}] $text")
        }
    }

    shared {
        /// Entry point for GSharp LanguageServer.
        /// @param args Command line arguments.
        /// @returns A (cref:Task) representing the asynchronous operation.
        async func Main(args[]string) {
            if ShouldWaitForDebugger(args) {
                await Console.Error.WriteLineAsync(
                    "Waiting for debugger attachment to process ${Environment.ProcessId}."
                )
                while !Debugger.IsAttached {
                    await Task.Delay(100)
                }
                Debugger.Break()
            }
            var logger ILogger = NullLogger.Instance
            let logFile string? = GetLogPath(args, Environment.GetEnvironmentVariable("GSHARP_LSP_TRACE_PATH"))
            if logFile != nil {
                logger = FileLogger(logFile)
                logger.LogInfo("Server start. Args: ${string.Join(" ", args)}")
            }
            AppDomain.CurrentDomain.UnhandledException += (s object, e UnhandledExceptionEventArgs) -> {
                logger.LogError("Unhandled exception", e.ExceptionObject as Exception)
            }
            let pipeName string? = GetPipeName(args)
            var stream Stream? = nil
            var sending Stream
            var receiving Stream
            if pipeName != nil {
                let connectedStream = await ConnectPipeAsync(pipeName)
                stream = connectedStream
                sending = connectedStream
                receiving = connectedStream
            } else {
                sending = Console.OpenStandardOutput()
                receiving = Console.OpenStandardInput()
            }
            if logger.IsEnabled(LogLevel.Debug) {
                sending = LoggingStream(sending, logger, "OUT")
                receiving = LoggingStream(receiving, logger, "IN")
            }
            try {
                await RunAsync(sending, receiving, logger)
            } catch (ex Exception) {
                logger.LogError("Fatal error", ex)
                rethrow
            } finally {
                if stream != nil {
                    await stream.DisposeAsync()
                }
                (logger as IDisposable)?.Dispose()
            }
        }

        internal func ShouldWaitForDebugger(args[]string) bool -> args.Any(
            (arg string) -> string.Equals(arg, "--debug", StringComparison.OrdinalIgnoreCase)
        )

        /// Resolves the debug log file path from the command line or protocol trace environment.
        /// @param args The language-server command-line arguments.
        /// @param tracePath The optional trace path supplied by the host environment.
        /// @returns The requested log path, or `null` when logging is disabled.
        internal func GetLogPath(args[]string, tracePath string? = nil) string? {
            let logArg string? = args.FirstOrDefault(
                (a string) -> string.Equals(a, "--log", StringComparison.OrdinalIgnoreCase) || a.StartsWith(
                    "--log=",
                    StringComparison.OrdinalIgnoreCase
                )
            )
            if logArg == nil {
                return if string.IsNullOrWhiteSpace(tracePath) {
                    default(string?)
                } else {
                    tracePath!!.Trim()
                }
            }
            let separatorIndex = logArg.IndexOf('=')
            if separatorIndex >= 0 {
                let path = logArg.Substring(separatorIndex + 1).Trim()
                if !string.IsNullOrEmpty(path) {
                    return path
                }
            }
            return DiagnosticLogPaths.GetDefaultFilePath("gsharp-lsp-debug.log")
        }

        private async func RunAsync(sending Stream, receiving Stream, logger ILogger) {
            let documentContentService = DocumentContentService()
            let workspaceState = WorkspaceState()
            let target = LspServer(documentContentService, workspaceState, logger)
            let formatter = SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
            let handler = HeaderDelimitedMessageHandler(sending, receiving, formatter)
            let rpc = JsonRpc(handler)
            rpc.AddLocalRpcTarget(target, JsonRpcTargetOptions{DisposeOnDisconnect: false})
            target.Attach(rpc)
            rpc.StartListening()
            await target.WaitForExit
        }

        private async func ConnectPipeAsync(pipeName string) Stream {
            if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) {
                const pipePrefix = "\\\\.\\pipe\\"
                let name = if pipeName.StartsWith(pipePrefix, StringComparison.OrdinalIgnoreCase) {
                    pipeName.Substring(pipePrefix.Length)
                } else {
                    pipeName
                }
                let pipeStream = NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous)
                await pipeStream.ConnectAsync()
                return pipeStream
            }
            let socket = Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            let endpoint = UnixDomainSocketEndPoint(pipeName)
            await socket.ConnectAsync(endpoint)
            return NetworkStream(socket, ownsSocket: true)
        }

        private func GetPipeName(args[]string) string? {
            let pipeArg string? = args.FirstOrDefault(
                (a string) -> a.StartsWith("--pipe=", StringComparison.OrdinalIgnoreCase)
            )
            return if pipeArg != nil {
                pipeArg.Substring("--pipe=".Length)
            } else {
                default(string?)
            }
        }
    }
}
