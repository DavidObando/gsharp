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
