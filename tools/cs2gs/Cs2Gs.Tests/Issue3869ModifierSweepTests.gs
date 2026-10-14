// <copyright file="Issue3869ModifierSweepTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #3869, sibling sweep. Dropping `ref` from a `ref struct` was
/// not a one-off typo, it was a whole defect class: a type-declaration modifier
/// that cs2gs silently discards even though G# can express it, and whose loss
/// changes the emitted type's RUNTIME identity. This file pins the behaviour of
/// every other C# type-declaration modifier so the next one cannot regress
/// unnoticed — including the ones that turn out to be fine, which are exactly
/// the assertions that would otherwise never be written.
class Issue3869ModifierSweepTests {
    /// `partial` — preserved (ADR-0145 §C/§D preserve mode). It has no
    /// runtime representation of its own, but losing it in preserve mode would
    /// break the standalone-part contract.
    @Fact
    func Partial_IsPreservedInPreserveMode() {
        let printed = Translate("namespace R { public partial class C { public int X; } }", preservePartialParts: true)
        Assert.Contains("partial class C", printed, StringComparison.Ordinal)
    }

    /// `unsafe` — preserved (ADR-0122 / issue #1202). The body is an unsafe
    /// context, which is what makes a `*T` member signature legal.
    @Fact
    func Unsafe_IsPreserved() {
        let printed = Translate("namespace R { public unsafe struct S { public int X; } }")
        Assert.Contains("unsafe struct S", printed, StringComparison.Ordinal)
    }

    /// `sealed` — correctly dropped, and this is NOT a fidelity loss: G#
    /// types are closed by default and opt INTO inheritance with `open`, so
    /// a C# `sealed class` maps to a plain G# `class` and the emitted
    /// type still carries the CLR `sealed` flag. (G#'s own `sealed`
    /// keyword means a closed hierarchy, a different concept.) Emitting
    /// `sealed` here would change the meaning, not preserve it.
    @Fact
    func Sealed_MapsToAPlainClosedGSharpClass() {
        let printed = Translate("namespace R { public sealed class C { public int X; } }")
        Assert.Contains("class C", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("open class C", printed, StringComparison.Ordinal)
    }

    /// `abstract` — preserved (ADR-0195 / issue #4674). It used to be dropped in
    /// favour of `open` with an Info diagnostic, which left a concrete,
    /// instantiable type where the C# one was abstract; G# now has an `abstract`
    /// class modifier (it implies `open`), so nothing is lost and nothing is
    /// reported.
    @Fact
    func Abstract_IsPreserved_AndImpliesOpen() {
        let project = Load("namespace R { public abstract class C { public int X; } }")
        let translator = CSharpToGSharpTranslator()
        let document = project.Documents.Single()
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        Assert.Contains("abstract class C", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("open class C", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("abstract", StringComparison.Ordinal)
        )
    }

    /// `readonly struct` — the `readonly` IS dropped, and unlike
    /// `ref` this is a LANGUAGE gap, not a translator gap: G# has no
    /// `readonly struct` declaration form at all (gsc only stamps
    /// `IsReadOnlyAttribute` on an `inline struct`,
    /// `TypeDefEmitter`). Crucially it is not the #3869 defect class: the
    /// attribute is a defensive-copy hint for C# consumers, not something the CLR
    /// type loader enforces, so the emitted assembly still loads. Pinned here so
    /// the distinction is on record rather than rediscovered.
    @Fact
    func ReadOnlyStruct_LosesReadOnly_ALanguageGapNotATypeLoadHazard() {
        let printed = Translate("namespace R { public readonly struct S { public readonly int X; } }")
        Assert.Contains("struct S", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("readonly struct", printed, StringComparison.Ordinal)
    }

    /// `static class` — preserved (ADR-0195 / issue #4674). It used to be emitted
    /// as an ordinary instantiable class, so the type stopped being CLR
    /// `abstract sealed`; G# now has a `shared class` modifier, with the
    /// members directly in the class body (no `shared { }` block).
    @Fact
    func StaticClass_IsPreservedAsASharedClass() {
        let printed = Translate("namespace R { public static class Helpers { public static int X() { return 1; } } }")
        Assert.Contains("shared class Helpers", printed, StringComparison.Ordinal)
        Assert.Contains("func X() int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("shared {", printed, StringComparison.Ordinal)
    }

    /// `ref struct` — the #3869 defect itself, and the ONLY modifier in this
    /// sweep whose loss changes runtime type identity to the point of making the
    /// assembly unloadable. Now preserved.
    @Fact
    func RefStruct_IsPreserved() {
        let printed = Translate("using System; namespace R { public ref struct S { public Span<int> V; } }")
        Assert.Contains("ref struct S", printed, StringComparison.Ordinal)
    }

    /// A `ref struct` nested inside a class keeps its `ref` too — gsc's
    /// aggregate-head detector accepts the contextual `ref` at nested
    /// positions, so there is no reason for the translator to special-case them.
    @Fact
    func NestedRefStruct_IsPreserved() {
        let printed = Translate(
            "using System; namespace R { public class Outer { public ref struct Inner { public Span<int> V; } } }"
        )
        Assert.Contains("ref struct Inner", printed, StringComparison.Ordinal)
    }

    shared {
        private func Load(source string) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Repro.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            return project
        }

        private func Translate(source string, preservePartialParts bool = false) string {
            let project = Load(source)
            let translator = CSharpToGSharpTranslator(preservePartialParts: preservePartialParts)
            return string.Join(
                Environment.NewLine,
                project.Documents.Select(
                    (document LoadedDocument) -> {
                        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                        let unit = translator.TranslateDocument(document, context)
                        return GSharpPrinter.Print(unit)
                    }
                )
            )
        }
    }
}
