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

        // …and only there. A guarded receiver and a never-promoted one keep
        // their bare form; asserting either would churn `!!` across every
        // oblivious project and leave GS0536 for the polish pass to strip.
        Assert.Contains("guarded.Up[Node]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("guarded!!.Up[Node]()", printed, StringComparison.Ordinal);
        Assert.Contains("clean.Up[Node]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("clean!!.Up[Node]()", printed, StringComparison.Ordinal);
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
