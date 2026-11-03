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

        public static string MainEntry() =>
            RunQuery() + "|" +
            string.Join(",", YieldAfterLoops(true)) + "|" +
            string.Join(",", YieldBeforeLoops(true)) + "|" +
            PatternDesignatorAfterRenamedOut(new Item { Code = 7 }) + "|" +
            TwoCapturedPromotedOutLocals();
    }
}`)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(Demo.C.MainEntry())",
            "k1:k2:nil|1|10|s1:nil|k1:nil"
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
