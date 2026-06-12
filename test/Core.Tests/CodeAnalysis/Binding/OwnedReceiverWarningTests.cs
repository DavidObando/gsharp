// <copyright file="OwnedReceiverWarningTests.cs" company="GSharp">
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
/// ADR-0079 / issue #719: receiver-clause methods on owned (same-package)
/// types emit the soft <c>GS0314</c> warning. These tests pin the
/// fire-once-per-declaration semantics and the cross-package /
/// in-body / operator exemptions.
/// </summary>
public class OwnedReceiverWarningTests
{
    [Fact]
    public void SamePackage_ReceiverClauseMethod_OnClass_EmitsGS0314_AndStillBinds()
    {
        var source = @"
class MyClass {
    var X int32
}

func (m MyClass) M() int32 { return m.X + 1 }

let c = MyClass{X: 41}
c.M()
";
        var result = Evaluate(source);

        var warnings = result.Diagnostics.Where(d => d.Id == "GS0314").ToImmutableArray();
        Assert.Single(warnings);
        var w = warnings[0];
        Assert.Equal(DiagnosticSeverity.Warning, w.Severity);
        Assert.Contains("'M'", w.Message);
        Assert.Contains("'MyClass'", w.Message);
        Assert.Contains("ADR-0079", w.Message);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SamePackage_ReceiverClauseMethod_OnStruct_EmitsGS0314()
    {
        var source = @"
struct Point {
    var X int32
    var Y int32
}

func (p Point) Distance() int32 { return p.X * p.X + p.Y * p.Y }
0
";
        var result = Evaluate(source);

        var warnings = result.Diagnostics.Where(d => d.Id == "GS0314").ToImmutableArray();
        Assert.Single(warnings);
        Assert.Equal(DiagnosticSeverity.Warning, warnings[0].Severity);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void SamePackage_ReceiverClauseMethod_OnSealedClass_EmitsGS0314()
    {
        var source = @"
sealed class Shape {
}

func (s Shape) Tag() int32 { return 1 }
0
";
        var result = Evaluate(source);

        var warnings = result.Diagnostics.Where(d => d.Id == "GS0314").ToImmutableArray();
        Assert.Single(warnings);
        Assert.Equal(DiagnosticSeverity.Warning, warnings[0].Severity);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void SamePackage_ReceiverClauseMethod_OnDataClass_EmitsGS0314()
    {
        var source = @"
data class Person(Name string)

func (p Person) Greet() int32 { return 1 }
0
";
        var result = Evaluate(source);

        var warnings = result.Diagnostics.Where(d => d.Id == "GS0314").ToImmutableArray();
        Assert.Single(warnings);
        Assert.Equal(DiagnosticSeverity.Warning, warnings[0].Severity);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void CrossPackage_ReceiverClauseMethod_DoesNotWarn()
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

        Assert.Empty(compilation.GlobalScope.Diagnostics);
    }

    [Fact]
    public void CrossAssembly_ReceiverClauseOnClrType_DoesNotWarn()
    {
        // StringBuilder is an imported BCL CLR type, so the package does
        // not own it and the receiver-clause method is a real extension
        // function — GS0314 must not fire.
        var source = @"
import System.Text

func (sb StringBuilder) Reset() {
    sb.Length = 0
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0314");
    }

    [Fact]
    public void InBodyMethod_OnClass_DoesNotWarn()
    {
        var source = @"
class Greeter(name string) {
    func Greet() string { return ""hi"" }
}

let g = Greeter(""x"")
g.Greet()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void OperatorReceiverClause_OnOwnedClass_DoesNotWarn()
    {
        // ADR-0035: operators must use receiver-clause syntax; ADR-0079
        // exempts them from GS0314 because there is no in-body operator
        // form today.
        var source = @"
class Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void WarningFiresOncePerDeclaration_RegardlessOfCallCount()
    {
        var source = @"
class Counter {
    var Value int32
}

func (c Counter) Bump() int32 { return c.Value + 1 }

let c = Counter{Value: 1}
c.Bump()
c.Bump()
c.Bump()
c.Bump()
";
        var result = Evaluate(source);
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0314").ToImmutableArray();
        Assert.Single(warnings);
    }

    [Fact]
    public void WarningFiresPerDeclaration_OnceEach()
    {
        var source = @"
class Counter {
    var Value int32
}

func (c Counter) Bump() int32 { return c.Value + 1 }
func (c Counter) Reset() int32 { return 0 }
0
";
        var result = Evaluate(source);
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0314").ToImmutableArray();
        Assert.Equal(2, warnings.Length);
    }

    [Fact]
    public void Warning_Location_PointsAtReceiverTypeClause()
    {
        var source = @"
class MyClass {
}

func (m MyClass) Do() int32 { return 1 }
0
";
        var result = Evaluate(source);
        var warning = result.Diagnostics.Single(d => d.Id == "GS0314");

        // Span should fall over the receiver type token "MyClass".
        var span = warning.Location.Span;
        var text = warning.Location.Text.ToString(span);
        Assert.Equal("MyClass", text);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
