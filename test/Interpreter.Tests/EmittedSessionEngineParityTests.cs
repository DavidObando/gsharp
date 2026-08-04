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
        {
            // Issue #3184: a prior cell's top-level function used as a value —
            // untyped `let`, direct invocation, and delegate-argument passing.
            "prior-cell-function-as-value",
            new[]
            {
                "func addOne(n int) int {\n    return n + 1\n}",
                "let g = addOne\ng(41)",
                "func apply(f func(int) int, v int) int {\n    return f(v)\n}",
                "apply(addOne, 1) + g(0)",
            }
        },
        {
            // Issue #3185 (part 1): cross-cell interface conversion for a
            // nominally conforming struct — declaration-typed global, reuse
            // from a later cell, and reassignment through the conversion.
            "cross-cell-interface-conversion",
            new[]
            {
                "interface Shape {\n    func Area() int;\n}\nstruct Sq : Shape {\n    var S int\n    func Area() int {\n        return S * S\n    }\n}",
                "var sh Shape = Sq{S: 3}\nsh.Area()",
                "sh.Area() * 2",
                "sh = Sq{S: 5}\nsh.Area()",
            }
        },
        {
            // Issue #3185 (part 1, negative): G# interface conformance is
            // nominal — without the base clause BOTH engines report GS0155.
            "cross-cell-interface-nominal-required",
            new[]
            {
                "interface Shape {\n    func Area() int;\n}\nstruct Sq {\n    var S int\n    func Area() int {\n        return S * S\n    }\n}",
                "var sh Shape = Sq{S: 3}",
            }
        },
        {
            // Issue #3185 (part 2): member writes through prior-cell globals —
            // struct simple/compound, nested struct chains, and class-typed
            // globals (simple and compound).
            "member-writes-through-prior-cell-globals",
            new[]
            {
                "struct P {\n    var X int\n}\nvar p = P{X: 1}\np.X",
                "p.X = 5",
                "p.X",
                "p.X += 2\np.X",
                "struct Inner {\n    var C int\n}\nstruct Outer {\n    var B Inner\n}\nvar a = Outer{B: Inner{C: 1}}\na.B.C",
                "a.B.C = 7\na.B.C",
                "class Counter {\n    var N int\n}\nvar c = Counter{N: 1}\nc.N",
                "c.N = 41\nc.N",
                "c.N += 1\nc.N",
            }
        },
        {
            // Issue #3185 (part 2): a `let` struct global rejects member
            // writes on both engines (issue #1132's read-only rule).
            "let-global-member-writes-rejected",
            new[]
            {
                "struct P {\n    var X int\n}\nlet p = P{X: 1}\np.X",
                "p.X = 5",
                "p.X += 1",
                "p.X",
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
    /// interactive model). Phase 3a made the emitted engine the interactive
    /// default; both halves keep selecting their engine EXPLICITLY while the
    /// deprecated <c>--engine evaluator</c> escape hatch exists, and the
    /// evaluator half retires with it in Phase 3c.
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

    /// <summary>
    /// Issue #3185 follow-on, pinned on both engines: a mutating method call
    /// on a struct-typed global. The tree-walking evaluator invokes struct
    /// methods against a COPY of the receiver, so the mutation is lost — even
    /// within a single cell — while the emitted engine passes the global's
    /// real address (`ldsflda`) as the receiver, so the mutation persists,
    /// matching what the same program compiled by `gsc` does. Phase 3a made
    /// the emitted engine the interactive default; both halves keep selecting
    /// their engine EXPLICITLY while the deprecated <c>--engine evaluator</c>
    /// escape hatch exists, and the evaluator half retires with it in
    /// Phase 3c.
    /// </summary>
    [Fact]
    public void StructMethodReceiverMutationDivergesByDesign()
    {
        const string declare = "struct P {\n    var X int\n    func Bump() {\n        X = X + 1\n    }\n}\nvar p = P{X: 41}";

        var evaluator = new SessionEngine();
        Assert.False(evaluator.Evaluate(declare).HasError);
        Assert.False(evaluator.Evaluate("p.Bump()").HasError);
        var evaluatorRead = evaluator.Evaluate("p.X");
        Assert.False(evaluatorRead.HasError);
        Assert.Equal(41, evaluatorRead.Value);

        using var emitted = new EmittedSessionEngine();
        Assert.False(emitted.Evaluate(declare).HasError);
        Assert.False(emitted.Evaluate("p.Bump()").HasError);
        var emittedRead = emitted.Evaluate("p.X");
        Assert.False(emittedRead.HasError);
        Assert.Equal(42, emittedRead.Value);
    }
}
