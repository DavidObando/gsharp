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
/// <para>
/// Issue #1896 update: a range-slice's start/end bounds are no longer
/// desugared to a double-embedding <c>.Slice(start, end - start)</c> call —
/// gsc's own native <c>recv[start..end]</c> range-index form embeds each
/// bound exactly once, in any context, with no spill needed at all. A
/// range-slice operand is therefore no longer a null-seam site by itself;
/// the helper lowering below remains reachable only via a non-trivial
/// <c>is</c>-pattern scrutinee (a range-slice nested inside one is simply
/// embedded once, as part of the scrutinee capture — see
/// <see cref="FieldInitializer_NestedNullSeamOperand_LowersCleanlyWithNoDanglingHelperCall"/>).
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
    public void FieldInitializer_RangeSliceSideEffectingOperand_LowersToNativeRangeIndex()
    {
        // Issue #1896 follow-up: a range-slice's native `recv[start..end]`
        // form embeds each bound exactly once regardless of context, so a
        // field initializer never needs the #1849 helper lowering for a
        // range-slice operand — that helper machinery only remains reachable
        // for a non-trivial `is`-pattern scrutinee (see the sibling
        // `PatternScrutineeSideEffectingReceiver` tests above).
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

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use
        Assert.Contains("Data[C.Next()..2]", printed);
        Assert.DoesNotContain(".Slice(", printed);
        Assert.DoesNotContain("__init0", printed);
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
    public void StaticPropertyInitializer_RangeSliceSideEffectingOperand_LowersToNativeRangeIndex()
    {
        // Issue #1896 follow-up: same as the field-initializer case above —
        // the native range-index form needs no helper here either.
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

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use
        Assert.Contains("Data[C.Next()..2]", printed);
        Assert.DoesNotContain(".Slice(", printed);
        Assert.DoesNotContain("__init0", printed);
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
    public void ThisConstructorArgument_RangeSliceSideEffectingOperand_LowersToNativeRangeIndex()
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

        // Issue #1896 follow-up: the delegating constructor's own parameters
        // (`s`, `j`) are already in scope at the `this(...)` argument list —
        // no helper is needed to thread them through, since the native
        // range-index form needs no helper at all here.
        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use
        Assert.Contains("init(s[C.Next()..j])", printed);
        Assert.DoesNotContain(".Slice(", printed);
        Assert.DoesNotContain("__init0", printed);
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

    /// <summary>
    /// Reviewer follow-up, re-verified after #1896: a null-seam operand
    /// nested inside another null-seam operand — here, the is-pattern
    /// scrutinee <c>Y[Z()..a]</c> is a range-slice whose start <c>Z()</c> is
    /// non-trivial. Before #1896, the range-slice's <c>.Slice</c> desugaring
    /// ALSO needed a single-evaluation spill of <c>Z()</c>, so this was two
    /// nested null-seam lowerings sharing one synthesized helper — and the
    /// inner spill's parameter name (<c>__p0</c>) leaking into the outer
    /// capture's own call-site argument was a genuine dangling-identifier
    /// hazard, guarded by bailing to the loud <c>Unsupported</c> diagnostic.
    /// #1896's native <c>recv[start..end]</c> range-index form embeds
    /// <c>Z()</c> exactly once with no spill of its own — the range-slice is
    /// no longer a null-seam site at all, only the outer <c>is</c>-pattern
    /// scrutinee is. So there is only ONE capture now (the whole
    /// <c>Y[Z()..a]</c> expression, captured as-is by the pattern-match
    /// helper), the dangling-<c>__p0</c> hazard this test guarded no longer
    /// exists, and the correct current behavior is a clean helper lowering
    /// with no <c>Unsupported</c> diagnostic.
    /// </summary>
    [Fact]
    public void FieldInitializer_NestedNullSeamOperand_LowersCleanlyWithNoDanglingHelperCall()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
namespace Demo
{
    public sealed class C
    {
        private static int[] Y = new int[] { 1, 2, 3, 4, 5 };

        private static int Z() => 1;

        private const int a = 3;

        private bool flag = Y[Z()..a] is [1, 2];
    }
}");

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        // The whole range-slice `Y[Z()..a]` is the single (only) capture, at
        // the call site, exactly once — no dangling `__p0` leaks into the
        // argument list itself (a `__p0` parameter name is fine INSIDE the
        // synthesized helper's own body/signature, since it is in scope
        // there).
        Assert.Contains("__init0(C.Y[C.Z()..C.a])", printed);
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
