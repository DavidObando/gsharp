// <copyright file="Issue1849NullSeamHelperLoweringTests.cs" company="GSharp">
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
/// Regression tests for issue #1849: a follow-up to issue #1731 N1
/// (<see cref="Issue1731DoubleEvaluationTranslationTests"/>). A non-trivial
/// <c>is</c>-pattern scrutinee or range-slice start operand at a "null-seam"
/// expression context — a field/property initializer or a
/// <c>base(...)</c>/<c>this(...)</c> constructor-initializer argument — used
/// to have no G# lowering: G#'s grammar has no expression-only way to host a
/// spill <c>let</c> at those positions, so #1731 N1 settled for a LOUD
/// <c>Unsupported</c> diagnostic instead of silently double-evaluating the
/// operand.
/// <para>
/// The real fix sidesteps the grammar gap entirely: the whole null-seam
/// initializer/argument is lowered to a call to a synthesized <c>private
/// static</c> helper method — <c>__init0</c>, <c>__initN</c>, ... — added to
/// the declaring type's <c>shared {{ }}</c> block. The non-trivial operand(s)
/// become the helper's parameters, evaluated exactly once by the CALLER
/// (the null-seam site itself, which is a perfectly fine place to evaluate an
/// argument expression) and passed in; the pattern-match/range-slice logic
/// runs inside the helper body against the parameter, which is an ordinary
/// method body with a normal statement seam. No parser/grammar change is
/// needed, and the shape is no longer reported <c>Unsupported</c>.
/// </para>
/// </summary>
public class Issue1849NullSeamHelperLoweringTests
{
    [Fact]
    public void FieldInitializer_PatternScrutineeSideEffectingReceiver_LowersToHelper()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public sealed class C
    {
        private static A GetA() => new A();

        private bool flag = GetA() is { X: 1, Y: 2 };
    }
}");

        // The non-trivial receiver is evaluated exactly once: once as the
        // helper-call argument at the field initializer, and never again
        // inside the synthesized helper body (which reads its parameter
        // instead).
        Assert.Equal(2, CountOccurrences(printed, "GetA()")); // 1 declaration + 1 call-site use (was N-per-embed before the fix)
        Assert.Contains("__init0(", printed);
        Assert.Contains("private func __init0(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void FieldInitializer_RangeSliceSideEffectingOperand_LowersToHelper()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class C
    {
        private static int counter;

        private static int Next() => counter++;

        private static int[] Data = new int[] { 1, 2, 3, 4 };

        private int[] r = Data[Next()..2];
    }
}");

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use (was N-per-embed before the fix)
        Assert.Contains(".Slice(", printed);
        Assert.Contains("__init0(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void GetOnlyPropertyInitializer_PatternScrutineeSideEffectingReceiver_LowersToHelper()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class A
    {
        public int X;
    }

    public sealed class C
    {
        private static A GetA() => new A();

        public bool P { get; } = GetA() is { X: > 0 };
    }
}");

        Assert.Equal(2, CountOccurrences(printed, "GetA()")); // 1 declaration + 1 call-site use (was N-per-embed before the fix)
        Assert.Contains("__init0(", printed);
        Assert.Contains("private func __init0(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void StaticPropertyInitializer_RangeSliceSideEffectingOperand_LowersToHelper()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class C
    {
        private static int counter;

        private static int Next() => counter++;

        private static int[] Data = new int[] { 1, 2, 3, 4 };

        public static int[] R { get; } = Data[Next()..2];
    }
}");

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use (was N-per-embed before the fix)
        Assert.Contains(".Slice(", printed);
        Assert.Contains("__init0(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void BaseConstructorArgument_PatternScrutineeSideEffectingReceiver_LowersToHelper()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class A
    {
        public int X;
        public int Y;
    }

    public class Base
    {
        public Base(bool flag) { }
    }

    public sealed class Derived : Base
    {
        private static A GetA() => new A();

        public Derived() : base(GetA() is { X: 1, Y: 2 }) { }
    }
}");

        Assert.Equal(2, CountOccurrences(printed, "GetA()")); // 1 declaration + 1 call-site use (was N-per-embed before the fix)
        Assert.Contains(": base(__init0(", printed);
        Assert.Contains("private func __init0(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void ThisConstructorArgument_RangeSliceSideEffectingOperand_LowersToHelper()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class C
    {
        private static int counter;

        private static int Next() => counter++;

        public C(int[] r) { }

        public C(int[] s, int j) : this(s[Next()..j]) { }
    }
}");

        // `s` and `j` are the DELEGATING constructor's own parameters, not
        // field/static state — they must be threaded through as additional
        // (same-named) helper parameters alongside the genuinely captured
        // `Next()` operand, since a static helper method cannot otherwise see
        // them at all.
        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use (was N-per-embed before the fix)
        Assert.Contains(".Slice(", printed);
        Assert.Contains("__init0(s, j,", printed);
        Assert.Contains("private func __init0(s []int32, j int32,", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void MultipleNullSeamSitesInOneType_HelperNamesAreUnique()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class A
    {
        public int X;
    }

    public sealed class C
    {
        private static A GetA() => new A();

        private bool flag1 = GetA() is { X: 1 };
        private bool flag2 = GetA() is { X: 2 };
    }
}");

        Assert.Contains("__init0(", printed);
        Assert.Contains("__init1(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    [Fact]
    public void HelperName_UniquifiedAgainstExistingMember()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class A
    {
        public int X;
    }

    public sealed class C
    {
        private static A GetA() => new A();

        private static void __init0() { }

        private bool flag = GetA() is { X: 1 };
    }
}");

        // The existing `__init0` member is left alone; the synthesized helper
        // picks the next free name instead of colliding with it.
        Assert.Contains("private func __init0()", printed);
        Assert.Contains("__init1(", printed);
        Assert.Contains("private func __init1(", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// A trivial scrutinee/operand (a bare literal) needs no spill — and so no
    /// helper — regardless of the null-seam site; only a non-trivial (method-
    /// call/indexer/etc.) operand does. A qualified static-member read (e.g.
    /// <c>C.SharedA</c>) is NOT considered trivial by <c>IsTrivialOperand</c>
    /// (pre-existing #1731 behavior, unrelated to this fix) and so is still
    /// helper-lowered like any other non-trivial operand — a bare literal is
    /// used here to exercise the genuinely-no-spill-needed path instead.
    /// </summary>
    [Fact]
    public void FieldInitializer_TrivialPatternScrutinee_NoHelperSynthesized()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class C
    {
        private bool flag = 5 is > 0;
    }
}");

        Assert.DoesNotContain("__init0", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
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

    private static (string Printed, TranslationContext Context) TranslateUnitWithContext(string source)
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
