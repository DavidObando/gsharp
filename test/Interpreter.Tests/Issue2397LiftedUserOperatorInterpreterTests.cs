// <copyright file="Issue2397LiftedUserOperatorInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2397: evaluator coverage for nullable-lifted equality operators
/// declared on a same-compilation struct.
/// </summary>
public class Issue2397LiftedUserOperatorInterpreterTests
{
    [Fact]
    public void LiftedEqualityAndInequality_UseOperatorForValuesAndBuiltInNullSemantics()
    {
        const string source = """
            import System

            struct Score {
                var Rank int32
            }

            func (left Score) operator ==(right Score) bool {
                return left.Rank / 10 == right.Rank / 10
            }

            func (left Score) operator !=(right Score) bool {
                return left.Rank / 10 != right.Rank / 10
            }

            let seven Score? = Score{Rank: 7}
            let eight Score? = Score{Rank: 8}
            let twelve Score? = Score{Rank: 12}
            let missing Score? = nil

            Console.WriteLine(seven == eight)
            Console.WriteLine(seven == twelve)
            Console.WriteLine(seven == missing)
            Console.WriteLine(missing == seven)
            Console.WriteLine(missing == missing)
            Console.WriteLine(seven != eight)
            Console.WriteLine(seven != twelve)
            Console.WriteLine(seven != missing)
            Console.WriteLine(missing != seven)
            Console.WriteLine(missing != missing)
            """;

        Assert.Equal(
            """
            True
            False
            False
            False
            True
            False
            True
            True
            True
            False

            """,
            RunSubmission(source));
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        TextWriter previous = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(previous);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
