// <copyright file="CodeExploderTranslationTests.cs" company="GSharp">
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

/// <summary>
/// Targeted translator regressions discovered by the code-exploder corpus
/// integration tracked by issue #3395.
/// </summary>
public class CodeExploderTranslationTests
{
    [Fact]
    public void FlowNarrowedCollectionElement_IsAsserted()
    {
        string printed = TranslateUnit("""
            #nullable enable
            namespace Demo;

            public static class Args
            {
                public static string[] Build(string? gitRef)
                {
                    if (gitRef is null)
                    {
                        throw new System.ArgumentNullException(nameof(gitRef));
                    }

                    return ["--branch", gitRef];
                }
            }
            """);

        Assert.True(
            printed.Contains("""[]string{"--branch", gitRef!!}""", StringComparison.Ordinal),
            printed);
    }

    [Fact]
    public void NamedTupleExtendedPropertyPattern_UsesPositionalField()
    {
        string printed = TranslateUnit("""
            #nullable enable
            namespace Demo;

            public static class Summaries
            {
                public static bool HasProse((string Component, string ProseMd) summary) =>
                    summary is { ProseMd.Length: > 0 };
            }
            """);

        Assert.Contains("Item2", printed);
        Assert.DoesNotContain("ProseMd:", printed);
    }

    [Fact]
    public void FlowNarrowedAnonymousProperty_IsAsserted()
    {
        string printed = TranslateUnit("""
            #nullable enable
            namespace Demo;

            public sealed class Callout
            {
                public string? Md { get; init; }
            }

            public static class Renderer
            {
                public static string Render(Callout callout)
                {
                    if (callout is { Md: not null })
                    {
                        var value = new { md = callout.Md };
                        return value.md;
                    }

                    return "";
                }
            }
            """);

        Assert.True(
            printed.Contains("(callout.Md!!)", StringComparison.Ordinal),
            printed);
    }

    [Fact]
    public void NullableReferenceObjectCast_PreservesCoalesceType()
    {
        string printed = TranslateUnit("""
            #nullable enable
            namespace Demo;

            public static class Values
            {
                public static object DbValue(string? text) =>
                    (object?)text ?? System.DBNull.Value;
            }
            """);

        Assert.Contains("object?(text) ?? DBNull.Value", printed);
        Assert.DoesNotContain("let __cast", printed);
    }

    [Fact]
    public void NullableValueTypedNullCast_UsesDefault()
    {
        string printed = TranslateUnit("""
            #nullable enable
            namespace Demo;

            public static class Routes
            {
                public static object Build() => new { ParentId = (System.Guid?)null };
            }
            """);

        Assert.Contains("default(Guid?)", printed);
        Assert.DoesNotContain("Guid?(nil)", printed);
    }

    [Fact]
    public void NullableNamedTupleMemberBinding_UsesPositionalField()
    {
        string printed = TranslateUnit("""
            #nullable enable
            namespace Demo;

            public static class Summaries
            {
                public static string? Get((string ProseMd, string? Json)? summary) =>
                    summary?.ProseMd;
            }
            """);

        Assert.Contains("summary?.Item1", printed);
        Assert.DoesNotContain("summary?.ProseMd", printed);
    }

    [Fact]
    public void PrefixIncrementArgument_UsesAssignmentExpression()
    {
        string printed = TranslateUnit("""
            namespace Demo;

            public static class Events
            {
                private static void Publish(int sequence)
                {
                }

                public static void Send()
                {
                    var sequence = 0;
                    Publish(++sequence);
                }
            }
            """);

        Assert.True(
            printed.Contains(" += 1))", StringComparison.Ordinal),
            printed);
        Assert.DoesNotContain("Publish(++sequence)", printed);
    }

    [Fact]
    public void StringConstruction_UsesImportedClrTypeName()
    {
        string printed = TranslateUnit("""
            namespace Demo;

            public static class Text
            {
                public static string Build(char[] chars) => new string(chars);
            }
            """);

        Assert.Contains("String(chars)", printed);
        Assert.DoesNotContain("System.String(chars)", printed);
    }

    [Fact]
    public void VoidDelegateDiscardAssignment_EmitsRhsStatement()
    {
        string printed = TranslateUnit("""
            using System;
            using System.Threading.Tasks;

            namespace Demo;

            public static class Events
            {
                private static Task RelayAsync() => Task.CompletedTask;

                public static EventHandler Build() =>
                    (_, args) => _ = RelayAsync();
            }
            """);

        Assert.Contains("RelayAsync()", printed);
        Assert.DoesNotContain("_ = RelayAsync()", printed);
    }

    [Fact]
    public void BlockLambdaSingleUnderscoreParameter_IsRenamed()
    {
        string printed = TranslateUnit("""
            using System;
            using System.Threading.Tasks;

            namespace Demo;

            public static class Events
            {
                private static Task RelayAsync() => Task.CompletedTask;

                public static EventHandler Build() =>
                    (_, args) =>
                    {
                        _ = RelayAsync();
                    };
            }
            """);

        Assert.Contains("__underscore object", printed);
        Assert.Contains("RelayAsync()", printed);
        Assert.DoesNotContain("_ = RelayAsync()", printed);
    }

    private static string TranslateUnit(string source)
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
