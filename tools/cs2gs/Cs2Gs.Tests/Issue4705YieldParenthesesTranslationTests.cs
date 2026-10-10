// <copyright file="Issue4705YieldParenthesesTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4705YieldParenthesesTranslationTests
{
    [Fact]
    public void YieldExpressionsStartingWithParentheses_TranslateAndRunWithoutChangingYieldTiming()
    {
        string printed = Translate("""
            using System.Collections.Generic;

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
            }
            """);

        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(149, result.Value);
        Assert.DoesNotContain("let item int32 = (item", printed, StringComparison.Ordinal);
        Assert.Matches(@"let item_\d+ int32 = \(item \+ x\) << y", printed);
        MatchCollection hoistedValues = Regex.Matches(printed, @"let (?<name>item(_\d+)?) int32 =");
        Assert.NotEmpty(hoistedValues);
        Assert.All(
            hoistedValues.Cast<Match>(),
            local => Assert.Matches(
                @"\byield " + Regex.Escape(local.Groups["name"].Value) + @"\b",
                printed));
        Assert.Contains("yield (1, 2)", printed, StringComparison.Ordinal);
        Assert.Contains("yield int32(value)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void HoistedNullableReferenceYield_PreservesIteratorElementPromotion()
    {
        string printed = Translate("""
            using System.Collections.Generic;

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
            }
            """);

        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.False(
            result.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void SplicedStringYield_PreservesTheExactStringValue()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            public static class Obj
            {
                public static IEnumerable<string> Rows()
                {
                    yield return "alpha\n`beta\nomega";
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
            }
            """);

        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal("alpha\n`beta\nomega", result.Value);
    }

    private static string Translate(
        string source,
        params MetadataReference[] additionalReferences)
    {
        IReadOnlyList<MetadataReference> references = additionalReferences.Length == 0
            ? null
            : CSharpProjectLoader.RuntimeReferences()
                .Concat(additionalReferences)
                .GroupBy(reference => reference.Display, StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            references);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
