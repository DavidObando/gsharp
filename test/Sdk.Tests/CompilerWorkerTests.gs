package GSharp.Sdk.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import Gsharp.NET.Sdk.Tools
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Security
import System.Text
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Xunit

/// Exercises the real compiler process, not a simulated compilation callback.
open class CompilerWorkerTests : IDisposable {
    private let directory string = Path.Combine(
        Environment.CurrentDirectory,
        "TestArtifacts",
        "compiler-worker-" + Guid.NewGuid().ToString("N")
    )
    private let messages List[string] = List[string]()
    private let client WorkerProcessClient = WorkerProcessClient()

    init() {
        Directory.CreateDirectory(directory)
    }

    func Dispose() {
        client.Dispose()
        Directory.Delete(directory, recursive: true)
        GC.SuppressFinalize(this)
    }

    @Fact
    func InheritedHelperDiagnosticsCannotCorruptPrivateProtocol() {
        let (analyzer, _marker) = CreateHelperAnalyzer(background: false)
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let output = List[string]()
        let errors = List[string]()
        Assert.True(
            Run(
                directory,
                []string{"/out:result.dll", "/target:library", "/gsanalyzer:" + analyzer, "input.gs"},
                output,
                errors,
                out var exit
            )
        )
        Assert.Equal(0, exit)
        Assert.Contains("helper-stdout é", output)
        Assert.Contains("helper-stderr", errors)
        Assert.True(
            Run(
                directory,
                []string{"/out:next.dll", "/target:library", "input.gs"},
                List[string](),
                List[string](),
                out var next
            )
        )
        Assert.Equal(0, next)
    }

    @Theory
    @InlineData("crash")
    @InlineData("cancel")
    @InlineData("ownerloss")
    @InlineData("loggerfailure")
    func InterruptedWorkerPreservesBothDiagnosticStreamsAndTheirTails(mode string) {
        let (analyzer, _marker) = CreateHelperAnalyzer(background: false, failureMode: mode)
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let output = List[string]()
        let errors = List[string]()
        using let cancellation = CancellationTokenSource()
        var failure Exception? = nil
        let request = Task.Run(
            () -> {
                try {
                    client.TryRun(
                        CompilerPath(),
                        "--compiler-worker",
                        directory,
                        WithReferences(
                            []string{"/out:result.dll", "/target:library", "/gsanalyzer:" + analyzer, "input.gs"}
                        ),
                        1,
                        cancellation.Token,
                        (line string) -> {
                            if mode == "loggerfailure" {
                                throw ApplicationException("A secondary diagnostic logger failed.")
                            }
                            output.Add(line)
                        },
                        (line string) -> errors.Add(line),
                        (line string) -> messages.Add(line),
                        out var _exit
                    )
                } catch (ex Exception) {
                    failure = ex
                }
            }
        )
        try {
            Assert.True(SpinWait.SpinUntil(() -> File.Exists(Path.Combine(directory, "failure.ready")), 5000))
            if mode == "cancel" {
                cancellation.Cancel()
            } else if mode == "ownerloss" {
                let processField = typeof(WorkerProcessClient).GetField(
                    "process",
                    BindingFlags.Instance | BindingFlags.NonPublic
                ) ??
                    throw InvalidOperationException("The accepted worker process is required.")
                let worker = processField.GetValue(client) as Process ??
                    throw InvalidOperationException("The accepted request must own its worker.")
                worker.StandardInput.Close()
            }
            Assert.True(request.Wait(5000))
        } finally {
            cancellation.Cancel()
            request.Wait(5000)
        }
        if mode == "cancel" {
            Assert.IsType[OperationCanceledException](failure)
        } else {
            Assert.IsType[IOException](failure)
        }
        if mode != "loggerfailure" {
            Assert.Contains("crash stdout é", output)
            Assert.Contains("stdout tail é", output)
        }
        Assert.Contains("crash stderr é", errors)
        Assert.Contains("stderr tail é", errors)
        Assert.DoesNotContain(messages, (line string) -> line.Contains("worker completed"))
        Assert.True(
            Run(
                directory,
                []string{"/out:next.dll", "/target:library", "input.gs"},
                List[string](),
                List[string](),
                out var next
            )
        )
        Assert.Equal(0, next)
        let accepted = messages.Where((m string) -> m.Contains("accepted request")).ToArray()
        Assert.Equal(2, accepted.Length)
        Assert.NotEqual(accepted[0], accepted[1])
    }

    @Fact
    func StartupFailurePreservesDiagnosticsWithoutReportingACompilationOrHidingFallback() {
        File.WriteAllText(
            Path.Combine(directory, "startup.gs"),
            "import System\nfunc Main() {\n" +
                "Console.WriteLine(\"startup stdout é\")\nConsole.Write(\"stdout tail é\")\n" +
                "Console.Error.WriteLine(\"startup stderr é\")\nConsole.Error.Write(\"stderr tail é\")\n" +
                "Console.Out.Flush()\nConsole.Error.Flush()\nEnvironment.Exit(42)\n}"
        )
        let (toolExit, diagnostics) = Standalone(
            directory,
            []string{"/out:startup.dll", "/target:exe", "/targetframework:net10.0", "startup.gs"}
        )
        Assert.True(toolExit == 0, diagnostics)
        let output = List[string]()
        let errors = List[string]()
        Assert.False(
            Run(
                directory,
                []string{"/out:result.dll", "/target:library", "unused.gs"},
                output,
                errors,
                out var exit,
                Path.Combine(directory, "startup.dll")
            )
        )
        Assert.Equal(1, exit)
        Assert.Empty(output)
        Assert.Empty(errors)
        Assert.Contains(messages, (line string) -> line.Contains("unavailable; using standalone"))
        Assert.Contains("G# worker startup stdout: startup stdout é", messages)
        Assert.Contains("G# worker startup stdout: stdout tail é", messages)
        Assert.Contains("G# worker startup stderr: startup stderr é", messages)
        Assert.Contains("G# worker startup stderr: stderr tail é", messages)
        Assert.DoesNotContain(messages, (line string) -> line.Contains("accepted request"))
        Assert.DoesNotContain(messages, (line string) -> line.Contains("worker completed"))
        Assert.False(File.Exists(Path.Combine(directory, "result.dll")))
    }

    @Fact
    func NormalRetirementTerminatesOwnedHelperDescendants() {
        let (analyzer, marker) = CreateHelperAnalyzer(background: true)
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        var helperPid = 0
        try {
            let processField = typeof(WorkerProcessClient).GetField(
                "process",
                BindingFlags.Instance | BindingFlags.NonPublic
            ) ??
                throw InvalidOperationException("The real worker process is required.")
            Assert.True(
                client.TryRun(
                    CompilerPath(),
                    "--compiler-worker",
                    directory,
                    WithReferences(
                        []string{"/out:result.dll", "/target:library", "/gsanalyzer:" + analyzer, "input.gs"}
                    ),
                    1,
                    CancellationToken.None,
                    (_line string) -> { },
                    (_line string) -> { },
                    (message string) -> {
                        if message.Contains("worker completed") {
                            let worker = processField.GetValue(client) as Process ??
                                throw InvalidOperationException("Completion must retain its worker until teardown.")
                            Assert.True(worker.WaitForExit(5000), "Worker did not retire before SDK disposal.")
                            helperPid = int32.Parse(File.ReadAllText(marker))
                            try {
                                using let helper = Process.GetProcessById(helperPid)
                                Assert.True(
                                    helper.WaitForExit(5000),
                                    "A helper survived server retirement before SDK disposal."
                                )
                            } catch (ex ArgumentException) {
                                // Server teardown already removed the owned helper.

                            }
                        }
                    },
                    out var exit
                )
            )
            Assert.Equal(0, exit)
            helperPid = int32.Parse(File.ReadAllText(marker))
            try {
                using let helper = Process.GetProcessById(helperPid)
                Assert.True(helper.WaitForExit(5000), "A helper survived normal worker retirement.")
            } catch (ex ArgumentException) {
                // The owned helper exited before its process handle was opened.

            }
        } finally {
            if helperPid == 0 && File.Exists(marker) {
                helperPid = int32.Parse(File.ReadAllText(marker))
            }
            if helperPid > 0 {
                try {
                    using let helper = Process.GetProcessById(helperPid)
                    if !helper.HasExited {
                        helper.Kill(entireProcessTree: true)
                        helper.WaitForExit()
                    }
                } catch (ex ArgumentException) {
                    // The owned helper is already gone.

                }
            }
        }
    }

