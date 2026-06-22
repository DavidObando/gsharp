// <copyright file="Issue752ElvisNullableValueTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #752 / ADR-0084 L3: interpreter parity for the null-coalescing (<c>??</c>)
/// operator over value-type <c>Nullable&lt;T&gt;</c> receivers. The
/// interpreter stores nullables as their underlying boxed payload (or
/// <c>null</c> when absent), so the existing <c>left ?? right</c> path
/// in <c>EvaluateBinaryExpression</c> handles both reference- and
/// value-typed nullables uniformly — these tests pin down the runtime
/// semantics so a future evaluator change cannot silently diverge from
/// the emitted IL behavior validated by
/// <c>Issue752ElvisNullableValueTypeEmitTests</c>.
/// </summary>
public class Issue752ElvisNullableValueTypeInterpreterTests
{
    [Fact]
    public void Elvis_NullableInt_LeftNil_ReturnsRightUnderlying()
    {
        var source = """
            let v int32? = nil
            let n = v ?? 0
            Console.WriteLine(n)
            """;

        Assert.Equal("0\n", RunSubmission(source));
    }

    [Fact]
    public void Elvis_NullableInt_LeftPresent_ReturnsLeftUnderlying()
    {
        var source = """
            let v int32? = 42
            let n = v ?? 0
            Console.WriteLine(n)
            """;

        Assert.Equal("42\n", RunSubmission(source));
    }

    [Fact]
    public void Elvis_NullableInt_Nested_MiddleHasValue_ChainsThroughInner()
    {
        var source = """
            let a int32? = nil
            let b int32? = 7
            let n = (a ?? b) ?? 0
            Console.WriteLine(n)
            """;

        Assert.Equal("7\n", RunSubmission(source));
    }

    [Fact]
    public void Elvis_NullableInt_Nested_AllNil_FallsThroughToLiteral()
    {
        var source = """
            let a int32? = nil
            let b int32? = nil
            let n = (a ?? b) ?? 0
            Console.WriteLine(n)
            """;

        Assert.Equal("0\n", RunSubmission(source));
    }

    [Fact]
    public void Elvis_NullableInt_BothArmsNullable_PreservesWrapperShape()
    {
        var source = """
            let a int32? = nil
            let b int32? = 99
            let r int32? = a ?? b
            Console.WriteLine(r!!)
            """;

        Assert.Equal("99\n", RunSubmission(source));
    }

    [Fact]
    public void Elvis_ReferenceTypeString_RegressionGuard()
    {
        var source = """
            let s string? = nil
            let r string = s ?? "missing"
            Console.WriteLine(r)

            let t string? = "hello"
            let u string = t ?? "missing"
            Console.WriteLine(u)
            """;

        Assert.Equal("missing\nhello\n", RunSubmission(source));
    }

    [Fact]
    public void Elvis_NullableInt_ReceiverOfInstanceCall_Interpreted()
    {
        var source = """
            let v int32? = 42
            Console.WriteLine((v ?? -1).ToString())

            let w int32? = nil
            Console.WriteLine((w ?? -1).ToString())
            """;

        Assert.Equal("42\n-1\n", RunSubmission(source));
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
