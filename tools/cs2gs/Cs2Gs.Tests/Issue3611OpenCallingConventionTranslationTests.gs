// <copyright file="Issue3611OpenCallingConventionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3611 / ADR-0095 v2: the two formerly by-design-gapped C#
/// function-pointer shapes now translate to G#'s open calling-convention
/// model — bare `delegate* unmanaged<...>` (the platform-default
/// ABI) spells `unmanaged (T) -> R`, and a combined or non-legacy
/// convention set spells `unmanaged[Name, ...] (T) -> R` with the
/// `CallConv` short names in source order. Single legacy conventions
/// keep the v1 spelling.
open class Issue3611OpenCallingConventionTranslationTests {
    @Fact
    func BareUnmanagedPointer_TranslatesToBareUnmanagedForm() {
        // The exact residual shape from the #3501 corpus
        // (Core.Tests Issue2852GenericUnmanagedStackAllocTests).
        const source = `
public unsafe class Holder
{
    public delegate* unmanaged<int, int> FunctionPointer { get; set; }
}
`
        let printed = Render(source)
        Assert.Contains("unmanaged (int32) -> int32", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
    }

    @Fact
    func CombinedConventions_TranslateInSourceOrder() {
        const source = `
public unsafe class Holder
{
    public delegate* unmanaged[Cdecl, SuppressGCTransition]<int, int> Combined;
    public delegate* unmanaged[SuppressGCTransition, Cdecl]<int, int> Reversed;
}
`
        let printed = Render(source)
        Assert.Contains("unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32", printed, StringComparison.Ordinal)
        Assert.Contains("unmanaged[SuppressGCTransition, Cdecl] (int32) -> int32", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
    }

    @Fact
    func SingleNonLegacyConvention_TranslatesToOpenForm() {
        const source = `
public unsafe class Holder
{
    public delegate* unmanaged[SuppressGCTransition]<int, int> Suppressed;
}
`
        let printed = Render(source)
        Assert.Contains("unmanaged[SuppressGCTransition] (int32) -> int32", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
    }

    @Fact
    func SingleLegacyConvention_KeepsTheV1Spelling() {
        const source = `
public unsafe class Holder
{
    public delegate* unmanaged[Cdecl]<int, int> Legacy;
}
`
        let printed = Render(source)
        Assert.Contains("unmanaged[Cdecl] (int32) -> int32", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
