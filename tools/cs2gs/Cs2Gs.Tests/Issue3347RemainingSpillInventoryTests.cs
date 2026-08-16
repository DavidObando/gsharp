// <copyright file="Issue3347RemainingSpillInventoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Current-state synthetic-spill inventory for issue #3347.
/// </summary>
public sealed class Issue3347RemainingSpillInventoryTests
{
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
    public void RemainingSpills_AreRequiredCrossScopeCaptures()
    {
        string printed = Translate(
            """
            #nullable enable

            public sealed class Item
            {
                public int X;
                public int Y;
                public string? Name { get; set; }
            }

            public static class C
            {
                private static Item GetItem() => new Item();
                private static object GetValue() => 1;

                public static bool NestedBinding() =>
                    GetItem() is { X: var x, Y: > 0 } && x > 0;

                public static string Coalesce() =>
                    GetItem().Name ??= "default";

                public static int ReassignedBinder()
                {
                    if (GetValue() is int value)
                    {
                        value++;
                        return value;
                    }

                    return 0;
                }
            }
            """);

        Assert.Contains("__spill", printed, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "C.GetItem()"));
        Assert.Equal(1, CountOccurrences(printed, "C.GetValue()"));
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
