package Gsharp.NET.Sdk.Tools

import GSharp.Workers
import Microsoft.Build.Framework
import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics
import System.IO
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
            cancellation.ThrowIfCancellationRequested()
            let requestedIdentity = WorkerProtocol.ToolIdentity(path)
            let environment = Dictionary[string, string](StringComparer.Ordinal)
            for entry DictionaryEntry in Environment.GetEnvironmentVariables() {
                environment.Add(cast[string](entry.Key), cast[string](entry.Value))
            }
            if process?.HasExited != false ||
                identity != requestedIdentity ||
                toolPath != path ||
                !SameEnvironment(environment, workerEnvironment) {
                Dispose()
                try {
                    Start(path, workerFlag, requestedIdentity, environment, cancellation)
                } catch (ex Exception) when ex is IOException ||
                    ex is System
                    .ComponentModel
                    .Win32Exception ||
                    ex is InvalidOperationException ||
                    ex is TimeoutException {
                    Dispose()
                    cancellation.ThrowIfCancellationRequested()
                    transportMessage("G# worker unavailable; using standalone tool: ${ex.Message}")
                    return false
                }
            }
            let activeProcess = process ?? throw InvalidOperationException("Worker was not started.")
            using let registration = cancellation.Register(() -> Kill(activeProcess))
            // Once a request is sent, transport loss is a failure, not a retry.
            try {
                WorkerProtocol.WriteRequest(
                    writer ?? throw InvalidOperationException("Worker input is unavailable."),
                    requestedIdentity,
                    directory,
                    arguments,
                    environment,
                    workerGrant
                )
                let input = reader ?? throw InvalidOperationException("Worker output is unavailable.")
                let status = input.ReadByte()
                if status == WorkerProtocol.Rejected {
                    transportMessage("G# worker rejected request; using standalone tool: ${input.ReadString()}")
                    Dispose()
                    return false
                }
                if status != WorkerProtocol.Accepted {
                    throw InvalidDataException("Worker did not acknowledge the request.")
                }
                transportMessage("G# worker accepted request: pid=${activeProcess.Id}.")
                let stdoutLine = StringBuilder()
                let stderrLine = StringBuilder()
                while true {
                    let kind = input.ReadByte()
                    switch kind {
                        case WorkerProtocol.Stdout {
                            ReadOutput(input, stdoutLine, stdout)
                        }
                        case WorkerProtocol.Stderr {
                            ReadOutput(input, stderrLine, stderr)
                        }
                        case WorkerProtocol.Completed {
                            exitCode = input.ReadInt32()
                            let retire = input.ReadBoolean()
                            let retained = input.ReadInt64()
                            let workingSet = input.ReadInt64()
                            cancellation.ThrowIfCancellationRequested()
                            transportMessage(
                                "G# worker completed: pid=${activeProcess.Id}, retained=$retained bytes, workingSet=$workingSet bytes, retire=$retire."
                            )
                            if retire {
                                Dispose()
                            }
                            return true
                        }
                        default {
                            throw InvalidDataException("Unexpected worker response.")
                        }
                    }
                }
            } catch (ex Exception) when ex is IOException ||
                ex is InvalidOperationException ||
                ex is System
                .ComponentModel
                .Win32Exception {
                Dispose()
                cancellation.ThrowIfCancellationRequested()
                throw IOException("Worker request transport failed.", ex)
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
        let start = ProcessStartInfo("dotnet", "\"$path\" $flag"){
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        }
        start.EnvironmentVariables.Clear()
        for entry in environment {
            start.EnvironmentVariables.Add(entry.Key, entry.Value)
        }
        let child = Process.Start(start) ?? throw IOException("Cannot start worker.")
        process = child
        // Drain startup/runtime stderr. Only framed request diagnostics enter MSBuild.
        child.ErrorDataReceived += (_sender object, _event DataReceivedEventArgs) -> { }
        child.BeginErrorReadLine()
        let input = BinaryReader(child.StandardOutput.BaseStream, Encoding.UTF8)
        reader = input
        writer = BinaryWriter(child.StandardInput.BaseStream, Encoding.UTF8)
        using let registration = cancellation.Register(() -> Kill(child))
        let handshake = Task.Run(
            () -> {
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
    }

    func Dispose() {
        let child = process
        process = nil
        identity = nil
        toolPath = nil
        workerEnvironment = nil
        if child != nil {
            Kill(child)
            child.WaitForExit()
            child.Dispose()
        }
        reader?.Dispose()
        writer?.Dispose()
        reader = nil
        writer = nil
    }

    shared {
        private let RegistrationGate object = SystemObject()

        private func ReadOutput(input BinaryReader, partial StringBuilder, report(string) -> void) {
            let complete = input.ReadBoolean()
            let text = input.ReadString()
            if partial.Length + text.Length > WorkerProtocol.MaxFrameBytes {
                throw InvalidDataException("Worker diagnostic line exceeds the protocol limit.")
            }
            if complete && partial.Length == 0 {
                report(text)
                return
            }
            partial.Append(text)
            if complete {
                report(partial.ToString())
                partial.Clear()
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
                let existing = engine.GetRegisteredTaskObject(
                    key,
                    RegisteredTaskObjectLifetime.Build
                ) as WorkerProcessClient
                if existing != nil {
                    return existing
                }
                let client = WorkerProcessClient()
                engine.RegisterTaskObject(key, client, RegisteredTaskObjectLifetime.Build, allowEarlyCollection: false)
                return client
            }
        }

        private func Kill(child Process) {
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
