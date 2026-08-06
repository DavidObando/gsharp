// <copyright file="PackageRedeclarationAcrossCellsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3297 witness matrix: redeclaring the same <c>package X</c> in a
/// later REPL cell EXTENDS the package — the new cell's members join the
/// package for subsequent cells, and a redefinition of an existing name
/// follows the engine's newest-wins shadowing model. Structurally, every
/// submission still emits into its own assembly (<c>gsi$N</c>), so two
/// same-package <c>foo.&lt;Program&gt;</c> containers never collide in
/// metadata; <c>SubmissionImports</c> resolves each prior submission's
/// members from that submission's own assembly
/// (<see cref="GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver"/>
/// assembly-qualified steering) instead of the flat namespace-qualified
/// lookup that always answered with the newest assembly's copy.
/// </summary>
public sealed class PackageRedeclarationAcrossCellsTests : IDisposable
{
    private readonly EmittedSessionEngine engine = new();

    public void Dispose() => engine.Dispose();

    [Fact]
    public void SamePackageTwoCellsFunctionsGlobalsAndTypesAllReachable()
    {
        var first = engine.Evaluate(
            "package foo\n" +
            "struct Point {\n    var X int\n    var Y int\n}\n" +
            "var origin = 10\n" +
            "func a() int {\n    return 1\n}");
        Assert.False(first.HasError, string.Join("; ", first.Diagnostics));

        var second = engine.Evaluate(
            "package foo\n" +
            "struct Pair {\n    var L int\n    var R int\n}\n" +
            "var offset = 20\n" +
            "func b() int {\n    return 2\n}");
        Assert.False(second.HasError, string.Join("; ", second.Diagnostics));

        // Functions from both cells.
        var older = engine.Evaluate("a()");
        Assert.False(older.HasError, string.Join("; ", older.Diagnostics));
        Assert.Equal(1, older.Value);

        var newer = engine.Evaluate("b()");
        Assert.False(newer.HasError, string.Join("; ", newer.Diagnostics));
        Assert.Equal(2, newer.Value);

        // Globals from both cells.
        var globals = engine.Evaluate("origin + offset");
        Assert.False(globals.HasError, string.Join("; ", globals.Diagnostics));
        Assert.Equal(30, globals.Value);

        // Types from both cells.
        var olderType = engine.Evaluate("var p = Point{X: 3, Y: 4}\np.X + p.Y");
        Assert.False(olderType.HasError, string.Join("; ", olderType.Diagnostics));
        Assert.Equal(7, olderType.Value);

        var newerType = engine.Evaluate("var q = Pair{L: 5, R: 6}\nq.L + q.R");
        Assert.False(newerType.HasError, string.Join("; ", newerType.Diagnostics));
        Assert.Equal(11, newerType.Value);
    }

    [Fact]
    public void MemberAddedInSecondPackageCellVisibleToThirdCell()
    {
        Assert.False(engine.Evaluate("package foo\nfunc a() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("package foo\nfunc b() int {\n    return a() + 1\n}").HasError);

        var third = engine.Evaluate("a() + b()");
        Assert.False(third.HasError, string.Join("; ", third.Diagnostics));
        Assert.Equal(3, third.Value);
    }

    [Fact]
    public void RedefinitionInsideSamePackageAcrossCellsNewestWins()
    {
        Assert.False(engine.Evaluate("package foo\nfunc f() int {\n    return 1\n}").HasError);

        var beforeRedefinition = engine.Evaluate("f()");
        Assert.False(beforeRedefinition.HasError, string.Join("; ", beforeRedefinition.Diagnostics));
        Assert.Equal(1, beforeRedefinition.Value);

        Assert.False(engine.Evaluate("package foo\nfunc f() int {\n    return 2\n}").HasError);

        var afterRedefinition = engine.Evaluate("f()");
        Assert.False(afterRedefinition.HasError, string.Join("; ", afterRedefinition.Diagnostics));
        Assert.Equal(2, afterRedefinition.Value);
    }

    [Fact]
    public void GlobalRedefinitionInsideSamePackageAcrossCellsNewestWins()
    {
        Assert.False(engine.Evaluate("package foo\nvar x = 1").HasError);
        Assert.False(engine.Evaluate("package foo\nvar x = 2").HasError);

        var read = engine.Evaluate("x");
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics));
        Assert.Equal(2, read.Value);
    }

    [Fact]
    public void DifferentPackagesInDifferentCellsBothReachable()
    {
        Assert.False(engine.Evaluate("package foo\nfunc a() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("package bar\nfunc b() int {\n    return 2\n}").HasError);

        var both = engine.Evaluate("a() + b()");
        Assert.False(both.HasError, string.Join("; ", both.Diagnostics));
        Assert.Equal(3, both.Value);
    }

    [Fact]
    public void PackageCellsInterleavedWithPackagelessCells()
    {
        Assert.False(engine.Evaluate("package foo\nfunc a() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("func plain() int {\n    return 10\n}").HasError);
        Assert.False(engine.Evaluate("package foo\nfunc b() int {\n    return 2\n}").HasError);

        var all = engine.Evaluate("a() + plain() + b()");
        Assert.False(all.HasError, string.Join("; ", all.Diagnostics));
        Assert.Equal(13, all.Value);
    }

    [Fact]
    public void SnapshotShowsMembersFromBothSamePackageCells()
    {
        Assert.False(engine.Evaluate("package foo\nvar first = 1\nfunc a() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("package foo\nvar second = 2\nfunc b() int {\n    return 2\n}").HasError);

        var state = engine.Snapshot();
        Assert.Contains(state.Functions, s => s.Display.Contains("a", StringComparison.Ordinal));
        Assert.Contains(state.Functions, s => s.Display.Contains("b", StringComparison.Ordinal));
        Assert.Contains(state.Variables, s => s.Display.Contains("first", StringComparison.Ordinal));
        Assert.Contains(state.Variables, s => s.Display.Contains("second", StringComparison.Ordinal));
    }

    [Fact]
    public void ResetClearsSamePackageChain()
    {
        Assert.False(engine.Evaluate("package foo\nfunc a() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("package foo\nfunc b() int {\n    return 2\n}").HasError);

        engine.Reset();

        Assert.Empty(engine.Cells);
        Assert.Empty(engine.Snapshot().Functions);

        var afterReset = engine.Evaluate("a()");
        Assert.True(afterReset.HasError);

        // The package can be rebuilt from scratch after Reset.
        Assert.False(engine.Evaluate("package foo\nfunc a() int {\n    return 41\n}").HasError);
        Assert.False(engine.Evaluate("package foo\nfunc plusOne() int {\n    return a() + 1\n}").HasError);
        var rebuilt = engine.Evaluate("plusOne()");
        Assert.False(rebuilt.HasError, string.Join("; ", rebuilt.Diagnostics));
        Assert.Equal(42, rebuilt.Value);
    }
}
