package Gsharp.NET.Sdk.Tools

import GSharp.Workers
import Microsoft.Build.Framework
import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Runtime.InteropServices
import System.Text
import System.Threading
import System.Threading.Tasks
import SystemObject = System.Object

/// One serial worker per tool and MSBuild node, disposed at the end of the build.
internal class WorkerProcessClient : IDisposable {
    private let gate object = SystemObject()
    private var process Process?
    private var reader BinaryReader?
    private var writer BinaryWriter?
    private var identity string?
    private var toolPath string?
    private var workerEnvironment Dictionary[string, string]?
    private var idleTimer Timer?
    private var lastActivity int64
    private var protocol NamedPipeServerStream?
    private var nativeOut WorkerDiagnosticCapture?
    private var nativeError WorkerDiagnosticCapture?
    private var containedProcess int32

    internal func TryRun(
        path string,
        workerFlag string,
        directory string,
        arguments[]string,
        workerGrant int32,
        cancellation CancellationToken,
        stdout(string) -> void,
        stderr(string) -> void,
        transportMessage(string) -> void,
        out exitCode int32
    ) bool {
        lock gate {
            exitCode = 1
            var completedExchange = false
            var acceptedRequest = false
            var retireWorker = false
            var requestFailure Exception? = nil
            idleTimer?.Change(Timeout.Infinite, Timeout.Infinite)
            try {
                cancellation.ThrowIfCancellationRequested()
                let requestedIdentity = WorkerProtocol.ToolIdentity(path)
                let environment = Dictionary[string, string](StringComparer.Ordinal)
                for entry DictionaryEntry in Environment.GetEnvironmentVariables() {
                    environment.Add(cast[string](entry.Key), cast[string](entry.Value))
                }
                if process?.HasExited != false ||
                    identity != requestedIdentity ||
                    toolPath != path ||
                    IdleExpired() ||
                    !SameEnvironment(environment, workerEnvironment) {
                    Dispose()
                    try {
                        Start(path, workerFlag, requestedIdentity, environment, cancellation)
                    } catch (ex Exception) when ex is IOException ||
                        ex is System
                        .ComponentModel
                        .Win32Exception ||
                        ex is InvalidOperationException ||
                        ex is ArgumentException ||
                        ex is NotSupportedException ||
                        ex is TimeoutException {
                        cancellation.ThrowIfCancellationRequested()
                        transportMessage("G# worker unavailable; using standalone tool: ${ex.Message}")
                        return false
                    }
                }
                let activeProcess = process ?? throw InvalidOperationException("Worker was not started.")
                using let registration = cancellation.Register(() -> Kill(activeProcess))
                // Once a request is sent, transport loss is a failure, not a retry.
                try {
                    let fence = "\u001egsharp-" + Guid.NewGuid().ToString("N") + "\u001f"
                    nativeOut?.Begin(fence)
                    nativeError?.Begin(fence)
                    WorkerProtocol.WriteRequest(
                        writer ?? throw InvalidOperationException("Worker input is unavailable."),
                        requestedIdentity,
                        directory,
                        arguments,
                        environment,
                        workerGrant,
                        fence
                    )
                    let input = reader ?? throw InvalidOperationException("Worker output is unavailable.")
                    let status = input.ReadByte()
                    if status == WorkerProtocol.Rejected {
                        transportMessage("G# worker rejected request; using standalone tool: ${input.ReadString()}")
                        return false
                    }
                    if status != WorkerProtocol.Accepted {
                        throw InvalidDataException("Worker did not acknowledge the request.")
                    }
                    acceptedRequest = true
                    transportMessage("G# worker accepted request: pid=${activeProcess.Id}.")
                    while true {
                        let kind = input.ReadByte()
                        switch kind {
                            case WorkerProtocol.Completed {
                                exitCode = input.ReadInt32()
                                let serverRetire = input.ReadBoolean()
                                let retained = input.ReadInt64()
                                let workingSet = input.ReadInt64()
                                let _out = nativeOut?.Complete(cancellation, stdout)
                                let _error = nativeError?.Complete(cancellation, stderr)
                                retireWorker = serverRetire
                                cancellation.ThrowIfCancellationRequested()
                                transportMessage(
                                    "G# worker completed: pid=${activeProcess.Id}, retained=$retained bytes, workingSet=$workingSet bytes, retire=$retireWorker."
                                )
                                completedExchange = true
                                return true
                            }
                            default {
                                throw InvalidDataException("Unexpected worker response.")
                            }
                        }
                    }
                } catch (ex Exception) when ex is IOException ||
                    ex is InvalidDataException ||
                    ex is FormatException ||
                    ex is DecoderFallbackException ||
                    ex is InvalidOperationException ||
                    ex is System
                    .ComponentModel
                    .Win32Exception {
                    let detail = nativeOut?.FailureMessage() ?? nativeError?.FailureMessage() ?? ex.Message
                    cancellation.ThrowIfCancellationRequested()
                    throw IOException("Worker request transport failed: $detail", ex)
                }
            } catch (ex Exception) {
                requestFailure = ex
                rethrow
            } finally {
                if completedExchange && !retireWorker && process?.HasExited == false {
                    lastActivity = Stopwatch.GetTimestamp()
                    idleTimer?.Dispose()
                    idleTimer = Timer(
                        (_state object?) -> RetireIdleWorker(),
                        nil,
                        WorkerProtocol.IdleMilliseconds,
                        Timeout.Infinite
                    )
                } else {
                    try {
                        FinishProcess(acceptedRequest, stdout, stderr, transportMessage)
                    } catch (ex Exception) when requestFailure != nil {
                        // Cleanup and logger failures cannot replace the original request failure.

                    }
                }
            }
        }
    }

