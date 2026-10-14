// <copyright file="Issue615EmittedSessionEnumArithmeticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #615: Emitted-session coverage for enum arithmetic.
open class Issue615EmittedSessionEnumArithmeticTests {
    // ───────────────────────────────────────────────────────────────────
    // §11.10 arithmetic: enum + underlying → enum
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func DayOfWeek_Plus_Int32_Produces_Enum() {
        let output = RunSubmission("import System\n" + "Console.WriteLine(DayOfWeek.Monday + int32(2))\n")
        Assert.Contains("Wednesday", output)
    }

    @Fact
    func Int32_Plus_DayOfWeek_Produces_Enum() {
        let output = RunSubmission("import System\n" + "Console.WriteLine(int32(2) + DayOfWeek.Monday)\n")
        Assert.Contains("Wednesday", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // §11.10 arithmetic: enum - underlying → enum
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func DayOfWeek_Minus_Int32_Produces_Enum() {
        let output = RunSubmission("import System\n" + "Console.WriteLine(DayOfWeek.Friday - int32(1))\n")
        Assert.Contains("Thursday", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // §11.10 arithmetic: enum - enum → underlying
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func DayOfWeek_Minus_DayOfWeek_Produces_Underlying() {
        let output = RunSubmission("import System\n" + "Console.WriteLine(DayOfWeek.Friday - DayOfWeek.Monday)\n")
        Assert.Contains("4", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // User-defined enum arithmetic
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func UserDefinedEnum_Plus_Int32() {
        let output = RunSubmission(
            "import System\n" +
                "enum Color {\n" +
                "    Red,\n" +
                "    Green,\n" +
                "    Blue,\n" +
                "}\n" +
                "var c = Color.Red + int32(2)\n" +
                "Console.WriteLine(c == Color.Blue)\n"
        )
        Assert.Contains("True", output)
    }

    @Fact
    func UserDefinedEnum_Minus_UserDefinedEnum() {
        let output = RunSubmission(
            "import System\n" +
                "enum Color {\n" +
                "    Red,\n" +
                "    Green,\n" +
                "    Blue,\n" +
                "}\n" +
                "Console.WriteLine(Color.Blue - Color.Red)\n"
        )
        Assert.Contains("2", output)
    }

    @Fact
    func Int32_Plus_UserDefinedEnum() {
        let output = RunSubmission(
            "import System\n" +
                "enum Color {\n" +
                "    Red,\n" +
                "    Green,\n" +
                "    Blue,\n" +
                "}\n" +
                "var c = int32(1) + Color.Red\n" +
                "Console.WriteLine(c == Color.Green)\n"
        )
        Assert.Contains("True", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // Bitwise: enum | enum → enum
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func DayOfWeek_BitwiseOr_Produces_Enum() {
        // DayOfWeek.Monday(1) | DayOfWeek.Tuesday(2) = 3 (Wednesday)
        let output = RunSubmission(
            "import System\n" + "var result = DayOfWeek.Monday | DayOfWeek.Tuesday\n" + "Console.WriteLine(result)\n"
        )
        Assert.Contains("Wednesday", output)
    }

    @Fact
    func DayOfWeek_BitwiseAnd_Produces_Enum() {
        // DayOfWeek.Wednesday(3) & DayOfWeek.Monday(1) = 1 (Monday)
        let output = RunSubmission(
            "import System\n" + "var result = DayOfWeek.Wednesday & DayOfWeek.Monday\n" + "Console.WriteLine(result)\n"
        )
        Assert.Contains("Monday", output)
    }

    @Fact
    func DayOfWeek_BitwiseXor_Produces_Enum() {
        // DayOfWeek.Wednesday(3) ^ DayOfWeek.Monday(1) = 2 (Tuesday)
        let output = RunSubmission(
            "import System\n" + "var result = DayOfWeek.Wednesday ^ DayOfWeek.Monday\n" + "Console.WriteLine(result)\n"
        )
        Assert.Contains("Tuesday", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // Unary: ~enum → enum
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func OnesComplement_DayOfWeek_Produces_Enum() {
        // ~DayOfWeek.Sunday(0) = all bits set = -1 as int backed enum
        let output = RunSubmission(
            "import System\n" + "var result = ~DayOfWeek.Sunday\n" + "Console.WriteLine(result)\n"
        )
        // -1 is not a named DayOfWeek member, so ToString() prints the numeric value
        Assert.Contains("-1", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // Comparison: enum == enum, enum < enum
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func DayOfWeek_Equality_Works() {
        let output = RunSubmission(
            "import System\n" +
                "Console.WriteLine(DayOfWeek.Monday == DayOfWeek.Monday)\n" +
                "Console.WriteLine(DayOfWeek.Monday == DayOfWeek.Friday)\n"
        )
        Assert.Contains("True", output)
        Assert.Contains("False", output)
    }

    @Fact
    func DayOfWeek_LessThan_Works() {
        let output = RunSubmission(
            "import System\n" +
                "Console.WriteLine(DayOfWeek.Monday < DayOfWeek.Friday)\n" +
                "Console.WriteLine(DayOfWeek.Friday < DayOfWeek.Monday)\n"
        )
        // First should be True, second should be False
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("True", lines[0].Trim())
        Assert.Equal("False", lines[1].Trim())
    }

    @Fact
    func DayOfWeek_GreaterThan_Works() {
        let output = RunSubmission("import System\n" + "Console.WriteLine(DayOfWeek.Friday > DayOfWeek.Monday)\n")
        Assert.Contains("True", output)
    }

    // ───────────────────────────────────────────────────────────────────
    // Lifted-nullable forms (§6.1): enum? + underlying? → enum?
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func LiftedNullable_EnumPlus_BothPresent() {
        let output = RunSubmission(
            "import System\n" +
                "var a System.DayOfWeek? = DayOfWeek.Monday\n" +
                "var b int32? = int32(2)\n" +
                "Console.WriteLine(a + b)\n"
        )
        Assert.Contains("Wednesday", output)
    }

    @Fact
    func LiftedNullable_EnumPlus_LeftNull() {
        let output = RunSubmission(
            "import System\n" +
                "var a System.DayOfWeek? = nil\n" +
                "var b int32? = int32(2)\n" +
                "Console.WriteLine(a + b)\n"
        )
        // nil arithmetic produces nil, which prints as empty string
        let trimmed = output.Trim()
        Assert.Equal(string.Empty, trimmed)
    }

    @Fact
    func LiftedNullable_EnumPlus_RightNull() {
        let output = RunSubmission(
            "import System\n" +
                "var a System.DayOfWeek? = DayOfWeek.Monday\n" +
                "var b int32? = nil\n" +
                "Console.WriteLine(a + b)\n"
        )
        let trimmed = output.Trim()
        Assert.Equal(string.Empty, trimmed)
    }

    @Fact
    func LiftedNullable_EnumMinus_BothPresent() {
        let output = RunSubmission(
            "import System\n" +
                "var a System.DayOfWeek? = DayOfWeek.Friday\n" +
                "var b System.DayOfWeek? = DayOfWeek.Monday\n" +
                "Console.WriteLine(a - b)\n"
        )
        Assert.Contains("4", output)
    }

    @Fact
    func LiftedNullable_EnumMinus_LeftNull() {
        let output = RunSubmission(
            "import System\n" +
                "var a System.DayOfWeek? = nil\n" +
                "var b System.DayOfWeek? = DayOfWeek.Monday\n" +
                "Console.WriteLine(a - b)\n"
        )
        let trimmed = output.Trim()
        Assert.Equal(string.Empty, trimmed)
    }

    // ───────────────────────────────────────────────────────────────────
    // Runtime type verification: confirm the result is actually
    // DayOfWeek (not a raw int) for imported CLR enums.
    // ───────────────────────────────────────────────────────────────────
    @Fact
    func EnumPlusUnderlying_ResultType_IsDayOfWeek() {
        // DayOfWeek.ToString() prints the named member; an int prints a number.
        // DayOfWeek.Monday + 2 should print "Wednesday" (not "3").
        let output = RunSubmission(
            "import System\n" + "var result = DayOfWeek.Monday + int32(2)\n" + "Console.WriteLine(result)\n"
        )
        Assert.Contains("Wednesday", output)
        Assert.DoesNotContain("3", output)
    }

    @Fact
    func EnumMinusUnderlying_ResultType_IsDayOfWeek() {
        let output = RunSubmission(
            "import System\n" + "var result = DayOfWeek.Friday - int32(1)\n" + "Console.WriteLine(result)\n"
        )
        Assert.Contains("Thursday", output)
        Assert.DoesNotContain("4", output)
    }

    @Fact
    func EnumMinusEnum_ResultType_IsUnderlying() {
        // enum - enum → underlying int (not an enum member name)
        let output = RunSubmission(
            "import System\n" + "var result = DayOfWeek.Friday - DayOfWeek.Monday\n" + "Console.WriteLine(result)\n"
        )
        Assert.Contains("4", output)
        Assert.DoesNotContain("Thursday", output)
    }

    shared {
        // ───────────────────────────────────────────────────────────────────
        // Helper
        // ───────────────────────────────────────────────────────────────────
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return outWriter.ToString() + errWriter.ToString()
        }
    }
}
