package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.Json
import Xunit

class Issue5041BoundedDriverTests {
    @Fact
    func FreshStandaloneProcessesFreezeImplicitReferencesBeforeWorkers() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let first = Path.Combine(fixture.Directory, "first.gs")
        let second = Path.Combine(fixture.Directory, "second.gs")
        let third = Path.Combine(fixture.Directory, "third.gs")
        let fourth = Path.Combine(fixture.Directory, "fourth.gs")
        let output = Path.Combine(fixture.Directory, "implicit.dll")
        File.WriteAllText(first, "package Implicit\nfunc First(x int32) int32 -> x + 1")
        File.WriteAllText(second, "package Implicit\nfunc Second(x int32) int32 -> x + 2")
        File.WriteAllText(third, "package Implicit\nfunc Third(x int32) int32 -> x + 3")
        File.WriteAllText(fourth, "package Implicit\nfunc Fourth(x int32) int32 -> x + 4")
        var baseline[]uint8 = Array.Empty[uint8]()
        var baselinePdb[]uint8 = Array.Empty[uint8]()
        for workers in[]int32{1, 2, 4, 8} {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = fixture.Directory
            }
            for argument in[]string{
                typeof(Program).Assembly.Location,
                "/target:library",
                "/deterministic+",
                "/debug:portable",
                "/out:" + output,
                "--workers:$workers",
                first,
                second,
                third,
                fourth
            } {
                start.ArgumentList.Add(argument)
            }
            start.Environment.Remove("GSHARP_WORKER_GRANT")
            using let process = Process.Start(start)!!
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Standalone compiler exceeded its deadline.")
            }
            Assert.True(process.ExitCode == 0, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
            if workers == 1 {
                baseline = File.ReadAllBytes(output)
                baselinePdb = File.ReadAllBytes(Path.ChangeExtension(output, ".pdb"))
            } else {
                Assert.Equal(baseline, File.ReadAllBytes(output))
                Assert.Equal(baselinePdb, File.ReadAllBytes(Path.ChangeExtension(output, ".pdb")))
            }
        }
    }

    @Fact
    func SmallInputsKeepTheMeasuredSequentialFastPathWhenWorkersAreRequested() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let sibling = Path.Combine(fixture.Directory, "sibling.gs")
        File.WriteAllText(sibling, "package Small\nfunc Sibling() int32 -> 2")
        let report = Path.Combine(fixture.Directory, "small.json")
        let previous = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
        try {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", report)
            let dll = fixture.Compile("package Small\nfunc Value() int32 -> 1", "small", false, "--workers:8", sibling)
            Assert.True(File.Exists(dll))
            using let json = JsonDocument.Parse(File.ReadAllText(report))
            let counters = json.RootElement.GetProperty("Counters")
            Assert.Equal(2, counters.GetProperty("input.sources").GetInt32())
            Assert.Equal(1, counters.GetProperty("workers.active").GetInt32())
            Assert.Equal(1, counters.GetProperty("parse.workers.active").GetInt32())
            Assert.False(counters.TryGetProperty("workers.parallel-batches", out _))
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", previous)
        }
    }

    @Fact
    func ExplicitReferenceNullabilityContextAndDiagnosticsSurviveWorkers() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`#nullable disable
namespace Foreign { public static class Api { public static string Read() => "ok"; } }`, "Foreign")
        let primitiveBodies = string.Concat(
            Enumerable.Range(0, 32).Select((i int32) -> "func Independent$i(x int32) int32 -> x + $i\n")
        )
        let source = "package NullableWorkers\nimport Foreign\nfunc Value() int32 -> Api.Read().Length\n" +
            primitiveBodies
        for mode in[]string{"platform-types", "enabled"} {
            var expected string? = nil
            var image[]uint8 = Array.Empty[uint8]()
            for workers in[]int32{1, 2, 4, 8} {
                let (code, diagnostics) = fixture.TryCompile(
                    source,
                    "nullable",
                    false,
                    "/r:" + library,
                    "/deterministic+",
                    "--nullability:$mode",
                    "--workers:$workers"
                )
                if mode == "platform-types" {
                    Assert.True(code == 0, diagnostics)
                    let bytes = File.ReadAllBytes(Path.Combine(fixture.Directory, "nullable.dll"))
                    if workers == 1 {
                        image = bytes
                    } else {
                        Assert.Equal(image, bytes)
                    }
                } else {
                    Assert.NotEqual(0, code)
                    Assert.Contains("GS0158", diagnostics)
                }
                expected ??= diagnostics
                Assert.Equal(expected, diagnostics)
            }
        }
    }

    @Fact
    func RealDriverWorkersPreserveImplementationReferencePdbAndExecution() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let sources = Enumerable
            .Range(0, 16)
            .Select(
            (file int32) -> {
                let path = Path.Combine(fixture.Directory, "part-$file.gs")
                File.WriteAllText(
                    path,
                    "package Parallel\n" + string.Concat(
                        Enumerable.Range(0, 32).Select(
                            (
                                member int32
                            ) -> "func F${file}_$member(x int32) int32 { let y = x + $member\nif y > 10 { return y }\nreturn x }\n"
                        )
                    )
                )
                return path
            }
        )
            .ToArray()
        let partial = Path.Combine(fixture.Directory, "partial.gs")
        File.WriteAllText(partial, `package Parallel
import System
partial class State {
    var Seed int32 = 5
    shared {
        var Count int32 = 7
        init { Count += 1 }
        func RichRead() int32 -> Build[int32](9).Read()
        private func Build[T](value T) -> object {
            func Read() T -> value
        }
    }
    func Read() int32 -> Seed + Count
}
`)
        const program = `package Parallel
import System
import System.Threading.Tasks
partial class State {
    shared { init { Count *= 2 } }
    func Pure(x int32) int32 -> x + 1
}
interface Reader { func Read() int32; }
func Identity[T](value T) T -> value
private func Make() -> object { func Read() int32 -> 4 }
func Values() sequence[int32] {
    yield 2
    yield 3
}
async func Answer() int32 {
    await Task.Yield()
    return 6
}
async func Main() {
    var captured = 1
    let next = () -> {
        captured += 1
        return captured
    }
    let first = object { let Value = 3 }
    let second = object { let Value = 3 }
    let reader = object : Reader { func Read() int32 -> captured }
    Console.WriteLine(State().Read())
    Console.WriteLine(State().Pure(F0_1(41)))
    Console.WriteLine(State.RichRead())
    Console.WriteLine(Identity(Make().Read()))
    Console.WriteLine(first.Value + second.Value)
    Console.WriteLine(next())
    Console.WriteLine(reader.Read())
    for value in Values() { Console.WriteLine(value) }
    Console.WriteLine(await Answer())
}`
        let report = Path.Combine(fixture.Directory, "phases.json")
        let reference = Path.Combine(fixture.Directory, "parallel.ref.dll")
        let runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let references = []string{
            "/r:" + typeof(object).Assembly.Location,
            "/r:" + typeof(Console).Assembly.Location,
            "/r:" + Path.Combine(runtime, "System.Runtime.dll")
        }
        let previous = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
        let previousGrant = Environment.GetEnvironmentVariable("GSHARP_WORKER_GRANT")
        try {
            Environment.SetEnvironmentVariable("GSHARP_WORKER_GRANT", nil)
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", report)
            var implementation[]uint8 = Array.Empty[uint8]()
            var referenceImage[]uint8 = Array.Empty[uint8]()
            var pdb[]uint8 = Array.Empty[uint8]()
            for workers in[]int32{1, 2, 4, 8, 8, 4, 2} {
                let options = []string{
                    "/deterministic+",
                    "/debug:portable",
                    "/refout:" + reference,
                    "--workers:$workers",
                    partial
                }
                    .Concat(sources)
                    .Concat(references)
                    .ToArray()
                let dll = fixture.Compile(program, "parallel", true, options)
                Assert.Equal("20\n43\n9\n4\n6\n2\n2\n2\n3\n6\n", fixture.Run(dll))
                if workers == 1 {
                    implementation = File.ReadAllBytes(dll)
                    referenceImage = File.ReadAllBytes(reference)
                    pdb = File.ReadAllBytes(Path.ChangeExtension(dll, ".pdb"))
                } else {
                    Assert.Equal(implementation, File.ReadAllBytes(dll))
                    Assert.Equal(referenceImage, File.ReadAllBytes(reference))
                    Assert.Equal(pdb, File.ReadAllBytes(Path.ChangeExtension(dll, ".pdb")))
                    using let measurements = JsonDocument.Parse(File.ReadAllText(report))
                    let counters = measurements.RootElement.GetProperty("Counters")
                    if Environment.ProcessorCount > 1 {
                        Assert.True(counters.GetProperty("bodies.independent").GetInt32() >= 512)
                        Assert.True(counters.GetProperty("workers.parallel-items").GetInt32() >= 528)
                        Assert.True(counters.GetProperty("workers.active").GetInt32() > 1)
                        Assert.True(counters.GetProperty("parse.workers.active").GetInt32() > 1)
                        Assert.True(counters.GetProperty("bodies.workers.active").GetInt32() > 1)
                    }
                }
            }
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", previous)
            Environment.SetEnvironmentVariable("GSHARP_WORKER_GRANT", previousGrant)
        }
    }

    @Fact
    func RealDriverMalformedAndMissingInputsHaveStableSourceOrderedDiagnostics() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let first = Path.Combine(fixture.Directory, "z-first.gs")
        let second = Path.Combine(fixture.Directory, "a-last.gs")
        File.WriteAllText(first, "package Broken\nfunc First( {")
        File.WriteAllText(second, "package Broken\nfunc Last( {")
        let (baselineCode, baseline) = fixture.TryCompile(
            "package Broken\n",
            "broken",
            false,
            "--workers:1",
            first,
            second
        )
        Assert.NotEqual(0, baselineCode)
        Assert.Contains("GS0005", baseline)
        Assert.Contains("z-first.gs", baseline)
        Assert.Contains("a-last.gs", baseline)
        for workers in[]int32{2, 4, 8} {
            let (code, diagnostics) = fixture.TryCompile(
                "package Broken\n",
                "broken",
                false,
                "--workers:$workers",
                first,
                second
            )
            Assert.Equal(baselineCode, code)
            Assert.Equal(baseline, diagnostics)
        }
        let missing = Path.Combine(fixture.Directory, "missing-source.gs")
        let (missingCode, missingBaseline) = fixture.TryCompile(
            "package Broken\n",
            "missing",
            false,
            "--workers:1",
            missing
        )
        Assert.NotEqual(0, missingCode)
        Assert.Contains("Unable to find specified file", missingBaseline)
        let (parallelCode, parallelMissing) = fixture.TryCompile(
            "package Broken\n",
            "missing",
            false,
            "--workers:8",
            missing
        )
        Assert.Equal(missingCode, parallelCode)
        Assert.Equal(missingBaseline, parallelMissing)
    }
}
