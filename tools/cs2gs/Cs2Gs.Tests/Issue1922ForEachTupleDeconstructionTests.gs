// <copyright file="Issue1922ForEachTupleDeconstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Regression tests for issue #1922: cs2gs used to lower a C#
/// `foreach (var (a, b) in xs)` to a hidden temp variable plus a
/// separate `let (a, b) = tmp` deconstruction statement, which then
/// failed to compile in gsc (`GS0164`) once the loop's tuple-typed
/// element resolved to a raw imported `System.ValueTuple<...>`.
/// Now that G# has a first-class deconstructing loop header
/// (`for (a, b) in xs { ... }`), a synchronous `foreach` tuple
/// deconstruction should translate directly to it instead.
open class Issue1922ForEachTupleDeconstructionTests {
    @Fact
    func ForEachTupleDeconstruction_TranslatesToFirstClassForTupleIn() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M(List<(string Name, int Score)> xs)
        {
            foreach (var (name, score) in xs)
            {
                Console.WriteLine(name);
            }
        }
    }
}`)
        Assert.Contains("for (name, score) in xs {", printed)
        // The old two-step lowering (hidden temp variable plus a separate
        // `let (a, b) = tmp` statement) must be gone.
        Assert.DoesNotContain("__decon", printed)
        Assert.DoesNotContain("let (name, score)", printed)
    }

    @Fact
    func ForEachTupleDeconstruction_DiscardName_TranslatesToUnderscore() {
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M(List<(string, int)> xs)
        {
            foreach (var (name, _) in xs)
            {
            }
        }
    }
}`)
        Assert.Contains("for (name, _) in xs {", printed)
    }

    @Fact
    func KeyValuePairDeconstruction_TranslatesToCompilerSupportedForTupleIn() {
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M(Dictionary<string, int> values)
        {
            foreach (var (key, value) in values)
            {
            }
        }
    }
}`)
        Assert.Contains("for (key, value) in values {", printed)
        Assert.DoesNotContain("__decon", printed)
    }

    @Fact
    func ConcurrentDictionaryOfNestedUserGenericDeconstruction_TranslatesToCompilerSupportedForTupleIn() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Demo
{
    public sealed class JobUpdate
    {
        int Number { get; }
    }

    public sealed class C
    {
        public void M(ConcurrentDictionary<Guid, Channel<JobUpdate>> subscribers)
        {
            foreach (var (key, ch) in subscribers)
            {
                Console.WriteLine(ch.Reader.Count);
            }
        }
    }
}`)
        Assert.Contains("import System.Collections.Concurrent", printed)
        Assert.Contains("import System.Threading.Channels", printed)
        Assert.Contains("for (key, ch) in subscribers {", printed)
        Assert.Contains("ch.Reader.Count", printed)
        Assert.DoesNotContain("import System.Collections.Generic", printed)
    }

    @Fact
    func AwaitForEachTupleDeconstruction_KeepsTempPlusLetLowering() {
        // G# has no first-class `await for (a, b) in` header, so the async
        // form must keep the older temp-variable-plus-`let` lowering instead
        // of emitting syntax G# cannot parse.
        let printed = TranslateUnit(`
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public async Task M(IAsyncEnumerable<(string Name, int Score)> xs)
        {
            await foreach (var (name, score) in xs)
            {
            }
        }
    }
}`)
        Assert.Contains("await for nameItem", printed)
        Assert.Contains("let (name, score) = nameItem", printed)
        Assert.DoesNotContain("__decon", printed)
    }

    @Fact
    func NestedForEachTupleDeconstruction_PreservesOuterArityAndExecutes() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public sealed class C
    {
        private static int Pick(object value) => 7;
        private static int Pick(string value) => 99;

        public static long Run()
        {
            long total = 0;
            foreach (var (a, (b, c)) in new[] { (1, (2, 3)) })
            {
                total += a + b + c;
            }

            int dTuple = 100;
            foreach ((var x, (var d, (var e, _))) in new[] { (10, (20, (30, 40))) })
            {
                total += x + d + e + dTuple;
            }

            foreach ((int head, (long widened, int tail)) in new[] { (0, (1, 0)) })
            {
                total += head + (widened << 32) + tail;
            }

            foreach ((int head, (long? nullableWidened, int tail)) in new[] { (0, ((int?)null, 0)), (1, ((int?)2, 3)) })
            {
                total += head + ((nullableWidened ?? 0L) << 32) + tail;
            }

            foreach ((int head, ((long, long) pair, int tail)) in new[] { (0, ((1, 2), 0)) })
            {
                total += head + (pair.Item1 << 32) + pair.Item2 + tail;
            }

            foreach ((int head, ((object, object) objectPair, int tail)) in new[] { (0, (("a", "b"), 0)) })
            {
                total += head + Pick(objectPair.Item1) + tail;
            }

            return total;
        }
    }
}`)
        Assert.Contains("for (a, bTuple) in [](int32, (int32, int32)){(1, (2, 3))} {", printed)
        Assert.Contains("let (b, c) = bTuple", printed)
        Assert.Contains("for (x, dTuple2) in", printed)
        Assert.Contains("let (d, eTuple) = dTuple2", printed)
        Assert.Contains("let (e, _) = eTuple", printed)
        Assert.Contains("let (widenedValue, tail) = widenedTuple", printed)
        Assert.Contains("let widened int64 = int64(widenedValue)", printed)
        Assert.Contains("let objectPair (object, object) = objectPairValue", printed)
        Assert.DoesNotContain("for (a, b, c) in", printed)
        let result = EmittedOracle.Evaluate(printed + "\nDemo.C.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(17179869363L, result.Value)
    }

    @Fact
    func NestedForEachTupleDeconstruction_RunsDeconstructionsBeforeLeafConversions() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Log
    {
        public static int Order;
    }

    public readonly struct Convertible
    {
        public static implicit operator int(Convertible value)
        {
            return (Log.Order = (Log.Order * 10) + 2);
        }
    }

    public sealed class Pair
    {
        public void Deconstruct(out int left, out int right)
        {
            Log.Order = (Log.Order * 10) + 1;
            left = 3;
            right = 4;
        }
    }

    public sealed class C
    {
        public static int Run()
        {
            Log.Order = 0;
            foreach ((int first, (var x, var y)) in new[] { (new Convertible(), new Pair()) })
            {
                return (Log.Order * 100) + first + x + y;
            }
            return 0;
        }
    }
}`)
        let deconstructIdx = printed.IndexOf("let (x, y) = xTuple", StringComparison.Ordinal)
        let convertIdx = printed.IndexOf("let first int32 = int32(firstValue)", StringComparison.Ordinal)
        Assert.True(deconstructIdx >= 0 && convertIdx > deconstructIdx, printed)
        let result = EmittedOracle.Evaluate(printed + "\nDemo.C.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(1219, result.Value)
    }

    @Fact
    func AwaitForEachNestedTupleDeconstruction_PreservesOuterArity() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public async Task<int> Sum(IAsyncEnumerable<(int Head, (int Left, int Right))> xs)
        {
            int sum = 0;
            await foreach (var (_, (left, right)) in xs)
            {
                sum += left + right;
            }
            return sum;
        }
    }
}`)
        Assert.Contains("await for leftItem in xs {", printed)
        Assert.Contains("let (_, leftTuple) = leftItem", printed)
        Assert.Contains("let (left, right) = leftTuple", printed)
        Assert.DoesNotContain("let (_, left, right)", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
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
            return printed
        }
    }
}
