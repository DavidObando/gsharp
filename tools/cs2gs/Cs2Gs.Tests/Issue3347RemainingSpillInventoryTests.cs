// <copyright file="Issue3347RemainingSpillInventoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Current-state synthetic-spill inventory for issue #3347.
/// </summary>
public sealed class Issue3347RemainingSpillInventoryTests
{
    /// <summary>
    /// Issue #3423 ratchet. Regenerated from <c>be857f02c4</c>, Core started
    /// with 16 <c>__castN</c> occurrences (8 block conversions), 22
    /// <c>__deconN</c> occurrences (11 temp names), and 17 <c>__using</c>
    /// declarations. Those families and issue #3347's <c>__spillN</c>
    /// declarations are now retired from Core output; the companion translator
    /// project ratchet below protects its independently verified zero-spill output.
    /// </summary>
    [Fact]
    public async Task CoreMigration_RemainingSynthesizedNameFamiliesStayRetired()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "src", "Core", "Core.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            "Core should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator(preservePartialParts: true);
        int castCount = 0;
        int deconstructionCount = 0;
        int spillCount = 0;
        int usingCount = 0;
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            string printed = GSharpPrinter.Print(
                translator.TranslateDocument(document, context));
            castCount += CountOccurrences(printed, "__cast");
            deconstructionCount += CountOccurrences(printed, "__decon");
            spillCount += CountOccurrences(printed, "let __spill");
            usingCount += CountOccurrences(printed, "__using");
        }

        Assert.Equal(0, castCount);
        Assert.Equal(0, deconstructionCount);
        Assert.Equal(0, spillCount);
        Assert.Equal(0, usingCount);
    }

    [Fact]
    public async Task TranslatorMigration_SpillFamilyStaysRetired()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(
                repoRoot,
                "tools",
                "cs2gs",
                "Cs2Gs.Translator",
                "Cs2Gs.Translator.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            "Translator should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator(preservePartialParts: true);
        int spillCount = 0;
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            string printed = GSharpPrinter.Print(
                translator.TranslateDocument(document, context));
            spillCount += CountOccurrences(printed, "let __spill");
        }

        Assert.Equal(0, spillCount);
    }

    [Fact]
    public void NonBindingPatterns_UseNativeBooleanPatterns()
    {
        string printed = Translate(
            """
            public sealed class Node
            {
                public object Value;
            }

            public static class C
            {
                private static object Get() => "abc";

                public static bool Match(Node node) =>
                    Get() is string { Length: > 0 } or int
                    && node.Value is not null;
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("C.Get() is string and { Length: > 0 } or int32", printed, StringComparison.Ordinal);
        Assert.Contains("node.Value != nil", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0166 / issue #3409: a top-level typed binder with a native property
    /// residual is a native pattern variable in both value and statement
    /// position, so neither surface needs the <c>if let</c> lowering (or a spill).
    /// </summary>
    [Fact]
    public void TopLevelPatternBinders_UseNativePatternVariablesAcrossValueAndStatementPositions()
    {
        string printed = Translate(
            """
            public static class C
            {
                private static object Get() => "abc";

                public static int Value() =>
                    Get() is string { Length: > 0 } text && text[0] == 'a'
                        ? text.Length
                        : 0;

                public static int Statement()
                {
                    if (Get() is string { Length: > 0 } text)
                    {
                        return text.Length;
                    }

                    return 0;
                }
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains(
            "if C.Get() is string { Length: > 0 } text && text[0] == 'a' { text.Length } else { 0 }",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("if C.Get() is string { Length: > 0 } text {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void IfLetResidualPatterns_PreserveNestedTypedConstraintsAcrossAllSurfaces()
    {
        string printed = Translate(
            """
            public sealed record Point(int X, int Y);
            public sealed record Shape(Point Center);

            public static class C
            {
                private static object Get() => new Shape(new Point(0, 1));

                public static int Value() =>
                    Get() is Shape { Center: Point(0, > 0) } shape
                        ? shape.Center.Y
                        : 0;

                public static int Statement()
                {
                    if (Get() is Shape { Center: Point(0, > 0) } shape)
                    {
                        return shape.Center.Y;
                    }

                    return 0;
                }

                public static int Loop()
                {
                    int result = 0;
                    while (Get() is Shape { Center: Point(0, > 0) } shape)
                    {
                        result = shape.Center.Y;
                        break;
                    }

                    return result;
                }

                public static bool Boolean() =>
                    Get() is Shape { Center: Point(0, > 0) } shape
                    && shape.Center.Y == 1;
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Equal(
            4,
            CountOccurrences(
                printed,
                "shape is { Center: Point and { X: 0, Y: > 0 } }"));
    }

    [Fact]
    public void NativeAssignmentExpressions_RemoveValueCarryingSpills()
    {
        string printed = Translate(
            """
            public sealed class Holder
            {
                private int value;
                private readonly int[] values = new int[1];

                public int P
                {
                    get => value;
                    set => this.value = value;
                }

                public int this[int index]
                {
                    set => values[index] = value;
                }
            }

            public static class C
            {
                private static int Echo(int value) => value;

                public static int Assign(Holder holder)
                {
                    int a = 0;
                    int b = 0;
                    a = b = Echo(holder.P = 5);
                    return holder[0] = a + b;
                }
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("a = (b = C.Echo((holder.P = 5)))", printed, StringComparison.Ordinal);
        Assert.Contains("return (holder[0] = a + b)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void VarPatternBindings_NoLongerRequireCrossScopeSpills()
    {
        string printed = Translate(
            """
            #nullable enable

            public sealed class Item
            {
                public int X;
                public int Y;
            }

            public static class C
            {
                private static Item GetItem() => new Item();

                public static bool NestedBinding() =>
                    GetItem() is { X: var x, Y: > 0 } && x > 0;
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("&& true", printed, StringComparison.Ordinal);
        Assert.Contains("C.GetItem() is { X: var x, Y: > 0 } && x > 0", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "C.GetItem()"));
    }

    [Fact]
    public void MutableNestedGuardBinder_UsesNativeMatchThenAuthorNamedStorage()
    {
        string printed = Translate(
            """
            using Microsoft.CodeAnalysis;
            using Microsoft.CodeAnalysis.CSharp.Syntax;
            using System.Linq;

            public static class C
            {
                public static bool IsAsLocal(ILocalSymbol local)
                {
                    if (local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                        is not VariableDeclaratorSyntax { Initializer.Value: { } initializer })
                    {
                        return false;
                    }

                    while (initializer is ParenthesizedExpressionSyntax parenthesized)
                    {
                        initializer = parenthesized.Expression;
                    }

                    return initializer is BinaryExpressionSyntax;
                }
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("&& true", printed, StringComparison.Ordinal);
        Assert.Contains("initializerMatch", printed, StringComparison.Ordinal);
        Assert.Contains("var initializer ExpressionSyntax = initializerMatch", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullabilityOnlyMethodGroupDifference_UsesDirectMemberReference()
    {
        string printed = Translate(
            """
            using System;
            using System.Diagnostics.CodeAnalysis;

            public sealed class Mapper
            {
                [return: NotNullIfNotNull(nameof(value))]
                public string? Map(string? value) => value;
            }

            public sealed class Holder
            {
                public Mapper Mapper { get; } = new Mapper();
            }

            public static class C
            {
                private static string Apply(string value, Func<string, string> map) => map(value);

                public static string Run(Holder holder, string value) =>
                    Apply(value, holder.Mapper.Map);
            }
            """);

        Assert.Contains("C.Apply(value, holder.Mapper.Map)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CoalesceAssignmentOnNontrivialTarget_RemainsRequiredSpill()
    {
        string printed = Translate(
            """
            #nullable enable

            public sealed class Item
            {
                public string? Name { get; set; }
            }

            public static class C
            {
                private static Item GetItem() => new Item();

                public static string Coalesce() =>
                    GetItem().Name ??= "default";
            }
            """);

        Assert.Contains("__spill", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "C.GetItem()"));
    }

    [Fact]
    public void AssignmentBodiedLambdas_PreserveValueOrDiscardContract()
    {
        string printed = Translate(
            """
            using System;

            public sealed class Holder
            {
                public int P { get; set; }
            }

            public static class C
            {
                public static int Run(Holder holder)
                {
                    Func<int> value = () => holder.P = 7;
                    Action discard = () => holder.P = 8;
                    int result = value();
                    discard();
                    return result + holder.P;
                }
            }
            """);

        Assert.Contains("-> (holder.P = 7)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NativePatternDelimitersAndElseIfBindings_RemainScoped()
    {
        string printed = Translate(
            """
            public enum Phase
            {
                Queued,
                Completed,
            }

            public sealed class Update
            {
                public double? Progress;
                public Phase Phase;
            }

            public static class C
            {
                private static object GetValue() => "ok";

                public static bool IsTerminal(Update update) =>
                    update.Progress is 0.0 or 1.0
                    || update.Phase is Phase.Queued or Phase.Completed;

                public static int ElseIf(bool first)
                {
                    if (first)
                    {
                        return 1;
                    }
                    else if (GetValue() is string text && text.Length > 0)
                    {
                        return text.Length;
                    }

                    return 0;
                }
            }
            """);

        Assert.Contains(
            "(update.Progress is 0.0 or 1.0) ||",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
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
}
