// <copyright file="Issue3501ImplicitCreationTaintTranslationTests.cs" company="GSharp">
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

/// Issue #3501 (Translator burn-down, GS0155 nil→string family): the oblivious
/// taint walk matched `ObjectCreationExpressionSyntax` only, but a
/// target-typed creation (`new(null, "…")`, C# 9) is the sibling
/// `ImplicitObjectCreationExpressionSyntax` — so a null argument inside a
/// collection-initializer entry (`[key] = new(null, "…")`, the
/// RoslynAnalyzerApiMap shape) never flowed into the record's positional
/// parameter and the rendered `T` rejected the `nil` at every call site.
/// Matching the shared `BaseObjectCreationExpressionSyntax` closes it.
open class Issue3501ImplicitCreationTaintTranslationTests {
    @Fact
    func Oblivious_ImplicitCreationNullArgument_TaintsPositionalParameter() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    internal static class Map
    {
        private static readonly Dictionary<string, Entry> Table = new()
        {
            ["a"] = new("ns", "x"),
            ["b"] = new(null, "y"),
        };

        internal readonly record struct Entry(string Ns, string Name, string Note = null);
    }
}`)
        // The null argument in the target-typed `new(null, ""y"")` taints the
        // positional `Ns`; `Name` never sees null and stays bare.
        Assert.Contains("Ns string?", printed)
        Assert.Contains("Name string,", printed)
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
