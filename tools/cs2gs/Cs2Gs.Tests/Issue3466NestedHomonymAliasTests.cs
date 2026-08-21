// <copyright file="Issue3466NestedHomonymAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3466NestedHomonymAliasTests
{
    [Fact]
    public void NestedDocInlineList_DoesNotAliasImportedGenericList()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            namespace Demo
            {
                public abstract record DocInline
                {
                    public sealed record List(string Value) : DocInline;
                }

                public static class Repro
                {
                    public static int Count()
                    {
                        var values = new List<string>();
                        values.Add("one");
                        return values.Count;
                    }
                }
            }
            """);

        Assert.Contains("import System.Collections.Generic", printed, StringComparison.Ordinal);
        Assert.Contains("List[string]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("import GenericList =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("public sealed class List { }")]
    [InlineData("public sealed class List<T> { }")]
    public void TopLevelListHomonym_UsesReadableAlias(string sourceDeclaration)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;

            namespace Demo
            {
                {{sourceDeclaration}}

                public static class Repro
                {
                    public static int Count()
                    {
                        var values = new System.Collections.Generic.List<string>();
                        values.Add("one");
                        return values.Count;
                    }
                }
            }
            """);

        Assert.Contains(
            "import GenericList = System.Collections.Generic.List",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("GenericList[string]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NonListMetadataHomonym_UsesGeneralReadableAliasPath()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class Repro
                {
                    public static int Length()
                    {
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length;
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("TextStringBuilder(\"one\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadableAlias_AvoidsExistingAliasAndSourceType()
    {
        string printed = Translate("""
            using GenericList = System.Text.StringBuilder;

            namespace Demo
            {
                public sealed class List
                {
                }

                public sealed class GenericList_2
                {
                }

                public static class Repro
                {
                    public static int Count()
                    {
                        var first = new System.Collections.Generic.List<int>();
                        var second = new System.Collections.Generic.List<int>();
                        first.Add(1);
                        second.Add(2);
                        return first.Count + second.Count;
                    }
                }
            }
            """);

        Assert.Contains(
            "import GenericList = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Equal(
            1,
            CountOccurrences(
                printed,
                "import GenericList_3 = System.Collections.Generic.List"));
        Assert.Equal(2, CountOccurrences(printed, "GenericList_3[int32]()"));
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }

    private static int CountOccurrences(string value, string search)
    {
        int count = 0;
        for (int index = value.IndexOf(search, StringComparison.Ordinal);
            index >= 0;
            index = value.IndexOf(search, index + search.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
