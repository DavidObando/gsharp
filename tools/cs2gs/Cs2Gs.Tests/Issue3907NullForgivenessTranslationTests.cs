// <copyright file="Issue3907NullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3907: two translation faithfulness defects found by the migrated
/// <c>src/Sdk/Gsharp.Runtime.Channels</c>.
/// </summary>
/// <remarks>
/// <para><b>A deconstruction-assignment TARGET skipped the null-forgiveness
/// lift.</b> <c>SelectRandom.Shuffle</c>'s Fisher–Yates swap
/// <c>(order[i], order[j]) = (order[j], order[i]);</c> sits two lines below
/// <c>order[i] = i;</c>, on the same <c>int[]?</c> local, flow-proved non-null
/// by the same preceding guard. The single-target write got its <c>!!</c>; the
/// deconstruction targets did not, because
/// <c>TryLowerNativeMultiAssignment</c> translated each target with the plain
/// expression translator rather than the assignment-target translator every
/// other write goes through. gsc then rejected the indexing of a <c>[]?int32</c>
/// with <c>GS0116</c>.</para>
/// <para><b>An inferred local's delegate type was erased to its arrow
/// type.</b> <c>GoroutineRuntime.TryHandle</c>'s <c>var handlers =
/// UnhandledGoroutineException;</c> is a plain <c>var</c>; the type clause
/// exists only to carry the issue-#1072 nullable widening. Mapping it through
/// the structural type mapper turned <c>EventHandler&lt;T&gt;</c> into
/// <c>(object?, T) -&gt; void</c>, and in G# the conversion between a nominal
/// delegate and a structurally equal function type is EXPLICIT — so the emitted
/// declaration failed with <c>GS0156</c>.</para>
/// </remarks>
public class Issue3907NullForgivenessTranslationTests
{
    [Fact]
    public void DeconstructionAssignmentTargets_GetTheSameNullForgivenessAsASingleTarget()
    {
        string printed = Translate(@"
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
}");

        // The anti-vacuity anchor: the single-target write on the SAME local
        // already lifted before this fix, so a test that only asserted the
        // swap line's presence would pass on a broken build.
        Assert.Contains("order!![i] = i", printed, StringComparison.Ordinal);

        // The regression itself: every indexing in the swap is lifted too.
        Assert.Contains(
            "order!![i], order!![j] = order!![j], order!![i]",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void InferredNullableLocal_KeepsADelegatesNominalType()
    {
        string printed = Translate(@"
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
}");

        // The nominal delegate name survives; the structural arrow spelling
        // (which gsc will not implicitly convert to) must not appear.
        Assert.Contains("EventHandler[EventArgs]?", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(object?, EventArgs) -> void", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", "using System;\n\nnamespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip.Errors)
                + "\n\nPrinted:\n" + printed);

        return printed;
    }
}
