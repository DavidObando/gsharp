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
        // Issue #4932: assert after the check, so a missing root fails the
        // assertion (as in the C#) rather than throwing a NullReferenceException.
        let foundRoot = GsharpTestProjectRunner.FindRepoRoot()
        Assert.False(string.IsNullOrEmpty(foundRoot))
        let repoRoot = foundRoot!!
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
        let migrated = await SelfMigratedCompilerSource.LoadAsync(repoRoot, "src/Core", preservePartialParts: true)
        // Issue #4656: zero documents would count zero of everything and pass.
        Assert.NotEmpty(migrated)
        var doubledAssertions = 0
        var assertedParenthesizedReceivers = 0
        for file in migrated.Values {
            let printed = file.Text
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
        Assert.Contains("let receiver = value!!", printed, StringComparison.Ordinal)
        Assert.Contains("(delta int32) -> receiver.Measure(delta)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
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
    func SwitchWhenNullGuard_NarrowsSectionBodyAndSwitchExpression() {
        let source = `#nullable enable

public static class P
{
    public sealed class Box
    {
        public string Text = "ok";
        public string? Touch(System.Action cb)
        {
            cb();
            return Text;
        }
    }

    public static int MeasureStmt(int kind, string? value)
    {
        switch (kind)
        {
            case 1 when value is not null:
                return value.Length;
            default:
                return 0;
        }
    }

    public static int MeasureExpr(int kind, string? value) =>
        kind switch
        {
            1 when value != null => value.Length,
            _ => 0,
        };

    public static int MeasureConditionalAccess(int kind, string? value) =>
        kind switch
        {
            1 when value?.Length != null => value.Length,
            _ => 0,
        };

    public static int MeasureConditionalAccessMutated(int kind, bool drop)
    {
        Box? box = new Box();
        System.Action clear = () => { if (drop) box = null; };
        return kind switch
        {
            1 when box?.Touch(clear) != null => box!.Text.Length,
            _ => 0,
        };
    }

    public static int MeasureMultiLabel(int kind, string? value)
    {
        switch (kind)
        {
            case 1 when value is not null:
            case 2:
                return value!.Length;
            default:
                return 0;
        }
    }

    public static int MeasureMutatedInGuard(int kind, string? value, bool drop)
    {
        bool Clear()
        {
            if (drop) value = null;
            return true;
        }

        return kind switch
        {
            1 when value != null && Clear() => value!.Length,
            _ => 0,
        };
    }

    public static int MeasureClosureAssignedFieldConditionalAccess(int kind)
    {
        Box? box = new Box();
        System.Func<int> reader = () => (box?.Text ?? "").Length;
        return kind switch
        {
            1 when box?.Text != null => box.Text.Length,
            _ => reader(),
        };
    }

    public static int MeasureNestedConditionalAccessMutated(int kind, string? value, bool drop)
    {
        return kind switch
        {
            1 when (value?.Substring((drop ? (value = null) : null) == null ? 0 : 0))?.Length != null => value!.Length,
            _ => 0,
        };
    }

    public static int MeasureNestedMultiLabel(int outer, int inner, string? value)
    {
        switch (outer)
        {
            case 1 when value is not null:
            case 2:
                switch (inner)
                {
                    case 10:
                        return value!.Length;
                    default:
                        return 0;
                }
            default:
                return -1;
        }
    }

    public static int MeasureConditionalRelationalNotGuard(string? value)
    {
        if (value?.Length is not > 0 || value.Length > 10)
            return -1;
        return value.Length;
    }

    public static int MeasureConditionalIsTypeTestExpr(int kind, string? value)
    {
        return kind switch
        {
            1 when value?.Length is int => value.Length,
            _ => 0,
        };
    }

    public static int MeasureConditionalIsTypeTestStmt(int kind, string? value)
    {
        switch (kind)
        {
            case 1 when value?.Length is int:
                return value.Length;
            default:
                return 0;
        }
    }

    public static int MeasureConditionalIsTypeTestMutated(int kind, string? value, bool drop)
    {
        return kind switch
        {
            1 when (value?.Substring((drop ? (value = null) : null) == null ? 0 : 0))?.Length is int => value!.Length,
            _ => 0,
        };
    }

    public static string Run() =>
        MeasureStmt(1, "ab") + "|" +
        MeasureExpr(1, "abc") + "|" +
        MeasureConditionalAccess(1, "abcd") + "|" +
        MeasureConditionalAccess(1, null) + "|" +
        MeasureConditionalAccessMutated(1, false) + "|" +
        MeasureMultiLabel(1, "xy") + "|" +
        MeasureMultiLabel(2, "z") + "|" +
        MeasureMutatedInGuard(1, "q", false) + "|" +
        MeasureClosureAssignedFieldConditionalAccess(1) + "|" +
        MeasureNestedConditionalAccessMutated(1, "wxyz", false) + "|" +
        MeasureNestedMultiLabel(1, 10, "hi") + "|" +
        MeasureNestedMultiLabel(2, 10, "bye") + "|" +
        MeasureConditionalRelationalNotGuard("hello") + "|" +
        MeasureConditionalRelationalNotGuard(null) + "|" +
        MeasureConditionalIsTypeTestExpr(1, "abcde") + "|" +
        MeasureConditionalIsTypeTestStmt(1, "abcdef") + "|" +
        MeasureConditionalIsTypeTestMutated(1, "ab", false);
}`
        let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(
            "using System;\nnamespace Demo {\n" + source + "\n}",
            "2|3|4|0|2|2|1|1|2|4|2|3|5|-1|5|6|2",
            rejectRedundantAssertions: true
        )
        Assert.Contains(
            "case 1 when value != nil {\n                return value.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("case 1 when value != nil: value.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when value?.Length != nil: value.Length", printed, StringComparison.Ordinal)
        Assert.Contains("box!!.Text", printed, StringComparison.Ordinal)
        Assert.Contains("case 2 {\n                return value!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("&& Clear(): value!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when box?.Text != nil: box.Text.Length", printed, StringComparison.Ordinal)
        Assert.Contains(")?.Length != nil: value!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 10 {\n                        return value.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 10 {\n                        return value!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("value!!.Length > 10", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when value?.Length is int32: value.Length", printed, StringComparison.Ordinal)
        Assert.Contains(
            "case 1 when value?.Length is int32 {\n                return value.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains(")?.Length is int32: value!!.Length", printed, StringComparison.Ordinal)
    }

    @Fact
    func SwitchWhenNullGuard_ReadonlyFieldsAndStringGuards() {
        let source = `#nullable enable
using System;

namespace Demo
{
    public sealed class Holder
    {
        public readonly string? Text;
        public string? Mutable;

        public Holder(string? text, string? mutable)
        {
            Text = text;
            Mutable = mutable;
        }
    }

    public sealed class P
    {
        private readonly string? field;
        private string? mutableField;
        private static void Touch() { }

        public P(string? value, string? mutable)
        {
            field = value;
            mutableField = mutable;
        }

        public int Stmt(int kind)
        {
            switch (kind)
            {
                case 1 when field != null:
                    return field.Length;
                default:
                    return 0;
            }
        }

        public int Expr(int kind) =>
            kind switch
            {
                1 when field != null => field.Length,
                _ => 0,
            };

        public int ExprThisIsNotNull(int kind) =>
            kind switch
            {
                1 when this.field is not null => this.field.Length,
                _ => 0,
            };

        public int ExprNegatedEqualsNull(int kind) =>
            kind switch
            {
                1 when !(field == null) => field.Length,
                _ => 0,
            };

        public int ExprTypePattern(int kind) =>
            kind switch
            {
                1 when field is string => field.Length,
                _ => 0,
            };

        public int ExprConditionalAccess(int kind) =>
            kind switch
            {
                1 when field?.Length != null => field.Length,
                _ => 0,
            };

        public int QualifiedExpr(int kind, Holder holder) =>
            kind switch
            {
                1 when holder.Text != null => holder.Text.Length,
                _ => 0,
            };

        public int QualifiedStmt(int kind, Holder holder)
        {
            switch (kind)
            {
                case 1 when holder.Text != null:
                    return holder.Text.Length;
                default:
                    return 0;
            }
        }

        public int QualifiedConditionalIsInt(int kind, Holder holder) =>
            kind switch
            {
                1 when holder.Text?.Length is int => holder.Text.Length,
                _ => 0,
            };

        public int QualifiedNullableReceiverConditional(int kind, Holder? holder) =>
            kind switch
            {
                1 when holder?.Text != null => holder.Text.Length,
                _ => 0,
            };

        public int QualifiedStmtCallInvalidates(int kind, Holder holder)
        {
            switch (kind)
            {
                case 1 when holder.Text != null:
                    Touch();
                    return holder.Text!.Length;
                default:
                    return 0;
            }
        }

        public int QualifiedExprCallInvalidates(int kind, Holder holder) =>
            kind switch
            {
                1 when holder.Text != null => (Touch0() + holder.Text!.Length),
                _ => 0,
            };

        public int QualifiedMutableKeepsAssertion(int kind, Holder holder) =>
            kind switch
            {
                1 when holder.Mutable != null => holder.Mutable!.Length,
                _ => 0,
            };

        public int QualifiedNestedConditionalAccessExpr(int kind, Holder? holder) =>
            kind switch
            {
                1 when holder?.Text?.Length != null => holder.Text.Length,
                _ => 0,
            };

        public int QualifiedNestedConditionalAccessStmt(int kind, Holder? holder)
        {
            switch (kind)
            {
                case 1 when holder?.Text?.Length != null:
                    return holder.Text.Length;
                default:
                    return 0;
            }
        }

        public int QualifiedNestedConditionalAccessMutated(int kind, Holder? holder, bool drop) =>
            kind switch
            {
                1 when holder?.Text?.Substring((drop ? (holder = null) : null) == null ? 0 : 0) != null =>
                    holder!.Text!.Length,
                _ => 0,
            };

        public int QualifiedNestedDefaultLaterHeaderCallInvalidates(int kind, int inner, Holder holder)
        {
            switch (kind)
            {
                case 1 when holder.Text != null:
                    switch (inner)
                    {
                        default:
                            return holder.Text!.Length;
                        case 2 when TouchBool():
                            return 0;
                    }
                default:
                    return 0;
            }
        }

        public int ReadonlyFieldStringIsNullOrEmptyGuardExpr(int kind) =>
            kind switch
            {
                1 when !string.IsNullOrEmpty(field) => field.Length,
                _ => 0,
            };

        public int ReadonlyFieldStringIsNullOrEmptyGuardStmt(int kind)
        {
            switch (kind)
            {
                case 1 when !string.IsNullOrEmpty(field):
                    return field.Length;
                default:
                    return 0;
            }
        }

        public int QualifiedStringIsNullOrEmptyGuardExpr(int kind, Holder holder) =>
            kind switch
            {
                1 when !string.IsNullOrEmpty(holder.Text) => holder.Text.Length,
                _ => 0,
            };

        private static bool TouchBool()
        {
            Touch();
            return false;
        }

        public int MultiLabel(int kind)
        {
            switch (kind)
            {
                case 1 when field is not null:
                case 2:
                    return field!.Length;
                default:
                    return 0;
            }
        }

        public int StmtCallInvalidates(int kind)
        {
            switch (kind)
            {
                case 1 when field != null:
                    Touch();
                    return field!.Length;
                default:
                    return 0;
            }
        }

        public int ExprCallBeforeReadInvalidates(int kind) =>
            kind switch
            {
                1 when field != null => (Touch0() + field!.Length),
                _ => 0,
            };

        private static int Touch0()
        {
            Touch();
            return 0;
        }

        public int MutableFieldKeepsAssertion(int kind) =>
            kind switch
            {
                1 when mutableField != null => mutableField!.Length,
                _ => 0,
            };

        public static int StringIsNullOrEmptyGuard(int kind, string? s) =>
            kind switch
            {
                1 when !string.IsNullOrEmpty(s) => s.Length,
                _ => 0,
            };

        public static string Run()
        {
            var p = new P("abcd", "xy");
            var h = new Holder("abcde", "zw");
            return p.Stmt(1) + "|" +
                p.Expr(1) + "|" +
                p.ExprThisIsNotNull(1) + "|" +
                p.ExprNegatedEqualsNull(1) + "|" +
                p.ExprTypePattern(1) + "|" +
                p.ExprConditionalAccess(1) + "|" +
                p.QualifiedExpr(1, h) + "|" +
                p.QualifiedStmt(1, h) + "|" +
                p.QualifiedConditionalIsInt(1, h) + "|" +
                p.QualifiedNullableReceiverConditional(1, h) + "|" +
                p.QualifiedStmtCallInvalidates(1, h) + "|" +
                p.QualifiedExprCallInvalidates(1, h) + "|" +
                p.QualifiedMutableKeepsAssertion(1, h) + "|" +
                p.QualifiedNestedConditionalAccessExpr(1, h) + "|" +
                p.QualifiedNestedConditionalAccessStmt(1, h) + "|" +
                p.QualifiedNestedConditionalAccessMutated(1, h, false) + "|" +
                p.QualifiedNestedDefaultLaterHeaderCallInvalidates(1, 1, h) + "|" +
                p.ReadonlyFieldStringIsNullOrEmptyGuardExpr(1) + "|" +
                p.ReadonlyFieldStringIsNullOrEmptyGuardStmt(1) + "|" +
                p.QualifiedStringIsNullOrEmptyGuardExpr(1, h) + "|" +
                p.MultiLabel(1) + "|" +
                p.MultiLabel(2) + "|" +
                p.StmtCallInvalidates(1) + "|" +
                p.ExprCallBeforeReadInvalidates(1) + "|" +
                p.MutableFieldKeepsAssertion(1) + "|" +
                StringIsNullOrEmptyGuard(1, "hello");
        }
    }
}`
        let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(
            source,
            "4|4|4|4|4|4|5|5|5|5|5|5|2|5|5|5|5|4|4|5|4|4|4|4|2|5",
            rejectRedundantAssertions: true
        )
        Assert.Contains(
            "case 1 when field != nil {\n                return field.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("case 1 when field != nil: field.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when this.field != nil: this.field.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when !(field == nil): field.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when field is string: field.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when field?.Length != nil: field.Length", printed, StringComparison.Ordinal)
        Assert.Contains("case 1 when holder.Text != nil: holder.Text.Length", printed, StringComparison.Ordinal)
        Assert.Contains(
            "case 1 when holder.Text != nil {\n                return holder.Text.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "case 1 when holder.Text?.Length is int32: holder.Text.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("case 1 when holder?.Text != nil: holder.Text.Length", printed, StringComparison.Ordinal)
        Assert.Contains("Touch()\n                return holder.Text!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("Touch0() + holder.Text!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("holder.Mutable != nil: holder.Mutable!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains(
            "case 1 when holder?.Text?.Length != nil: holder.Text.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "case 1 when holder?.Text?.Length != nil {\n                return holder.Text.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("holder!!.Text!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains(
            "default {\n                        return holder.Text!!.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("case 1 when !string.IsNullOrEmpty(field): field.Length", printed, StringComparison.Ordinal)
        Assert.Contains(
            "case 1 when !string.IsNullOrEmpty(field) {\n                return field.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "case 1 when !string.IsNullOrEmpty(holder.Text): holder.Text.Length",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("case 2 {\n                return field!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("Touch()\n                return field!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("Touch0() + field!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("mutableField != nil: mutableField!!.Length", printed, StringComparison.Ordinal)
        Assert.Contains("!string.IsNullOrEmpty(s): s.Length", printed, StringComparison.Ordinal)
    }

    @Fact
    func SwitchWhenNullGuard_ObliviousSectionWritesAndGuardOrderFlow() {
        let source = `using System;

namespace Demo
{
    public static class P
    {
        private static int lastConsumed;
        private static int lastSafe;
        private static int lastNestedDefault;

        private static void Consume(string x)
        {
            lastConsumed = x == null ? -1 : x.Length;
        }

        private static void ConsumeNestedDefault(string x)
        {
            lastNestedDefault = x == null ? -1 : x.Length;
        }

        private static bool Observe(string x)
        {
            return x == null || x.Length >= 0;
        }

        private static void SafeConsume(string x)
        {
            lastSafe = x.Length;
        }

        public static int TestSectionWriteInvalidates(int kind, string s)
        {
            switch (kind)
            {
                case 1 when s != null:
                    s = null;
                    Consume(s);
                    break;
                case 2 when s != null:
                    SafeConsume(s);
                    break;
            }
            return lastConsumed + lastSafe;
        }

        public static int TestGuardOrderObserveBeforeNullCheck(int kind, string s)
        {
            switch (kind)
            {
                case 1 when Observe(s) && s != null:
                    return s.Length;
                default:
                    return -1;
            }
        }

        public static int TestSectionConditionalWriteKeepsAssertion(int kind, string s, bool drop)
        {
            switch (kind)
            {
                case 1 when s != null:
                    if (drop) s = null;
                    return s.Length;
                default:
                    return -1;
            }
        }

        public static int TestNestedDefaultLaterHeaderWriteInvalidates(int kind, int inner, string s)
        {
            switch (kind)
            {
                case 1 when s != null:
                    switch (inner)
                    {
                        default:
                            ConsumeNestedDefault(s);
                            break;
                        case 2 when (s = null) != null:
                            break;
                    }
                    break;
            }
            return lastNestedDefault;
        }

        public static string Run()
        {
            int a = TestSectionWriteInvalidates(1, "hi");
            int b = TestSectionWriteInvalidates(2, "abc");
            int c = TestGuardOrderObserveBeforeNullCheck(1, null);
            int d = TestGuardOrderObserveBeforeNullCheck(1, "xy");
            int e = TestSectionConditionalWriteKeepsAssertion(1, "abcd", false);
            int f = TestNestedDefaultLaterHeaderWriteInvalidates(1, 1, "hello");
            return a + "|" + b + "|" + c + "|" + d + "|" + e + "|" + f;
        }
    }
}`
        let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(
            source,
            "-1|2|-1|2|4|5",
            rejectRedundantAssertions: true
        )
        Assert.Contains("func Consume(x string?)", printed, StringComparison.Ordinal)
        Assert.Contains("func ConsumeNestedDefault(x string?)", printed, StringComparison.Ordinal)
        Assert.Contains("func Observe(x string?) bool", printed, StringComparison.Ordinal)
        Assert.Contains("func SafeConsume(x string)", printed, StringComparison.Ordinal)
        Assert.Contains("SafeConsume(s)", printed, StringComparison.Ordinal)
        Assert.Contains("return s!!.Length", printed, StringComparison.Ordinal)
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
