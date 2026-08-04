// <copyright file="EmittedSessionEngineBehaviorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0156 interactive-engine behavioral suite: drives multi-cell submission
/// scripts through the emitted <see cref="EmittedSessionEngine"/> and asserts
/// each cell's error flag, echoed value rendering, and captured console
/// output against pinned goldens. Until Phase 3c (#3176) this was the Phase 2
/// dual-engine parity gate against the tree-walking <c>SessionEngine</c>; the
/// goldens below are the cross-checked values both engines agreed on when the
/// evaluator retired, so the behavioral coverage is preserved verbatim.
/// Cells expected to error are pinned as errors (both engines agreed on
/// those too).
/// </summary>
public sealed class EmittedSessionEngineBehaviorTests
{
    /// <summary>
    /// One expected cell outcome: <c>Value</c> is the echoed value's
    /// <see cref="object.ToString"/> rendering (<see langword="null"/> for no
    /// echo), <c>Output</c> the captured stdout, and <c>HasError</c> the
    /// error flag.
    /// </summary>
    public sealed record ExpectedCell(bool HasError, string Value, string Output = "")
    {
        public static ExpectedCell Ok(string value = null, string output = "") => new(false, value, output);

        public static ExpectedCell Error() => new(true, null);
    }

    public static TheoryData<string, string[], ExpectedCell[]> Scripts() => new()
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
            },
            new[]
            {
                ExpectedCell.Ok("6"),
                ExpectedCell.Ok("7"),
                ExpectedCell.Ok("42"),
                ExpectedCell.Ok("7"),
                ExpectedCell.Ok("7"),
            }
        },
        {
            "strings-and-interpolation",
            new[]
            {
                "var name = \"world\"",
                "\"hello \" + name",
                "name.Length",
            },
            new[]
            {
                ExpectedCell.Ok("world"),
                ExpectedCell.Ok("hello world"),
                ExpectedCell.Ok("5"),
            }
        },
        {
            "functions-and-recursion",
            new[]
            {
                "func fib(n int) int {\n    if n < 2 {\n        return n\n    }\n    return fib(n - 1) + fib(n - 2)\n}",
                "fib(10)",
            },
            new[]
            {
                ExpectedCell.Ok(),
                ExpectedCell.Ok("55"),
            }
        },
        {
            "structs-and-methods",
            new[]
            {
                "struct Point {\n    var X int\n    var Y int\n    func Sum() int {\n        return X + Y\n    }\n}",
                "var p = Point{X: 3, Y: 4}\np.Sum()",
                "p.Sum() * 2",
            },
            new[]
            {
                ExpectedCell.Ok(),
                ExpectedCell.Ok("7"),
                ExpectedCell.Ok("14"),
            }
        },
        {
            "console-output",
            new[]
            {
                "Console.WriteLine(\"line-1\")",
                "for i in range 3 {\n    Console.WriteLine(i.ToString())\n}",
            },
            new[]
            {
                ExpectedCell.Ok(output: "line-1\n"),

                // Bare `range` is not bindable in a submission; both engines
                // agreed this cell errors (pinned from the parity gate).
                ExpectedCell.Error(),
            }
        },
        {
            "redefinition-shadowing",
            new[]
            {
                "var x = 1",
                "var x = \"text\"",
                "x",
            },
            new[]
            {
                ExpectedCell.Ok("1"),
                ExpectedCell.Ok("text"),
                ExpectedCell.Ok("text"),
            }
        },
        {
            "failed-submissions-recover",
            new[]
            {
                "var ok = 41",
                "nope + 1",
                "ok + 1",
            },
            new[]
            {
                ExpectedCell.Ok("41"),
                ExpectedCell.Error(),
                ExpectedCell.Ok("42"),
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
            },
            new[]
            {
                ExpectedCell.Ok("System.Int32[]"),
                ExpectedCell.Ok("20"),
                ExpectedCell.Ok("System.Collections.Generic.Dictionary`2[System.String,System.Int32]"),
                ExpectedCell.Ok("1"),
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
            },
            new[]
            {
                ExpectedCell.Ok(),
                ExpectedCell.Ok("42"),
                ExpectedCell.Ok(),
                ExpectedCell.Ok("3"),
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
            },
            new[]
            {
                ExpectedCell.Ok(),
                ExpectedCell.Ok("9"),
                ExpectedCell.Ok("18"),
                ExpectedCell.Ok("25"),
            }
        },
        {
            // Issue #3185 (part 1, negative): G# interface conformance is
            // nominal — without the base clause the engine reports GS0155.
            "cross-cell-interface-nominal-required",
            new[]
            {
                "interface Shape {\n    func Area() int;\n}\nstruct Sq {\n    var S int\n    func Area() int {\n        return S * S\n    }\n}",
                "var sh Shape = Sq{S: 3}",
            },
            new[]
            {
                ExpectedCell.Ok(),
                ExpectedCell.Error(),
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
            },
            new[]
            {
                ExpectedCell.Ok("1"),
                ExpectedCell.Ok("5"),
                ExpectedCell.Ok("5"),
                ExpectedCell.Ok("7"),
                ExpectedCell.Ok("1"),
                ExpectedCell.Ok("7"),
                ExpectedCell.Ok("1"),
                ExpectedCell.Ok("41"),
                ExpectedCell.Ok("42"),
            }
        },
        {
            // Issue #3185 (part 2): a `let` struct global rejects member
            // writes (issue #1132's read-only rule).
            "let-global-member-writes-rejected",
            new[]
            {
                "struct P {\n    var X int\n}\nlet p = P{X: 1}\np.X",
                "p.X = 5",
                "p.X += 1",
                "p.X",
            },
            new[]
            {
                ExpectedCell.Ok("1"),
                ExpectedCell.Error(),
                ExpectedCell.Error(),
                ExpectedCell.Ok("1"),
            }
        },
    };

    [Theory]
    [MemberData(nameof(Scripts))]
    public void CellsMatchPinnedGoldens(string label, string[] submissions, ExpectedCell[] expected)
    {
        Assert.Equal(submissions.Length, expected.Length);
        using var engine = new EmittedSessionEngine { CaptureConsole = true };

        var mismatches = new List<string>();
        for (var i = 0; i < submissions.Length; i++)
        {
            var cell = engine.Evaluate(submissions[i]);
            var want = expected[i];

            if (cell.HasError != want.HasError)
            {
                mismatches.Add($"{label} cell {i + 1}: HasError expected={want.HasError} actual={cell.HasError} (diags: {string.Join("; ", cell.Diagnostics)})");
                continue;
            }

            if (!cell.HasError)
            {
                var actualValue = cell.Value?.ToString();
                if (!string.Equals(want.Value, actualValue, StringComparison.Ordinal))
                {
                    mismatches.Add($"{label} cell {i + 1}: Value expected='{want.Value}' actual='{actualValue}'");
                }

                if (!string.Equals(want.Output, cell.Output, StringComparison.Ordinal))
                {
                    mismatches.Add($"{label} cell {i + 1}: Output expected='{want.Output}' actual='{cell.Output}'");
                }
            }
        }

        Assert.True(mismatches.Count == 0, string.Join(Environment.NewLine, mismatches));
    }

    /// <summary>
    /// ADR-0156 Phase 2 deliberate semantic change, now simply the semantics:
    /// redefining a same-signature function and calling it gives clean
    /// newest-wins shadowing (the Roslyn interactive model). The evaluator
    /// engine's ambiguous-overload behavior retired with it in Phase 3c
    /// (#3176).
    /// </summary>
    [Fact]
    public void RedefinedFunctionCallUsesNewestDefinition()
    {
        using var emitted = new EmittedSessionEngine();
        emitted.Evaluate("func g() int {\n    return 1\n}");
        emitted.Evaluate("func g() int {\n    return 2\n}");
        var emittedCall = emitted.Evaluate("g()");
        Assert.False(emittedCall.HasError);
        Assert.Equal(2, emittedCall.Value);
    }

    /// <summary>
    /// Issue #3185 follow-on, now simply the semantics: a mutating method
    /// call on a struct-typed global passes the global's real address
    /// (<c>ldsflda</c>) as the receiver, so the mutation persists — matching
    /// what the same program compiled by <c>gsc</c> does. The evaluator's
    /// copy-receiver behavior retired with it in Phase 3c (#3176).
    /// </summary>
    [Fact]
    public void StructMethodReceiverMutationPersists()
    {
        const string declare = "struct P {\n    var X int\n    func Bump() {\n        X = X + 1\n    }\n}\nvar p = P{X: 41}";

        using var emitted = new EmittedSessionEngine();
        Assert.False(emitted.Evaluate(declare).HasError);
        Assert.False(emitted.Evaluate("p.Bump()").HasError);
        var emittedRead = emitted.Evaluate("p.X");
        Assert.False(emittedRead.HasError);
        Assert.Equal(42, emittedRead.Value);
    }
}
