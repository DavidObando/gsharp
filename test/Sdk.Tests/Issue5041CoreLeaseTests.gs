package GSharp.Sdk.Tests

import GSharp.Compiler
import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections.Generic
import System.IO
import System.Reflection
import System.Threading
import Xunit

class Issue5041CoreLeaseTests {
    open class RecordingEngine : DispatchProxy {
        let Requested List[int32] = List[int32]()
        let Released List[int32] = List[int32]()
        var AfterRequest Action?

        protected override func Invoke(method MethodInfo?, args[]?object?) object? {
            if method?.Name == "RequestCores" {
                let requested = cast[int32](args!![0])
                Requested.Add(requested)
                AfterRequest?.Invoke()
                return Math.Min(2, requested)
            }
            if method?.Name == "ReleaseCores" {
                Released.Add(cast[int32](args!![0]))
                return nil
            }
            if method?.Name?.StartsWith("Log", StringComparison.Ordinal) == true {
                return nil
            }
            if method?.Name == "get_ProjectFileOfTaskNode" {
                return string.Empty
            }
            if method?.ReturnType == typeof(bool) {
                return false
            }
            if method?.ReturnType == typeof(int32) {
                return 0
            }
            throw NotSupportedException(method?.Name)
        }
    }

    @Fact
    func OneTotalGrantIsReleasedOnceOnSuccessAndFailure() {
        let engine = DispatchProxy.Create[IBuildEngine9, RecordingEngine]()
        let recording = cast[RecordingEngine](engine)
        let lease = WorkerCoreLease.Acquire(engine, 8, 4096, default(CancellationToken))
        Assert.Equal([]int32{Math.Min(8, Environment.ProcessorCount)}, recording.Requested)
        Assert.Equal(Math.Min(2, Environment.ProcessorCount), lease.Grant)
        lease.Dispose()
        lease.Dispose()
        Assert.Equal([]int32{lease.Grant}, recording.Released)
        Assert.Throws[IOException](
            () -> {
                using let failed = WorkerCoreLease.Acquire(engine, 4, 4096, default(CancellationToken))
                throw IOException("compiler failed")
            }
        )
        Assert.Equal(2, recording.Requested.Count)
        Assert.Equal(2, recording.Released.Count)
        Assert.Equal(Math.Min(2, Environment.ProcessorCount), recording.Released[1])
    }

    @Fact
    func CancellationBeforeAndAfterAcquisitionCannotLeakAGrant() {
        let engine = DispatchProxy.Create[IBuildEngine9, RecordingEngine]()
        let recording = cast[RecordingEngine](engine)
        using let before = CancellationTokenSource()
        before.Cancel()
        Assert.Throws[OperationCanceledException](() -> WorkerCoreLease.Acquire(engine, 4, 1024, before.Token))
        Assert.Empty(recording.Requested)
        using let after = CancellationTokenSource()
        recording.AfterRequest = () -> after.Cancel()
        Assert.Throws[OperationCanceledException](() -> WorkerCoreLease.Acquire(engine, 4, 1024, after.Token))
        Assert.Single(recording.Requested)
        Assert.Equal([]int32{Math.Min(2, Environment.ProcessorCount)}, recording.Released)
    }

    @Fact
    func UnsupportedEnginesUseOnlyTheAmbientCore() {
        let engine = DispatchProxy.Create[IBuildEngine, RecordingEngine]()
        let recording = cast[RecordingEngine](engine)
        using let lease = WorkerCoreLease.Acquire(engine, 8, 4096, default(CancellationToken))
        Assert.Equal(1, lease.Grant)
        Assert.Empty(recording.Requested)
        lease.Dispose()
        Assert.Empty(recording.Released)
    }

    @Fact
    func RealCompilerTaskUsesTheActualGrantAndReleasesAfterFailure() {
        let directory = Path.Combine(AppContext.BaseDirectory, "task-budget-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, "input.gs")
            File.WriteAllText(source, "package Budget\nfunc Value(x int32) int32 -> x + 1")
            let engine = DispatchProxy.Create[IBuildEngine9, RecordingEngine]()
            let recording = cast[RecordingEngine](engine)
            let task = CreateTask(engine, directory, source)
            Assert.True(task.Execute())
            let grant = Math.Min(2, Environment.ProcessorCount)
            Assert.Equal([]int32{grant}, recording.Released)
            Assert.Contains("--workers:$grant", File.ReadAllLines(task.ResponseFilePath!!))
            File.WriteAllText(source, "package Budget\nfunc Value(x int32) int32 -> missing")
            let failed = CreateTask(engine, directory, source)
            Assert.False(failed.Execute())
            Assert.Equal(2, recording.Requested.Count)
            Assert.Equal([]int32{grant, grant}, recording.Released)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func DesignTimeAndCancelledTasksDoNotStartTheCompilerOrLeakCores() {
        let directory = Path.Combine(AppContext.BaseDirectory, "task-cancel-" + Guid.NewGuid().ToString("N"))
        let engine = DispatchProxy.Create[IBuildEngine9, RecordingEngine]()
        let recording = cast[RecordingEngine](engine)
        let task = CreateTask(engine, directory, "unread-input.gs")
        task.SkipCompilerExecution = "true"
        task.ProvideCommandLineArgs = "true"
        Assert.True(task.Execute())
        Assert.Empty(recording.Requested)
        Assert.False(Directory.Exists(directory))
        Assert.Contains(task.CommandLineArgs, (item ITaskItem) -> item.ItemSpec == "--workers:8")
        let cancelled = CreateTask(engine, directory, "unread-input.gs")
        recording.AfterRequest = () -> cancelled.Cancel()
        Assert.False(cancelled.Execute())
        Assert.Single(recording.Requested)
        Assert.Equal([]int32{Math.Min(2, Environment.ProcessorCount)}, recording.Released)
        Assert.False(Directory.Exists(directory))
    }

    shared {
        private func CreateTask(engine IBuildEngine, directory string, source string) BuildTask -> BuildTask{
            BuildEngine: engine,
            GsharpCompilerFullPath: typeof(Program).Assembly.Location,
            BasePath: directory,
            OutputPath: directory,
            OutputName: "Budget",
            OutputType: "Library",
            TempOutputPath: directory,
            TargetFramework: "net10.0",
            ResponseFilePath: Path.Combine(directory, "budget.rsp"),
            Compile: []ITaskItem{TaskItem(source)},
            MaxWorkers: 8,
            WorkerMemoryBudgetMiB: 1024
        }
    }
}
