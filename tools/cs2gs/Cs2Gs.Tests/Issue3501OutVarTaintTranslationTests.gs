// <copyright file="Issue3501OutVarTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #3501 (Translator burn-down, GS0154 family): an `out`/`ref`
/// argument flows the OPPOSITE way through a call — the callee writes the
/// parameter's value into the caller's variable. The oblivious taint analysis
/// only modeled argument→parameter edges, so a Try-pattern out parameter that
/// can be assigned null (`bool TryGet(..., out T value)` assigning an
/// `as`-cast) rendered `T?` while the caller's out-var local stayed
/// untainted; gsc independently infers the out-var's type from the promoted
/// parameter (`T?`), so downstream reads passed a `T?` where the
/// translator believed a `T` flowed and never bridged with `!!`.
/// The parameter→receiver back-edge closes the gap.
open class Issue3501OutVarTaintTranslationTests {
    @Fact
    func Oblivious_TryPatternOutVar_TaintsReceiverAndBridgesUse() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public bool TryPick(object value, out string picked)
        {
            picked = value as string;
            return picked != null;
        }

        public int Consume(string exact) { return exact.Length; }

        public int Run(object value)
        {
            if (this.TryPick(value, out var picked))
            {
                return this.Consume(picked);
            }

            return 0;
        }
    }
}`)
        // The out parameter itself is tainted (assigned an `as`-cast)...
        Assert.Contains("out picked string?", printed)
        // ...and the receiving out-var local now inherits that taint, which the
        // fixpoint carries onward through the argument edge into `Consume`'s
        // parameter — the whole chain agrees on `string?` and the read needs no
        // call-site bridge. (Before the back-edge, the local stayed untainted,
        // `Consume` kept `string`, and gsc rejected the `T? -> T` argument.)
        Assert.Contains("func Consume(exact string?)", printed)
        Assert.Contains("Consume(picked)", printed)
    }

    @Fact
    func Oblivious_NonNullOutVar_StaysBare() {
        // The out parameter is always assigned a non-null value, so neither the
        // parameter nor the receiving local is promoted and no `!!` appears.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public bool TryPick(object value, out string picked)
        {
            picked = "fixed";
            return true;
        }

        public int Consume(string exact) { return exact.Length; }

        public int Run(object value)
        {
            if (this.TryPick(value, out var picked))
            {
                return this.Consume(picked);
            }

            return 0;
        }
    }
}`)
        Assert.Contains("out picked string)", printed)
        Assert.Contains("Consume(picked)", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
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
