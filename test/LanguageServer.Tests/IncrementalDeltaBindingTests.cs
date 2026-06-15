// <copyright file="IncrementalDeltaBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// ADR-0105 (Phase 2) — end-to-end tests driving the real language-server path
/// (<see cref="ProjectState.UpdateFile"/> + <see cref="ProjectState.GetCompilation"/>,
/// a fresh <c>Compilation</c> per edit). They prove that a single-file,
/// body-only edit reuses the previous compilation's global scope and serves the
/// unchanged files' bodies from the shared <c>BoundBodyCache</c>, while edits
/// that are not provably body-only fall back to a full rebuild.
/// </summary>
public class IncrementalDeltaBindingTests
{
    private const string FileA = "/test/a.gs";
    private const string FileB = "/test/b.gs";
    private const string FileC = "/test/c.gs";

    [Fact]
    public void BodyOnlyEdit_ReusesGlobalScope_AndServesCacheHitsForUnchangedFiles()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(FileA, "package P\nfunc A() int {\n    return 1\n}\n");
        project.UpdateFile(FileB, "package P\nfunc B() int {\n    return 2\n}\n");
        project.UpdateFile(FileC, "package P\nfunc C() int {\n    return 3\n}\n");

        var comp1 = project.GetCompilation();
        _ = comp1.BoundProgram; // populate the per-project body cache
        var cache = comp1.BodyCache;
        Assert.NotNull(cache);
        var hitsBefore = cache.Hits;
        var storesBefore = cache.Stores;

        // Body-only edit to a.gs — only the returned literal changes.
        project.UpdateFile(FileA, "package P\nfunc A() int {\n    return 100\n}\n");
        var comp2 = project.GetCompilation();

        Assert.NotSame(comp1, comp2);

        // Fast path taken: comp2 reuses comp1's bound global scope (and therefore
        // every symbol instance), and marks a.gs as the only dirty body tree.
        Assert.Same(comp1.GlobalScope, comp2.ReusedGlobalScope);
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope);

        _ = comp2.BoundProgram;

        // b.gs and c.gs were served from the cache; only a.gs re-bound and re-stored.
        Assert.Equal(hitsBefore + 2, cache.Hits);
        Assert.Equal(storesBefore + 1, cache.Stores);
    }

    [Fact]
    public void SignatureEdit_FallsBackToFullRebuild()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(FileA, "package P\nfunc Helper(x int) int {\n    return x * 2\n}\n");
        project.UpdateFile(FileB, "package P\nfunc UseHelper(y int) int {\n    return Helper(y) + 1\n}\n");

        var comp1 = project.GetCompilation();
        _ = comp1.BoundProgram;

        // Parameter type changes — a signature edit, not body-only.
        project.UpdateFile(FileA, "package P\nfunc Helper(x int32) int {\n    return x * 2\n}\n");
        var comp2 = project.GetCompilation();

        Assert.NotSame(comp1, comp2);
        Assert.Null(comp2.ReusedGlobalScope);
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope);
    }

    [Fact]
    public void MultipleFilesChanged_FallsBackToFullRebuild()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(FileA, "package P\nfunc A() int {\n    return 1\n}\n");
        project.UpdateFile(FileB, "package P\nfunc B() int {\n    return 2\n}\n");

        var comp1 = project.GetCompilation();
        _ = comp1.BoundProgram;

        project.UpdateFile(FileA, "package P\nfunc A() int {\n    return 10\n}\n");
        project.UpdateFile(FileB, "package P\nfunc B() int {\n    return 20\n}\n");
        var comp2 = project.GetCompilation();

        Assert.Null(comp2.ReusedGlobalScope);
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope);
    }

    [Fact]
    public void FileAdded_FallsBackToFullRebuild()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(FileA, "package P\nfunc A() int {\n    return 1\n}\n");

        var comp1 = project.GetCompilation();
        _ = comp1.BoundProgram;

        project.UpdateFile(FileB, "package P\nfunc B() int {\n    return 2\n}\n");
        var comp2 = project.GetCompilation();

        Assert.Null(comp2.ReusedGlobalScope);
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope);
    }

    /// <summary>
    /// ADR-0105 Phase 2 (broadened member surface) — the headline repro: a file
    /// containing a constructor (<c>init()</c>) now takes the incremental fast
    /// path for a pure in-body edit instead of falling back to a full rebuild.
    /// </summary>
    [Fact]
    public void BodyOnlyEdit_FileWithConstructor_ReusesGlobalScope()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(
            FileA,
            "package P\nclass Box {\n    var V int32\n    init(v int32) {\n        V = v\n    }\n    func Get() int32 {\n        return V\n    }\n}\n");
        project.UpdateFile(FileB, "package P\nfunc Use() int32 {\n    var b = Box(1)\n    return b.Get()\n}\n");

        var comp1 = project.GetCompilation();
        _ = comp1.BoundProgram;
        var cache = comp1.BodyCache;
        Assert.NotNull(cache);
        var hitsBefore = cache.Hits;

        // Pure in-body edit to the method (constructor signature unchanged).
        project.UpdateFile(
            FileA,
            "package P\nclass Box {\n    var V int32\n    init(v int32) {\n        V = v\n    }\n    func Get() int32 {\n        return V + 0\n    }\n}\n");
        var comp2 = project.GetCompilation();

        // Fast path engaged: the global scope (and every symbol) is reused.
        Assert.Same(comp1.GlobalScope, comp2.ReusedGlobalScope);
        Assert.Same(comp1.GlobalScope, comp2.GlobalScope);

        _ = comp2.BoundProgram;

        // b.gs was served from the cache.
        Assert.True(cache.Hits > hitsBefore);
    }

    /// <summary>
    /// A computed-property type change in a constructor-bearing file is a
    /// signature edit, so the fast path is correctly refused.
    /// </summary>
    [Fact]
    public void SignatureEdit_FileWithComputedProperty_FallsBackToFullRebuild()
    {
        var project = new ProjectState("/test/project.gsproj");
        project.UpdateFile(
            FileA,
            "package P\nclass Counter {\n    var n int32\n    prop Doubled int32 {\n        get { return n }\n    }\n}\n");

        var comp1 = project.GetCompilation();
        _ = comp1.BoundProgram;

        // Property type changes int32 -> int64: a signature edit.
        project.UpdateFile(
            FileA,
            "package P\nclass Counter {\n    var n int32\n    prop Doubled int64 {\n        get { return n }\n    }\n}\n");
        var comp2 = project.GetCompilation();

        Assert.Null(comp2.ReusedGlobalScope);
        Assert.NotSame(comp1.GlobalScope, comp2.GlobalScope);
    }
}
