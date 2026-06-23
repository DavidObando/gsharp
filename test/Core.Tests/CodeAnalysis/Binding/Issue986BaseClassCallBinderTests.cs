// <copyright file="Issue986BaseClassCallBinderTests.cs" company="GSharp">
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
/// Issue #986: binder/interpreter tests for the base-class call expression
/// <c>base.Method(args)</c> (and the bracketed <c>base[BaseClass].Method(args)</c>
/// form). Verifies the happy paths resolve to the nearest base implementation
/// and run without recursion, and that the GS0383 / GS0384 / GS0385
/// diagnostics fire on the expected ill-formed inputs.
/// </summary>
public class Issue986BaseClassCallBinderTests
{
    [Fact]
    public void BaseDotCall_ResolvesAndRuns()
    {
        var source = @"
open class Shape {
    open func Describe() string { return ""shape"" }
}

class Circle() : Shape {
    override func Describe() string { return base.Describe() + "" circle"" }
}

var c = Circle()
c.Describe()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("shape circle", result.Value);
    }

    [Fact]
    public void BaseBracketCall_ResolvesAndRuns()
    {
        var source = @"
open class Shape {
    open func Describe() string { return ""shape"" }
}

class Circle() : Shape {
    override func Describe() string { return base[Shape].Describe() + "" circle"" }
}

var c = Circle()
c.Describe()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("shape circle", result.Value);
    }

    [Fact]
    public void BaseCall_WithParametersAndReturn()
    {
        var source = @"
open class Adder {
    open func Add(a int32, b int32) int32 { return a + b }
}

class LoggingAdder() : Adder {
    override func Add(a int32, b int32) int32 { return base.Add(a, b) + 100 }
}

var x = LoggingAdder()
x.Add(2, 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(105, result.Value);
    }

    [Fact]
    public void BaseCall_ReachesGrandparentImplementation()
    {
        var source = @"
open class A {
    open func Name() string { return ""A"" }
}

open class B() : A {
}

class C() : B {
    override func Name() string { return base.Name() + ""C"" }
}

var c = C()
c.Name()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("AC", result.Value);
    }

    [Fact]
    public void BaseCall_OutsideDerivedInstanceMember_DiagnosticGS0383()
    {
        var source = @"
func standalone() string {
    return base.ToString()
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0383");
    }

    [Fact]
    public void BaseCall_NoBaseClass_DiagnosticGS0383()
    {
        var source = @"
class Solo() {
    func Describe() string { return base.Describe() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0383");
    }

    [Fact]
    public void BaseCall_MemberNotOnBase_DiagnosticGS0384()
    {
        var source = @"
open class Shape {
    open func Describe() string { return ""shape"" }
}

class Circle() : Shape {
    override func Describe() string { return base.NotAMember() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0384");
    }

    [Fact]
    public void BaseBracket_NotABaseClass_DiagnosticGS0385()
    {
        var source = @"
open class Shape {
    open func Describe() string { return ""shape"" }
}

open class Other {
    open func Describe() string { return ""other"" }
}

class Circle() : Shape {
    override func Describe() string { return base[Other].Describe() }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0385");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
