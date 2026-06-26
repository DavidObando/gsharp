// <copyright file="Issue1211CompositeLiteralPropBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1211: a composite literal <c>T{Field: value}</c> must resolve and
/// assign settable <c>prop</c> auto-property members (a property with a
/// <c>set</c> or an <c>init</c> accessor) — not just <c>var</c> fields. A
/// get-only property is still not settable, so targeting it stays a diagnostic.
/// </summary>
public class Issue1211CompositeLiteralPropBinderTests
{
    [Fact]
    public void CompositeLiteral_GetInitProperty_Binds()
    {
        var source = @"
class C { prop TrackId int32 { get; init; } }
let c = C{TrackId: 7}
c.TrackId
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void CompositeLiteral_GetSetProperty_Binds()
    {
        var source = @"
class C { prop Count int32 { get; set } }
let c = C{Count: 9}
c.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void CompositeLiteral_MixedPropAndVar_Binds()
    {
        var source = @"
class E { prop Name int32 { get; set } var Count int32 }
let e = E{Name: 3, Count: 4}
e.Name + e.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void CompositeLiteral_InheritedProperty_Binds()
    {
        var source = @"
open class Base { prop Id int32 { get; init; } }
class Derived : Base { prop Extra int32 { get; set } }
let d = Derived{Id: 5, Extra: 6}
d.Id + d.Extra
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void CompositeLiteral_StructProperty_Binds()
    {
        var source = @"
struct P { prop X int32 { get; init; } prop Y int32 { get; set } var Z int32 }
let p = P{X: 1, Y: 2, Z: 3}
p.X + p.Y + p.Z
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void CompositeLiteral_GetOnlyProperty_IsDiagnosed()
    {
        var source = @"
class C { prop Ro int32 { get; } }
let c = C{Ro: 1}
c.Ro
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("read-only"));
    }

    [Fact]
    public void CompositeLiteral_UnknownMember_IsDiagnosed()
    {
        var source = @"
class C { prop Name int32 { get; set } }
let c = C{Missing: 1}
c.Name
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
