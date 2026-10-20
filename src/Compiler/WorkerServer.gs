package GSharp.Workers

import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text

/// Serial compiler host. Process isolation is the cancellation boundary.
internal shared class WorkerServer {
    internal func Run(toolPath string, compile([]string) -> int32, canReuse(() -> bool)? = nil) int32 {
        let identity = WorkerProtocol.ToolIdentity(toolPath)
        using let input = BinaryReader(Console.OpenStandardInput(), Encoding.UTF8)
        using let output = BinaryWriter(Console.OpenStandardOutput(), Encoding.UTF8)
        using let stdout = WorkerOutput(output, WorkerProtocol.Stdout)
        using let stderr = WorkerOutput(output, WorkerProtocol.Stderr)
        Console.SetOut(stdout)
        Console.SetError(stderr)
        output.Write(WorkerProtocol.Version)
        output.Write(identity)
        output.Flush()
        for var request = 1; request <= WorkerProtocol.MaxRequests; request++ {
            using let stream = MemoryStream(WorkerProtocol.ReadFrame(input))
            using let payload = BinaryReader(stream, Encoding.UTF8)
            let version = payload.ReadInt32()
            let requestedIdentity = payload.ReadString()
            let directory = payload.ReadString()
            let grant = payload.ReadInt32()
            let arguments = [WorkerProtocol.ReadCount(payload)]string
            for var i = 0; i < arguments.Length; i++ {
                arguments[i] = payload.ReadString()
            }
            let environment = Dictionary[string, string](StringComparer.Ordinal)
            let count = WorkerProtocol.ReadCount(payload)
            for var i = 0; i < count; i++ {
                environment.Add(payload.ReadString(), payload.ReadString())
            }
            if version != WorkerProtocol.Version || requestedIdentity != identity || grant < 1 || !Path.IsPathRooted(
                directory
            ) ||
                !Directory.Exists(directory) || stream.Position != stream.Length {
                output.Write(WorkerProtocol.Rejected)
                output.Write("Worker version, directory, or resource grant is invalid.")
                output.Flush()
                return 1
            }
            output.Write(WorkerProtocol.Accepted)
            output.Flush()
            if RunRequest(
                output,
                stdout,
                stderr,
                directory,
                arguments,
                environment,
                grant,
                compile,
                canReuse,
                request
            ) {
                return 0
            }
        }
        return 0
    }

    private func RunRequest(
        output BinaryWriter,
        stdout WorkerOutput,
        stderr WorkerOutput,
        directory string,
        arguments[]string,
        environment Dictionary[string, string],
        grant int32,
        compile([]string) -> int32,
        canReuse(() -> bool)?,
        request int32
    ) bool {
        let oldDirectory = Environment.CurrentDirectory
        let oldEnvironment = Environment.GetEnvironmentVariables()
        try {
            for entry DictionaryEntry in oldEnvironment {
                Environment.SetEnvironmentVariable(cast[string](entry.Key), nil)
            }
            for entry in environment {
                Environment.SetEnvironmentVariable(entry.Key, entry.Value)
            }
            Environment.SetEnvironmentVariable("GSHARP_WORKER_GRANT", grant.ToString())
            Environment.CurrentDirectory = directory
            let exitCode = compile(arguments)
            GC.Collect()
            GC.WaitForPendingFinalizers()
            var retained = GC.GetTotalMemory(forceFullCollection: true)
            GC.WaitForPendingFinalizers()
            var reusable = canReuse?.Invoke() ?? true
            if !reusable {
                // Collectible load contexts can require a second finalizer cycle.
                // Retry once; persistent analyzer roots still retire the worker.
                GC.Collect()
                GC.WaitForPendingFinalizers()
                retained = GC.GetTotalMemory(forceFullCollection: false)
                reusable = canReuse?.Invoke() ?? true
            }
            using let process = Process.GetCurrentProcess()
            let workingSet = process.WorkingSet64
            let retire = request == WorkerProtocol.MaxRequests ||
                retained >= WorkerProtocol.MaxRetainedBytes ||
                workingSet >= WorkerProtocol.MaxWorkingSetBytes ||
                !reusable
            stdout.Complete()
            stderr.Complete()
            lock output {
                output.Write(WorkerProtocol.Completed)
                output.Write(exitCode)
                output.Write(retire)
                output.Write(retained)
                output.Write(workingSet)
                output.Flush()
            }
            return retire
        } finally {
            Environment.CurrentDirectory = oldDirectory
            for entry DictionaryEntry in Environment.GetEnvironmentVariables() {
                Environment.SetEnvironmentVariable(cast[string](entry.Key), nil)
            }
            for entry DictionaryEntry in oldEnvironment {
                Environment.SetEnvironmentVariable(cast[string](entry.Key), cast[string](entry.Value))
            }
        }
    }

    private class WorkerOutput : TextWriter {
        private let output BinaryWriter
        private let kind uint8
        private let line StringBuilder = StringBuilder()
        private var hasFragment bool
        private var carriageReturn bool

        init(output BinaryWriter, kind uint8) {
            this.output = output
            this.kind = kind
        }

        override prop Encoding Encoding -> Encoding.UTF8

        override func Write(value char) {
            lock output {
                if value == '\r' {
                    Emit(completeLine: true)
                    carriageReturn = true
                } else if value == '\n' {
                    if !carriageReturn {
                        Emit(completeLine: true)
                    }
                    carriageReturn = false
                } else {
                    carriageReturn = false
                    line.Append(value)
                    if line.Length >= 16384 {
                        Emit(completeLine: false)
                    }
                }
            }
        }

        override func Flush() {
            lock output {
                if line.Length > 0 {
                    Emit(completeLine: false)
                }
                output.Flush()
            }
        }

        internal func Complete() {
            lock output {
                if line.Length > 0 || hasFragment {
                    Emit(completeLine: true)
                }
            }
        }

        private func Emit(completeLine bool) {
            var pending char? = nil
            if !completeLine && line.Length > 0 && char.IsHighSurrogate(line[line.Length - 1]) {
                pending = line[line.Length - 1]
                line.Length--
            }
            output.Write(kind)
            output.Write(completeLine)
            output.Write(line.ToString())
            output.Flush()
            line.Clear()
            if pending is {} high {
                line.Append(high)
            }
            hasFragment = !completeLine
        }
    }
}
