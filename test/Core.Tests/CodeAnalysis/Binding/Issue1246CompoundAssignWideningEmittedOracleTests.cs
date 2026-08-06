// <copyright file="Issue1246CompoundAssignWideningEmittedOracleTests.cs" company="GSharp">
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
/// Issue #1246: Emitted-oracle coverage for compound assign widening.
/// </summary>
public class Issue1246CompoundAssignWideningEmittedOracleTests
{
    [Fact]
    public void Int32PlusEqualsUInt8_EvaluatesWidenedSum()
    {
        var source = @"
var a int32 = 200
var b uint8 = 100
a += b
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(300, vars["a"]);
    }

    [Fact]
    public void Int64PlusEqualsInt32_EvaluatesWidenedSum()
    {
        var source = @"
var acc int64 = 4000000000
var i int32 = 1
acc += i
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(4000000001L, vars["acc"]);
    }

    [Fact]
    public void Int64PlusEqualsIntLiteral_EvaluatesSum()
    {
        var source = @"
var x int64 = 4000000000
x += 1
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(4000000001L, vars["x"]);
    }

    private static (EmittedOracleResult Result, IReadOnlyDictionary<string, object> Variables) EvaluateWithVariables(string source)
    {
        // Post-run globals read back through the oracle (issue #3176 Phase
        // 3b.2): the emitted equivalent of the evaluator's variables
        // dictionary.
        var result = EmittedOracle.Evaluate(source);
        return (result, result.ReadGlobals());
    }
}
