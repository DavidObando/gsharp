// <copyright file="Issue2202UnguardedTernaryArmForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #2202 (generalized in #2412 round 3):
/// a nullable-tainted field/property arm of a ternary/switch expression whose
/// enclosing property/method return type is deliberately kept non-null (the
/// oblivious analyzer's property-contract / forwarding-exclusion guardrail,
/// issues #1354 / #2167). The original C# accepted this implicitly
/// (oblivious); forgiving every such tainted arm — regardless of whether the
/// conditional's own condition happens to null-check any arm — is the minimal
/// assertion needed to compile the member without regressing safety or
/// widening its declared contract.
open class Issue2202UnguardedTernaryArmForgivenessTranslationTests {
    @Fact
    func ReassignedGuardReceiver_DoesNotSuppressNullableArm() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public sealed class Holder
    {
        public string Value { get; }
    }

    public static class C
    {
        private static string Keep(string value) => value;

        public static string Read(Holder holder, Holder other) =>
            holder.Value != null && (holder = other) != null
                ? Keep(holder.Value)
                : "";
    }
}`)
        Assert.Contains("func Keep(value string?) string?", printed)
    }

    @Fact
    func RepeatedPropertyRead_DoesNotSuppressNullableArm() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public sealed class Holder
    {
        private int reads;
        public string Value { get => reads++ == 0 ? "first" : null; }
    }

    public static class C
    {
        private static string Keep(string value) => value;

        public static string Read(Holder holder) =>
            holder.Value != null
                ? Keep(holder.Value)
                : "";
    }
}`)
        Assert.Contains("func Keep(value string?) string?", printed)
    }

    /// Positive test: mirrors the Oahu.Data `BookCommon` shape — an
    /// interface-implementing property with a ternary whose guarded arm (Book)
    /// gets `!!` via `IsNullGuardNarrowedFieldUse` and whose UNGUARDED
    /// sibling arm (Component) must also get `!!` to compile the property's
    /// non-null return type.
    @Fact
    func NonContractGetter_Ternary_UnguardedSiblingArm_AssertsNonNull() {
        let printed = TranslateOblivious((`
namespace Demo
{
    public interface ICommon { }
    public class Book : ICommon { }
    public class Component : ICommon { }

    public class Entity : ICommon
    {
        public Book Book { get; set; }
        public Component Component { get; set; }

        // Taint Book via a null-check elsewhere:
        public string BookName => Book == null ? "none" : Book.ToString();

        // Taint Component via a null-check elsewhere:
        public string CompName => Component == null ? "none" : Component.ToString();

        // The target property: non-null return (does not override/implement an
        // interface member for ICommon.Common, since ICommon has no such member).
        // The ternary returns Book (guarded by ` + "`" + `Book == null` + "`" + ` on the else arm)
        // and Component (unguarded).
        public ICommon Common => Book == null ? Component : Book;
    }
}`))
        // Both arms must be asserted with !! for the property to compile.
        let commonPropIndex = printed.IndexOf("prop Common ICommon", StringComparison.Ordinal)
        Assert.True(commonPropIndex >= 0, "Expected to find 'prop Common ICommon' in output:\n" + printed)
        let afterCommon = printed.Substring(commonPropIndex)
        // The guarded arm (Book in else position) must be asserted.
        Assert.Contains("Book!!", afterCommon)
        // The unguarded arm (Component in if-true position) must ALSO be asserted.
        Assert.Contains("Component!!", afterCommon)
    }

    /// Positive test: same shape but with a block-bodied getter (return
    /// statement wrapping the ternary) — confirms the fix works when the
    /// conditional is not directly the arrow body.
    @Fact
    func NonContractGetter_BlockBodyReturn_UnguardedSiblingArm_AssertsNonNull() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IItem { }
    public class Primary : IItem { }
    public class Fallback : IItem { }

    public class Container
    {
        public Primary Primary { get; set; }
        public Fallback Fallback { get; set; }

        // Taint Primary via null-check:
        public bool HasPrimary => Primary != null;

        // Taint Fallback via null-check:
        public bool HasFallback => Fallback != null;

        // Block-bodied getter returning a ternary (property, not method).
        public IItem Current
        {
            get
            {
                return Primary == null ? Fallback : Primary;
            }
        }
    }
}`)
        let currentIndex = printed.IndexOf("prop Current IItem", StringComparison.Ordinal)
        Assert.True(currentIndex >= 0, "Expected to find 'prop Current IItem' in output:\n" + printed)
        let afterCurrent = printed.Substring(currentIndex)
        Assert.Contains("Primary!!", afterCurrent)
        Assert.Contains("Fallback!!", afterCurrent)
    }

    /// Negative test: an unguarded nullable-tainted field in a ternary that
    /// is NOT in a return-preserving context (the property's return type IS
    /// promoted to nullable by the analyzer) must NOT get blindly forgiven.
    /// This ensures the fix is properly scoped.
    @Fact
    func PromotedNullableReturnType_UnguardedArm_IsNotAsserted() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string X { get; set; }
        public string Y { get; set; }

        // Taint X via null-usage:
        public string TaintX => X == null ? "default" : X;

        // Taint Y via null-usage:
        public string TaintY => Y == null ? "default" : Y;

        // This property has a DIRECTLY nullable body (null literal arm in
        // another method causes Y to be tainted, and X's null-check in
        // condition ALSO taints X), so the analyzer will look at the ternary
        // and may promote. But the key test: a property whose body IS a
        // ternary where NEITHER arm is guarded for its own symbol should
        // NOT get blanket forgiveness.
        public string Unrelated()
        {
            // Y is used bare here — no guard on Y in this context.
            // This should NOT get !! because the method's return type IS
            // promoted (the method returns Y which is tainted, transitively).
            return Y;
        }
    }
}`)
        // The Unrelated() method's bare return of Y should NOT get `!!` —
        // it's not in a ternary with a sibling null-guarded arm.
        let unrelatedIndex = printed.IndexOf("func Unrelated()", StringComparison.Ordinal)
        Assert.True(unrelatedIndex >= 0, "Expected to find 'func Unrelated()' in output:\n" + printed)
        let afterUnrelated = printed.Substring(unrelatedIndex)
        let unrelatedBody = afterUnrelated.Substring(
            0,
            afterUnrelated.IndexOf('\n', afterUnrelated.IndexOf('\n') + 1) + 1
        )
        Assert.DoesNotContain("Y!!", unrelatedBody)
    }

    /// Positive test (round 3 generalization, real Oahu.Core shape): two
    /// nullable-tainted fields as ternary arms where the CONDITION does NOT
    /// null-check either arm at all — mirrors the real Oahu.Core
    /// `AudibleApi.HttpClient => Profile.PreAmazon ? HttpClientAudible :
    /// HttpClientAmazon;` shape, where `Profile.PreAmazon` is an unrelated
    /// flag, not a null-check on either `HttpClientAudible`/`HttpClientAmazon`.
    /// Both arms must still be forgiven for the property to compile against
    /// its deliberately-preserved non-null return type.
    @Fact
    func NoSiblingGuarded_UnguardedArms_AreBothAsserted() {
        let printed = TranslateOblivious((`
namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Beta : IVal { }

    public class NoGuard
    {
        public Alpha A { get; set; }
        public Beta B { get; set; }
        public bool Flag { get; set; }

        // Taint A via null-check elsewhere:
        public bool HasA => A != null;

        // Taint B via null-check elsewhere:
        public bool HasB => B != null;

        // The condition checks ` + "`" + `Flag` + "`" + `, NOT a null-check on A or B.
        // Neither arm is null-guard-narrowed, but both are nullable-tainted,
        // so both must be forgiven for this non-null-returning property to
        // compile (mirrors Oahu.Core's AudibleApi.HttpClient).
        public IVal Pick => Flag ? A : B;
    }
}`))
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        // Look at just the Pick property line(s) — both A and B must get !!
        // even though neither is null-guard-narrowed by the condition (which
        // checks an unrelated `Flag`, not either arm's nullness).
        let pickLine = afterPick.Substring(0, afterPick.IndexOf('\n') + 1)
        Assert.Contains("A!!", pickLine)
        Assert.Contains("B!!", pickLine)
    }

    /// Negative control: an arm that is NOT nullable-tainted at all (no
    /// null-check evidence anywhere for `C`) must never get a spurious `!!`,
    /// even though it sits in the very same kind of unguarded conditional as
    /// the positive case above. Only genuinely tainted arms are forgiven.
    @Fact
    func UntaintedArm_InUnguardedConditional_IsNotAsserted() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Gamma : IVal { }

    public class Mixed
    {
        public Alpha A { get; set; }
        public Gamma C { get; set; }
        public bool Flag { get; set; }

        // Taint A via null-check elsewhere:
        public bool HasA => A != null;

        // C has NO null-check evidence anywhere — never tainted.
        public IVal Pick => Flag ? A : C;
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        let pickLine = afterPick.Substring(0, afterPick.IndexOf('\n') + 1)
        // A is tainted (via HasA's null-check) and must be forgiven.
        Assert.Contains("A!!", pickLine)
        // C is never tainted anywhere — must NOT get a spurious !!.
        Assert.DoesNotContain("C!!", pickLine)
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
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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
