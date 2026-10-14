// <copyright file="Issue3470PrinterWrapTests.cs" company="GSharp">
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
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

// Issue #3470 / ADR-0179 phase 7a: the printer retains its proven wrapping
// until the canonical formatter's cs2gs post-pass is ready to become the
// phase 7b default. These tests run both layers so either path regressing
// long-expression layout is caught.
class Issue3470PrinterWrapTests {
    @Fact
    func LongBooleanChain_WrapsAfterOperators_AndRuns() {
        let printed = Translate(`public static class Obj
{
    private static bool EqualHandles(string leftCollection, string rightCollection) =>
        leftCollection == rightCollection;

    public static bool Compare(string first, string second)
    {
        return !EqualHandles(first + ".fields.expanded", second + ".fields.expanded") ||
            !EqualHandles(first + ".methods.expanded", second + ".methods.expanded") ||
            !EqualHandles(first + ".properties.expanded", second + ".properties.expanded") ||
            !EqualHandles(first + ".events.expanded", second + ".events.expanded");
    }

    public static int Run() => Compare("a", "a") ? 1 : 0;
}`)
        Assert.Contains("||\n", printed, StringComparison.Ordinal)
        Assert.All(printed.Split('\n'), (line string) -> Assert.True(line.Length <= 160, "line still too long: $line"))
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func LongArgumentList_WrapsAfterCommas_AndBinds() {
        let printed = Translate(`public static class Obj
{
    private static string Combine(
        string firstComponentValue,
        string secondComponentValue,
        string thirdComponentValue,
        string fourthComponentValue) =>
        firstComponentValue + secondComponentValue + thirdComponentValue + fourthComponentValue;

    public static string Run(string prefix)
    {
        return Combine(
            prefix + ".first-component-value-with-some-length",
            prefix + ".second-component-value-with-some-length",
            prefix + ".third-component-value-with-some-length",
            prefix + ".fourth-component-value-with-some-length");
    }
}`)
        Assert.Contains("Combine(\n", printed, StringComparison.Ordinal)
        // Declaration signatures are outside issue #3470's statement-level
        // scope; every statement line must fit the budget.
        Assert.All(
            printed.Split('\n').Where((line string) -> !line.Contains("func ", StringComparison.Ordinal)),
            (line string) -> Assert.True(line.Length <= 160, "line still too long: $line")
        )
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ShortStatements_KeepOneLineForm() {
        let printed = Translate(`public static class Obj
{
    public static bool Both(bool a, bool b) => a && b;

    public static int Add(int x, int y) => x + y;

    public static int Run() => Both(true, false) ? Add(1, 2) : 0;
}`)
        Assert.Contains("a && b", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("&&\n", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(\n", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func WrappedIfCondition_KeepsBlockBraceOnLastLine_AndRuns() {
        let printed = Translate(`public static class Obj
{
    private static bool LongCheckNumberOne(string candidateInputValue) => candidateInputValue.Length > 1;

    private static bool LongCheckNumberTwo(string candidateInputValue) => candidateInputValue.Length > 2;

    private static bool LongCheckNumberThree(string candidateInputValue) => candidateInputValue.Length > 3;

    public static int Run()
    {
        var candidate = "abcdef";
        if (LongCheckNumberOne(candidate + ".suffix-one-for-length") && LongCheckNumberTwo(candidate + ".suffix-two-for-length") && LongCheckNumberThree(candidate + ".suffix-three-for-length"))
        {
            return 7;
        }

        return 0;
    }
}`)
        Assert.Contains("&&\n", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
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
            let formatted = GSharpFormatter.Format(SourceText.From(GSharpPrinter.Print(unit)))
            Assert.Empty(formatted.Diagnostics)
            return formatted.Text!!.ToString()
        }
    }
}
