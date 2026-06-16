// <copyright file="MethodWithReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 6.4 — methods with receivers on same-package user-defined types.
/// </summary>
/// <remarks>
/// ADR-0079 (issue #719) makes the receiver-clause form on owned types
/// emit the soft <c>GS0314</c> warning. These tests cover binding /
/// dispatch behaviour and intentionally ignore that warning; the
/// dedicated GS0314 coverage lives in <c>OwnedReceiverWarningTests</c>.
/// </remarks>
public class MethodWithReceiverTests
{
    [Fact]
    public void MethodWithReceiver_OnStruct_BindsAndDispatches()
    {
        var source = @"
struct Point {
    var X int32
    var Y int32
}

func (p Point) Distance() int32 {
    return p.X * p.X + p.Y * p.Y
}

var p = Point{X: 3, Y: 4}
p.Distance()
";
        var result = Evaluate(source);
        AssertOnlyOwnedReceiverWarnings(result.Diagnostics);
        Assert.Equal(25, result.Value);
    }

    [Fact]
    public void MethodWithReceiver_OnClass_BindsAndDispatches()
    {
        var source = @"
class Point {
    var X int32
    var Y int32
}

func (p Point) Distance() int32 {
    return p.X * p.X + p.Y * p.Y
}

var p = Point{X: 6, Y: 8}
p.Distance()
";
        var result = Evaluate(source);
        AssertOnlyOwnedReceiverWarnings(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void MethodWithReceiver_ComposesWithOtherMethodsOnSameType()
    {
        var source = @"
struct Point {
    var X int32
    var Y int32
}

func (p Point) Sum() int32 { return p.X + p.Y }
func (p Point) DoubleSum() int32 { return p.Sum() * 2 }

var p = Point{X: 5, Y: 7}
p.DoubleSum()
";
        var result = Evaluate(source);
        AssertOnlyOwnedReceiverWarnings(result.Diagnostics);
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
    public void TopLevelMethod_CollidingWithInBodyMethod_Diagnoses()
    {
        var source = @"
class Point {
    func Sum() int32 { return 1 }
}

func (p Point) Sum() int32 { return 2 }
";
        var result = Evaluate(source);

        // ADR-0063: two `Sum()` methods on Point share the same signature, so the
        // duplicate-overload diagnostic fires instead of the older
        // "symbol already declared" one.
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'Sum'") && (d.Message.Contains("already declared") || d.Message.Contains("overload")));
    }

    [Fact]
    public void MethodReceiver_OnInterface_Diagnoses()
    {
        var source = @"
interface I {
    func F() int32;
}

func (i I) G() int32 { return 1 }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("must be a struct or class"));
    }

    [Fact]
    public void MethodReceiver_OnAlias_Diagnoses()
    {
        var source = @"
type Count = int32
func (c Count) G() int32 { return c + 1 }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("must be a struct or class"));
    }

    [Fact]
    public void MethodWithReceiver_BareFieldAccess_UsesImplicitThis()
    {
        var source = @"
struct Counter {
    var Value int32
}

func (c Counter) Inc() int32 {
    return Value + 1
}

var c = Counter{Value: 41}
c.Inc()
";
        var result = Evaluate(source);
        AssertOnlyOwnedReceiverWarnings(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    private static void AssertOnlyOwnedReceiverWarnings(ImmutableArray<Diagnostic> diagnostics)
    {
        foreach (var d in diagnostics)
        {
            Assert.True(
                d.Id == "GS0314" && d.Severity == DiagnosticSeverity.Warning,
                $"unexpected diagnostic: {d.Id} {d.Severity} {d.Message}");
        }
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
