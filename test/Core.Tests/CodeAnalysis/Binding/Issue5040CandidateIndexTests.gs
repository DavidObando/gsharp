package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue5040CandidateIndexTests {
    @Fact
    func AliasCollisionCandidates_ObserveImportsPackagesAndLaterCollisions() {
        let tree = SyntaxTree.Parse("import B")
        let import_ = tree.Root.Members.OfType[ImportSyntax]().Single()
        let scope_ = BoundScope(nil)
        Assert.True(scope_.TryDeclareTypeAlias("Choice", TypeSymbol.Int32, "A"))
        Assert.True(scope_.TryDeclareTypeAlias("Choice", TypeSymbol.String, "B"))
        Assert.True(scope_.TryImport(ImportSymbol("B", "B", import_)))
        scope_.SetCurrentReferencingSyntaxTree(tree)
        Assert.True(scope_.TryLookupTypeAlias("Choice", 0, out var imported, out var ambiguous))
        Assert.False(ambiguous)
        Assert.Same(TypeSymbol.String, imported)
        Assert.True(scope_.TryDeclareTypeAlias("Choice", TypeSymbol.Bool, "C"))
        Assert.True(scope_.TryImport(ImportSymbol("C", "C", declaration: nil)))
        Assert.False(scope_.TryLookupTypeAlias("Choice", 0, out _, out ambiguous))
        Assert.True(ambiguous)
        scope_.SetCurrentDeclaringPackage("A")
        Assert.True(scope_.TryLookupTypeAlias("Choice", out var own))
        Assert.Same(TypeSymbol.Int32, own)
        scope_.SetCurrentDeclaringPackage(nil)
        scope_.SetQualifiedConstructionPackageHint("C")
        Assert.True(scope_.TryLookupTypeAlias("Choice", out var qualified))
        Assert.Same(TypeSymbol.Bool, qualified)
    }

    @Fact
    func AliasCandidates_DoNotVisitUnrelatedNames_AndObserveLaterDeclarations() {
        let scope_ = BoundScope(nil)
        for var i = 0; i < 1000; i++ {
            Assert.True(scope_.TryDeclareTypeAlias("Unrelated$i", TypeSymbol.Int32))
        }
        using let measurements = CompilationMeasurements.Start("test")
        for var i = 0; i < 100; i++ {
            Assert.False(scope_.TryLookupTypeAlias("Wanted", out _))
        }
        Assert.Equal(0L, measurements.GetCounter("alias.candidate-visits"))
        Assert.True(scope_.TryDeclareTypeAlias("Wanted", TypeSymbol.Bool))
        Assert.True(scope_.TryLookupTypeAlias("Wanted", out var found))
        Assert.Same(TypeSymbol.Bool, found)
        Assert.InRange(measurements.GetCounter("alias.candidate-visits"), 1L, 2L)
    }

    @Fact
    func CandidateSnapshot_StaysImmutableAcrossNestedPromotionAndChildOverrides() {
        let declarations = Binder.BindGlobalScope(nil, ImmutableArray.Create(SyntaxTree.Parse(`package P
class Outer { class Item[T] {} }
`)))
        Assert.Empty(declarations.Diagnostics)
        let nested = declarations.Structs.Single((type StructSymbol) -> type.Name == "Item")
        let outer = declarations.Structs.Single((type StructSymbol) -> type.Name == "Outer")
        let parent = BoundScope(nil)
        Assert.True(parent.TryDeclareTypeAlias("Item", nested))
        let snapshot = parent.CaptureTypeAliasIndex()
        let child = BoundScope(parent)
        let top = StructSymbol("Item", ImmutableArray[FieldSymbol].Empty, Accessibility.Public, nil, "P")
        top.SetTypeParameters(nested.TypeParameters)
        Assert.True(child.TryDeclareTypeAlias("Item", top))
        Assert.True(child.TryLookupTypeAlias("Item", preferredArity: 1, out var direct))
        Assert.Same(top, direct)
        for var i = 0; i < 1000; i++ {
            Assert.True(child.TryDeclareTypeAlias("Unrelated$i", TypeSymbol.Int32))
        }
        using let measurements = CompilationMeasurements.Start("test")
        Assert.True(child.TryLookupNestedTypeAlias(outer, "Item", preferredArity: -1, out var qualified))
        Assert.Same(nested, qualified)
        Assert.InRange(measurements.GetCounter("alias.nested-candidate-visits"), 1L, 2L)
        Assert.Same(nested, child.CaptureNestedTypeAliasIndex()[(cast[TypeSymbol](outer), "Item")]["Outer.Item`1"])
        Assert.Same(nested, snapshot["Item"]["Item`1"])
        Assert.False(snapshot.ContainsKey("Outer.Item"))
        Assert.Same(top, child.CaptureTypeAliasIndex()["Item"]["Item`1"])
        Assert.True(parent.TryLookupTypeAlias("Item", preferredArity: 1, out var unchanged))
        Assert.Same(nested, unchanged)
    }

    @Fact
    func ImportedExtensionIndex_ReusesPositiveAndNegativeBuckets_AndInvalidatesEqualCountScopes() {
        using let fixture = CSharpFixture(`namespace ExtensionsA {
    public static class Extensions {
        public static int Select(this string value) => value.Length;
        public static int Other(this string value) => 0;
    }
}
namespace ExtensionsB { public static class Empty {} }`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let first = BoundScope(nil, resolver)
        Assert.True(first.TryImport(ImportSymbol("ExtensionsA", "ExtensionsA", nil)))
        let context = BinderContext(first)
        let lookup = MemberLookup(context)
        using let measurements = CompilationMeasurements.Start("test")
        let candidates = lookup.CollectImportedExtensionMethods("Select")
        Assert.NotEmpty(candidates)
        let visited = measurements.GetCounter("extensions.method-visits")
        Assert.True(visited > 0)
        Assert.Equal(candidates, lookup.CollectImportedExtensionMethods("Select"))
        Assert.Empty(lookup.CollectImportedExtensionMethods("NoSuchExtension5040"))
        Assert.Empty(lookup.CollectImportedExtensionMethods("NoSuchExtension5040"))
        Assert.Equal(visited, measurements.GetCounter("extensions.method-visits"))
        let second = BoundScope(nil, resolver)
        Assert.True(second.TryImport(ImportSymbol("ExtensionsB", "ExtensionsB", nil)))
        context.RootScope = second
        Assert.Empty(lookup.CollectImportedExtensionMethods("Select"))
        context.RootScope = first
        Assert.NotEmpty(lookup.CollectImportedExtensionMethods("Select"))
    }

    @Fact
    func ImportedExtensionIndex_ConsumerChangesReapplyFriendAccessibility() {
        using let fixture = CSharpFixture(`using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Friend5040")]
namespace Extensions5040 {
    public static class Methods {
        internal static int Hidden(this string value) => value.Length;
        public static int Visible(this string value) => value.Length;
    }
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        resolver.CurrentAssemblyName = "Other5040"
        let scope_ = BoundScope(nil, resolver)
        Assert.True(scope_.TryImport(ImportSymbol("Extensions5040", "Extensions5040", nil)))
        let lookup = MemberLookup(BinderContext(scope_))
        Assert.Empty(lookup.CollectImportedExtensionMethods("Hidden"))
        Assert.Single(lookup.CollectImportedExtensionMethods("Visible"))
        resolver.CurrentAssemblyName = "Friend5040"
        Assert.Single(lookup.CollectImportedExtensionMethods("Hidden"))
        resolver.CurrentAssemblyName = "Other5040"
        Assert.Empty(lookup.CollectImportedExtensionMethods("Hidden"))
    }
}
