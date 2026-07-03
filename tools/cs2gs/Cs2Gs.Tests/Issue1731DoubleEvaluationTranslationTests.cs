// <copyright file="Issue1731DoubleEvaluationTranslationTests.cs" company="GSharp">
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
/// Regression tests for issue #1731: several lowerings re-embedded the SAME
/// translated operand at two output positions instead of translating it once
/// — a chained assignment's inner target (once as the write, once as the next
/// link's read), an <c>is</c>-pattern's scrutinee (once per sub-pattern/binder
/// reference), and a range-slice's start operand (once as the <c>Slice</c>
/// argument, once inside the length computation). When the operand has a side
/// effect (a method call, an increment) or reads a mutable value, duplicating
/// it silently changes C# semantics by running it twice. The fix spills any
/// non-trivial operand into a single <c>let</c> via a shared helper and
/// references the local at both positions, while a bare local/<c>this</c>/
/// literal operand is left untouched (no spurious temp). Every snippet must
/// round-trip through the real G# parser.
///
/// The original <c>lock</c> double-evaluation cases (target embedded once for
/// <c>Monitor.Enter</c>, once for <c>Monitor.Exit</c>) are now moot: G# has a
/// first-class <c>lock</c> keyword (issue #1885), so the translator emits the
/// target expression exactly once and single-evaluation is gsc's job, not the
/// translator's — see <see cref="Issue1885LockStatementTranslationTests"/>.
/// </summary>
public class Issue1731DoubleEvaluationTranslationTests
{
    [Fact]
    public void ChainedAssignment_SideEffectingIndexTarget_EvaluatesIndexOnce()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call

        // Both writes must still happen: the inner element write, and the
        // outer read of the same (now spilled) target back into `a`.
        Assert.Contains("= 5", printed);
        Assert.Contains("a =", printed);
    }

    [Fact]
    public void ChainedAssignment_SimpleLocalTargets_NoUnnecessaryTemp()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.DoesNotContain("__spill", printed);
    }

    [Fact]
    public void PatternScrutinee_RecursivePattern_SideEffectingReceiver_EvaluatesOnce()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Equal(2, CountOccurrences(printed, "GetA()")); // 1 declaration + 1 call
    }

    [Fact]
    public void PatternScrutinee_PropertyPathReceiverWithSideEffect_EvaluatesOnce()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Equal(2, CountOccurrences(printed, "GetB()")); // 1 declaration + 1 call
    }

    [Fact]
    public void PatternScrutinee_OrCombinatorWithSideEffectingReceiver_EvaluatesOnce()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call
    }

    [Fact]
    public void PatternScrutinee_SimpleLocal_NoUnnecessaryTemp()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.DoesNotContain("__spill", printed);
    }

    [Fact]
    public void RangeSliceStart_SideEffectingOperand_EvaluatesOnce()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call
        Assert.Contains(".Slice(", printed);
    }

    /// <summary>
    /// A sibling of the named pattern-scrutinee site: an expression-bodied
    /// LAMBDA (<c>x => x.GetB() is { X: 1, Y: 2 }</c>) has no statement seam of
    /// its own, so a naive "suspend the ambient seam across the closure
    /// boundary" fix (needed to stop a spill from leaking into the ENCLOSING
    /// statement) would also silently disable the fix for this shape. The
    /// lambda must open its OWN seam and, if anything spills, become
    /// block-bodied with an explicit <c>return</c> so the spill still
    /// evaluates once PER INVOCATION, inside the lambda.
    /// </summary>
    [Fact]
    public void PatternScrutinee_InsideExpressionBodiedLambda_EvaluatesReceiverOnce()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Equal(2, CountOccurrences(printed, "GetB()")); // 1 declaration + 1 call
    }

    [Fact]
    public void RangeSliceStart_SimpleLocal_NoUnnecessaryTemp()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.DoesNotContain("__spill", printed);
    }

    // --- N1: null-seam expression contexts (field/property initializers and
    // base(...)/this(...) constructor-call arguments have no ambient
    // statement seam of their own, AND — unlike a lambda/local-function body
    // — G# has no expression-only way to host a spill `let` there at all: a
    // bare block-with-trailing-expression is only legal directly inside a
    // lambda arrow body or an if/else branch, and G# has no "invoke an
    // arbitrary parenthesized expression" postfix form to smuggle one in as
    // an immediately-invoked lambda either. #1731 settled for REPORTING the
    // gap (TranslationSeverity.Unsupported) instead of silently
    // double-evaluating. Issue #1849 closes the gap for real: the whole
    // null-seam initializer/argument is lowered to a call to a synthesized
    // private static helper method, so the non-trivial operand is evaluated
    // exactly once (by the caller, as the helper-call argument) instead of
    // re-embedded — see Issue1849NullSeamHelperLoweringTests for the full
    // helper-lowering coverage (all four sites, static-vs-instance/ctor-
    // parameter passthrough, name uniquification). These four cases are kept
    // here, updated to assert the fixed behavior, since they are the exact
    // reproducers #1731 N1 originally reported as unsupported.) ------------

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

        // Issue #1849: the field initializer is lowered to a call to a
        // synthesized private static helper, so `GetA()` is evaluated exactly
        // once (as the helper-call argument) instead of once per sub-pattern
        // test (the #1731 N1 gap this used to report as Unsupported).
        Assert.Equal(2, CountOccurrences(printed, "GetA()")); // 1 declaration + 1 call-site use
        Assert.Contains("__init0(", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("1731 N1"));
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

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use
        Assert.Contains(".Slice(", printed);
        Assert.Contains("__init0(", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("1731 N1"));
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

        Assert.Equal(2, CountOccurrences(printed, "GetA()")); // 1 declaration + 1 call-site use
        Assert.Contains(": base(__init0(", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("1731 N1"));
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

        Assert.Equal(2, CountOccurrences(printed, "Next()")); // 1 declaration + 1 call-site use
        Assert.Contains(".Slice(", printed);
        Assert.Contains("__init0(", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("1731 N1"));
    }

    /// <summary>
    /// Documents the N1 safety argument for attribute arguments and default
    /// parameter values (see <c>MapAttributeArgumentValue</c> and
    /// <c>BuildOptionalParameterDefault</c> doc comments): C# requires both to
    /// be compile-time constants, and neither an <c>is</c>-pattern nor a
    /// range-slice is ever a constant expression — so those two "null-seam"
    /// sites can never actually reach <c>SpillOperand</c>'s no-seam fallback,
    /// and no diagnostic is expected for this ordinary constant case.
    /// </summary>
    [Fact]
    public void AttributeArgumentAndDefaultParameter_ConstantOperand_TranslatesUnaffected()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
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
}");

        Assert.Contains("42", printed);
        Assert.Contains("7", printed);
        Assert.DoesNotContain("__spill", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.Message.Contains("1731 N1"));
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

    private static string TranslateUnit(string source) => TranslateUnitWithContext(source).Printed;

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
