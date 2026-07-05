// <copyright file="Issue2157ObliviousPropertyTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
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
/// Translator-fidelity tests for issue #2157: in a nullable-<em>oblivious</em>
/// compilation the whole-program taint analysis
/// (<see cref="ObliviousNullabilityAnalyzer"/>) must scan property / indexer
/// getters (expression body, <c>get =&gt; expr;</c>, and block-bodied
/// <c>get { ... return x; }</c>) so a getter whose body yields a nullable value
/// (<c>?.</c>, <c>??</c> with a nullable fallback, <c>return null</c>) is emitted
/// with a <c>T?</c> return type. Before the fix such a property was emitted as a
/// non-null <c>T</c> even though its <c>?.</c> body types as <c>T?</c>, producing
/// GS0156 "Cannot convert type 'string?' to 'string'". The analysis is gated to
/// oblivious compilations, so a nullable-<em>enabled</em> compilation is untouched.
/// </summary>
public class Issue2157ObliviousPropertyTaintTranslationTests
{
    [Fact]
    public void Oblivious_ExpressionBodiedProperty_WithConditionalAccessBody_RendersNullable()
    {
        // `Meta?.Asin` is a conditional access → its result is `string?`. The
        // property must therefore be emitted `string?` or gsc reports GS0156.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Meta { public string Asin = ""x""; }

    public class Book
    {
        public Meta Meta = new Meta();

        public string Asin => Meta?.Asin;
    }
}");

        Assert.Contains("prop Asin string?", printed);
    }

    [Fact]
    public void Oblivious_ExpressionBodiedProperty_WithCoalesceNullableFallbackBody_RendersNullable()
    {
        // `First()?.Name ?? Other` — the `??` fallback (`Other`) is itself a `?.`
        // result, so the whole expression is nullable and the property is `string?`.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Meta { public string Name = ""x""; }

    public class Book
    {
        public Meta Meta = new Meta();
        public Meta Other = new Meta();

        public string Display => Meta?.Name ?? Other?.Name;
    }
}");

        Assert.Contains("prop Display string?", printed);
    }

    [Fact]
    public void Oblivious_BlockBodiedGetter_WithReturnNull_RendersNullable()
    {
        // A block-bodied `get { ... return null; }` taints the property return.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Book
    {
        public bool Missing = true;

        public string Title
        {
            get
            {
                if (Missing) { return null; }
                return ""t"";
            }
        }
    }
}");

        Assert.Contains("prop Title string?", printed);
    }

    [Fact]
    public void Oblivious_UntaintedComputedProperty_StaysNonNull()
    {
        // A getter that can never yield null keeps the idiomatic non-null `string`.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Book
    {
        public string First = ""a"";
        public string Last = ""b"";

        public string Full => First + Last;
    }
}");

        Assert.Contains("prop Full string", printed);
        Assert.DoesNotContain("prop Full string?", printed);
    }

    [Fact]
    public void Oblivious_ValueTypedComputedProperty_IsNotPromoted()
    {
        // A value-typed property is never promoted even when the body is a `?.`
        // chain (its type is not a reference type).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Meta { public int Count = 3; }

    public class Book
    {
        public Meta Meta = new Meta();

        public int Count => Meta == null ? 0 : Meta.Count;
    }
}");

        Assert.Contains("prop Count int32", printed);
        Assert.DoesNotContain("prop Count int32?", printed);
    }

    [Fact]
    public void Oblivious_IndexerWithConditionalAccessBody_RendersNullable()
    {
        // An indexer getter yielding `string?` must be emitted `T?` too.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Meta { public string Get(int i) { return ""x""; } }

    public class Book
    {
        public Meta Meta = new Meta();

        public string this[int i] => Meta?.Get(i);
    }
}");

        Assert.Contains("prop this[i int32] string?", printed);
    }

    [Fact]
    public void NullableEnabled_ComputedPropertyWithConditionalAccessBody_StaysNonNull()
    {
        // Same `?.` body but in a nullable-ENABLED compilation: the oblivious
        // taint analysis must NOT run, and the property is emitted exactly as its
        // declared non-null `string`.
        string printed = TranslateEnabled(@"
#nullable enable
namespace Demo
{
    public class Meta { public string Asin = ""x""; }

    public class Book
    {
        public Meta Meta = new Meta();

        public string Asin => Meta.Asin;
    }
}");

        Assert.Contains("prop Asin string", printed);
        Assert.DoesNotContain("prop Asin string?", printed);
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
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Select(r => r).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
