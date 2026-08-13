// <copyright file="Issue1723ValuePositionAssignmentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
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
/// the RHS — silently dropping the write. ADR-0161 establishes native G#
/// assignment expressions, so cs2gs now keeps the write at its original value
/// position. Every snippet must bind through the real G# compiler.
/// </summary>
public class Issue1723ValuePositionAssignmentTranslationTests
{
    /// <summary>
    /// The canonical idiom: <c>while ((line = r.ReadLine()) != null)</c>. The
    /// assignment stays in the loop condition and runs exactly once per test.
    /// </summary>
    [Fact]
    public void WhileConditionAssignment_RemainsInCondition()
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

        Assert.DoesNotContain("while true {", printed);
        Assert.Equal(1, CountOccurrences(printed, "r.ReadLine()"));
        Assert.Contains("while (line = r.ReadLine()) != nil {", printed);

        Assert.Contains("Console.WriteLine(line)", printed);
    }

    /// <summary>
    /// <c>if ((x = f()) > 0)</c> remains a native condition expression.
    /// </summary>
    [Fact]
    public void IfConditionAssignment_RemainsInCondition()
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
        Assert.Contains("if (x = C.F()) > 0 {", printed);
        Assert.Contains("Console.WriteLine(x)", printed);
    }

    /// <summary>
    /// A bare assignment used directly as an <c>if</c> condition:
    /// <c>if (x = F())</c> (C# only allows this for a <c>bool</c>-typed target).
    /// </summary>
    [Fact]
    public void IfConditionBareAssignment_RemainsInCondition()
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
        Assert.Contains("if (x = C.F()) {", printed);
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

        Assert.Contains("a = (b += c)", printed);
    }

    /// <summary>
    /// Assignment as a call argument, <c>M(x = 5)</c>: the argument's write
    /// must land in <c>x</c> AND the call must observe the assigned value.
    /// </summary>
    [Fact]
    public void AssignmentAsCallArgument_RemainsInArgument()
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
        Assert.Contains("Consume((x = 5))", printed);
        Assert.Contains("Console.WriteLine(x)", printed);
    }

    /// <summary>
    /// <c>return (x = M());</c> returns the native assignment value.
    /// </summary>
    [Fact]
    public void ReturnValueAssignment_RemainsInReturn()
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
        Assert.Contains("return (x = C.F())", printed);
    }

    /// <summary>
    /// An assignment in a conditional-expression arm must stay inside that arm.
    /// The false branch writes the dictionary exactly once and yields the written
    /// value as the conditional result.
    /// </summary>
    [Fact]
    public void ConditionalFalseBranchDictionaryAssignment_RunsOnceAndYieldsAssignedValue()
    {
        string printed = TranslateUnit(
            """
            using System;
            using System.Collections.Generic;

            namespace Demo
            {
                public static class C
                {
                    private static int calls;

                    private static int Next()
                    {
                        calls++;
                        return 42;
                    }

                    private static int GetOrAdd(Dictionary<string, int> map, string key)
                    {
                        var value = map.TryGetValue(key, out var existing)
                            ? existing
                            : map[key] = Next();
                        return value;
                    }

                    public static string Run()
                    {
                        calls = 0;
                        var map = new Dictionary<string, int>();
                        string key = "k";
                        int first = GetOrAdd(map, key);
                        int second = GetOrAdd(map, key);
                        return calls + "," + map.Count + "," + first + "," + second + "," + map[key];
                    }
                }
            }
            """,
            out TranslationContext context);

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("(map_[key] = C.Next())", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "C.Next()"));

        Assert.Equal("1,1,42,42,42", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void PropertyAssignmentResult_UsesAssignedValueWithoutCallingGetter()
    {
        string printed = TranslateUnit(
            """
            namespace Demo
            {
                public sealed class Holder
                {
                    private int stored;
                    private int gets;

                    public int P
                    {
                        get
                        {
                            this.gets++;
                            return this.stored + 100;
                        }

                        set
                        {
                            this.stored = value;
                        }
                    }

                    public int Stored => this.stored;

                    public int Gets => this.gets;

                    private static int Echo(int value) => value;

                    private int AssignAndReturn()
                    {
                        return P = 8;
                    }

                    public string Assign()
                    {
                        int argument = Echo(P = 7);
                        int returned = AssignAndReturn();
                        return argument + "," + returned + "," + this.Stored + "," + this.Gets;
                    }
                }

                public static class C
                {
                    public static string Run() => new Holder().Assign();
                }
            }
            """);

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("(P = 7)", printed, StringComparison.Ordinal);
        Assert.Contains("(P = 8)", printed, StringComparison.Ordinal);
        Assert.Equal("7,8,8,0", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ConditionalCompoundPropertyAssignment_ReturnsCombinedValueWithoutGetterReadback()
    {
        string printed = TranslateUnit(
            """
            namespace Demo
            {
                public sealed class Holder
                {
                    private int backing = 1;
                    private int gets;

                    public int P
                    {
                        get
                        {
                            this.gets++;
                            return this.backing + 10;
                        }

                        set { this.backing = value; }
                    }

                    public int Gets => this.gets;

                    public int Stored => this.backing;
                }

                public static class C
                {
                    private static Holder current = new Holder();
                    private static int receiverCalls;
                    private static int rhsCalls;

                    private static Holder Receiver()
                    {
                        receiverCalls++;
                        return current;
                    }

                    private static int Next()
                    {
                        rhsCalls++;
                        return 2;
                    }

                    public static string Run()
                    {
                        current = new Holder();
                        receiverCalls = 0;
                        rhsCalls = 0;
                        int result = false ? -1 : Receiver().P += Next();
                        return receiverCalls + "," + rhsCalls + "," + current.Gets + ","
                            + result + "," + current.Stored;
                    }
                }
            }
            """);

        Assert.Equal(1, CountOccurrences(printed, "C.Receiver()"));
        Assert.Equal(1, CountOccurrences(printed, "C.Next()"));
        Assert.Equal("1,1,1,13,13", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ReturnAndInvocationCompoundPropertyAssignments_ReuseCombinedValue()
    {
        string printed = TranslateUnit(
            """
            namespace Demo
            {
                public sealed class Holder
                {
                    private int backing = 1;
                    private int gets;

                    public int P
                    {
                        get
                        {
                            this.gets++;
                            return this.backing + 10;
                        }

                        set { this.backing = value; }
                    }

                    public int Gets => this.gets;

                    public int Stored => this.backing;
                }

                public static class C
                {
                    private static int rhsCalls;

                    private static int Next()
                    {
                        rhsCalls++;
                        return 2;
                    }

                    private static int Echo(int value) => value;

                    private static int AddAndReturn(Holder holder)
                    {
                        return holder.P += Next();
                    }

                    public static string Run()
                    {
                        rhsCalls = 0;
                        var holder = new Holder();
                        int argument = Echo(holder.P += Next());
                        int returned = AddAndReturn(holder);
                        return rhsCalls + "," + holder.Gets + "," + argument + ","
                            + returned + "," + holder.Stored;
                    }
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "C.Next()"));
        Assert.Equal("2,2,13,25,25", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void SetOnlyIndexerAssignment_SideEffectingTargetAndValueRunOnce()
    {
        string printed = TranslateUnit(
            """
            namespace Demo
            {
                public sealed class Holder
                {
                    private int[] values = new int[2];
                    private int writes;

                    public int this[int index]
                    {
                        set
                        {
                            this.writes++;
                            this.values[index] = value;
                        }
                    }

                    public int Read(int index) => this.values[index];

                    public int Writes => this.writes;
                }

                public static class C
                {
                    private static Holder current = new Holder();
                    private static int receiverCalls;
                    private static int indexCalls;
                    private static int valueCalls;
                    private static string trace = "";

                    private static Holder Receiver()
                    {
                        trace += "R";
                        receiverCalls++;
                        return current;
                    }

                    private static int NextIndex()
                    {
                        trace += "I";
                        indexCalls++;
                        return 1;
                    }

                    private static int NextValue()
                    {
                        trace += "V";
                        valueCalls++;
                        return 42;
                    }

                    public static string Run()
                    {
                        current = new Holder();
                        receiverCalls = 0;
                        indexCalls = 0;
                        valueCalls = 0;
                        trace = "";
                        int result = Receiver()[NextIndex()] = NextValue();
                        return trace + "," + receiverCalls + "," + indexCalls + "," + valueCalls + ","
                            + current.Writes + "," + result + "," + current.Read(1);
                    }
                }
            }
            """);

        Assert.Equal(1, CountOccurrences(printed, "C.Receiver()"));
        Assert.Equal(1, CountOccurrences(printed, "C.NextIndex()"));
        Assert.Equal(1, CountOccurrences(printed, "C.NextValue()"));
        Assert.Equal("RIV,1,1,1,1,42,42", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ConditionalFalseBranchStaticPropertyAssignment_CompilesAndReturnsAssignedValue()
    {
        string printed = TranslateUnit(
            """
            namespace Demo
            {
                public static class Store
                {
                    private static int backing;

                    public static int P
                    {
                        get => backing + 100;
                        set { backing = value; }
                    }

                    public static int Backing => backing;
                }

                public static class C
                {
                    private static int calls;

                    private static int Next()
                    {
                        calls++;
                        return 42;
                    }

                    public static string Run()
                    {
                        calls = 0;
                        Store.P = 0;
                        int result = false ? -1 : Store.P = Next();
                        return calls + "," + result + "," + Store.Backing + "," + Store.P;
                    }
                }
            }
            """);

        Assert.Equal("1,42,42,142", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ReturnStaticFieldAssignment_CompilesAndReturnsAssignedValue()
    {
        string printed = TranslateUnit(
            """
            namespace Demo
            {
                public static class C
                {
                    private static int calls;
                    public static int Stored;

                    private static int Next()
                    {
                        calls++;
                        return 9;
                    }

                    private static int AssignAndReturn()
                    {
                        return C.Stored = Next();
                    }

                    public static string Run()
                    {
                        calls = 0;
                        Stored = 0;
                        int result = AssignAndReturn();
                        return calls + "," + result + "," + Stored;
                    }
                }
            }
            """);

        Assert.Equal("1,9,9", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ConditionalFalseBranchAssignment_WithIfLetCandidate_StaysInsideElseArm()
    {
        string printed = TranslateUnit(
            """
            #nullable enable

            namespace Demo
            {
                public static class C
                {
                    public static int Pick(string? candidate)
                    {
                        int x = 0;
                        int value = candidate is { } text ? text.Length : (x = 5);
                        return value + x;
                    }

                    public static string Run() => Pick(null) + "," + Pick("abc");
                }
            }
            """,
            out TranslationContext context);

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        int elseArm = printed.IndexOf("else {", StringComparison.Ordinal);
        int assignment = printed.IndexOf("x = 5", StringComparison.Ordinal);
        Assert.True(elseArm >= 0 && assignment > elseArm, printed);
        Assert.Equal(1, CountOccurrences(printed, "x = 5"));
        Assert.Equal("10,3", CompileAndRun(printed, "C.Run()").Trim());
    }

    /// <summary>
    /// A <c>for</c> loop whose condition carries a value-position assignment,
    /// <c>for (...; (c = Next()) != -1; ...)</c>, must call <c>Next()</c>
    /// exactly once per iteration (evaluated as part of the loop test) and use
    /// the hoisted read to decide whether to continue.
    /// </summary>
    [Fact]
    public void ForConditionAssignment_RemainsInCondition()
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

        Assert.DoesNotContain("while true {", printed);
        Assert.Contains("(c = s.Next()) != -1", printed);
        Assert.Contains("Console.WriteLine(c)", printed);
    }

    /// <summary>
    /// An assignment hidden inside the short-circuited operand of <c>&amp;&amp;</c>
    /// (<c>a() &amp;&amp; (x = f()) > 0</c>): hoisting it unconditionally would evaluate
    /// <c>f()</c> even when <c>a()</c> is <c>false</c>, changing C#'s evaluation
    /// COUNT — so it cannot be hoisted. ADR-0161 / issue #3350: it does not need
    /// to be. G# assignment is a value-yielding expression, so the write is
    /// emitted in place and runs exactly when C# runs it. This previously
    /// reported <see cref="TranslationSeverity.Unsupported"/> and dropped it.
    /// </summary>
    [Fact]
    public void AssignmentInsideShortCircuitedAnd_IsEmittedInPlace()
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

        // ADR-0161 / issue #3350: G# assignment is a value-yielding expression, so
        // the write is now emitted IN PLACE, running exactly when C# runs it,
        // rather than being reported Unsupported and then silently dropped.
        Assert.DoesNotContain(
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
    public void DoWhileConditionAssignment_RemainsAtLoopTail()
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
        Assert.True(assign >= 0, "Expected `i = i + 1` in:\n" + printed);
        Assert.True(writeLine < assign, "Body must run before the condition assignment:\n" + printed);
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
    public void DoWhileConditionAssignmentWithOwnContinue_UsesNativeCondition()
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

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// A <c>continue</c> inside a <c>switch</c> STATEMENT case still targets
    /// the enclosing <c>do</c>/<c>while</c> loop — unlike <c>break</c>, C#'s
    /// <c>switch</c> does not re-target <c>continue</c>. So this must be
    /// flagged Unsupported the same as an un-nested continue (issue #1723).
    /// </summary>
    [Fact]
    public void DoWhileConditionAssignmentWithContinueInsideSwitch_UsesNativeCondition()
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
                switch (i % 2)
                {
                    case 0:
                        i = i + 1;
                        continue;
                    default:
                        x = x + i;
                        break;
                }
            } while ((i = i + 1) < 10);
        }
    }
}"),
        });
        Assert.True(project.BoundWithoutErrors);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
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
    public void WhileConditionAssignmentWithContinue_ReevaluatesNativeAssignmentEachIteration()
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

        Assert.DoesNotContain("while true {", printed);
        Assert.Contains("while (c = s.Next()) != -1 {", printed);
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
    /// evaluation count, so it cannot be hoisted — ADR-0161 / issue #3350 emits it
    /// in place instead (previously <see cref="TranslationSeverity.Unsupported"/>),
    /// not silently hoisted (issue #1723 follow-up).
    /// </summary>
    [Fact]
    public void AssignmentInsideCoalesceRight_IsEmittedInPlace()
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

        // ADR-0161 / issue #3350: G# assignment is a value-yielding expression, so
        // the write is now emitted IN PLACE, running exactly when C# runs it,
        // rather than being reported Unsupported and then silently dropped.
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// An assignment inside the "when not null" side of a <c>?.</c> chain
    /// (<c>obj?.M(x = 5)</c>): the call/argument only evaluates when <c>obj</c>
    /// is non-null, so hoisting unconditionally would run it even when <c>obj</c>
    /// is null, so it cannot be hoisted — ADR-0161 / issue #3350 emits it in place
    /// instead (previously <see cref="TranslationSeverity.Unsupported"/>).
    /// </summary>
    [Fact]
    public void AssignmentInsideConditionalAccessWhenNotNull_IsEmittedInPlace()
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

        // ADR-0161 / issue #3350: G# assignment is a value-yielding expression, so
        // the write is now emitted IN PLACE, running exactly when C# runs it,
        // rather than being reported Unsupported and then silently dropped.
        Assert.DoesNotContain(
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
        Assert.Contains("Consume((p = 1), (q = 2))", printed);
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

    private static string TranslateUnit(string source) =>
        TranslateUnit(source, out _);

    private static string TranslateUnit(string source, out TranslationContext context)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-1723-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Snippet.gs");
            string dllPath = Path.Combine(workDir, "Snippet.dll");
            File.WriteAllText(
                gsPath,
                printed + Environment.NewLine +
                    $"Console.WriteLine({callExpression})" + Environment.NewLine);

            (int compileExit, string compileOutput) = RunDotnet(
                compiler,
                "/target:exe",
                $"/out:{dllPath}",
                gsPath);
            Assert.True(
                compileExit == 0 &&
                    !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" +
                    compileOutput + "\n\nTranslated G#:\n" + printed);

            (int runExit, string runOutput) = RunDotnet(dllPath);
            Assert.True(
                runExit == 0,
                "Translated snippet must run successfully. Output:\n" + runOutput);
            return runOutput;
        }
        finally
        {
            Directory.Delete(workDir, recursive: true);
        }
    }

    private static (int Exit, string Output) RunDotnet(params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
