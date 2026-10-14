// <copyright file="Issue1731DoubleEvaluationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Regression tests for issue #1731: several lowerings re-embedded the SAME
/// translated operand at two output positions instead of translating it once
/// — a chained assignment's inner target (once as the write, once as the next
/// link's read), an `is`-pattern's scrutinee (once per sub-pattern/binder
/// reference), and a range-slice's start operand (once as the `Slice`
/// argument, once inside the length computation). When the operand has a side
/// effect (a method call, an increment) or reads a mutable value, duplicating
/// it silently changes C# semantics by running it twice. The fix spills any
/// non-trivial operand into a single `let` via a shared helper and
/// references the local at both positions, while a bare local/`this`/
/// literal operand is left untouched (no spurious temp). Every snippet must
/// round-trip through the real G# parser.
///
/// The original `lock` double-evaluation cases (target embedded once for
/// `Monitor.Enter`, once for `Monitor.Exit`) are now moot: G# has a
/// first-class `lock` keyword (issue #1885), so the translator emits the
/// target expression exactly once and single-evaluation is gsc's job, not the
/// translator's — see (cref:Issue1885LockStatementTranslationTests).
open class Issue1731DoubleEvaluationTranslationTests {
    @Fact
    func ChainedAssignment_SideEffectingIndexTarget_EvaluatesIndexOnce() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        private int[] buf = new int[10];
        private int counter;

        private int Next() => counter++;

