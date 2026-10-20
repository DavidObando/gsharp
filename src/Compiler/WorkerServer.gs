package GSharp.Workers

import System
import System.Collections
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import System.Text
import System.Threading

/// Serial compiler host. Process isolation is the cancellation boundary.
internal shared class WorkerServer {
    internal func Run(toolPath string, compile([]string) -> int32, canReuse(() -> bool)? = nil) int32 {
        EstablishProcessLifetime()
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
        using let requests = BlockingCollection[[]uint8](1)
        let ownerMonitor = Thread(
            () -> {
                try {
                    while true {
                        let frame = WorkerProtocol.ReadFrame(input)
                        if !requests.TryAdd(frame) {
                            break
                        }
                    }
                } catch (ex Exception) when ex is IOException ||
                    ex is InvalidDataException ||
                    ex is FormatException ||
                    ex is DecoderFallbackException ||
                    ex is InvalidOperationException {
                    // An incomplete request or closed pipe cannot own a live worker.

                }
                TerminateProcessLifetime()
            }
        )
        ownerMonitor.IsBackground = true
        ownerMonitor.Start()
        for var request = 1; request <= WorkerProtocol.MaxRequests; request++ {
            using let stream = MemoryStream(requests.Take())
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

    private var job IntPtr

    // Process.Kill(true) rejects a tree containing its caller.
    // A worker owns an OS group or job for atomic owner-loss teardown.
    private func EstablishProcessLifetime() {
        if OperatingSystem.IsWindows() {
            job = CreateJobObject(IntPtr.Zero, IntPtr.Zero)
            if job == IntPtr.Zero || AssignProcessToJobObject(job, GetCurrentProcessHandle()) == 0 {
                throw IOException("Cannot contain compiler worker descendants in a Windows job.")
            }
        } else if CreateSession() < 0 && GetProcessGroup() != Environment.ProcessId {
            throw IOException("Cannot create the compiler worker's process group.")
        }
    }

    private func TerminateProcessLifetime() {
        if OperatingSystem.IsWindows() {
            TerminateJobObject(job, 1)
        } else {
            KillProcessGroup(-Environment.ProcessId, 9)
        }
        Environment.FailFast("Compiler worker owner disconnected.")
    }

    @DllImport("kernel32.dll", EntryPoint: "CreateJobObjectW", SetLastError: true)
    private func CreateJobObject(attributes IntPtr, name IntPtr) IntPtr;

    @DllImport("kernel32.dll", SetLastError: true)
    private func AssignProcessToJobObject(job IntPtr, process IntPtr) int32;

    @DllImport("kernel32.dll", EntryPoint: "GetCurrentProcess")
    private func GetCurrentProcessHandle() IntPtr;

    @DllImport("kernel32.dll", SetLastError: true)
    private func TerminateJobObject(job IntPtr, exitCode uint32) int32;

    @DllImport("libc", EntryPoint: "setsid", SetLastError: true)
    private func CreateSession() int32;

    @DllImport("libc", EntryPoint: "getpgrp")
    private func GetProcessGroup() int32;

    @DllImport("libc", EntryPoint: "kill", SetLastError: true)
    private func KillProcessGroup(group int32, signal int32) int32;

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
