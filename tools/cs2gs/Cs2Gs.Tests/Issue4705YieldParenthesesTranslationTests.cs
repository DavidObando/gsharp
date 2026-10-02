// <copyright file="Issue4705YieldParenthesesTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
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

                public static IEnumerable<int> Arithmetic(int __yielded0, int x, int y, int z)
                {
                    yield return (x + y) * z;
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
                    foreach (int value in Arithmetic(0, 2, 3, 4))
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
        Assert.Equal(45, result.Value);
        Assert.Contains("let __yielded1 int32", printed, StringComparison.Ordinal);
        Assert.Contains("yield (1, 2)", printed, StringComparison.Ordinal);
        Assert.Contains("yield int32(value)", printed, StringComparison.Ordinal);
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
