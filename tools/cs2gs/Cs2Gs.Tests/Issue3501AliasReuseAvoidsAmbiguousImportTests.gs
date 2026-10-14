// <copyright file="Issue3501AliasReuseAvoidsAmbiguousImportTests.cs" company="GSharp">
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

/// Issue #3501 (GS0532 family in the migrated Translator): when a C# file
/// references an aliased type (`using GSharpSyntaxFacts =
/// GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts;`) in symbol-only positions,
/// the mapper used to shorten to the bare name and synthesize a WHOLE-NAMESPACE
/// import — which made other simple names (`AssignmentExpressionSyntax`,
/// `SyntaxKind`) ambiguous between that namespace and Roslyn's, and gsc bound
/// the wrong package, surfacing as GS0532 "pattern variable not definitely
/// assigned" on the now-impossible patterns. The mapper now reuses the source
/// alias (its import is already emitted) so no namespace import is synthesized.
open class Issue3501AliasReuseAvoidsAmbiguousImportTests {
    @Fact
    func AliasedTypeInSymbolPosition_ReusesAliasInsteadOfNamespaceImport() {
        let printed = TranslateUnit(`
using TextEncoding = System.Text.Encoding;

namespace Demo
{
    public class Writer
    {
        private readonly TextEncoding encoding = TextEncoding.UTF8;

        public TextEncoding Pick(bool wide)
        {
            TextEncoding chosen = wide ? TextEncoding.Unicode : this.encoding;
            return chosen;
        }
    }
}`)
        // The alias import survives and the references reuse it...
        Assert.Contains("import TextEncoding = System.Text.Encoding", printed)
        Assert.Contains("encoding TextEncoding", printed)
        // ...so no whole-namespace import is synthesized for the alias target.
        Assert.DoesNotContain("import System.Text\n", printed, StringComparison.Ordinal)
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
