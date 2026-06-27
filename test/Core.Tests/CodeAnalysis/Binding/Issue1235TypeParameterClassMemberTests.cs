// <copyright file="Issue1235TypeParameterClassMemberTests.cs" company="GSharp">
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
/// Issue #1235: a value whose static type is a type parameter constrained to a
/// (user) class or interface exposes that constraint's FULL instance member
/// surface — instance fields and properties, not only methods. Previously a
/// field/property read (<c>t.F</c> / <c>t.P</c>) on a constrained type
/// parameter reported GS0158 "Cannot find member" while method calls resolved
/// correctly.
/// </summary>
public class Issue1235TypeParameterClassMemberTests
{
    [Fact]
    public void ClassConstraint_PropertyRead_BindsAndReturnsValue()
    {
        var source = @"
open class Base { prop P int32 { get; set; } }

func ReadP[T Base](t T) int32 { return t.P }
var b = Base()
b.P = 7
ReadP[Base](b)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ClassConstraint_FieldRead_BindsAndReturnsValue()
    {
        var source = @"
open class Base { var F2 int32 }

func ReadF[T Base](t T) int32 { return t.F2 }
var b = Base()
b.F2 = 13
ReadF[Base](b)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void ClassConstraint_MethodCall_StillBinds()
    {
        var source = @"
open class Base { func Hello() int32 { return 42 } }

func CallHello[T Base](t T) int32 { return t.Hello() }
CallHello[Base](Base())
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ClassConstraint_InheritedProperty_Binds()
    {
        var source = @"
open class GrandBase { prop Inherited int32 { get; set; } }
open class Base : GrandBase { }

func ReadInherited[T Base](t T) int32 { return t.Inherited }
var b = Base()
b.Inherited = 100
ReadInherited[Base](b)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void InterfaceConstraint_PropertyRead_Binds()
    {
        var source = @"
interface IHasName { prop Name int32 { get; } }
open class Named : IHasName { prop Name int32 { get; set; } }

func ReadName[T IHasName](t T) int32 { return t.Name }
var n = Named()
n.Name = 55
ReadName[Named](n)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(55, result.Value);
    }

    [Fact]
    public void UnknownMemberOnTypeParameter_StillReportsGS0158()
    {
        var source = @"
open class Base { var F2 int32 }

func Bad[T Base](t T) int32 { return t.Missing }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0158");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