    @Fact
    func OwnerDisconnectTerminatesABlockedCompilerAndItsChild() {
        let marker = Path.Combine(directory, "blocked-child.pid")
        let escapedMarker = marker.Replace("\\", "\\\\").Replace("\"", "\\\"")
        File.WriteAllText(
            Path.Combine(directory, "blocker.gs"),
            "import System\nimport System.IO\nimport System.Threading\n" +
                "func Main() {\n File.WriteAllText(\"${escapedMarker}.new\", Environment.ProcessId.ToString())\n " +
                "File.Move(\"${escapedMarker}.new\", \"$escapedMarker\")\n Thread.Sleep(Timeout.Infinite)\n}"
        )
        let (toolExit, toolDiagnostics) = Standalone(
            directory,
            []string{"/out:blocker.dll", "/target:exe", "/targetframework:net10.0", "blocker.gs"}
        )
        Assert.True(toolExit == 0, toolDiagnostics)
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = WithReferences(
            []string{
                "/out:result.dll",
                "/target:library",
                "/analyzer:unused.dll",
                "/gsgentool:" + Path.Combine(directory, "blocker.dll"),
                "input.gs"
            }
        )
        using let cancellation = CancellationTokenSource()
        using let accepted = ManualResetEventSlim()
        let processField = typeof(WorkerProcessClient).GetField(
            "process",
            BindingFlags.Instance | BindingFlags.NonPublic
        ) ??
            throw InvalidOperationException("The real worker process field is required.")
        let request = Task.Run(
            () -> {
                try {
                    client.TryRun(
                        CompilerPath(),
                        "--compiler-worker",
                        directory,
                        arguments,
                        1,
                        cancellation.Token,
                        (_line string) -> { },
                        (_line string) -> { },
                        (line string) -> {
                            if line.Contains("accepted request") {
                                accepted.Set()
                            }
                        },
                        out var _exit
                    )
                    return false
                } catch (ex IOException) {
                    return true
                } catch (ex OperationCanceledException) {
                    return false
                }
            }
        )
        try {
            Assert.True(accepted.Wait(5000))
            Assert.True(SpinWait.SpinUntil(() -> File.Exists(marker), 5000))
            let worker = processField.GetValue(client) as Process ??
                throw InvalidOperationException("The accepted request must have a worker.")
            using let child = Process.GetProcessById(int32.Parse(File.ReadAllText(marker)))
            worker.StandardInput.Close()
            Assert.True(worker.WaitForExit(5000), "Worker survived its owner's input disconnection.")
            Assert.True(child.WaitForExit(5000), "The blocked compiler's child survived owner disconnection.")
            Assert.True(request.Wait(5000))
            Assert.True(request.Result)
        } finally {
            cancellation.Cancel()
            request.Wait(5000)
        }
    }

    @Fact
    func ReusedCompilerCreatesOneIsolatedMeasurementSessionPerRequest() {
        let previous = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = WithReferences([]string{"/out:result.dll", "/target:library", "input.gs"})
        try {
            Environment.SetEnvironmentVariable(
                "GSHARP_MEASURE_PHASES",
                Path.Combine(directory, "measure-{pid}-{id}.json")
            )
            for grant in[]int32{2, 1} {
                Assert.True(
                    client.TryRun(
                        CompilerPath(),
                        "--compiler-worker",
                        directory,
                        arguments,
                        grant,
                        CancellationToken.None,
                        (_line string) -> { },
                        (_line string) -> { },
                        (line string) -> messages.Add(line),
                        out var exit
                    )
                )
                Assert.Equal(0, exit)
            }
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", previous)
        }
        let reports = Directory.GetFiles(directory, "measure-*.json")
        Assert.Equal(2, reports.Length)
        let processes = HashSet[int32]()
        let grants = List[int64]()
        for path in reports {
            using let report = JsonDocument.Parse(File.ReadAllText(path))
            let root = report.RootElement
            Assert.Equal("gsc", root.GetProperty("Tool").GetString())
            processes.Add(root.GetProperty("ProcessId").GetInt32())
            let counters = root.GetProperty("Counters")
            Assert.Equal(int64(1), counters.GetProperty("input.sources").GetInt64())
            Assert.Equal(int64(1), counters.GetProperty("workers.active").GetInt64())
            grants.Add(counters.GetProperty("workers.granted").GetInt64())
            Assert.True(root.GetProperty("Phases").GetArrayLength() > 0)
        }
        Assert.Single(processes)
        Assert.Equal[int64]([]int64{1, 2}, grants.OrderBy((value int64) -> value))
    }

    @Fact
    func DiagnosticCapturePreservesUnicodeLinesAndUnterminatedTail() {
        let fence = "\u001egsharp-" + Guid.NewGuid().ToString("N") + "\u001f"
        using let stream = MemoryStream(Encoding.UTF8.GetBytes("error GS1234: 😀 message\r\ntail" + fence))
        using let reader = StreamReader(stream, Encoding.UTF8)
        using let capture = WorkerDiagnosticCapture(reader, () -> { }, fence)
        let lines = List[string]()
        Assert.True(capture.Complete(CancellationToken.None, (line string) -> lines.Add(line)))
        Assert.Equal[string]([]string{"error GS1234: 😀 message", "tail"}, lines)
    }

