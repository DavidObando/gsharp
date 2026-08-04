// <copyright file="EmittedSessionEngineParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 Phase 2 parity gate: drives the SAME submission script through
/// the historical tree-walking <see cref="SessionEngine"/> and the emitted
/// <see cref="EmittedSessionEngine"/> and compares each cell's error flag,
/// echoed value rendering, and captured console output. Scripts here cover
/// the surface whose observable semantics the migration must preserve;
/// deliberate divergences (deinit, GS0510, interpreter boundaries) have their
/// own dedicated tests instead of parity rows.
/// </summary>
public sealed class EmittedSessionEngineParityTests
{
    public static TheoryData<string, string[]> ParityScripts() => new()
    {
        {
            "arithmetic-and-locals",
            new[]
            {
                "var a = 6",
                "var b = 7",
                "a * b",
                "a = a + 1",
                "a",
            }
        },
        {
            "strings-and-interpolation",
            new[]
            {
                "var name = \"world\"",
                "\"hello \" + name",
                "name.Length",
            }
        },
        {
            "functions-and-recursion",
            new[]
            {
                "func fib(n int) int {\n    if n < 2 {\n        return n\n    }\n    return fib(n - 1) + fib(n - 2)\n}",
                "fib(10)",
            }
        },
        {
            "structs-and-methods",
            new[]
            {
                "struct Point {\n    var X int\n    var Y int\n    func Sum() int {\n        return X + Y\n    }\n}",
                "var p = Point{X: 3, Y: 4}\np.Sum()",
                "p.Sum() * 2",
            }
        },
        {
            "console-output",
            new[]
            {
                "Console.WriteLine(\"line-1\")",
                "for i in range 3 {\n    Console.WriteLine(i.ToString())\n}",
            }
        },
        {
            "redefinition-shadowing",
            new[]
            {
                "var x = 1",
                "var x = \"text\"",
                "x",
            }
        },
        {
            "failed-submissions-recover",
            new[]
            {
                "var ok = 41",
                "nope + 1",
                "ok + 1",
            }
        },
        {
            "collections",
            new[]
            {
                "let arr = [3]int{10, 20, 30}",
                "arr[1]",
                "var m = map[string,int]{\"a\": 1}",
                "m[\"a\"]",
            }
        },
    };

    [Theory]
    [MemberData(nameof(ParityScripts))]
    public void BothEnginesAgreeCellByCell(string label, string[] submissions)
    {
        _ = label;
        var evaluator = new SessionEngine { CaptureConsole = true };
        using var emitted = new EmittedSessionEngine { CaptureConsole = true };

        var mismatches = new List<string>();
        for (var i = 0; i < submissions.Length; i++)
        {
            var evaluatorCell = evaluator.Evaluate(submissions[i]);
            var emittedCell = emitted.Evaluate(submissions[i]);

            if (evaluatorCell.HasError != emittedCell.HasError)
            {
                mismatches.Add($"cell {i + 1}: HasError evaluator={evaluatorCell.HasError} emitted={emittedCell.HasError} (evaluator diags: {string.Join("; ", evaluatorCell.Diagnostics)}) (emitted diags: {string.Join("; ", emittedCell.Diagnostics)})");
                continue;
            }

            if (!evaluatorCell.HasError)
            {
                var evaluatorValue = evaluatorCell.Value?.ToString();
                var emittedValue = emittedCell.Value?.ToString();
                if (!string.Equals(evaluatorValue, emittedValue, StringComparison.Ordinal))
                {
                    mismatches.Add($"cell {i + 1}: Value evaluator='{evaluatorValue}' emitted='{emittedValue}'");
                }
            }

            if (!string.Equals(evaluatorCell.Output, emittedCell.Output, StringComparison.Ordinal))
            {
                mismatches.Add($"cell {i + 1}: Output evaluator='{evaluatorCell.Output}' emitted='{emittedCell.Output}'");
            }
        }

        Assert.True(mismatches.Count == 0, string.Join(Environment.NewLine, mismatches));
    }

    /// <summary>
    /// ADR-0156 Phase 2 deliberate semantic change, pinned on both engines:
    /// redefining a same-signature function and calling it. The evaluator
    /// engine's chained scopes surface BOTH declarations as overloads, so the
    /// call reports an ambiguity and the redefined function is uncallable;
    /// the emitted engine gives clean newest-wins shadowing (the Roslyn
    /// interactive model). When the emitted engine becomes the default, the
    /// evaluator half of this test retires with it.
    /// </summary>
    [Fact]
    public void RedefinedFunctionCallDivergesByDesign()
    {
        var evaluator = new SessionEngine();
        evaluator.Evaluate("func g() int {\n    return 1\n}");
        evaluator.Evaluate("func g() int {\n    return 2\n}");
        var evaluatorCall = evaluator.Evaluate("g()");
        Assert.True(evaluatorCall.HasError);
        Assert.Contains(evaluatorCall.Diagnostics, d => d.Message.Contains("ambiguous", StringComparison.OrdinalIgnoreCase));

        using var emitted = new EmittedSessionEngine();
        emitted.Evaluate("func g() int {\n    return 1\n}");
        emitted.Evaluate("func g() int {\n    return 2\n}");
        var emittedCall = emitted.Evaluate("g()");
        Assert.False(emittedCall.HasError);
        Assert.Equal(2, emittedCall.Value);
    }
}
