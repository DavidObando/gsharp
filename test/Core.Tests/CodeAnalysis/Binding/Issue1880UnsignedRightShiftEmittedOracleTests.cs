// <copyright file="Issue1880UnsignedRightShiftEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1880: Emitted-oracle coverage for unsigned right shift.
/// </summary>
public class Issue1880UnsignedRightShiftEmittedOracleTests
{
    [Fact]
    public void SByte_NegativeOne_UnsignedShiftRight_MatchesCompiledIl()
    {
        var result = Evaluate("var v sbyte = -1\nv >>> 1");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((sbyte)-1, result.Value);
    }

    [Fact]
    public void Short_NegativeOne_UnsignedShiftRight_MatchesCompiledIl()
    {
        var result = Evaluate("var v short = -1\nv >>> 1");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((short)-1, result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
