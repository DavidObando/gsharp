// <copyright file="ClrConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Stream E — user-defined / imported CLR conversion operators
/// (<c>op_Implicit</c>, <c>op_Explicit</c>) participate in
/// <c>BindConversion</c> after built-in conversions fail.
/// </summary>
public class ClrConversionTests
{
    [Fact]
    public void DateTimeToDateTimeOffset_ImplicitConversion_Succeeds()
    {
        // DateTimeOffset declares public static op_Implicit(DateTime).
        var source = @"
import System

var dt = DateTime(2025, 6, 1)
var dto DateTimeOffset = dt
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.IsType<DateTimeOffset>(result.Value);
        Assert.Equal(new DateTime(2025, 6, 1), ((DateTimeOffset)result.Value).DateTime);
    }

    [Fact]
    public void IntToBigInteger_ImplicitConversion_Succeeds()
    {
        // BigInteger declares public static op_Implicit(Int32).
        var source = @"
import System.Numerics

var x BigInteger = 12345
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(System.Numerics.BigInteger.Parse("12345"), result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
