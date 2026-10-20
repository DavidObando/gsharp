package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Runtime.CompilerServices
import Xunit

class Issue5040RecordShapeIndexTests {
    @Fact
    func MetadataCandidateCaches_DoNotRetainDisposedReferenceContexts() {
        using let fixture = CSharpFixture(`namespace Weak5040 {
    public record Value(int Number);
    public static class Extensions {
        public static int Touch(this string value) => value.Length;
    }
}`)
        let weak = PopulateMetadataCaches(fixture.AssemblyPath)
        for var i = 0; i < 3; i++ {
            GC.Collect()
            GC.WaitForPendingFinalizers()
        }
        Assert.False(weak.TryGetTarget(out _))
    }

    shared {
        @MethodImpl(MethodImplOptions.NoInlining)
        private func PopulateMetadataCaches(path string) WeakReference[Type] {
            using let resolver = ReferenceResolver.WithReferences([]string{path})
            Assert.True(resolver.TryResolveType("Weak5040.Value", out var record))
            Assert.True(ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(record, out _))
            Assert.True(resolver.TryResolveType("Weak5040.Extensions", out var holder))
            let scope_ = BoundScope(nil, resolver)
            Assert.True(scope_.TryImport(ImportSymbol("Weak5040", "Weak5040", nil)))
            Assert.Single(MemberLookup(BinderContext(scope_)).CollectImportedExtensionMethods("Touch"))
            Assert.NotEmpty(resolver.ExportMetadataIndex().ToNameIndex())
            return WeakReference[Type](holder)
        }
    }

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
