// <copyright file="BareFormExtensionCallTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translator-fidelity tests for a SOURCE-defined extension method called through
/// its BARE name (the unqualified static form a sibling member inside the
/// declaring `static class` uses, e.g. `ApplicableState(book.Conversion)`).
/// It must be rewritten to the G# receiver-clause call
/// `book.Conversion.ApplicableState()` for the same reason as the qualified
/// `Owner.M(recv, args)` static form (issue #914): cs2gs lifts every non-enum
/// source extension of a `static class` to a top-level receiver-clause
/// `func (recv R) M[…](…)` (ADR-0115 §B.19), leaving no `Owner` type
/// behind — so the bare call would otherwise be qualified as
/// `Owner.M(...)` and fail to resolve (GS0157). Discovered migrating the Oahu
/// corpus (`EntityExtensions.ApplicableState`).
open class BareFormExtensionCallTranslationTests {
    @Fact
    func BareFormExtensionCall_RewrittenToReceiverForm() {
        // `Norm(s)` — a bare sibling extension call whose single argument is the
        // receiver — must become `s.Norm()`, never `Ext.Norm(s)`.
        let printed = Render(`
namespace Demo
{
    public static class Ext
    {
        public static string Norm(this string s) { return s.Trim(); }
        public static string NormOrEmpty(this string s) { return s.Length == 0 ? "" : Norm(s); }
    }
}`)
        Assert.Contains("s.Norm()", printed)
        Assert.DoesNotContain("Ext.Norm", printed)
    }

    @Fact
    func BareFormExtensionCall_WithTrailingArguments_KeepsThemAfterReceiver() {
        // The first argument is the receiver; the rest follow in the receiver call:
        // `Wrap(s, ""x"")` -> `s.Wrap(""x"")`.
        let printed = Render(`
namespace Demo
{
    public static class Ext
    {
        public static string Wrap(this string s, string suffix) { return s + suffix; }
        public static string WrapX(this string s) { return Wrap(s, "x"); }
    }
}`)
        Assert.Contains("s.Wrap(\"x\")", printed)
        Assert.DoesNotContain("Ext.Wrap", printed)
    }

    @Fact
    func BareFormGenericExtensionCall_RewrittenToReceiverForm_WithTypeArguments() {
        // A bare-form generic extension call `Cast<int>(o)` carries its type
        // arguments on the name; it must become `o.Cast[int32]()`.
        let printed = Render(`
namespace Demo
{
    public static class Ext
    {
        public static T Cast<T>(this object o) { return (T)o; }
        public static int CastInt(this object o) { return Cast<int>(o); }
    }
}`)
        Assert.Contains("o.Cast[int32]()", printed)
        Assert.DoesNotContain("Ext.Cast", printed)
    }

    shared {
        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
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
