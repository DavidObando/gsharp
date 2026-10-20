package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import System.Text.Json
import Xunit

class Issue5041BoundedDriverTests {
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
    }
    func Read() int32 -> Seed + Count
}
`)
        const program = `package Parallel
import System
import System.Threading.Tasks
partial class State { func Pure(x int32) int32 -> x + 1 }
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
    Console.WriteLine(Identity(Make().Read()))
    Console.WriteLine(first.Value + second.Value)
    Console.WriteLine(next())
    Console.WriteLine(reader.Read())
    for value in Values() { Console.WriteLine(value) }
    Console.WriteLine(await Answer())
}`
        let report = Path.Combine(fixture.Directory, "phases.json")
        let reference = Path.Combine(fixture.Directory, "parallel.ref.dll")
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
                    .Concat(sources).ToArray()
                let dll = fixture.Compile(program, "parallel", true, options)
                Assert.Equal("13\n43\n4\n6\n2\n2\n2\n3\n6\n", fixture.Run(dll))
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
                    Assert.True(counters.GetProperty("bodies.independent").GetInt32() >= 512)
                    Assert.True(counters.GetProperty("workers.parallel-items").GetInt32() >= 528)
                    if Environment.ProcessorCount > 1 {
                        Assert.True(counters.GetProperty("workers.active").GetInt32() > 1)
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
