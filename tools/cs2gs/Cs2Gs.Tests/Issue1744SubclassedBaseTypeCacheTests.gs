// <copyright file="Issue1744SubclassedBaseTypeCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Reflection
import Xunit

/// Issue #1744: `CollectSubclassedBaseTypes` used to enumerate every
/// named type across every referenced assembly (the merged
/// `Compilation.GlobalNamespace`) on every single document translation,
/// an O(assemblies × types × documents) cost. It is now memoized per
/// (cref:Compilation) instance so an N-document batch pays the
/// enumeration once, and the walk itself only visits the source assembly
/// (metadata types can never subclass source types).
open class Issue1744SubclassedBaseTypeCacheTests {
    @Fact
    func MultiDocumentBatch_ReusesSameCachedSetAcrossDocuments() {
        let sourceA = `namespace Probe;

public class Shape
{
    public virtual string Describe() => "shape";
}

public class Circle : Shape
{
    public override string Describe() => base.Describe() + " circle";
}`
        let sourceB = `namespace Probe;

public class Widget
{
    public virtual string Name() => "widget";
}

public class Gadget : Widget
{
    public override string Name() => base.Name() + " gadget";
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("A.cs", sourceA), ("B.cs", sourceB)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippets should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        Assert.Equal(2, project.Documents.Count)
        let translator = CSharpToGSharpTranslator()
        let sets = List[object]()
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            translator.TranslateDocument(document, context)
            sets.Add(GetCachedSetFor(project.Compilation)!!)
        }
        // Every document in the batch shares one `Compilation`, so the cached
        // subclassed-base-type set produced while translating the first
        // document must be the exact same object reused for the second —
        // never recomputed.
        Assert.NotNull(sets[0])
        Assert.Same(sets[0], sets[1])
    }

    @Fact
    func DistinctCompilations_GetIndependentCacheEntries() {
        let source = `namespace Probe;

public class Base1 { public virtual void M() { } }
public class Derived1 : Base1 { public override void M() { } }`
        let project1 = CSharpProjectLoader.LoadInMemory([](string, source string){("A.cs", source)})
        let project2 = CSharpProjectLoader.LoadInMemory([](string, source string){("A.cs", source)})
        Assert.True(project1.BoundWithoutErrors)
        Assert.True(project2.BoundWithoutErrors)
        let translator = CSharpToGSharpTranslator()
        let doc1 = Assert.Single(project1.Documents)
        let context1 = TranslationContext(project1.Compilation, doc1.SemanticModel, doc1.FilePath)
        translator.TranslateDocument(doc1, context1)
        let doc2 = Assert.Single(project2.Documents)
        let context2 = TranslationContext(project2.Compilation, doc2.SemanticModel, doc2.FilePath)
        translator.TranslateDocument(doc2, context2)
        let set1 object? = GetCachedSetFor(project1.Compilation)
        let set2 object? = GetCachedSetFor(project2.Compilation)
        // Two independent `Compilation` instances (even from identical source
        // text) must not share a cache entry — the cache is keyed by
        // compilation reference identity, so edits/new compilations are never
        // served stale data.
        Assert.NotNull(set1)
        Assert.NotNull(set2)
        Assert.NotSame(set1, set2)
    }

    shared {
        private func GetCacheField() FieldInfo? {
            let field FieldInfo? = typeof(CSharpToGSharpTranslator).GetField(
                "SubclassedBaseTypesCache",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(field)
            return field
        }

        private func GetCachedSetFor(compilation Compilation) object? {
            let table object? = GetCacheField()!!.GetValue(nil)
            let tryGetValue MethodInfo? = table!!.GetType().GetMethod("TryGetValue")
            let args = []object? {compilation, nil}
            let found = bool(tryGetValue!!.Invoke(table, args))
            return if found {
                args[1]
            } else {
                default(object?)
            }
        }
    }
}
