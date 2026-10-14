// <copyright file="LockKeywordSanitizationTranslationTests.cs" company="GSharp">
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

/// `lock` is a hard G# keyword (it introduces the `lock` statement),
/// so a C# member literally named `lock` — most commonly the verbatim
/// identifier `@lock` guarding a `lock (@lock) { ... }` block, an
/// idiomatic C# monitor pattern — must be sanitized to `lock_` at both its
/// declaration and every reference site (including the lock-statement operand).
/// It was missing from the translator's reserved-word set, so the field emitted
/// as the bare keyword `lock` and the statement as `lock lock { ... }`,
/// which failed to round-trip-parse (GS0005: unexpected `LockKeyword`).
open class LockKeywordSanitizationTranslationTests {
    @Fact
    func VerbatimLockField_IsSanitizedToLockUnderscore() {
        let rendered = Render()
        // ADR-0170: the metadata-visible field keeps its CLR name via the escape.
        Assert.Contains("$$lock", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("lock_", rendered, StringComparison.Ordinal)
        // The bare `lock` keyword must never appear as an identifier: neither the
        // field declaration nor the lock-statement operand may leak it.
        Assert.DoesNotContain("@lock", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("lock lock ", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let lock ", rendered, StringComparison.Ordinal)
    }

    @Fact
    func SanitizedOutput_RoundTripParses() {
        let rendered = Render()
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
        Assert.True(
            result!!.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
        )
    }

    shared {
        private const Source string = `
namespace Corpus.LockSanitize
{
    public class Guarded
    {
        private readonly object @lock = new object();
        private int count;

        public int Increment()
        {
            lock (@lock)
            {
                return ++this.count;
            }
        }
    }
}
`

        private func Render() string {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Guarded.cs", Source)})
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
            return GSharpPrinter.Print(unit)
        }
    }
}
