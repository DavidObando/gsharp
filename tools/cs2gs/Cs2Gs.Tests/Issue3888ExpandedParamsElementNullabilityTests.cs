// <copyright file="Issue3888ExpandedParamsElementNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3888: nullable evidence in an expanded <c>params T[]</c> argument
/// belongs to the emitted <c>...T</c> element position, not to the array carrier.
/// </summary>
public class Issue3888ExpandedParamsElementNullabilityTests
{
    [Fact]
    public void ExpandedEvidence_IsAssociatedWithItsParameterAndRuns()
    {
        string printed = TranslateOblivious("""
            namespace Demo
            {
                public static class Fixture
                {
                    public static int LiteralCount(params string[] values) => values.Length;
                    public static int ExpressionCount(params string[] values) => values.Length;
                    public static int StrictCount(params string[] values) => values.Length;
                    public static int Ordinary(string value) => 1;
                }

                public static class Caller
                {
                    public static int Literal() => Fixture.LiteralCount(null, "tail");

                    public static int Expression(bool useNull)
                    {
                        string maybe = useNull ? null : "x";
                        return Fixture.ExpressionCount("head", maybe);
                    }

                    public static int Zero() => Fixture.StrictCount();
                    public static int Multiple() => Fixture.StrictCount("a", "b");
                    public static int OrdinaryNull() => Fixture.Ordinary(null);
                }
            }
            """);

        Assert.Contains("func LiteralCount(values ...string?)", printed, StringComparison.Ordinal);
        Assert.Contains("func ExpressionCount(values ...string?)", printed, StringComparison.Ordinal);
        Assert.Contains("func StrictCount(values ...string)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func StrictCount(values ...string?)", printed, StringComparison.Ordinal);
        Assert.Contains("func Ordinary(value string?)", printed, StringComparison.Ordinal);
        Assert.Contains("LiteralCount(nil, \"tail\")", printed, StringComparison.Ordinal);
        Assert.Contains("ExpressionCount(\"head\", maybe)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("maybe!!", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Literal()", 2);
        AssertEvaluates(printed, "Caller.Expression(true)", 2);
        AssertEvaluates(printed, "Caller.Zero()", 0);
        AssertEvaluates(printed, "Caller.Multiple()", 2);
        AssertEvaluates(printed, "Caller.OrdinaryNull()", 1);
    }

    [Fact]
    public void NormalFormNullableArray_DoesNotWidenElementOrCarrierAndRuns()
    {
        string printed = TranslateOblivious("""
            namespace Demo
            {
                public static class Fixture
                {
                    public static int Count(params string[] values)
                    {
                        if (values is null)
                        {
                            return -1;
                        }

                        return values.Length;
                    }
                }

                public static class Caller
                {
                    public static int Go(bool present)
                    {
                        string[] values = present ? new[] { "x" } : null;
                        return Fixture.Count(values);
                    }
                }
            }
            """);

        Assert.Contains("func Count(values ...string)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func Count(values ...string?)", printed, StringComparison.Ordinal);
        Assert.Contains("Fixture.Count(values!!)", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go(true)", 1);
    }

    [Fact]
    public void GenericReferenceParams_PromotesExpandedElementAndRuns()
    {
        string printed = TranslateOblivious("""
            namespace Demo
            {
                public static class Fixture
                {
                    public static int Count<T>(params T[] values)
                        where T : class => values.Length;
                }

                public static class Caller
                {
                    public static int Go() => Fixture.Count<string>(null, "x");
                }
            }
            """);

        Assert.Contains("values ...T?", printed, StringComparison.Ordinal);
        Assert.Contains("Count[string](nil, \"x\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go()", 2);
    }

    [Fact]
    public void CarrierShapedArrayElement_PromotesNestedElementAndRuns()
    {
        string printed = TranslateOblivious("""
            namespace Demo
            {
                public static class Fixture
                {
                    public static int Count(params string[][] values) => values.Length;
                }

                public static class Caller
                {
                    public static int Go() => Fixture.Count(null, new[] { "x" });
                }
            }
            """);

        Assert.Contains("func Count(values ...[][]?string)", printed, StringComparison.Ordinal);
        Assert.Contains("Fixture.Count(nil, []string{\"x\"})", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("nil!!", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go()", 2);
    }

    [Fact]
    public void AnnotatedNullableParamsElement_RemainsNullableAndRuns()
    {
        string printed = TranslateOblivious("""
            #nullable enable

            namespace Demo
            {
                public static class Fixture
                {
                    public static int Count(params string?[] values) => values.Length;
                }

                public static class Caller
                {
                    public static int Go() => Fixture.Count(null, "x");
                }
            }
            """);

        Assert.Contains("func Count(values ...string?)", printed, StringComparison.Ordinal);
        Assert.Contains("Fixture.Count(nil, \"x\")", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go()", 2);
    }

    [Fact]
    public void CrossProjectSameArityOverloads_KeepEvidenceOnSelectedParamsPosition()
    {
        const string libSource = """
            namespace Lib
            {
                public static class Fixture
                {
                    public static int Count(params string[] values) => values.Length;
                    public static int Count(params object[] values) => values.Length;
                }
            }
            """;
        const string appSource = """
            using Lib;

            namespace App
            {
                public static class Caller
                {
                    public static int Go()
                    {
                        string maybe = null;
                        return Fixture.Count(maybe, "x");
                    }
                }
            }
            """;

        LoadedCSharpProject library = LoadOblivious(libSource, "Lib");
        LoadedCSharpProject app = LoadOblivious(
            appSource,
            "App",
            new[] { library.Compilation.ToMetadataReference() });
        var siblings = new[] { library.Compilation, app.Compilation };

        string printedLibrary = TranslateProject(library, siblings);
        string printedApp = TranslateProject(app, siblings);
        TranslationTestValidation.AssertBinds(printedLibrary, printedApp);

        Assert.Contains("func Count(values ...string?)", printedLibrary, StringComparison.Ordinal);
        Assert.Contains("func Count(values ...object)", printedLibrary, StringComparison.Ordinal);
        Assert.DoesNotContain("func Count(values ...object?)", printedLibrary, StringComparison.Ordinal);
        Assert.DoesNotContain("maybe!!", printedApp, StringComparison.Ordinal);
    }

    private static void AssertEvaluates(string printed, string expression, object expected)
    {
        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + expression);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static LoadedCSharpProject LoadOblivious(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> extraReferences = null)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (assemblyName + ".cs", source) },
            references,
            assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        return project;
    }

    private static string TranslateProject(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations,
            repositoryCompilations: siblingCompilations);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
