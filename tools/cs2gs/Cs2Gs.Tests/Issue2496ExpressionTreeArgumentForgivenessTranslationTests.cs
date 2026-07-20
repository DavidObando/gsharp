// <copyright file="Issue2496ExpressionTreeArgumentForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
/// Issue #2496: nullable-oblivious argument forgiveness must distinguish a
/// callable value from the value returned by that callable. In particular,
/// translator-injected runtime <c>!!</c> nodes are forbidden inside lambdas
/// converted to <c>Expression&lt;TDelegate&gt;</c>.
/// </summary>
public sealed class Issue2496ExpressionTreeArgumentForgivenessTranslationTests
{
    [Fact]
    public void ImportedExpressionSinks_AllLambdaShapes_RemainRepresentable()
    {
        string printed = TranslateOblivious("""
            using System;
            using System.Linq.Expressions;

            namespace Demo;

            public sealed class Item
            {
                public int Id { get; set; }
                public int? ParentId { get; set; }
                public Item Other { get; set; }
                public string Name => Other?.Name;
            }

            public static class Repro
            {
                public static void Run(Builder<Item> builder)
                {
                    builder
                        .HasKey(item => item.Id)
                        .HasIndex((Item item) => item.Name)
                        .HasForeignKey(item => new { item.ParentId, item.Name })
                        .HasOptional(item => item.ParentId);

                    _ = new Selector<Item>(item => item.Id);
                    GenericSink.Accept<Func<Item, string>>(item => item.Name);
                    builder.Nested(item => child => child.Name);
                    builder.Quoted(item => GenericSink.Read<Item>(child => child.Name));
                }
            }
            """);

        Assert.Contains("HasKey((item Item) -> item.Id)", printed, StringComparison.Ordinal);
        Assert.Contains("HasIndex((item Item) -> item.Name)", printed, StringComparison.Ordinal);
        Assert.Contains("HasForeignKey((item Item) ->", printed, StringComparison.Ordinal);
        Assert.Contains("AnonymousType0(item.ParentId, item.Name)", printed, StringComparison.Ordinal);
        Assert.Contains("HasOptional((item Item) -> item.ParentId)", printed, StringComparison.Ordinal);
        Assert.Contains("Selector[Item]((item Item) -> item.Id)", printed, StringComparison.Ordinal);
        Assert.Contains("GenericSink.Accept", printed, StringComparison.Ordinal);
        Assert.Contains("Nested((item Item) -> (child Item) -> child.Name)", printed, StringComparison.Ordinal);
        Assert.Contains("Read[Item]((child Item) -> child.Name)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Id!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Name!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("item.ParentId!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("child.Name!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void OverloadResolution_UsesSemanticExpressionTargetOnly()
    {
        string printed = TranslateOblivious("""
            namespace Demo;

            public sealed class Item
            {
                public Item Other { get; set; }
                public string Name => Other?.Name;
                public int Id { get; set; }
            }

            public static class Repro
            {
                public static void Run()
                {
                    OverloadSink.Select((Item item) => item.Name);
                    OverloadSink.Select((Item item) => item.Id);
                }
            }
            """);

        Assert.Contains("Select((item Item) -> item.Name)", printed, StringComparison.Ordinal);
        Assert.Contains("Select((item Item) -> item.Id)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Name!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeDelegateLambda_ResultForgivenessRemainsAtResultSeam()
    {
        string printed = TranslateOblivious("""
            using System;

            namespace Demo;

            public sealed class Item
            {
                public Item Other { get; set; }
                public string Name => Other?.Name;

                public static string ReadName(Item item) => item.Other?.Name;
            }

            public static class Repro
            {
                public static void Run(RuntimeSink sink)
                {
                    sink.Accept((Item item) => item.Name);
                    sink.AcceptBlock((Item item) => { return item.Name; });
                    sink.Accept<Item>(Item.ReadName);
                }
            }
            """);

        Assert.Contains("Accept((item Item) -> item.Name!!)", printed, StringComparison.Ordinal);
        Assert.Contains("return item.Name!!", printed, StringComparison.Ordinal);
        Assert.Contains("Accept[Item](Item.ReadName)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadName!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void UserAuthoredSuppression_InsideExpressionTree_IsPreservedForGscDiagnostic()
    {
        string printed = TranslateOblivious("""
            namespace Demo;

            public sealed class Item
            {
                public string Name { get; set; }
            }

            public static class Repro
            {
                public static void Run(Builder<Item> builder) =>
                    builder.HasIndex(item => item.Name!);
            }
            """);

        Assert.Contains("HasIndex((item Item) -> item.Name!!)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableEnabledExpressionLambda_RemainsAssertionFree()
    {
        string printed = Translate("""
            #nullable enable
            using System;

            namespace Demo;

            public sealed class Item
            {
                public string Name { get; set; } = "";
                public string? OptionalName { get; set; }
            }

            public static class Repro
            {
                public static void Run(Builder<Item> builder)
                {
                    builder.HasIndex(item => item.Name);
                    Func<Item, string?> runtime = item => item.OptionalName;
                }
            }
            """, NullableContextOptions.Enable);

        Assert.Contains("HasIndex((item Item) -> item.Name)", printed, StringComparison.Ordinal);
        Assert.Contains("(item Item) -> item.OptionalName", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
    }

    private static string TranslateOblivious(string source) =>
        Translate(source, NullableContextOptions.Disable);

    private static string Translate(string source, NullableContextOptions nullableContext)
    {
        MetadataReference sinks = CreateSinkReference();
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Concat(new[] { sinks })
            .ToArray();
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Issue2496.Consumer",
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullableContext));
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

    private static MetadataReference CreateSinkReference()
    {
        const string source = """
            using System;
            using System.Linq.Expressions;

            namespace Demo;

            public sealed class Builder<T>
            {
                public Builder<T> HasKey(Expression<Func<T, object>> selector) => this;
                public Builder<T> HasIndex(Expression<Func<T, string>> selector) => this;
                public Builder<T> HasForeignKey(Expression<Func<T, object>> selector) => this;
                public Builder<T> HasOptional(Expression<Func<T, int?>> selector) => this;
                public Builder<T> Nested(Expression<Func<T, Func<T, string>>> selector) => this;
                public Builder<T> Quoted(Expression<Func<T, string>> selector) => this;
            }

            public sealed class Selector<T>
            {
                public Selector(Expression<Func<T, object>> selector) { }
            }

            public sealed class RuntimeSink
            {
                public void Accept<T>(Func<T, string> selector) { }
                public void AcceptBlock<T>(Func<T, string> selector) { }
            }

            public static class GenericSink
            {
                public static void Accept<TDelegate>(Expression<TDelegate> selector)
                    where TDelegate : Delegate { }

                public static string Read<T>(Expression<Func<T, string>> selector) => "";
            }

            public static class OverloadSink
            {
                public static void Select<T>(Expression<Func<T, string>> selector) { }
                public static void Select<T>(Func<T, int> selector) { }
            }
            """;

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));
        var compilation = CSharpCompilation.Create(
            "Issue2496.ExternalSinks",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }
}
