// <copyright file="Issue2113ObliviousNullableTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #2113: in a nullable-<em>oblivious</em>
/// compilation (<c>NullableContextOptions.Disable</c>, i.e. a project with no
/// <c>&lt;Nullable&gt;</c> setting) Roslyn reports every reference type as
/// <c>NullableAnnotation.None</c> with no flow state, so an oblivious reference
/// <c>T</c> used to always map to non-null G# <c>T</c>. That collided with the
/// <c>T?</c> values cs2gs legitimately introduces (<c>?.</c>, <c>= null</c>
/// defaults, nullable-returning BCL), producing GS0154/GS0155/GS0156 "T? vs T"
/// errors. The whole-program taint analysis
/// (<see cref="ObliviousNullabilityAnalyzer"/>) now promotes a reference
/// declaration to <c>T?</c> exactly when it is reachable from a null value, and
/// keeps a provably non-null declaration as <c>T</c>. The analysis is gated to
/// oblivious compilations, so a nullable-<em>enabled</em> compilation is untouched.
/// </summary>
public class Issue2113ObliviousNullableTranslationTests
{
    [Fact]
    public void Oblivious_NullTaintedField_RendersNullableType()
    {
        // `field` is assigned null on one path, so it is null-tainted and must
        // render `string?`; without promotion the later `field = null` assignment
        // is a GS0155 "cannot convert nil to string".
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        private string field = ""seed"";

        public void Clear() { this.field = null; }
    }
}");

        Assert.Contains("field string?", printed);
    }

    [Fact]
    public void Oblivious_NullTaintedParameterAndReturn_RenderNullableTypes()
    {
        // `Find` returns null on a path (return type tainted) and its result flows
        // into the `value` parameter of `Use` via a call argument (interprocedural
        // taint), so both the return and the parameter must render `string?`.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return ""x"";
        }

        public void Use(string value) { }

        public void Run() { Use(Find(true)); }
    }
}");

        Assert.Contains("Find(b bool) string?", printed);
        Assert.Contains("Use(value string?)", printed);
    }

    [Fact]
    public void Oblivious_UntaintedReference_StaysNonNull()
    {
        // No null ever reaches `Name`, `Greet`, or its parameter, so all stay
        // non-null `string` — the idiomatic G# form.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        private string Name = ""hello"";

        public string Greet(string who) { return who; }
    }
}");

        Assert.Contains("Name string", printed);
        Assert.DoesNotContain("Name string?", printed);
        Assert.Contains("Greet(who string) string", printed);
        Assert.DoesNotContain("string?", printed);
    }

    [Fact]
    public void NullableEnabled_DeclarationsUnchanged_NoObliviousPromotion()
    {
        // Same null-assignment shape as the oblivious field test, but in a
        // nullable-ENABLED compilation. The oblivious taint analysis must NOT run:
        // `field` is a declared non-null `string` (assigning null is a C# warning,
        // not a promotion trigger), so it stays non-null `string` exactly as
        // before #2113. `maybe` is declared `string?` and stays nullable.
        string printed = TranslateEnabled(@"
namespace Demo
{
    public class C
    {
        private string field = ""seed"";
        private string? maybe = null;

        public void Keep() { this.field = this.field; }
    }
}");

        Assert.Contains("field string", printed);
        Assert.DoesNotContain("field string?", printed);
        Assert.Contains("maybe string?", printed);
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
