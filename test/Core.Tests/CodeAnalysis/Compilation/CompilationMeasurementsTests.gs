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
