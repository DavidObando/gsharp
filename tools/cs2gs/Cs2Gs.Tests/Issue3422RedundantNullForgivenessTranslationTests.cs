// <copyright file="Issue3422RedundantNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
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
        }

        Assert.Equal(0, doubledAssertions);
        Assert.InRange(assertedParenthesizedReceivers, 0, 8);
    }

    [Fact]
    public void InferredNonNullBindings_DoNotGainAssertions()
    {
        string printed = Translate(
            """
            #nullable enable

            using System.Collections.Generic;

            public static class C
            {
                private static void Consume(List<string> values, string text)
                {
                }

                public static int Measure(string? input, object value, bool flag)
                {
                    var fresh = new List<string>();
                    var fallback = input ?? "fallback";
                    var concatenated = "prefix:" + fallback;
                    var selected = flag ? concatenated : "other";
                    var narrowed = (string)value;

                    fresh.Add(fallback);
                    Consume(fresh, concatenated);
                    return fresh.Count
                        + fallback.Length
                        + concatenated.Length
                        + selected.Length
                        + narrowed.Length;
                }
            }
            """);

        Assert.DoesNotContain("fresh!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("fallback!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("concatenated!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("selected!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("narrowed!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(\"prefix:\" + fallback)!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[string](value)!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableAssignmentInitializer_KeepsRequiredLocalAssertion()
    {
        string printed = Translate(
            """
            #nullable enable

            public static class C
            {
                public static int Measure()
                {
                    string? sink = null;
                    var inferred = (sink = "text");
                    return inferred.Length;
                }
            }
            """);

        Assert.Contains("return inferred!!.Length", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceNullableExtensionMethodGroup_UsesReducedReceiverAtRuntime()
    {
        string printed = Translate(
            """
            #nullable enable

            using System;

            public static class Ext
            {
                public static int Measure(this string? value, int delta) =>
                    (value?.Length ?? 10) + delta;
            }

            public static class C
            {
                private static int Apply(Func<int, int> measure) => measure(2);

                public static int Run()
                {
                    string? value = null;
                    return Apply(value.Measure);
                }
            }
            """);

        Assert.Contains("return value.Measure(__arg0)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Ext.Measure", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("value!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("value.Measure(value", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "C.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void SourceNonNullableExtensionMethodGroup_UsesNormalReceiverLowering()
    {
        string printed = Translate(
            """
            #nullable enable

            using System;

            public static class Ext
            {
                public static int Measure(this string value, int delta) =>
                    value.Length + delta;
            }

            public static class C
            {
                private static int Apply(Func<int, int> measure) => measure(2);

                private static int Bind(string? value) => Apply(value.Measure);

                public static int Run() => Bind("abc");
            }
            """);

        Assert.Contains("let __spill0 = value!!", printed, StringComparison.Ordinal);
        Assert.Contains("return __spill0.Measure(__arg0)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Ext.Measure", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "C.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void EntryPointExtensionMethodGroup_DoesNotDuplicateReceiverAtRuntime()
    {
        string printed = Translate(
            """
            #nullable enable

            using System;

            public static class Program
            {
                public static bool Matches(this string value, string expected) =>
                    value == expected;

                private static bool Apply(Func<string, bool> matches) =>
                    matches("match");

                public static bool Run()
                {
                    string receiver = "match";
                    return Apply(receiver.Matches);
                }

                public static void Main()
                {
                    Console.WriteLine(Run());
                }
            }
            """);

        Assert.Contains("return receiver.Matches(__arg0)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "receiver.Matches(receiver, __arg0)",
            printed,
            StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(printed);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(
            $"True{Environment.NewLine}",
            result.Output.ReplaceLineEndings(Environment.NewLine));
    }

    [Fact]
    public void NonIteratorForEachElements_DoNotGainAssertions()
    {
        string printed = Translate(
            """
            #nullable enable

            using System.Collections.Generic;

            public static class C
            {
                public static int Measure(IEnumerable<string> values)
                {
                    var total = 0;
                    foreach (var value in values)
                    {
                        total += value.Length;
                    }

                    return total;
                }
            }
            """);

        Assert.Contains("for value in values", printed, StringComparison.Ordinal);
        Assert.Contains("total += value.Length", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("value!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void StaticExtensionMethodGroup_KeepsCapturedNonNullReceiver()
    {
        string printed = Translate(
            """
            #nullable enable

            using System.Collections.Generic;
            using System.Linq;

            public sealed class Item
            {
            }

            public static class C
            {
                public static int Remove(List<Item> values)
                {
                    var removed = values.ToArray();
                    return values.RemoveAll(removed.Contains);
                }
            }
            """);

        Assert.Contains(
            "Enumerable.Contains[Item](removed, __arg0)",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "Enumerable.Contains[Item](__arg0)",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void FlowProvenCheckedCast_ForgivesNullableOperandNotCastResult()
    {
        string printed = Translate(
            """
            #nullable enable

            using System;
            using System.Diagnostics.CodeAnalysis;
            using System.Reflection;

            public static class C
            {
                private static bool TryResolve([NotNullWhen(true)] out MethodInfo? method)
                {
                    method = typeof(string).GetMethod("ToString", Type.EmptyTypes);
                    return method is not null;
                }

                public static MethodBase Resolve()
                {
                    if (!TryResolve(out var method))
                    {
                        throw new InvalidOperationException();
                    }

                    return (MethodBase)method;
                }
            }
            """);

        Assert.Contains("cast[MethodBase](method!!)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[MethodBase](method)!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void LoopCarriedNullableLocal_KeepsRequiredAssertions()
    {
        string printed = Translate(
            """
            #nullable enable

            using System;

            public static class C
            {
                private static void Consume(Type type)
                {
                }

                public static void Walk(Type? type, int count)
                {
                    if (type is null)
                    {
                        return;
                    }

                    while (count-- > 0)
                    {
                        Consume(type);
                        type = type.BaseType ?? typeof(object);
                    }
                }
            }
            """);

        Assert.Contains("C.Consume(type_!!)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void IteratorForeachAndYield_KeepRequiredGenericTypeAssertions()
    {
        string printed = Translate(
            """
            #nullable enable

            using System.Collections.Generic;

            public static class C
            {
                public static IEnumerable<string> NonNullValues(IEnumerable<string?>? values)
                {
                    if (values is null)
                    {
                        yield break;
                    }

                    foreach (var value in values)
                    {
                        if (value is not null)
                        {
                            yield return value;
                        }
                    }
                }
            }
            """);

        Assert.Contains("for value in values!!", printed, StringComparison.Ordinal);
        Assert.Contains("yield value!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SyntheticAssertionRatchet_PreservesOnlyRequiredNullableForgiveness()
    {
        string printed = Translate(
            """
            #nullable enable

            using System.Collections.Generic;

            public static class C
            {
                private static string? Maybe() => null;

                public static int Measure(bool clear)
                {
                    string? explicitlyNullable = "text";
                    List<string>? mutable = new List<string>();
                    if (clear)
                    {
                        mutable = null;
                    }

                    return Maybe()!.Length
                        + explicitlyNullable!.Length
                        + mutable!.Count;
                }
            }
            """);

        Assert.Equal(1, CountOccurrences(printed, ")!!."));
        Assert.Equal(0, CountOccurrences(printed, "!!!!"));
        Assert.Contains("C.Maybe()!!.Length", printed, StringComparison.Ordinal);
        Assert.Contains("explicitlyNullable!!.Length", printed, StringComparison.Ordinal);
        Assert.Contains("mutable!!.Count", printed, StringComparison.Ordinal);
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
}
