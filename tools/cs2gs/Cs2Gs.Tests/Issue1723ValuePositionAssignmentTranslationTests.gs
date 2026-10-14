// <copyright file="Issue1723ValuePositionAssignmentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Regression tests for issue #1723: a C# assignment used in VALUE position
/// (`while ((line = r.ReadLine()) != null)`, `a = b += c`,
/// `M(x = 5)`, `if ((x = f()) > 0)`, `return (x = M());`) was
/// translated as if the assignment were statement-only, or by returning just
/// the RHS — silently dropping the write. ADR-0161 establishes native G#
/// assignment expressions, so cs2gs now keeps the write at its original value
/// position. Every snippet must bind through the real G# compiler.
open class Issue1723ValuePositionAssignmentTranslationTests {
    /// The canonical idiom: `while ((line = r.ReadLine()) != null)`. The
    /// assignment stays in the loop condition and runs exactly once per test.
    @Fact
    func WhileConditionAssignment_RemainsInCondition() {
        let printed = TranslateUnit(`
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
}`)
        Assert.DoesNotContain("while true {", printed)
        Assert.Equal(1, CountOccurrences(printed, "r.ReadLine()"))
        Assert.Contains("while (line = r.ReadLine()) != nil {", printed)
        Assert.Contains("Console.WriteLine(line)", printed)
    }

