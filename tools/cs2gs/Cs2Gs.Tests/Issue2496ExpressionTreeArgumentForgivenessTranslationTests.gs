// <copyright file="Issue2496ExpressionTreeArgumentForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #2496: nullable-oblivious argument forgiveness must distinguish a
/// callable value from the value returned by that callable. In particular,
/// translator-injected runtime `!!` nodes are forbidden inside lambdas
/// converted to `Expression<TDelegate>`.
class Issue2496ExpressionTreeArgumentForgivenessTranslationTests {
    @Fact
    func ImportedExpressionSinks_AllLambdaShapes_RemainRepresentable() {
        let printed = TranslateOblivious(`using System;
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
}`)
        Assert.Contains("HasKey((item Item) -> item.Id)", printed, StringComparison.Ordinal)
        Assert.Contains("HasIndex((item Item) -> item.Name)", printed, StringComparison.Ordinal)
        Assert.Contains("HasForeignKey((item Item) ->", printed, StringComparison.Ordinal)
        Assert.Matches("AnonymousType2_[0-9A-F]{16}\\(item\\.ParentId, item\\.Name\\)", printed)
        Assert.Contains("(item Item) -> item.ParentId)", printed, StringComparison.Ordinal)
        Assert.Contains("Selector[Item]((item Item) -> item.Id)", printed, StringComparison.Ordinal)
        Assert.Contains("GenericSink.Accept", printed, StringComparison.Ordinal)
        Assert.Contains("Nested((item Item) -> (child Item) -> child.Name)", printed, StringComparison.Ordinal)
        Assert.Contains("Read[Item]((child Item) -> child.Name)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item.Id!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item.Name!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item.ParentId!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("child.Name!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func OverloadResolution_UsesSemanticExpressionTargetOnly() {
        let printed = TranslateOblivious(`namespace Demo;

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
}`)
        Assert.Contains("Select((item Item) -> item.Name)", printed, StringComparison.Ordinal)
        Assert.Contains("Select((item Item) -> item.Id)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item.Name!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func RuntimeDelegateLambda_ResultForgivenessRemainsAtResultSeam() {
        let printed = TranslateOblivious(`using System;

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
        sink.Accept((Item item) => item.Other?.Name);
        sink.AcceptBlock((Item item) => { return item.Name; });
        sink.Accept<Item>(Item.ReadName);
    }
}`)
        Assert.Contains("Accept((item Item) -> item.Name!!)", printed, StringComparison.Ordinal)
        Assert.Contains("Accept((item Item) -> item.Other?.Name)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item.Other?.Name!!", printed, StringComparison.Ordinal)
        Assert.Contains("return item.Name!!", printed, StringComparison.Ordinal)
        Assert.Contains("Accept[Item](Item.ReadName)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ReadName!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func UserAuthoredSuppression_InsideExpressionTree_IsPreservedForGscDiagnostic() {
        let printed = TranslateOblivious(`namespace Demo;

public sealed class Item
{
    public string Name { get; set; }
}

public static class Repro
{
    public static void Run(Builder<Item> builder) =>
        builder.HasIndex(item => item.Name!);
}`)
        Assert.Contains("HasIndex((item Item) -> item.Name!!)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NullableEnabledExpressionLambda_RemainsAssertionFree() {
        let printed = Translate(`#nullable enable
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
}`, NullableContextOptions.Enable)
        Assert.Contains("HasIndex((item Item) -> item.Name)", printed, StringComparison.Ordinal)
        Assert.Contains("(item Item) -> item.OptionalName", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateOblivious(source string) string -> Translate(source, NullableContextOptions.Disable)

        private func Translate(source string, nullableContext NullableContextOptions) string {
            let sinks = CreateSinkReference()
            let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]MetadataReference{sinks})
                .ToArray()
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Issue2496.Consumer",
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    nullableContext
                )
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(translated)
            let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Consumer-only fixture omits the referenced expression-sink metadata library from emitted G#."
            )
            Assert.True(
                roundTrip.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func CreateSinkReference() MetadataReference {
            const source = `using System;
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
}`
            let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                "Issue2496.ExternalSinks",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return MetadataReference.CreateFromImage(stream.ToArray())
        }
    }
}
