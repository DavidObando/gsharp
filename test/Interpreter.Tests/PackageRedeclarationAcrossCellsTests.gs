// <copyright file="PackageRedeclarationAcrossCellsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System
import Xunit

/// Issue #3297 witness matrix: redeclaring the same `package X` in a
/// later REPL cell EXTENDS the package — the new cell's members join the
/// package for subsequent cells, and a redefinition of an existing name
/// follows the engine's newest-wins shadowing model. Structurally, every
/// submission still emits into its own assembly (`gsi$N`), so two
/// same-package `foo.<Program>` containers never collide in
/// metadata; `SubmissionImports` resolves each prior submission's
/// members from that submission's own assembly
/// ((cref:GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver)
/// assembly-qualified steering) instead of the flat namespace-qualified
/// lookup that always answered with the newest assembly's copy.
class PackageRedeclarationAcrossCellsTests : IDisposable {
    private let engine EmittedSessionEngine = EmittedSessionEngine()
    func Dispose() -> engine.Dispose()

    @Fact
    func SamePackageTwoCellsFunctionsGlobalsAndTypesAllReachable() {
        let first = engine.Evaluate("package foo\n" + `struct Point {
    var X int
    var Y int
}
` + "var origin = 10\n" + `func a() int {
    return 1
}`)
        Assert.False(first.HasError, string.Join("; ", first.Diagnostics))
        let second = engine.Evaluate("package foo\n" + `struct Pair {
    var L int
    var R int
}
` + "var offset = 20\n" + `func b() int {
    return 2
}`)
        Assert.False(second.HasError, string.Join("; ", second.Diagnostics))
        // Functions from both cells.
        let older = engine.Evaluate("a()")
        Assert.False(older.HasError, string.Join("; ", older.Diagnostics))
        Assert.Equal(1, older.Value)
        let newer = engine.Evaluate("b()")
        Assert.False(newer.HasError, string.Join("; ", newer.Diagnostics))
        Assert.Equal(2, newer.Value)
        // Globals from both cells.
        let globals = engine.Evaluate("origin + offset")
        Assert.False(globals.HasError, string.Join("; ", globals.Diagnostics))
        Assert.Equal(30, globals.Value)
        // Types from both cells.
        let olderType = engine.Evaluate("var p = Point{X: 3, Y: 4}\np.X + p.Y")
        Assert.False(olderType.HasError, string.Join("; ", olderType.Diagnostics))
        Assert.Equal(7, olderType.Value)
        let newerType = engine.Evaluate("var q = Pair{L: 5, R: 6}\nq.L + q.R")
        Assert.False(newerType.HasError, string.Join("; ", newerType.Diagnostics))
        Assert.Equal(11, newerType.Value)
    }

    @Fact
    func MemberAddedInSecondPackageCellVisibleToThirdCell() {
        Assert.False(engine.Evaluate(`package foo
func a() int {
    return 1
}`).HasError)
        Assert.False(engine.Evaluate(`package foo
func b() int {
    return a() + 1
}`).HasError)
        let third = engine.Evaluate("a() + b()")
        Assert.False(third.HasError, string.Join("; ", third.Diagnostics))
        Assert.Equal(3, third.Value)
    }

    @Fact
    func RedefinitionInsideSamePackageAcrossCellsNewestWins() {
        Assert.False(engine.Evaluate(`package foo
func f() int {
    return 1
}`).HasError)
        let beforeRedefinition = engine.Evaluate("f()")
        Assert.False(beforeRedefinition.HasError, string.Join("; ", beforeRedefinition.Diagnostics))
        Assert.Equal(1, beforeRedefinition.Value)
        Assert.False(engine.Evaluate(`package foo
func f() int {
    return 2
}`).HasError)
        let afterRedefinition = engine.Evaluate("f()")
        Assert.False(afterRedefinition.HasError, string.Join("; ", afterRedefinition.Diagnostics))
        Assert.Equal(2, afterRedefinition.Value)
    }

    @Fact
    func GlobalRedefinitionInsideSamePackageAcrossCellsNewestWins() {
        Assert.False(engine.Evaluate("package foo\nvar x = 1").HasError)
        Assert.False(engine.Evaluate("package foo\nvar x = 2").HasError)
        let read = engine.Evaluate("x")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(2, read.Value)
    }

    @Fact
    func DifferentPackagesInDifferentCellsBothReachable() {
        Assert.False(engine.Evaluate(`package foo
func a() int {
    return 1
}`).HasError)
        Assert.False(engine.Evaluate(`package bar
func b() int {
    return 2
}`).HasError)
        let both = engine.Evaluate("a() + b()")
        Assert.False(both.HasError, string.Join("; ", both.Diagnostics))
        Assert.Equal(3, both.Value)
    }

    @Fact
    func PackageCellsInterleavedWithPackagelessCells() {
        Assert.False(engine.Evaluate(`package foo
func a() int {
    return 1
}`).HasError)
        Assert.False(engine.Evaluate(`func plain() int {
    return 10
}`).HasError)
        Assert.False(engine.Evaluate(`package foo
func b() int {
    return 2
}`).HasError)
        let all = engine.Evaluate("a() + plain() + b()")
        Assert.False(all.HasError, string.Join("; ", all.Diagnostics))
        Assert.Equal(13, all.Value)
    }

    @Fact
    func SnapshotShowsMembersFromBothSamePackageCells() {
        Assert.False(engine.Evaluate(`package foo
var first = 1
func a() int {
    return 1
}`).HasError)
        Assert.False(engine.Evaluate(`package foo
var second = 2
func b() int {
    return 2
}`).HasError)
        let state = engine.Snapshot()
        Assert.Contains(state.Functions, (s ReplSymbol) -> s.Display.Contains("a", StringComparison.Ordinal))
        Assert.Contains(state.Functions, (s ReplSymbol) -> s.Display.Contains("b", StringComparison.Ordinal))
        Assert.Contains(state.Variables, (s ReplSymbol) -> s.Display.Contains("first", StringComparison.Ordinal))
        Assert.Contains(state.Variables, (s ReplSymbol) -> s.Display.Contains("second", StringComparison.Ordinal))
    }

    @Fact
    func ResetClearsSamePackageChain() {
        Assert.False(engine.Evaluate(`package foo
func a() int {
    return 1
}`).HasError)
        Assert.False(engine.Evaluate(`package foo
func b() int {
    return 2
}`).HasError)
        engine.Reset()
        Assert.Empty(engine.Cells)
        Assert.Empty(engine.Snapshot().Functions)
        let afterReset = engine.Evaluate("a()")
        Assert.True(afterReset.HasError)
        // The package can be rebuilt from scratch after Reset.
        Assert.False(engine.Evaluate(`package foo
func a() int {
    return 41
}`).HasError)
        Assert.False(engine.Evaluate(`package foo
func plusOne() int {
    return a() + 1
}`).HasError)
        let rebuilt = engine.Evaluate("plusOne()")
        Assert.False(rebuilt.HasError, string.Join("; ", rebuilt.Diagnostics))
        Assert.Equal(42, rebuilt.Value)
    }
}
