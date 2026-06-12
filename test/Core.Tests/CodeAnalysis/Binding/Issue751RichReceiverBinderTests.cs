// <copyright file="Issue751RichReceiverBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Binder + tree-walking interpreter coverage for issue #751 / ADR-0084 §L2.
/// Verifies that each rich receiver shape accepted by the parser fix
/// (nullable, generic application, tuple, array-of-nullable, map[K]V)
/// binds as an extension method and is dispatched via the dot-syntax
/// call site. Only concrete (non-type-parameter) receiver shapes are
/// covered here — receivers that close over a function-level type
/// parameter (e.g. <c>sequence[T]</c>, <c>T?</c>) hit a separate binder
/// gap tracked in a follow-up issue.
/// </summary>
public class Issue751RichReceiverBinderTests
{
    [Fact]
    public void NullableString_Receiver_Dispatches_Via_DotSyntax()
    {
        var source = @"
func (self string?) OrElse(fb string) string {
    return self ?: fb
}

var x string? = ""hi""
var y string? = nil
x.OrElse(""nope"") + "":"" + y.OrElse(""nope"")
";
        var result = Evaluate(source);
        AssertNoErrors(result);
        Assert.Equal("hi:nope", result.Value);
    }

    [Fact]
    public void TupleTyped_Receiver_Dispatches_Via_DotSyntax()
    {
        var source = @"
func (self (int32, string)) Show() string {
    return self.Item1.ToString() + "":"" + self.Item2
}

var p = (42, ""hi"")
p.Show()
";
        var result = Evaluate(source);
        AssertNoErrors(result);
        Assert.Equal("42:hi", result.Value);
    }

    [Fact]
    public void NullableTuple_Receiver_Dispatches_Via_DotSyntax()
    {
        var source = @"
func (self (int32, string)?) Tag() string {
    if self == nil {
        return ""nil""
    }
    return self!!.Item2
}

var p (int32, string)? = (7, ""seven"")
var q (int32, string)? = nil
p.Tag() + ""|"" + q.Tag()
";
        var result = Evaluate(source);
        AssertNoErrors(result);
        Assert.Equal("seven|nil", result.Value);
    }

    [Fact]
    public void NullableArray_Receiver_Dispatches_Via_DotSyntax()
    {
        var source = @"
func (self []int32?) FirstOrZero() int32 {
    if self == nil {
        return 0
    }
    if self.Length == 0 {
        return 0
    }
    return self[0]
}

var present []int32? = []int32{10, 20}
var absent []int32? = nil
present.FirstOrZero() + absent.FirstOrZero()
";
        var result = Evaluate(source);
        AssertNoErrors(result);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Map_Receiver_Dispatches_Via_DotSyntax()
    {
        var source = @"
func (self map[string]int32) CountKeys() int32 {
    return self.Count
}

var m = map[string]int32{""a"": 1, ""b"": 2, ""c"": 3}
m.CountKeys()
";
        var result = Evaluate(source);
        AssertNoErrors(result);
        Assert.Equal(3, result.Value);
    }

    private static void AssertNoErrors(EvaluationResult result)
    {
        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.True(errors.Count == 0, "Unexpected errors:\n" + string.Join("\n", errors.Select(d => d.ToString())));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
