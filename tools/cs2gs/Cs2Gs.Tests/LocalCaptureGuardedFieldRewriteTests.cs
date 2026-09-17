// <copyright file="LocalCaptureGuardedFieldRewriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #4262 follow-up (5-item plan, item 2):
/// a statement-level early-return null guard on a field/property
/// (<c>if (F == null) { return; }</c>, including a compound-condition
/// disjunct such as <c>if (flag || F == null) { return; }</c>) proves
/// <c>F</c> non-null for every statement that follows the guard in the SAME
/// block. Rather than asserting <c>F!!</c> at every one of those later
/// dereferences (the pre-existing <see cref="Issue2202NullGuardNarrowedFieldForgivenessTranslationTests"/>
/// / <see cref="Issue2164LazySingletonNullForgivenessTranslationTests"/>
/// per-use behavior, still the FALLBACK here), the translator now captures
/// <c>F</c> into a synthesized local right after the guard
/// (<c>let __guardN = F!!</c>) and rewrites the guard-dominated later reads
/// to use that local instead — a plain non-null <c>T</c> local needs no
/// further assertion at its own use sites.
/// </summary>
public class LocalCaptureGuardedFieldRewriteTests
{
    [Fact]
    public void EarlyReturnGuard_SingleLaterDereference_RewritesToLocalCapture()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
        }
    }
}");

        Assert.Contains("let __guard0 = F!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);

        // The rewritten use must not ALSO carry its own assertion.
        string useBody = printed.Substring(printed.IndexOf("func Use()", StringComparison.Ordinal));
        Assert.DoesNotContain("F!!.ToUpper", useBody);
    }

    [Fact]
    public void EarlyReturnGuard_MultipleLaterUses_ShareOneCapturedLocal()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
            F.ToLower();
            F.Trim();
        }
    }
}");

        Assert.Contains("let __guard0 = F!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
        Assert.Contains("__guard0.ToLower()", printed);
        Assert.Contains("__guard0.Trim()", printed);

        // Only ONE capture is synthesized for the three uses.
        Assert.DoesNotContain("__guard1", printed);
    }

    [Fact]
    public void EarlyReturnGuard_CompoundOrCondition_StillCaptures()
    {
        // `if (flag || F == null) { return; }` — the exact Oahu ViewModel
        // shape from the follow-up investigation. Fallthrough still proves
        // `F` non-null (De Morgan), regardless of the unrelated `flag`
        // disjunct.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        private bool flag;
        public string F { get; set; }

        public void Use()
        {
            if (flag || F == null)
            {
                return;
            }

            F.ToUpper();
        }
    }
}");

        Assert.Contains("let __guard0 = F!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
    }

    [Fact]
    public void FieldReassignedBetweenGuardAndUse_LaterUseKeepsPerUseAssertion()
    {
        // The first use (before the reassignment) is captured; the second
        // use (after `F = null;`) must still fall back to a per-use `!!` —
        // rewriting it to the STALE captured local would be a correctness
        // bug (it would see the pre-reassignment value).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
            F = null;
            F.ToLower();
        }
    }
}");

        Assert.Contains("let __guard0 = F!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
        Assert.Contains("F = nil", printed);
        Assert.Contains("F!!.ToLower()", printed);

        // The written-between use is never redirected to the stale capture.
        Assert.DoesNotContain("__guard0.ToLower()", printed);
    }

    [Fact]
    public void LoopCarriedWriteAfterGuard_FallsBackToPerUseAssertion()
    {
        // A write inside the loop body invalidates the outer guard's proof
        // for later iterations (HasLoopCarriedWrite) — no capture at all,
        // exactly like the existing #2202 rule already refuses to trust a
        // loop-carried guard.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            for (int i = 0; i < 3; i++)
            {
                F.ToUpper();
                if (i == 1)
                {
                    F = null;
                }
            }
        }
    }
}");

        Assert.DoesNotContain("__guard", printed);
        Assert.Contains("F!!.ToUpper()", printed);
    }

    [Fact]
    public void GotoGuard_DoesNotCapture_LabelCanSkipTheCapture()
    {
        // `goto` (unlike `return`/`throw`) does not exit the enclosing
        // method body — it can jump FORWARD to a label that lies among the
        // very "later statements" a capture would be inserted before. If
        // this guard were (wrongly) treated as an early-return guard, the
        // `goto` path would reach `SkipF:` — and the use after it — having
        // skipped `let __guardN = F!!` entirely, reading an unassigned
        // local. No capture must be synthesized for this guard at all; every
        // later use keeps its own per-use `!!` fallback (still correct,
        // because gsc never actually reaches that use with `F` proven null
        // by a captured local that was never assigned).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                goto SkipF;
            }

            F.ToUpper();

            SkipF:
            F.ToLower();
        }
    }
}");

        Assert.DoesNotContain("__guard", printed);
        Assert.Contains("F!!.ToUpper()", printed);
        Assert.Contains("F!!.ToLower()", printed);
    }

    [Fact]
    public void PropertyGuard_SameEarlyReturnShape_RewritesToLocalCapture()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string Name { get; set; }

        public void Use()
        {
            if (Name == null)
            {
                return;
            }

            Name.ToUpper();
        }
    }
}");

        Assert.Contains("let __guard0 = Name!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
    }

    [Fact]
    public void ComputedPropertyGuard_SameEarlyReturnShape_FallsBackToPerUseAssertion()
    {
        // `Name` is a COMPUTED (expression-bodied) property, not an
        // auto-property — its getter is not a pure storage read. Capturing
        // it once at the guard would collapse two getter evaluations into
        // one, changing observable behavior for a getter that computes a
        // fresh value or has side effects on each call. The rewrite must
        // exclude it, keeping the existing per-use `!!` fallback (which is
        // faithful to C#'s own per-read call count).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        private int calls;
        public string Name => (calls++).ToString();

        public void Use()
        {
            if (Name == null)
            {
                return;
            }

            Name.ToUpper();
            Name.ToLower();
        }
    }
}");

        Assert.DoesNotContain("__guard", printed);
        Assert.Contains("Name!!.ToUpper()", printed);
        Assert.Contains("Name!!.ToLower()", printed);
    }

    [Fact]
    public void FieldGuard_IsNullPattern_RewritesToLocalCapture()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        private string f;

        public void Use()
        {
            if (f is null)
            {
                return;
            }

            f.ToUpper();
        }
    }
}");

        Assert.Contains("let __guard0 = f!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
    }

    [Fact]
    public void GuardDoesNotLeakPastNestedBlock_FallsBackToPerUseAssertion()
    {
        // The guard sits inside `if (flag) { … }`, so it dominates nothing
        // outside that nested block (mirrors ComputeBooleanFlowRegions'
        // identical "only a direct block child leaks" restriction) — the
        // later use keeps its own per-use assertion.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use(bool flag)
        {
            if (flag)
            {
                if (F == null)
                {
                    return;
                }
            }

            F.ToUpper();
        }
    }
}");

        Assert.DoesNotContain("__guard", printed);
        Assert.Contains("F!!.ToUpper()", printed);
    }

    [Fact]
    public void DifferentInstanceReceiver_NeverSubstitutesCapturedLocal()
    {
        // `other.F` binds to the SAME symbol as `this`'s `F` (a field/
        // property symbol is shared across every instance of its declaring
        // type), but it reads a DIFFERENT instance's storage — it must never
        // be redirected to this method's captured local.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use(Holder other)
        {
            if (F == null)
            {
                return;
            }

            other.F.ToUpper();
        }
    }
}");

        Assert.DoesNotContain("__guard", printed);
        Assert.Contains("other.F!!.ToUpper()", printed);
    }

    [Fact]
    public void RedundantLaterGuardOnSameField_ReusesOneCapturedLocal()
    {
        // A second, redundant `if (F == null) return;` later in the same
        // block (common in real code — a defensive re-check) must not
        // synthesize a SECOND capture: the first capture's region already
        // reaches everything after the second guard too, and the second
        // guard's own condition becomes a (harmless, always-false) check of
        // the already-non-null captured local.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();

            if (F == null)
            {
                return;
            }

            F.ToLower();
        }
    }
}");

        Assert.Contains("let __guard0 = F!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
        Assert.Contains("if __guard0 == nil", printed);
        Assert.Contains("__guard0.ToLower()", printed);
        Assert.DoesNotContain("__guard1", printed);
    }

    [Fact]
    public void NullableEnabledCompilation_EarlyReturnGuard_RewritesToLocalCapture()
    {
        // The rewrite is not gated on oblivious compilation: a nullable-
        // ENABLED file with the identical statement-level early-return guard
        // shape gets the same treatment.
        string printed = TranslateEnabled(@"
#nullable enable
namespace Demo
{
    public class Holder
    {
        public string? F { get; set; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
        }
    }
}");

        Assert.Contains("let __guard0 = F!!", printed);
        Assert.Contains("__guard0.ToUpper()", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        return TranslateAndPrint(project);
    }

    private static string TranslateEnabled(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        return TranslateAndPrint(project);
    }

    private static string TranslateAndPrint(LoadedCSharpProject project)
    {
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
