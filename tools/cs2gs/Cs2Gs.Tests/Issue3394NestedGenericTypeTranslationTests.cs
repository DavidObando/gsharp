// <copyright file="Issue3394NestedGenericTypeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3394: nested metadata types retain type arguments carried by their
/// constructed containing type.
/// </summary>
public class Issue3394NestedGenericTypeTranslationTests
{
    [Fact]
    public void ImmutableArrayBuilder_PreservesContainingElementType()
    {
        const string source = """
            using System.Collections.Immutable;

            namespace Demo
            {
                public class Item { }

                public static class C
                {
                    public static int Count(ImmutableArray<Item>.Builder builder) =>
                        builder.Count;
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

        Assert.Contains(
            "builder ImmutableArray[Item].Builder",
            rendered,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ImmutableArrayBuilder_RetainsContainingElementType()
    {
        const string source = @"
#nullable enable
using System.Collections.Immutable;
namespace Demo
{
    public class C
    {
        public int Count(ImmutableArray<int>.Builder? builder) => builder?.Count ?? 0;
    }
}
";

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("ImmutableArray[int32].Builder?", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void NullablePromotedNestedGenericLocal_RetainsContainingType()
    {
        const string source = """
            #nullable enable
            using System.Collections.Immutable;

            namespace Demo
            {
                public class C
                {
                    public void M()
                    {
                        var builder = ImmutableArray.CreateBuilder<int>();
                        builder = null;
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

        Assert.Contains("builder ImmutableArray[int32].Builder?", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void NamedTuplePropertyPattern_UsesPositionalMember()
    {
        const string source = """
            #nullable enable

            namespace Demo
            {
                public static class C
                {
                    public static bool HasValue((int Id, string? FunctionType)? target) =>
                        target is { FunctionType: not null };
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

        Assert.Contains("target!!.Item2 != nil", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("target!!.FunctionType", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void PositionalRecordProperty_RedeclarationDoesNotDuplicateMember()
    {
        const string source = @"
namespace Demo
{
    public readonly record struct Key(string Name)
    {
        public string Name { get; } = Name ?? string.Empty;
    }
}
";

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

        Assert.Equal(1, rendered.Split("Name string", StringSplitOptions.None).Length - 1);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void SourceNestedBaseType_InsideGenericContainer_RemainsDirectlyInScope()
    {
        const string source = @"
namespace Demo
{
    public class Outer<T>
    {
        private abstract class Format
        {
        }

        private class TextFormat : Format
        {
            public TextFormat() : base()
            {
            }
        }

        private Format Make() => new TextFormat();
    }
}
";

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("class TextFormat : Format", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Outer[T].Format", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var tree = SyntaxTree.Parse(SourceText.From(rendered));
        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        Assert.DoesNotContain(
            scope.Diagnostics,
            diagnostic => diagnostic.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void DeconstructedLocals_PassedByRef_AreMutable()
    {
        const string source = """
            namespace Demo
            {
                public static class C
                {
                    private static (int?, int?) Pair() => (null, null);

                    private static void Touch(ref int? value)
                    {
                    }

                    public static void M()
                    {
                        var (left, right) = Pair();
                        Touch(ref left);
                        Touch(ref right);
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

        Assert.Contains("var (left, right) = C.Pair()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let (left, right)", rendered, StringComparison.Ordinal);
        Assert.Contains("C.Touch(&left)", rendered, StringComparison.Ordinal);
        Assert.Contains("C.Touch(&right)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void DeconstructedLocals_PassedByRef_MutateAtRuntime()
    {
        const string source = """
            namespace Demo
            {
                public static class C
                {
                    private static (int, int) Pair() => (0, 0);

                    private static void Touch(ref int value)
                    {
                        value = value + 1;
                    }

                    public static int M()
                    {
                        var (left, right) = Pair();
                        Touch(ref left);
                        Touch(ref right);
                        return left + right;
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

        Assert.Contains("var (left, right) = C.Pair()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("let (left, right)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "C.M()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(2, result.Value);
    }
}