        public void M()
        {
            int a;
            a = buf[Next()] = 5;
            System.Console.WriteLine(a);
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "Next()")) // 1 declaration + 1 call
        // Both writes must still happen: the inner element write, and the
        // outer read of the same (now spilled) target back into `a`.
        Assert.Contains("= 5", printed)
        Assert.Contains("a =", printed)
    }

    @Fact
    func ChainedAssignment_SimpleLocalTargets_NoUnnecessaryTemp() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int a, b, c;
            a = b = c = 5;
            System.Console.WriteLine(a + b + c);
        }
    }
}`)
        Assert.DoesNotContain("__spill", printed)
    }

    @Fact
    func PatternScrutinee_RecursivePattern_SideEffectingReceiver_EvaluatesOnce() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class B
    {
        public int X;
        public int Y;
    }

    public sealed class A
    {
        public B B;
    }

    public sealed class C
    {
        private static A GetA() => new A();

        public void M()
        {
            if (GetA() is { B: { X: 1, Y: 2 } })
            {
                System.Console.WriteLine(1);
            }
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetA()")) // 1 declaration + 1 call

    }

    @Fact
    func PatternScrutinee_PropertyPathReceiverWithSideEffect_EvaluatesOnce() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class B
    {
        public int X;
        public int Y;
    }

    public sealed class A
    {
        public B GetB() => new B();
    }

    public sealed class C
    {
        public void M(A a)
        {
            if (a.GetB() is { X: 1, Y: 2 })
            {
                System.Console.WriteLine(1);
            }
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetB()")) // 1 declaration + 1 call

    }

    @Fact
    func PatternScrutinee_OrCombinatorWithSideEffectingReceiver_EvaluatesOnce() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        private static int Next() => 1;

        public void M()
        {
            if (Next() is 1 or 2)
            {
                System.Console.WriteLine(1);
            }
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "Next()")) // 1 declaration + 1 call

    }

    @Fact
    func PatternScrutinee_SimpleLocal_NoUnnecessaryTemp() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class B
    {
        public int X;
        public int Y;
    }

    public sealed class A
    {
        public B B;
    }

    public sealed class C
    {
        public void M(A a)
        {
            if (a is { B: { X: 1, Y: 2 } })
            {
                System.Console.WriteLine(1);
            }
        }
    }
}`)
        Assert.DoesNotContain("__spill", printed)
    }

    @Fact
    func RangeSliceStart_SideEffectingOperand_EvaluatesOnce() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        private int counter;

        private int Next() => counter++;

        public void M(int[] s, int j)
        {
            int[] r = s[Next()..j];
            System.Console.WriteLine(r.Length);
        }
    }
}`)
        // Issue #1896: the native `recv[start..end]` range-index form embeds
        // `Next()` exactly once with no `.Slice` desugaring/spill needed.
        Assert.Equal(2, CountOccurrences(printed, "Next()")) // 1 declaration + 1 call
        Assert.Contains("s[Next()..j]", printed)
        Assert.DoesNotContain(".Slice(", printed)
    }

    /// A sibling of the named pattern-scrutinee site: an expression-bodied
    /// LAMBDA (`x => x.GetB() is { X: 1, Y: 2 }`) has no statement seam of
    /// its own, so a naive "suspend the ambient seam across the closure
    /// boundary" fix (needed to stop a spill from leaking into the ENCLOSING
    /// statement) would also silently disable the fix for this shape. The
    /// lambda must open its OWN seam and, if anything spills, become
    /// block-bodied with an explicit `return` so the spill still
    /// evaluates once PER INVOCATION, inside the lambda.
    @Fact
    func PatternScrutinee_InsideExpressionBodiedLambda_EvaluatesReceiverOnce() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public sealed class B
    {
        public int X;
        public int Y;
    }

    public sealed class A
    {
        public B GetB() => new B();
    }

    public sealed class C
    {
        public void M(A a)
        {
            Func<A, bool> f = x => x.GetB() is { X: 1, Y: 2 };
            System.Console.WriteLine(f(a));
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetB()")) // 1 declaration + 1 call

    }

    @Fact
    func RangeSliceStart_SimpleLocal_NoUnnecessaryTemp() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public void M(int[] s, int i, int j)
        {
            int[] r = s[i..j];
            System.Console.WriteLine(r.Length);
        }
    }
}`)
        Assert.DoesNotContain("__spill", printed)
    }

    // --- N1: null-seam expression contexts (field/property initializers and
    // base(...)/this(...) constructor-call arguments have no ambient
    // statement seam of their own. #1731 settled for REPORTING the gap
    // (TranslationSeverity.Unsupported) instead of silently double-evaluating.
    // Issue #3355 closes the gap with a native G# block
    // expression: spill `let` statements and the translated value stay at
    // the original initializer/argument site, with no synthesized helper or
    // expression-type dependency. Issue #1896 separately closed
    // the range-slice half of the original N1 gap a different way: the
    // native `recv[start..end]` range-index form embeds each bound exactly
    // once in ANY context, so a range-slice null-seam operand no longer
    // needs a block spill at all — see the two
    // RangeSlice* cases below, kept here as the exact reproducers #1731 N1
    // originally reported as unsupported, updated to assert the current
    // native-form behavior. ------------------------------------------------
    @Fact
    func FieldInitializer_PatternScrutineeSideEffectingReceiver_LowersToNativeBlock() {
        let (printed, context) = TranslateUnitWithContext(`
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
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetA()")) // 1 declaration + 1 call-site use
        Assert.Contains("GetA() is { X: 1, Y: 2 }", printed)
        Assert.DoesNotContain("__spill", printed)
        Assert.DoesNotContain("__init", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "1731 N1"
            )
        )
    }

    @Fact
    func FieldInitializer_RangeSliceSideEffectingOperand_LowersToNativeRangeIndex() {
        let (printed, context) = TranslateUnitWithContext(`
namespace Demo
{
    public sealed class C
    {
        private static int counter;

        private static int Next() => counter++;

        private static int[] Data = new int[] { 1, 2, 3, 4 };

        private int[] r = Data[Next()..2];
    }
}`)
        // Issue #1896: no helper needed — the native range-index form
        // already embeds `Next()` exactly once.
        Assert.Equal(2, CountOccurrences(printed, "Next()")) // 1 declaration + 1 call-site use
        Assert.Contains("Data[Next()..2]", printed)
        Assert.DoesNotContain(".Slice(", printed)
        Assert.DoesNotContain("__init0(", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "1731 N1"
            )
        )
    }

    @Fact
    func BaseConstructorArgument_PatternScrutineeSideEffectingReceiver_LowersToNativeBlock() {
        let (printed, context) = TranslateUnitWithContext(`
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
}`)
        Assert.Equal(2, CountOccurrences(printed, "GetA()")) // 1 declaration + 1 call-site use
        Assert.Contains(": base(", printed)
        Assert.Contains("GetA() is { X: 1, Y: 2 }", printed)
        Assert.DoesNotContain("__spill", printed)
        Assert.DoesNotContain("__init", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "1731 N1"
            )
        )
    }

    @Fact
    func ThisConstructorArgument_RangeSliceSideEffectingOperand_LowersToNativeRangeIndex() {
        let (printed, context) = TranslateUnitWithContext(`
namespace Demo
{
    public sealed class C
    {
        private static int counter;

        private static int Next() => counter++;

        public C(int[] r) { }

        public C(int[] s, int j) : this(s[Next()..j]) { }
    }
}`)
        // Issue #1896: no helper needed — `s`/`j` are already in scope at
        // the `this(...)` argument list, and the native range-index form
        // already embeds `Next()` exactly once.
        Assert.Equal(2, CountOccurrences(printed, "Next()")) // 1 declaration + 1 call-site use
        Assert.Contains("init(s[Next()..j])", printed)
        Assert.DoesNotContain(".Slice(", printed)
        Assert.DoesNotContain("__init0(", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "1731 N1"
            )
        )
    }

    /// Documents the N1 safety argument for attribute arguments and default
    /// parameter values (see `MapAttributeArgumentValue` and
    /// `BuildOptionalParameterDefault` doc comments): C# requires both to
    /// be compile-time constants, and neither an `is`-pattern nor a
    /// range-slice is ever a constant expression — so those two "null-seam"
    /// sites can never actually reach `SpillOperand`'s no-seam fallback,
    /// and no diagnostic is expected for this ordinary constant case.
    @Fact
    func AttributeArgumentAndDefaultParameter_ConstantOperand_TranslatesUnaffected() {
        let (printed, context) = TranslateUnitWithContext(`
namespace Demo
{
    public sealed class MyAttribute : System.Attribute
    {
        public MyAttribute(int value) { }
    }

    [My(42)]
    public sealed class C
    {
        public void M(int x = 7) { }
    }
}`)
        Assert.Contains("42", printed)
        Assert.Contains("7", printed)
        Assert.DoesNotContain("__spill", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.Message!!.Contains("1731 N1"))
    }

    shared {
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

        private func TranslateUnit(source string) string -> TranslateUnitWithContext(source).Printed

        private func TranslateUnitWithContext(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
