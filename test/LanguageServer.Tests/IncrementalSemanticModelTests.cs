// <copyright file="IncrementalSemanticModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// ADR-0106 — the incremental LSP <c>SemanticModel</c> build. These tests prove
/// that building the model with the per-tree / per-body memo caches warm
/// (the incremental path) produces results identical to a from-scratch build
/// (the <c>useIncrementalCaches: false</c> oracle): <c>Resolve</c> over every
/// token, <c>GetLocals</c> over every function, and the <c>globals</c> map all
/// agree. They also prove the incremental path actually reuses unchanged files
/// rather than re-walking them, and that non-body-only edits stay correct.
/// </summary>
[Collection("IncrementalSemanticModel")]
public class IncrementalSemanticModelTests
{
    private const string FileA = "/test/a.gs";
    private const string FileB = "/test/b.gs";
    private const string FileC = "/test/c.gs";
    private const string FileD = "/test/d.gs";

    private const string SourceA =
        "package P\n" +
        "class Box {\n" +
        "    var V int32\n" +
        "    init(v int32) {\n" +
        "        V = v\n" +
        "    }\n" +
        "    func Get() int32 {\n" +
        "        var local = V\n" +
        "        return local\n" +
        "    }\n" +
        "}\n";

    private const string SourceB =
        "package P\n" +
        "func MakeBox(n int32) int32 {\n" +
        "    var b = Box(n)\n" +
        "    return b.Get()\n" +
        "}\n";

    private const string SourceC =
        "package P\n" +
        "func Compute(x int32) int32 {\n" +
        "    var sum = 0\n" +
        "    for i, v in [1, 2, 3] {\n" +
        "        sum = sum + v\n" +
        "    }\n" +
        "    return sum + x\n" +
        "}\n";

    private const string SourceD =
        "package P\n" +
        "func Total() int32 {\n" +
        "    return MakeBox(2) + Compute(3)\n" +
        "}\n";

    [Fact]
    public void BodyOnlyEdit_IncrementalModel_MatchesFullRebuild()
    {
        var project = NewProject();
        var comp1 = project.GetCompilation();

        // Warm the per-tree / per-body memo caches with the first compilation.
        _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true);

        // Body-only edit to b.gs: change only the argument literal.
        project.UpdateFile(FileB, SourceB.Replace("Box(n)", "Box(n + 0)"));
        var comp2 = project.GetCompilation();

        // The ADR-0105 fast path engaged (single body-only edit), so the model
        // build runs over a reused global scope — exactly the scenario the
        // incremental build must keep identical.
        Assert.Same(comp1.GlobalScope, comp2.ReusedGlobalScope);

