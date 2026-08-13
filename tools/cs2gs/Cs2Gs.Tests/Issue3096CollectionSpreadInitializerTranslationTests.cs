// <copyright file="Issue3096CollectionSpreadInitializerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Translation coverage for initializer-safe native collection spreads.</summary>
public sealed class Issue3096CollectionSpreadInitializerTranslationTests
{
    [Fact]
    public void FieldAndPropertyInitializers_UseNativeSpreadSyntaxWithoutSpills()
    {
        string rendered = Render("""
            using System;
            using System.Linq;

            namespace Issue3096;

            public sealed class Holder
            {
                private static readonly string[] All = ["a", "b", "skip"];
                public static readonly string[] Filtered = [.. All.Where(x => x != "skip")];
                public static readonly string[] Mixed = ["before", .. Filtered, "after"];
                public static readonly string[] Empty = [.. Array.Empty<string>()];

                public string[] Property { get; } =
                    ["property-head", .. All.Where(x => x != "skip"), "property-tail"];

                public Holder()
                {
                }
            }
            """);

        Assert.Contains("All.Where(", rendered, StringComparison.Ordinal);
        Assert.Contains("...", rendered, StringComparison.Ordinal);
        Assert.Contains("\"before\", ...", rendered, StringComparison.Ordinal);
        Assert.Contains("Filtered, \"after\"}", rendered, StringComparison.Ordinal);
        Assert.Contains("Array.Empty[string]()", rendered, StringComparison.Ordinal);
        Assert.Contains("Property = []string{\"property-head\", ...", rendered, StringComparison.Ordinal);
        Assert.Contains("\"property-tail\"}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__spread", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".AddRange(", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("CS2GS-GAP", rendered, StringComparison.Ordinal);

        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Errors) + Environment.NewLine + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Empty(context.Diagnostics);
        return rendered;
    }
}
