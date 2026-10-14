// <copyright file="Adr0179DocCommentLineStructureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

// ADR-0179 phase 9a: a doc comment's line structure belongs to the author.
// The converter used to collapse every `///` line of a block into one
// string and then recompute the layout with a word-wrap pass; when that
// pass could not find a legal split point the whole block emitted as a
// single line (32 lines over 300 characters in the repo self-migration,
// the longest 1,961). The source already had the line structure, so it is
// now preserved rather than recomputed, and the wrap survives only as a
// backstop for a line the author wrote long.
class Adr0179DocCommentLineStructureTests {
    @Fact
    func MultiLineRemarks_KeepsItsSourceLines() {
        let printed = Translate(`public class Widget
{
    /// <summary>Short.</summary>
    /// <remarks>
    /// First remark line, written deliberately.
    /// Second remark line, a separate thought.
    /// Third remark line, ending the block.
    /// </remarks>
    public int Mass() => 42;
}`)
        Assert.Contains("/// @remarks First remark line, written deliberately.", printed, StringComparison.Ordinal)
        Assert.Contains("/// Second remark line, a separate thought.", printed, StringComparison.Ordinal)
        Assert.Contains("/// Third remark line, ending the block.", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func CodeSpanContainingABracket_DoesNotSwallowTheRestOfTheComment() {
        // The concrete defect. `<c>?[</c>` renders as a Markdown code span
        // holding an unbalanced `[`; the wrap pass counted that bracket as
        // an open Markdown link, so every following word merged into one
        // unsplittable atom and the comment emitted as one enormous line.
        // Brackets inside a code span are code, not Markdown.
        let printed = Translate(`public class Widget
{
    /// <summary>
    /// gsc parses <c>?.</c> and <c>?[</c> asymmetrically: the member form takes the whole trailing chain as its guarded continuation, while the index form is one postfix step whose result is <c>T?</c>. Printing the C# shape flat therefore says <c>(a?[i]).B</c> to gsc, which rejects the dereference.
    /// </summary>
    public int Mass() => 42;
}`)
        let docLines = DocLines(printed)
        Assert.NotEmpty(docLines)
        Assert.All(
            docLines,
            (line string) -> Assert.True(line.Length <= 300, "A code span must not defeat the wrap backstop: " + line)
        )
        Assert.Contains("which rejects the dereference.", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func BlankDocLine_StaysAParagraphBreak() {
        let printed = Translate(`public class Widget
{
    /// <summary>
    /// First paragraph.
    ///
    /// Second paragraph.
    /// </summary>
    public int Mass() => 42;
}`)
        let docLines = DocLines(printed)
        let first = docLines.FindIndex((line string) -> line.Contains("First paragraph.", StringComparison.Ordinal))
        let second = docLines.FindIndex((line string) -> line.Contains("Second paragraph.", StringComparison.Ordinal))
        Assert.True(first >= 0 && second == first + 2, "Expected a blank `///` between the paragraphs:\n" + printed)
        Assert.Equal("///", docLines[first + 1])
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func CodeSpanWrappedAcrossSourceLines_DoesNotStartALineWithAStrayTag() {
        // Issue #3501: src/Sdk/Gsharp.NET.Sdk/GsgenTask.cs writes
        // `<c>dotnet &lt;tool&gt;.dll @rsp</c>` with the author's own line
        // break falling INSIDE the code span, right before `@rsp`. Phase
        // 9a preserves that line structure, so the emitted G# began a doc
        // line with `@rsp` — which gsc reads as a block tag and rejects
        // with GS0231 "Unknown documentation tag", failing the whole
        // project. The break carries no meaning inside a span, so it heals.
        let printed = Translate(`public class Widget
{
    /// <summary>Short.</summary>
    /// <remarks>
    /// Modeled EXACTLY on the build task: same <c>dotnet &lt;tool&gt;.dll
    /// @rsp</c> process launch, the same response-file writer.
    /// </remarks>
    public int Mass() => 42;
}`)
        Assert.All(
            DocLines(printed),
            (line string) -> Assert.False(
                line.StartsWith("/// @rsp", StringComparison.Ordinal),
                "A doc line must not start with an unknown block tag: " + line
            )
        )
        Assert.Contains("@rsp`", printed, StringComparison.Ordinal)
        Assert.Contains("response-file writer.", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    shared {
        private func DocLines(printed string) List[string] -> printed
            .Split('\n')
            .Select((line string) -> line.Trim())
            .Where((line string) -> line.StartsWith("///", StringComparison.Ordinal))
            .ToList()

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references: nil
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
