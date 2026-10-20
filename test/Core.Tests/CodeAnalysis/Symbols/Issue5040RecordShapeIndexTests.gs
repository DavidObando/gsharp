package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import Xunit

class Issue5040RecordShapeIndexTests {
    @Fact
    func RecordShapes_CachePositiveAndNegativeResults_WithoutCrossingLoadContexts() {
        using let fixture = CSharpFixture("public record Value(int Number); public class NotARecord {}")
        using let first = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        using let second = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        Assert.True(first.TryResolveType("Value", out var record))
        Assert.True(first.TryResolveType("NotARecord", out var ordinary))
        Assert.True(second.TryResolveType("Value", out var otherRecord))
        using let measurements = CompilationMeasurements.Start("test")
        for var i = 0; i < 100; i++ {
            Assert.True(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(record, out _))
            Assert.False(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(ordinary, out _))
        }
        Assert.Equal(200L, measurements.GetCounter("records.shape-queries"))
        Assert.Equal(2L, measurements.GetCounter("records.shape-scans"))
        Assert.True(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(record, out var shape))
        Assert.True(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(otherRecord, out var otherShape))
        Assert.NotSame(shape, otherShape)
        Assert.Equal(3L, measurements.GetCounter("records.shape-scans"))
    }
}
