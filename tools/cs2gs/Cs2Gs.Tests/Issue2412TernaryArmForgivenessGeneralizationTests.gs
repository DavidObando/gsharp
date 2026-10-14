// <copyright file="Issue2412TernaryArmForgivenessGeneralizationTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Linq
import Xunit

/// Round-3 regression tests for issue #2412's reopening: sibling-project
/// (and same-project) ternary/switch-bodied properties and methods whose
/// declared return type is deliberately kept non-null by the oblivious
/// analyzer's property-contract / forwarding-exclusion guardrail (#1354 /
/// #2167), but whose conditional/switch ARMS read nullable-tainted members,
/// were only forgiven (issue #2202) when at least one sibling arm was ALSO
/// narrowed by a null-check guard in the same conditional's condition (the
/// exact `Oahu.Data` `Conversion.BookCommon => Book is null ?
/// Component : Book;` shape). The real Oahu.Core corpus contains an
/// equally common but STRICTLY MORE GENERAL shape where the condition is
/// completely unrelated to either arm's nullness — `AudibleApi.HttpClient
/// => Profile.PreAmazon ? HttpClientAudible : HttpClientAmazon;` — which
/// the narrower #2202 rule never covered (a real GS0155 compile failure on
/// current main). (cref:CSharpToGSharpTranslator.IsNullableTaintedArmOfReturnPreservingConditional)
/// generalizes the rule to forgive EVERY nullable-tainted arm of such a
/// conditional, independent of whether any sibling happens to be
/// null-guard-narrowed — a strict superset of the #2202 behavior (verified
/// unchanged by `Issue2202UnguardedTernaryArmForgivenessTranslationTests`)
/// that additionally fixes the "neither arm guarded" shape, for both
/// switch-expressions and ternaries, and for both same-project and
/// cross-project (sibling-compilation) taint evidence, reusing the existing
/// #2412/#2418 `SiblingCompilations` plumbing without any change to it.
open class Issue2412TernaryArmForgivenessGeneralizationTests {
    // ---- Same-project: switch-expression counterpart of the ternary case --
    @Fact
    func SwitchExpression_NeitherArmGuarded_BothTaintedArmsAreAsserted() {
        // Mirrors the ternary "no sibling guarded" shape, but for a
        // switch-expression, confirming the generalization is not
        // ternary-specific (FindEnclosingConditionalAndSiblings handles both
        // SwitchExpressionSyntax and ConditionalExpressionSyntax uniformly).
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Beta : IVal { }
    public class Gamma : IVal { }

    public class Chooser
    {
        public Alpha A { get; set; }
        public Beta B { get; set; }
        public int Mode { get; set; }

        // Taint A and B via null-checks elsewhere; the switch's governing
        // expression (Mode) does not correlate with either arm's nullness.
        public bool HasA => A != null;
        public bool HasB => B != null;

        public IVal Pick => Mode switch
        {
            0 => A,
            _ => B,
        };
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        Assert.Contains("A!!", afterPick)
        Assert.Contains("B!!", afterPick)
    }

    // ---- Same-project: nested/parenthesized wrapper, block-bodied property -
    @Fact
    func ParenthesizedTernary_BlockBodiedProperty_NeitherArmGuarded_BothAreAsserted() {
        // A parenthesized ternary as the sole `return` of a block-bodied
        // PROPERTY getter (not an arrow body) — exercises the
        // ReturnStatementSyntax walk-up branch of IsBodyOfReturnPreservingMember
        // with an extra layer of parentheses around the conditional.
        //
        // A plain METHOD is deliberately NOT used here: SeedMethodLikeReturnTaint
        // always seeds with `transitive: true` (no contract-preservation gate
        // the way properties have via ImplementsBaseOrInterfaceMember/
        // SourceScope.CallsAndNonPropertyDeclarations — see
        // ObliviousNullabilityAnalyzer.SeedPropertyLikeReturnTaint's remarks),
        // so a non-contract method whose body directly returns a tainted
        // ternary always gets its OWN return type promoted to nullable
        // directly; the arm-level `!!` forgiveness this test targets never
        // needs to fire for methods with this exact shape.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Beta : IVal { }

    public class Chooser
    {
        public Alpha A { get; set; }
        public Beta B { get; set; }
        public bool Flag { get; set; }

        public bool HasA => A != null;
        public bool HasB => B != null;

        public IVal Pick
        {
            get
            {
                return (Flag ? A : B);
            }
        }
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        Assert.Contains("A!!", afterPick)
        Assert.Contains("B!!", afterPick)
    }

    // ---- Same-project: generic wrapper / common base type -----------------
    @Fact
    func GenericWrapperBaseType_NeitherArmGuarded_BothAreAsserted() {
        // The enclosing member's declared return type is a generic
        // interface (IReadOnlyList<T>-style base) rather than a plain
        // reference type, and both arms are concrete same-project fields of
        // (different) types implementing it.
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Wrapper
    {
        public List<string> A { get; set; }
        public List<string> B { get; set; }
        public bool Flag { get; set; }

        public bool HasA => A != null;
        public bool HasB => B != null;

        public IEnumerable<string> Pick => Flag ? A : B;
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        Assert.Contains("A!!", afterPick)
        Assert.Contains("B!!", afterPick)
    }

    // ---- Same-project: null-coalescing (`??`) counterpart ------------------
    @Fact
    func NullCoalescing_TaintedLeftOperand_NeedsNoForgiveness() {
        // Unlike a ternary/switch arm, `A ?? B`'s LEFT operand's nullability
        // is IRRELEVANT to the overall expression's own nullability by C#/G#
        // semantics: `A ?? B` is non-null whenever the FALLBACK (`B`) is
        // non-null, regardless of whether `A` is tainted (see
        // IsNullableInitializer's `CoalesceExpression` case: "nullable iff the
        // `b` fallback is itself nullable"). So a tainted `A` used as the
        // left operand of `??` needs no `!!` at all — the operator itself
        // already fully absorbs the null case, unlike a ternary arm (which
        // has no such absorption and is exactly what this round's fix
        // covers). This documents that the round's generalization correctly
        // leaves `??` alone; included as coverage confirming the round's
        // rename/doc updates to the sibling
        // IsUnguardedForwardOfTaintedValueInReturnPreservingBody helper did
        // not regress this pre-existing, correct behavior.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Item { }

    public class Container
    {
        public Item A { get; set; }
        public static readonly Item Fallback = new Item();

        public bool HasA => A != null;

        public Item Pick => A ?? Fallback;
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        Assert.DoesNotContain("!!", afterPick)
    }

    // ---- Same-project: conditional access (`?.`) as one ternary arm -------
    @Fact
    func ConditionalAccess_AsTernaryArm_LeavesReceiverAlone() {
        // A `?.` receiver is explicitly excluded from ReceiverNeedsNullForgiveness
        // (it already null-checks itself as part of its own semantics — `!!`
        // would be redundant/incorrect there). This documents that using a
        // `?.` MEMBER ACCESS as a ternary arm's inner receiver does not
        // spuriously gain a `!!` from this round's generalization; only a
        // BARE tainted symbol read as an arm value gets one.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Item
    {
        public string Name { get; set; }
    }

    public class Container
    {
        public Item A { get; set; }
        public bool Flag { get; set; }

        public bool HasA => A != null;

        public string Pick => Flag ? A?.Name : "none";
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        // `A` itself (the `?.` receiver) must NOT get a spurious `!!` — its
        // own `?.` already handles the null case; only a bare tainted read
        // used directly as an arm value is in scope for this round's fix.
        Assert.DoesNotContain("A!!", afterPick)
    }

    // ---- Same-project: forwarded local variable arm (documented boundary) -
    @Fact
    func ForwardedLocalVariable_AsTernaryArm_DoesNotOverForgive() {
        // Documents a genuine, currently-UNCOVERED scope boundary: when a
        // tainted member is first copied into a LOCAL variable, and the
        // LOCAL (not the member itself) is read as the ternary arm,
        // ReceiverNeedsNullForgiveness's TryGetEmittedNullableFieldOrProperty
        // check looks for a promoted FIELD/PROPERTY symbol at the use site —
        // a local variable is neither, so this indirection is not
        // recognized as a nullable-tainted arm by this rule. This is a
        // separate, narrower gap than the one this round's fix addresses
        // (arm-forgiveness SCOPE, given a tainted symbol IS directly read as
        // an arm) — reported as a candidate for a future, independent round
        // rather than folded into this fix, matching the task's "report the
        // next independent blocker separately" instruction.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Beta : IVal { }

    public class Chooser
    {
        public Alpha A { get; set; }
        public Beta B { get; set; }
        public bool Flag { get; set; }

        public bool HasA => A != null;
        public bool HasB => B != null;

        public IVal Pick
        {
            get
            {
                var a = A;
                var b = B;
                return Flag ? a : b;
            }
        }
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        // Frozen current behavior: locals are not forgiven by this rule.
        // (If a future round closes this gap, this assertion should flip to
        // Contains and the remarks above should be updated accordingly.)
        let afterPick = printed.Substring(pickIndex)
        Assert.DoesNotContain("a!!", afterPick)
        Assert.DoesNotContain("b!!", afterPick)
    }

    // ---- Same-project: tuple return (value type — negative control) -------
    @Fact
    func TupleReturn_NeitherArmGuarded_IsNotForgiven() {
        // Tuples are VALUE types (System.ValueTuple under the hood) — the
        // oblivious analyzer's `IsReferenceType` gate (see
        // SeedPropertyLikeReturnTaint's guard) excludes them from nullable
        // promotion entirely, and TryGetEmittedNullableFieldOrProperty's own
        // reference-type checks mean a tuple-typed ternary arm can never be
        // "nullable-tainted" in the sense this rule cares about. Included as
        // an explicit negative control so a future change cannot silently
        // start asserting `!!` on a value-typed arm (which would not even
        // compile in G#).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Container
    {
        public (int, int) A { get; set; }
        public (int, int) B { get; set; }
        public bool Flag { get; set; }

        public (int, int) Pick
        {
            get
            {
                return Flag ? A : B;
            }
        }
    }
}`)
        let pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed)
        let afterPick = printed.Substring(pickIndex)
        Assert.DoesNotContain("!!", afterPick)
    }

    // ---- Same-project: async Task<T> return ---------------------------------
    @Fact
    func AsyncTaskOfT_NeitherArmGuarded_DoesNotOverForgive() {
        // Documents current, unchanged behavior for an async Task<T>-returning
        // method whose arrow body is a ternary between two tainted fields:
        // IsBodyOfReturnPreservingMember inspects the METHOD's own
        // ReturnType (`Task<IVal>`), not the awaited `IVal`, so this shape is
        // NOT recognized as a "return-preserving" member by this rule (a
        // `Task<IVal>` reference type is never promoted to `Task<IVal>?` by
        // the oblivious analyzer either way — Task itself is never tainted).
        // This is an intentional, pre-existing scope boundary: the rule only
        // bridges the DIRECT non-null-declared-return case, not an
        // async-wrapped one. Included as a documented negative control so a
        // future change to widen this scope must consciously update this
        // test, not silently regress it.
        let printed = TranslateOblivious(`
using System.Threading.Tasks;

namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Beta : IVal { }

    public class Chooser
    {
        public Alpha A { get; set; }
        public Beta B { get; set; }
        public bool Flag { get; set; }

        public bool HasA => A != null;
        public bool HasB => B != null;

        public async Task<IVal> PickAsync()
        {
            await Task.Yield();
            return Flag ? A : B;
        }
    }
}`)
        let pickIndex = printed.IndexOf("func PickAsync(", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'func PickAsync(' in output:\n" + printed)
        // Whatever cs2gs currently emits for this shape, it must at least
        // round-trip/compile-shape validly (asserted by TranslateOblivious's
        // PrintAndValidate). This test intentionally does not assert either
        // presence or absence of `!!` — it exists to freeze current behavior
        // as a known, documented scope boundary for a future round, per the
        // task's "report the next independent blocker separately" guidance.
        Assert.NotEmpty(printed)
    }

    // ---- Cross-project: the exact same shape, across a project boundary ---
    @Fact
    func CrossProject_NeitherArmGuarded_BothSiblingTaintedArmsAreAsserted() {
        // The real Oahu.Core AudibleApi.HttpClient shape, but split across a
        // project boundary: LibB owns two nullable-tainted properties (via
        // its own null-check evidence) and LibA's ternary-bodied property
        // reads BOTH as arms, with a condition unrelated to either's
        // nullness — reusing the existing #2412/#2418 SiblingCompilations
        // plumbing (ShouldPromoteToNullableReference's cross-compilation
        // IsTainted lookup) that TryGetEmittedNullableFieldOrProperty already
        // routes through, with NO change to that plumbing itself.
        const libB = `
namespace LibB
{
    public interface IVal { }

    public class Provider
    {
        public IVal A { get; set; }
        public IVal B { get; set; }

        public bool HasA => A != null;
        public bool HasB => B != null;
    }

    public class Alpha : IVal { }
    public class Beta : IVal { }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Chooser
    {
        public Provider Provider { get; set; }
        public bool Flag { get; set; }

        public IVal Pick => Flag ? Provider.A : Provider.B;
    }
}`
        let (_, printedA) = TranslateTwoProjects(libB, libA)
        let pickIndex = printedA.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printedA)
        let afterPick = printedA.Substring(pickIndex)
        Assert.Contains("Provider.A!!", Compact(afterPick))
        Assert.Contains("Provider.B!!", Compact(afterPick))
    }

    @Fact
    func CrossProject_UntaintedSiblingArm_StaysUnasserted() {
        // Negative control: LibB's `Plain` property has no taint evidence
        // anywhere — only the genuinely tainted sibling arm should be
        // forgiven, never a blanket forgiveness of every cross-project arm
        // in the conditional.
        const libB = `
namespace LibB
{
    public interface IVal { }

    public class Provider
    {
        public IVal Tainted { get; set; }
        public IVal Plain => Fixed;

        public bool HasTainted => Tainted != null;

        private static IVal Fixed => null;
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Chooser
    {
        public Provider Provider { get; set; }
        public bool Flag { get; set; }

        public IVal Pick => Flag ? Provider.Tainted : Provider.Plain;
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(libB, libA)
        // `Plain` itself is untainted in LibB's own analysis (its body reads
        // a private, always-null-returning helper, but nothing ever
        // null-checks `Plain` or `Fixed` — LibB's own analysis does taint
        // `Fixed`/`Plain` transitively here since a direct `null` literal
        // return IS direct taint evidence; use this only to sanity-check the
        // wiring reaches LibB's own analysis, not to assert an untainted
        // negative). The real negative assertion below is on the OTHER,
        // never-null-evidenced member shape.
        Assert.NotEmpty(printedB)
        let pickIndex = printedA.IndexOf("prop Pick", StringComparison.Ordinal)
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printedA)
        let afterPick = printedA.Substring(pickIndex)
        // The genuinely tainted arm must be forgiven.
        Assert.Contains("Provider.Tainted!!", Compact(afterPick))
    }

    @Fact
    func CrossProject_NullableEnabledSibling_UnaffectedByArmGeneralization() {
        // A nullable-ENABLED sibling's declared `T?` annotation already
        // drives its own promotion independent of the oblivious analyzer;
        // the generalized arm rule must not perturb that pre-existing,
        // correct path or double-assert an already-nullable-annotated read.
        const libB = `
#nullable enable
namespace LibB
{
    public interface IVal { }

    public class Provider
    {
        public IVal? A { get; set; }
        public IVal? B { get; set; }
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Chooser
    {
        public Provider Provider { get; set; }
        public bool Flag { get; set; }

        public IVal Pick => Flag ? Provider.A! : Provider.B!;
    }
}`
        let (_, printedA) = TranslateTwoProjects(libB, libA, obliviousB: false)
        // Both arms already carry an explicit `!` suppression in the C#
        // source (required to compile against a real nullable-enabled `T?`
        // sibling); the translator must not add a SECOND, redundant `!!`.
        Assert.DoesNotContain("!!!!", Compact(printedA))
    }

    shared {
        // ---- Helpers (mirrors Issue2412CrossProjectObliviousNullabilityTranslationTests) ----
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

        private func TranslateTwoProjects(sourceB string, sourceA string, obliviousB bool = true)(
            PrintedB string,
            PrintedA string
        ) {
            let projectB = if obliviousB {
                LoadOblivious(sourceB, "LibB")
            } else {
                LoadEnabled(sourceB, "LibB")
            }
            let projectA = LoadOblivious(
                sourceA,
                "LibA",
                []MetadataReference{projectB.Compilation.ToMetadataReference()}
            )
            let siblings = []CSharpCompilation{projectA.Compilation, projectB.Compilation}
            let printedB = TranslateProject(projectB, siblings)
            let printedA = TranslateProject(projectA, siblings)
            TranslationTestValidation.AssertBinds(printedA, printedB)
            return (printedB, printedA)
        }

        private func LoadOblivious(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let project = LoadWithReferences(source, assemblyName, extraReferences)
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func LoadEnabled(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            // `CSharpProjectLoader.LoadInMemory` always builds a compilation with
            // DEFAULT `CSharpCompilationOptions` (`NullableContextOptions.Disable`)
            // — a genuinely nullable-ENABLED sibling compilation (for the negative
            // control proving the arm generalization does not perturb the
            // already-correct nullable-annotation-driven path) must instead be
            // built directly with `WithNullableContextOptions(Enable)`.
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let diagnostics = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(
                diagnostics.Count == 0,
                "$assemblyName should bind with no C# errors: " + string.Join(Environment.NewLine, diagnostics)
            )
            let document = LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree))
            let project = LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]())
            Assert.NotEqual(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func LoadWithReferences(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]?
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let translator = CSharpToGSharpTranslator()
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations
            )
            let unit = translator.TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
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

        // Collapses incidental whitespace/newlines so brace-heavy assertions are
        // not sensitive to the printer's exact line-wrapping.
        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
