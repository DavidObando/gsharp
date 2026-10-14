// <copyright file="Issue3422RedundantNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Regression coverage for issue #3422's redundant null-forgiveness classes.
class Issue3422RedundantNullForgivenessTranslationTests {
    @Fact
    async func CoreMigration_RedundantAssertionInventoryDoesNotRegress() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        Assert.False(string.IsNullOrEmpty(repoRoot))
        if CommittedCompilerSource.IsGSharp(repoRoot) {
            // Issue #4656: after the cut-over the committed G# IS the
            // translation, and the same inventory is counted over it.
            var committedDoubled = 0
            var committedParenthesized = 0
            for file in CommittedCompilerSource.GSharpFiles(repoRoot, "src/Core") {
                let committed = StripCommentLines(File.ReadAllText(file))
                committedDoubled += CountOccurrences(committed, "!!!!")
                committedParenthesized += CountOccurrences(committed, ")!!.")
            }
            Assert.Equal(0, committedDoubled)
            Assert.InRange(committedParenthesized, 0, 9)
            return
        }
        let project = await CSharpProjectLoader.LoadProjectAsync(Path.Combine(repoRoot, "src", "Core", "Core.csproj"))
        Assert.True(
            project.BoundWithoutErrors,
            "Core should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        // Issue #4656: zero documents would count zero of everything and pass.
        Assert.NotEmpty(project.Documents)
        let translator = CSharpToGSharpTranslator(preservePartialParts: true)
        var doubledAssertions = 0
        var assertedParenthesizedReceivers = 0
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            // Issue #3469: author comments now flow into the emitted G#,
            // and Core-source comments mention the very patterns this
            // inventory counts — count code lines only.
            let code = StripCommentLines(printed)
            doubledAssertions += CountOccurrences(code, "!!!!")
            assertedParenthesizedReceivers += CountOccurrences(code, ")!!.")
        }
        Assert.Equal(0, doubledAssertions)
        Assert.InRange(assertedParenthesizedReceivers, 0, 9)
    }

    @Fact
    func InferredNonNullBindings_DoNotGainAssertions() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.DoesNotContain("fresh!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("fallback!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("concatenated!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("selected!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("narrowed!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(\"prefix:\" + fallback)!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("cast[string](value)!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func NullableAssignmentInitializer_KeepsRequiredLocalAssertion() {
        let printed = Translate(`#nullable enable

public static class C
{
    public static int Measure()
    {
        string? sink = null;
        var inferred = (sink = "text");
        return inferred.Length;
    }
}`)
        Assert.Contains("return inferred!!.Length", printed, StringComparison.Ordinal)
    }

    @Fact
    func SourceNullableExtensionMethodGroup_UsesReducedReceiverAtRuntime() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("(delta int32) -> value.Measure(delta)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Ext.Measure", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("value!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("value.Measure(value", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func CrossNamespaceExactExtensionMethodGroup_GlobalUsingSynthesizesImport() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Extensions.cs", `#nullable enable
namespace Acme.Extensions;

public static class Ext
{
    public static int Measure(this string? value, int delta) =>
        (value?.Length ?? 10) + delta;
}`), ("GlobalUsings.cs", "global using Acme.Extensions;"), ("Consumer.cs", `#nullable enable
using System;
namespace Demo;

public static class C
{
    private static int Apply(Func<int, int> measure) => measure(2);

    public static int Run()
    {
        string? value = null;
        return Apply(value.Measure);
    }
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let translator = CSharpToGSharpTranslator()
        let TranslateDocument = func (fileName string) string {
            let document = project.Documents.Single(
                (candidate LoadedDocument) -> Path.GetFileName(candidate.FilePath) == fileName
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return printed
        }
        let extensions = TranslateDocument("Extensions.cs")
        let consumer = TranslateDocument("Consumer.cs")
        Assert.Contains("import Acme.Extensions", consumer, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(extensions, consumer)
    }

    @Fact
    func SourceNonNullableExtensionMethodGroup_UsesNormalReceiverLowering() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("let __spill0 = value!!", printed, StringComparison.Ordinal)
        Assert.Contains("(delta int32) -> __spill0.Measure(delta)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Ext.Measure", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func EntryPointExtensionMethodGroup_DoesNotDuplicateReceiverAtRuntime() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("(expected string) -> receiver.Matches(expected)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("receiver.Matches(receiver, expected)", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed)
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal("True${Environment.NewLine}", result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func NonIteratorForEachElements_DoNotGainAssertions() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("for value in values", printed, StringComparison.Ordinal)
        Assert.Contains("total += value.Length", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("value!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func StaticExtensionMethodGroup_KeepsCapturedNonNullReceiver() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("Enumerable.Contains[Item](removed, value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Enumerable.Contains[Item](value)", printed, StringComparison.Ordinal)
    }

    @Fact
    func FlowProvenCheckedCast_ForgivesNullableOperandNotCastResult() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("cast[MethodBase](method!!)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("cast[MethodBase](method)!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func LoopCarriedNullableLocal_KeepsRequiredAssertions() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("Consume(type!!)", printed, StringComparison.Ordinal)
    }

    @Fact
    func IteratorForeachAndYield_KeepRequiredGenericTypeAssertions() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("for value in values!!", printed, StringComparison.Ordinal)
        Assert.Contains("yield value!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func SyntheticAssertionRatchet_PreservesOnlyRequiredNullableForgiveness() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Equal(1, CountOccurrences(printed, ")!!."))
        Assert.Equal(0, CountOccurrences(printed, "!!!!"))
        Assert.Contains("Maybe()!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("explicitlyNullable!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("mutable!!.Count", printed, StringComparison.Ordinal)
    }

    @Fact
    func SwitchPropertyPatternBindings_UseNativeNonNullableDesignators() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("case Wrapper { Child: Leaf leaf } wrapper", printed, StringComparison.Ordinal)
        Assert.Contains("return Consume(leaf) + wrapper.GetHashCode()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(" as Leaf", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(")!!.", printed, StringComparison.Ordinal)
    }

    @Fact
    func NativePatternBindingsAndSmartCastLocals_DoNotGainAssertions() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.DoesNotContain("wrapper!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("leaf!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("node!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func ProvenNonNullSuppressions_AreElidedAndRequiredAssertionsRemain() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.DoesNotContain("})!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(left ?? right)!!", printed, StringComparison.Ordinal)
        Assert.Contains("Maybe()!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("(value as string)!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("return (first ?? second)!!", printed, StringComparison.Ordinal)
        Assert.Contains("value!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func ValuePositionIf_UsesTranslatedArmNullability() {
        let printed = Translate(`#nullable enable

public static class C
{
    public static string Narrowed(string? value) =>
        value is not null ? value : "fallback";

    public static string Required(bool flag, string? value) =>
        (flag ? value : "fallback")!;
}`)
        Assert.Contains("if value != nil { value } else { \"fallback\" }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(if value != nil { value } else { \"fallback\" })!!", printed, StringComparison.Ordinal)
        Assert.Contains("(if flag { value } else { \"fallback\" })!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func TupleDeconstructionBetweenGuardAndUse_InvalidatesSmartCastNarrowing() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("return value!!.Length", printed, StringComparison.Ordinal)
    }

    @Fact
    func SwitchWhenNullGuard_DoesNotNarrowSectionBody() {
        let printed = Translate(`#nullable enable

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
}`)
        Assert.Contains("case 1 when value != nil", printed, StringComparison.Ordinal)
        Assert.Contains("return value!!.Length", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `using System;

namespace Demo
{
` + source + `
}
`)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }

        private func StripCommentLines(printed string) string -> string.Join(
            "\n",
            printed.Split('\n').Where(
                (line string) -> {
                    let trimmed = line.TrimStart()
                    return !trimmed.StartsWith("//", StringComparison.Ordinal)
                }
            )
        )

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }
    }
}
