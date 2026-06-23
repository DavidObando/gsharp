// <copyright file="Issue987AbstractMethodBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #987: binder tests for abstract members. A no-body
/// <c>open func F() R;</c> on an <c>open class</c> is the canonical G# spelling
/// of a C# <c>abstract</c> method. These tests verify that the declaration no
/// longer crashes the binder (the original GS9998 ICE), that a concrete derived
/// class overriding it binds cleanly with working virtual dispatch, and that the
/// GS0386 / GS0387 / GS0388 diagnostics fire on the expected ill-formed inputs.
/// </summary>
public class Issue987AbstractMethodBinderTests
{
    [Fact]
    public void AbstractMethodDeclaration_NoIce_BindsClean()
    {
        var source = @"
open class Shape {
    open func Area() float64;
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ConcreteOverride_ResolvesAndDispatchesVirtually()
    {
        var source = @"
open class Shape {
    open func Area() float64;
}

class Circle(R float64) : Shape {
    override func Area() float64 { return 3.0 * R * R }
}

let s Shape = Circle(2.0)
s.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12.0, result.Value);
    }

    [Fact]
    public void AbstractMethod_WithParameters_BindsAndDispatches()
    {
        var source = @"
open class Animal {
    open func Speak(n int32) int32;
}

class Dog() : Animal {
    override func Speak(n int32) int32 { return n + 1 }
}

let a Animal = Dog()
a.Speak(41)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConstructingAbstractType_DiagnosticGS0386()
    {
        var source = @"
open class Shape {
    open func Area() float64;
}

let bad = Shape()
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0386");
    }

    [Fact]
    public void ConcreteDerivedMissingOverride_DiagnosticGS0387()
    {
        var source = @"
open class Shape {
    open func Area() float64;
}

class Circle(R float64) : Shape {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0387");
    }

    [Fact]
    public void OpenDerivedMayLeaveAbstract_NoDiagnostic()
    {
        var source = @"
open class Shape {
    open func Area() float64;
}

open class Mid : Shape {
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0387");
    }

    [Fact]
    public void AbstractMethodInNonOpenClass_DiagnosticGS0388()
    {
        var source = @"
class Shape {
    open func Area() float64;
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0388");
    }

    [Fact]
    public void BodylessMethodWithoutOpen_DiagnosticGS0388()
    {
        var source = @"
open class Shape {
    func Area() float64;
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0388");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
