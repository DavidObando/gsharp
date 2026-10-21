package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue5105VisibleImportIndexTests {
    @Fact
    func ViewsUseTreeIdentityAndRetainInterleavedAncestorOrder() {
        let left = Parse("same.gs", "import api = System.Text")
        let right = Parse("same.gs", "import api = System.IO")
        let parent = BoundScope(nil)
        let first = ImportSymbol("First", "First", nil)
        let leftImport = DeclaredImport(left, "api", "System.Text")
        let middle = ImportSymbol("Middle", "Middle", nil)
        let rightImport = DeclaredImport(right, "api", "System.IO")
        let last = ImportSymbol("Last", "Last", nil)
        for import_ in[]ImportSymbol{first, leftImport, middle, rightImport, last} {
            Assert.True(parent.TryImport(import_))
        }
        let child = BoundScope(parent)
        let childImport = DeclaredImport(left, "api", "System.Collections")
        Assert.True(child.TryImport(childImport))
        let reader = BoundScope(BoundScope(child))
        reader.SetCurrentReferencingSyntaxTree(left)
        let leftView = reader.GetDeclaredImports()
        Assert.Equal([]ImportSymbol{first, leftImport, middle, last, childImport}, leftView)
        Assert.True(leftView.Equals(child.GetDeclaredImports()))
        Assert.True(reader.TryLookupImport("api", out var alias))
        Assert.Same(leftImport, alias)
        reader.SetCurrentReferencingSyntaxTree(right)
        Assert.Equal([]ImportSymbol{first, middle, rightImport, last}, reader.GetDeclaredImports())
        Assert.True(reader.TryLookupImport("api", out alias))
        Assert.Same(rightImport, alias)
        reader.SetCurrentReferencingSyntaxTree(nil)
        Assert.Equal([]ImportSymbol{first, middle, last}, reader.GetDeclaredImports())
        Assert.False(reader.TryLookupImport("api", out _))
        reader.SetCurrentReferencingSyntaxTree(left)
        Assert.True(leftView.Equals(reader.GetDeclaredImports()))
        let other = BoundScope(nil)
        Assert.True(other.TryImport(rightImport))
        other.SetCurrentReferencingSyntaxTree(left)
        Assert.Empty(other.GetDeclaredImports())
    }

    @Fact
    func AncestorAndOwnAdditionsInvalidateWarmViewsWithoutChangingOldSnapshots() {
        let tree = Parse("mutation.gs", "import A")
        let root = BoundScope(nil)
        let first = DeclaredImport(tree, "A", "A")
        Assert.True(root.TryImport(first))
        let parent = BoundScope(root)
        let child = BoundScope(parent)
        let own = DeclaredImport(tree, "Own", "Own")
        Assert.True(child.TryImport(own))
        let reader = BoundScope(child)
        reader.SetCurrentReferencingSyntaxTree(tree)
        let before = reader.GetDeclaredImports()
        Assert.Equal([]ImportSymbol{first, own}, before)
        reader.SetCurrentReferencingSyntaxTree(nil)
        Assert.Empty(reader.GetDeclaredImports())
        let added = ImportSymbol("Added", "Added", nil)
        Assert.True(parent.TryImport(added))
        Assert.Equal([]ImportSymbol{added}, reader.GetDeclaredImports())
        reader.SetCurrentReferencingSyntaxTree(tree)
        Assert.Equal([]ImportSymbol{first, added, own}, reader.GetDeclaredImports())
        let rootAdded = DeclaredImport(tree, "RootAdded", "RootAdded")
        Assert.True(root.TryImport(rootAdded))
        Assert.Equal([]ImportSymbol{first, rootAdded, added, own}, reader.GetDeclaredImports())
        let childAdded = DeclaredImport(tree, "ChildAdded", "ChildAdded")
        Assert.True(child.TryImport(childAdded))
        let after = reader.GetDeclaredImports()
        Assert.Equal([]ImportSymbol{first, rootAdded, added, own, childAdded}, after)
        Assert.True(after.Equals(child.GetDeclaredImports()))
        Assert.Equal([]ImportSymbol{first, rootAdded, added}, parent.GetDeclaredImports())
        Assert.Equal([]ImportSymbol{first, own}, before)
    }

    @Fact
    func RepeatedOrdinaryLookupsPartitionOnceAndReuseViewsAcrossLexicalReaders() {
        let scope_ = BoundScope(nil)
        let implicitImport = ImportSymbol("Implicit", "Implicit", nil)
        Assert.True(scope_.TryImport(implicitImport))
        let trees = Enumerable.Range(0, 128).Select((i int32) -> Parse("file$i.gs", "import N$i")).ToArray()
        for var i = 0; i < trees.Length; i++ {
            Assert.True(scope_.TryImport(DeclaredImport(trees[i], "N$i", "N$i")))
        }
        using let measurements = CompilationMeasurements.Start("visible-import-test")
        for var repeat = 0; repeat < 3; repeat++ {
            for var i = 0; i < trees.Length; i++ {
                let reader = BoundScope(BoundScope(scope_))
                reader.SetCurrentReferencingSyntaxTree(trees[i])
                Assert.True(reader.TryLookupImport("N$i", out var found))
                Assert.Equal("N$i", found.Target)
                let view = reader.GetDeclaredImports()
                Assert.Equal(2, view.Length)
                Assert.Same(implicitImport, view[0])
                Assert.True(view.Equals(scope_.GetDeclaredImports()))
            }
        }
        Assert.Equal(129L, measurements.GetCounter("imports.indexed"))
        Assert.Equal(128L, measurements.GetCounter("imports.views-built"))
        Assert.Equal(256L, measurements.GetCounter("imports.view-entries"))
    }

    @Fact
    func IndependentReadersKeepConcurrentTreeViewsSeparate() {
        let left = Parse("left.gs", "import api = System.Text")
        let right = Parse("right.gs", "import api = System.IO")
        let declarations = BoundScope(nil)
        Assert.True(declarations.TryImport(DeclaredImport(left, "api", "System.Text")))
        Assert.True(declarations.TryImport(DeclaredImport(right, "api", "System.IO")))
        Parallel.For(
            0,
            64,
            (index int32) -> {
                let reader = declarations.CreateIndependentBodyScope()
                let tree = if index % 2 == 0 {
                    left
                } else {
                    right
                }
                let target = if index % 2 == 0 {
                    "System.Text"
                } else {
                    "System.IO"
                }
                let previous = reader.SetCurrentReferencingSyntaxTree(tree)
                try {
                    for var repeat = 0; repeat < 8; repeat++ {
                        Assert.Equal(target, Assert.Single(reader.GetDeclaredImports()).Target)
                        Assert.True(reader.TryLookupImport("api", out var found))
                        Assert.Equal(target, found.Target)
                    }
                } finally {
                    reader.SetCurrentReferencingSyntaxTree(previous)
                }
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func OrdinaryClrLookupRetainsFallbackAliasesAndAmbiguityOrder(reverse bool) {
        using let fixture = CSharpFixture(`namespace First5105 { public class Thing {} public class Thing<T> {} }
namespace Second5105 { public class Thing {} public class Thing<T> {} }
namespace Fallback5105 { public class Thing {} public class Thing<T> {} }`)
        using let references = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let first = if reverse {
            "Second5105"
        } else {
            "First5105"
        }
        let second = if reverse {
            "First5105"
        } else {
            "Second5105"
        }
        let tree = Parse("lookup.gs", "import " + first)
        let parent = BoundScope(nil, references)
        Assert.True(parent.TryImport(ImportSymbol("Fallback5105", "Fallback5105", nil)))
        let child = BoundScope(parent)
        Assert.True(child.TryImport(DeclaredImport(tree, first, first)))
        child.SetCurrentReferencingSyntaxTree(tree)
        Assert.True(child.TryLookupImportedClass("Thing", nil, out var type, out var ambiguity))
        Assert.Equal(first + ".Thing", type.ClassType.FullName)
        Assert.Null(ambiguity)
        Assert.True(child.TryLookupImportedGenericClass("Thing", 1, out var generic, out ambiguity))
        Assert.Equal(first + ".Thing`1", generic.FullName)
        Assert.Null(ambiguity)
        Assert.True(child.TryImport(DeclaredImport(tree, second, second)))
        Assert.True(child.TryLookupImportedClass("Thing", nil, out type, out ambiguity))
        Assert.NotNull(ambiguity)
        Assert.Equal(first + ".Thing", ambiguity.First.FullName)
        Assert.Equal(second + ".Thing", ambiguity.Second.FullName)
        Assert.Equal(first + ".Thing", ambiguity.Chosen.FullName)
        Assert.True(child.TryLookupImportedGenericClass("Thing", 1, out generic, out ambiguity))
        Assert.NotNull(ambiguity)
        Assert.Equal(first + ".Thing`1", ambiguity.Chosen.FullName)
        Assert.True(parent.TryImport(DeclaredImport(tree, "Thing", second + ".Thing")))
        Assert.True(child.TryLookupImportedClass("Thing", nil, out type, out ambiguity))
        Assert.Equal(second + ".Thing", type.ClassType.FullName)
        Assert.Null(ambiguity)
        Assert.True(child.TryLookupImportedGenericClass("Thing", 1, out generic, out ambiguity))
        Assert.Equal(second + ".Thing`1", generic.FullName)
        Assert.Null(ambiguity)
        child.SetCurrentReferencingSyntaxTree(nil)
        Assert.True(child.TryLookupImportedClass("Thing", nil, out type, out ambiguity))
        Assert.Equal("Fallback5105.Thing", type.ClassType.FullName)
        Assert.Null(ambiguity)

        let diagnosticTree = Parse(
            "ambiguous.gs",
            "import " + first + "\nimport " + second + "\nfunc Use(value Thing) {}\n"
        )
        let compilation = Compilation(references, diagnosticTree){IsLibrary = true}
        let error = Assert.Single(compilation.GlobalScope.Diagnostics, (d) -> d.Id == "GS0547")
        Assert.Equal("ambiguous.gs", error.Location.FileName)
        Assert.Equal("Thing", diagnosticTree.Text.ToString(error.Location.Span))
        Assert.Contains("would bind '" + first + ".Thing'", error.Message)
    }

    shared {
        private func Parse(fileName string, source string) SyntaxTree -> SyntaxTree.Parse(
            SourceText.From(source, fileName)
        )

        private func DeclaredImport(tree SyntaxTree, name string, target string) ImportSymbol -> ImportSymbol(
            name,
            target,
            tree.Root.Members.OfType[ImportSyntax]().Single()
        )
    }
}
