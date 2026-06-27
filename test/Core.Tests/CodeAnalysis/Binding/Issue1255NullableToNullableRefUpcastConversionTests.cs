// <copyright file="Issue1255NullableToNullableRefUpcastConversionTests.cs" company="GSharp">
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
/// Issue #1255: a nullable value of type <c>T?</c> must be implicitly convertible
/// to <c>U?</c> when <c>U</c> is a base class or implemented interface of <c>T</c>
/// — the lifted reference upcast maps null to null and reference-upcasts a
/// non-null value (representation-preserving). Previously <c>Conversion.Classify</c>
/// only lifted the non-null source case (<c>T → U?</c>, issue #1121) and rejected
/// <c>T? → U?</c> with <c>GS0155</c> (<c>GS0154</c> in argument position).
///
/// These tests assert the positive base-class and interface cases in both
/// argument and let-target positions, that the narrowing <c>T? → U</c>
/// (non-nullable target) still errors, that the #1121 <c>T → U?</c> control still
/// binds, and that an unrelated <c>T? → U?</c> still fails.
/// </summary>
public class Issue1255NullableToNullableRefUpcastConversionTests
{
    [Fact]
    public void NullableDerived_To_NullableBase_AsArgument_Binds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func TakeBase(p Base?) {}

func F(x Derived?) { TakeBase(x) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableConcrete_To_NullableInterface_AsArgument_Binds()
    {
        var source = @"
interface IBox {}
class AppleListBox : IBox {}

func Take(parent IBox?) {}

func F(x AppleListBox?) { Take(x) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableDerived_To_NullableBase_LetTarget_Binds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func F(x Derived?) {
    let b Base? = x
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableConcrete_To_NullableInterface_LetTarget_Binds()
    {
        var source = @"
interface IBox {}
class AppleListBox : IBox {}

func F(x AppleListBox?) {
    let b IBox? = x
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableConcrete_To_NullableTransitiveBaseInterface_Binds()
    {
        var source = @"
interface IBase {}
interface IDerived : IBase {}
class Impl : IDerived {}

func TakeBase(p IBase?) {}

func F(x Impl?) { TakeBase(x) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableDerived_To_NonNullableBase_StillReportsGS0155()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func TakeBase(p Base) {}

func F(x Derived?) { TakeBase(x) }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type"));
    }

    [Fact]
    public void NonNullableDerived_To_NullableBase_StillBinds_Control()
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
    public void UnrelatedNullable_To_NullableInterface_StillReportsGS0155()
    {
        var source = @"
interface IBox {}
class Unrelated {}

func F(x Unrelated?) {
    let b IBox? = x
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
