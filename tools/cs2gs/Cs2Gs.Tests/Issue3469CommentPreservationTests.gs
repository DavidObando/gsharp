// <copyright file="Issue3469CommentPreservationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

// Issue #3469: author comments (`//`, `/* */`) and `///` doc comments were
// dropped wholesale — ~70k comment lines in the self-migrated src/ became
// 78. Leading trivia now rides on the first G# node each statement, type
// member, and top-level type translates to, and the printer re-emits it
// above that node; `///` doc lines keep the doc-comment marker
// (ADR-0057), block comments normalize to `//` lines.
class Issue3469CommentPreservationTests {
    @Fact
    func StatementComments_SurviveTranslation_AndBind() {
        let printed = Translate(`public static class C
{
    public static int Run()
    {
        // The seed is deliberately non-zero: zero would skip
        // the calibration branch below.
        var seed = 41;

        /* block comment
           second line */
        seed = seed + 1;
        return seed;
    }
}`)
        Assert.Contains("// The seed is deliberately non-zero: zero would skip", printed, StringComparison.Ordinal)
        Assert.Contains("// the calibration branch below.", printed, StringComparison.Ordinal)
        Assert.Contains("// block comment", printed, StringComparison.Ordinal)
        Assert.Contains("// second line", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func MemberDocComments_KeepDocMarker_AndBind() {
        let printed = Translate(`public class Widget
{
    /// <summary>
    /// Computes the widget's mass in grams.
    /// </summary>
    /// <returns>The mass.</returns>
    public int Mass() => 42;

    // A plain member comment.
    public int Tare() => 1;
}`)
        // Issue #3501 B1: doc comments render in the ADR-0057 Markdown
        // surface, not verbatim XML.
        Assert.Contains("/// Computes the widget's mass in grams.", printed, StringComparison.Ordinal)
        Assert.Contains("/// @returns The mass.", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("<summary>", printed, StringComparison.Ordinal)
        Assert.Contains("// A plain member comment.", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func TypeComments_AndCommentPlacement_AreAboveTheirNodes() {
        let printed = Translate(`// ADR-9999: this type is load-bearing.
public class Anchor
{
    public int Value()
    {
        // above the return
        return 3;
    }
}`)
        let typeComment = printed.IndexOf("// ADR-9999: this type is load-bearing.", StringComparison.Ordinal)
        let typeDecl = printed.IndexOf("class Anchor", StringComparison.Ordinal)
        let bodyComment = printed.IndexOf("// above the return", StringComparison.Ordinal)
        let returnStmt = printed.IndexOf("return 3", StringComparison.Ordinal)
        Assert.True(typeComment >= 0 && typeComment < typeDecl, printed)
        Assert.True(bodyComment > typeDecl && bodyComment < returnStmt, printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func CommentedCode_StillExecutes() {
        let printed = Translate(`public static class Obj
{
    /// <summary>Adds one, documented.</summary>
    public static int Run()
    {
        // returns 42
        return 41 + 1;
    }
}`)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func Translate(source string, additionalReferences ...MetadataReference) string {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences.Length == 0 {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy((reference MetadataReference) -> reference.Display!!, StringComparer.Ordinal)
                    .Select((group IGrouping[string, MetadataReference]) -> group.First())
                    .ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
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
