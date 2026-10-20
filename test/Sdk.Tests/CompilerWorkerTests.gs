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
        Assert.Contains("helper-stdout 😀", output)
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

    private func CreateHelperAnalyzer(background bool)(Analyzer string, Marker string) {
        let marker = Path.Combine(directory, "helper.pid")
        let escaped = EscapeSource(marker)
        let helperBody = if background {
            "File.WriteAllText(\"${escaped}.new\", Environment.ProcessId.ToString())\n" +
                "File.Move(\"${escaped}.new\", \"$escaped\")\nThread.Sleep(Timeout.Infinite)"
        } else {
            "Console.Out.Write(\"helper-\")\nConsole.Out.Flush()\n" +
                "Console.Out.WriteLine(\"stdout 😀\")\nConsole.Error.WriteLine(\"helper-stderr\")"
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
        File.WriteAllText(
            Path.Combine(directory, "analyzer.gs"),
            "import System\nimport System.IO\nimport System.Diagnostics\nimport System.Threading\n" +
                "import System.Collections.Immutable\nimport GSharp.Core.CodeAnalysis\n" +
                "import GSharp.Core.CodeAnalysis.Analyzers\n" +
                "@GSharpDiagnosticAnalyzer\nclass HelperAnalyzer : GSharpDiagnosticAnalyzer {\n" +
                "override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray[DiagnosticDescriptor].Empty\n" +
                "override func Initialize(context AnalysisContext) {\n" +
                "let start = ProcessStartInfo(\"dotnet\", \"\\\"$helper\\\"\"){UseShellExecute = false}\n" +
                "using let process = Process.Start(start) ?? throw Exception(\"helper startup failed\")\n$wait\n}\n}"
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
            let (exit, stdout, stderr) = RunProcess(start)
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
            let (exit, stdout, stderr) = RunProcess(start)
            let lines = (stdout + stderr).Replace("\r\n", "\n").TrimEnd('\n')
            return (exit, lines)
        }

        private func RunProcess(start ProcessStartInfo, timeoutMilliseconds int32 = 30000)(
            Exit int32,
            Stdout string,
            Stderr string
        ) {
            using let child = Process.Start(start) ?? throw InvalidOperationException("Cannot start subprocess.")
            let stdout = child.StandardOutput.ReadToEndAsync()
            let stderr = child.StandardError.ReadToEndAsync()
            if !child.WaitForExit(timeoutMilliseconds) {
                try {
                    child.Kill(entireProcessTree: true)
                } catch (ex InvalidOperationException) {
                    // The subprocess exited after the timed wait.

                }
                child.WaitForExit()
                throw TimeoutException("Subprocess ${child.Id} exceeded its $timeoutMilliseconds ms deadline.")
            }
            return (child.ExitCode, stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult())
        }
    }
}
