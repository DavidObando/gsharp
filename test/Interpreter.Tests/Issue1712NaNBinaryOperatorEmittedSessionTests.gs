// <copyright file="Issue1712NaNBinaryOperatorEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1712: Emitted-session coverage for na n binary operator.
/// Traceability: issues #1653 and #421.
open class Issue1712NaNBinaryOperatorEmittedSessionTests {
    @Fact
    func Double_NaN_AllOrderedComparisons_AreFalse() {
        let output = RunSubmission(`let nan = 0.0 / 0.0
let one = 1.0
Console.WriteLine(nan < one)
Console.WriteLine(one < nan)
Console.WriteLine(nan <= one)
Console.WriteLine(one <= nan)
Console.WriteLine(nan > one)
Console.WriteLine(one > nan)
Console.WriteLine(nan >= one)
Console.WriteLine(one >= nan)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func Float32_NaN_AllOrderedComparisons_AreFalse() {
        let output = RunSubmission(`let nan = float32(0.0 / 0.0)
let one = float32(1.0)
Console.WriteLine(nan < one)
Console.WriteLine(one < nan)
Console.WriteLine(nan <= one)
Console.WriteLine(one <= nan)
Console.WriteLine(nan > one)
Console.WriteLine(one > nan)
Console.WriteLine(nan >= one)
Console.WriteLine(one >= nan)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func Double_NaN_Equality_AlreadyCorrect() {
        // Regression guard: NaN == NaN is false, NaN != NaN is true — these
        // don't go through NumericCompare and were already correct.
        let output = RunSubmission(`let nan = 0.0 / 0.0
Console.WriteLine(nan == nan)
Console.WriteLine(nan != nan)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func Double_NormalOrdering_StillWorks() {
        // Non-NaN comparisons must be unaffected by the guard.
        let output = RunSubmission(`let a = 1.5
let b = 2.5
Console.WriteLine(a < b)
Console.WriteLine(b < a)
Console.WriteLine(a <= a)
Console.WriteLine(b >= a)
Console.WriteLine(a > b)
Console.WriteLine(b > a)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func Int_And_Decimal_Ordering_Unaffected() {
        // Non-floating-point relational comparisons must not be affected by
        // the NaN guard (IsNaN returns false for non-float/double operands).
        let output = RunSubmission(`let i1 = 3
let i2 = 5
let d1 = 3.0m
let d2 = 5.0m
Console.WriteLine(i1 < i2)
Console.WriteLine(i2 <= i1)
Console.WriteLine(d1 < d2)
Console.WriteLine(d2 >= d1)`)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}
