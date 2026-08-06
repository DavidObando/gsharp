// <copyright file="RefLocalAliasingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #491 (ADR-0060 follow-up): binder-level tests for ref-aliasing locals
/// declared with <c>let ref</c> / <c>var ref</c>. Validates lvalue RHS, escape-scope
/// classification (top-level / async / iterator rejection), <c>const ref</c> rejection,
/// type-clause mismatch reporting, and clean binding of the canonical shapes from
/// the issue (array element alias, field alias).
/// </summary>
public class RefLocalAliasingTests
{
    [Fact]
    public void LetRef_AliasingArrayElement_BindsCleanly()
    {
        var source = @"
func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[1]
    m = 99
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void VarRef_AliasingStructField_BindsCleanly()
    {
        var source = @"
struct Counter {
    var Value int32
}

func tweak() {
    var c Counter = Counter{Value: 5}
    var ref v = c.Value
    v = v + 1
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void LetRef_WithExplicitTypeClause_BindsCleanly()
    {
        var source = @"
func tweak() {
    var x int32 = 7
    let ref m int32 = x
    m = 8
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void LetRef_FromEndIndex_BindsCleanly()
    {
        // Issue #3247: `xs[^1]` binds as a BoundBlockExpression (receiver +
        // offset spilled into temps); the ref-alias binder must sink the
        // address-of onto the trailing element access instead of wrapping the
        // block (which ICEd the emitter with GS9998).
        var source = @"
func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[^1]
    m = 99
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void LetRef_FromEndIndexOnString_ReportsGS0256()
    {
        // Issue #3247: a string's from-end element access lowers to the CLR
        // counted indexer (get_Chars), which is not an lvalue — diagnostic,
        // never an ICE.
        var source = @"
func tweak() {
    var s = ""abc""
    let ref c = s[^1]
    c = 'z'
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0256");
    }

    [Fact]
    public void LetRef_FromEndIndexOnMap_ReportsGS0116()
    {
        // Issue #3247: a map has no length-based element order, so `m[^1]` is
        // not indexable by System.Index — diagnostic, never an ICE.
        var source = @"
func tweak() {
    var m = map[string,int32]{""a"": 1}
    let ref v = m[^1]
    v = 2
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0116");
    }

    [Fact]
    public void LetRef_NonLvalueRhs_ReportsGS0256()
    {
        var source = @"
func tweak() {
    let ref m = 1 + 2
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0256");
    }

    [Fact]
    public void LetRef_LiteralRhs_ReportsGS0256()
    {
        var source = @"
func tweak() {
    let ref m = 42
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0256");
    }

    [Fact]
    public void LetRef_AliasReadOnlyLetLocal_RejectedAsAddressOfConstant()
    {
        var source = @"
func tweak() {
    let x = 7
    let ref m = x
}
tweak()
0
";
        var result = Evaluate(source);
        // Same diagnostic family as `&x` over a `let` binding (GS9005): cannot take address of constant.
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9005");
    }

    [Fact]
    public void LetRef_AtTopLevel_ReportsGS0258()
    {
        var source = @"
var n int32 = 7
let ref m = n
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_InAsyncFunction_ReportsGS0258()
    {
        var source = @"
async func tweak() {
    var n int32 = 7
    let ref m = n
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void ConstRef_Rejected()
    {
        var source = @"
func tweak() {
    var n int32 = 7
    const ref m = n
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0258");
    }

    [Fact]
    public void LetRef_TypeMismatch_ReportsCannotConvert()
    {
        var source = @"
func tweak() {
    var n int32 = 7
    let ref m int64 = n
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155" || d.Id == "GS0017" || d.Id == "GS0011" || d.Id == "GS0030" || d.Id == "GS0019");
    }

    [Fact]
    public void LetRef_BindRefAliasOfDereference_BindsCleanly()
    {
        var source = @"
func tweak() {
    var n int32 = 5
    var p *int32 = &n
    let ref m = *p
    m = 11
}
tweak()
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