    /// `if ((x = f()) > 0)` remains a native condition expression.
    @Fact
    func IfConditionAssignment_RemainsInCondition() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Equal(1, CountOccurrences(printed, "= F()"))
        Assert.Contains("if (x = F()) > 0 {", printed)
        Assert.Contains("Console.WriteLine(x)", printed)
    }

    /// A bare assignment used directly as an `if` condition:
    /// `if (x = F())` (C# only allows this for a `bool`-typed target).
    @Fact
    func IfConditionBareAssignment_RemainsInCondition() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Equal(1, CountOccurrences(printed, "= F()"))
        Assert.Contains("if (x = F()) {", printed)
    }

    /// Chained assignment through a COMPOUND operator link, `a = b += c`:
    /// C# evaluates `b += c` first (mutating `b`, yielding its new
    /// value) and then assigns that value to `a`. The compound link must
    /// not be dropped (the historical bug turned this into plain `a = c`).
    @Fact
    func ChainedAssignmentThroughCompoundOperator_PreservesBothWrites() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("a = (b += c)", printed)
    }

    /// Assignment as a call argument, `M(x = 5)`: the argument's write
    /// must land in `x` AND the call must observe the assigned value.
    @Fact
    func AssignmentAsCallArgument_RemainsInArgument() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("x = 5", printed)
        Assert.Contains("Consume((x = 5))", printed)
        Assert.Contains("Console.WriteLine(x)", printed)
    }

    /// `return (x = M());` returns the native assignment value.
    @Fact
    func ReturnValueAssignment_RemainsInReturn() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Equal(1, CountOccurrences(printed, "= F()"))
        Assert.Contains("return (x = F())", printed)
    }

    /// An assignment in a conditional-expression arm must stay inside that arm.
    /// The false branch writes the dictionary exactly once and yields the written
    /// value as the conditional result.
    @Fact
    func ConditionalFalseBranchDictionaryAssignment_RunsOnceAndYieldsAssignedValue() {
        let printed = TranslateUnit(`using System;
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
}`, out var context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("GetOrAdd($$map ", printed, StringComparison.Ordinal)
        Assert.Contains("($$map[key] = Next())", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "= Next()"))
        Assert.Equal("1,1,42,42,42", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func PropertyAssignmentResult_UsesAssignedValueWithoutCallingGetter() {
        let printed = TranslateUnit(`namespace Demo
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
}`)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("(P = 7)", printed, StringComparison.Ordinal)
        Assert.Contains("(P = 8)", printed, StringComparison.Ordinal)
        Assert.Equal("7,8,8,0", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ConditionalCompoundPropertyAssignment_ReturnsCombinedValueWithoutGetterReadback() {
        let printed = TranslateUnit(`namespace Demo
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
}`)
        Assert.Equal(2, CountOccurrences(printed, "Receiver()"))
        Assert.Equal(2, CountOccurrences(printed, "Next()"))
        Assert.Equal("1,1,1,13,13", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ReturnAndInvocationCompoundPropertyAssignments_ReuseCombinedValue() {
        let printed = TranslateUnit(`namespace Demo
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
}`)
        Assert.Equal(3, CountOccurrences(printed, "Next()"))
        Assert.Equal("2,2,13,25,25", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func SetOnlyIndexerAssignment_SideEffectingTargetAndValueRunOnce() {
        let printed = TranslateUnit(`namespace Demo
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
}`)
        Assert.Equal(2, CountOccurrences(printed, "Receiver()"))
        Assert.Equal(2, CountOccurrences(printed, "NextIndex()"))
        Assert.Equal(2, CountOccurrences(printed, "NextValue()"))
        Assert.Equal("RIV,1,1,1,1,42,42", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ConditionalFalseBranchStaticPropertyAssignment_CompilesAndReturnsAssignedValue() {
        let printed = TranslateUnit(`namespace Demo
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
}`)
        Assert.Equal("1,42,42,142", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ReturnStaticFieldAssignment_CompilesAndReturnsAssignedValue() {
        let printed = TranslateUnit(`namespace Demo
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
}`)
        Assert.Equal("1,9,9", CompileAndRun(printed, "C.Run()").Trim())
    }

    @Fact
    func ConditionalFalseBranchAssignment_WithIfLetCandidate_StaysInsideElseArm() {
        let printed = TranslateUnit(`#nullable enable

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
}`, out var context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        let elseArm = printed.IndexOf("else {", StringComparison.Ordinal)
        let assignment = printed.IndexOf("x = 5", StringComparison.Ordinal)
        Assert.True(elseArm >= 0 && assignment > elseArm, printed)
        Assert.Equal(1, CountOccurrences(printed, "x = 5"))
        Assert.Equal("10,3", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// A `for` loop whose condition carries a value-position assignment,
    /// `for (...; (c = Next()) != -1; ...)`, must call `Next()`
    /// exactly once per iteration (evaluated as part of the loop test) and use
    /// the hoisted read to decide whether to continue.
    @Fact
    func ForConditionAssignment_RemainsInCondition() {
        let printed = TranslateUnit(`
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
}`)
        Assert.DoesNotContain("while true {", printed)
        Assert.Contains("(c = s.Next()) != -1", printed)
        Assert.Contains("Console.WriteLine(c)", printed)
    }

    /// An assignment hidden inside the short-circuited operand of `&&`
    /// (`a() && (x = f()) > 0`): hoisting it unconditionally would evaluate
    /// `f()` even when `a()` is `false`, changing C#'s evaluation
    /// COUNT — so it cannot be hoisted. ADR-0161 / issue #3350: it does not need
    /// to be. G# assignment is a value-yielding expression, so the write is
    /// emitted in place and runs exactly when C# runs it. This previously
    /// reported (cref:TranslationSeverity.Unsupported) and dropped it.
    @Fact
    func AssignmentInsideShortCircuitedAnd_IsEmittedInPlace() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        // ADR-0161 / issue #3350: G# assignment is a value-yielding expression, so
        // the write is now emitted IN PLACE, running exactly when C# runs it,
        // rather than being reported Unsupported and then silently dropped.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "short-circuited"
            )
        )
    }

    /// A `do`/`while` loop whose condition carries a value-position
    /// assignment must hoist the assignment + break-guard to the TAIL of the
    /// body, not the top: C# evaluates the body BEFORE the condition on every
    /// iteration (including the first), so hoisting at the top would apply the
    /// assignment's write before the first body run, silently reordering an
    /// observable side effect (issue #1723, do-while regression).
    @Fact
    func DoWhileConditionAssignment_RemainsAtLoopTail() {
        let printed = TranslateUnit(`
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
}`)
        let writeLine = printed.IndexOf("Console.WriteLine(i)", StringComparison.Ordinal)
        let assign = printed.IndexOf("i = i + 1", StringComparison.Ordinal)
        Assert.True(writeLine >= 0, "Expected `Console.WriteLine(i)` in:\n" + printed)
        Assert.True(assign >= 0, "Expected `i = i + 1` in:\n" + printed)
        Assert.True(writeLine < assign, "Body must run before the condition assignment:\n" + printed)
    }

    /// A `do`/`while` whose condition carries a value-position
    /// assignment AND whose body has a `continue` targeting this loop: the
    /// tail-hoisted assignment/break-guard sits AFTER the `continue`'s jump
    /// target (ADR-0070's continueLabel is placed right after the whole bound
    /// body), so `continue` would skip it — re-using a stale condition value
    /// instead of re-evaluating it. This has no side-effect-preserving G#
    /// lowering yet, so it must be flagged Unsupported instead of silently
    /// mistranslated (issue #1723, do-while + continue regression).
    @Fact
    func DoWhileConditionAssignmentWithOwnContinue_UsesNativeCondition() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// A `continue` inside a `switch` STATEMENT case still targets
    /// the enclosing `do`/`while` loop — unlike `break`, C#'s
    /// `switch` does not re-target `continue`. So this must be
    /// flagged Unsupported the same as an un-nested continue (issue #1723).
    @Fact
    func DoWhileConditionAssignmentWithContinueInsideSwitch_UsesNativeCondition() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Regression guard: a `continue` inside a NESTED inner loop targets
    /// the inner loop, not the outer `do`/`while` — it never reaches
    /// this do-while's ADR-0070 continueLabel, so the outer tail-hoist is safe
    /// and must still lower normally (no diagnostic), instead of being
    /// over-flagged as unsupported (issue #1723).
    @Fact
    func DoWhileConditionAssignmentWithNestedLoopContinue_StillLowersNormally() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("i = i + 1", printed)
        Assert.Contains("continue", printed)
        let writeLine = printed.IndexOf("Console.WriteLine(j)", StringComparison.Ordinal)
        let assign = printed.IndexOf("i = i + 1", StringComparison.Ordinal)
        Assert.True(writeLine >= 0 && assign >= 0 && writeLine < assign, printed)
    }

    /// A `while` loop whose hoisted condition-assignment body contains a
    /// `continue`: the hoisted assignment lives at the TOP of the body (as
    /// the loop's real condition check), so `continue` jumps back to it and
    /// it re-runs every iteration — it must never go stale.
    @Fact
    func WhileConditionAssignmentWithContinue_ReevaluatesNativeAssignmentEachIteration() {
        let printed = TranslateUnit(`
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
}`)
        Assert.DoesNotContain("while true {", printed)
        Assert.Contains("while (c = s.Next()) != -1 {", printed)
        Assert.Contains("continue", printed)
        // The hoisted assignment must be the first statement in the loop body
        // (before the `continue`'s enclosing `if`), so `continue` re-triggers it.
        let hoist = printed.IndexOf("c = s.Next()", StringComparison.Ordinal)
        let continueIdx = printed.IndexOf("continue", StringComparison.Ordinal)
        Assert.True(hoist >= 0 && continueIdx >= 0 && hoist < continueIdx, printed)
    }

    /// An assignment hidden in the RHS of `??` (`a ?? (x = f())`): the
    /// RHS only runs when `a` is null, so hoisting the assignment
    /// unconditionally would run it even when `a` is non-null, changing C#'s
    /// evaluation count, so it cannot be hoisted — ADR-0161 / issue #3350 emits it
    /// in place instead (previously (cref:TranslationSeverity.Unsupported)),
    /// not silently hoisted (issue #1723 follow-up).
    @Fact
    func AssignmentInsideCoalesceRight_IsEmittedInPlace() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        // ADR-0161 / issue #3350: G# assignment is a value-yielding expression, so
        // the write is now emitted IN PLACE, running exactly when C# runs it,
        // rather than being reported Unsupported and then silently dropped.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// An assignment inside the "when not null" side of a `?.` chain
    /// (`obj?.M(x = 5)`): the call/argument only evaluates when `obj`
    /// is non-null, so hoisting unconditionally would run it even when `obj`
    /// is null, so it cannot be hoisted — ADR-0161 / issue #3350 emits it in place
    /// instead (previously (cref:TranslationSeverity.Unsupported)).
    @Fact
    func AssignmentInsideConditionalAccessWhenNotNull_IsEmittedInPlace() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        // ADR-0161 / issue #3350: G# assignment is a value-yielding expression, so
        // the write is now emitted IN PLACE, running exactly when C# runs it,
        // rather than being reported Unsupported and then silently dropped.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
    }

    /// Multiple independent embedded assignments in one expression must hoist
    /// (and thus evaluate) in left-to-right source order: `if ((a=f())>(b=g()))`
    /// and `M(x=1, y=2)`.
    @Fact
    func MultipleEmbeddedAssignments_PreserveLeftToRightOrder() {
        let printed = TranslateUnit(`
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
}`)
        let aAssign = printed.IndexOf("a = F()", StringComparison.Ordinal)
        let bAssign = printed.IndexOf("b = G()", StringComparison.Ordinal)
        Assert.True(aAssign >= 0 && bAssign >= 0 && aAssign < bAssign, printed)
        let pAssign = printed.IndexOf("p = 1", StringComparison.Ordinal)
        let qAssign = printed.IndexOf("q = 2", StringComparison.Ordinal)
        Assert.True(pAssign >= 0 && qAssign >= 0 && pAssign < qAssign, printed)
        Assert.Contains("Consume((p = 1), (q = 2))", printed)
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

        private func TranslateUnit(source string) string -> TranslateUnit(source, out _)

        private func TranslateUnit(source string, out context TranslationContext) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-1723-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(
                    gsPath,
                    printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
                )
                let (compileExit, compileOutput) = RunDotnet(compiler, "/target:exe", "/out:$dllPath", gsPath)
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput + `

Translated G#:
` + printed
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput)
                return runOutput
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string?)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
