// <copyright file="Issue4287GenericInstanceCallReceiverForgivenessTests.cs" company="GSharp">
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
/// Regression coverage for issue #4287's self-migration fallout. A generic
/// instance call carrying EXPLICIT type arguments (<c>x.M&lt;T&gt;()</c>) is
/// translated by its own branch in
/// <c>CSharpToGSharpTranslator.TranslateInvocationCore</c>, and that branch was
/// the one receiver position that built its target with a bare
/// <c>TranslateExpression</c> instead of
/// <c>TranslateReceiverWithNullForgiveness</c>. A NON-generic call
/// (<c>x.M()</c>) falls through to the general path, which routes through the
/// member-access translation and DOES forgive, so <c>x.Parent</c> and
/// <c>x.M()</c> were both asserted while <c>x.M&lt;T&gt;()</c> was left bare.
/// <para>
/// That was invisible while gsc bound an instance call on a nilable receiver
/// unguarded. Issue #4287 closed that hole, and the missing assertion became
/// <c>GS0159</c> ("receiver ... may be nil") on three sites in the migrated
/// <c>Cs2Gs.Translator</c> itself — all of them
/// <c>node.FirstAncestorOrSelf&lt;T&gt;()</c> on an oblivious parameter the
/// whole-program taint fixpoint had promoted to <c>T?</c> — which took the
/// self-migration PR guard from 8/8 to 5/8.
/// </para>
/// </summary>
public sealed class Issue4287GenericInstanceCallReceiverForgivenessTests
{
    [Fact]
    public void GenericInstanceCall_PromotedReceiver_AssertsLikeTheNonGenericAndReadForms()
    {
        string printed = Translate("""
            namespace Demo;

            public class Node
            {
                public Node Parent => null;
                public Node Plain() => null;
                public T Up<T>() where T : Node => null;
            }

            public static class Repro
            {
                // The taint evidence. Without a null-valued call site the
                // whole-program fixpoint leaves these parameters non-nullable
                // and nothing here is promoted, so the defect cannot appear.
                public static bool Drive() =>
                    CallIsFirstUse(null)
                    || ReadThenCall(null)
                    || GuardedThenCall(null)
                    || Untainted(new Node());

                // The failing shape: a generic instance call is the FIRST use
                // of a promoted receiver. Was bare, must now assert.
                public static bool CallIsFirstUse(Node use) => use.Up<Node>() != null;

                // The same receiver used BOTH ways in one method. The read was
                // always asserted; the generic call beside it was not.
                public static bool ReadThenCall(Node both)
                {
                    Node p = both.Parent;
                    return p != null && both.Up<Node>() != null && both.Plain() != null;
                }

                // Over-insertion sentinel: a real nil guard narrows the
                // receiver in G# too, so this must stay bare.
                public static bool GuardedThenCall(Node guarded)
                {
                    if (guarded == null)
                    {
                        return false;
                    }

                    return guarded.Up<Node>() != null;
                }

                // Over-insertion sentinel: never null-tainted, so never
                // promoted to `T?` and never asserted.
                public static bool Untainted(Node clean) => clean.Up<Node>() != null;
            }
            """);

        // The fix: the generic call now forgives its receiver, exactly as the
        // read and the non-generic call beside it always did.
        Assert.Contains("use!!.Up[Node]()", printed, StringComparison.Ordinal);
        Assert.Contains("both!!.Parent", printed, StringComparison.Ordinal);
        Assert.Contains("both!!.Up[Node]()", printed, StringComparison.Ordinal);
        Assert.Contains("both!!.Plain()", printed, StringComparison.Ordinal);

        // The over-insertion sentinel THIS layer can state: a receiver the
        // taint fixpoint never promoted is not nullable in G# at all, so it
        // must never be asserted, under any flow analysis.
        Assert.False(printed.Contains("clean!!", StringComparison.Ordinal), printed);

        // The guarded receiver is deliberately NOT a sentinel here, and the
        // distinction is worth stating because it is easy to mis-read as
        // over-insertion. This test exercises the TRANSLATOR alone
        // (TranslateDocument + print), and the translator is liberal by
        // design: it emits `guarded!!` and leaves removal to CompileStage's
        // NullAssertionPolishPass, which strips every assertion gsc reports
        // as unnecessary (GS0536 — 832 of them on one hot-core run). Through
        // the full migrate pipeline the same source comes back
        // `guarded.Up[Node]()`, bare, because the `if guarded == nil` guard
        // narrows the parameter in G# exactly as in C#. That end-to-end
        // behaviour is witnessed by the minimal-project run recorded on the
        // PR: pre-fix three GS0159, post-fix green, and the emitted diff is
        // exactly three `!!` insertions — none of them on this receiver.
        Assert.Contains("guarded!!.Up[Node]()", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericInstanceCall_ThisReceiver_IsNeverAsserted()
    {
        // `this` is never nilable, and the branch this fix touches covers every
        // `x.M<T>(...)`, so pin that widening the receiver treatment did not
        // reach it.
        string printed = Translate("""
            namespace Demo;

            public class Node
            {
                public T Up<T>() where T : Node => null;

                public bool ViaThis() => this.Up<Node>() != null;
            }
            """);

        Assert.Contains("this.Up[Node]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("this!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void BareMemberGuardedInSameCondition_IsAsserted_WhileTheQualifiedFormIsNot()
    {
        // The private Oahu corpus failed on `X != null && X.Contains(i)` where
        // `X` is a member. cs2gs's stability classification is RIGHT — it
        // already asserts a mutable field and a settable property, which gsc
        // will not narrow — but gsc narrows a stable member path only through
        // its QUALIFIED form: `this.RoField != nil && this.RoField.Contains(i)`
        // compiles while the identical BARE form does not, for a readonly field
        // and a get-only property alike, and for a read exactly as for a call.
        // So a bare reference is not a path gsc narrows, and claiming otherwise
        // dropped a `!!` the emitted code needs.
        string printed = Translate("""
            using System.Collections.Generic;

            namespace Demo;

            public class Holder
            {
                public readonly List<int> RoField;
                public List<int> MutField;
                public List<int> GetOnlyProp { get; }
                public List<int> GetSetProp { get; set; }

                public Holder(List<int> v)
                {
                    RoField = v;
                    MutField = v;
                    GetOnlyProp = v;
                    GetSetProp = v;
                }

                public bool ViaRoField(int i) => RoField != null && RoField.Contains(i);

                public bool ViaMutField(int i) => MutField != null && MutField.Contains(i);

                public bool ViaGetOnly(int i) => GetOnlyProp != null && GetOnlyProp.Contains(i);

                public bool ViaGetSet(int i) => GetSetProp != null && GetSetProp.Contains(i);

                public bool ViaQualified(int i) => this.RoField != null && this.RoField.Contains(i);

                public static bool Drive()
                {
                    var h = new Holder(null);
                    return h.ViaRoField(1) || h.ViaMutField(1)
                        || h.ViaGetOnly(1) || h.ViaGetSet(1) || h.ViaQualified(1);
                }
            }
            """);

        // Every BARE guarded member is asserted, stable or not — gsc narrows
        // none of them.
        Assert.Contains("RoField!!.Contains(i)", printed, StringComparison.Ordinal);
        Assert.Contains("MutField!!.Contains(i)", printed, StringComparison.Ordinal);
        Assert.Contains("GetOnlyProp!!.Contains(i)", printed, StringComparison.Ordinal);
        Assert.Contains("GetSetProp!!.Contains(i)", printed, StringComparison.Ordinal);

        // The sentinel: the QUALIFIED form of the very same stable field is a
        // path gsc does narrow, so it keeps its bare call. This is what pins
        // that the rule declines BARE references rather than all stable
        // members — without it the change would be indistinguishable from
        // giving up on member narrowing altogether.
        Assert.Contains("this.RoField.Contains(i)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("this.RoField!!", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
