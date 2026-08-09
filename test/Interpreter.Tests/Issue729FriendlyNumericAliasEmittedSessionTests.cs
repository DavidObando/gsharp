// <copyright file="Issue729FriendlyNumericAliasEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #729: Emitted-session coverage for friendly numeric alias.
/// Traceability: ADR-0098.
/// </summary>
public class Issue729FriendlyNumericAliasEmittedSessionTests
{
    public static IEnumerable<object[]> AliasCases => new[]
    {
        new object[] { "int", "int32", "42", "42" },
        new object[] { "uint", "uint32", "uint32(42)", "uint32(42)" },
        new object[] { "long", "int64", "42L", "42L" },
        new object[] { "ulong", "uint64", "42UL", "42UL" },
        new object[] { "short", "int16", "int16(42)", "int16(42)" },
        new object[] { "ushort", "uint16", "uint16(42)", "uint16(42)" },
        new object[] { "byte", "uint8", "uint8(42)", "uint8(42)" },
        new object[] { "sbyte", "int8", "int8(42)", "int8(42)" },
        new object[] { "float", "float32", "1.5F", "1.5F" },
        new object[] { "double", "float64", "1.5", "1.5" },
    };

    [Theory]
    [MemberData(nameof(AliasCases))]
    public void Alias_AndCanonical_ProduceSameOutput(string alias, string canonical, string aliasLiteral, string canonicalLiteral)
    {
        var aliasSource = $@"
func pair(x {alias}, y {alias}) {alias} {{ return x + y }}
Console.WriteLine(pair({aliasLiteral}, {aliasLiteral}))
";
        var canonicalSource = $@"
func pair(x {canonical}, y {canonical}) {canonical} {{ return x + y }}
Console.WriteLine(pair({canonicalLiteral}, {canonicalLiteral}))
";

        Assert.Equal(RunSubmission(canonicalSource), RunSubmission(aliasSource));
    }

    [Fact]
    public void Mixed_AliasAndCanonical_Interoperate()
    {
        // Sanity check that calling a canonically-typed function from an
        // alias-typed wrapper (and storing the result back into a
        // canonical-typed variable) works end-to-end through the REPL.
        const string source = @"
func sumCanonical(a int32, b int32) int32 { return a + b }
func sumAlias(a int, b int) int { return sumCanonical(a, b) }

let x int = sumCanonical(2, 3)
let y int32 = sumAlias(x, 4)
Console.WriteLine(y)
";

        Assert.Equal($"9{Environment.NewLine}", RunSubmission(source));
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

        return outWriter.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
