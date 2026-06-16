// <copyright file="Issue521ClassToInterfaceConversionTests.cs" company="GSharp">
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
/// Issue #521: the binder used to reject a concrete-class → implemented-interface
/// assignment with <c>GS0155</c> for every CLR-typed shape (e.g.
/// <c>List&lt;string&gt;</c> to <c>IReadOnlyList&lt;string&gt;</c>) because the
/// reference-upcast rule in <see cref="Conversion.Classify"/> only walked the
/// G# class <see cref="StructSymbol.Interfaces"/> list. The fix layers a
/// general CLR-reference upcast on top so the binder accepts any
/// <c>from.ClrType</c> → <c>to.ClrType</c> that
/// <see cref="ClrTypeUtilities.IsAssignableByName"/> reports as
/// assignment-compatible, covering BCL classes, CLR interfaces, and the
/// user-class → user-interface path that already worked.
///
/// Scope tested here (binder classification only; the emit + execute shape
/// lives in <c>Issue521ClassToInterfaceUpcastEmitTests</c>):
/// <list type="bullet">
///   <item>G# class implementing G# interface — assignment, argument passing,
///         return widening, explicit cast.</item>
///   <item>CLR class implementing CLR interface — <c>List&lt;T&gt;</c> to
///         <c>IReadOnlyList&lt;T&gt;</c>, <c>IEnumerable&lt;T&gt;</c>, and
///         <c>ICollection&lt;T&gt;</c>.</item>
///   <item>CLR class implementing CLR interface — <c>string</c> to
///         <c>IComparable</c>.</item>
///   <item>Negative: assigning an unrelated reference type still produces
///         a precise <c>GS0155</c>.</item>
/// </list>
/// </summary>
public class Issue521ClassToInterfaceConversionTests
{
    [Fact]
    public void GSharpClass_To_GSharpInterface_Assignment_Binds()
    {
        var source = @"
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return ""Hello, "" + name }
}

var g IGreeter = HelloGreeter{}
g.Greet(""world"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Hello, world", result.Value);
    }

    [Fact]
    public void GSharpClass_To_GSharpInterface_AsArgument_Binds()
    {
        var source = @"
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return ""Hi, "" + name }
}

func Run(g IGreeter, name string) string {
    return g.Greet(name)
}

Run(HelloGreeter{}, ""ada"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Hi, ada", result.Value);
    }

    [Fact]
    public void GSharpClass_To_GSharpInterface_AsReturnType_Binds()
    {
        var source = @"
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return ""Hey, "" + name }
}

func Make() IGreeter {
    return HelloGreeter{}
}

Make().Greet(""bob"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Hey, bob", result.Value);
    }

    [Fact]
    public void GSharpClass_To_GSharpInterface_ExplicitCast_Binds()
    {
        var source = @"
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return ""Yo, "" + name }
}

var g = IGreeter(HelloGreeter{})
g.Greet(""sam"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Yo, sam", result.Value);
    }

    [Fact]
    public void ClrList_To_IReadOnlyList_Assignment_Binds()
    {
        var source = @"
import System.Collections.Generic

var mut = List[string]()
mut.Add(""a"")
mut.Add(""b"")
var r IReadOnlyList[string] = mut
mut.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ClrList_To_ICollection_Assignment_Binds()
    {
        var source = @"
import System.Collections.Generic

var mut = List[int32]()
mut.Add(10)
mut.Add(20)
var c ICollection[int32] = mut
c.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ClrList_To_IEnumerable_Assignment_Binds()
    {
        var source = @"
import System.Collections.Generic

var mut = List[int32]()
mut.Add(1)
mut.Add(2)
var e IEnumerable[int32] = mut
mut.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ClrString_To_IComparable_Assignment_Binds()
    {
        var source = @"
import System

var s = ""abc""
var c IComparable = s
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrList_To_IReadOnlyList_AsArgument_Binds()
    {
        // Member lookup through inherited interface bases isn't part of
        // #521 — verify the upcast itself by computing the count on the
        // backing list inside the function.
        var source = @"
import System.Collections.Generic

func ConsumeReadOnly(r IReadOnlyList[string], mut List[string]) int32 {
    return mut.Count
}

var l = List[string]()
l.Add(""x"")
l.Add(""y"")
l.Add(""z"")
ConsumeReadOnly(l, l)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void UnrelatedReferenceAssignment_StillReports_GS0155()
    {
        // The CLR has no relationship between `string` and `Random`, so a
        // direct assignment must still surface as the precise GS0155
        // diagnostic — not silently succeed under the broader rule.
        var source = @"
import System

var s = ""abc""
var r Random = s
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert type"));
    }

    [Fact]
    public void ClrList_To_IReadOnlyList_DispatchesIndexer()
    {
        // Index through the interface — exercises that the upcast value
        // remains a runtime List<string> and the indexer call binds to the
        // IReadOnlyList<T>.Item member.
        var source = @"
import System.Collections.Generic

var mut = List[string]()
mut.Add(""first"")
mut.Add(""second"")
var r IReadOnlyList[string] = mut
r[1]
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("second", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
