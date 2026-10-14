// <copyright file="Issue3360SpillTrivialityGuardTests.cs" company="GSharp">
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

/// Issue #3360: two sites emitted a `__spillN` temp directly instead of
/// going through `SpillOperand`, so they bypassed its
/// `IsTrivialOperand` check and spilled even a bare
/// local/parameter/`this`/literal — which is safe to duplicate and needs no
/// temp at all.
///
/// `CaptureMethodGroupReceiver` uses the same triviality gate only after
/// proving the receiver symbol stable; reassigned locals still spill to
/// preserve C# method-group capture timing (issue #3357 follow-up).
///
/// Issue #3347 later removes the remaining value-type guard spill by emitting
/// native typed `if let`, and ADR-0166 (issue #3409) turns an unmodified
/// binder into a native pattern variable (`if x is T t { }`), so the hoist
/// under test is now only reached for a binder the body reassigns.
open class Issue3360SpillTrivialityGuardTests {
    /// `BuildPositiveValueGuardHoist`: the scrutinee is read twice — by the
    /// `is` guard and by the narrowing conversion — but a bare parameter is
    /// safe to duplicate.
    @Fact
    func ValueTypeGuard_TrivialScrutinee_EmitsNoSpill() {
        // ADR-0166 / issue #3409: the binder is reassigned in the body, so the
        // (let-immutable) native pattern variable path declines and the
        // positive value-guard hoist under test is still the lowering taken.
        let printed = Translate(`
public sealed class C
{
    public void M(object o)
    {
        if (o is int i) { i = i + 1; System.Console.WriteLine(i); }
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("var i int32", printed, StringComparison.Ordinal)
        Assert.Contains("if o is int32", printed, StringComparison.Ordinal)
        Assert.Contains("i = int32(o)", printed, StringComparison.Ordinal)
    }

    /// A non-trivial scrutinee must be evaluated exactly once. ADR-0166 / issue
    /// #3409: an unmodified binder is a native pattern variable, which reads the
    /// scrutinee once by construction — no spill, no `if let`.
    @Fact
    func ValueTypeGuard_NonTrivialScrutinee_UsesNativePatternVariable() {
        let printed = Translate(`
public sealed class C
{
    private static object Get() { return 1; }

    public void M()
    {
        if (Get() is int i) { System.Console.WriteLine(i + 1); }
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("if Get() is int32 i {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("as int32?", printed, StringComparison.Ordinal)
        // Evaluated exactly once: one declaration site, one call.
        Assert.Equal(2, CountOccurrences(printed, "Get()"))
    }

    @Fact
    func ValueTypeGuard_ThisScrutinee_EmitsNoSpill() {
        let printed = Translate(`
public sealed class C
{
    public void M()
    {
        if (this is object o) { System.Console.WriteLine(o); }
    }
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func Translate(source string) string {
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
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
