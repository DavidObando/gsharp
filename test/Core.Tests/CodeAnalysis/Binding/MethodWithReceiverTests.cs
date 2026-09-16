// <copyright file="MethodWithReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 6.4 — instance methods on same-package user-defined types.
/// </summary>
/// <remarks>
/// ADR-0182 (issue #4240) retired the receiver-clause spelling for owned
/// instance methods: <c>func (r T) M() { ... }</c> is unconditionally an
/// extension now, regardless of whether the current package owns <c>T</c>.
/// The in-body form (<c>class T { func M() { ... } }</c> /
/// <c>struct T { func M() { ... } }</c>) is the only spelling for an owned
/// instance method. Receiver-clause behavior — including the "does this
/// collide with an in-body method of the same name" question, which it no
/// longer does — is covered by <c>OwnedReceiverWarningTests</c>.
/// </remarks>
public class MethodWithReceiverTests
{
    [Fact]
    public void InBodyMethod_OnStruct_BindsAndDispatches()
    {
        var source = @"
struct Point {
    var X int32
    var Y int32

    func Distance() int32 {
        return X * X + Y * Y
    }
}

var p = Point{X: 3, Y: 4}
p.Distance()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(25, result.Value);
    }

    [Fact]
    public void InBodyMethod_OnClass_BindsAndDispatches()
    {
        var source = @"
class Point {
    var X int32
    var Y int32

    func Distance() int32 {
        return X * X + Y * Y
    }
}

var p = Point{X: 6, Y: 8}
p.Distance()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void InBodyMethod_ComposesWithOtherMethodsOnSameType()
    {
        var source = @"
struct Point {
    var X int32
    var Y int32

    func Sum() int32 { return X + Y }
    func DoubleSum() int32 { return Sum() * 2 }
}

var p = Point{X: 5, Y: 7}
p.DoubleSum()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(24, result.Value);
    }

    [Fact]
    public void CrossPackageReceiver_RemainsExtensionFunction()
    {
        var definingTree = SyntaxTree.Parse(SourceText.From(@"
package Geometry
public struct Point {
    var X int32
}
"));
        var extensionTree = SyntaxTree.Parse(SourceText.From(@"
package Extensions
func (p Point) Next() int32 { return p.X + 1 }
"));
        var compilation = new Compilation(definingTree, extensionTree);
        var function = compilation.GlobalScope.Functions.Single(f => f.Name == "Next");

        Assert.Empty(compilation.GlobalScope.Diagnostics);
        Assert.True(function.IsExtension);
        Assert.IsType<StructSymbol>(function.ExtensionReceiverType);
        Assert.Null(function.ReceiverType);
    }

    [Fact]
    public void InBodyMethod_BareFieldAccess_UsesImplicitThis()
    {
        var source = @"
struct Counter {
    var Value int32

    func Inc() int32 {
        return Value + 1
    }
}

var c = Counter{Value: 41}
c.Inc()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
