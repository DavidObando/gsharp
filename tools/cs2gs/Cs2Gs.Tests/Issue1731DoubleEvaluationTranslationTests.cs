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
/// — a <c>lock (target)</c>'s target (once for <c>Monitor.Enter</c>, once for
/// <c>Monitor.Exit</c>), a chained assignment's inner target (once as the
/// write, once as the next link's read), an <c>is</c>-pattern's scrutinee
/// (once per sub-pattern/binder reference), and a range-slice's start operand
/// (once as the <c>Slice</c> argument, once inside the length computation).
/// When the operand has a side effect (a method call, an increment) or reads
/// a mutable value, duplicating it silently changes C# semantics by running
/// it twice. The fix spills any non-trivial operand into a single <c>let</c>
/// via a shared helper and references the local at both positions, while a
/// bare local/<c>this</c>/literal operand is left untouched (no spurious
/// temp). Every snippet must round-trip through the real G# parser.
/// </summary>
public class Issue1731DoubleEvaluationTranslationTests
{
    [Fact]
    public void Lock_MethodCallTarget_EvaluatesTargetOnce()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        private static object GetSyncRoot() => new object();

        public void M()
        {
            lock (GetSyncRoot())
            {
                System.Console.WriteLine(1);
            }
        }
    }
}");

        Assert.Equal(2, CountOccurrences(printed, "GetSyncRoot()")); // 1 declaration + 1 call (was 1 declaration + 2 calls before the fix)
        Assert.Contains("Monitor.Enter(", printed);
        Assert.Contains("Monitor.Exit(", printed);
    }

    [Fact]
    public void Lock_SimpleFieldTarget_NoUnnecessaryTemp()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        private readonly object gate = new object();

        public void M()
        {
            lock (gate)
            {
                System.Console.WriteLine(1);
            }
        }
    }
}");

        Assert.DoesNotContain("__spill", printed);
        Assert.Contains("Monitor.Enter(gate)", printed);
        Assert.Contains("Monitor.Exit(gate)", printed);
    }

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

    private static string TranslateUnit(string source)
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
        return printed;
    }
}
