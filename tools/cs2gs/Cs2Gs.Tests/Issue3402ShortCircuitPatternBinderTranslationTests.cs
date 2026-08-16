// <copyright file="Issue3402ShortCircuitPatternBinderTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3402: a pattern binder at the start of an && chain remains visible
/// through later conjuncts and the true body.
/// </summary>
public class Issue3402ShortCircuitPatternBinderTranslationTests
{
    [Fact]
    public void PatternBinder_WithLaterOutVar_RemainsInScope()
    {
        const string source = """
            namespace Demo
            {
                public class Base { }
                public sealed class Candidate : Base
                {
                    public int Value;
                }

                public static class C
                {
                    private static Base Get(Base value) => value;

                    private static bool TryRead(out int value)
                    {
                        value = 2;
                        return true;
                    }

                    public static int Read(Base value)
                    {
                        if (Get(value) is Candidate candidate
                            && candidate.Value > 0
                            && TryRead(out var extra)
                            && extra > 0)
                        {
                            return candidate.Value + extra;
                        }

                        return 0;
                    }
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("if let candidate = C.Get(value) as Candidate", rendered, StringComparison.Ordinal);
        Assert.Contains("candidate.Value > 0 && C.TryRead(out var extra) && extra > 0", rendered, StringComparison.Ordinal);
        Assert.Contains("return candidate.Value + extra", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("if if let", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void PatternBinder_AfterOutVarPrefix_RemainsInScope()
    {
        const string source = """
            namespace Demo
            {
                public class Base { }
                public sealed class Candidate : Base
                {
                    public int Value;
                }

                public static class C
                {
                    private static bool TryGet(Base input, out Base value)
                    {
                        value = input;
                        return true;
                    }

                    public static int Read(Base input)
                    {
                        if (TryGet(input, out var value)
                            && value is Candidate candidate
                            && candidate.Value > 0)
                        {
                            return candidate.Value;
                        }

                        return 0;
                    }
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("if C.TryGet(input, out var value)", rendered, StringComparison.Ordinal);
        Assert.Contains("if let candidate = value as Candidate", rendered, StringComparison.Ordinal);
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void InferredGenericEnumTryParse_RendersExplicitTypeArgument()
    {
        const string source = """
            using System;

            namespace Demo
            {
                public static class C
                {
                    public static bool Parse<T>(string text, out T result)
                        where T : struct, Enum =>
                        Enum.TryParse(text, false, out result);
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("Enum.TryParse[T]", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }
}
