// <copyright file="Issue805MapTypeClauseSpellingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #805 / ADR-0104 — interpreter parity for the canonical
/// <c>map[K,V]</c> spelling. Mirrors the emit-side coverage so the two
/// execution backends behave identically against the migrated surface
/// syntax.
/// </summary>
public class Issue805MapTypeClauseSpellingInterpreterTests
{
    [Fact]
    public void CanonicalSpelling_InferredLocal_RunsInRepl()
    {
        var source = """
            var m = map[string,int32]{"a": 1}
            Console.WriteLine(m["a"])
            """;
        var output = RunSubmission(source);
        Assert.Contains("1", output);
    }

    [Fact]
    public void CanonicalSpelling_ExplicitTypedLocal_RunsInRepl()
    {
        var source = """
            var m map[string,int32] = map[string,int32]{"a": 1, "b": 2}
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;
        var output = RunSubmission(source);
        Assert.Contains("1", output);
        Assert.Contains("2", output);
    }

    [Fact]
    public void CanonicalSpelling_FunctionReturnAndParameter_RunsInRepl()
    {
        var source = """
            func makeIndex() map[string,int32] {
                return map[string,int32]{"a": 1, "b": 2}
            }
            func first(m map[string,int32]) int32 {
                return m["a"]
            }
            Console.WriteLine(first(makeIndex()))
            """;
        var output = RunSubmission(source);
        Assert.Contains("1", output);
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

        return outWriter.ToString();
    }
}
