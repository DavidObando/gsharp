// <copyright file="Issue914StaticFormExtensionCallTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translator-fidelity tests for issue #914: a SOURCE-defined extension method
/// called in STATIC (unreduced) form `Owner.M<T>(recv, args)` must be
/// rewritten to the G# receiver-clause call `recv.M[T](args)`. cs2gs lifts
/// every source extension of a `static class` to a top-level
/// receiver-clause `func (recv R) M[…](…)` (ADR-0115 §B.19), which gsc
/// invokes only through the receiver form; the static-form call site would
/// otherwise resolve to a non-existent static member (GS0158). The reduced
/// instance form already binds directly and is unaffected.
open class Issue914StaticFormExtensionCallTranslationTests {
    @Fact
    func StaticFormExtensionCall_RewrittenToReceiverForm() {
        // `JsonLike.FromFile<T>(path)` — static-form generic call whose first
        // argument is the extension receiver — must become `path.FromFile[T]()`.
        let printed = Render(`
namespace Demo
{
    public static class JsonLike
    {
        public static T FromFile<T>(this string path) where T : class, new() { return new T(); }
    }

    public class Consumer
    {
        public T Load<T>(string path) where T : class, new()
        {
            return JsonLike.FromFile<T>(path);
        }
    }
}`)
        Assert.Contains("path.FromFile[T]()", printed)
        Assert.DoesNotContain("JsonLike.FromFile", printed)
    }

    @Fact
    func StaticFormExtensionCall_WithTrailingArguments_KeepsThemAfterReceiver() {
        // The first argument is the receiver; the rest follow in the receiver call:
        // `StringExt.Repeat(s, 3)` -> `s.Repeat(3)`.
        let printed = Render(`
namespace Demo
{
    public static class StringExt
    {
        public static string Repeat(this string s, int n) { return s; }
    }

    public class Consumer
    {
        public string Run(string s)
        {
            return StringExt.Repeat(s, 3);
        }
    }
}`)
        Assert.Contains("s.Repeat(3)", printed)
        Assert.DoesNotContain("StringExt.Repeat", printed)
    }

    @Fact
    func InstanceFormExtensionCall_Unchanged() {
        // The reduced instance form already binds to the receiver-clause func and
        // must be left exactly as-is (`s.Repeat(3)`), never re-qualified.
        let printed = Render(`
namespace Demo
{
    public static class StringExt
    {
        public static string Repeat(this string s, int n) { return s; }
    }

    public class Consumer
    {
        public string Run(string s)
        {
            return s.Repeat(3);
        }
    }
}`)
        Assert.Contains("s.Repeat(3)", printed)
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
