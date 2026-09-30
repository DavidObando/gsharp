// <copyright file="Issue4300DeconstructionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Focused translation coverage for issue #4300 carrier allocation.</summary>
public sealed class Issue4300DeconstructionTranslationTests
{
    [Fact]
    public void NestedDeclarations_BindSimpleLeavesDirectly_PerBody()
    {
        string printed = Translate("""
            public sealed class Runner
            {
                public int First()
                {
                    var (a, (b, c)) = (1, (2, 3));
                    return a + b + c;
                }

                public int Second()
                {
                    var (a, (b, c)) = (1, (2, 3));
                    return a + b + c;
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "let (a, bTuple) = (1, (2, 3))"));
        Assert.Equal(2, CountOccurrences(printed, "let (b, c) = bTuple"));
        Assert.DoesNotContain("aValue", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("bTuple2", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void LambdaAndLocalFunction_CollidingOuterName_UseIndependentBodyNames()
    {
        string printed = Translate("""
            using System;

            public sealed class Runner
            {
                public int Run()
                {
                    int aTuple = 100;
                    Func<int> lambda = () =>
                    {
                        int a = 0;
                        int b = 0;
                        int c = 0;
                        ((a, b), c) = ((1, 2), 3);
                        return a + b + c + aTuple;
                    };

                    int Local()
                    {
                        int a = 0;
                        int b = 0;
                        int c = 0;
                        ((a, b), c) = ((4, 5), 6);
                        return a + b + c + aTuple;
                    }

                    return lambda() + Local();
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "let (aTuple2, cValue) ="));
        Assert.DoesNotContain("aTuple3", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Runner().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(221, result.Value);
    }

    [Fact]
    public void LaterSourceLocal_IsReservedBeforeCarrierAllocation()
    {
        string printed = Translate("""
            public sealed class Runner
            {
                public int Run()
                {
                    int a = 0;
                    int b = 0;
                    int c = 0;
                    ((a, b), c) = ((1, 2), 3);
                    int aTuple = 4;
                    return a + b + c + aTuple;
                }
            }
            """);

        Assert.Contains("let (aTuple2, cValue) = ((1, 2), 3)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int start = 0;
        while ((start = text.IndexOf(value, start, StringComparison.Ordinal)) >= 0)
        {
            count++;
            start += value.Length;
        }

        return count;
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        return printed;
    }
}
