// <copyright file="Issue3501PatternKeywordVariableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3501: a C# pattern variable named `not` (legal in C#, e.g.
/// `NotPattern not =>`) collides with G#'s negated-pattern keyword in
/// case-pattern position, so the sanitizer must suffix it like the other
/// contextual pattern spellings (`and`, `or`, `when`).
open class Issue3501PatternKeywordVariableTranslationTests {
    @Fact
    func PatternVariableNamedNot_IsSuffixed_AndRoundTrips() {
        let printed = Translate(`namespace Demo
{
    public abstract class Pat { }
    public sealed class Neg : Pat
    {
        public Pat? Inner { get; init; }
    }

    public static class C
    {
        public static string Render(Pat p) =>
            p switch
            {
                Neg not => not.Inner is null ? "not ?" : "not x",
                _ => "other",
            };
    }
}`)
        Assert.Contains("not_ is Neg", printed, StringComparison.Ordinal)
        Assert.Contains("not_.Inner", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("case not is", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
            )
            TranslationTestValidation.AssertBinds(rendered)
            return rendered
        }
    }
}
