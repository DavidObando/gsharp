// <copyright file="Issue1927VarianceConversionAndStringConcatTests.cs" company="GSharp">
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
/// Issue #1927 — two distinct bugs, both exercised via the grid app G08
/// generics fixture:
///
/// <para>Bug A: declaration-site variance (<c>out</c>/<c>in</c>, ADR-0021)
/// was recognized during interface DECLARATION (position checks), but the
/// CONVERSION classifier never consulted it, so a constructed covariant
/// interface (<c>ISource[string]</c>) failed to convert to its widened form
/// (<c>ISource[object]</c>) with GS0155, and likewise a contravariant
/// interface (<c>ISink[object]</c>) failed to narrow to
/// <c>ISink[string]</c>.</para>
///
/// <para>Bug B: the binary <c>+</c> string-concatenation operator only
/// accepted homogeneous <c>string + string</c>; a <c>string?</c> operand
/// (e.g. from <c>T.ToString()</c> under a <c>class</c> constraint, or from
/// <c>object.ToString()</c>) triggered GS0129 "'string' + 'string?'".</para>
/// </summary>
public class Issue1927VarianceConversionAndStringConcatTests
{
    [Fact]
    public void CovariantOutInterface_StringToObject_ConvertsImplicitly()
    {
        var source = @"
interface ISource[out T] {
    func Get() T;
}

class StringSource : ISource[string] {
    func Get() string { return ""made"" }
}

var source ISource[string] = StringSource{}
var widened ISource[object] = source
widened.Get().ToString()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("made", result.Value);
    }

    [Fact]
    public void ContravariantInInterface_ObjectToString_ConvertsImplicitly()
    {
        var source = @"
interface ISink[in T] {
    func Accept(value T) string;
}

class ObjectSink : ISink[object] {
    func Accept(value object) string { return ""took:"" + value.ToString() }
}

var sink ISink[object] = ObjectSink{}
var narrowed ISink[string] = sink
narrowed.Accept(""note"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("took:note", result.Value);
    }

    [Fact]
    public void InvariantInterface_DifferentArguments_StillDiagnoses()
    {
        // Guardrail: a type parameter with NO variance modifier must remain
        // invariant even after the variance-conversion fix — the arguments
        // must be identical, not merely convertible.
        var source = @"
interface IBox[T] {
    func Get() T;
}

class StringBox : IBox[string] {
    func Get() string { return ""x"" }
}

var box IBox[string] = StringBox{}
var widened IBox[object] = box
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void ContravariantInInterface_WrongDirection_StillDiagnoses()
    {
        // Guardrail: contravariance only permits narrowing (object -> string
        // interface). The reverse (widening an `in`-annotated interface)
        // must still fail.
        var source = @"
interface ISink[in T] {
    func Accept(value T) string;
}

class StringSink : ISink[string] {
    func Accept(value string) string { return ""got:"" + value }
}

var narrow ISink[string] = StringSink{}
var wide ISink[object] = narrow
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void ClassConstrainedTypeParameter_ToStringConcat_Binds()
    {
        // Bug B, exact reported shape: `T.ToString()` under a `class`
        // constraint yields `string?`; concatenating it with a `string`
        // literal must not raise GS0129.
        var source = @"
func describe[T class](item T) string {
    return ""value:"" + item.ToString()
}

describe(""hello"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("value:hello", result.Value);
    }

    [Theory]
    [InlineData(@"var s1 string? = ""a""
var s2 string? = ""b""
s1 + s2", "ab")]
    [InlineData(@"var s1 string = ""a""
var s2 string? = ""b""
s1 + s2", "ab")]
    [InlineData(@"var s1 string? = ""a""
var s2 string = ""b""
s1 + s2", "ab")]
    public void StringConcat_AnyNullableCombination_Binds(string source, string expected)
    {
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
