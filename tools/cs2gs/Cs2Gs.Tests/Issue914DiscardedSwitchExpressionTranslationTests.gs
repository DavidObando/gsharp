// <copyright file="Issue914DiscardedSwitchExpressionTranslationTests.cs" company="GSharp">
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

/// Issue #914: a C# switch EXPRESSION used in statement position (a discard
/// `_ = x switch { ... };`, or any other expression-statement) was
/// translated as a G# switch-EXPRESSION with `case P: expr` arms emitted
/// at statement position. That arm form is only valid in value position; at
/// statement position G# parses a switch STATEMENT, whose arms require a
/// `case P { block }` body, so the emitted G# failed to round-trip
/// (GS0005 "Unexpected token ColonToken, expected OpenBraceToken").
///
/// The fix lowers such a discarded switch expression into a genuine G# switch
/// STATEMENT, running each arm's expression for its side effect.
open class Issue914DiscardedSwitchExpressionTranslationTests {
    /// The dominant Oahu shape: a discarded switch expression whose arms are
    /// side-effecting method calls, with a value-only `_ => false`
    /// default. It must round-trip (the helper asserts that) as a switch
    /// STATEMENT, not a bare colon-arm expression at statement position.
    @Fact
    func DiscardedSwitchExpression_WithSideEffectingArms_LowersToSwitchStatement() {
        let printed = TranslateUnit(Prelude + `
    public static class Ops
    {
        private static bool Check(EState s) => true;

        public static void Run(EState state)
        {
            _ = state switch
            {
                EState.LocalLocked => Check(state),
                EState.LocalUnlocked => Check(state),
                EState.Exported => Check(state),
                EState.Converted => Check(state),
                _ => false
            };
        }
    }
}`)
        // Lowered to a switch STATEMENT: arms carry brace bodies, never a bare
        // `case ...:` colon arm at statement position.
        Assert.Contains("switch state", printed)
        Assert.Contains("Check(state)", printed)
        Assert.DoesNotContain("_ =", printed)
    }

    /// A discarded switch expression with no total (`_`/`var`/default)
    /// arm is exhaustive in C# by its type arms; the lowering must still
    /// round-trip by synthesizing a throwing default (mirroring C#'s runtime
    /// `SwitchExpressionException`), so gsc's total-arm rule is satisfied.
    @Fact
    func DiscardedSwitchExpression_NonTotalArms_SynthesizesThrowingDefault() {
        let printed = TranslateUnit(Prelude + `
    public static class Ops
    {
        private static bool Check(EState s) => true;

        public static void Run(bool flag)
        {
            _ = flag switch
            {
                true => Check(EState.Exported),
                false => Check(EState.Converted)
            };
        }
    }
}`)
        Assert.Contains("switch flag", printed)
        Assert.Contains("default", printed)
    }

    shared {
        private const Prelude string = `
namespace Demo
{
    public enum EState { LocalLocked, LocalUnlocked, Exported, Converted }
`

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