    private func IdleExpired() bool -> lastActivity != 0 && Stopwatch.GetTimestamp() - lastActivity >=
    int64(WorkerProtocol.IdleMilliseconds) * Stopwatch.Frequency / 1000

    private func RetireIdleWorker() {
        lock gate {
            if IdleExpired() {
                Dispose()
            }
        }
    }

    private func Start(
        path string,
        flag string,
        requestedIdentity string,
        environment Dictionary[string, string],
        cancellation CancellationToken
    ) {
        if typeof(Process).GetMethod("Kill", []Type{typeof(bool)}) == nil {
            throw InvalidOperationException("This MSBuild runtime cannot cancel a worker process tree.")
        }
        let pipeName = CreateProtocolPipeName()
        let pipe = NamedPipeServerStream(
            pipeName,
            PipeDirection.In,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | cast[PipeOptions](0x20000000)
        )
        protocol = pipe
        let start = CreateStartInfo(path, flag, pipeName)
        start.EnvironmentVariables.Clear()
        for entry in environment {
            start.EnvironmentVariables.Add(entry.Key, entry.Value)
        }
        let child = Process.Start(start) ?? throw IOException("Cannot start worker.")
        process = child
        nativeOut = WorkerDiagnosticCapture(child.StandardOutput, () -> Kill(child))
        nativeError = WorkerDiagnosticCapture(child.StandardError, () -> Kill(child))
        child.Exited += (_sender object, _event EventArgs) -> {
            try {
                if !pipe.IsConnected {
                    pipe.Dispose()
                }
            } catch (ex ObjectDisposedException) {
                // Startup cleanup already closed the private channel.

            }
        }
        child.EnableRaisingEvents = true
        let input = BinaryReader(pipe, Encoding.UTF8)
        reader = input
        writer = BinaryWriter(child.StandardInput.BaseStream, Encoding.UTF8)
        using let registration = cancellation.Register(() -> Kill(child))
        let handshake = Task.Run(
            () -> {
                pipe.WaitForConnection()
                if input.ReadInt32() != WorkerProtocol.Version || input.ReadString() != requestedIdentity {
                    throw InvalidDataException("Worker SDK identity or protocol version differs.")
                }
            }
        )
        try {
            if !handshake.Wait(30000) {
                throw TimeoutException("Worker handshake timed out.")
            }
        } catch (ex AggregateException) {
            throw IOException("Worker handshake failed.", ex.InnerException ?? ex)
        }
        cancellation.ThrowIfCancellationRequested()
        identity = requestedIdentity
        toolPath = path
        workerEnvironment = environment
        containedProcess = child.Id
    }

