// <copyright file="Issue1256ElementWiseTupleConversionTests.cs" company="GSharp">
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
/// Issue #1256: a tuple type <c>(T1, …, Tn)</c> must be implicitly convertible to
/// <c>(U1, …, Un)</c> when both are tuple types of the SAME arity and EACH element
/// <c>Ti → Ui</c> has an implicit conversion (identity, reference/interface upcast,
/// nullable-reference upcast, numeric widening, …). Previously
/// <c>Conversion.Classify</c> treated the tuple as a single nominal type requiring
/// exact element identity, so <c>(A, Derived) → (A, Base)</c> failed with
/// <c>GS0155</c> (<c>GS0154</c> in argument position).
///
/// These tests assert the positive base-class, interface, 3-element-mixed, and
/// nullable-reference element cases across argument, let-target, and return
/// positions; and that downcasts, no-conversion element pairs, and arity
/// mismatches still error exactly as C# requires.
/// </summary>
public class Issue1256ElementWiseTupleConversionTests
{
    [Fact]
    public void DerivedElement_To_BaseElement_AsArgument_Binds()
    {
        var source = @"
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base)) {}

func F(a A, d Derived) { Take((a, d)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ConcreteElement_To_InterfaceElement_AsArgument_Binds()
    {
        var source = @"
class A {}
interface IFace {}
class Concrete : IFace {}

func Take(t (A, IFace)) {}

func F(a A, c Concrete) { Take((a, c)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void DerivedElement_To_BaseElement_LetTarget_Binds()
    {
        var source = @"
open class Base {}
class Derived : Base {}

func F(d Derived) {
    let t (Base, int32) = (d, 1)
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void DerivedElement_To_BaseElement_ReturnPosition_Binds()
    {
        var source = @"
class A {}
open class Base {}
class Derived : Base {}

func Make(a A, d Derived) (A, Base) {
    return (a, d)
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ThreeElementMixed_IdentityUpcastAndWidening_Binds()
    {
        var source = @"
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base, int64)) {}

func F(a A, d Derived, n int32) { Take((a, d, n)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableDerivedElement_To_NullableBaseElement_Binds()
    {
        var source = @"
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base?)) {}

func F(a A, d Derived?) { Take((a, d)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void IdenticalElementTypes_AsArgument_StillBinds_Control()
    {
        var source = @"
func Take(t ([]int32, int32)) {}

func F(arr []int32) { Take((arr, 3)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void BaseElement_To_DerivedElement_Downcast_StillReportsError()
    {
        var source = @"
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Derived)) {}

func F(a A, b Base) { Take((a, b)) }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type"));
    }

    [Fact]
    public void NoElementConversion_IntToString_StillReportsError()
    {
        var source = @"
class A {}

func Take(t (A, string)) {}

func F(a A, n int32) { Take((a, n)) }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type"));
    }

    [Fact]
    public void ArityMismatch_StillReportsError()
    {
        var source = @"
class A {}
open class Base {}
class Derived : Base {}

func Take(t (A, Base)) {}

func F(a A, d Derived) { Take((a, d, a)) }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("Cannot convert") || d.Message.Contains("requires a value of type"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
