// <copyright file="ByRefEvaluationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0039: by-ref/out write-back semantics, asserted through the emitted
/// oracle. The interpreter pointer-model pin
/// (<c>AddressOf_Evaluates_To_Value_In_Interpreter</c>, "&amp;x evaluates to
/// the value") retired with the tree-walking evaluator in ADR-0156 Phase 3c
/// (#3176) — it asserted ADR-0039's interpreter-only by-design behavior,
/// which has no emitted equivalent (under emit the byref-typed local never
/// surfaces as a readable global, see #3215).
/// </summary>
public class ByRefEvaluationTests
{
    [Fact]
    public void IntTryParse_Success_WritesBack_Result()
    {
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""42"", &result)
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(true, vars["ok"]);
        Assert.Equal(42, vars["result"]);
    }

    [Fact]
    public void IntTryParse_Failure_WritesBack_Zero()
    {
        var source = @"
import System
var result = 99
var ok = Int32.TryParse(""notanumber"", &result)
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(false, vars["ok"]);
        Assert.Equal(0, vars["result"]);
    }

    [Fact]
    public void Dereference_Returns_Original_Value()
    {
        // #3215 (fixed): the byref-typed `p` stays an entry-point local under
        // emit while `x` and `y` still hoist, so the dereference round-trip
        // is observable through the emitted globals.
        var source = @"
var x = 100
var p = &x
var y = *p
";
        var (eval, vars) = EvaluateWithVariables(source);
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(100, vars["y"]);
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
