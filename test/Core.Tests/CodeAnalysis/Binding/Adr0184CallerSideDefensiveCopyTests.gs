// <copyright file="Adr0184CallerSideDefensiveCopyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.Tests

/// ADR-0184 amendment (caller side). The definition-side half of ADR-0184 let a
/// struct member return a `ref` into its own instance state. The caller
/// side was then unsound: the emitter defensively COPIES a value-type receiver
/// into a function-local temp whenever the receiver is a READ-ONLY REFERENCE
/// (an `in` parameter, a `ref readonly` alias, a `ref readonly`
/// call/property result) and the called member is not itself a `readonly`
/// member — which, since G# has no `readonly func`, is every native G#
/// member. The binder's escape walk did not model that copy at all: it treated
/// such a receiver as caller-scoped and accepted the forward, so the returned
/// reference pointed into a temp that died at function exit.
///
/// Proven at run time before the fix: the minimal repro
/// ((cref:InParameterReceiver_RefReturnThroughUnscopedRefMember_ReportsGS0591)'s
/// source, returned out to a caller that then made an intervening call)
/// compiled with ZERO diagnostics and read back three different garbage values
/// across two builds (-1048597222, -1083017767, -1040415262) where 7 was
/// stored — genuinely reused stack memory, not a stale-but-stable copy. Real
/// csc rejects the C# analogue with CS8156.
///
/// The fix is one shared predicate —
/// `RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy`, which the
/// three emitter defensive-copy sites and the binder's new
/// `IsDefensivelyCopiedReceiverForwarding` check now both consult — plus
/// two hooks in `StatementBinder.HasFunctionLocalRefScope` and the new
/// GS0591, which names the actual remedy ("use a `ref` parameter or alias")
/// rather than GS0254's misleading "function-local storage".
///
/// NOTE on why every GS0591 test below returns `ref readonly` rather than
/// `ref`: `BindReturnStatement`'s read-only-storage gate
/// (`function.ReturnRefKind == Ref && IsReadOnlyStorage(expression)`)
/// runs BEFORE the escape-scope branch, and a `Ref`-returning member
/// invoked on a read-only value receiver already counts as read-only storage
/// (issue #4224). A plain `ref` return therefore stops at GS0253 and never
/// reaches the new branch at all — verified directly against gsc. Declaring the
/// enclosing function `ref readonly` isolates the scope question, exactly
/// as `Issue4265SpanByValueRefReturnTests` already does for the same
/// reason.
open class Adr0184CallerSideDefensiveCopyTests {
    // ---------------------------------------------------------------------
    // (1)-(8) The new rejection: GS0591.
    // ---------------------------------------------------------------------
    /// (1) The minimal repro from the bug report — an `in` parameter
    /// receiver. This is the shape that was runtime-proven to dangle.
    @Fact
    func InParameterReceiver_RefReturnThroughUnscopedRefMember_ReportsGS0591() {
        let diagnostics = Bind(AccDeclaration + "\nfunc fromIn(in a Acc) ref readonly int32 { return ref a.Slot() }")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
        // Not the generic escape diagnostic, and not the GS0589 "mark it
        // @UnscopedRef" advice — neither names the actual remedy here.
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
    }

