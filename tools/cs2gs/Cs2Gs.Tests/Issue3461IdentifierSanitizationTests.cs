// <copyright file="Issue3461IdentifierSanitizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;
using GSharpSyntaxFacts = GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts;
using GSharpSyntaxKind = GSharp.Core.CodeAnalysis.Syntax.SyntaxKind;

namespace Cs2Gs.Tests;

/// <summary>Issue #3461: every emitted identifier must avoid G# reserved spellings without collisions.</summary>
public sealed class Issue3461IdentifierSanitizationTests
{
    [Fact]
    public void LanguageServerParamsParameter_DeclarationAndReference_Bind()
    {
        string rendered = Render(
            """
            using System.Text.Json;

            public static class LspServer
            {
                public static void Initialized(JsonElement @params)
                {
                    _ = @params;
                }
            }
            """);

        Assert.Contains("Initialized(params_ JsonElement)", rendered, StringComparison.Ordinal);
        AssertNoStandaloneIdentifier(rendered, "params");
        TranslationTestValidation.AssertBinds(
            rendered,
            """
            package System.Text.Json

            struct JsonElement { }
            """);
    }

    [Fact]
    public void ReservedAndSuffixIdentifiers_RemainDistinctAcrossSurfaces()
    {
        string rendered = Render(
            """
            using @import = System.Text.StringBuilder;
            using import_ = System.Text.StringBuilder;

            namespace Corpus.Issue3461
            {
                public class @type
                {
                    public int Value;
                }

                public class type_
                {
                    public int Value;
                }

                public class Holder
                {
                    private @import @scope = new @import();
                    private import_ scope_ = new import_();

                    public int @select(int @params, int params_, object value)
                    {
                        int @range = @params + this.@scope.Length;
                        int range_ = params_ + this.scope_.Length;
                        if (value is int @guard)
                        {
                            int guard_ = @guard + @range;
                            if (guard_ > 0)
                            {
                                goto @goto;
                            }
                        }

                        goto goto_;

                    @goto:
                        return @range;

                    goto_:
                        return range_;
                    }

                    public int select_(int @params, int params_, object value) =>
                        @select(@params, params_, value);

                    public @type MakeKeywordType() => new @type();

                    public type_ MakeSuffixType() => new type_();
                }
            }
            """);

        Assert.Contains("import import_ = System.Text.StringBuilder", rendered, StringComparison.Ordinal);
        Assert.Contains("import import__ = System.Text.StringBuilder", rendered, StringComparison.Ordinal);
        Assert.Contains("class type_", rendered, StringComparison.Ordinal);
        Assert.Contains("class type__", rendered, StringComparison.Ordinal);
        Assert.Contains("select_(params_ int32, params__ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("select__(params_ int32, params__ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("range_", rendered, StringComparison.Ordinal);
        Assert.Contains("range__", rendered, StringComparison.Ordinal);
        Assert.Contains("guard_", rendered, StringComparison.Ordinal);
        Assert.Contains("guard__", rendered, StringComparison.Ordinal);
        Assert.Contains("goto goto_", rendered, StringComparison.Ordinal);
        Assert.Contains("goto goto__", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void AnonymousGeneratedMembers_PreserveReservedNameCollisions()
    {
        string rendered = Render(
            """
            public static class Holder
            {
                public static int Sum()
                {
                    var value = new { @params = 1, params_ = 2 };
                    return value.@params + value.params_;
                }
            }
            """);

        Assert.Contains("params_ int32", rendered, StringComparison.Ordinal);
        Assert.Contains("params__ int32", rendered, StringComparison.Ordinal);
        Assert.Contains(".params_", rendered, StringComparison.Ordinal);
        Assert.Contains(".params__", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void LexerAndParserReservedWordAudit_AllNamesAreSanitized()
    {
        string[] reserved = Enum.GetValues<GSharpSyntaxKind>()
            .Select(GSharpSyntaxFacts.GetText)
            .Where(text => text != null && GSharpSyntaxFacts.GetKeywordKind(text) != GSharpSyntaxKind.IdentifierToken)
            .Append("params")
            .Distinct(StringComparer.Ordinal)
            .OrderBy(text => text, StringComparer.Ordinal)
            .ToArray();
        string declarations = string.Join(
            Environment.NewLine,
            reserved.Select(word => $"    public int @{word};"));
        string references = string.Join(" + ", reserved.Select(word => $"this.@{word}"));
        string rendered = Render(
            $$"""
            public class ReservedAudit
            {
            {{declarations}}

                public int Sum() => {{references}};
            }
            """);

        foreach (string word in reserved)
        {
            Assert.Contains(word + "_", rendered, StringComparison.Ordinal);
            Assert.DoesNotContain($"var {word} ", rendered, StringComparison.Ordinal);
            Assert.DoesNotMatch(
                $@"\.{Regex.Escape(word)}(?![A-Za-z0-9_])",
                rendered);
        }

        TranslationTestValidation.AssertBinds(rendered);
    }

    private static void AssertNoStandaloneIdentifier(string rendered, string identifier)
    {
        Match match = Regex.Match(
            rendered,
            $@"(?<![A-Za-z0-9_]){Regex.Escape(identifier)}(?![A-Za-z0-9_])");
        Assert.False(match.Success, $"raw identifier '{identifier}' leaked into translated G#:\n{rendered}");
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Issue3461.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
