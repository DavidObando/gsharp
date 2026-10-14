// <copyright file="L5ConstructTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translation tests for the new C# surface area exercised by the L5-Console
/// corpus app (ADR-0115 §E/§G): a `switch` statement over type patterns, a
/// `yield return` iterator (with the `IEnumerable<T>` return
/// type rewritten to `sequence[T]`), and the two faithfulness fixes the L5
/// pipeline surfaced — an integer literal that C# implicitly promotes to a
/// floating-point parameter is emitted as a float literal, and a parameterless
/// constructor that initializes a property keeps its explicit `init` body
/// (G# has no property member initializer).
open class L5ConstructTranslationTests {
    /// A C# `switch` statement over type patterns is emitted as the
    /// canonical G# `switch subj { case P { … } default { … } }` statement
    /// form (PatternSwitch.gs), with the per-section `break;` dropped.
    @Fact
    func SwitchStatement_OverTypePatterns_EmittedAsSwitchBlock() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(object shape)
        {
            switch (shape)
            {
                case string s:
                    return "text";
                default:
                    return "other";
            }
        }
    }
}`)
        Assert.Contains("switch shape {", printed)
        Assert.Contains("case s is string {", printed)
        Assert.Contains("default {", printed)
        Assert.DoesNotContain("break", printed)
    }

    /// Issue #991: a C# `when` guard on a switch-statement case is now
    /// translated to the canonical G# `case <pattern> when <bool> { … }`
    /// form instead of being reported as unsupported.
    @Fact
    func SwitchStatement_WhenGuard_EmittedAsGuardedCase() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(int n)
        {
            switch (n)
            {
                case > 0 when n < 10:
                    return "small";
                default:
                    return "other";
            }
        }
    }
}`)
        Assert.Contains("case > 0 when n < 10 {", printed)
        Assert.DoesNotContain("when' guard has no canonical", printed)
    }

    /// Issue #991: a C# `when` guard on a switch-expression arm is now
    /// translated to the canonical G# `case <pattern> when <bool>: …`
    /// form.
    @Fact
    func SwitchExpression_WhenGuard_EmittedAsGuardedArm() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(int n) => n switch
        {
            > 0 when n < 10 => "small",
            > 0 => "big",
            _ => "other",
        };
    }
}`)
        Assert.Contains("case > 0 when n < 10:", printed)
    }

    /// Issue #992: C# `and` / `or` / `not` pattern combinators are
    /// translated to the canonical G# `and` / `or` / `not` forms.
    @Fact
    func SwitchExpression_AndOrNotPatterns_EmittedAsCombinators() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Shapes
    {
        public static string Kind(int n) => n switch
        {
            > 0 and < 10 => "small-positive",
            < 0 or > 100 => "extreme",
            not > 0 => "nonpositive",
            _ => "other",
        };
    }
}`)
        Assert.Contains("case > 0 and < 10:", printed)
        Assert.Contains("case < 0 or > 100:", printed)
        Assert.Contains("case not > 0:", printed)
        Assert.DoesNotContain("has no canonical G# form", printed)
    }

    /// A C# iterator method (`yield return`) returning
    /// `IEnumerable<string>` is emitted with the return type rewritten
    /// to `sequence[string]` and a bare `yield expr` body
    /// (TupleSequenceIterators.gs).
    @Fact
    func Iterator_YieldReturn_EmitsSequenceReturnAndYield() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;

    public static class Source
    {
        public static IEnumerable<string> Names()
        {
            yield return "a";
            yield return "b";
        }
    }
}`)
        Assert.Contains("sequence[string]", printed)
        Assert.Contains("yield \"a\"", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("IEnumerable", printed)
    }

    /// A C# integer literal argument that the semantic model implicitly promotes
    /// to a floating-point parameter is emitted as a float literal (e.g.
    /// `30` → `30.0`). G# performs no implicit numeric promotion, so a
    /// bare `int32` push to a `float64` parameter would yield invalid
    /// IL (ilverify StackUnexpected). ADR-0115 §B.12.
    @Fact
    func IntegerLiteral_ImplicitlyPromotedToDouble_EmittedAsFloatLiteral() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Calc
    {
        public static double Scale(double factor) => factor * 2.0;

        public static double Run() => Scale(30);
    }
}`)
        Assert.Contains("Scale(30.0)", printed)
        Assert.DoesNotContain("Scale(30)", printed)
    }

    /// The int-to-float promotion in (cref:TranslateLiteral) must derive
    /// the emitted float text from the literal's bound *value*, not its raw
    /// token spelling — appending ".0" to the spelling mangles hex (`0xFF` →
    /// `0xFF.0`, a parse error), silently misses hex spellings that already
    /// contain an 'E' digit (`0xAE`), and leaves integer suffixes in place
    /// (`30L` → `30L.0`, a parse error). Binary literals and digit separators
    /// must promote correctly too, and an already-float argument must never be
    /// promoted twice (Issue #1740).
    @Theory
    @InlineData("0xFF", "255.0")
    @InlineData("0xAE", "174.0")
    @InlineData("30L", "30.0")
    @InlineData("0b1010", "10.0")
    @InlineData("1_000", "1000.0")
    @InlineData("30", "30.0")
    func IntegerLiteralSpellings_PromotedToDouble_EmitAsValidFloatLiteral(
        literalSpelling string,
        expectedFloatText string
    ) {
        let printed = TranslateUnit((`
namespace Demo
{
    public static class Calc
    {
        public static double Scale(double factor) => factor * 2.0;

        public static double Run() => Scale(` + "$literalSpelling" + `);
    }
}`))
        Assert.Contains("Scale($expectedFloatText)", printed)
    }

    /// A C# literal that is already floating-point (e.g. `2.0`) must be
    /// passed through unchanged when its target parameter is also
    /// floating-point — the promotion path only applies to integral literals,
    /// so it must never double-promote or otherwise rewrite an already-float
    /// spelling (Issue #1740).
    @Fact
    func FloatLiteral_PassedToDoubleParameter_IsNotDoublePromoted() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Calc
    {
        public static double Scale(double factor) => factor * 2.0;

        public static double Run() => Scale(2.0);
    }
}`)
        Assert.Contains("Scale(2.0)", printed)
        Assert.DoesNotContain("Scale(2.0.0)", printed)
    }

    /// A parameterless constructor that assigns a constant to a property keeps
    /// its explicit `init()` body — G# accepts a field member initializer
    /// (`var Name T = expr`) but rejects a property member initializer
    /// (`prop Name T = expr`), so the assignment must stay in the
    /// constructor (ADR-0115 §B.3).
    @Fact
    func ParameterlessConstructor_InitializingProperty_KeepsExplicitInit() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Label
    {
        public string Text { get; set; }

        public Label()
        {
            Text = "empty";
        }
    }
}`)
        Assert.Contains("init() {", printed)
        Assert.Contains("Text = \"empty\"", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
