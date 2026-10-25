package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Text
import System.Text.Json
import Xunit

class Issue5040PhaseMeasurementTests {
    @Fact
    func LexicalOwnerQueriesDoNotRepeatForHiddenOuterState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace LookupCost5262;
public class Base { public int Value => 9; }`, "ForeignLookupCost5262")
        let source = StringBuilder("package LookupCostConsumer5262\nimport LookupCost5262\n")
        for var level = 0; level < 4; level++ {
            source
                .Append("class Level")
                .Append(level)
                .Append(" { shared { let Value int32 = ")
                .Append(level)
                .Append(" }\n")
        }
        source.Append("class Leaf : Base { func Read() int32 -> Value }\n")
        for var level = 0; level < 4; level++ {
            source.Append("}\n")
        }
        source.Append("System.Console.Write(Level0.Level1.Level2.Level3.Leaf().Read())")
        let report = Path.Combine(fixture.Directory, "lookup.json")
        let previous = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
        try {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", report)
            let executable = fixture.Compile(
                source.ToString(),
                "LookupCost5262",
                true,
                "/r:" + contract,
                "/deterministic+",
                "/debug:none"
            )
            using let json = JsonDocument.Parse(File.ReadAllText(report))
            Assert.Equal(
                int64(1),
                json.RootElement.GetProperty("Counters").GetProperty("binding.lexical-member-owner.queries").GetInt64()
            )
            IlVerifier.Verify(executable, []string{contract})
            Assert.Equal(Encoding.UTF8.GetBytes("9"), Encoding.UTF8.GetBytes(fixture.Run(executable)))
            let measured = File.ReadAllBytes(executable)
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", nil)
            fixture.Compile(
                source.ToString(),
                "LookupCost5262",
                true,
                "/r:" + contract,
                "/deterministic+",
                "/debug:none"
            )
            Assert.Equal(measured, File.ReadAllBytes(executable))
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", previous)
        }
    }

    @Fact
    func RealDriver_OptInMeasurements_PreserveDeterministicOutputAndDiagnostics() {
        let directory = Path.Combine(AppContext.BaseDirectory, "phase-measurement-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        let previous = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
        let previousGrant = Environment.GetEnvironmentVariable("GSHARP_WORKER_GRANT")
        let originalOut = Console.Out
        let originalError = Console.Error
        try {
            let source = Path.Combine(directory, "input.gs")
            let output = Path.Combine(directory, "result.dll")
            let report = Path.Combine(directory, "phases.json")
            File.WriteAllText(source, "package Measurement\nfunc Value() int32 -> 42")
            let args = []string{"/target:library", "/deterministic+", "/debug:none", "/out:" + output, source}
            using let baselineOut = StringWriter()
            using let baselineError = StringWriter()
            Console.SetOut(baselineOut)
            Console.SetError(baselineError)
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", nil)
            Assert.Equal(0, Program.Main(args))
            let baseline = File.ReadAllBytes(output)
            using let measuredOut = StringWriter()
            using let measuredError = StringWriter()
            Console.SetOut(measuredOut)
            Console.SetError(measuredError)
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", report)
            Environment.SetEnvironmentVariable("GSHARP_WORKER_GRANT", "3")
            Assert.Equal(0, Program.Main(args))
            Assert.Equal(baseline, File.ReadAllBytes(output))
            Assert.Equal(baselineOut.ToString(), measuredOut.ToString())
            Assert.Equal(baselineError.ToString(), measuredError.ToString())
            using let json = JsonDocument.Parse(File.ReadAllText(report))
            let phases = json.RootElement.GetProperty("Phases").EnumerateArray().ToArray()
            Assert.NotEmpty(phases)
            for name in[]string{
                "compilation",
                "parse",
                "references.setup",
                "declarations",
                "bodies",
                "emit.implementation"
            } {
                Assert.Contains(phases, (phase JsonElement) -> phase.GetProperty("Name").GetString() == name)
            }
            Assert.Equal(1, json.RootElement.GetProperty("Counters").GetProperty("input.sources").GetInt32())
            Assert.Equal(3, json.RootElement.GetProperty("Counters").GetProperty("workers.granted").GetInt32())
            Assert.Equal(1, json.RootElement.GetProperty("Counters").GetProperty("workers.active").GetInt32())
        } finally {
            Console.SetOut(originalOut)
            Console.SetError(originalError)
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", previous)
            Environment.SetEnvironmentVariable("GSHARP_WORKER_GRANT", previousGrant)
            Directory.Delete(directory, recursive: true)
        }
    }
}
