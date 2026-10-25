package GSharp.Core.Tests.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.IO
import System.Linq
import System.Text.Json
import Xunit

class CompilationMeasurementsTests {
    @Fact
    func ReusedDeclarations_AreCountedButDoNotProduceDeclarationSpans() {
        let tree = SyntaxTree.Parse("package P\nfunc Value() int32 {\n    return 42\n}\n")
        let original = Compilation(tree){IsLibrary = true}
        let globals = original.GlobalScope
        let path = Path.Combine(AppContext.BaseDirectory, "reuse-" + Guid.NewGuid().ToString("N") + ".json")
        try {
            using let measurements = CompilationMeasurements.Start("reuse")
            let edited = SyntaxTree.Parse("package P\nfunc Value() int32 {\n    return 43\n}\n")
            let updated = original.ReplaceSyntaxTree(tree, edited)
            Assert.Same(globals, updated.GlobalScope)
            Assert.Empty(updated.BoundProgram.Diagnostics)
            measurements.WriteJson(path)
            using let json = JsonDocument.Parse(File.ReadAllText(path))
            let phases = json.RootElement.GetProperty("Phases").EnumerateArray().ToArray()
            Assert.NotEmpty(phases)
            Assert.Contains(phases, (phase JsonElement) -> phase.GetProperty("Name").GetString() == "bodies")
            Assert.DoesNotContain(
                phases,
                (phase JsonElement) -> phase.GetProperty("Name").GetString() == "declarations"
            )
            Assert.Equal(1L, measurements.GetCounter("declarations.reuses"))
        } finally {
            File.Delete(path)
        }
    }

    @Fact
    func SeparateRequests_ShareOneMonotonicTimeOrigin() {
        let firstPath = Path.Combine(AppContext.BaseDirectory, "clock-first-" + Guid.NewGuid().ToString("N") + ".json")
        let secondPath = firstPath + ".second"
        try {
            using let first = CompilationMeasurements.Start("first")
            using let firstPhase = CompilationMeasurements.BeginPhase("first-phase")
            firstPhase.Dispose()
            first.WriteJson(firstPath)
            first.Dispose()
            using let second = CompilationMeasurements.Start("second")
            using let secondPhase = CompilationMeasurements.BeginPhase("second-phase")
            secondPhase.Dispose()
            second.WriteJson(secondPath)
            using let firstJson = JsonDocument.Parse(File.ReadAllText(firstPath))
            using let secondJson = JsonDocument.Parse(File.ReadAllText(secondPath))
            let firstSpan = firstJson.RootElement.GetProperty("Phases")[0]
            let secondSpan = secondJson.RootElement.GetProperty("Phases")[0]
            let firstEnd = firstSpan.GetProperty("StartMilliseconds").GetDouble() + firstSpan.GetProperty(
                "ElapsedMilliseconds"
            )
                .GetDouble()
            Assert.True(secondSpan.GetProperty("StartMilliseconds").GetDouble() >= firstEnd)
            Assert.True(secondJson.RootElement.GetProperty("RequestStartMilliseconds").GetDouble() >= firstEnd)
            Assert.Equal(
                firstJson.RootElement.GetProperty("TimestampFrequency").GetInt64(),
                secondJson.RootElement.GetProperty("TimestampFrequency").GetInt64()
            )
        } finally {
            File.Delete(firstPath)
            File.Delete(secondPath)
        }
    }

    @Fact
    func ExplicitHostSession_OwnsCountersWhenEnvironmentProfilingIsEnabled() {
        let previous = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
        let path = Path.Combine(AppContext.BaseDirectory, "hosted-" + Guid.NewGuid().ToString("N") + ".json")
        try {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", path)
            using let host = CompilationMeasurements.Start("host")
            using let driver = CompilationMeasurements.StartFromEnvironment("driver")
            CompilationMeasurements.Count("owned-by-host")
            Assert.Equal(1L, host.GetCounter("owned-by-host"))
            Assert.False(File.Exists(path))
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_MEASURE_PHASES", previous)
            File.Delete(path)
        }
    }

    @Fact
    func DisabledMeasurements_DoNotAllocatePerLookup() {
        CompilationMeasurements.Count("disabled")
        using let warmup = CompilationMeasurements.BeginPhase("disabled")
        let before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < 1000; i++ {
            CompilationMeasurements.Count("disabled")
            using let phase = CompilationMeasurements.BeginPhase("disabled")
        }
        Assert.Equal(before, GC.GetAllocatedBytesForCurrentThread())
    }

    @Fact
    func Measurements_RecordNestedRealCompilation_WithoutChangingOutputs() {
        let tree = SyntaxTree.Parse("package P\nfunc Value() int32 -> 42")
        using let baseline = MemoryStream()
        Assert.True(
            Compilation(tree){IsLibrary = true, DebugInformation = DebugInformationOptions(){Deterministic = true}}
                .Emit(baseline).Success
        )
        using let measurements = CompilationMeasurements.Start("test")
        using let measured = MemoryStream()
        using let reference = MemoryStream()
        using let docs = MemoryStream()
        Assert.True(
            Compilation(tree){IsLibrary = true, DebugInformation = DebugInformationOptions(){Deterministic = true}}
                .Emit(measured, nil, reference, docs).Success
        )
        Assert.Equal(baseline.ToArray(), measured.ToArray())
        let path = Path.Combine(AppContext.BaseDirectory, "measurements-" + Guid.NewGuid().ToString("N") + ".json")
        try {
            measurements.WriteJson(path)
            using let json = JsonDocument.Parse(File.ReadAllText(path))
            let root = json.RootElement
            Assert.Equal(1, root.GetProperty("SchemaVersion").GetInt32())
            let phases = root.GetProperty("Phases").EnumerateArray().ToArray()
            Assert.NotEmpty(phases)
            for name in[]string{
                "declarations",
                "bodies",
                "lowering.iterators",
                "emit.implementation",
                "emit.reference",
                "documentation.emit"
            } {
                Assert.Contains(phases, (phase JsonElement) -> phase.GetProperty("Name").GetString() == name)
            }
            let body = phases.Single((phase JsonElement) -> phase.GetProperty("Name").GetString() == "bodies")
            let analyses = phases.Single(
                (phase JsonElement) -> phase.GetProperty("Name").GetString() == "bodies.whole-program-analyses"
            )
            Assert.Equal(body.GetProperty("Id").GetInt32(), analyses.GetProperty("ParentId").GetInt32())
            Assert.True(body.GetProperty("ElapsedMilliseconds").GetDouble() > 0)
            Assert.True(body.GetProperty("ProcessAllocatedBytes").GetInt64() > 0)
        } finally {
            File.Delete(path)
        }
    }
}