    private func FinishProcess(
        accepted bool,
        stdout(string) -> void,
        stderr(string) -> void,
        transportMessage(string) -> void
    ) {
        try {
            StopProcess()
            try {
                if accepted {
                    nativeOut?.DrainFailure(stdout)
                } else {
                    nativeOut?.DrainFailure((line string) -> transportMessage("G# worker startup stdout: $line"))
                }
            } finally {
                if accepted {
                    nativeError?.DrainFailure(stderr)
                } else {
                    nativeError?.DrainFailure((line string) -> transportMessage("G# worker startup stderr: $line"))
                }
            }
        } finally {
            Dispose()
        }
    }

    private func StopProcess() {
        let child = process
        if child != nil {
            if containedProcess == child.Id && Path.DirectorySeparatorChar != '\\' {
                containedProcess = 0
                KillOwnedGroup(-child.Id, 9)
            }
            Kill(child)
            child.WaitForExit()
        }
    }

    func Dispose() {
        lock gate {
            idleTimer?.Dispose()
            idleTimer = nil
            lastActivity = 0
            StopProcess()
            let child = process
            process = nil
            identity = nil
            toolPath = nil
            workerEnvironment = nil
            if child != nil {
                nativeOut?.Dispose()
                nativeError?.Dispose()
                child.Dispose()
            }
            reader?.Dispose()
            writer?.Dispose()
            reader = nil
            writer = nil
            nativeOut = nil
            nativeError = nil
            containedProcess = 0
            protocol?.Dispose()
            protocol = nil
        }
    }

    shared {
        @DllImport("libc", EntryPoint: "kill", SetLastError: true)
        private func KillOwnedGroup(group int32, signal int32) int32;
        private let RegistrationGate object = SystemObject()

        internal func CreateStartInfo(path string, flag string, pipeName string) ProcessStartInfo {
            let start = ProcessStartInfo(DotnetHost.Path()){
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            let arguments = typeof(ProcessStartInfo).GetProperty("ArgumentList")?.GetValue(start) as IList[string] ??
                throw InvalidOperationException("This MSBuild runtime cannot pass worker arguments safely.")
            for argument in[]string{path, flag, pipeName} {
                arguments.Add(argument)
            }
            return start
        }

        internal func CreateProtocolPipeName() string {
            let random = Convert
                .ToBase64String(Guid.NewGuid().ToByteArray())
                .Replace('/', '_')
                .Replace('+', '-')
                .TrimEnd('=')
            return if Path.DirectorySeparatorChar == '\\' {
                "gsharp-" + random
            } else {
                Path.Combine(Path.GetFullPath(Path.GetTempPath()), "p" + random)
            }
        }

        private func SameEnvironment(current Dictionary[string, string], previous Dictionary[string, string]?) bool {
            if previous == nil || current.Count != previous.Count {
                return false
            }
            for entry in current {
                if !previous.TryGetValue(entry.Key, out var value) || value != entry.Value {
                    return false
                }
            }
            return true
        }

        internal func Get(engine IBuildEngine4, key string) WorkerProcessClient {
            lock RegistrationGate {
                let registered = engine.GetRegisteredTaskObject(key, RegisteredTaskObjectLifetime.Build)
                if registered is WorkerProcessClient existing {
                    return existing
                }
                if registered != nil {
                    let previous = engine.UnregisterTaskObject(key, RegisteredTaskObjectLifetime.Build)
                    (previous as IDisposable)?.Dispose()
                }
                let client = WorkerProcessClient()
                engine.RegisterTaskObject(key, client, RegisteredTaskObjectLifetime.Build, allowEarlyCollection: false)
                return client
            }
        }

        internal func Kill(child Process) {
            try {
                if !child.HasExited {
                    let killTree = typeof(Process).GetMethod("Kill", []Type{typeof(bool)})
                    if killTree != nil {
                        killTree.Invoke(child, []object{true})
                    } else {
                        child.Kill()
                    }
                }
            } catch (ex InvalidOperationException) {
                // The process exited between HasExited and Kill.

            } catch (
                ex System.Reflection.TargetInvocationException
            ) when ex.InnerException is InvalidOperationException {
                // The process exited before the reflected tree-kill call.

            }
        }
    }
}
