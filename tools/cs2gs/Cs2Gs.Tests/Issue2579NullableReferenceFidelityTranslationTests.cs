// <copyright file="Issue2579NullableReferenceFidelityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2579NullableReferenceFidelityTranslationTests
{
    [Fact]
    public void NullableEnabledWarningBoundaries_EmitTargetAwareAssertions()
    {
        string printed = Translate("""
            #nullable enable
            using System.Collections.Generic;
            using System.Linq;

            namespace Demo;

            public sealed class Item
            {
                public string Name => "item";
                public Item? Next => null;
            }

            public static class ItemExtensions
            {
                public static string Label(this Item item) => item.Name;
                public static string NullableLabel(this Item? item) => item?.Name ?? "";
            }

            public static class Repro
            {
                private static string Required = "";
                private static void Consume(string value) { }

                public static int Run(
                    Item? item,
                    IEnumerable<Item>? items,
                    Dictionary<string, string> map,
                    string? key)
                {
                    _ = item.Name;
                    _ = item.Next.Name;
                    _ = item.Label();
                    _ = item.NullableLabel();
                    _ = items.Count();
                    foreach (var current in items)
                        _ = current.Name;

                    string required = key;
                    required = key;
                    Required = key;
                    Consume(key);
                    _ = map[key];
                    Consume(key!);
                    string? optional = key;
                    return required.Length + optional?.Length ?? 0;
                }
            }
            """);

        Assert.Contains("item!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("item!!.Next!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("item!!.Label()", printed, StringComparison.Ordinal);
        Assert.Contains("item.NullableLabel()", printed, StringComparison.Ordinal);
        Assert.Contains("items!!.Count()", printed, StringComparison.Ordinal);
        Assert.Contains("for current in items!!", printed, StringComparison.Ordinal);
        Assert.Contains("var required = key!!", printed, StringComparison.Ordinal);
        Assert.Contains("required = key!!", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Required = key!!", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Consume(key!!)", printed, StringComparison.Ordinal);
        Assert.Contains("map_[key!!]", printed, StringComparison.Ordinal);
        Assert.Contains("let optional string? = key", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("optional string? = key!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DirectAndAttributedGuards_KeepNullableValuesUsable()
    {
        string printed = Translate("""
            #nullable enable
            using System.Diagnostics.CodeAnalysis;

            namespace Demo;

            public static class Repro
            {
                private static bool Present([NotNullWhen(true)] string? value) =>
                    value is not null;

                private static int Length(string value) => value.Length;

                public static int Direct(string? value)
                {
                    if (value is null)
                        return 0;
                    return Length(value);
                }

                public static int Attributed(string? value)
                {
                    if (!Present(value))
                        return 0;
                    return Length(value);
                }
            }
            """);

        Assert.Contains("Repro.Length(value!!)", printed, StringComparison.Ordinal);
        Assert.Contains("@NotNullWhen(true)", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Errors) + "\n" + printed);
        return printed;
    }
}
