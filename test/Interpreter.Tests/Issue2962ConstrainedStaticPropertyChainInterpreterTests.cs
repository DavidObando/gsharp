// <copyright file="Issue2962ConstrainedStaticPropertyChainInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2962: constrained static property values remain valid receivers for
/// member access in the interpreter.
/// </summary>
public class Issue2962ConstrainedStaticPropertyChainInterpreterTests
{
    [Fact]
    public void ChainedPropertyAccess_Evaluates()
    {
        const string Source = """
            import System

            sealed interface I[T] {
                shared { prop V T { get; } }
            }

            struct C : I[string] {
                shared { prop V string -> "value" }
            }

            func Read[T I[string]](w T) int32 {
                return T.V.Length
            }

            Console.WriteLine(Read(C{}))
            """;

        Assert.Equal("5\n", Evaluate(Source));
    }

    [Fact]
    public void NonMemberStaticSuffix_ReportsSourceTextInsteadOfIce()
    {
        const string Source = """
            sealed interface I[T] {
                shared { prop V T { get; } }
            }

            struct C : I[string] {
                shared { prop V string -> "value" }
            }

            func Read[T I[string]](w T) int32 {
                return T.sizeof(int32)
            }

            Read(C{})
            """;

        var output = RunSubmission(Source);
        Assert.Contains(
            "error GS0333: Constrained static access 'sizeof(int32)' on type parameter 'T' must name a static-virtual member declared by an interface constraint (ADR-0089).",
            output,
            StringComparison.Ordinal);
        Assert.DoesNotContain("GS9999", output, StringComparison.Ordinal);
        Assert.DoesNotContain("member '?'", output, StringComparison.Ordinal);
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));
        return result.Output.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string RunSubmission(string source)
    {
        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            new GSharpRepl().EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
