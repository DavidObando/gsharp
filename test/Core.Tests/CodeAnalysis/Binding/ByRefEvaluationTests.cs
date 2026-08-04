// <copyright file="ByRefEvaluationTests.cs" company="GSharp">
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
/// ADR-0039: Evaluator (interpreter) tests for by-ref/out write-back semantics.
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

    [Fact]
    public void AddressOf_Evaluates_To_Value_In_Interpreter()
    {
        // ADR-0156 Phase 3b (#3176): pinned on Compilation.Evaluate — the
        // asserted semantics ("&x evaluates to the value") are the
        // interpreter's pointer model by design (ADR-0039), and under the
        // #3215 fix the byref-typed `p` is an entry-point local, not a
        // readable global; retires with the evaluator (Phase 3c).
        var source = @"
var x = 55
var p = &x
";
        var (eval, vars) = EvaluateWithEvaluatorVariables(source);
        Assert.Empty(eval.Diagnostics);
        // In the interpreter, &x just evaluates to the value of x.
        Assert.Equal(55, vars["p"]);
    }

    private static (EmittedOracleResult Result, IReadOnlyDictionary<string, object> Variables) EvaluateWithVariables(string source)
    {
        // Post-run globals read back through the oracle (issue #3176 Phase
        // 3b.2): the emitted equivalent of the evaluator's variables
        // dictionary.
        var result = EmittedOracle.Evaluate(source);
        return (result, result.ReadGlobals());
    }

    // ADR-0156 Phase 3b (#3176): evaluator twin for the ADR-0039-pinned
    // pointer-model test above; delete with the evaluator (Phase 3c).
    private static (EvaluationResult Result, Dictionary<string, object> Variables) EvaluateWithEvaluatorVariables(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(variables);

        var namedVars = new Dictionary<string, object>();
        foreach (var kvp in variables)
        {
            namedVars[kvp.Key.Name] = kvp.Value;
        }

        return (result, namedVars);
    }
}
