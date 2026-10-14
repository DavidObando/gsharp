// <copyright file="Issue4705YieldParenthesesTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import System.Text.RegularExpressions
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

class Issue4705YieldParenthesesTranslationTests {
    @Fact
    func YieldExpressionsStartingWithParentheses_TranslateAndRunWithoutChangingYieldTiming() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    private static int calls;

    private static int Next()
    {
        calls++;
        return calls;
    }

    public static IEnumerable<int> Arithmetic(int item, int x, int y, int z)
    {
        yield return (x + y) * z;
        yield return (item + x) << y;
        yield return x + y << z;
    }

    public static IEnumerable<int> Conditional(bool choose, int x, int y, int z)
    {
        yield return (choose ? x : y) + z;
    }

    public static IEnumerable<(int First, int Second)> Tuple()
    {
        yield return (1, 2);
    }

    public static IEnumerable<int> Cast(double value)
    {
        yield return (int)value;
    }

    public static IEnumerable<int> Deferred()
    {
        yield return (Next()) + 1;
    }

    public static int Run()
    {
        int total = 0;
        foreach (int value in Arithmetic(1, 2, 3, 4))
        {
            total += value;
        }

        foreach (int value in Conditional(true, 5, 7, 1))
        {
            total += value;
        }

        foreach (int value in Conditional(false, 5, 7, 1))
        {
            total += value;
        }

        foreach (int value in Cast(9.8))
        {
            total += value;
        }

        calls = 0;
        IEnumerable<int> deferred = Deferred();
        if (calls != 0)
        {
            return -1;
        }

        foreach (int value in deferred)
        {
            if (calls != 1)
            {
                return -2;
            }

            total += value;
            break;
        }

        return total;
    }
}`)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(149, result.Value)
        Assert.DoesNotContain("let item int32 = (item", printed, StringComparison.Ordinal)
        Assert.Matches("let item_\\d+ int32 = \\(item \\+ x\\) << y", printed)
        let hoistedValues = Regex.Matches(printed, "let (?<name>item(_\\d+)?) int32 =")
        Assert.NotEmpty(hoistedValues)
        Assert.All(
            hoistedValues.Cast[Match](),
            (local Match) -> Assert.Matches("\\byield " + Regex.Escape(local.Groups["name"].Value) + "\\b", printed)
        )
        Assert.Contains("yield (1, 2)", printed, StringComparison.Ordinal)
        Assert.Contains("yield int32(value)", printed, StringComparison.Ordinal)
    }

    @Fact
    func HoistedNullableReferenceYield_PreservesIteratorElementPromotion() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<string> Rows(bool choose)
    {
        yield return choose ? null : "x";
    }

    public static int Run()
    {
        int total = 0;
        foreach (string value in Rows(true))
        {
            if (value != null) { return -1; }
            total += 1;
        }

        foreach (string value in Rows(false))
        {
            if (value != "x") { return -2; }
            total += 2;
        }

        return total;
    }
}`)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.False(
            result.Diagnostics.Any((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func SplicedStringYield_PreservesTheExactStringValue() {
        let printed = Translate((`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<string> Rows()
    {
        yield return "alpha\n` + "`" + `beta\nomega";
    }

    public static string Run()
    {
        string result = "";
        foreach (string value in Rows())
        {
            result += value;
        }

        return result;
    }
}`))
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal((`alpha
` + "`" + `beta
omega`), result.Value)
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
