// <copyright file="Issue1744SubclassedBaseTypeCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1744: <c>CollectSubclassedBaseTypes</c> used to enumerate every
/// named type across every referenced assembly (the merged
/// <c>Compilation.GlobalNamespace</c>) on every single document translation,
/// an O(assemblies × types × documents) cost. It is now memoized per
/// <see cref="Compilation"/> instance so an N-document batch pays the
/// enumeration once, and the walk itself only visits the source assembly
/// (metadata types can never subclass source types).
/// </summary>
public class Issue1744SubclassedBaseTypeCacheTests
{
    [Fact]
    public void MultiDocumentBatch_ReusesSameCachedSetAcrossDocuments()
    {
        var sourceA = """
            namespace Probe;

            public class Shape
            {
                public virtual string Describe() => "shape";
            }

            public class Circle : Shape
            {
                public override string Describe() => base.Describe() + " circle";
            }
            """;

        var sourceB = """
            namespace Probe;

            public class Widget
            {
                public virtual string Name() => "widget";
            }

            public class Gadget : Widget
            {
                public override string Name() => base.Name() + " gadget";
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("A.cs", sourceA),
            ("B.cs", sourceB),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippets should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(2, project.Documents.Count);

        var translator = new CSharpToGSharpTranslator();
        var sets = new List<object>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            translator.TranslateDocument(document, context);
            sets.Add(GetCachedSetFor(project.Compilation));
        }

        // Every document in the batch shares one `Compilation`, so the cached
        // subclassed-base-type set produced while translating the first
        // document must be the exact same object reused for the second —
        // never recomputed.
        Assert.NotNull(sets[0]);
        Assert.Same(sets[0], sets[1]);
    }

    [Fact]
    public void DistinctCompilations_GetIndependentCacheEntries()
    {
        var source = """
            namespace Probe;

            public class Base1 { public virtual void M() { } }
            public class Derived1 : Base1 { public override void M() { } }
            """;

        LoadedCSharpProject project1 = CSharpProjectLoader.LoadInMemory(new[] { ("A.cs", source) });
        LoadedCSharpProject project2 = CSharpProjectLoader.LoadInMemory(new[] { ("A.cs", source) });
        Assert.True(project1.BoundWithoutErrors);
        Assert.True(project2.BoundWithoutErrors);

        var translator = new CSharpToGSharpTranslator();

        LoadedDocument doc1 = Assert.Single(project1.Documents);
        var context1 = new TranslationContext(project1.Compilation, doc1.SemanticModel, doc1.FilePath);
        translator.TranslateDocument(doc1, context1);

        LoadedDocument doc2 = Assert.Single(project2.Documents);
        var context2 = new TranslationContext(project2.Compilation, doc2.SemanticModel, doc2.FilePath);
        translator.TranslateDocument(doc2, context2);

        object set1 = GetCachedSetFor(project1.Compilation);
        object set2 = GetCachedSetFor(project2.Compilation);

        // Two independent `Compilation` instances (even from identical source
        // text) must not share a cache entry — the cache is keyed by
        // compilation reference identity, so edits/new compilations are never
        // served stale data.
        Assert.NotNull(set1);
        Assert.NotNull(set2);
        Assert.NotSame(set1, set2);
    }

    private static FieldInfo GetCacheField()
    {
        FieldInfo field = typeof(CSharpToGSharpTranslator).GetField(
            "SubclassedBaseTypesCache",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(field);
        return field;
    }

    private static object GetCachedSetFor(Compilation compilation)
    {
        object table = GetCacheField().GetValue(null);
        MethodInfo tryGetValue = table.GetType().GetMethod("TryGetValue");
        var args = new object[] { compilation, null };
        var found = (bool)tryGetValue.Invoke(table, args);
        return found ? args[1] : null;
    }
}
