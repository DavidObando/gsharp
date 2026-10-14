// <copyright file="Adr0161AssignmentExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// ADR-0161 / issue #3350: a C# assignment used in value position translates to
/// G#'s assignment EXPRESSION, emitted where C# put it.
///
/// The premise this replaces was that "G# assignment is statement-only" — stated
/// in the translator's own comments and in issue #3347. It was false. Because of
/// it, an assignment inside a short-circuited `&&` / `||` /
/// `??` operand — which genuinely cannot be hoisted into a preceding
/// statement, since its write must run only when that operand is evaluated — was
/// reported `Unsupported` and then <b>silently dropped</b> (issue #1723).
open class Adr0161AssignmentExpressionTranslationTests {
    /// The #1723 reproducer. Before ADR-0161 this emitted `if a && (5) > 0`
    /// — the write to `x` gone entirely — plus an Unsupported diagnostic.
    @Fact
    func ShortCircuitedAndOperand_PreservesTheWrite() {
        let (printed, context) = Translate(`
public sealed class C
{
    public void M(bool a)
    {
        int x = 0;
        if (a && (x = 5) > 0) { System.Console.WriteLine(x); }
    }
}`)
        Assert.Contains("(x = 5)", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context, printed)
    }

    @Fact
    func ShortCircuitedCoalesceOperand_PreservesTheWrite() {
        let (printed, context) = Translate(`
#nullable enable
public sealed class C
{
    public void M(string? s)
    {
        string? t = null;
        System.Console.WriteLine(s ?? (t = "fallback"));
    }
}`)
        Assert.Contains("(t = \"fallback\")", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context, printed)
    }

    /// A C# source-level paren around the assignment must not double up with the
    /// parentheses the assignment expression renders for itself.
    @Fact
    func SourceLevelParentheses_AreNotDoubled() {
        let (printed, _) = Translate(`
public sealed class C
{
    public void M(bool a)
    {
        int x = 0;
        if (a && (x = 5) > 0) { System.Console.WriteLine(x); }
    }
}`)
        Assert.DoesNotContain("((x = 5))", printed, StringComparison.Ordinal)
    }

    /// The assignment must stay INSIDE the short-circuited operand — hoisting it
    /// ahead of the condition would run the write unconditionally, which is the
    /// opposite error from dropping it.
    @Fact
    func ShortCircuitedWrite_IsNotHoistedAheadOfTheCondition() {
        let (printed, _) = Translate(`
public sealed class C
{
    public void M(bool a)
    {
        int x = 0;
        if (a && (x = 5) > 0) { System.Console.WriteLine(x); }
    }
}`)
        let conditionIndex = printed.IndexOf("if a &&", StringComparison.Ordinal)
        let writeIndex = printed.IndexOf("x = 5", StringComparison.Ordinal)
        Assert.True(conditionIndex >= 0, "Expected the `if` condition in:\n" + printed)
        Assert.True(
            writeIndex > conditionIndex,
            "The write must stay inside the short-circuited operand, not be hoisted:\n" + printed
        )
    }

    /// A conditional-access branch is short-circuited the same way and was
    /// covered by the same Unsupported report.
    @Fact
    func ConditionalAccessBranch_PreservesTheWrite() {
        let (printed, context) = Translate(`
#nullable enable
public sealed class Node { public int Value; }

public sealed class C
{
    public void M(Node? n)
    {
        int seen = 0;
        System.Console.WriteLine(n?.Value.ToString() ?? (seen = 1).ToString());
    }
}`)
        Assert.Contains("seen = 1", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context, printed)
    }

    /// A `??=` write is conditional on the target being nil and G# has no
    /// coalescing-assignment EXPRESSION, so it keeps its existing hoisting path
    /// rather than being emitted in place.
    @Fact
    func CoalesceAssignment_KeepsExistingLowering() {
        let (printed, _) = Translate(`
#nullable enable
public sealed class C
{
    public void M(string? s)
    {
        string? t = null;
        t ??= s;
        System.Console.WriteLine(t);
    }
}`)
        Assert.Contains("??=", printed, StringComparison.Ordinal)
    }

    shared {
        private func AssertNoUnsupported(context TranslationContext, printed string) {
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                    "1723"
                )
            )
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
        }

        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `using System;

namespace Demo
{
` + source + `
}
`)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (GSharpPrinter.Print(unit), context)
        }
    }
}