    @Fact
    func IdleRetirementCannotInterruptDispatchOrAnActiveRequest() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var first))
        Assert.Equal(0, first)
        let previousProcess = messages.Last().Split(',')[0]
        let activity = typeof(WorkerProcessClient).GetField(
            "lastActivity",
            BindingFlags.Instance | BindingFlags.NonPublic
        ) ??
            throw InvalidOperationException("The worker idle timestamp is required.")
        let expire = typeof(WorkerProcessClient).GetMethod(
            "RetireIdleWorker",
            BindingFlags.Instance | BindingFlags.NonPublic
        ) ??
            throw InvalidOperationException("The actual idle callback is required.")
        using let accepted = ManualResetEventSlim()
        using let release = ManualResetEventSlim()
        using let expiryAttempted = ManualResetEventSlim()
        let request = Task.Run(
            () -> {
                let handled = client.TryRun(
                    CompilerPath(),
                    "--compiler-worker",
                    directory,
                    WithReferences(arguments),
                    1,
                    CancellationToken.None,
                    (_line string) -> { },
                    (_line string) -> { },
                    (line string) -> {
                        messages.Add(line)
                        if line.Contains("accepted request") {
                            activity.SetValue(client, Stopwatch.GetTimestamp() - 61 * Stopwatch.Frequency)
                            accepted.Set()
                            if !release.Wait(5000) {
                                throw TimeoutException("The test did not release the active request.")
                            }
                        }
                    },
                    out var exit
                )
                Assert.True(handled)
                Assert.Equal(0, exit)
            }
        )
        try {
            Assert.True(accepted.Wait(5000))
            let retirement = Task.Run(
                () -> {
                    expiryAttempted.Set()
                    expire.Invoke(client, nil)
                }
            )
            try {
                Assert.True(expiryAttempted.Wait(5000))
                Assert.False(retirement.Wait(100))
            } finally {
                release.Set()
            }
            Assert.True(request.Wait(5000))
            Assert.True(retirement.Wait(5000))
            Assert.True(Run(directory, arguments, List[string](), List[string](), out var after))
            Assert.Equal(0, after)
            Assert.Equal(previousProcess, messages.Last().Split(',')[0])
        } finally {
            release.Set()
        }
    }

    @Fact
    func OversizedDiagnosticDisposesTransportAndNextRequestStartsFresh() {
        let source = Path.Combine(directory, "input.gs")
        File.WriteAllText(source, "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var warmup))
        Assert.Equal(0, warmup)
        let previousProcess = messages.Last().Split(',')[0]
        File.WriteAllText(
            source,
            "open class Sample { func Get() int32 -> missingName } //".PadRight(16 * 1024 * 1024 + 1)
        )
        let failure = Assert.Throws[IOException](
            () -> Run(directory, arguments, List[string](), List[string](), out var _exit)
        )
        Assert.Contains("protocol limit", failure.Message)
        File.WriteAllText(source, "open class Sample { }")
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var after))
        Assert.Equal(0, after)
        Assert.NotEqual(previousProcess, messages.Last().Split(',')[0])
    }

    @Fact
    func UnexpectedRequestFailureCannotLeaveAReusableStream() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var first))
        Assert.Equal(0, first)
        let previousProcess = messages.Last().Split(',')[0]
        Assert.Throws[ApplicationException](
            () -> client.TryRun(
                CompilerPath(),
                "--compiler-worker",
                directory,
                WithReferences(arguments),
                1,
                CancellationToken.None,
                (_line string) -> { },
                (_line string) -> { },
                (line string) -> {
                    if line.Contains("accepted request") {
                        throw ApplicationException("The request logger failed.")
                    }
                },
                out var _exit
            )
        )
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var after))
        Assert.Equal(0, after)
        Assert.NotEqual(previousProcess, messages.Last().Split(',')[0])
    }

    @Fact
    func SubprocessDeadlineDoesNotWaitForOutputEof() {
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        start.ArgumentList.Add(CompilerPath())
        start.ArgumentList.Add("--compiler-worker")
        let name = WorkerProcessClient.CreateProtocolPipeName()
        using let protocol = NamedPipeServerStream(name, PipeDirection.In)
        start.ArgumentList.Add(name)
        let elapsed = Stopwatch.StartNew()
        Assert.Throws[TimeoutException](
            () -> {
                RunProcess(start, 100)
            }
        )
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(5))
    }

    @Fact
    func SubprocessDeadlineIncludesInheritedOutputAfterRootExit() {
        let marker = Path.Combine(directory, "orphan.pid")
        let ready = Path.Combine(directory, "orphan.ready")
        File.WriteAllText(
            Path.Combine(directory, "orphan.gs"),
            "import System\nimport System.IO\nimport System.Reflection\nimport System.Diagnostics\nimport System.Threading\n" +
                "func Main(args[]string) {\nif args.Length > 0 {\n" +
                "File.WriteAllText(\"${EscapeSource(ready)}\", \"ready\")\nThread.Sleep(Timeout.Infinite)\nreturn\n}\n" +
                "File.WriteAllText(\"${EscapeSource(marker)}.root\", Environment.ProcessId.ToString())\n" +
                "let start = ProcessStartInfo(\"dotnet\"){UseShellExecute = false}\n" +
                "start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location)\nstart.ArgumentList.Add(\"child\")\n" +
                "using let child = Process.Start(start) ?? throw Exception(\"child startup failed\")\n" +
                "File.WriteAllText(\"${EscapeSource(marker)}\", child.Id.ToString())\n" +
                "if !SpinWait.SpinUntil(() -> File.Exists(\"${EscapeSource(ready)}\"), 5000) { throw Exception(\"child not ready\") }\n}"
        )
        let (toolExit, diagnostics) = Standalone(
            directory,
            []string{"/out:orphan.dll", "/target:exe", "/targetframework:net10.0", "orphan.gs"}
        )
        Assert.True(toolExit == 0, diagnostics)
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        start.ArgumentList.Add(Path.Combine(directory, "orphan.dll"))
        let cleanup = () -> {
            if File.Exists(marker + ".root") {
                try {
                    using let root = Process.GetProcessById(int32.Parse(File.ReadAllText(marker + ".root")))
                    Assert.True(root.HasExited, "The fixture must time out after root exit, not during startup.")
                } catch (ex ArgumentException) {
                    // The fixture root already exited and was reaped.

                }
            }
            if File.Exists(marker) {
                try {
                    using let child = Process.GetProcessById(int32.Parse(File.ReadAllText(marker)))
                    if !child.HasExited {
                        child.Kill(entireProcessTree: true)
                        Assert.True(child.WaitForExit(1000))
                    }
                } catch (ex ArgumentException) {
                    // The precisely identified fixture child already exited.

                }
            }
        }
        let operation = Task.Run(
            () -> {
                try {
                    RunProcess(start, 2000, cleanup)
                    return false
                } catch (ex TimeoutException) {
                    return true
                }
            }
        )
        try {
            Assert.True(operation.Wait(5000), "Root exit bypassed the subprocess output deadline.")
            Assert.True(operation.Result)
            Assert.True(File.Exists(marker))
            try {
                using let child = Process.GetProcessById(int32.Parse(File.ReadAllText(marker)))
                Assert.True(child.HasExited, "Timeout cleanup left the fixture's output-owning child alive.")
            } catch (ex ArgumentException) {
                // The precisely identified fixture child already exited.

            }
        } finally {
            cleanup()
            operation.Wait(5000)
        }
    }

    @Fact
    func SharedGenericDefinitionDoesNotKeepPrivateReferenceContextAlive() {
        let assembly = CacheSharedGenericOverPrivateType()
        for var i = 0; i < 5 && assembly.IsAlive; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
            GC.Collect()
        }
        Assert.False(assembly.IsAlive, "A host generic definition must not retain a private metadata context.")
    }

    @Fact
    func LiveImportedSymbolsKeepContextSensitiveCanonicalIdentity() {
        let paths = RuntimeReferences()
        using let firstContext = ReferenceResolver.WithReferences(paths)
        using let secondContext = ReferenceResolver.WithReferences(paths)
        Assert.True(firstContext.TryResolveType("System.Text.StringBuilder", out var firstType))
        Assert.True(secondContext.TryResolveType("System.Text.StringBuilder", out var secondType))
        let first = ImportedTypeSymbol.Get(typeof(Func[_, _]).MakeGenericType(firstType, typeof(int32)))
        let otherContext = ImportedTypeSymbol.Get(typeof(Func[_, _]).MakeGenericType(secondType, typeof(int32)))
        GC.Collect()
        GC.WaitForPendingFinalizers()
        Assert.Same(first, ImportedTypeSymbol.Get(typeof(Func[_, _]).MakeGenericType(firstType, typeof(int32))))
        Assert.NotSame(first, otherContext)
    }

    @Fact
    func ReusedRequestsMatchStandaloneBytesAndDiagnostics() {
        for var i = 0; i < 6; i++ {
            let project = Path.Combine(
                directory,
                if i % 2 == 0 {
                    "first"
                } else {
                    "second"
                }
            )
            Directory.CreateDirectory(project)
            let source = Path.Combine(project, "input.gs")
            // The diagnostic snippet prefixes four spaces before this source line.
            let body = if i == 3 {
                "open class Sample { func Value() int32 -> missingName } //".PadRight(16379) + "😀" + "".PadRight(20000)
            } else {
                "open class Sample { func Value() int32 -> $i }"
            }
            File.WriteAllText(source, body)
            let arguments = []string{
                "/out:result.dll",
                "/target:library",
                "/assemblyname:WorkerIsolation",
                "/deterministic",
                "/debug:portable",
                "/refout:reference.dll",
                "/doc:result.xml",
                if i % 2 == 0 {
                    "/optimize+"
                } else {
                    "/optimize-"
                },
                if i % 2 == 0 {
                    "/nullability:platform-types"
                } else {
                    "/nullability:oblivious"
                },
                "input.gs"
            }
            let (standaloneExit, standaloneDiagnostics) = Standalone(project, arguments)
            let expected = Dictionary[string, []uint8]()
            if standaloneExit == 0 {
                for name in[]string{"result.dll", "result.pdb", "reference.dll", "result.xml"} {
                    let path = Path.Combine(project, name)
                    Assert.True(File.Exists(path), path)
                    expected.Add(name, File.ReadAllBytes(path))
                    File.Delete(path)
                }
            }
            let output = List[string]()
            let errors = List[string]()
            Assert.True(Run(project, arguments, output, errors, out var workerExit))
            Assert.Equal(standaloneExit, workerExit)
            Assert.Equal(standaloneDiagnostics, string.Join("\n", output.Concat(errors)))
            if standaloneExit == 0 {
                for entry in expected {
                    Assert.Equal[uint8](entry.Value, File.ReadAllBytes(Path.Combine(project, entry.Key)))
                }
            }
        }
        Assert.Equal(6, messages.Count((m string) -> m.Contains("worker completed:")))
        let pids = messages
            .Where((m string) -> m.Contains("worker completed:"))
            .Select((m string) -> m.Split(',')[0])
            .Distinct()
            .ToArray()
        Assert.Single(pids)
    }

    @Fact
    func AnalyzerRequestsRetireWithoutDroppingTheirDiagnostics() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        File.WriteAllText(Path.Combine(directory, "invalid-analyzer.dll"), "not an assembly")
        let output = List[string]()
        let errors = List[string]()
        Assert.True(
            Run(
                directory,
                []string{"/out:result.dll", "/target:library", "/gsanalyzer:invalid-analyzer.dll", "input.gs"},
                output,
                errors,
                out var failure
            )
        )
        Assert.NotEqual(0, failure)
        Assert.Contains(output, (line string) -> line.Contains("GS9301"))
        Assert.Contains("retire=True", messages.Last())
        let firstProcess = messages.Last().Split(',')[0]
        Assert.True(
            Run(
                directory,
                []string{"/out:result.dll", "/target:library", "input.gs"},
                List[string](),
                List[string](),
                out var success
            )
        )
        Assert.Equal(0, success)
        Assert.NotEqual(firstProcess, messages.Last().Split(',')[0])
    }

    @Fact
    func RequestLimitRetiresAndRestartsWorker() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        for var i = 0; i < 17; i++ {
            Assert.True(Run(directory, arguments, List[string](), List[string](), out var exit))
            Assert.Equal(0, exit)
        }
        let completed = messages.Where((m string) -> m.Contains("worker completed:")).ToArray()
        Assert.Equal(17, completed.Length)
        Assert.Contains("retire=True", completed[15])
        Assert.NotEqual(completed[0].Split(',')[0], completed[16].Split(',')[0])
    }

    @Fact
    func UnavailableProtocolIsExplicitFallbackNotCompilationSuccess() {
        let output = List[string]()
        Assert.False(
            client.TryRun(
                CompilerPath(),
                "--help",
                directory,
                []string{"/out:never.dll"},
                1,
                CancellationToken.None,
                (line string) -> output.Add(line),
                (line string) -> output.Add(line),
                (line string) -> messages.Add(line),
                out var exit
            )
        )
        Assert.NotEqual(0, exit)
        Assert.Contains(messages, (message string) -> message.Contains("using standalone tool"))
        Assert.False(File.Exists(Path.Combine(directory, "never.dll")))
    }

    @Fact
    func SameAssemblyNameWithChangedReferenceContentsDoesNotReuseOldTypes() {
        let api = Path.Combine(directory, "api.gs")
        let consumer = Path.Combine(directory, "input.gs")
        File.WriteAllText(consumer, "import R\nopen class Sample { func Get() int32 -> Value.Get() }")
        for var i = 0; i < 3; i++ {
            let returnType = if i == 1 {
                "string"
            } else {
                "int32"
            }
            let value = if i == 1 {
                "\"changed\""
            } else {
                "42"
            }
            File.WriteAllText(api, "package R\nopen class Value { shared { func Get() $returnType -> $value } }")
            let (apiExit, apiDiagnostics) = Standalone(
                directory,
                []string{"/out:api.dll", "/assemblyname:SameReference", "/target:library", "api.gs"}
            )
            Assert.True(apiExit == 0, apiDiagnostics)
            let arguments = []string{"/out:result.dll", "/target:library", "/r:api.dll", "input.gs"}
            let (expectedExit, expectedDiagnostics) = Standalone(directory, arguments)
            Assert.Equal(
                if i == 1 {
                    1
                } else {
                    0
                },
                expectedExit
            )
            let output = List[string]()
            let errors = List[string]()
            Assert.True(Run(directory, arguments, output, errors, out var exit))
            Assert.Equal(expectedExit, exit)
            Assert.Equal(expectedDiagnostics, string.Join("\n", output.Concat(errors)))
        }
    }

    @Fact
    func ChangedToolPayloadStartsANewWorker() {
        let toolDirectory = Path.Combine(directory, "tool")
        Directory.CreateDirectory(toolDirectory)
        for path in Directory.GetFiles(Path.GetDirectoryName(CompilerPath()) ?? ".") {
            File.Copy(path, Path.Combine(toolDirectory, Path.GetFileName(path)))
        }
        let tool = Path.Combine(toolDirectory, "gsc.dll")
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var first, tool))
        Assert.Equal(0, first)
        File.WriteAllText(Path.Combine(toolDirectory, "version-marker.json"), "{}")
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var second, tool))
        Assert.Equal(0, second)
        let completed = messages.Where((m string) -> m.Contains("worker completed:")).ToArray()
        Assert.Equal(2, completed.Length)
        Assert.NotEqual(completed[0].Split(',')[0], completed[1].Split(',')[0])
    }

    @Fact
    func RealBuildTaskUsesEachLeaseInsteadOfAStaleReusableGrant() {
        let source = "package LeaseRequests\nimport System\nfunc Main() { Console.WriteLine(Value0(0)) }\n" +
            string
            .Concat(
            Enumerable.Range(0, 16).Select(
                (method int32) -> "func Value$method(x int32) int32 {\nlet n0 = x + 1\n" + string.Concat(
                    Enumerable.Range(1, 64).Select((n int32) -> "let n$n = n${n - 1} + $n\n")
                ) +
                    "return n63\n}\n"
            )
        )
        File.WriteAllText(Path.Combine(directory, "input.gs"), source)
        let compiler = SecurityElement.Escape(CompilerPath())
        let taskAssembly = SecurityElement.Escape(typeof(BuildTask).Assembly.Location)
        let basePath = SecurityElement.Escape(directory)
        let references = string.Join(
            "",
            RuntimeReferences().Select((path string) -> "<Refs Include=\"${SecurityElement.Escape(path)}\"/>")
        )
        let xml = StringBuilder(
            "<Project><UsingTask AssemblyFile=\"$taskAssembly\" TaskName=\"Gsharp.NET.Sdk.Tools.BuildTask\"/>" +
                "<ItemGroup><Sources Include=\"input.gs\"/>$references</ItemGroup><Target Name=\"Build\">"
        )
        for label in[]string{"standalone", "two", "one"} {
            let shared = if label == "standalone" {
                "false"
            } else {
                "true"
            }
            let workers = if label == "two" {
                2
            } else {
                32
            }
            let memory = if label == "two" {
                1024
            } else {
                256
            }
            xml.Append(
                "<BuildTask GsharpCompilerFullPath=\"$compiler\" OutputPath=\".\" OutputName=\"Budget\" " +
                    "TempOutputPath=\".\" TargetFramework=\"net10.0\" BasePath=\"$basePath\" OutputType=\"Exe\" " +
                    "Compile=\"@(Sources)\" References=\"@(Refs)\" ResponseFilePath=\"./$label.rsp\" " +
                    "UseSharedCompilation=\"$shared\" WorkerGrant=\"7\" MaxWorkers=\"$workers\" " +
                    "WorkerMemoryBudgetMiB=\"$memory\" Deterministic=\"true\" DebugType=\"portable\" RefAssembly=\"Budget.ref.dll\"/>"
            )
            for suffix in[]string{".dll", ".pdb", ".ref.dll", ".runtimeconfig.json"} {
                xml.Append("<Copy SourceFiles=\"Budget$suffix\" DestinationFiles=\"$label$suffix\"/>")
            }
        }
        xml.Append("</Target></Project>")
        let project = Path.Combine(directory, "lease-requests.proj")
        File.WriteAllText(project, xml.ToString())
        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in[]string{"msbuild", project, "-t:Build", "-m:1", "-nr:false", "-v:normal", "-nologo"} {
            start.ArgumentList.Add(argument)
        }
        start.Environment["DOTNET_PROCESSOR_COUNT"] = "2"
        start.Environment["GSHARP_MEASURE_PHASES"] = Path.Combine(directory, "budget-{pid}-{id}.json")
        start.Environment.Remove("GSHARP_WORKER_GRANT")
        let (exit, stdout, stderr, _pid) = RunProcess(start, 60000)
        Assert.True(exit == 0, stdout + stderr)
        let completed = stdout.Split('\n').Where((line string) -> line.Contains("worker completed:")).ToArray()
        Assert.Equal(2, completed.Length)
        Assert.Equal(completed[0].Split(',')[0], completed[1].Split(',')[0])
        let byProcess = Dictionary[int32, List[int32]]()
        let reports = Directory.GetFiles(directory, "budget-*.json")
        Assert.Equal(3, reports.Length)
        for path in reports {
            using let report = JsonDocument.Parse(File.ReadAllText(path))
            let root = report.RootElement
            let process = root.GetProperty("ProcessId").GetInt32()
            if !byProcess.ContainsKey(process) {
                byProcess[process] = List[int32]()
            }
            let counters = root.GetProperty("Counters")
            let grant = counters.GetProperty("workers.granted").GetInt32()
            byProcess[process].Add(grant)
            Assert.InRange(counters.GetProperty("workers.active").GetInt32(), 1, grant)
            if grant == 2 {
                Assert.True(counters.GetProperty("bodies.workers.active").GetInt32() > 1)
            }
        }
        Assert.Equal(
            []int32{1, 2},
            byProcess.Values.Select((grants List[int32]) -> grants.Count).OrderBy((count int32) -> count)
        )
        let reused = Assert.Single(byProcess.Values, (grants List[int32]) -> grants.Count == 2)
        Assert.Equal([]int32{1, 2}, reused.OrderBy((grant int32) -> grant))
        for label in[]string{"standalone", "two", "one"} {
            let expectedGrant = if label == "two" {
                2
            } else {
                1
            }
            Assert.Contains("--workers:$expectedGrant", File.ReadAllLines(Path.Combine(directory, "$label.rsp")))
            for suffix in[]string{".dll", ".pdb", ".ref.dll"} {
                Assert.Equal(
                    File.ReadAllBytes(Path.Combine(directory, "standalone$suffix")),
                    File.ReadAllBytes(Path.Combine(directory, "$label$suffix"))
                )
            }
            let run = ProcessStartInfo("dotnet"){
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            run.ArgumentList.Add(Path.Combine(directory, "$label.dll"))
            let (runtimeExit, output, errors, _runtimePid) = RunProcess(run)
            Assert.True(runtimeExit == 0, errors)
            Assert.Equal("2017\n", output.ReplaceLineEndings("\n"))
        }
    }

    @Fact
    func RealBuildTaskReusesItsBuildLifetimeWorkerAndPreservesFailure() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { func Get() int32 -> 42 }")
        let compiler = SecurityElement.Escape(CompilerPath())
        let taskAssembly = SecurityElement.Escape(typeof(BuildTask).Assembly.Location)
        let references = string.Join(
            "",
            RuntimeReferences().Select((path string) -> "<Refs Include=\"${SecurityElement.Escape(path)}\"/>")
        )
        let basePath = SecurityElement.Escape(directory)
        let project = Path.Combine(directory, "worker.proj")
        let prefix =
        "<Project><UsingTask AssemblyFile=\"$taskAssembly\" TaskName=\"Gsharp.NET.Sdk.Tools.BuildTask\"/>" +
            "<ItemGroup><Sources Include=\"input.gs\"/>$references</ItemGroup>" +
            "<Target Name=\"Build\">"
        for name in[]string{"first", "second"} {
            let xml = prefix +
                "<BuildTask GsharpCompilerFullPath=\"$compiler\" OutputPath=\".\" OutputName=\"$name\" " +
                "TempOutputPath=\".\" TargetFramework=\"net10.0\" BasePath=\"$basePath\" OutputType=\"Library\" " +
                "Compile=\"@(Sources)\" References=\"@(Refs)\" ResponseFilePath=\"./$name.rsp\" " +
                "UseSharedCompilation=\"true\" WorkerGrant=\"1\" Deterministic=\"true\"/>" +
                "</Target></Project>"
            File.WriteAllText(Path.Combine(directory, "$name.proj"), xml)
        }
        File.WriteAllText(
            project,
            "<Project><Target Name=\"Build\">" +
                "<MSBuild Projects=\"first.proj;second.proj\" Targets=\"Build\" BuildInParallel=\"false\"/>" +
                "</Target></Project>"
        )
        let (exit, log) = BuildProject(project, directory)
        Assert.True(exit == 0, log)
        let completed = log.Split('\n').Where((line string) -> line.Contains("worker completed:")).ToArray()
        Assert.Equal(2, completed.Length)
        Assert.Equal(completed[0].Split(',')[0], completed[1].Split(',')[0])
        Assert.True(File.Exists(Path.Combine(directory, "first.dll")))
        Assert.True(File.Exists(Path.Combine(directory, "second.dll")))
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { func Get() int32 -> missing }")
        let (failure, diagnostics) = BuildProject(project, directory)
        Assert.NotEqual(0, failure)
        Assert.Contains("error GS", diagnostics)
        Assert.DoesNotContain("using standalone", diagnostics)
    }

    @Fact
    func NullabilityModesDoNotCarryOverBetweenRequests() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { func Get() string -> nil }")
        for var i = 0; i < 3; i++ {
            let arguments = []string{
                "/out:result.dll",
                "/target:library",
                if i == 1 {
                    "/nullability:oblivious"
                } else {
                    "/nullability:platform-types"
                },
                "input.gs"
            }
            let (expected, diagnostics) = Standalone(directory, arguments)
            Assert.Equal(
                if i == 1 {
                    0
                } else {
                    1
                },
                expected
            )
            let output = List[string]()
            let errors = List[string]()
            Assert.True(Run(directory, arguments, output, errors, out var actual))
            Assert.Equal(expected, actual)
            Assert.Equal(diagnostics, string.Join("\n", output.Concat(errors)))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SdkTaskReferenceClosure_OnlyExplicitPromotionRejectsOmittedDependencies(promoteClosure bool) {
        let resolve = ProcessStartInfo("dotnet"){
            WorkingDirectory = RepoRoot.Path,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in[]string{
            "msbuild",
            Path.Combine(RepoRoot.SdkSourceDir, "Gsharp.NET.Sdk.gsproj"),
            "-target:FindReferenceAssembliesForReferences",
            "-getItem:ReferencePathWithRefAssemblies",
            "-p:BuildProjectReferences=false",
            "-p:Configuration=Release",
            "-nr:false",
            "-nologo",
            "-v:quiet"
        } {
            resolve.ArgumentList.Add(argument)
        }
        let (resolved, stdout, stderr, _) = RunProcess(resolve)
        Assert.True(resolved == 0, stdout + stderr)
        using let document = JsonDocument.Parse(stdout)
        let references = document
            .RootElement
            .GetProperty("Items")
            .GetProperty("ReferencePathWithRefAssemblies")
            .EnumerateArray()
            .Select(
            (item JsonElement) -> item.GetProperty("FullPath").GetString() ??
                throw InvalidOperationException("Missing resolved reference path.")
        )
            .ToArray()
        Assert.NotEmpty(references)
        let source = Path.Combine(directory, "closure.gs")
        File.WriteAllText(source, "func Value() int32 -> 42\n")
        for missing in[]string{"", "System.Security.Permissions"} {
            let name = if missing.Length == 0 {
                "complete"
            } else {
                missing
            }
            let output = Path.Combine(directory, name + ".dll")
            let reference = Path.Combine(directory, name + ".ref.dll")
            let pdb = Path.Combine(directory, name + ".pdb")
            let start = ProcessStartInfo("dotnet"){
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in[]string{
                CompilerPath(),
                source,
                "/target:library",
                "/targetframework:netstandard2.0",
                "/warnaserror+",
                "/out:" + output,
                "/refout:" + reference,
                "/pdb:" + pdb
            } {
                start.ArgumentList.Add(argument)
            }
            for path in references.Where((path string) -> Path.GetFileNameWithoutExtension(path) != missing) {
                start.ArgumentList.Add("/r:" + path)
            }
            if promoteClosure {
                start.ArgumentList.Add("/warnaserror:GS9100")
            }
            let (exit, diagnostics, errors, _) = RunProcess(start)
            if missing.Length == 0 {
                Assert.True(exit == 0, diagnostics + errors)
                Assert.DoesNotContain("GS9100", diagnostics)
                Assert.True(File.Exists(output))
                Assert.True(File.Exists(reference))
                Assert.True(File.Exists(pdb))
            } else if promoteClosure {
                Assert.NotEqual(0, exit)
                Assert.Contains("$source(1,1,1,1): error GS9100:", diagnostics)
                Assert.Contains("($missing)", diagnostics)
                Assert.False(File.Exists(output))
                Assert.False(File.Exists(reference))
                Assert.False(File.Exists(pdb))
            } else {
                Assert.True(exit == 0, diagnostics + errors)
                Assert.Contains("$source(1,1,1,1): warning GS9100:", diagnostics)
                Assert.Contains("($missing)", diagnostics)
                Assert.True(File.Exists(output))
                Assert.True(File.Exists(reference))
                Assert.True(File.Exists(pdb))
            }
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RealBuildTask_OptionalFrameworkForwarders_AreNotMissing(shared bool) {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "func Value() int32 -> 42\n")
        let compiler = SecurityElement.Escape(CompilerPath())
        let taskAssembly = SecurityElement.Escape(typeof(BuildTask).Assembly.Location)
        let basePath = SecurityElement.Escape(directory)
        let references = string.Join(
            "",
            RuntimeReferences().Select((path string) -> "<Refs Include=\"${SecurityElement.Escape(path)}\"/>")
        )
        let project = Path.Combine(directory, "forwarders.proj")
        File.WriteAllText(
            project,
            "<Project><UsingTask AssemblyFile=\"$taskAssembly\" TaskName=\"Gsharp.NET.Sdk.Tools.BuildTask\"/>" +
                "<ItemGroup><Sources Include=\"input.gs\"/>$references</ItemGroup><Target Name=\"Build\">" +
                "<BuildTask GsharpCompilerFullPath=\"$compiler\" OutputPath=\".\" OutputName=\"Forwarders\" " +
                "TempOutputPath=\".\" TargetFramework=\"net10.0\" BasePath=\"$basePath\" OutputType=\"Library\" " +
                "Compile=\"@(Sources)\" References=\"@(Refs)\" ResponseFilePath=\"./forwarders.rsp\" " +
                "UseSharedCompilation=\"$shared\" TreatWarningsAsErrors=\"true\" WorkerGrant=\"1\" " +
                "Deterministic=\"true\" DebugType=\"portable\" RefAssembly=\"Forwarders.ref.dll\"/>" +
                "</Target></Project>"
        )
        let (exit, diagnostics) = BuildProject(project, directory)
        Assert.True(exit == 0, diagnostics)
        Assert.DoesNotContain("GS9100", diagnostics)
        Assert.Contains("/warnaserror", File.ReadAllLines(Path.Combine(directory, "forwarders.rsp")))
        for suffix in[]string{".dll", ".ref.dll", ".pdb"} {
            Assert.True(File.Exists(Path.Combine(directory, "Forwarders" + suffix)))
        }
    }

    @Fact
    func TargetFrameworkReferenceIdentityIsIsolated() {
        let packages = Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".nuget",
            "packages"
        )
        let netstandard = Path.Combine(packages, "netstandard.library", "2.0.3", "build", "netstandard2.0", "ref")
        Assert.True(Directory.Exists(netstandard), netstandard)
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { func Get() string -> \"value\" }")
        for var i = 0; i < 3; i++ {
            let referenceDirectory string? = if i == 1 {
                netstandard
            } else {
                nil
            }
            let arguments = []string{
                "/out:result.dll",
                "/target:library",
                "/deterministic",
                if i == 1 {
                    "/targetframework:netstandard2.0"
                } else {
                    "/targetframework:net10.0"
                },
                "input.gs"
            }
            let (exit, diagnostics) = Standalone(directory, arguments, referenceDirectory)
            Assert.True(exit == 0, diagnostics)
            let expected = File.ReadAllBytes(Path.Combine(directory, "result.dll"))
            let output = List[string]()
            let errors = List[string]()
            Assert.True(
                Run(directory, arguments, output, errors, out var actual, referenceDirectory: referenceDirectory)
            )
            Assert.Equal(0, actual)
            Assert.Equal[uint8](expected, File.ReadAllBytes(Path.Combine(directory, "result.dll")))
            using let stream = File.OpenRead(Path.Combine(directory, "result.dll"))
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            let names = metadata
                .AssemblyReferences
                .Select(
                (handle AssemblyReferenceHandle) -> metadata.GetString(metadata.GetAssemblyReference(handle).Name)
            )
                .ToArray()
            Assert.Contains(
                if i == 1 {
                    "netstandard"
                } else {
                    "System.Private.CoreLib"
                },
                names
            )
        }
    }

    @Theory
    @InlineData("sp ace", "pipe with spaces")
    @InlineData("λ😀", "管道-😀")
    @InlineData("trailing\\", "space and trailing\\")
    @InlineData("quo\"te", "pipe \"quoted\"\\")
    func WorkerArgumentsRoundTripThroughRealChild(toolDirectoryName string, pipeName string) {
        if Path.DirectorySeparatorChar == '\\' && toolDirectoryName.Contains("\"") {
            return
        }
        File.WriteAllText(
            Path.Combine(directory, "arguments.gs"),
            "import System\nimport System.Text\nfunc Main(args[]string) {\n" +
                "Console.WriteLine(Environment.ProcessId.ToString())\n" +
                "for argument in args { Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(argument))) }\n}"
        )
        let (toolExit, diagnostics) = Standalone(
            directory,
            []string{"/out:arguments.dll", "/target:exe", "/targetframework:net10.0", "arguments.gs"}
        )
        Assert.True(toolExit == 0, diagnostics)
        let toolDirectory = Path.Combine(directory, toolDirectoryName)
        Directory.CreateDirectory(toolDirectory)
        for path in Directory.GetFiles(directory, "arguments.*") {
            File.Copy(path, Path.Combine(toolDirectory, Path.GetFileName(path)))
        }
        let flag = "--roundtrip"
        let start = WorkerProcessClient.CreateStartInfo(Path.Combine(toolDirectory, "arguments.dll"), flag, pipeName)
        let result = RunProcess(start, 10000)
        Assert.True(result.Exit == 0, result.Stderr)
        let lines = result.Stdout.Split([]char{'\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal(result.ProcessId.ToString(), lines[0])
        Assert.Equal(
            []string{flag, pipeName},
            lines.Skip(1).Select((line string) -> Encoding.UTF8.GetString(Convert.FromBase64String(line)))
        )
    }

    @Theory
    @InlineData("none")
    @InlineData("stdout")
    @InlineData("stderr")
    @InlineData("stdin")
    @InlineData("inputencoding")
    @InlineData("outputencoding")
    func SharedServerRetiresEveryMutatedConsoleChannelBeforeAnotherRequest(mode string) {
        File.WriteAllText(
            Path.Combine(directory, "console-worker.gs"),
            "import System\nimport System.Reflection\nfunc Main(args[]string) {\n" +
                "let assembly = Assembly.LoadFrom(\"${EscapeSource(typeof(CompilerWorkerTests).Assembly.Location)}\")\n" +
                "let method = assembly.GetType(\"GSharp.Sdk.Tests.CompilerWorkerTests\")!!.GetMethod(\"RunConsoleMutationWorker\")!!\n" +
                "method.Invoke(nil, []object{Assembly.GetExecutingAssembly().Location, \"${EscapeSource(CompilerPath())}\", args[1]})\n}"
        )
        let (toolExit, diagnostics) = Standalone(
            directory,
            []string{"/out:console-worker.dll", "/target:exe", "/targetframework:net10.0", "console-worker.gs"}
        )
        Assert.True(toolExit == 0, diagnostics)
        for path in Directory.GetFiles(
            Path.GetDirectoryName(typeof(CompilerWorkerTests).Assembly.Location) ?? ".",
            "*.dll"
        ) {
            if !string.Equals(Path.GetFileName(path), "gsc.dll", StringComparison.OrdinalIgnoreCase) {
                File.Copy(path, Path.Combine(directory, Path.GetFileName(path)))
            }
        }
        let tool = Path.Combine(directory, "console-worker.dll")
        Assert.True(
            client.TryRun(
                tool,
                "--compiler-worker",
                directory,
                []string{mode},
                1,
                CancellationToken.None,
                (_line string) -> { },
                (_line string) -> { },
                (line string) -> messages.Add(line),
                out var firstExit
            )
        )
        Assert.Equal(0, firstExit)
        let firstCompleted = messages.Single((line string) -> line.Contains("worker completed"))
        if mode != "none" {
            let pid = int32.Parse(firstCompleted.Split(',')[0].Split('=')[1])
            try {
                using let first = Process.GetProcessById(pid)
                Assert.True(first.HasExited, "A console-mutating worker survived request completion.")
            } catch (ex ArgumentException) {
                // The retired first worker already exited and was reaped.

            }
        }
        let output = List[string]()
        let errors = List[string]()
        Assert.True(
            client.TryRun(
                tool,
                "--compiler-worker",
                directory,
                []string{"next"},
                1,
                CancellationToken.None,
                (line string) -> output.Add(line),
                (line string) -> errors.Add(line),
                (line string) -> messages.Add(line),
                out var nextExit
            )
        )
        Assert.Equal(1, nextExit)
        Assert.Equal[string]([]string{"next warning"}, output)
        Assert.Equal[string]([]string{"next error"}, errors)
        let completed = messages.Where((line string) -> line.Contains("worker completed")).ToArray()
        Assert.Equal(2, completed.Length)
        Assert.Equal(mode != "none", completed[0].Contains("retire=True"))
        Assert.Equal(mode != "none", completed[0].Split(',')[0] != completed[1].Split(',')[0])
    }

    @Fact
    func WindowsNonUtf8ConsolePreservesStandaloneAndWorkerDiagnosticParity() {
        let marker = Path.Combine(directory, "console-proof.txt")
        File.WriteAllText(
            Path.Combine(directory, "console.gs"),
            "import System\nimport System.IO\nimport System.Reflection\n" +
                "func Main(args[]string) {\nif args.Length == 2 {\n" +
                "Console.WriteLine(Console.OutputEncoding.CodePage.ToString())\n" +
                "if args[0] == \"--unicode\" {\nConsole.WriteLine(\"résumé😀\")\nConsole.Error.WriteLine(\"stderr 😀\")\n" +
                "} else { Console.WriteLine(\"résumé\") }\nreturn\n}\n" +
                "try {\nlet assembly = Assembly.LoadFrom(\"${EscapeSource(typeof(CompilerWorkerTests).Assembly.Location)}\")\n" +
                "let method = assembly.GetType(\"GSharp.Sdk.Tests.CompilerWorkerTests\")!!.GetMethod(\"VerifyWindowsConsoleParity\")!!\n" +
                "method.Invoke(nil, []object{args[0], args[1], Assembly.GetExecutingAssembly().Location})\n" +
                "File.WriteAllText(args[2], \"green\")\n} catch (ex Exception) {\n" +
                "File.WriteAllText(args[2], ex.ToString())\nEnvironment.Exit(1)\n}\n}"
        )
        let (toolExit, diagnostics) = Standalone(
            directory,
            []string{"/out:console.dll", "/target:exe", "/targetframework:net10.0", "console.gs"}
        )
        Assert.True(toolExit == 0, diagnostics)
        for path in Directory.GetFiles(
            Path.GetDirectoryName(typeof(CompilerWorkerTests).Assembly.Location) ?? ".",
            "*.dll"
        ) {
            File.Copy(path, Path.Combine(directory, Path.GetFileName(path)))
        }
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        start.ArgumentList.Add(Path.Combine(directory, "console.dll"))
        if Path.DirectorySeparatorChar != '\\' {
            start.ArgumentList.Add("--unicode")
            start.ArgumentList.Add("unused")
            let portable = RunProcess(start)
            Assert.True(portable.Exit == 0, portable.Stderr)
            Assert.Contains("résumé😀", portable.Stdout)
            Assert.Contains("stderr 😀", portable.Stderr)
            let mismatchedStart = WorkerProcessClient.CreateStartInfo(
                Path.Combine(directory, "console.dll"),
                "--unicode",
                "unused"
            )
            mismatchedStart.StandardOutputEncoding = Encoding.Unicode
            mismatchedStart.StandardErrorEncoding = Encoding.Unicode
            let mismatched = RunProcess(mismatchedStart)
            Assert.NotEqual(portable.Stdout, mismatched.Stdout)
            Assert.NotEqual(portable.Stderr, mismatched.Stderr)
            return
        }
        for argument in[]string{CompilerPath(), directory, marker} {
            start.ArgumentList.Add(argument)
        }
        let result = RunProcess(start)
        Assert.True(File.Exists(marker), result.Stderr)
        Assert.True(result.Exit == 0, File.ReadAllText(marker))
        Assert.Equal("green", File.ReadAllText(marker))
    }

    @Theory
    @InlineData("s x")
    @InlineData("u λ")
    @InlineData("q\"x")
    func TemporaryPathWithSpecialCharactersPreservesWorkerReuse(segment string) {
        if Path.DirectorySeparatorChar == '\\' {
            return
        }
        let previous = Environment.GetEnvironmentVariable("TMPDIR")
        let temporaryDirectory = Path.Combine(
            Path.GetTempPath(),
            segment + Guid.NewGuid().ToString("N").Substring(0, 3)
        )
        Directory.CreateDirectory(temporaryDirectory)
        let toolDirectory = Path.Combine(directory, "tool-" + segment)
        Directory.CreateDirectory(toolDirectory)
        for path in Directory.GetFiles(Path.GetDirectoryName(CompilerPath()) ?? ".") {
            File.Copy(path, Path.Combine(toolDirectory, Path.GetFileName(path)))
        }
        let tool = Path.Combine(toolDirectory, "gsc.dll")
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        try {
            Environment.SetEnvironmentVariable("TMPDIR", temporaryDirectory + Path.DirectorySeparatorChar)
            for var i = 0; i < 2; i++ {
                Assert.True(
                    Run(
                        directory,
                        []string{"/out:result${i}.dll", "/target:library", "input.gs"},
                        List[string](),
                        List[string](),
                        out var exit,
                        tool
                    ),
                    string.Join("\n", messages)
                )
                Assert.Equal(0, exit)
                Assert.True(File.Exists(Path.Combine(directory, "result${i}.dll")))
            }
            let completed = messages.Where((m string) -> m.Contains("worker completed:")).ToArray()
            Assert.Equal(2, completed.Length)
            Assert.Equal(completed[0].Split(',')[0], completed[1].Split(',')[0])
            let processField = typeof(WorkerProcessClient).GetField(
                "process",
                BindingFlags.Instance | BindingFlags.NonPublic
            ) ??
                throw InvalidOperationException("The actual worker process is required.")
            let worker = processField.GetValue(client) as Process ??
                throw InvalidOperationException("Successful requests must retain their actual worker.")
            Assert.Equal("G# worker completed: pid=${worker.Id}", completed[0].Split(',')[0])
            Assert.Equal(2, messages.Count((m string) -> m == "G# worker accepted request: pid=${worker.Id}."))
        } finally {
            client.Dispose()
            Environment.SetEnvironmentVariable("TMPDIR", previous)
            Directory.Delete(temporaryDirectory, recursive: true)
        }
    }

    @Fact
    func EnvironmentChangesRestartTheWorker() {
        let name = "GSHARP_WORKER_TEST_" + Guid.NewGuid().ToString("N")
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        try {
            for value in[]string{"first", "second"} {
                Environment.SetEnvironmentVariable(name, value)
                Assert.True(Run(directory, arguments, List[string](), List[string](), out var exit))
                Assert.Equal(0, exit)
            }
        } finally {
            Environment.SetEnvironmentVariable(name, nil)
        }
        let completed = messages.Where((m string) -> m.Contains("worker completed:")).ToArray()
        Assert.Equal(2, completed.Length)
        Assert.NotEqual(completed[0].Split(',')[0], completed[1].Split(',')[0])
    }

    @Fact
    func CancellationAndWorkerLossDoNotRetryAcceptedRequests() {
        File.WriteAllText(Path.Combine(directory, "input.gs"), "open class Sample { }")
        let arguments = []string{"/out:result.dll", "/target:library", "input.gs"}
        using let cancellation = CancellationTokenSource()
        Assert.Throws[OperationCanceledException](
            () -> client.TryRun(
                CompilerPath(),
                "--compiler-worker",
                directory,
                WithReferences(arguments),
                1,
                cancellation.Token,
                (_line string) -> { },
                (_line string) -> { },
                (line string) -> {
                    if line.Contains("accepted request") {
                        cancellation.Cancel()
                    }
                },
                out var _exit
            )
        )
        Assert.True(Run(directory, arguments, List[string](), List[string](), out var restarted))
        Assert.Equal(0, restarted)
        Assert.Throws[IOException](
            () -> client.TryRun(
                CompilerPath(),
                "--compiler-worker",
                directory,
                arguments,
                1,
                CancellationToken.None,
                (_line string) -> { },
                (_line string) -> { },
                (line string) -> {
                    if line.Contains("accepted request") {
                        client.Dispose()
                    }
                },
                out var _exit
            )
        )
        Assert.True(Run(directory, arguments, List[string](), List[string](), out restarted))
        Assert.Equal(0, restarted)
    }

    private func CreateHelperAnalyzer(background bool, failureMode string = "")(Analyzer string, Marker string) {
        let marker = Path.Combine(directory, "helper.pid")
        let escaped = EscapeSource(marker)
        let helperBody = if background {
            "File.WriteAllText(\"${escaped}.new\", Environment.ProcessId.ToString())\n" +
                "File.Move(\"${escaped}.new\", \"$escaped\")\nThread.Sleep(Timeout.Infinite)"
        } else {
            "Console.Out.Write(\"helper-\")\nConsole.Out.Flush()\n" +
                "Console.Out.WriteLine(\"stdout é\")\nConsole.Error.WriteLine(\"helper-stderr\")"
        }
        File.WriteAllText(
            Path.Combine(directory, "helper.gs"),
            "import System\nimport System.IO\nimport System.Threading\nfunc Main() {\n$helperBody\n}"
        )
        let (helperExit, helperDiagnostics) = Standalone(
            directory,
            []string{"/out:helper.dll", "/target:exe", "/targetframework:net10.0", "helper.gs"}
        )
        Assert.True(helperExit == 0, helperDiagnostics)
        let helper = EscapeSource(Path.Combine(directory, "helper.dll"))
        let wait = if background {
            "if !SpinWait.SpinUntil(() -> File.Exists(\"$escaped\"), 5000) { throw Exception(\"helper did not start\") }"
        } else {
            "process.WaitForExit()"
        }
        let termination = if failureMode == "crash" || failureMode == "loggerfailure" {
            "Environment.Exit(73)"
        } else {
            "Thread.Sleep(Timeout.Infinite)"
        }
        let crashAction = if failureMode.Length > 0 {
            "Console.WriteLine(\"crash stdout é\")\nConsole.Write(\"stdout tail é\")\n" +
                "Console.Error.WriteLine(\"crash stderr é\")\nConsole.Error.Write(\"stderr tail é\")\n" +
                "Console.Out.Flush()\nConsole.Error.Flush()\n" +
                "File.WriteAllText(\"${EscapeSource(Path.Combine(directory, "failure.ready"))}\", \"ready\")\n$termination\n"
        } else {
            ""
        }
        File.WriteAllText(
            Path.Combine(directory, "analyzer.gs"),
            "import System\nimport System.IO\nimport System.Diagnostics\nimport System.Threading\n" +
                "import System.Collections.Immutable\nimport GSharp.Core.CodeAnalysis\n" +
                "import GSharp.Core.CodeAnalysis.Analyzers\n" +
                "@GSharpDiagnosticAnalyzer\nclass HelperAnalyzer : GSharpDiagnosticAnalyzer {\n" +
                "override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray[DiagnosticDescriptor].Empty\n" +
                "override func Initialize(context AnalysisContext) {\n" +
                "let start = ProcessStartInfo(\"dotnet\", \"\\\"$helper\\\"\"){UseShellExecute = false}\n" +
                "using let process = Process.Start(start) ?? throw Exception(\"helper startup failed\")\n$wait\n$crashAction}\n}"
        )
        let analyzer = Path.Combine(directory, "analyzer.dll")
        let (analyzerExit, analyzerDiagnostics) = Standalone(
            directory,
            []string{
                "/out:" + analyzer,
                "/target:library",
                "/r:" + typeof(ReferenceResolver).Assembly.Location,
                "analyzer.gs"
            }
        )
        Assert.True(analyzerExit == 0, analyzerDiagnostics)
        return (analyzer, marker)
    }

    private func Run(
        project string,
        arguments[]string,
        output List[string],
        errors List[string],
        out exitCode int32,
        tool string? = nil,
        referenceDirectory string? = nil
    ) bool -> client
        .TryRun(
        tool ?? CompilerPath(),
        "--compiler-worker",
        project,
        WithReferences(arguments, referenceDirectory),
        1,
        CancellationToken.None,
        (line string) -> output.Add(line),
        (line string) -> errors.Add(line),
        (line string) -> messages.Add(line),
        out exitCode
    )

    shared {
        func RunConsoleMutationWorker(tool string, compiler string, pipe string) {
            let server = Assembly.LoadFrom(compiler).GetType("GSharp.Workers.WorkerServer") ??
                throw InvalidOperationException("The actual compiler server is required.")
            let run = server.GetMethod("Run", BindingFlags.NonPublic | BindingFlags.Static) ??
                throw InvalidOperationException("The actual server entrypoint is required.")
            let parameters = run.GetParameters()
            let compile = Delegate.CreateDelegate(
                parameters[1].ParameterType,
                typeof(CompilerWorkerTests).GetMethod("CompileConsoleMutation") ??
                    throw InvalidOperationException("The isolated request callback is required.")
            )
            let canReuse = Delegate.CreateDelegate(
                parameters[2].ParameterType,
                typeof(CompilerWorkerTests).GetMethod("ConsoleAlwaysReusable") ??
                    throw InvalidOperationException("The unconditional reuse probe is required.")
            )
            run.Invoke(nil, []object{tool, compile, canReuse, pipe})
        }

        func ConsoleAlwaysReusable() bool -> true

        func CompileConsoleMutation(arguments[]string) int32 {
            switch arguments[0] {
                case "stdout" {
                    Console.SetOut(TextWriter.Null)
                }
                case "stderr" {
                    Console.SetError(TextWriter.Null)
                }
                case "stdin" {
                    Console.SetIn(TextReader.Null)
                }
                case "inputencoding" {
                    Console.InputEncoding = Encoding.Unicode
                }
                case "outputencoding" {
                    Console.OutputEncoding = Encoding.Unicode
                }
                case "next" {
                    Console.WriteLine("next warning")
                    Console.Error.WriteLine("next error")
                    return 1
                }
            }
            return 0
        }

        @DllImport("kernel32.dll")
        private func AllocConsole() int32;

        @DllImport("kernel32.dll")
        private func FreeConsole() int32;

        func VerifyWindowsConsoleParity(compiler string, directory string, probe string) {
            FreeConsole()
            Assert.True(AllocConsole() != 0)
            try {
                Encoding.RegisterProvider(CodePagesEncodingProvider.Instance)
                for codePage in[]int32{437, 65001} {
                    Console.OutputEncoding = Encoding.GetEncoding(codePage)
                    let flag = if codePage == 437 {
                        "--encoding"
                    } else {
                        "--unicode"
                    }
                    let text = if codePage == 437 {
                        "résumé"
                    } else {
                        "résumé😀"
                    }
                    let inherited = RunProcess(WorkerProcessClient.CreateStartInfo(probe, flag, "unused"))
                    Assert.Equal("${codePage}\n$text", inherited.Stdout.Replace("\r\n", "\n").TrimEnd('\n'))
                    if codePage == 437 {
                        let mismatchedStart = WorkerProcessClient.CreateStartInfo(probe, flag, "unused")
                        mismatchedStart.StandardOutputEncoding = Encoding.UTF8
                        let mismatched = RunProcess(mismatchedStart)
                        Assert.NotEqual(inherited.Stdout, mismatched.Stdout)
                    } else {
                        Assert.Equal("stderr 😀", inherited.Stderr.TrimEnd('\r', '\n'))
                    }

                    let source = text + ".gs"
                    File.WriteAllText(
                        Path.Combine(directory, source),
                        "open class Sample { func Get() int32 -> missingName }"
                    )
                    let arguments = WithReferences([]string{"/out:result.dll", "/target:library", source})
                    let start = ProcessStartInfo("dotnet"){
                        UseShellExecute = false,
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    }
                    start.ArgumentList.Add(compiler)
                    for argument in arguments {
                        start.ArgumentList.Add(argument)
                    }
                    let expected = RunProcess(start)
                    Assert.Equal(1, expected.Exit)
                    let expectedDiagnostics = (expected.Stdout + expected.Stderr).Replace("\r\n", "\n").TrimEnd('\n')
                    Assert.Contains(source, expectedDiagnostics)
                    using let worker = WorkerProcessClient()
                    let output = List[string]()
                    let errors = List[string]()
                    let messages = List[string]()
                    Assert.True(
                        worker.TryRun(
                            compiler,
                            "--compiler-worker",
                            directory,
                            arguments,
                            1,
                            CancellationToken.None,
                            (line string) -> output.Add(line),
                            (line string) -> errors.Add(line),
                            (line string) -> messages.Add(line),
                            out var exit
                        )
                    )
                    Assert.Equal(expected.Exit, exit)
                    Assert.Equal(expectedDiagnostics, string.Join("\n", output.Concat(errors)))
                    Assert.Single(messages.Where((line string) -> line.Contains("worker completed")))
                }
            } finally {
                FreeConsole()
            }
        }

        private func EscapeSource(value string) string -> value.Replace("\\", "\\\\").Replace("\"", "\\\"")

        private func BuildProject(project string, directory string)(Exit int32, Log string) {
            let start = ProcessStartInfo("dotnet"){
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in[]string{"msbuild", project, "-t:Build", "-m:2", "-nr:false", "-v:normal", "-nologo"} {
                start.ArgumentList.Add(argument)
            }
            let (exit, stdout, stderr, _pid) = RunProcess(start)
            return (exit, stdout + stderr)
        }

        @MethodImpl(MethodImplOptions.NoInlining)
        private func CacheSharedGenericOverPrivateType() WeakReference {
            let references = RuntimeReferences()
            Assert.NotEmpty(references)
            using let resolver = ReferenceResolver.WithReferences(references)
            Assert.True(resolver.TryResolveType("System.Text.StringBuilder", out var type))
            let constructed = typeof(List[_]).MakeGenericType(type)
            Assert.Same(typeof(List[_]).Assembly, constructed.Assembly)
            Assert.Same(ImportedTypeSymbol.Get(constructed), ImportedTypeSymbol.Get(constructed))
            let function = typeof(Func[_, _]).MakeGenericType(type, typeof(int32))
            Assert.Same(ImportedTypeSymbol.Get(function), ImportedTypeSymbol.Get(function))
            return WeakReference(type.Assembly)
        }

        private func WithReferences(arguments[]string, directory string? = nil)[]string -> arguments.Concat(
            (
                if directory == nil {
                    RuntimeReferences()
                } else {
                    Directory.GetFiles(directory, "*.dll")
                }
            )
                .OrderBy((path string) -> path, StringComparer.Ordinal).Select((path string) -> "/r:" + path)
        )
            .ToArray()

        private func RuntimeReferences()[]string {
            let runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let paths = ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Where(
                (path string) -> string.Equals(Path.GetDirectoryName(path), runtime, StringComparison.OrdinalIgnoreCase)
            )
                .ToArray()
            Assert.NotEmpty(paths)
            return paths
        }

        private func CompilerPath() string {
            let configuration = Directory.GetParent(Path.GetDirectoryName(typeof(Program).Assembly.Location) ?? ".")
            let path = Path.Combine(configuration?.FullName ?? ".", "Compiler", "gsc.dll")
            Assert.True(File.Exists(path), path)
            return path
        }

        private func Standalone(directory string, arguments[]string, referenceDirectory string? = nil)(
            Exit int32,
            Diagnostics string
        ) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            start.ArgumentList.Add(CompilerPath())
            for argument in WithReferences(arguments, referenceDirectory) {
                start.ArgumentList.Add(argument)
            }
            let (exit, stdout, stderr, _pid) = RunProcess(start)
            let lines = (stdout + stderr).Replace("\r\n", "\n").TrimEnd('\n')
            return (exit, lines)
        }

        private func RunProcess(
            start ProcessStartInfo,
            timeoutMilliseconds int32 = 30000,
            cleanupDescendants(() -> void)? = nil
        )(Exit int32, Stdout string, Stderr string, ProcessId int32) {
            using let deadline = CancellationTokenSource(timeoutMilliseconds)
            using let child = Process.Start(start) ?? throw InvalidOperationException("Cannot start subprocess.")
            let stdout = child.StandardOutput.ReadToEndAsync(deadline.Token)
            let stderr = child.StandardError.ReadToEndAsync(deadline.Token)
            var completed = false
            try {
                child.WaitForExitAsync(deadline.Token).GetAwaiter().GetResult()
                let output = stdout.GetAwaiter().GetResult()
                let errors = stderr.GetAwaiter().GetResult()
                completed = true
                return (child.ExitCode, output, errors, child.Id)
            } catch (ex OperationCanceledException) when deadline.IsCancellationRequested {
                throw TimeoutException("Subprocess ${child.Id} exceeded its $timeoutMilliseconds ms deadline.", ex)
            } finally {
                if !completed {
                    WorkerProcessClient.Kill(child)
                    cleanupDescendants?.Invoke()
                    child.WaitForExit(1000)
                }
            }
        }
    }
}
