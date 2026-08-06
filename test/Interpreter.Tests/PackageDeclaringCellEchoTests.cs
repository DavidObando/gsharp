// <copyright file="PackageDeclaringCellEchoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 Phase 3d (#3176): a REPL cell that declares its own
/// <c>package X</c> emits its members — including the synthesized
/// <c>&lt;Program&gt;</c> type holding <c>&lt;Result&gt;$</c> and the
/// globals — under that namespace rather than the session default
/// <c>gsiN</c>. The Phase 3c note observed such cells "succeed silently,
/// no echo"; worse, their declarations were invisible to later cells
/// because the chain recorded the wrong package. The engine now records
/// the emitted package (<c>GlobalScope.Package</c>), making the echo and
/// cross-cell visibility work. The one structural residue — two cells
/// redeclaring the <em>same</em> package — was
/// <see href="https://github.com/DavidObando/gsharp/issues/3297">#3297</see>,
/// fixed by assembly-qualified steering in <c>SubmissionImports</c>; see
/// <see cref="PackageRedeclarationAcrossCellsTests"/> for the full matrix.
/// </summary>
public sealed class PackageDeclaringCellEchoTests : IDisposable
{
    private readonly EmittedSessionEngine engine = new();

    public void Dispose() => engine.Dispose();

    [Fact]
    public void PackageCellEchoesTrailingExpression()
    {
        var cell = engine.Evaluate("package foo\n1 + 2");
        Assert.False(cell.HasError, string.Join("; ", cell.Diagnostics));
        Assert.Equal(3, cell.Value);
    }

    [Fact]
    public void PackageCellFunctionVisibleToLaterCells()
    {
        var decl = engine.Evaluate("package foo\nfunc addOne(n int) int {\n    return n + 1\n}");
        Assert.False(decl.HasError, string.Join("; ", decl.Diagnostics));
        Assert.Null(decl.Value);

        var call = engine.Evaluate("addOne(41)");
        Assert.False(call.HasError, string.Join("; ", call.Diagnostics));
        Assert.Equal(42, call.Value);
    }

    [Fact]
    public void PackageCellGlobalVisibleToLaterCells()
    {
        var decl = engine.Evaluate("package bar\nvar counter = 10");
        Assert.False(decl.HasError, string.Join("; ", decl.Diagnostics));

        var read = engine.Evaluate("counter + 5");
        Assert.False(read.HasError, string.Join("; ", read.Diagnostics));
        Assert.Equal(15, read.Value);
    }

    [Fact]
    public void DefaultCellThenPackageCellBothEcho()
    {
        var plain = engine.Evaluate("40 + 1");
        Assert.False(plain.HasError);
        Assert.Equal(41, plain.Value);

        var packaged = engine.Evaluate("package baz\n41 + 1");
        Assert.False(packaged.HasError, string.Join("; ", packaged.Diagnostics));
        Assert.Equal(42, packaged.Value);
    }

    [Fact]
    public void SamePackageTwiceExtendsThePackage()
    {
        // #3297: a later `package foo` cell EXTENDS the package. Each
        // submission emits into its own assembly (`gsi$1`, `gsi$2`), so the
        // two `foo.<Program>` containers never physically collide; the
        // historical failure was that SubmissionImports resolved a prior
        // cell's container through the namespace-qualified name only, and
        // the flat lookup always answered with the newest assembly's copy.
        // Assembly-qualified steering (ReferenceResolver.TryResolveTypeInAssembly)
        // resolves each submission's members from that submission's own
        // assembly, so both cells' declarations stay reachable.
        Assert.False(engine.Evaluate("package foo\nfunc a() int {\n    return 1\n}").HasError);
        Assert.False(engine.Evaluate("package foo\nfunc b() int {\n    return 2\n}").HasError);

        var useNewest = engine.Evaluate("b()");
        Assert.False(useNewest.HasError, string.Join("; ", useNewest.Diagnostics));
        Assert.Equal(2, useNewest.Value);

        var useOldest = engine.Evaluate("a()");
        Assert.False(useOldest.HasError, string.Join("; ", useOldest.Diagnostics));
        Assert.Equal(1, useOldest.Value);
    }
}
