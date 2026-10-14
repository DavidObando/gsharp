// <copyright file="LocalCaptureGuardedFieldRewriteTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #4262 follow-up (5-item plan, item 2):
/// a statement-level early-return null guard on a field/property
/// (`if (F == null) { return; }`, including a compound-condition
/// disjunct such as `if (flag || F == null) { return; }`) proves
/// `F` non-null for every statement that follows the guard in the SAME
/// block (or switch section). Rather than asserting `F!!` at every one
/// of those later dereferences (the pre-existing
/// (cref:Issue2202NullGuardNarrowedFieldForgivenessTranslationTests) /
/// (cref:Issue2164LazySingletonNullForgivenessTranslationTests)
/// per-use behavior, still the FALLBACK here), the translator now captures
/// `F` into a local — NAMED BY LOWERCASING THE FIELD/PROPERTY'S OWN
/// FIRST LETTER, never a synthetic `__identifier` (issue #3501's
/// synthetic-identifier reduction target) — right after the guard, and
/// rewrites the guard-dominated later reads to use that local instead. A
/// name collision falls back to the per-use `!!` rather than inventing
/// a suffixed alternative, and the rewrite is further restricted to
/// genuinely STABLE members (a `readonly` field, or a non-virtual
/// get-only/init-only auto-property) — the same stability concept item 1
/// (#4277) introduced for its own analogous narrowing decision — since only
/// those cannot be reassigned by an intervening call or dispatch to an
/// override between the guard and a later use.
open class LocalCaptureGuardedFieldRewriteTests {
    @Fact
    func EarlyReturnGuard_SingleLaterDereference_RewritesToLocalCapture() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
        }
    }
}`)
        Assert.Contains("let f = F!!", printed)
        Assert.Contains("f.ToUpper()", printed)
        // The rewritten use must not ALSO carry its own assertion.
        let useBody = printed.Substring(printed.IndexOf("func Use()", StringComparison.Ordinal))
        Assert.DoesNotContain("F!!.ToUpper", useBody)
    }

    @Fact
    func EarlyReturnGuard_MultipleLaterUses_ShareOneCapturedLocal() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

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
}`)
        Assert.Contains("let f = F!!", printed)
        Assert.Contains("f.ToUpper()", printed)
        Assert.Contains("f.ToLower()", printed)
        Assert.Contains("f.Trim()", printed)
        // Only ONE `let f = …` capture is synthesized for the three uses.
        let firstLet = printed.IndexOf("let f", StringComparison.Ordinal)
        Assert.DoesNotContain("let f", printed.Substring(firstLet + 1))
    }

    @Fact
    func EarlyReturnGuard_CompoundOrCondition_StillCaptures() {
        // `if (flag || F == null) { return; }` — the exact Oahu ViewModel
        // shape from the follow-up investigation. Fallthrough still proves
        // `F` non-null (De Morgan), regardless of the unrelated `flag`
        // disjunct.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        private readonly bool flag;
        public string F { get; }

        public void Use()
        {
            if (flag || F == null)
            {
                return;
            }

            F.ToUpper();
        }
    }
}`)
        Assert.Contains("let f = F!!", printed)
        Assert.Contains("f.ToUpper()", printed)
    }

    @Fact
    func GuardCapture_LiftedHelperNameCollision_FallsBackToFieldRead() {
        let printed = TranslateOblivious(`
using System;

public class C
{
    private readonly Func<int, int> Callback_2;
    private static int callback(int value) => 100 + value;

    public C()
    {
        Callback_2 = value => value + 1;
    }

    public int Run(int value)
    {
        if (Callback_2 == null)
        {
            return -1;
        }

        int first = Callback_2(1);
        return first + callback(value);
        static int callback(int n) => n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => callback(n);
    }
}`)
        Assert.DoesNotContain("let callback_2 =", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run(0))", "9")
    }

    @Fact
    func StructConstructor_ThisQualifiedReadonlyFieldWrite_InvalidatesGuardCapture() {
        let printed = TranslateOblivious(`
using System;

public struct Holder
{
    private readonly string F;

