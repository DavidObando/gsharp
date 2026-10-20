package GSharp.Workers

import System
import System.Collections
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Runtime.InteropServices
import System.Text
import System.Threading

/// Serial compiler host. Process isolation is the cancellation boundary.
internal shared class WorkerServer {
    internal func Run(toolPath string, compile([]string) -> int32, canReuse(() -> bool)?, protocolPipe string) int32 {
        EstablishProcessLifetime()
        let identity = WorkerProtocol.ToolIdentity(toolPath)
        using let input = BinaryReader(Console.OpenStandardInput(), Encoding.UTF8)
        using let connection = NamedPipeClientStream(".", protocolPipe, PipeDirection.Out)
        connection.Connect(30000)
        using let output = BinaryWriter(connection, Encoding.UTF8)
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
            let fence = payload.ReadString()
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
                !Directory.Exists(directory) || stream.Position != stream.Length || fence.Length != 41 {
                output.Write(WorkerProtocol.Rejected)
                output.Write("Worker version, directory, or resource grant is invalid.")
                output.Flush()
                return 1
            }
            output.Write(WorkerProtocol.Accepted)
            output.Flush()
            if RunRequest(output, directory, arguments, environment, grant, compile, canReuse, request, fence) {
                TerminateProcessLifetime()
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
        if !OperatingSystem.IsWindows() && !File.Exists("/bin/ps") {
            throw IOException("Compiler worker containment requires /bin/ps.")
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

    private func HasLiveDescendants() bool {
        if OperatingSystem.IsWindows() {
            return QueryInformationJobObject(
                job,
                1,
                out var accounting,
                uint32(Marshal.SizeOf[JobAccounting]()),
                IntPtr.Zero
            ) == 0 ||
                accounting.ActiveProcesses > 1
        }
        let start = ProcessStartInfo("/bin/ps", "-axo pid=,pgid="){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        using let query = Process.Start(start) ?? throw IOException("Cannot inspect compiler worker descendants.")
        let stdout = query.StandardOutput.ReadToEndAsync()
        let stderr = query.StandardError.ReadToEndAsync()
        if !query.WaitForExit(5000) {
            query.Kill(entireProcessTree: true)
            query.WaitForExit()
            return true
        }
        let text = stdout.GetAwaiter().GetResult()
        let _error = stderr.GetAwaiter().GetResult()
        if query.ExitCode != 0 {
            return true
        }
        for line in text.Split('\n') {
            let columns = line.Split([]char{' ', '\t'}, StringSplitOptions.RemoveEmptyEntries)
            if columns.Length == 2 && int32.TryParse(columns[0], out var pid) && int32.TryParse(
                columns[1],
                out var group
            ) &&
                group == Environment.ProcessId &&
                pid != Environment.ProcessId &&
                pid != query.Id {
                return true
            }
        }
        return false
    }

    @StructLayout(LayoutKind.Sequential)
    private struct JobAccounting {
        var TotalUserTime int64
        var TotalKernelTime int64
        var PeriodUserTime int64
        var PeriodKernelTime int64
        var PageFaults uint32
        var TotalProcesses uint32
        var ActiveProcesses uint32
        var TerminatedProcesses uint32
    }

    @DllImport("kernel32.dll", SetLastError: true)
    private func QueryInformationJobObject(
        job IntPtr,
        kind int32,
        out accounting JobAccounting,
        length uint32,
        returnedLength IntPtr
    ) int32;

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
        directory string,
        arguments[]string,
        environment Dictionary[string, string],
        grant int32,
        compile([]string) -> int32,
        canReuse(() -> bool)?,
        request int32,
        fence string
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
                !reusable ||
                HasLiveDescendants()
            Console.Out.Flush()
            Console.Error.Flush()
            let marker = Encoding.UTF8.GetBytes(fence)
            using let nativeOut = Console.OpenStandardOutput()
            using let nativeError = Console.OpenStandardError()
            nativeOut.Write(marker)
            nativeOut.Flush()
            nativeError.Write(marker)
            nativeError.Flush()
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
}
