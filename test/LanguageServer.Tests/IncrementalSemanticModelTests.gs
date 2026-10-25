// <copyright file="IncrementalSemanticModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0106 — the incremental LSP `SemanticModel` build. These tests prove
/// that building the model with the per-tree / per-body memo caches warm
/// (the incremental path) produces results identical to a from-scratch build
/// (the `useIncrementalCaches: false` oracle): `Resolve` over every
/// token, `GetLocals` over every function, and the `globals` map all
/// agree. They also prove the incremental path actually reuses unchanged files
/// rather than re-walking them, and that non-body-only edits stay correct.
@Collection("IncrementalSemanticModel")
open class IncrementalSemanticModelTests {
    @Fact
    func BodyOnlyEdit_IncrementalModel_MatchesFullRebuild() {
        let project = NewProject()
        let comp1 = project.GetCompilation()
        // Warm the per-tree / per-body memo caches with the first compilation.
        let _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true)
        // Body-only edit to b.gs: change only the argument literal.
        project.UpdateFile(FileB, SourceB.Replace("Box(n)", "Box(n + 0)"))
        let comp2 = project.GetCompilation()
        // The ADR-0105 fast path engaged (single body-only edit), so the model
        // build runs over a reused global scope — exactly the scenario the
        // incremental build must keep identical.
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope)
        AssertModelsEquivalent(comp2)
    }

    @Fact
    func BodyOnlyEdit_ReusesUnchangedFiles_AndRecomputesEditedFile() {
        let project = NewProject()
        let comp1 = project.GetCompilation()
        let _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true)
        // Edit a method body in a.gs (the V + 0 keeps the signature identical).
        project.UpdateFile(FileA, SourceA.Replace("return local", "return local + 0"))
        let comp2 = project.GetCompilation()
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope)
        SemanticLookup.ResetIncrementalCacheCounters()
        let _ = SemanticLookup.BuildModelForTest(comp2, useIncrementalCaches: true)
        let nodeStats = SemanticLookup.NodeBucketCacheStats
        let localStats = SemanticLookup.FunctionLocalsCacheStats
        // Four files; only a.gs changed. The three unchanged trees are served
        // from the per-tree memo (instance identity), and exactly one tree
        // (a.gs) misses and is re-collected.
        Assert.True(nodeStats.Hits >= int64(3), "expected >= 3 node-bucket hits, got ${nodeStats.Hits}")
        Assert.True(nodeStats.Misses >= int64(1), "expected >= 1 node-bucket miss, got ${nodeStats.Misses}")
        // The unchanged files' bodies are served from the BoundBodyCache as the
        // same instances, so their local maps are reused; the edited file's
        // body is fresh and recomputes.
        Assert.True(localStats.Hits >= int64(1), "expected >= 1 function-locals hit, got ${localStats.Hits}")
    }

    @Fact
    func SignatureEdit_FallsBackToFullRebuild_ModelStaysCorrect() {
        let project = NewProject()
        let comp1 = project.GetCompilation()
        let _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true)
        // Change the parameter type of Compute: a signature edit. ProjectState
        // falls back to a full rebuild (no reused global scope).
        project.UpdateFile(FileC, SourceC.Replace("func Compute(x int32)", "func Compute(x int64)"))
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope)
        AssertModelsEquivalent(comp2)
    }

    @Fact
    func MultipleFilesChanged_FallsBackToFullRebuild_ModelStaysCorrect() {
        let project = NewProject()
        let comp1 = project.GetCompilation()
        let _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true)
        project.UpdateFile(FileA, SourceA.Replace("return local", "return local + 1"))
        project.UpdateFile(FileC, SourceC.Replace("return sum + x", "return sum + x + 1"))
        let comp2 = project.GetCompilation()
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope)
        AssertModelsEquivalent(comp2)
    }

    @Fact
    func BodyOnlyEdit_CrossFileReferences_ResolveCorrectly() {
        let project = NewProject()
        let comp1 = project.GetCompilation()
        let _ = SemanticLookup.BuildModelForTest(comp1, useIncrementalCaches: true)
        project.UpdateFile(FileB, SourceB.Replace("Box(n)", "Box(n + 0)"))
        let comp2 = project.GetCompilation()
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope)
        // MakeBox is declared in b.gs and called in d.gs — references must
        // include both the declaration and the cross-file call site.
        let makeBox = comp2.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MakeBox")
        let references = SemanticLookup.FindReferences(comp2, makeBox).ToList()
        Assert.Contains(references, (t SyntaxToken) -> Path.GetFileName(t.SyntaxTree.Text.FileName) == "b.gs")
        Assert.Contains(references, (t SyntaxToken) -> Path.GetFileName(t.SyntaxTree.Text.FileName) == "d.gs")
    }

    shared {
        private const FileA string = "/test/a.gs"
        private const FileB string = "/test/b.gs"
        private const FileC string = "/test/c.gs"
        private const FileD string = "/test/d.gs"
        private const SourceA string = "package P\n" +
            "class Box {\n" +
            "    var V int32\n" +
            "    init(v int32) {\n" +
            "        V = v\n" +
            "    }\n" +
            "    func Get() int32 {\n" +
            "        var local = V\n" +
            "        return local\n" +
            "    }\n" +
            "}\n"
        private const SourceB string = "package P\n" +
            "func MakeBox(n int32) int32 {\n" +
            "    var b = Box(n)\n" +
            "    return b.Get()\n" +
            "}\n"
        private const SourceC string = "package P\n" +
            "func Compute(x int32) int32 {\n" +
            "    var sum = 0\n" +
            "    for i, v in [1, 2, 3] {\n" +
            "        sum = sum + v\n" +
            "    }\n" +
            "    return sum + x\n" +
            "}\n"
        private const SourceD string = "package P\n" +
            "func Total() int32 {\n" +
            "    return MakeBox(2) + Compute(3)\n" +
            "}\n"

        private func NewProject() ProjectState {
            let project = ProjectState("/test/project.gsproj")
            project.UpdateFile(FileA, SourceA)
            project.UpdateFile(FileB, SourceB)
            project.UpdateFile(FileC, SourceC)
            project.UpdateFile(FileD, SourceD)
            return project
        }

        private func AssertModelsEquivalent(compilation Compilation) {
            let incremental = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: true)
            let full = SemanticLookup.BuildModelForTest(compilation, useIncrementalCaches: false)
            // 1. Resolve agrees for every identifier token in every file.
            var tokenCount = 0
            for tree in compilation.SyntaxTrees {
                for token in SemanticLookup.EnumerateIdentifierTokens(tree) {
                    tokenCount++
                    let a Symbol? = incremental.Resolve(token)
                    let b Symbol? = full.Resolve(token)
                    Assert.True(
                        object.ReferenceEquals(a, b),
                        "Resolve mismatch for '${token.Text}' at ${token.SyntaxTree.Text.FileName}:${token.Span.Start} — incremental=${Describe(a)}, full=${Describe(b)}"
                    )
                }
            }
            Assert.True(tokenCount > 0)
            // 2. GetLocals agrees for every function declaration.
            for tree in compilation.SyntaxTrees {
                for function in DescendantsOfType[FunctionDeclarationSyntax](tree.Root) {
                    let incrementalLocals = incremental.GetLocals(function)
                    let fullLocals = full.GetLocals(function)
                    Assert.Equal(fullLocals.Count, incrementalLocals.Count)
                    Assert.Equal(
                        fullLocals.OrderBy((s VariableSymbol) -> s.Name).Select((s VariableSymbol) -> s.Name),
                        incrementalLocals.OrderBy((s VariableSymbol) -> s.Name).Select((s VariableSymbol) -> s.Name)
                    )
                    for symbol in fullLocals {
                        Assert.Contains(incrementalLocals, (s VariableSymbol) -> object.ReferenceEquals(s, symbol))
                    }
                }
            }
            // 3. The globals map agrees (same keys, same symbol instances).
            let incrementalGlobals = incremental.GlobalsSnapshot
            let fullGlobals = full.GlobalsSnapshot
            Assert.Equal(fullGlobals.Count, incrementalGlobals.Count)
            for pair in fullGlobals {
                Assert.True(
                    incrementalGlobals.TryGetValue(pair.Key, out var value),
                    "globals missing key '${pair.Key}'"
                )
                Assert.Same(pair.Value, value)
            }
        }

        private func Describe(symbol Symbol?) string -> if symbol == nil {
            "<null>"
        } else {
            "${symbol.Kind}:${symbol.Name}"
        }

        private func DescendantsOfType[T SyntaxNode](root SyntaxNode) sequence[T] {
            if root is T match {
                yield match
            }
            for child in root.GetChildren() {
                for descendant in DescendantsOfType[T](child) {
                    yield descendant
                }
            }
        }
    }
}
