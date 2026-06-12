// <copyright file="Issue615InterpreterEnumArithmeticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #615: interpreter parity for C# §11.10 enum arithmetic.
/// Mirrors the emit-side test cases from Issue6_6EnumArithmeticEmitTests and
/// Issue6_6EnumLiftedNullableArithmeticEmitTests, verifying that the interpreter
/// produces correctly-typed enum values (not raw integers) for:
///   enum + underlying → enum
///   underlying + enum → enum
///   enum - underlying → enum
///   enum - enum → underlying
///   enum | enum → enum (bitwise)
///   ~enum → enum (unary)
///   enum == enum, enum &lt; enum (comparison)
///   lifted nullable forms (§6.1)
/// </summary>
public class Issue615InterpreterEnumArithmeticTests
{
    // ───────────────────────────────────────────────────────────────────
    // §11.10 arithmetic: enum + underlying → enum
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void DayOfWeek_Plus_Int32_Produces_Enum()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(DayOfWeek.Monday + int32(2))\n");
        Assert.Contains("Wednesday", output);
    }

    [Fact]
    public void Int32_Plus_DayOfWeek_Produces_Enum()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(int32(2) + DayOfWeek.Monday)\n");
        Assert.Contains("Wednesday", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // §11.10 arithmetic: enum - underlying → enum
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void DayOfWeek_Minus_Int32_Produces_Enum()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(DayOfWeek.Friday - int32(1))\n");
        Assert.Contains("Thursday", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // §11.10 arithmetic: enum - enum → underlying
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void DayOfWeek_Minus_DayOfWeek_Produces_Underlying()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(DayOfWeek.Friday - DayOfWeek.Monday)\n");
        Assert.Contains("4", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // User-defined enum arithmetic
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void UserDefinedEnum_Plus_Int32()
    {
        var output = RunSubmission(
            "import System\n" +
            "enum Color {\n" +
            "    Red,\n" +
            "    Green,\n" +
            "    Blue,\n" +
            "}\n" +
            "var c = Color.Red + int32(2)\n" +
            "Console.WriteLine(c == Color.Blue)\n");
        Assert.Contains("True", output);
    }

    [Fact]
    public void UserDefinedEnum_Minus_UserDefinedEnum()
    {
        var output = RunSubmission(
            "import System\n" +
            "enum Color {\n" +
            "    Red,\n" +
            "    Green,\n" +
            "    Blue,\n" +
            "}\n" +
            "Console.WriteLine(Color.Blue - Color.Red)\n");
        Assert.Contains("2", output);
    }

    [Fact]
    public void Int32_Plus_UserDefinedEnum()
    {
        var output = RunSubmission(
            "import System\n" +
            "enum Color {\n" +
            "    Red,\n" +
            "    Green,\n" +
            "    Blue,\n" +
            "}\n" +
            "var c = int32(1) + Color.Red\n" +
            "Console.WriteLine(c == Color.Green)\n");
        Assert.Contains("True", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // Bitwise: enum | enum → enum
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void DayOfWeek_BitwiseOr_Produces_Enum()
    {
        // DayOfWeek.Monday(1) | DayOfWeek.Tuesday(2) = 3 (Wednesday)
        var output = RunSubmission(
            "import System\n" +
            "var result = DayOfWeek.Monday | DayOfWeek.Tuesday\n" +
            "Console.WriteLine(result)\n");
        Assert.Contains("Wednesday", output);
    }

    [Fact]
    public void DayOfWeek_BitwiseAnd_Produces_Enum()
    {
        // DayOfWeek.Wednesday(3) & DayOfWeek.Monday(1) = 1 (Monday)
        var output = RunSubmission(
            "import System\n" +
            "var result = DayOfWeek.Wednesday & DayOfWeek.Monday\n" +
            "Console.WriteLine(result)\n");
        Assert.Contains("Monday", output);
    }

    [Fact]
    public void DayOfWeek_BitwiseXor_Produces_Enum()
    {
        // DayOfWeek.Wednesday(3) ^ DayOfWeek.Monday(1) = 2 (Tuesday)
        var output = RunSubmission(
            "import System\n" +
            "var result = DayOfWeek.Wednesday ^ DayOfWeek.Monday\n" +
            "Console.WriteLine(result)\n");
        Assert.Contains("Tuesday", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // Unary: ~enum → enum
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void OnesComplement_DayOfWeek_Produces_Enum()
    {
        // ~DayOfWeek.Sunday(0) = all bits set = -1 as int backed enum
        var output = RunSubmission(
            "import System\n" +
            "var result = ^DayOfWeek.Sunday\n" +
            "Console.WriteLine(result)\n");
        // -1 is not a named DayOfWeek member, so ToString() prints the numeric value
        Assert.Contains("-1", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // Comparison: enum == enum, enum < enum
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void DayOfWeek_Equality_Works()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(DayOfWeek.Monday == DayOfWeek.Monday)\n" +
            "Console.WriteLine(DayOfWeek.Monday == DayOfWeek.Friday)\n");
        Assert.Contains("True", output);
        Assert.Contains("False", output);
    }

    [Fact]
    public void DayOfWeek_LessThan_Works()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(DayOfWeek.Monday < DayOfWeek.Friday)\n" +
            "Console.WriteLine(DayOfWeek.Friday < DayOfWeek.Monday)\n");
        // First should be True, second should be False
        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("True", lines[0].Trim());
        Assert.Equal("False", lines[1].Trim());
    }

    [Fact]
    public void DayOfWeek_GreaterThan_Works()
    {
        var output = RunSubmission(
            "import System\n" +
            "Console.WriteLine(DayOfWeek.Friday > DayOfWeek.Monday)\n");
        Assert.Contains("True", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // Lifted-nullable forms (§6.1): enum? + underlying? → enum?
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void LiftedNullable_EnumPlus_BothPresent()
    {
        var output = RunSubmission(
            "import System\n" +
            "var a System.DayOfWeek? = DayOfWeek.Monday\n" +
            "var b int32? = int32(2)\n" +
            "Console.WriteLine(a + b)\n");
        Assert.Contains("Wednesday", output);
    }

    [Fact]
    public void LiftedNullable_EnumPlus_LeftNull()
    {
        var output = RunSubmission(
            "import System\n" +
            "var a System.DayOfWeek? = nil\n" +
            "var b int32? = int32(2)\n" +
            "Console.WriteLine(a + b)\n");
        // nil arithmetic produces nil, which prints as empty string
        var trimmed = output.Trim();
        Assert.Equal(string.Empty, trimmed);
    }

    [Fact]
    public void LiftedNullable_EnumPlus_RightNull()
    {
        var output = RunSubmission(
            "import System\n" +
            "var a System.DayOfWeek? = DayOfWeek.Monday\n" +
            "var b int32? = nil\n" +
            "Console.WriteLine(a + b)\n");
        var trimmed = output.Trim();
        Assert.Equal(string.Empty, trimmed);
    }

    [Fact]
    public void LiftedNullable_EnumMinus_BothPresent()
    {
        var output = RunSubmission(
            "import System\n" +
            "var a System.DayOfWeek? = DayOfWeek.Friday\n" +
            "var b System.DayOfWeek? = DayOfWeek.Monday\n" +
            "Console.WriteLine(a - b)\n");
        Assert.Contains("4", output);
    }

    [Fact]
    public void LiftedNullable_EnumMinus_LeftNull()
    {
        var output = RunSubmission(
            "import System\n" +
            "var a System.DayOfWeek? = nil\n" +
            "var b System.DayOfWeek? = DayOfWeek.Monday\n" +
            "Console.WriteLine(a - b)\n");
        var trimmed = output.Trim();
        Assert.Equal(string.Empty, trimmed);
    }

    // ───────────────────────────────────────────────────────────────────
    // Runtime type verification: confirm the result is actually
    // DayOfWeek (not a raw int) for imported CLR enums.
    // ───────────────────────────────────────────────────────────────────

    [Fact]
    public void EnumPlusUnderlying_ResultType_IsDayOfWeek()
    {
        // DayOfWeek.ToString() prints the named member; an int prints a number.
        // DayOfWeek.Monday + 2 should print "Wednesday" (not "3").
        var output = RunSubmission(
            "import System\n" +
            "var result = DayOfWeek.Monday + int32(2)\n" +
            "Console.WriteLine(result)\n");
        Assert.Contains("Wednesday", output);
        Assert.DoesNotContain("3", output);
    }

    [Fact]
    public void EnumMinusUnderlying_ResultType_IsDayOfWeek()
    {
        var output = RunSubmission(
            "import System\n" +
            "var result = DayOfWeek.Friday - int32(1)\n" +
            "Console.WriteLine(result)\n");
        Assert.Contains("Thursday", output);
        Assert.DoesNotContain("4", output);
    }

    [Fact]
    public void EnumMinusEnum_ResultType_IsUnderlying()
    {
        // enum - enum → underlying int (not an enum member name)
        var output = RunSubmission(
            "import System\n" +
            "var result = DayOfWeek.Friday - DayOfWeek.Monday\n" +
            "Console.WriteLine(result)\n");
        Assert.Contains("4", output);
        Assert.DoesNotContain("Thursday", output);
    }

    // ───────────────────────────────────────────────────────────────────
    // Helper
    // ───────────────────────────────────────────────────────────────────

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return outWriter.ToString() + errWriter.ToString();
    }
}
