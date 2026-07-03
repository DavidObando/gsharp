// <copyright file="Issue1723ValuePositionAssignmentTranslationTests.cs" company="GSharp">
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
/// Regression tests for issue #1723: a C# assignment used in VALUE position
/// (<c>while ((line = r.ReadLine()) != null)</c>, <c>a = b += c</c>,
/// <c>M(x = 5)</c>, <c>if ((x = f()) > 0)</c>, <c>return (x = M());</c>) was
/// translated as if the assignment were statement-only, or by returning just
/// the RHS — silently dropping the write. G# models assignment as a
/// statement, not a value-yielding expression, so the fix hoists the
/// assignment into a preceding (or, for loop conditions, per-iteration
/// body-prologue) assignment statement and substitutes the assigned target's
/// read for the original assignment expression, preserving evaluation order,
/// evaluation COUNT, and the write itself. Every snippet must round-trip
/// through the real G# parser.
/// </summary>
public class Issue1723ValuePositionAssignmentTranslationTests
{
    /// <summary>
    /// The canonical idiom: <c>while ((line = r.ReadLine()) != null)</c>. The
    /// assignment must be hoisted into the loop body (so <c>ReadLine</c> is
    /// called exactly once per iteration) and the loop must break when the
    /// hoisted <c>line</c> is nil, instead of comparing the call's return value
    /// directly and losing the assignment to <c>line</c>.
    /// </summary>
    [Fact]
    public void WhileConditionAssignment_HoistsReadLineIntoBodyAndBreaksOnNil()
    {
        string printed = TranslateUnit(@"
using System.IO;

namespace Demo
{
    public sealed class C
    {
        public void ReadAll(TextReader r)
        {
            string line;
            while ((line = r.ReadLine()) != null)
            {
                System.Console.WriteLine(line);
            }
        }
    }
}");

        Assert.Contains("while true {", printed);

        // The assignment is hoisted as its own statement — `ReadLine` appears
        // exactly once, and `line` is actually assigned (not just read).
        Assert.Equal(1, CountOccurrences(printed, "r.ReadLine()"));
        Assert.Contains("line = r.ReadLine()", printed);

        // The condition becomes a negated break guard over the hoisted read.
        Assert.Contains("!((line) != nil)", printed);
        Assert.Contains("break", printed);

        Assert.Contains("Console.WriteLine(line)", printed);
    }

    /// <summary>
    /// <c>if ((x = f()) > 0)</c>: the assignment is hoisted immediately before
    /// the <c>if</c> (evaluated exactly once, matching C#'s single evaluation of
    /// an if-condition), and the condition reads the now-current <c>x</c>.
    /// </summary>
    [Fact]
    public void IfConditionAssignment_HoistsBeforeIfAndReadsAssignedTarget()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public static int F() => 5;

        public void M()
        {
            int x = 0;
            if ((x = F()) > 0)
            {
                System.Console.WriteLine(x);
            }
        }
    }
}");

        Assert.Equal(1, CountOccurrences(printed, "= C.F()"));
        Assert.Contains("x = C.F()", printed);
        Assert.Contains("if (x) > 0 {", printed);
        Assert.Contains("Console.WriteLine(x)", printed);
    }

    /// <summary>
    /// A bare assignment used directly as an <c>if</c> condition:
    /// <c>if (x = F())</c> (C# only allows this for a <c>bool</c>-typed target).
    /// </summary>
    [Fact]
    public void IfConditionBareAssignment_HoistsAndReadsAssignedTarget()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public static bool F() => true;

        public void M()
        {
            bool x = false;
            if (x = F())
            {
                System.Console.WriteLine(x);
            }
        }
    }
}");

        Assert.Equal(1, CountOccurrences(printed, "= C.F()"));
        Assert.Contains("x = C.F()", printed);
        Assert.Contains("if x {", printed);
    }

    /// <summary>
    /// Chained assignment through a COMPOUND operator link, <c>a = b += c</c>:
    /// C# evaluates <c>b += c</c> first (mutating <c>b</c>, yielding its new
    /// value) and then assigns that value to <c>a</c>. The compound link must
    /// not be dropped (the historical bug turned this into plain <c>a = c</c>).
    /// </summary>
    [Fact]
    public void ChainedAssignmentThroughCompoundOperator_PreservesBothWrites()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int a = 0;
            int b = 1;
            int c = 2;
            a = b += c;
            System.Console.WriteLine(a);
            System.Console.WriteLine(b);
        }
    }
}");

        // Both the compound mutation of `b` and the final assignment to `a`
        // must appear as separate statements, in this order.
        int bMutation = printed.IndexOf("b += c", StringComparison.Ordinal);
        int aAssignment = printed.IndexOf("a = b", StringComparison.Ordinal);
        Assert.True(bMutation >= 0, "Expected `b += c` mutation in:\n" + printed);
        Assert.True(aAssignment >= 0, "Expected `a = b` assignment in:\n" + printed);
        Assert.True(bMutation < aAssignment, "`b += c` must run before `a = b`:\n" + printed);
    }

    /// <summary>
    /// Assignment as a call argument, <c>M(x = 5)</c>: the argument's write
    /// must land in <c>x</c> AND the call must observe the assigned value.
    /// </summary>
    [Fact]
    public void AssignmentAsCallArgument_HoistsBeforeCallAndPassesAssignedValue()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public static void Consume(int value)
        {
        }

        public void M()
        {
            int x = 0;
            Consume(x = 5);
            System.Console.WriteLine(x);
        }
    }
}");

        Assert.Contains("x = 5", printed);
        Assert.Contains("Consume(x)", printed);
        Assert.Contains("Console.WriteLine(x)", printed);
    }

    /// <summary>
    /// <c>return (x = M());</c>: the assignment is hoisted into a preceding
    /// statement and the return value reads the now-assigned <c>x</c>.
    /// </summary>
    [Fact]
    public void ReturnValueAssignment_HoistsBeforeReturnAndReadsAssignedTarget()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public static int F() => 7;

        public int M()
        {
            int x = 0;
            return (x = F());
        }
    }
}");

        Assert.Equal(1, CountOccurrences(printed, "= C.F()"));
        Assert.Contains("x = C.F()", printed);
        Assert.Contains("return (x)", printed);
    }

    /// <summary>
    /// A <c>for</c> loop whose condition carries a value-position assignment,
    /// <c>for (...; (c = Next()) != -1; ...)</c>, must call <c>Next()</c>
    /// exactly once per iteration (evaluated as part of the loop test) and use
    /// the hoisted read to decide whether to continue.
    /// </summary>
    [Fact]
    public void ForConditionAssignment_HoistsIntoBodyPrologue()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Source
    {
        private int calls;

        public int Next()
        {
            this.calls++;
            return this.calls > 3 ? -1 : this.calls;
        }
    }

    public sealed class C
    {
        public void M(Source s)
        {
            int c;
            for (int i = 0; (c = s.Next()) != -1; i++)
            {
                System.Console.WriteLine(c);
            }
        }
    }
}");

        Assert.Contains("while true {", printed);
        Assert.Contains("c = s.Next()", printed);
        Assert.Contains("!((c) != -1)", printed);
        Assert.Contains("break", printed);
        Assert.Contains("Console.WriteLine(c)", printed);
    }

    /// <summary>
    /// An assignment hidden inside the short-circuited operand of <c>&amp;&amp;</c>
    /// (<c>a() &amp;&amp; (x = f()) > 0</c>): hoisting it unconditionally would evaluate
    /// <c>f()</c> even when <c>a()</c> is <c>false</c>, changing C#'s evaluation
    /// COUNT. This is the one form the fix cannot lower faithfully, so it must be
    /// surfaced as an <see cref="TranslationSeverity.Unsupported"/> diagnostic
    /// instead of silently dropping the write.
    /// </summary>
    [Fact]
    public void AssignmentInsideShortCircuitedAnd_ReportsUnsupportedInsteadOfSilentlyDropping()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public sealed class C
    {
        public static bool A() => true;

        public static int F() => 5;

        public void M()
        {
            int x = 0;
            if (A() && (x = F()) > 0)
            {
                System.Console.WriteLine(x);
            }
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("short-circuited"));
    }

    /// <summary>
    /// A <c>do</c>/<c>while</c> loop whose condition carries a value-position
    /// assignment must hoist the assignment + break-guard to the TAIL of the
    /// body, not the top: C# evaluates the body BEFORE the condition on every
    /// iteration (including the first), so hoisting at the top would apply the
    /// assignment's write before the first body run, silently reordering an
    /// observable side effect (issue #1723, do-while regression).
    /// </summary>
    [Fact]
    public void DoWhileConditionAssignment_HoistsToBodyTailNotTop()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int i = 0;
            do
            {
                System.Console.WriteLine(i);
            } while ((i = i + 1) < 3);
        }
    }
}");

        int writeLine = printed.IndexOf("Console.WriteLine(i)", StringComparison.Ordinal);
        int assign = printed.IndexOf("i = i + 1", StringComparison.Ordinal);
        Assert.True(writeLine >= 0, "Expected `Console.WriteLine(i)` in:\n" + printed);
        Assert.True(assign >= 0, "Expected hoisted `i = i + 1` in:\n" + printed);
        Assert.True(writeLine < assign, "Body must run before the hoisted condition assignment:\n" + printed);
    }

    /// <summary>
    /// A <c>do</c>/<c>while</c> whose condition carries a value-position
    /// assignment AND whose body has a <c>continue</c> targeting this loop: the
    /// tail-hoisted assignment/break-guard sits AFTER the `continue`'s jump
    /// target (ADR-0070's continueLabel is placed right after the whole bound
    /// body), so `continue` would skip it — re-using a stale condition value
    /// instead of re-evaluating it. This has no side-effect-preserving G#
    /// lowering yet, so it must be flagged Unsupported instead of silently
    /// mistranslated (issue #1723, do-while + continue regression).
    /// </summary>
    [Fact]
    public void DoWhileConditionAssignmentWithOwnContinue_ReportsUnsupportedInsteadOfSilentlyDroppingHoist()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int i = 0;
            int x = 0;
            do
            {
                if (i % 2 == 0)
                {
                    i = i + 1;
                    continue;
                }

                x = x + i;
            } while ((i = i + 1) < 10);
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("short-circuited"));
    }

    /// <summary>
    /// Regression guard: a <c>continue</c> inside a NESTED inner loop targets
    /// the inner loop, not the outer <c>do</c>/<c>while</c> — it never reaches
    /// this do-while's ADR-0070 continueLabel, so the outer tail-hoist is safe
    /// and must still lower normally (no diagnostic), instead of being
    /// over-flagged as unsupported (issue #1723).
    /// </summary>
    [Fact]
    public void DoWhileConditionAssignmentWithNestedLoopContinue_StillLowersNormally()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int i = 0;
            do
            {
                for (int j = 0; j < 3; j++)
                {
                    if (j == 1)
                    {
                        continue;
                    }

                    System.Console.WriteLine(j);
                }
            } while ((i = i + 1) < 3);
        }
    }
}");

        Assert.Contains("i = i + 1", printed);
        Assert.Contains("continue", printed);

        int writeLine = printed.IndexOf("Console.WriteLine(j)", StringComparison.Ordinal);
        int assign = printed.IndexOf("i = i + 1", StringComparison.Ordinal);
        Assert.True(writeLine >= 0 && assign >= 0 && writeLine < assign, printed);
    }

    /// <summary>
    /// A <c>while</c> loop whose hoisted condition-assignment body contains a
    /// <c>continue</c>: the hoisted assignment lives at the TOP of the body (as
    /// the loop's real condition check), so <c>continue</c> jumps back to it and
    /// it re-runs every iteration — it must never go stale.
    /// </summary>
    [Fact]
    public void WhileConditionAssignmentWithContinue_ReevaluatesHoistedAssignmentEachIteration()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Source
    {
        private int calls;

        public int Next()
        {
            this.calls++;
            return this.calls > 5 ? -1 : this.calls;
        }
    }

    public sealed class C
    {
        public void M(Source s)
        {
            int c;
            while ((c = s.Next()) != -1)
            {
                if (c % 2 == 0)
                {
                    continue;
                }

                System.Console.WriteLine(c);
            }
        }
    }
}");

        Assert.Contains("while true {", printed);
        Assert.Contains("c = s.Next()", printed);
        Assert.Contains("continue", printed);

        // The hoisted assignment must be the first statement in the loop body
        // (before the `continue`'s enclosing `if`), so `continue` re-triggers it.
        int hoist = printed.IndexOf("c = s.Next()", StringComparison.Ordinal);
        int continueIdx = printed.IndexOf("continue", StringComparison.Ordinal);
        Assert.True(hoist >= 0 && continueIdx >= 0 && hoist < continueIdx, printed);
    }

    /// <summary>
    /// An assignment hidden in the RHS of <c>??</c> (<c>a ?? (x = f())</c>): the
    /// RHS only runs when <c>a</c> is null, so hoisting the assignment
    /// unconditionally would run it even when <c>a</c> is non-null, changing C#'s
    /// evaluation count. Must be surfaced as <see cref="TranslationSeverity.Unsupported"/>,
    /// not silently hoisted (issue #1723 follow-up).
    /// </summary>
    [Fact]
    public void AssignmentInsideCoalesceRight_ReportsUnsupportedInsteadOfSilentlyDropping()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public sealed class C
    {
        public void M(string s)
        {
            int x = 0;
            int y = s?.Length ?? (x = 42);
            System.Console.WriteLine(y);
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An assignment inside the "when not null" side of a <c>?.</c> chain
    /// (<c>obj?.M(x = 5)</c>): the call/argument only evaluates when <c>obj</c>
    /// is non-null, so hoisting unconditionally would run it even when <c>obj</c>
    /// is null. Must be surfaced as <see cref="TranslationSeverity.Unsupported"/>.
    /// </summary>
    [Fact]
    public void AssignmentInsideConditionalAccessWhenNotNull_ReportsUnsupportedInsteadOfSilentlyDropping()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public sealed class Obj
    {
        public int M(int value) => value;
    }

    public sealed class C
    {
        public void M(Obj obj)
        {
            int x = 0;
            int? y = obj?.M(x = 5);
            System.Console.WriteLine(y);
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// Multiple independent embedded assignments in one expression must hoist
    /// (and thus evaluate) in left-to-right source order: <c>if ((a=f())&gt;(b=g()))</c>
    /// and <c>M(x=1, y=2)</c>.
    /// </summary>
    [Fact]
    public void MultipleEmbeddedAssignments_PreserveLeftToRightOrder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public static int F() => 1;

        public static int G() => 2;

        public static void Consume(int x, int y)
        {
        }

        public void M()
        {
            int a = 0;
            int b = 0;
            if ((a = F()) > (b = G()))
            {
                System.Console.WriteLine(a);
            }

            int p = 0;
            int q = 0;
            Consume(p = 1, q = 2);
            System.Console.WriteLine(p);
            System.Console.WriteLine(q);
        }
    }
}");

        int aAssign = printed.IndexOf("a = C.F()", StringComparison.Ordinal);
        int bAssign = printed.IndexOf("b = C.G()", StringComparison.Ordinal);
        Assert.True(aAssign >= 0 && bAssign >= 0 && aAssign < bAssign, printed);

        int pAssign = printed.IndexOf("p = 1", StringComparison.Ordinal);
        int qAssign = printed.IndexOf("q = 2", StringComparison.Ordinal);
        Assert.True(pAssign >= 0 && qAssign >= 0 && pAssign < qAssign, printed);
        Assert.Contains("Consume(p, q)", printed);
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
