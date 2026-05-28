// <copyright file="ExtensionFunctionTests.cs" company="GSharp">
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
/// Phase 3.B.6 — extension functions per ADR-0019. Declared with a Go-style
/// receiver clause <c>func (recv RecvType) Name(args) ret { ... }</c>; called
/// as if they were instance methods on the receiver type.
/// </summary>
public class ExtensionFunctionTests
{
    [Fact]
    public void Extension_OnCrossPackageUserStruct_Binds_And_Dispatches()
    {
        var typeTree = SyntaxTree.Parse(SourceText.From(@"
package Geometry
public type Point struct {
    X int32
    Y int32
}
"));
        var extensionTree = SyntaxTree.Parse(SourceText.From(@"
package GeometryExtensions
func (p Point) SumXY() int32 {
    return p.X + p.Y
}

var p = Point{X: 3, Y: 4}
p.SumXY()
"));
        var result = Evaluate(typeTree, extensionTree);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Extension_OnClrString_Binds_And_Dispatches()
    {
        var source = @"
import System

func (s string) Loud() string {
    return s + ""!""
}

var greeting = ""hi""
greeting.Loud()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi!", result.Value);
    }

    [Fact]
    public void Extension_WithExtraArgs_BindsCorrectly()
    {
        var source = @"
func (a int32) Plus(b int32) int32 {
    return a + b
}

var x = 10
x.Plus(5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    [Fact]
    public void Extension_DistinctReceivers_SameName_AllowedAndDispatch()
    {
        var source = @"
import System

func (i int32) Describe() string {
    return ""int32""
}

func (s string) Describe() string {
    return ""string""
}

var i = 1
i.Describe()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("int32", result.Value);
    }

    [Fact]
    public void Extension_DuplicateOnSameReceiver_Diagnoses()
    {
        var source = @"
func (i int32) Foo() int32 { return 1 }
func (i int32) Foo() int32 { return 2 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Extension_DoesNotCollide_With_FreeFunction_OfSameName()
    {
        var source = @"
func Foo() int32 { return 99 }
func (i int32) Foo() int32 { return i + 1 }

var n = 4
n.Foo()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        return Evaluate(syntaxTree);
    }

    private static EvaluationResult Evaluate(params SyntaxTree[] syntaxTrees)
    {
        var compilation = new Compilation(syntaxTrees);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
