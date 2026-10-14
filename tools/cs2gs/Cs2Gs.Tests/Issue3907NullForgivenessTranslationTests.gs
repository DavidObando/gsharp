// <copyright file="Issue3907NullForgivenessTranslationTests.cs" company="GSharp">
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

/// Issue #3907: two translation faithfulness defects found by the migrated
/// `src/Sdk/Gsharp.Runtime.Channels`.
/// @remarks <b>A deconstruction-assignment TARGET skipped the null-forgiveness
/// lift.</b> `SelectRandom.Shuffle`'s Fisher–Yates swap
/// `(order[i], order[j]) = (order[j], order[i]);` sits two lines below
/// `order[i] = i;`, on the same `int[]?` local, flow-proved non-null
/// by the same preceding guard. The single-target write got its `!!`; the
/// deconstruction targets did not, because
/// `TryLowerNativeMultiAssignment` translated each target with the plain
/// expression translator rather than the assignment-target translator every
/// other write goes through. gsc then rejected the indexing of a `[]?int32`
/// with `GS0116`.
///
/// <b>An inferred local's delegate type was erased to its arrow
/// type.</b> `GoroutineRuntime.TryHandle`'s `var handlers =
/// UnhandledGoroutineException;` is a plain `var`; the type clause
/// exists only to carry the issue-#1072 nullable widening. Mapping it through
/// the structural type mapper turned `EventHandler<T>` into
/// `(object?, T) -> void`, and in G# the conversion between a nominal
/// delegate and a structurally equal function type is EXPLICIT — so the emitted
/// declaration failed with `GS0156`.
open class Issue3907NullForgivenessTranslationTests {
    @Fact
    func DeconstructionAssignmentTargets_GetTheSameNullForgivenessAsASingleTarget() {
        let printed = Translate(`
public sealed class C
{
    private static int[]? buffer;

    public static int M(int n)
    {
        var order = buffer;
        if (order is null || order.Length < n)
        {
            order = buffer = new int[System.Math.Max(n, 8)];
        }

        for (int i = 0; i < n; i++)
        {
            order[i] = i;
        }

        for (int i = n - 1; i > 0; i--)
        {
            int j = i / 2;
            (order[i], order[j]) = (order[j], order[i]);
        }

        return order[0];
    }
}`)
        // The anti-vacuity anchor: the single-target write on the SAME local
        // already lifted before this fix, so a test that only asserted the
        // swap line's presence would pass on a broken build.
        Assert.Contains("order!![i] = i", printed, StringComparison.Ordinal)
        // The regression itself: every indexing in the swap is lifted too.
        Assert.Contains("order!![i], order!![j] = order!![j], order!![i]", printed, StringComparison.Ordinal)
    }

    @Fact
    func InferredNullableLocal_KeepsADelegatesNominalType() {
        let printed = Translate(`
public sealed class C
{
    public static event EventHandler<EventArgs>? Ticked;

    public static bool M()
    {
        var handlers = Ticked;
        if (handlers is null)
        {
            return false;
        }

        handlers(null, EventArgs.Empty);
        return true;
    }
}`)
        // The nominal delegate name survives; the structural arrow spelling
        // (which gsc will not implicitly convert to) must not appear.
        Assert.Contains("EventHandler[EventArgs]?", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(object?, EventArgs) -> void", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `using System;

namespace Demo
{
` + source + `
}
`)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
