// <copyright file="Issue3501WrapAndCommentCoverageTests.cs" company="GSharp">
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

// Issue #3501 B2+B3 / ADR-0179: the canonical wrap pass extends to invocations whose
// arguments are multi-line lambdas (first-line budget), long postfix
// chains (leading-dot continuations), and long declaration signatures;
// comment coverage extends to trailing same-line comments and comments
// dangling before a block's closing brace.
class Issue3501WrapAndCommentCoverageTests {
    @Fact
    func MultiLineLambdaArgument_StillWrapsLongHead() {
        let printed = Translate(`using System;

public static class Obj
{
    private static int Configure(
        string firstConfigurationComponentName,
        string secondConfigurationComponentName,
        string thirdConfigurationComponentName,
        Func<int, int> transformCallback) => transformCallback(1);

    public static int Run()
    {
        return Configure("first-component-value-with-length", "second-component-value-with-length", "third-component-value-with-length", value =>
        {
            int doubled = value * 2;
            return doubled + 40;
        });
    }
}`)
        Assert.Contains("Configure(\n", printed, StringComparison.Ordinal)
        Assert.All(
            printed.Split('\n').Where((line string) -> !line.Contains("func ", StringComparison.Ordinal)),
            (line string) -> Assert.True(line.Length <= 160, "line still too long: $line")
        )
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func LongPostfixChain_BreaksBeforeDots_AndRuns() {
        let printed = Translate(`public static class Obj
{
    public static int Run(string candidateInputValueForProcessing)
    {
        return candidateInputValueForProcessing.Trim().Replace("aaaa", "bb").Replace("cccc", "dd").Replace("eeee", "ff").Replace("gggg", "hh").ToUpperInvariant().Length;
    }
}`)
        Assert.Contains(".Trim()\n", printed, StringComparison.Ordinal)
        Assert.Contains(".Replace(\"aaaa\", \"bb\")", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run(\"  aaaacccceeeegggg  \")")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(8, result.Value)
    }

    @Fact
    func LongDeclarationSignature_WrapsParameterList_AndBinds() {
        let printed = Translate(`public static class Obj
{
    public static string Combine(string firstComponentValueName, string secondComponentValueName, string thirdComponentValueName, string fourthComponentValueName, int repetitionCountValue)
        => firstComponentValueName + secondComponentValueName + thirdComponentValueName + fourthComponentValueName + repetitionCountValue;
}`)
        Assert.Contains("Combine(\n", printed, StringComparison.Ordinal)
        Assert.Contains("firstComponentValueName string,\n", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func TrailingAndDanglingComments_Survive() {
        let printed = Translate(`public static class Obj
{
    public static int Run()
    {
        var seed = 41; // seed chosen for the calibration branch
        seed += 1;
        return seed;
        // dangling: kept for the audit trail
    }
}`)
        Assert.Contains("// seed chosen for the calibration branch", printed, StringComparison.Ordinal)
        Assert.Contains("// dangling: kept for the audit trail", printed, StringComparison.Ordinal)
        let trailing = printed.IndexOf("// seed chosen", StringComparison.Ordinal)
        let seedLine = printed.IndexOf("var seed", StringComparison.Ordinal)
        Assert.True(
            printed.Substring(seedLine, trailing - seedLine).IndexOf('\n') < 0,
            "trailing comment stays on the statement's line"
        )
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ShortSignaturesAndChains_KeepOneLineForm() {
        let printed = Translate(`public static class Obj
{
    public static int Add(int x, int y) => x + y;

    public static int Run(string s) => s.Trim().Length + Add(1, 2);
}`)
        Assert.Contains("Add(x int32, y int32)", printed, StringComparison.Ordinal)
        Assert.Contains("s.Trim().Length", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
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
