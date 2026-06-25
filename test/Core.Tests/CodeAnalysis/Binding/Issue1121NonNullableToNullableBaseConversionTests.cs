// <copyright file="Issue1121NonNullableToNullableBaseConversionTests.cs" company="GSharp">
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
/// Issue #1121: a non-nullable value of type <c>T</c> must be implicitly
/// convertible to <c>U?</c> when <c>U</c> is a base class or implemented
/// interface of <c>T</c> — the conversion combines a reference upcast with
/// nullable wrapping. Previously <c>Conversion.Classify</c> only accepted a
/// nullable target whose underlying type was identical to the source, so the
/// <c>T → U?</c> combination was rejected with <c>GS0155</c>.
///
/// These tests assert the positive base-class and interface cases (argument
/// passing, assignment, return, and transitive base interface), that the
/// pre-existing <c>T → T?</c> and plain <c>T → U</c> upcasts still bind, and
/// that an unrelated type to <c>U?</c> still fails with <c>GS0155</c>.
/// </summary>
public class Issue1121NonNullableToNullableBaseConversionTests
{
    [Fact]
    public void NonNullableClass_To_NullableInterface_AsArgument_Binds()
    {
        var source = @"
interface IBox {}
class StsdBox : IBox {}

func TakeIface(p IBox?) {}

TakeIface(StsdBox{})
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableDerived_To_NullableBase_AsArgument_Binds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func TakeBase(p Base?) {}

TakeBase(Derived{})
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableDerived_To_NullableBase_Assignment_Binds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

var b Base? = Derived{}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableDerived_To_NullableBase_Return_Binds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func Make() Base? {
    return Derived{}
}

Make()
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableClass_To_NullableTransitiveBaseInterface_Binds()
    {
        var source = @"
interface IBase {}
interface IDerived : IBase {}
class Impl : IDerived {}

func TakeBase(p IBase?) {}

TakeBase(Impl{})
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullable_To_SameNullable_StillBinds()
    {
        var source = @"
class StsdBox {}

func Take(p StsdBox?) {}

Take(StsdBox{})
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableDerived_To_NonNullableBase_StillBinds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func Take(p Base) {}

Take(Derived{})
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void Unrelated_To_NullableInterface_StillReportsGS0155()
    {
        var source = @"
interface IBox {}
class Unrelated {}

var b IBox? = Unrelated{}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert type"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