    /// (2) A `ref readonly`-returning CALL result used as the receiver.
    /// The emitter spills that rvalue into a temp (`NeedsRvalueReceiverSpill`),
    /// so the reference Slot() hands back points at the spill slot, not at the
    /// static field the call aliased.
    @Fact
    func RefReadOnlyReturningCallReceiver_ReportsGS0591() {
        let diagnostics = Bind(AccDeclaration + `
struct Holder {
    shared {
        var Shared Acc = Acc{Total: 1}
        func GetAcc() ref readonly Acc { return ref Holder.Shared }
    }
}
func fromCall() ref readonly int32 { return ref Holder.GetAcc().Slot() }`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (3) A `ref readonly`-returning native PROPERTY used as the
    /// receiver. Distinct bound shape from (2) — `BoundPropertyAccessExpression`
    /// rather than a call — reaching the same `default:` arm, so it gets
    /// its own test rather than riding on (2)'s coverage.
    @Fact
    func RefReadOnlyReturningPropertyReceiver_ReportsGS0591() {
        let diagnostics = Bind(AccDeclaration + `
struct Holder {
    shared {
        var Shared Acc = Acc{Total: 1}
        prop Current ref readonly Acc { get { return ref Holder.Shared } }
    }
}
func fromProp() ref readonly int32 { return ref Holder.Current.Slot() }`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (4) A `let ref readonly` LOCAL ALIAS as the receiver. The alias
    /// itself points at caller-lived storage (a static field), so the escape
    /// walk finds nothing wrong with it — the unsoundness is entirely in the
    /// copy the emitter inserts because the alias is read-only.
    @Fact
    func RefReadOnlyLocalAliasReceiver_ReportsGS0591() {
        let diagnostics = Bind(AccDeclaration + `
struct Holder {
    shared {
        var Shared Acc = Acc{Total: 1}
    }
}
func fromLocalAlias() ref readonly int32 {
    let ref readonly v = Holder.Shared
    return ref v.Slot()
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (5) A NESTED field receiver over an `in` parameter. Read-only-ness
    /// propagates down a value-type field chain
    /// (`RefCapabilities.IsReadOnlyReference`'s
    /// `BoundFieldAccessExpression` case), so `a.Inner` is a
    /// read-only reference too and gets copied just like `a` would.
    @Fact
    func NestedFieldReceiverOverInParameter_ReportsGS0591() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
struct Inner {
    var Total int32

    @UnscopedRef
    func Slot() ref int32 { return ref this.Total }
}
struct Outer {
    var Inner Inner
}
func fromNested(in a Outer) ref readonly int32 { return ref a.Inner.Slot() }`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (6) The native INDEXER spelling (`prop this[...]`) of the same
    /// member, not just the `func` spelling.
    @Fact
    func NativeRefReturningIndexerOverInParameter_ReportsGS0591() {
        let diagnostics = Bind(AccDeclaration + "\nfunc fromIndexer(in a Acc) ref readonly int32 { return ref a[0] }")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (7) A CONSTRAINED TYPE-PARAMETER receiver. This pins the third emitter
    /// defensive-copy site, `MethodBodyEmitter.EmitConstrainedTypeParameterReceiver`,
    /// which no other test reaches: a `constrained.`-prefixed receiver is
    /// always addressed through a temp, so the copy happens there with no
    /// `isReadOnlyCall` opt-out at all.
    @Fact
    func ConstrainedTypeParameterReceiverOverInParameter_ReportsGS0591() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
interface IAcc {
    func Slot() ref int32;
}
struct Acc : IAcc {
    var Total int32

    @UnscopedRef
    func Slot() ref int32 { return ref this.Total }
}
func viaConstrained[T IAcc](in a T) ref readonly int32 { return ref a.Slot() }`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (8) The CLR-indexer variant — an independently PRE-EXISTING hole (not
    /// part of the original ADR-0184 change) with the exact same root cause,
    /// closed by the exact same hook. Issue #4265 already rejected forwarding
    /// an externally-compiled `[UnscopedRef]` indexer through a BY-VALUE
    /// parameter; the `in`-parameter spelling of the same forward was
    /// still accepted, and dangles for the same reason. Both attribute
    /// placements C# allows (accessor row and property row) are covered,
    /// sibling to the by-value theory in
    /// `Issue4265SpanByValueRefReturnTests`.
    @Theory
    @InlineData("UnscopedRefIndexerFixture")
    @InlineData("UnscopedRefIndexerPropertyLevelFixture")
    func UnscopedRefClrIndexer_InParameter_RefReturn_ReportsGS0591(typeName string) {
        let diagnostics = BindWithFixtures((`package P
import GSharp.Core.Tests.Fixtures

func M(in buf ` + "$typeName" + `) ref readonly int32 {
    return ref buf[0]
}`))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    // ---------------------------------------------------------------------
    // (9) The ref-local-alias launder — closed by the EXISTING IsScoped path.
    // ---------------------------------------------------------------------
    /// (9) Without this test the fix would have a one-line bypass: bind the
    /// result to a `ref` local first, then return the local.
    /// `StatementBinder.Narrowing.cs` already seeds
    /// `localVar.IsScoped` from `HasFunctionLocalRefScope(initializer)`,
    /// so the new hooks close this automatically — via GS0254, not GS0591,
    /// because by the time the `return` is bound the operand is a plain
    /// scoped local and the direct-forwarding check no longer sees the call it
    /// came from. That is intentional: the rejection is what matters, and
    /// GS0254's "function-local storage" wording is literally accurate for a
    /// scoped local.
    @Fact
    func RefLocalAliasLaunderOverInParameter_StillRejected_WithGS0254() {
        let diagnostics = Bind(AccDeclaration + `
func launder(in a Acc) ref readonly int32 {
    let ref readonly t = a.Slot()
    return ref t
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    // ---------------------------------------------------------------------
    // (10)-(15) Regression guards: these already worked and must keep working.
    // ---------------------------------------------------------------------
    /// (10) A genuine `ref` parameter receiver is NOT copied — the
    /// emitter passes its address straight through — so the forward is safe
    /// and must stay accepted. This is the over-rejection guard for the
    /// binder hook.
    @Fact
    func RefParameterReceiver_RefReturnThroughUnscopedRefMember_IsClean() {
        let diagnostics = Bind(AccDeclaration + "\nfunc fromRef(ref a Acc) ref int32 { return ref a.Slot() }")
        Assert.Empty(diagnostics)
    }

    /// (11) A by-value LOCAL receiver is function-local storage for the
    /// ordinary, pre-existing reason — unchanged by this fix, and still
    /// GS0254 rather than the new GS0591.
    @Fact
    func LocalVariableReceiver_StillReportsGS0254_NotGS0591() {
        let diagnostics = Bind(AccDeclaration + `
func fromLocal() ref readonly int32 {
    var a = Acc{Total: 1}
    return ref a.Slot()
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (12) A BY-VALUE parameter receiver, likewise unchanged.
    ///
    /// Discrepancy found implementing this (the design predicted GS0253): with
    /// the enclosing function declared `ref readonly` — which every test
    /// here must do, see the class remark — the read-only-storage gate does
    /// not fire and this lands on GS0254, exactly like the local-variable case
    /// above. GS0253 is what a plain `ref` return reports, for the
    /// unrelated read-only-storage reason. GS0254 is the correct expectation
    /// for this shape; what matters either way is that it is NOT GS0591, since
    /// the rejection here predates and is independent of the defensive copy.
    @Fact
    func ByValueParameterReceiver_StillReportsGS0254_NotGS0591() {
        let diagnostics = Bind(AccDeclaration + "\nfunc fromByValue(a Acc) ref readonly int32 { return ref a.Slot() }")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0591")
    }

    /// (13) A CLASS receiver is heap-backed; there is no defensive copy to
    /// make and nothing to reject. Both the shared predicate's callers and the
    /// new binder check keep their own value-type guard for exactly this.
    @Fact
    func ClassReceiver_IsClean() {
        let diagnostics = Bind(`package P
class Box {
    var Total int32

    func Slot() ref int32 { return ref this.Total }
}
func fromClass(b Box) ref int32 { return ref b.Slot() }`)
        Assert.Empty(diagnostics)
    }

    /// (14) An ARRAY-ELEMENT receiver lives in the heap-allocated array, not
    /// in a read-only reference, so it is not copied and stays accepted.
    @Fact
    func ArrayElementReceiver_IsClean() {
        let diagnostics = Bind(AccDeclaration + "\nfunc fromArray(xs []Acc) ref int32 { return ref xs[0].Slot() }")
        Assert.Empty(diagnostics)
    }

    /// (15) THE critical over-rejection guard. Issue #4265's shape:
    /// forwarding through a `Span[T]`/`ReadOnlySpan[T]` indexer must
    /// stay legal, including over an `in` parameter. The new check
    /// deliberately EXCLUDES the byref-like CLR-indexer branch (unless the
    /// indexer carries `[UnscopedRef]`, which is case (8)): such an
    /// indexer returns a reference into the ENCAPSULATED BUFFER the value
    /// merely wraps, not into the receiver's own storage, so a defensive copy
    /// of the receiver does not disturb the referent at all. Copying a
    /// `Span[T]` copies its pointer and length — the pointee is
    /// untouched. If this test ever starts failing, the exclusion has been
    /// "simplified away" and #4265 has regressed.
    @Theory
    @InlineData("func first(s Span[int32]) ref int32 { return ref s[0] }")
    @InlineData("func first(in s Span[int32]) ref readonly int32 { return ref s[0] }")
    @InlineData("func first(s ReadOnlySpan[int32]) ref readonly int32 { return ref s[0] }")
    @InlineData("func first(in s ReadOnlySpan[int32]) ref readonly int32 { return ref s[0] }")
    func SpanIndexerForwarding_StaysClean(declaration string) {
        let diagnostics = Bind("import System\n" + declaration)
        Assert.Empty(diagnostics)
    }

    // ---------------------------------------------------------------------
    // (16) A correct-but-non-obvious new rejection, documented on purpose.
    // ---------------------------------------------------------------------
    /// (16) The returned reference comes from `y`, a `ref` parameter
    /// — the CALLER's storage. Real csc ACCEPTS the C# analogue: a
    /// non-`[UnscopedRef]` struct method's `this` is
    /// `scoped ref`, so the receiver is excluded from the result's
    /// ref-safe-context and the result's scope is `ref y`'s alone.
    ///
    /// G# used to reject it (GS0591) because its escape walk included a call's
    /// receiver unconditionally. ADR-0187 / issue #4350 adopted the C# rule
    /// (`RefCapabilities.ReceiverContributesRefScope`): the callee side is
    /// already enforced by GS0589, so a non-`@UnscopedRef` member can
    /// never return into its receiver, and the defensive copy of an
    /// `in` receiver cannot be the reference's source. Cases (1)-(12)
    /// keep their diagnostics because their member IS `@UnscopedRef`.
    @Fact
    func RefArgumentForwardedThroughCopiedReceiver_IsClean_LikeCSharp() {
        let diagnostics = Bind(`package P
struct Acc {
    func Pick(ref x int32) ref int32 { return ref x }
}
func k(in a Acc, ref y int32) ref readonly int32 { return ref a.Pick(ref y) }
func v(a Acc, ref y int32) ref int32 { return ref a.Pick(ref y) }`)
        Assert.Empty(diagnostics)
    }

    /// (16b) Runtime proof for (16): the reference forwarded through a copied
    /// receiver still aliases the caller's own `y`.
    @Fact
    func RefArgumentForwardedThroughReceiver_AliasesCallerStorage_AtRuntime() {
        let result = EmittedOracle.Evaluate(`struct Acc {
    var Total int32
    func Pick(ref x int32) ref int32 { return ref x }
}
func k(in a Acc, ref y int32) ref int32 { return ref a.Pick(ref y) }
func Run() int32 {
    var y = 7
    let acc = Acc{Total: 1}
    var ref slot = k(in acc, ref y)
    slot = 42
    return y
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.ReadGlobals()["answer"])
    }

    // ---------------------------------------------------------------------
    // Runtime proof that the safe path still ALIASES rather than copies.
    // ---------------------------------------------------------------------
    /// The single strongest check that the binder hooks did not start treating
    /// the SAFE `ref`-parameter path as a copy too: mutate through the
    /// reference the member handed back and observe the change on the CALLER's
    /// own storage. A defensive copy anywhere in this chain would leave
    /// `answer` at 7.
    @Fact
    func RefParameterReceiver_RefResultStillAliasesCallerStorage_AtRuntime() {
        let result = EmittedOracle.Evaluate(`import System.Diagnostics.CodeAnalysis

struct Acc {
    var Total int32

    @UnscopedRef
    func Slot() ref int32 { return ref this.Total }
}
func Mutate(ref a Acc) {
    var ref slot = a.Slot()
    slot = 42
}
func Run() int32 {
    var acc = Acc{Total: 7}
    Mutate(ref acc)
    return acc.Total
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.ReadGlobals()["answer"])
    }

    shared {
        /// The struct under test: a legal ADR-0184 `@UnscopedRef` member that
        /// returns a reference into its own instance state, plus the indexer
        /// spelling of the same thing.
        private const AccDeclaration string = `package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func Slot() ref int32 { return ref this.Total }

    @UnscopedRef
    prop this[i int32] ref int32 {
        get { return ref this.Total }
    }
}`

        private func BindWithFixtures(source string) ImmutableArray[Diagnostic] {
            using let fixture = NativeMetadataFixtures.Compile()
            using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .ToImmutableArray()
        }
    }
}
