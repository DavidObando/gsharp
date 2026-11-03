// <copyright file="Issue3501OutVarTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #3501 (Translator burn-down, GS0154 family): an `out`/`ref`
/// argument flows the OPPOSITE way through a call — the callee writes the
/// parameter's value into the caller's variable. The oblivious taint analysis
/// only modeled argument→parameter edges, so a Try-pattern out parameter that
/// can be assigned null (`bool TryGet(..., out T value)` assigning an
/// `as`-cast) rendered `T?` while the caller's out-var local stayed
/// untainted; gsc independently infers the out-var's type from the promoted
/// parameter (`T?`), so downstream reads passed a `T?` where the
/// translator believed a `T` flowed and never bridged with `!!`.
/// The parameter→receiver back-edge closes the gap.
open class Issue3501OutVarTaintTranslationTests {
    @Fact
    func Oblivious_TryPatternOutVar_TaintsReceiverAndBridgesUse() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public bool TryPick(object value, out string picked)
        {
            picked = value as string;
            return picked != null;
        }

        public int Consume(string exact) { return exact.Length; }

        public int Run(object value)
        {
            if (this.TryPick(value, out var picked))
            {
                return this.Consume(picked);
            }

            return 0;
        }
    }
}`)
        // The out parameter itself is tainted (assigned an `as`-cast)...
        Assert.Contains("out picked string?", printed)
        Assert.Contains("if this.TryPick(value, out var picked)", printed)
        // ...and the receiving out-var local now inherits that taint, which the
        // fixpoint carries onward through the argument edge into `Consume`'s
        // parameter — the whole chain agrees on `string?` and the read needs no
        // call-site bridge. (Before the back-edge, the local stayed untainted,
        // `Consume` kept `string`, and gsc rejected the `T? -> T` argument.)
        Assert.Contains("func Consume(exact string?)", printed)
        Assert.Contains("Consume(picked)", printed)
    }

    @Fact
    func Oblivious_TaintedValueAssignedIntoInlineOutDeclaration_PredeclaresNullableLocal() {
        // Issue #4598: `out var x` / `out T x` takes its G# type from the callee's
        // `out` parameter. When the callee's parameter stays non-null (`Dictionary<int, Node>`
        // or an unpromoted source `out Node`) while the local itself is tainted by a
        // nullable write, emit `var x Node?` ahead of the statement and pass `out x`
        // so the write binds without a runtime `!!` that would throw on null.
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Node
    {
        public int Start => 7;
    }

    public static class C
    {
        private static Node Unwrap(Node node) => node;

        private static bool TryGetFixed(int key, out Node value)
        {
            value = new Node();
            return key > 0;
        }

        public static int RunHit(Node a, Node maybe)
        {
            if (maybe == null) { maybe = a; }
            var cache = new Dictionary<int, Node>();
            if (!cache.TryGetValue(1, out Node value))
            {
                value = Unwrap(maybe);
                cache.Add(1, value);
            }

            return value.Start;
        }

        private static string Describe(Node node) => node == null ? "null" : "node:" + node.Start;

        public static string RunNullStore(Node maybe)
        {
            if (maybe == null) { }
            var cache = new Dictionary<int, Node>();
            if (!cache.TryGetValue(1, out var inferred))
            {
                inferred = Unwrap(maybe);
            }

            if (!TryGetFixed(0, out Node fromSource))
            {
                fromSource = Unwrap(maybe);
            }

            return Describe(inferred) + ":" + Describe(fromSource);
        }

        public static string MainEntry() =>
            RunHit(new Node(), null) + ":" + RunNullStore(null) + ":" + RunNullStore(new Node());
    }
}`)
        Assert.Contains("var value Node?", printed)
        Assert.Contains("if !cache.TryGetValue(1, out value)", printed)
        Assert.Contains("value = Unwrap(maybe)", printed)
        Assert.Contains("cache.Add(1, value!!)", printed)
        Assert.Contains("return value!!.Start", printed)
        Assert.Contains("var inferred Node?", printed)
        Assert.Contains("if !cache.TryGetValue(1, out inferred)", printed)
        Assert.Contains("var fromSource Node?", printed)
        Assert.Contains("if !TryGetFixed(0, out fromSource)", printed)
        Assert.DoesNotContain("Unwrap(maybe)!!", printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.C.MainEntry())",
            "7:null:null:node:7:node:7"
        )
    }

    @Fact
    func Oblivious_PromotedOutDeclarationsInSiblingLoopsAndSwitchGuards_DisambiguateNames() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public static class C
    {
        private static int step;

        private static bool Next(out string value)
        {
            step++;
            value = "v" + step;
            return step <= 1;
        }

        public static string RunLoops()
        {
            step = 0;
            string acc = "";
            while (Next(out string value))
            {
                acc += value;
                value = null;
                acc += value ?? "nil";
            }

            step = 0;
            while (Next(out string value))
            {
                acc += ":" + value;
                value = null;
                acc += value ?? "nil";
            }

            step = 0;
            for (int i = 0; Next(out string value) && i < 1; i++)
            {
                acc += ":" + value;
                value = null;
                acc += value ?? "nil";
            }

            step = 0;
            for (int i = 0; Next(out string value) && i < 1; i++)
            {
                acc += ":" + value;
                value = null;
                acc += value ?? "nil";
            }

            return acc;
        }

        public static string RunSwitch(int selector)
        {
            step = 0;
            switch (selector)
            {
                case 1 when Next(out string value):
                    string first = value;
                    value = null;
                    return first + ":" + (value ?? "nil");
                case 2 when Next(out string value):
                    string second = value;
                    value = null;
                    return second + ":" + (value ?? "nil");
                default:
                    return "none";
            }
        }

        public static string RunSwitchExpr(int selector)
        {
            step = 0;
            return selector switch
            {
                1 when Next(out string value) => value + ":" + ((value = null) ?? "nil"),
                2 when Next(out string value) => value + ":" + ((value = null) ?? "nil"),
                _ => "none",
            };
        }

        public static string MainEntry() =>
            RunLoops() + "|" + RunSwitch(1) + "|" + RunSwitch(2) + "|" + RunSwitchExpr(1) + "|" + RunSwitchExpr(2);
    }
}`)
        Assert.Contains("var value string?", printed)
        Assert.Contains("var value_2 string?", printed)
        Assert.Contains("Next(out value)", printed)
        Assert.Contains("Next(out value_2)", printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.C.MainEntry())",
            "v1nil:v1nil:v1nil:v1nil|v1:nil|v1:nil|v1:nil|v1:nil"
        )
    }

    @Fact
    func Oblivious_PatternAndDeconstructionArrayLocals_KeepUnbridgedDeconstructionElementStore() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);

    public static class C
    {
        private static Entry Empty() => new Entry(null, 0);

        public static string ViaPattern()
        {
            var items = new Node[1];
            items[0] = null;
            if (items is var arr)
            {
                if (arr == null) { return "missing"; }
                int i;
                (arr[0], i) = Empty();
                object stored = arr[0];
                return (stored == null) + ":" + i;
            }

            return "none";
        }

        public static string ViaDeconstruction()
        {
            var items = new Node[1];
            items[0] = null;
            var pair = (items, 1);
            var (arr, _) = pair;
            if (arr == null) { return "missing"; }
            int i;
            (arr[0], i) = Empty();
            object stored = arr[0];
            return (stored == null) + ":" + i;
        }

        public static string MainEntry() => ViaPattern() + "|" + ViaDeconstruction();
    }
}`)
        Assert.DoesNotContain("arrValue!!", printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.C.MainEntry())",
            "True:0|True:0"
        )
    }

    @Fact
    func Oblivious_QueryClausePromotedOutLocal_AndSynthesizedTempDisambiguation() {
        let printed = TranslateOblivious(`
using System;
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public class Item
    {
        public int Code { get; set; }
    }

    public static class C
    {
        private static int step;

        private static bool Next(out string item)
        {
            step++;
            item = "s" + step;
            return step <= 1;
        }

        private static bool TryLookup(int key, out string value)
        {
            value = "k" + key;
            return key <= 2;
        }

        public static string RunQuery()
        {
            var keys = new[] { 1, 2, 3 };
            var readers = (
                from k in keys
                select (TryLookup(k, out string value)
                    ? new Func<string>(() => value ?? "nil")
                    : new Func<string>(() => (value = null) ?? "nil"))
            ).ToArray();
            return string.Join(":", readers.Select(r => r()));
        }

        public static IEnumerable<int> YieldAfterLoops(bool flag)
        {
            step = 0;
            while (Next(out string item))
            {
                item = null;
            }

            step = 0;
            while (Next(out string item))
            {
                item = null;
            }

            yield return flag ? 1 : 2;
        }

        public static IEnumerable<int> YieldBeforeLoops(bool flag)
        {
            yield return flag ? 10 : 20;
            step = 0;
            while (Next(out string item))
            {
                item = null;
            }

            step = 0;
            while (Next(out string item))
            {
                item = null;
            }
        }

        public static string PatternDesignatorAfterRenamedOut(object boxed)
        {
            step = 0;
            while (Next(out string item))
            {
                item = null;
            }

            step = 0;
            switch (boxed)
            {
                case Item { Code: 7 } when Next(out string item):
                    string seen = item;
                    item = null;
                    return seen + ":" + (item ?? "nil");
                default:
                    return "none";
            }
        }

        public static string TwoCapturedPromotedOutLocals()
        {
            if (!TryLookup(1, out string first))
            {
                first = null;
            }

            if (!TryLookup(9, out string second))
            {
                second = null;
            }

            Func<string> combine = () => (first ?? "nil") + ":" + (second ?? "nil");
            return combine();
        }

        private static bool NextThree(out string value)
        {
            step++;
            value = step.ToString();
            return step <= 2;
        }

        public static string EscapingClosureInLoopCondition()
        {
            step = 0;
            var readers = new List<Func<string>>();
            while (NextThree(out string value))
            {
                readers.Add(() => value ?? "nil");
                value = null;
            }

            step = 0;
            var forReaders = new List<Func<string>>();
            for (int i = 0; NextThree(out string value); i++)
            {
                forReaders.Add(() => value ?? "nil");
                value = null;
            }

            return string.Join(":", readers.Select(r => r())) + "/" + string.Join(":", forReaders.Select(r => r()));
        }

        public static string MainEntry() =>
            RunQuery() + "|" +
            string.Join(",", YieldAfterLoops(true)) + "|" +
            string.Join(",", YieldBeforeLoops(true)) + "|" +
            PatternDesignatorAfterRenamedOut(new Item { Code = 7 }) + "|" +
            TwoCapturedPromotedOutLocals() + "|" +
            EscapingClosureInLoopCondition();
    }
}`)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.C.MainEntry())",
            "k1:k2:nil|1|10|s1:nil|k1:nil|nil:nil/nil:nil"
        )
    }

    @Fact
    func Oblivious_DoWhileContinueAndHoistedPatternNullability_PreserveRuntimeSemantics() {
        let printed = TranslateOblivious(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public sealed class ScopeTracker : IDisposable
    {
        private readonly List<string> log;
        public ScopeTracker(List<string> log)
        {
            this.log = log;
            this.log.Add("enter");
        }

        public void Dispose() => this.log.Add("dispose");
    }

    public static class C
    {
        private static int step;
        private static int filterCalls;

        private static bool Next(out string value)
        {
            step++;
            value = "v" + step;
            return step <= 1;
        }

        private static bool ThrowOnCond(out string value)
        {
            value = "boom";
            throw new InvalidOperationException("cond");
        }

        private static bool LogCond(List<string> log, out string value)
        {
            step++;
            value = "v" + step;
            log.Add("cond:" + step);
            return step <= 1;
        }

        private static bool FalseFilter()
        {
            filterCalls++;
            return false;
        }

        private static string RequireNonNull(string s) => s.ToUpperInvariant();

        public static string DoContinueTryCatchDoesNotCatchConditionException()
        {
            int bodyCaught = 0;
            try
            {
                do
                {
                    try
                    {
                        continue;
                    }
                    catch (InvalidOperationException)
                    {
                        bodyCaught++;
                    }
                } while (ThrowOnCond(out string value) && (value = null) == null);
            }
            catch (InvalidOperationException ex)
            {
                return ex.Message + ":" + bodyCaught;
            }

            return "missed";
        }

        public static string DoContinueUsingDisposesBeforeCondition()
        {
            step = 0;
            var log = new List<string>();
            do
            {
                using (new ScopeTracker(log))
                {
                    if (step == 0)
                    {
                        continue;
                    }
                }
            } while (LogCond(log, out string value) && (value = null) == null);

            return string.Join(">", log);
        }

        public static string DoContinuePreservesCatchFilter()
        {
            step = 0;
            filterCalls = 0;
            try
            {
                do
                {
                    if (step == 1)
                    {
                        continue;
                    }

                    try
                    {
                        throw new InvalidOperationException("filtered");
                    }
                    catch (InvalidOperationException) when (FalseFilter())
                    {
                        return "swallowed";
                    }
                } while (Next(out string value) && (value = null) == null);
            }
            catch (InvalidOperationException ex)
            {
                return ex.Message + ":" + filterCalls;
            }

            return "missed";
        }

        public static string DoContinueInsideSwitchExitsLoop()
        {
            step = 1;
            int afterSwitch = 0;
            do
            {
                switch (step)
                {
                    case 1:
                        continue;
                }

                afterSwitch++;
            } while (Next(out string value) && (value = null) == null);

            return step + ":" + afterSwitch;
        }

        public static string HoistedPatternChecksPromotedNullability()
        {
            step = 0;
            while (Next(out string x) && (x = null) == null && x is string y)
            {
                return "entered:" + RequireNonNull(y);
            }

            step = 0;
            string matched = "none";
            while (Next(out string x) && x is string y)
            {
                x = null;
                y = RequireNonNull(y);
                matched = RequireNonNull(y) + ":" + (x ?? "nil");
            }

            return "skipped/" + matched;
        }

        public sealed class Box
        {
            private int reads;
            public string Name { get; set; }
            public object Value { get; set; }
            public int ReadCount => this.reads;
            public string ComputedName => "n" + (++this.reads);
            public Box NullChild => default(Box);
        }

        public static string NestedPropertyPatternInHoistedLoop(Box box)
        {
            step = 0;
            while (Next(out string x) && box is { Name: string name })
            {
                x = null;
                return RequireNonNull(name) + ":" + (x ?? "nil");
            }

            return "no-match";
        }

        public static string BoxedValuePropertyPatternInHoistedLoop(Box box)
        {
            step = 0;
            while (Next(out string x) && box is { Value: int n })
            {
                x = null;
                return n + ":" + (x ?? "nil");
            }

            return "no-int";
        }

        public static string ComputedPropertyPatternEvaluatedOnce()
        {
            step = 0;
            var box = new Box();
            while (Next(out string x) && box is { ComputedName: string name })
            {
                x = null;
                return RequireNonNull(name) + ":" + box.ReadCount;
            }

            return "none";
        }

        public static string ComputedPropertyVarPatternEvaluatedOnce()
        {
            step = 0;
            var box = new Box();
            while (Next(out string x) && box is { ComputedName: var name })
            {
                x = null;
                return RequireNonNull(name) + ":" + box.ReadCount;
            }

            return "none";
        }

        public static string NullComputedPropertyVarPatternMatches(Box box)
        {
            string ifResult = "missed";
            if (box is { NullChild: var c })
            {
                c = new Box { Name = "replaced" };
                ifResult = c.Name;
            }

            step = 0;
            string whileResult = "missed";
            while (Next(out string x) && box is { NullChild: var loopChild })
            {
                x = null;
                loopChild = new Box { Name = "loop" };
                whileResult = loopChild.Name;
            }

            return ifResult + ":" + whileResult;
        }

        public static string DoAndForContinueInsideLock()
        {
            object gate = new object();
            step = 0;
            int doRuns = 0;
            do
            {
                doRuns++;
                lock (gate)
                {
                    continue;
                }
            } while (Next(out string x) && (x = null) == null);

            step = 0;
            int forIncs = 0;
            for (; Next(out string x); forIncs++)
            {
                x = null;
                lock (gate)
                {
                    continue;
                }
            }

            return doRuns + ":" + step + "/" + forIncs;
        }

        private static int index;

        public static string ForBodyLocalShadowsStaticIncrementorTarget()
        {
            step = 0;
            index = 0;
            for (; Next(out string value); index++)
            {
                int index = 40;
                index++;
                value = (value = null) ?? index.ToString();
            }

            return index.ToString();
        }

        private static void ThrowIncrementor() => throw new InvalidOperationException("inc");

        public static string ForContinueTryCatchDoesNotCatchIncrementorException()
        {
            step = 0;
            try
            {
                for (; Next(out string value); ThrowIncrementor())
                {
                    value = null;
                    try
                    {
                        continue;
                    }
                    catch (InvalidOperationException)
                    {
                        return "caught";
                    }
                }
            }
            catch (InvalidOperationException ex)
            {
                return ex.Message;
            }

            return "missed";
        }

        public static string ForContinueUsingDisposesBeforeIncrementor()
        {
            step = 0;
            var log = new List<string>();
            for (; Next(out string value); _ = LogCond(log, out string inc) && (inc = null) == null)
            {
                value = null;
                using (new ScopeTracker(log))
                {
                    if (step == 1)
                    {
                        continue;
                    }
                }
            }

            return string.Join(">", log);
        }

        public static bool GenericTypeParameterPatternInHoistedLoop<T>(T value)
        {
            step = 0;
            while (Next(out string x) && value is T y)
            {
                x = null;
                return y != null;
            }

            return false;
        }

        public static string MainEntry() =>
            DoContinueTryCatchDoesNotCatchConditionException() + "|" +
            DoContinueUsingDisposesBeforeCondition() + "|" +
            DoContinuePreservesCatchFilter() + "|" +
            DoContinueInsideSwitchExitsLoop() + "|" +
            HoistedPatternChecksPromotedNullability() + "|" +
            NestedPropertyPatternInHoistedLoop(new Box { Name = "ok" }) + ":" +
            NestedPropertyPatternInHoistedLoop(new Box { Name = null }) + "|" +
            ForContinueTryCatchDoesNotCatchIncrementorException() + "|" +
            ForContinueUsingDisposesBeforeIncrementor() + "|" +
            GenericTypeParameterPatternInHoistedLoop<string>(null) + ":" +
            GenericTypeParameterPatternInHoistedLoop<string>("hi") + "|" +
            BoxedValuePropertyPatternInHoistedLoop(new Box { Value = 42 }) + ":" +
            BoxedValuePropertyPatternInHoistedLoop(new Box { Value = "nope" }) + "|" +
            ComputedPropertyPatternEvaluatedOnce() + ":" +
            ComputedPropertyVarPatternEvaluatedOnce() + ":" +
            NullComputedPropertyVarPatternMatches(new Box()) + "|" +
            DoAndForContinueInsideLock() + "|" +
            ForBodyLocalShadowsStaticIncrementorTarget();
    }
}`)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.C.MainEntry())",
            "cond:0|enter>dispose>cond:1>enter>dispose>cond:2|filtered:1|2:0|skipped/V1:nil|OK:nil:no-match|inc|enter>dispose>cond:2|False:True|42:nil:no-int|N1:1:N1:1:replaced:loop|2:2/1|1"
        )
    }

    @Fact
    func Oblivious_NonNullOutVar_StaysBare() {
        // The out parameter is always assigned a non-null value, so neither the
        // parameter nor the receiving local is promoted and no `!!` appears.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public bool TryPick(object value, out string picked)
        {
            picked = "fixed";
            return true;
        }

        public int Consume(string exact) { return exact.Length; }

        public int Run(object value)
        {
            if (this.TryPick(value, out var picked))
            {
                return this.Consume(picked);
            }

            return 0;
        }
    }
}`)
        Assert.Contains("out picked string)", printed)
        Assert.Contains("Consume(picked)", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
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
    }
}
