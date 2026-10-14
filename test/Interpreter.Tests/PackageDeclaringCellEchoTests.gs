// <copyright file="PackageDeclaringCellEchoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System
import Xunit

/// ADR-0156 Phase 3d (#3176): a REPL cell that declares its own
/// `package X` emits its members — including the synthesized
/// `<Program>` type holding `<Result>$` and the
/// globals — under that namespace rather than the session default
/// `gsiN`. The Phase 3c note observed such cells "succeed silently,
/// no echo"; worse, their declarations were invisible to later cells
/// because the chain recorded the wrong package. The engine now records
/// the emitted package (`GlobalScope.Package`), making the echo and
/// cross-cell visibility work. The one structural residue — two cells
/// redeclaring the <em>same</em> package — was
/// [#3297](https://github.com/DavidObando/gsharp/issues/3297),
/// fixed by assembly-qualified steering in `SubmissionImports`; see
/// (cref:PackageRedeclarationAcrossCellsTests) for the full matrix.
class PackageDeclaringCellEchoTests : IDisposable {
    private let engine EmittedSessionEngine = EmittedSessionEngine()
    func Dispose() -> engine.Dispose()

    @Fact
    func PackageCellEchoesTrailingExpression() {
        let cell = engine.Evaluate("package foo\n1 + 2")
        Assert.False(cell.HasError, string.Join("; ", cell.Diagnostics))
        Assert.Equal(3, cell.Value)
    }

    @Fact
    func PackageCellFunctionVisibleToLaterCells() {
        let decl = engine.Evaluate(`package foo
func addOne(n int) int {
    return n + 1
}`)
        Assert.False(decl.HasError, string.Join("; ", decl.Diagnostics))
        Assert.Null(decl.Value)
        let call = engine.Evaluate("addOne(41)")
        Assert.False(call.HasError, string.Join("; ", call.Diagnostics))
        Assert.Equal(42, call.Value)
    }

    @Fact
    func PackageCellGlobalVisibleToLaterCells() {
        let decl = engine.Evaluate("package bar\nvar counter = 10")
        Assert.False(decl.HasError, string.Join("; ", decl.Diagnostics))
        let read = engine.Evaluate("counter + 5")
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics))
        Assert.Equal(15, read.Value)
    }

    @Fact
    func DefaultCellThenPackageCellBothEcho() {
        let plain = engine.Evaluate("40 + 1")
        Assert.False(plain.HasError)
        Assert.Equal(41, plain.Value)
        let packaged = engine.Evaluate("package baz\n41 + 1")
        Assert.False(packaged.HasError, string.Join("; ", packaged.Diagnostics))
        Assert.Equal(42, packaged.Value)
    }

    @Fact
    func SamePackageTwiceExtendsThePackage() {
        // #3297: a later `package foo` cell EXTENDS the package. Each
        // submission emits into its own assembly (`gsi$1`, `gsi$2`), so the
        // two `foo.<Program>` containers never physically collide; the
        // historical failure was that SubmissionImports resolved a prior
        // cell's container through the namespace-qualified name only, and
        // the flat lookup always answered with the newest assembly's copy.
        // Assembly-qualified steering (ReferenceResolver.TryResolveTypeInAssembly)
        // resolves each submission's members from that submission's own
        // assembly, so both cells' declarations stay reachable.
        Assert.False(engine.Evaluate(`package foo
func a() int {
    return 1
}`).HasError)
        Assert.False(engine.Evaluate(`package foo
func b() int {
    return 2
}`).HasError)
        let useNewest = engine.Evaluate("b()")
        Assert.False(useNewest.HasError, string.Join("; ", useNewest.Diagnostics))
        Assert.Equal(2, useNewest.Value)
        let useOldest = engine.Evaluate("a()")
        Assert.False(useOldest.HasError, string.Join("; ", useOldest.Diagnostics))
        Assert.Equal(1, useOldest.Value)
    }
}
