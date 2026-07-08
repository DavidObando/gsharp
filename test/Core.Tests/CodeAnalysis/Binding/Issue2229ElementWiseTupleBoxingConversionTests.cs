// <copyright file="Issue2229ElementWiseTupleBoxingConversionTests.cs" company="GSharp">
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
/// Issue #2229: <see cref="Issue1256ElementWiseTupleConversionTests"/> taught
/// <c>Conversion.Classify</c> to accept a tuple `(T1, …, Tn) -> (U1, …, Un)`
/// whenever each element `Ti -> Ui` has an implicit conversion, but the lifted
/// nullable-target arm (`T? -> U?`) only covered TWO cases: reference-typed
/// underlyings sharing a CLR representation (#1255) and value-typed
/// underlyings widening to another value type (#1236). A value-typed nullable
/// source boxing to a reference-like nullable target — e.g. <c>int32? -> object?</c>,
/// which is exactly what a <c>bool?</c>/<c>int32?</c> tuple element boxes to when
/// passed as <c>(string, object?)</c> — fell through to <c>Conversion.None</c>
/// even though the bare `int32 -> object` boxing conversion is implicit. This
/// left every tuple containing such an element unable to convert, surfacing as
/// GS0154 on the <c>params (string, object?)...</c> call in the reported repro.
/// </summary>
public class Issue2229ElementWiseTupleBoxingConversionTests
{
    [Fact]
    public void NullableInt32Element_To_NullableObjectElement_AsArgument_Binds()
    {
        var source = @"
func Take(t (string, object?)) {}

func F(n int32?) { Take((""count"", n)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableBoolElement_To_NullableObjectElement_AsArgument_Binds()
    {
        var source = @"
func Take(t (string, object?)) {}

func F(b bool?) { Take((""ok"", b)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ParamsTupleArray_MixedNullableValueElements_Binds()
    {
        // The exact repro from issue #2229: a `params (string, object?)[]`-style
        // variadic call site with tuple literals whose second element is a
        // different nullable value type per argument.
        var source = @"
func Args(pairs ...(string, object?)) {}

func F(n int32?, b bool?) {
    Args((""count"", n), (""ok"", b))
}
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NonNullableInt32Element_To_NullableObjectElement_AsArgument_Binds()
    {
        var source = @"
func Take(t (string, object?)) {}

func F(n int32) { Take((""count"", n)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NumericWideningElement_IntToLong_AsArgument_Binds()
    {
        var source = @"
func Take(t (string, int64)) {}

func F(n int32) { Take((""count"", n)) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NestedTupleElement_BoxingInnerElement_Binds()
    {
        var source = @"
func Take(t (string, (string, object?))) {}

func F(n int32?) { Take((""outer"", (""inner"", n))) }
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NoConversion_NullableIntToNullableString_StillReportsError()
    {
        var source = @"
func Take(t (string, string?)) {}

func F(n int32?) { Take((""count"", n)) }
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
