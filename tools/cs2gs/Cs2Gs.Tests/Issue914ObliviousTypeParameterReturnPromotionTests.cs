// <copyright file="Issue914ObliviousTypeParameterReturnPromotionTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #914 (Oahu.Foundation oblivious
/// deferred-return-promotion): the whole-program oblivious taint analysis
/// (<see cref="ObliviousNullabilityAnalyzer"/>) now also promotes a
/// <em>reference-constrained</em> type-parameter position (<c>where T : class</c>)
/// to <c>T?</c> when it is null-tainted. Previously #2113 excluded ALL type
/// parameters, so a generic method like
/// <c>T DeserializeJsonFile&lt;T&gt;() where T : class { … return null; }</c>
/// kept a non-null <c>T</c> return and its <c>return null</c> / <c>T?</c> flow
/// collided with the non-null return (GS0129 <c>T == nil</c>, GS0155 <c>nil</c>/
/// <c>T?</c> → <c>T</c>). Unconstrained type parameters remain excluded because
/// their <c>IsReferenceType</c> is <c>false</c> and <c>T?</c> would mean
/// <c>Nullable&lt;T&gt;</c>.
/// </summary>
public class Issue914ObliviousTypeParameterReturnPromotionTests
{
    [Fact]
    public void Oblivious_NullReturningReferenceConstrainedTypeParam_RendersNullableReturn()
    {
        // `Deserialize` returns null on a path and `T : class`, so its return is a
        // well-defined nullable reference `T?`. Without promotion, `return null`
        // is GS0155 "cannot convert nil to T".
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public T Deserialize<T>(bool b) where T : class, new()
        {
            if (b) { return null; }
            return new T();
        }
    }
}");

        Assert.Contains("Deserialize[T class init()](b bool) T?", printed);
    }

    [Fact]
    public void Oblivious_TaintedTypeParamLocal_RendersNullableLocalAndFlows()
    {
        // `settings` is assigned `x as T` (nullable) and null-checked, so it is
        // T? locally; when it also flows to the return, the tainted return is
        // promoted to `T?` too — mirroring Oahu.Foundation SettingsManager.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        private object cached;

        public T Get<T>() where T : class, new()
        {
            var settings = this.cached as T;
            if (settings == null)
            {
                settings = new T();
            }
            return settings;
        }
    }
}");

        Assert.Contains("settings T?", printed);
    }

    [Fact]
    public void Oblivious_UnconstrainedTypeParam_StaysNonNull()
    {
        // Without a `class` constraint, `T` may be a value type, so `T?` would
        // mean `Nullable<T>`. The analysis must NOT promote it — the return stays
        // bare `T` (the `return default` is faithful to the C# default(T)).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public T OrDefault<T>(bool b, T value)
        {
            if (b) { return value; }
            return default;
        }
    }
}");

        Assert.Contains("OrDefault[T](b bool, value T) T", printed);
        Assert.DoesNotContain("OrDefault[T](b bool, value T) T?", printed);
    }

    [Fact]
    public void NullableEnabled_ReferenceConstrainedTypeParam_Unchanged()
    {
        // In a nullable-ENABLED compilation the oblivious analysis must not run:
        // a declared non-null `T` return stays `T` (the `return null!` is the
        // developer's explicit suppression, not a promotion trigger).
        string printed = TranslateEnabled(@"
namespace Demo
{
    public class C
    {
        public T Make<T>() where T : class, new()
        {
            return new T();
        }
    }
}");

        Assert.Contains("Make[T class init()]() T", printed);
        Assert.DoesNotContain("Make[T class init()]() T?", printed);
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
            CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
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
