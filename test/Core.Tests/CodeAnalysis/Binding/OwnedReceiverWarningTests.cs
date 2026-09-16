// <copyright file="OwnedReceiverWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
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
/// ADR-0182 / issue #4240: a receiver-clause function is unconditionally an
/// extension now, regardless of the receiver type's owning package or
/// aggregate kind. <c>GS0103</c> and <c>GS0314</c> — the diagnostics that
/// policed the old ownership-dependent binding rule (ADR-0079, ADR-0165) —
/// are retired. These tests pin the new, marker-free behavior; the retired
/// <c>func extension (...)</c> spelling's migration diagnostic (GS0587) is
/// covered by <c>RetiredExplicitExtensionReceiverModifierTests</c>.
/// </summary>
public class OwnedReceiverWarningTests
{
    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnClass_IsExtension_NoDiagnostics()
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

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnStruct_IsExtension_NoDiagnostics()
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

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnSealedClass_IsExtension_NoDiagnostics()
    {
        var source = @"
sealed class Shape {
}

func (s Shape) Tag() int32 { return 1 }
0
";
        var result = Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnDataClass_IsExtension_NoDiagnostics()
    {
        var source = @"
data class Person(Name string)

func (p Person) Greet() int32 { return 1 }
0
";
        var result = Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnEnum_IsExtension_NoDiagnostics()
    {
        // Pre-ADR-0165 this was rejected with GS0103; ADR-0165 required the
        // explicit `extension` marker to allow it. ADR-0182 makes it the
        // unmarked default.
        var source = @"
enum Color { Red, Green }

func (c Color) Rank() int32 {
    if c == Color.Green {
        return 2
    }

    return 1
}

Color.Green.Rank()
";
        var result = Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnInterface_IsExtension_NoDiagnostics()
    {
        var source = @"
interface I {
    func F() int32;
}

func (i I) G() int32 { return 1 }
0
";
        var result = Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void SamePackage_ReceiverClauseFunction_OnAlias_IsExtension_NoDiagnostics()
    {
        var source = @"
type Count = int32
func (c Count) G() int32 { return c + 1 }
0
";
        var result = Evaluate(source);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void CrossPackage_ReceiverClauseFunction_RemainsExtension_NoDiagnostics()
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
    public void CrossAssembly_ReceiverClauseOnClrType_RemainsExtension_NoDiagnostics()
    {
        var source = @"
import System.Text

func (sb StringBuilder) Reset() {
    sb.Length = 0
}
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
    }

    [Fact]
    public void Extension_RemainsAvailableAsOrdinaryFunctionName()
    {
        var source = @"
func extension(value int32) int32 { return value + 1 }
extension(41)
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Extension_RemainsAvailableAsExtensionMethodName()
    {
        var source = @"
func (s string) extension() int32 { return s.Length }
""hi"".extension()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void InBodyMethod_OnClass_IsTheOnlyInstanceMethodSpelling()
    {
        var source = @"
class Greeter(name string) {
    func Greet() string { return ""hi"" }
}

let g = Greeter(""x"")
g.Greet()
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id is "GS0103" or "GS0314");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void InBodyMethod_OwnedInstanceSemantics_NotAvailableViaReceiverClause()
    {
        // The in-body form gets implicit-this bare member access and
        // interface conformance; the receiver-clause form is an extension
        // and gets neither. A bare (unqualified) field reference inside a
        // receiver-clause function body does not resolve — only an
        // in-body method sees the type's own member scope implicitly.
        var source = @"
struct Counter {
    var Value int32
}

func (c Counter) Inc() int32 {
    return Value + 1
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void OperatorReceiverClause_OnOwnedClass_StillAttachesToType()
    {
        // ADR-0035: operators must use receiver-clause syntax; ADR-0182
        // keeps ADR-0079's operator carve-out — an operator has no in-body
        // form, so it keeps ownership-based routing unlike ordinary
        // receiver-clause functions.
        var source = @"
class Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

let sum = Vector2{X: 1, Y: 2} + Vector2{X: 3, Y: 4}
sum.X + sum.Y
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void TopLevelExtension_SameNameAsInBodyMethod_DoesNotCollide()
    {
        // The extension and instance-member declaration tables are
        // separate (ADR-0165's consequence, now the default rule): a
        // same-name receiver-clause extension no longer collides with an
        // in-body method the way two same-package receiver-clause
        // declarations used to under the pre-ADR-0182 rule.
        var source = @"
class Point {
    func Sum() int32 { return 1 }
}

func (p Point) Sum() int32 { return 2 }
0
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
