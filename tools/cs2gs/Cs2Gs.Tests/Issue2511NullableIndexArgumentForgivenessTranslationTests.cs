// <copyright file="Issue2511NullableIndexArgumentForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #2511: nullable-oblivious values used as
/// index arguments need the same minimal, target-aware forgiveness as ordinary
/// call arguments.
/// </summary>
public sealed class Issue2511NullableIndexArgumentForgivenessTranslationTests
{
    [Fact]
    public void ObliviousDictionaryIndexes_ForgiveReadsWritesAndCompoundAssignments()
    {
        string printed = TranslateOblivious("""
            using System;
            using System.Collections.Generic;

            namespace Demo;

            public static class Repro
            {
                private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

                public static string Run(
                    Dictionary<string, string> items,
                    Dictionary<string, int> counts)
                {
                    string key = FindKey();
                    items[key] = "value";
                    string value = items[key];
                    counts[key] += 1;
                    counts[key]++;
                    items[FindKey()] ??= value;
                    Dictionary<string, string> initialized = new()
                    {
                        [key] = value,
                    };
                    return items[key];
                }
            }
            """);

        Assert.Contains("items[key!!] = \"value\"", printed, StringComparison.Ordinal);
        Assert.Contains("let value = items[key!!]", printed, StringComparison.Ordinal);
        Assert.Contains("counts[key!!] += 1", printed, StringComparison.Ordinal);
        Assert.Contains("counts[key!!]++", printed, StringComparison.Ordinal);
        Assert.Contains("items[Repro.FindKey()!!] ??= value", printed, StringComparison.Ordinal);
        Assert.Contains("[key!!] = value", printed, StringComparison.Ordinal);
        Assert.Contains("return items[key!!]", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "items[Repro.FindKey()!!]"));
    }

    [Fact]
    public void ImportedGenericAndConditionalIndexes_AreForgivenWithoutDoubleAssertion()
    {
        string printed = TranslateObliviousWithIndexerLibrary("""
            using System;

            namespace Demo;

            public static class Repro
            {
                private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

                public static string Run(
                    ImportedLookup imported,
                    GenericLookup<string> generic,
                    bool useConditional)
                {
                    string key = FindKey();
                    imported[key] = "value";
                    string first = imported[key];
                    string second = generic[key];
                    string third = imported[key!];
                    string fourth = useConditional ? imported?[key] : "";
                    return first + second + third + fourth;
                }
            }
            """);

        Assert.Contains("imported!![key!!] = \"value\"", printed, StringComparison.Ordinal);
        Assert.Contains("let first = imported!![key!!]", printed, StringComparison.Ordinal);
        Assert.Contains("let second = generic[key!!]", printed, StringComparison.Ordinal);
        Assert.Contains("let third = imported!![key!!]", printed, StringComparison.Ordinal);
        Assert.Contains("imported?[key!!]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("key!!!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ObliviousIndexArgumentShapes_ReuseValueForgiveness()
    {
        string printed = TranslateOblivious("""
            using System;
            using System.Collections.Generic;

            namespace Demo;

            public sealed class Holder
            {
                public string Key { get; set; }
            }

            public static class Repro
            {
                private static string Field = Environment.GetEnvironmentVariable("FIELD");
                private static string Property => Environment.GetEnvironmentVariable("PROPERTY");
                private static string FindKey() => Environment.GetEnvironmentVariable("METHOD");

                public static void Run(
                    Dictionary<string, string> items,
                    string parameter,
                    Holder holder,
                    bool choose)
                {
                    parameter = Environment.GetEnvironmentVariable("PARAMETER");
                    items[Field] = "field";
                    items[Property] = "property";
                    items[FindKey()] = "method";
                    items[parameter] = "parameter";
                    items[choose ? Field : Property] = "conditional";
                    items[holder?.Key] = "conditional-access";
                    items[Environment.GetEnvironmentVariable("DIRECT")] = "external";
                }
            }
            """);

        Assert.Contains("items[Repro.Field!!] = \"field\"", printed, StringComparison.Ordinal);
        Assert.Contains("items[Repro.Property!!] = \"property\"", printed, StringComparison.Ordinal);
        Assert.Contains("items[Repro.FindKey()!!] = \"method\"", printed, StringComparison.Ordinal);
        Assert.Contains("items[parameter!!] = \"parameter\"", printed, StringComparison.Ordinal);
        Assert.Contains("if choose { Repro.Field } else { Repro.Property }", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Property })!!] = \"conditional\"", printed, StringComparison.Ordinal);
        Assert.Contains("items[(holder?.Key)!!] = \"conditional-access\"", printed, StringComparison.Ordinal);
        Assert.Contains(
            "items[Environment.GetEnvironmentVariable(\"DIRECT\")!!] = \"external\"",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitNullableIndexContractsRemainBareAndGuardedNonNullContractsCompile()
    {
        string oblivious = TranslateObliviousWithIndexerLibrary("""
            using System;

            namespace Demo;

            public sealed class SourceLookup
            {
                public string this[string key]
                {
                    get => key;
                    set { }
                }
            }

            public static class Repro
            {
                private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

                public static string Run(
                    NullableLookup nullable,
                    SourceLookup source)
                {
                    string key = FindKey();
                    nullable[key] = "value";
                    source[key] = "value";
                    NullableLookup initialized = new()
                    {
                        [key] = "value",
                    };
                    return nullable[key] + source[key];
                }
            }
            """);

        Assert.Contains("nullable[key] = \"value\"", oblivious, StringComparison.Ordinal);
        Assert.Contains("nullable[key] + source[key]", oblivious, StringComparison.Ordinal);
        Assert.DoesNotContain("nullable[key!!]", oblivious, StringComparison.Ordinal);
        Assert.DoesNotContain("source[key!!]", oblivious, StringComparison.Ordinal);
        Assert.DoesNotContain("[key!!] = \"value\"", oblivious, StringComparison.Ordinal);

        string enabled = Translate(
            """
            #nullable enable
            using System.Collections.Generic;

            namespace Demo;

            public static class Repro
            {
                public static string Run(Dictionary<string, string> items, string? key)
                {
                    if (key is null)
                    {
                        return "";
                    }

                    return items[key];
                }
            }
            """,
            NullableContextOptions.Enable);

        Assert.Contains("return items[key!!]", enabled, StringComparison.Ordinal);
    }

    [Fact]
    public void GuardsExpressionTreesAndNumericIndexPaths_RemainUnchanged()
    {
        string printed = TranslateOblivious("""
            using System;
            using System.Collections.Generic;
            using System.Linq.Expressions;

            namespace Demo;

            public static class Repro
            {
                private static string FindKey() => Environment.GetEnvironmentVariable("KEY");

                public static int Run(
                    Dictionary<string, string> items,
                    int[] array,
                    int[,] grid,
                    string text,
                    int i,
                    int row,
                    int column)
                {
                    string key = FindKey();
                    if (key != null)
                    {
                        _ = items[key];
                    }

                    items[key != null ? key : "fallback"] = "guarded";
                    Expression<Func<Dictionary<string, string>, string>> read =
                        dictionary => dictionary[key];
                    Span<int> span = array;
                    return array[i] + span[i] + text[i] + array[^1]
                        + text[1..^1].Length + grid[row, column];
                }
            }
            """);

        Assert.Contains("items[key]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("key!!", printed, StringComparison.Ordinal);
        Assert.Contains("dictionary[key]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("dictionary[key!!]", printed, StringComparison.Ordinal);
        Assert.Contains("array[i]", printed, StringComparison.Ordinal);
        Assert.Contains("span[i]", printed, StringComparison.Ordinal);
        Assert.Contains("text[i]", printed, StringComparison.Ordinal);
        Assert.Contains("array[^1]", printed, StringComparison.Ordinal);
        Assert.Contains("text[1..^1]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("row!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("column!!", printed, StringComparison.Ordinal);
    }

    private static string TranslateOblivious(string source) =>
        Translate(source, NullableContextOptions.Disable);

    private static string Translate(
        string source,
        NullableContextOptions nullableContext,
        params MetadataReference[] additionalReferences)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Issue2511.Consumer",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullableContext)
                .WithAllowUnsafe(true));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(translated);
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string TranslateObliviousWithIndexerLibrary(string source) =>
        Translate(source, NullableContextOptions.Disable, CompileIndexerLibrary());

    private static MetadataReference CompileIndexerLibrary()
    {
        const string source = """
            #nullable disable
            public sealed class ImportedLookup
            {
                public string this[string key]
                {
                    get => key;
                    set { }
                }
            }

            public sealed class GenericLookup<TKey>
                where TKey : class
            {
                public string this[TKey key] => key.ToString();
            }

            #nullable enable
            public sealed class NullableLookup
            {
                public string this[string? key]
                {
                    get => key ?? "";
                    set { }
                }
            }
            """;

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));
        var compilation = CSharpCompilation.Create(
            "Issue2511.IndexerLibrary",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int index = text.IndexOf(value, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
