// <copyright file="Issue3555NestedTypeNarrowingPatternTests.cs" company="GSharp">
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

/// <summary>
/// Issue #3555: a boolean-position C# pattern whose PROPERTY value is itself a
/// type-matching pattern with further subpatterns (`symbol is IParameterSymbol
/// { ContainingSymbol: IMethodSymbol { MethodKind: …, ContainingType.IsRecord:
/// true } }`) used to guard-lower over a smart-castable scrutinee into
/// unnarrowed member CHAINS (`symbol.ContainingSymbol is IMethodSymbol &&
/// symbol.ContainingSymbol.MethodKind == …`) — gsc narrows only the scrutinee
/// local, so the second read failed GS0158. Such shapes now take the native
/// pattern form.
/// </summary>
open class Issue3555NestedTypeNarrowingPatternTests {
    @Fact
    func NestedTypePropertyPattern_UsesNativePatternForm() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Owner
    {
        public bool IsSpecial { get; set; }
        public string Name { get; set; } = "";
    }

    public class Member
    {
        public object Holder { get; set; } = new object();
    }

    public static class Probe
    {
        public static bool Check(object value) =>
            value is string
            || value is Member
            {
                Holder: Owner
                {
                    IsSpecial: true,
                    Name.Length: > 0,
                },
            };
    }
}`)
        Assert.Contains("Holder: Owner and {", printed)
        Assert.DoesNotContain(".Holder is Owner &&", printed)
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