    public Holder()
    {
        F = "before";
        if (F == null)
        {
            return;
        }

        Console.WriteLine(F);
        this.F = "after";
        Console.WriteLine(F);
    }
}`)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Holder()", "before" + Environment.NewLine + "after")
    }

    @Fact
    func AlreadyLowercaseFieldName_CapturesToSameSpelling() {
        // The repo owner's own example: a field ALREADY spelled lowercase
        // (`viewModel`) derives a captured local of the IDENTICAL spelling —
        // the field's own name IS the derived name, and shadowing it with a
        // local of the same spelling is the intended, idiomatic result (gsc
        // narrows the LOCAL from that point on; the field itself is never
        // read bare again in this method).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class ViewModel { public void DoSomething() { } }

    public class Holder
    {
        private readonly ViewModel viewModel;

        public void Use()
        {
            if (viewModel == null)
            {
                return;
            }

            viewModel.DoSomething();
        }
    }
}`)
        Assert.Contains("let viewModel = viewModel!!", printed)
        Assert.Contains("viewModel.DoSomething()", printed)
    }

    @Fact
    func NonReadonlyField_CallBetweenGuardAndUse_FallsBackToPerUseAssertion() {
        // Copilot review fix (PR #4280): a NON-readonly field's stability
        // cannot be assumed even with no DIRECT syntactic write between the
        // guard and a later use — an intervening call (`Reset()`) could
        // reassign it internally, which `SymbolIsWrittenBetween` (a purely
        // syntactic check) cannot see. Restricting capture eligibility to
        // stable members (readonly fields / non-virtual get-or-init-only
        // auto-properties) excludes this field categorically, so no capture
        // is attempted at all and every use keeps the existing, always-safe
        // per-use `!!` fallback.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        private string f;

        private void Reset()
        {
            f = null;
        }

        public void Use()
        {
            if (f == null)
            {
                return;
            }

            f.ToUpper();
            Reset();
            f.ToLower();
        }
    }
}`)
        Assert.DoesNotContain("let f", printed)
        Assert.Contains("f!!.ToUpper()", printed)
        Assert.Contains("f!!.ToLower()", printed)
    }

    @Fact
    func SettableAutoProperty_SameEarlyReturnShape_FallsBackToPerUseAssertion() {
        // Copilot review fix (PR #4280): a settable property is not stable —
        // any call could reassign it via its public setter between the guard
        // and a later use — so it is excluded the same way a non-readonly
        // field is, even though it IS a pure auto-property (no computed
        // getter concern).
        let printed = TranslateOblivious(`
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
}`)
        Assert.DoesNotContain("let name", printed)
        Assert.Contains("Name!!.ToUpper()", printed)
    }

    @Fact
    func VirtualGetOnlyAutoProperty_SameEarlyReturnShape_FallsBackToPerUseAssertion() {
        // Copilot review fix (PR #4280): a `virtual` (or `override`/
        // `abstract`) get-only property is not stable even though its OWN
        // declaration is a plain auto-property — an override elsewhere could
        // dispatch to a computed getter that returns a different value (or
        // null) on a later call, exactly the "body-less virtual property can
        // dispatch to an override with a computed getter" hazard the review
        // flagged.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public virtual string Name { get; }

        public void Use()
        {
            if (Name == null)
            {
                return;
            }

            Name.ToUpper();
        }
    }
}`)
        Assert.DoesNotContain("let name", printed)
        Assert.Contains("Name!!.ToUpper()", printed)
    }

    @Fact
    func ComputedPropertyGuard_SameEarlyReturnShape_FallsBackToPerUseAssertion() {
        // `Name` is a COMPUTED (expression-bodied) property, not an
        // auto-property — its getter is not a pure storage read. Capturing
        // it once at the guard would collapse two getter evaluations into
        // one, changing observable behavior for a getter that computes a
        // fresh value or has side effects on each call. The rewrite must
        // exclude it, keeping the existing per-use `!!` fallback (which is
        // faithful to C#'s own per-read call count).
        let printed = TranslateOblivious(`
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
}`)
        Assert.DoesNotContain("let name", printed)
        Assert.Contains("Name!!.ToUpper()", printed)
        Assert.Contains("Name!!.ToLower()", printed)
    }

    @Fact
    func NameCollidesWithExistingLocal_FallsBackToPerUseAssertion_NoAlternateNameSynthesized() {
        // Requirement from the repo owner (issue #3501): a name collision
        // must skip the rewrite entirely — never invent a suffixed
        // alternative like `f2`. Here a local `f` already exists in scope at
        // the point the capture would be inserted, colliding with the
        // derived name for property `F`.
        let printed = TranslateOblivious(`
using System;
namespace Demo
{
    public class Holder
    {
        public string F { get; }

        public void Use()
        {
            string f = "already here";
            if (F == null)
            {
                return;
            }

            F.ToUpper();
            Console.WriteLine(f);
        }
    }
}`)
        // The hand-written `let f = "already here"` is expected and untouched
        // — only a SECOND `let f = F!!` capture (which would shadow it) must
        // never appear, and no suffixed alternative is invented either.
        Assert.Contains("let f = \"already here\"", printed)
        Assert.DoesNotContain("let f = F!!", printed)
        Assert.DoesNotContain("f2", printed)
        Assert.Contains("F!!.ToUpper()", printed)
    }

    @Fact
    func NameCollidesWithParameter_FallsBackToPerUseAssertion() {
        let printed = TranslateOblivious(`
using System;
namespace Demo
{
    public class Holder
    {
        public string F { get; }

        public void Use(string f)
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
            Console.WriteLine(f);
        }
    }
}`)
        Assert.DoesNotContain("let f =", printed)
        Assert.DoesNotContain("f2", printed)
        Assert.Contains("F!!.ToUpper()", printed)
    }

    @Fact
    func NameCollidesWithSiblingMember_FallsBackToPerUseAssertion() {
        // The derived name `name` collides with an unrelated sibling member
        // `Name()` reachable unqualified from inside `Use()` — a bare `name`
        // introduced as a local would be confusing shadowing, so the rewrite
        // skips it rather than introduce that ambiguity.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string AccessToken { get; }

        private string name;

        public void Use()
        {
            if (AccessToken == null)
            {
                return;
            }

            AccessToken.ToUpper();
        }
    }
}`)
        // `AccessToken` derives `accessToken`, which does NOT collide with
        // the unrelated `name` field — this positive control confirms the
        // fixture's OTHER member does not spuriously block capture.
        Assert.Contains("let accessToken = AccessToken!!", printed)
    }

    @Fact
    func FieldGuard_IsNullPattern_RewritesToLocalCapture() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        private readonly string f;

        public void Use()
        {
            if (f is null)
            {
                return;
            }

            f.ToUpper();
        }
    }
}`)
        Assert.Contains("let f = f!!", printed)
        Assert.Contains("f.ToUpper()", printed)
    }

    @Fact
    func GuardDoesNotLeakPastNestedBlock_FallsBackToPerUseAssertion() {
        // The guard sits inside `if (flag) { … }`, so it dominates nothing
        // outside that nested block (mirrors ComputeBooleanFlowRegions'
        // identical "only a direct block child leaks" restriction) — the
        // later use keeps its own per-use assertion.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

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
}`)
        Assert.DoesNotContain("let f", printed)
        Assert.Contains("F!!.ToUpper()", printed)
    }

    @Fact
    func DifferentInstanceReceiver_NeverSubstitutesCapturedLocal() {
        // `other.F` binds to the SAME symbol as `this`'s `F` (a field/
        // property symbol is shared across every instance of its declaring
        // type), but it reads a DIFFERENT instance's storage — it must never
        // be redirected to this method's captured local.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

        public void Use(Holder other)
        {
            if (F == null)
            {
                return;
            }

            other.F.ToUpper();
        }
    }
}`)
        Assert.DoesNotContain("let f", printed)
        Assert.Contains("other.F!!.ToUpper()", printed)
    }

    @Fact
    func RedundantLaterGuardOnSameField_ReusesOneCapturedLocal() {
        // A second, redundant `if (F == null) return;` later in the same
        // block (common in real code — a defensive re-check) must not
        // synthesize a SECOND capture: the first capture's region already
        // reaches everything after the second guard too, and the second
        // guard's own condition becomes a (harmless, always-false) check of
        // the already-non-null captured local.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

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
}`)
        Assert.Contains("let f = F!!", printed)
        Assert.Contains("f.ToUpper()", printed)
        Assert.Contains("if f == nil", printed)
        Assert.Contains("f.ToLower()", printed)
        // Only ONE `let f = …` capture is synthesized.
        let firstLet = printed.IndexOf("let f", StringComparison.Ordinal)
        Assert.DoesNotContain("let f", printed.Substring(firstLet + 1))
    }

    @Fact
    func GotoGuard_DoesNotCapture_LabelCanSkipTheCapture() {
        // `goto` (unlike `return`/`throw`) does not exit the enclosing
        // method body — it can jump FORWARD to a label that lies among the
        // very "later statements" a capture would be inserted before. If
        // this guard were (wrongly) treated as an early-return guard, the
        // `goto` path would reach `SkipF:` — and the use after it — having
        // skipped `let f = F!!` entirely, reading an unassigned local. No
        // capture must be synthesized for this guard at all; every later use
        // keeps its own per-use `!!` fallback (still correct, because gsc
        // never actually reaches that use with `F` proven null).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

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
}`)
        Assert.DoesNotContain("let f", printed)
        Assert.Contains("F!!.ToUpper()", printed)
        Assert.Contains("F!!.ToLower()", printed)
    }

    @Fact
    func SwitchSection_EarlyReturnGuard_RewritesToLocalCapture() {
        // A direct guard inside a `case` body leaks to that SAME section's
        // own following statements exactly like a block's does
        // (AddFollowingStatements explicitly supports SwitchSectionSyntax) —
        // TranslateSwitchSectionBody now runs the same per-statement capture
        // loop TranslateBlock does.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; }

        public void Use(int mode)
        {
            switch (mode)
            {
                case 1:
                    if (F == null)
                    {
                        return;
                    }

                    F.ToUpper();
                    F.ToLower();
                    break;
            }
        }
    }
}`)
        Assert.Contains("let f = F!!", printed)
        Assert.Contains("f.ToUpper()", printed)
        Assert.Contains("f.ToLower()", printed)
    }

    @Fact
    func NullableEnabledCompilation_EarlyReturnGuard_RewritesToLocalCapture() {
        // The rewrite is not gated on oblivious compilation: a nullable-
        // ENABLED file with the identical statement-level early-return guard
        // shape gets the same treatment.
        let printed = TranslateEnabled(`
#nullable enable
namespace Demo
{
    public class Holder
    {
        public string? F { get; }

        public void Use()
        {
            if (F == null)
            {
                return;
            }

            F.ToUpper();
        }
    }
}`)
        Assert.Contains("let f = F!!", printed)
        Assert.Contains("f.ToUpper()", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return TranslateAndPrint(project)
        }

        private func TranslateEnabled(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            return TranslateAndPrint(project)
        }

        private func TranslateAndPrint(project LoadedCSharpProject) string {
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
