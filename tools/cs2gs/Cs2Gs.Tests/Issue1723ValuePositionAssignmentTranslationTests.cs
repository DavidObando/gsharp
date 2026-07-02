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
