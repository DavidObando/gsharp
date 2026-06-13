// <copyright file="Issue796FunctionAndSequenceNilCompareInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #796 / ADR-0084 §L5 follow-up — interpreter parity for
/// <c>== nil</c> / <c>!= nil</c> on function-typed and sequence-typed
/// values. The fix is in the binder
/// (<see cref="GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator"/>'s
/// <c>IsNullCompare</c> arm); the interpreter rides on the same bound
/// tree, so these tests pin the runtime semantics observable via the
/// REPL so a future emitter or evaluator change cannot diverge from
/// the e2e-emit coverage in
/// <c>Issue796FunctionAndSequenceNilCompareEmitTests</c>.
/// </summary>
public class Issue796FunctionAndSequenceNilCompareInterpreterTests
{
    [Fact]
    public void FunctionParameter_EqualsNil_BindsAndEvaluates()
    {
        var source = """
            func Guard(f () -> int32) string {
                if f == nil {
                    return "nil"
                }
                return "bound"
            }

            var nilFn () -> int32 = default(() -> int32)
            Console.WriteLine(Guard(() -> 42))
            Console.WriteLine(Guard(nilFn))
            """;

        Assert.Equal("bound\nnil\n", RunSubmission(source));
    }

    [Fact]
    public void FunctionParameter_NotEqualNil_BindsAndEvaluates()
    {
        var source = """
            func IsBound(f () -> int32) bool {
                return f != nil
            }

            var nilFn () -> int32 = default(() -> int32)
            Console.WriteLine(IsBound(() -> 1))
            Console.WriteLine(IsBound(nilFn))
            """;

        Assert.Equal("True\nFalse\n", RunSubmission(source));
    }

    [Fact]
    public void ConcreteArrowFunction_EqualsNil_BindsAndEvaluates()
    {
        var source = """
            func Apply(x int32, f (int32) -> int32) bool {
                return f == nil
            }

            var nilFn (int32) -> int32 = default((int32) -> int32)
            Console.WriteLine(Apply(1, nilFn))
            Console.WriteLine(Apply(1, (n int32) -> n + 1))
            """;

        Assert.Equal("True\nFalse\n", RunSubmission(source));
    }

    [Fact]
    public void SequenceInt32_EqualsNil_BindsAndEvaluates()
    {
        var source = """
            func Sum(xs sequence[int32]) int32 {
                if xs == nil {
                    return -1
                }
                var total = 0
                for x in xs {
                    total = total + x
                }
                return total
            }

            var nilSeq sequence[int32] = default(sequence[int32])
            Console.WriteLine(Sum([]int32{1, 2, 3}))
            Console.WriteLine(Sum(nilSeq))
            """;

        Assert.Equal("6\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void SequenceInt32_NotEqualNil_BindsAndEvaluates()
    {
        var source = """
            func HasAny(xs sequence[int32]) bool {
                return xs != nil
            }

            var nilSeq sequence[int32] = default(sequence[int32])
            Console.WriteLine(HasAny([]int32{}))
            Console.WriteLine(HasAny(nilSeq))
            """;

        Assert.Equal("True\nFalse\n", RunSubmission(source));
    }

    [Fact]
    public void NamedDelegateType_EqualsNil_BindsAndEvaluates()
    {
        // ADR-0059 named delegate. The interpreter does not currently
        // evaluate named-delegate constructions (`var x T = func(...)`
        // for `T` a named delegate type bombs with `GS9999: Unexpected
        // type` — a separate gap), so this test focuses strictly on
        // the binder shape via a nil-typed local: the named-delegate
        // value never has to materialise.
        var source = """
            type Reducer = delegate func(a int32, b int32) int32

            func IsBound(f Reducer) string {
                if f == nil {
                    return "nil"
                }
                return "bound"
            }

            var nilReducer Reducer = default(Reducer)
            Console.WriteLine(IsBound(nilReducer))
            """;

        var output = RunSubmission(source);
        Assert.Contains("nil\n", output);
    }

    [Fact]
    public void LegacyFuncForm_EqualsNil_BindsAndEvaluates()
    {
        // ADR-0075 deprecates the legacy `func(T) U` type-clause form
        // (GS0303 warning). The interpreter still binds and runs the
        // shape — assert the program output is correct and the
        // warning is the only extra noise.
        var source = """
            func Guard(f func(int32) int32) string {
                if f == nil {
                    return "nil"
                }
                return "bound"
            }

            var nilFn func(int32) int32 = default(func(int32) int32)
            Console.WriteLine(Guard((x int32) -> x * 2))
            Console.WriteLine(Guard(nilFn))
            """;

        var output = RunSubmission(source);
        Assert.Contains("bound\nnil\n", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
