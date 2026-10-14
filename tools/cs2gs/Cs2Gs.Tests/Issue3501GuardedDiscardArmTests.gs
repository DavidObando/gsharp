// <copyright file="Issue3501GuardedDiscardArmTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #3501: a guarded discard arm (`_ when g =>`) rendered as
/// `default:`, silently DROPPING the guard and colliding with the
/// synthesized total arm (GS0169 "only one 'default' arm" — the
/// GSharp.GeneratorHost wall, GsStubRenderer's `EscapeChar`). The
/// spelling is `case _ when g:`; only an UNGUARDED discard folds to
/// `default`.
open class Issue3501GuardedDiscardArmTests {
    @Fact
    func GuardedDiscardArm_KeepsItsGuard() {
        let g = Render(EscapeSource)
        Assert.Contains("case _ when char.IsControl(c):", g, StringComparison.Ordinal)
        Assert.Single(SplitOccurrences(g, "default:"))
    }

    @Fact
    func GuardedDiscardArm_TranslatedGSharp_CompilesAndBehaves() {
        let g = Render(EscapeSource)
        let result = EmittedOracle.Evaluate([]string{g}, EmittedOracleOptions{IsLibrary: true})
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(0, result.ExitCode)
    }

    shared {
        private const EscapeSource string = `
using System.Globalization;

namespace N
{
    public static class C
    {
        public static string EscapeChar(char c) => c switch
        {
            '\n' => "\\n",
            _ when char.IsControl(c) => "\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture),
            _ => c.ToString(),
        };
    }
}`

        private func SplitOccurrences(haystack string, needle string)[]string -> haystack.Split(
            needle,
            StringSplitOptions.None
        )[1 ..]

        private func Render(csharp string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, csharp string){("Source.cs", csharp)})
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
