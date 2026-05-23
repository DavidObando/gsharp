// <copyright file="NullSafeOperatorTests.cs" company="GSharp">
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
/// Phase 3.C.3 — null-safe operators <c>?:</c> (Elvis) and postfix <c>!!</c>
/// (null assertion). Member access <c>?.</c> is deferred.
/// </summary>
public class NullSafeOperatorTests
{
    [Fact]
    public void Elvis_NullLeft_ReturnsRight()
    {
        var source = @"
var x int? = nil
x ?: 42
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Elvis_NonNullLeft_ReturnsLeft()
    {
        var source = @"
var x int? = 7
x ?: 42
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void BangBang_NonNull_ReturnsUnderlying()
    {
        var source = @"
var x int? = 9
x!!
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void BangBang_Null_Throws()
    {
        var source = @"
var x int? = nil
x!!
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("nil value"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
