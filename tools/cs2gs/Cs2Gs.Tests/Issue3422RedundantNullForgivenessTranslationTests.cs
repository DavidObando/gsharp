// <copyright file="Issue3422RedundantNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #3422's redundant null-forgiveness classes.
/// </summary>
public sealed class Issue3422RedundantNullForgivenessTranslationTests
{
    [Fact]
    public async Task CoreMigration_RedundantAssertionInventoryDoesNotRegress()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        Assert.False(string.IsNullOrEmpty(repoRoot));

        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "src", "Core", "Core.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            "Core should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator(preservePartialParts: true);
        int doubledAssertions = 0;
        int assertedParenthesizedReceivers = 0;
        int assertedAsConversions = 0;
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            string printed = GSharpPrinter.Print(
                translator.TranslateDocument(document, context));
            doubledAssertions += CountOccurrences(printed, "!!!!");
            assertedParenthesizedReceivers += CountOccurrences(printed, ")!!.");
            var tree = SyntaxTree.Parse(printed);
            Assert.Empty(tree.Diagnostics);
            assertedAsConversions += Descendants(tree.Root)
                .OfType<UnaryExpressionSyntax>()
                .Count(IsAssertedAsConversion);
        }

        Assert.Equal(0, doubledAssertions);
        Assert.Equal(9, assertedParenthesizedReceivers);
        Assert.Equal(0, assertedAsConversions);
    }

    [Fact]
    public void SwitchPropertyPatternBindings_UseNativeNonNullableDesignators()
    {
        string printed = Translate(
            """
            #nullable enable

            public abstract class Node
            {
            }

            public sealed class Leaf : Node
            {
                public string Text { get; init; } = "";
            }

            public sealed class Wrapper : Node
            {
                public Node? Child { get; init; }
            }

            public static class C
            {
                private static int Consume(Leaf leaf) => leaf.Text.Length;

                public static int Measure(Node node)
                {
                    switch (node)
                    {
                        case Wrapper { Child: Leaf leaf } wrapper:
                            return Consume(leaf) + wrapper.GetHashCode();
                        default:
                            return 0;
                    }
                }
            }
            """);

        Assert.Contains(
            "case Wrapper { Child: Leaf leaf } wrapper",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("return C.Consume(leaf) + wrapper.GetHashCode()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as Leaf", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(")!!.", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NativePatternBindingsAndSmartCastLocals_DoNotGainAssertions()
    {
        string printed = Translate(
            """
            #nullable enable

            public abstract class Node
            {
            }

            public sealed class Leaf : Node
            {
            }

            public sealed class Wrapper : Node
            {
                public Node? Child { get; init; }
            }

            public static class C
            {
                private static int Consume(Node node) => node.GetHashCode();

                public static bool InCondition(Node? node) =>
                    node is Wrapper wrapper
                    && Consume(wrapper) > 0
                    && node.GetHashCode() > 0;

                public static int AfterExitingIf(Node? node)
                {
                    if (node is not Wrapper { Child: Leaf leaf } wrapper)
                    {
                        return 0;
                    }

                    return Consume(leaf) + Consume(wrapper) + node.GetHashCode();
                }
            }
            """);

        Assert.DoesNotContain("wrapper!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("leaf!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("node!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ProvenNonNullSuppressions_AreElidedAndRequiredAssertionsRemain()
    {
        string printed = Translate(
            """
            #nullable enable

            public static class C
            {
                private static string? Maybe() => null;

                public static string Choose(bool flag, string left, string right) =>
                    (flag ? left : right)!;

                public static string Coalesce(string? left, string right) =>
                    (left ?? right)!;

                public static string RequiredCoalesce(string? first, string? second)
                {
                    if (first is null && second is null)
                    {
                        return "";
                    }

                    return (first ?? second)!;
                }

                public static int Required(object value) =>
                    Maybe()!.Length + (value as string)!.Length;

                public static int NullableValue(int? value) =>
                    value!.Value;
            }
            """);

        Assert.DoesNotContain("})!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(left ?? right)!!", printed, StringComparison.Ordinal);
        Assert.Contains("C.Maybe()!!.Length", printed, StringComparison.Ordinal);
        Assert.Contains("(value as string)!!.Length", printed, StringComparison.Ordinal);
        Assert.Contains("return (first ?? second)!!", printed, StringComparison.Ordinal);
        Assert.Contains("value!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ValuePositionIf_UsesTranslatedArmNullability()
    {
        string printed = Translate(
            """
            #nullable enable

            public static class C
            {
                public static string Narrowed(string? value) =>
                    value is not null ? value : "fallback";

                public static string Required(bool flag, string? value) =>
                    (flag ? value : "fallback")!;
            }
            """);

        Assert.Contains(
            "if value != nil { value } else { \"fallback\" }",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "(if value != nil { value } else { \"fallback\" })!!",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "(if flag { value } else { \"fallback\" })!!",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void TupleDeconstructionBetweenGuardAndUse_InvalidatesSmartCastNarrowing()
    {
        string printed = Translate(
            """
            #nullable enable

            public static class C
            {
                private static string? replacement;

                public static int TupleWrite(string? value)
                {
                    if (value is null || replacement is null)
                    {
                        return 0;
                    }

                    int marker = 0;
                    (value, marker) = (replacement, 1);
                    return value.Length;
                }
            }
            """);

        Assert.Contains("return value!!.Length", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SwitchWhenNullGuard_DoesNotNarrowSectionBody()
    {
        string printed = Translate(
            """
            #nullable enable

            public static class C
            {
                public static int Measure(int kind, string? value)
                {
                    switch (kind)
                    {
                        case 1 when value is not null:
                            return value.Length;
                        default:
                            return 0;
                    }
                }
            }
            """);

        Assert.Contains("case 1 when value != nil", printed, StringComparison.Ordinal);
        Assert.Contains("return value!!.Length", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", "using System;\n\nnamespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(
            document,
            context);
        string printed = GSharpPrinter.Print(unit);

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n"
                + string.Join("\n", result.Errors)
                + "\n\nPrinted:\n"
                + printed);
        return printed;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        for (int index = haystack.IndexOf(needle, StringComparison.Ordinal);
            index >= 0;
            index = haystack.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static bool IsAssertedAsConversion(UnaryExpressionSyntax unary)
    {
        if (unary.OperatorToken.Kind != SyntaxKind.BangBangToken)
        {
            return false;
        }

        ExpressionSyntax operand = unary.Operand;
        while (operand is ParenthesizedExpressionSyntax parenthesized)
        {
            operand = parenthesized.Expression;
        }

        return operand is AsExpressionSyntax;
    }

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        yield return node;
        foreach (SyntaxNode child in node.GetChildren())
        {
            foreach (SyntaxNode descendant in Descendants(child))
            {
                yield return descendant;
            }
        }
    }
}
