// <copyright file="Issue737NilGuardElseBranchInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #737 — interpreter parity for the if-else terminator shape that
/// the emit fix unblocked. The interpreter shares the binder with the
/// emit pipeline (smart-cast narrowing rides on
/// <c>BoundVariableExpression.NarrowedType</c>) so it has always handled
/// the narrowed reads correctly; the bug was strictly in the IL emitter.
/// These tests pin down the runtime semantics so a future emitter or
/// lowerer change cannot diverge from the interpreter's observable
/// behavior.
/// </summary>
public class Issue737NilGuardElseBranchInterpreterTests
{
    [Fact]
    public void IfElse_BothBranchesReturn_String_ElseBranchReadsNarrowed()
    {
        var source = """
            func Length(s string?) int32 {
                if s == nil {
                    return -1
                } else {
                    return s.Length
                }
            }

            Console.WriteLine(Length("hello"))
            Console.WriteLine(Length(nil))
            """;

        Assert.Equal("5\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void IfElse_PositiveGuard_ThenBranchReadsNarrowed()
    {
        var source = """
            func Use(s string) int32 {
                return s.Length
            }

            func Length(s string?) int32 {
                if s != nil {
                    return Use(s)
                }
                return -1
            }

            Console.WriteLine(Length("hi"))
            Console.WriteLine(Length(nil))
            """;

        Assert.Equal("2\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void IfElse_BothBranchesReturn_OrComposition_ElseReadsNarrowed()
    {
        var source = """
            func Length(s string?, force bool) int32 {
                if s == nil || force {
                    return -1
                } else {
                    return s.Length
                }
            }

            Console.WriteLine(Length("hello", false))
            Console.WriteLine(Length("hello", true))
            Console.WriteLine(Length(nil, false))
            """;

        Assert.Equal("5\n-1\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void IfElse_BothBranchesReturn_ChainedAndGuard()
    {
        var source = """
            func Both(a string?, b string?) int32 {
                if a != nil && b != nil {
                    return a.Length + b.Length
                } else {
                    return -1
                }
            }

            Console.WriteLine(Both("hi", "ya"))
            Console.WriteLine(Both("hi", nil))
            Console.WriteLine(Both(nil, "ya"))
            """;

        Assert.Equal("4\n-1\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void IfElse_BothBranchesReturn_UserClass_ElseReadsNarrowed()
    {
        var source = """
            class Greeter {
                var Name string
                func Greet() string { return "hi " + Name }
            }

            func DescribeOrDefault(g Greeter?) string {
                if g == nil {
                    return "none"
                } else {
                    return g.Greet()
                }
            }

            Console.WriteLine(DescribeOrDefault(Greeter{Name: "Alice"}))
            Console.WriteLine(DescribeOrDefault(nil))
            """;

        Assert.Equal("hi Alice\nnone\n", RunSubmission(source));
    }

    [Fact]
    public void IfElse_BothBranchesReturn_Interface_ElseReadsNarrowed()
    {
        // A G#-declared interface (not a CLR import) so this also runs
        // under the interpreter, whose CLR-interface implementation
        // surface differs from the emitter's.
        var source = """
            interface IGreeter {
                func Greet() string
            }

            class Hello : IGreeter {
                var Name string
                func Greet() string { return "hi " + Name }
            }

            func DescribeOrDefault(g IGreeter?) string {
                if g == nil {
                    return "none"
                } else {
                    return g.Greet()
                }
            }

            var h IGreeter = Hello{Name: "Alice"}
            Console.WriteLine(DescribeOrDefault(h))
            Console.WriteLine(DescribeOrDefault(nil))
            """;

        Assert.Equal("hi Alice\nnone\n", RunSubmission(source));
    }

    [Fact]
    public void IfElse_BothBranchesReturn_NonNullableBaseline_NoNarrowing()
    {
        var source = """
            func Classify(n int32) int32 {
                if n > 0 {
                    return 1
                } else {
                    return -1
                }
            }

            Console.WriteLine(Classify(5))
            Console.WriteLine(Classify(-3))
            """;

        Assert.Equal("1\n-1\n", RunSubmission(source));
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
