// <copyright file="Issue3948MultilineInterpolatedStringTests.cs" company="GSharp">
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
import System.Globalization
import System.Text
import Xunit

/// Issue #3948: multiline interpolated strings must keep their line structure
/// without changing interpolation semantics.
class Issue3948MultilineInterpolatedStringTests {
    @Fact
    func MultilineInterpolation_UsesRawLiteralRunsAndQuotedHoles() {
        let printed = Translate(FixtureSource)
        Assert.Contains("`head ` + \"\\u0060\" + `{} $$", printed, StringComparison.Ordinal)
        Assert.Contains("\"$${Next(),7:F1}\"", printed, StringComparison.Ordinal)
        Assert.Contains("\"$${Next(),-7:F1}\"", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("\\n", printed, StringComparison.Ordinal)
        Assert.All(
            printed.Split('\n'),
            (line string) -> Assert.True(line.Length <= 300, "Unexpected long line: " + line)
        )
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func MultilineInterpolation_PreservesValueCultureFormattingAndEvaluationOrder() {
        let printed = Translate(FixtureSource)
        let program = printed + `
CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR")
let value = Demo.Fixture.Render()
System.Console.Write(System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(value)))`
        let originalCulture = CultureInfo.CurrentCulture
        var result EmittedOracleResult
        try {
            result = EmittedOracle.Evaluate([]string{program})
        } finally {
            CultureInfo.CurrentCulture = originalCulture
        }
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(0, result.ExitCode)
        let expected = (`head ` + "`" + `{} $
left=    0,5 middle=1,0    
tail`)
        Assert.Equal(Convert.ToBase64String(Encoding.UTF8.GetBytes(expected)), result.Output)
    }

    shared {
        private const FixtureSource string = (`using System.Globalization;

namespace Demo
{
    public static class Fixture
    {
        private static int sequence;

        private static double Next()
        {
            sequence++;
            return sequence / 2.0;
        }

        public static string Render()
        {
            return $$"""
            head ` + "`" + `{} $
            left={{Next(),7:F1}} middle={{Next(),-7:F1}}
            tail
            """;
        }
    }
}`)

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
