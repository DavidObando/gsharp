package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.IO
import System.Linq
import System.Text.Json
import Xunit

class Issue5040PhaseMeasurementTests {
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
