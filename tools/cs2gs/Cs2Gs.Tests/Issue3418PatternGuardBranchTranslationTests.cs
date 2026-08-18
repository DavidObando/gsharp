// <copyright file="Issue3418PatternGuardBranchTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3418: legacy pattern-guard hoists must preserve each else-if branch
/// exactly once.
/// </summary>
public sealed class Issue3418PatternGuardBranchTranslationTests
{
    [Fact]
    public void MutableValuePatternGuard_PreservesElseIfWhenTypeTestFails()
    {
        string printed = Translate(
            """
            namespace Demo
            {
                public static class C
                {
                    private static bool TryRead(int value, out int extra)
                    {
                        extra = 2;
                        return value > 0;
                    }

                    public static int Select(object value)
                    {
                        if (value is int number && TryRead(number, out var extra))
                        {
                            number += 1;
                            return number + extra;
                        }
                        else if (value is string)
                        {
                            return 20;
                        }
                        else
                        {
                            throw new System.InvalidOperationException();
                        }
                    }
                }
            }
            """);

        Assert.Equal(1, CountOccurrences(printed, "return 20"));
        Assert.Equal(1, CountOccurrences(printed, "throw InvalidOperationException()"));
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C.Select(\"text\"))\nConsole.WriteLine(C.Select(42))",
            "20" + Environment.NewLine + "45");
    }

    [Fact]
    public void PositionalIfLetGuard_EmitsElseIfBranchOnce()
    {
        string printed = Translate(
            """
            namespace Demo
            {
                public sealed class Node
                {
                    public Node(int value)
                    {
                        Value = value;
                    }

                    public int Value;

                    public void Deconstruct(out int value)
                    {
                        value = Value;
                    }
                }

                public static class C
                {
                    private static object Get(object value) => value;

                    public static int Select(object value)
                    {
                        if (value != null && Get(value) is Node(1) node && node.Value > 0)
                        {
                            return 10;
                        }
                        else if (value is string)
                        {
                            return 20;
                        }
                        else
                        {
                            throw new System.InvalidOperationException();
                        }
                    }
                }
            }
            """,
            allowPositionalPatternDiagnostic: true);

        Assert.Equal(1, CountOccurrences(printed, "return 20"));
        Assert.Equal(1, CountOccurrences(printed, "throw InvalidOperationException()"));
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C.Select(\"text\"))",
            "20");
    }

    private static string Translate(string source, bool allowPositionalPatternDiagnostic = false)
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
        if (allowPositionalPatternDiagnostic)
        {
            Assert.All(
                context.Diagnostics,
                diagnostic => Assert.True(
                    diagnostic.Severity == TranslationSeverity.Info
                        || diagnostic.ConstructKind == "Subpattern",
                    diagnostic.ToString()));
        }
        else
        {
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        }

        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }
}