        AssertModelsEquivalent(comp2);
    }

    [Fact]
    public void BodyOnlyEdit_ReusesUnchangedFiles_AndRecomputesEditedFile()
    {
        var project = NewProject();
        var comp1 = project.GetCompilation();
        _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true);

        // Edit a method body in a.gs (the V + 0 keeps the signature identical).
        project.UpdateFile(FileA, SourceA.Replace("return local", "return local + 0"));
        var comp2 = project.GetCompilation();
        Assert.Same(comp1.GlobalScope, comp2.ReusedGlobalScope);

        SemanticLookup.ResetIncrementalCacheCounters();
        _ = SemanticLookup.BuildModelForTest(comp2, useIncrementalCaches: true);

        var nodeStats = SemanticLookup.NodeBucketCacheStats;
        var localStats = SemanticLookup.FunctionLocalsCacheStats;

        // Four files; only a.gs changed. The three unchanged trees are served
        // from the per-tree memo (instance identity), and exactly one tree
        // (a.gs) misses and is re-collected.
        Assert.True(nodeStats.Hits >= 3, $"expected >= 3 node-bucket hits, got {nodeStats.Hits}");
        Assert.True(nodeStats.Misses >= 1, $"expected >= 1 node-bucket miss, got {nodeStats.Misses}");

        // The unchanged files' bodies are served from the BoundBodyCache as the
        // same instances, so their local maps are reused; the edited file's
        // body is fresh and recomputes.
        Assert.True(localStats.Hits >= 1, $"expected >= 1 function-locals hit, got {localStats.Hits}");
    }

    [Fact]
    public void SignatureEdit_FallsBackToFullRebuild_ModelStaysCorrect()
    {
        var project = NewProject();
        var comp1 = project.GetCompilation();
        _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true);

        // Change the parameter type of Compute: a signature edit. ProjectState
        // falls back to a full rebuild (no reused global scope).
        project.UpdateFile(FileC, SourceC.Replace("func Compute(x int32)", "func Compute(x int64)"));
        var comp2 = project.GetCompilation();
        Assert.Null(comp2.ReusedGlobalScope);

        AssertModelsEquivalent(comp2);
    }

    [Fact]
    public void MultipleFilesChanged_FallsBackToFullRebuild_ModelStaysCorrect()
    {
        var project = NewProject();
        var comp1 = project.GetCompilation();
        _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true);

        project.UpdateFile(FileA, SourceA.Replace("return local", "return local + 1"));
        project.UpdateFile(FileC, SourceC.Replace("return sum + x", "return sum + x + 1"));
        var comp2 = project.GetCompilation();
        Assert.Null(comp2.ReusedGlobalScope);

        AssertModelsEquivalent(comp2);
    }

    [Fact]
    public void BodyOnlyEdit_CrossFileReferences_ResolveCorrectly()
    {
        var project = NewProject();
        var comp1 = project.GetCompilation();
        _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true);

        project.UpdateFile(FileB, SourceB.Replace("Box(n)", "Box(n + 0)"));
        var comp2 = project.GetCompilation();
        Assert.Same(comp1.GlobalScope, comp2.ReusedGlobalScope);

        // MakeBox is declared in b.gs and called in d.gs — references must
        // include both the declaration and the cross-file call site.
        var makeBox = comp2.GlobalScope.Functions.Single(f => f.Name == "MakeBox");
        var references = SemanticLookup.FindReferences(comp2, makeBox).ToList();

        Assert.Contains(references, t => System.IO.Path.GetFileName(t.SyntaxTree.Text.FileName) == "b.gs");
        Assert.Contains(references, t => System.IO.Path.GetFileName(t.SyntaxTree.Text.FileName) == "d.gs");
    }

    private static ProjectState NewProject()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(FileA, SourceA);
        project.UpdateFile(FileB, SourceB);
        project.UpdateFile(FileC, SourceC);
        project.UpdateFile(FileD, SourceD);
        return project;
    }

    private static void AssertModelsEquivalent(Compilation compilation)
    {
        var incremental = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: true);
        var full = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: false);

        // 1. Resolve agrees for every identifier token in every file.
        var tokenCount = 0;
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var token in SemanticLookup.EnumerateIdentifierTokens(tree))
            {
                tokenCount++;
                var a = incremental.Resolve(token);
                var b = full.Resolve(token);
                Assert.True(
                    ReferenceEquals(a, b),
                    $"Resolve mismatch for '{token.Text}' at {token.SyntaxTree.Text.FileName}:{token.Span.Start} — incremental={Describe(a)}, full={Describe(b)}");
            }
        }

        Assert.True(tokenCount > 0);

        // 2. GetLocals agrees for every function declaration.
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var function in DescendantsOfType<FunctionDeclarationSyntax>(tree.Root))
            {
                var incrementalLocals = incremental.GetLocals(function);
                var fullLocals = full.GetLocals(function);
                Assert.Equal(fullLocals.Count, incrementalLocals.Count);
                Assert.Equal(
                    fullLocals.OrderBy(s => s.Name).Select(s => s.Name),
                    incrementalLocals.OrderBy(s => s.Name).Select(s => s.Name));
                foreach (var symbol in fullLocals)
                {
                    Assert.Contains(incrementalLocals, s => ReferenceEquals(s, symbol));
                }
            }
        }

        // 3. The globals map agrees (same keys, same symbol instances).
        var incrementalGlobals = incremental.GlobalsSnapshot;
        var fullGlobals = full.GlobalsSnapshot;
        Assert.Equal(fullGlobals.Count, incrementalGlobals.Count);
        foreach (var pair in fullGlobals)
        {
            Assert.True(incrementalGlobals.TryGetValue(pair.Key, out var value), $"globals missing key '{pair.Key}'");
            Assert.Same(pair.Value, value);
        }
    }

    private static string Describe(Symbol symbol) => symbol == null ? "<null>" : $"{symbol.Kind}:{symbol.Name}";

    private static IEnumerable<T> DescendantsOfType<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T match)
        {
            yield return match;
        }

        foreach (var child in root.GetChildren())
        {
            foreach (var descendant in DescendantsOfType<T>(child))
            {
                yield return descendant;
            }
        }
    }
}
