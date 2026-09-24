// <copyright file="Adr0184CallerSideDefensiveCopyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0184 amendment (caller side). The definition-side half of ADR-0184 let a
/// struct member return a <c>ref</c> into its own instance state. The caller
/// side was then unsound: the emitter defensively COPIES a value-type receiver
/// into a function-local temp whenever the receiver is a READ-ONLY REFERENCE
/// (an <c>in</c> parameter, a <c>ref readonly</c> alias, a <c>ref readonly</c>
/// call/property result) and the called member is not itself a <c>readonly</c>
/// member — which, since G# has no <c>readonly func</c>, is every native G#
/// member. The binder's escape walk did not model that copy at all: it treated
/// such a receiver as caller-scoped and accepted the forward, so the returned
/// reference pointed into a temp that died at function exit.
/// <para>
/// Proven at run time before the fix: the minimal repro
/// (<see cref="InParameterReceiver_RefReturnThroughUnscopedRefMember_ReportsGS0591"/>'s
/// source, returned out to a caller that then made an intervening call)
/// compiled with ZERO diagnostics and read back three different garbage values
/// across two builds (-1048597222, -1083017767, -1040415262) where 7 was
/// stored — genuinely reused stack memory, not a stale-but-stable copy. Real
/// csc rejects the C# analogue with CS8156.
/// </para>
/// <para>
/// The fix is one shared predicate —
/// <c>RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy</c>, which the
/// three emitter defensive-copy sites and the binder's new
/// <c>IsDefensivelyCopiedReceiverForwarding</c> check now both consult — plus
/// two hooks in <c>StatementBinder.HasFunctionLocalRefScope</c> and the new
/// GS0591, which names the actual remedy ("use a <c>ref</c> parameter or alias")
/// rather than GS0254's misleading "function-local storage".
/// </para>
/// <para>
/// NOTE on why every GS0591 test below returns <c>ref readonly</c> rather than
/// <c>ref</c>: <c>BindReturnStatement</c>'s read-only-storage gate
/// (<c>function.ReturnRefKind == Ref &amp;&amp; IsReadOnlyStorage(expression)</c>)
/// runs BEFORE the escape-scope branch, and a <c>Ref</c>-returning member
/// invoked on a read-only value receiver already counts as read-only storage
/// (issue #4224). A plain <c>ref</c> return therefore stops at GS0253 and never
/// reaches the new branch at all — verified directly against gsc. Declaring the
/// enclosing function <c>ref readonly</c> isolates the scope question, exactly
/// as <c>Issue4265SpanByValueRefReturnTests</c> already does for the same
/// reason.
/// </para>
/// </summary>
public class Adr0184CallerSideDefensiveCopyTests
{
    /// <summary>
    /// The struct under test: a legal ADR-0184 <c>@UnscopedRef</c> member that
    /// returns a reference into its own instance state, plus the indexer
    /// spelling of the same thing.
    /// </summary>
    private const string AccDeclaration = """
        package P
        import System.Diagnostics.CodeAnalysis
        struct Acc {
            var Total int32

            @UnscopedRef
            func Slot() ref int32 { return ref this.Total }

            @UnscopedRef
            prop this[i int32] ref int32 {
                get { return ref this.Total }
            }
        }
        """;

    // ---------------------------------------------------------------------
    // (1)-(8) The new rejection: GS0591.
    // ---------------------------------------------------------------------

    /// <summary>
    /// (1) The minimal repro from the bug report — an <c>in</c> parameter
    /// receiver. This is the shape that was runtime-proven to dangle.
    /// </summary>
    [Fact]
    public void InParameterReceiver_RefReturnThroughUnscopedRefMember_ReportsGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            func fromIn(in a Acc) ref readonly int32 { return ref a.Slot() }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");

        // Not the generic escape diagnostic, and not the GS0589 "mark it
        // @UnscopedRef" advice — neither names the actual remedy here.
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0589");
    }

    /// <summary>
    /// (2) A <c>ref readonly</c>-returning CALL result used as the receiver.
    /// The emitter spills that rvalue into a temp (<c>NeedsRvalueReceiverSpill</c>),
    /// so the reference Slot() hands back points at the spill slot, not at the
    /// static field the call aliased.
    /// </summary>
    [Fact]
    public void RefReadOnlyReturningCallReceiver_ReportsGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            struct Holder {
                shared {
                    var Shared Acc = Acc{Total: 1}
                    func GetAcc() ref readonly Acc { return ref Holder.Shared }
                }
            }
            func fromCall() ref readonly int32 { return ref Holder.GetAcc().Slot() }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (3) A <c>ref readonly</c>-returning native PROPERTY used as the
    /// receiver. Distinct bound shape from (2) — <c>BoundPropertyAccessExpression</c>
    /// rather than a call — reaching the same <c>default:</c> arm, so it gets
    /// its own test rather than riding on (2)'s coverage.
    /// </summary>
    [Fact]
    public void RefReadOnlyReturningPropertyReceiver_ReportsGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            struct Holder {
                shared {
                    var Shared Acc = Acc{Total: 1}
                    prop Current ref readonly Acc { get { return ref Holder.Shared } }
                }
            }
            func fromProp() ref readonly int32 { return ref Holder.Current.Slot() }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (4) A <c>let ref readonly</c> LOCAL ALIAS as the receiver. The alias
    /// itself points at caller-lived storage (a static field), so the escape
    /// walk finds nothing wrong with it — the unsoundness is entirely in the
    /// copy the emitter inserts because the alias is read-only.
    /// </summary>
    [Fact]
    public void RefReadOnlyLocalAliasReceiver_ReportsGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            struct Holder {
                shared {
                    var Shared Acc = Acc{Total: 1}
                }
            }
            func fromLocalAlias() ref readonly int32 {
                let ref readonly v = Holder.Shared
                return ref v.Slot()
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (5) A NESTED field receiver over an <c>in</c> parameter. Read-only-ness
    /// propagates down a value-type field chain
    /// (<c>RefCapabilities.IsReadOnlyReference</c>'s
    /// <c>BoundFieldAccessExpression</c> case), so <c>a.Inner</c> is a
    /// read-only reference too and gets copied just like <c>a</c> would.
    /// </summary>
    [Fact]
    public void NestedFieldReceiverOverInParameter_ReportsGS0591()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            struct Inner {
                var Total int32

                @UnscopedRef
                func Slot() ref int32 { return ref this.Total }
            }
            struct Outer {
                var Inner Inner
            }
            func fromNested(in a Outer) ref readonly int32 { return ref a.Inner.Slot() }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (6) The native INDEXER spelling (<c>prop this[...]</c>) of the same
    /// member, not just the <c>func</c> spelling.
    /// </summary>
    [Fact]
    public void NativeRefReturningIndexerOverInParameter_ReportsGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            func fromIndexer(in a Acc) ref readonly int32 { return ref a[0] }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (7) A CONSTRAINED TYPE-PARAMETER receiver. This pins the third emitter
    /// defensive-copy site, <c>MethodBodyEmitter.EmitConstrainedTypeParameterReceiver</c>,
    /// which no other test reaches: a <c>constrained.</c>-prefixed receiver is
    /// always addressed through a temp, so the copy happens there with no
    /// <c>isReadOnlyCall</c> opt-out at all.
    /// </summary>
    [Fact]
    public void ConstrainedTypeParameterReceiverOverInParameter_ReportsGS0591()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            interface IAcc {
                func Slot() ref int32;
            }
            struct Acc : IAcc {
                var Total int32

                @UnscopedRef
                func Slot() ref int32 { return ref this.Total }
            }
            func viaConstrained[T IAcc](in a T) ref readonly int32 { return ref a.Slot() }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (8) The CLR-indexer variant — an independently PRE-EXISTING hole (not
    /// part of the original ADR-0184 change) with the exact same root cause,
    /// closed by the exact same hook. Issue #4265 already rejected forwarding
    /// an externally-compiled <c>[UnscopedRef]</c> indexer through a BY-VALUE
    /// parameter; the <c>in</c>-parameter spelling of the same forward was
    /// still accepted, and dangles for the same reason. Both attribute
    /// placements C# allows (accessor row and property row) are covered,
    /// sibling to the by-value theory in
    /// <c>Issue4265SpanByValueRefReturnTests</c>.
    /// </summary>
    [Theory]
    [InlineData("UnscopedRefIndexerFixture")]
    [InlineData("UnscopedRefIndexerPropertyLevelFixture")]
    public void UnscopedRefClrIndexer_InParameter_RefReturn_ReportsGS0591(string typeName)
    {
        var diagnostics = BindWithFixtures($$"""
            package P
            import GSharp.Core.Tests.Fixtures

            func M(in buf {{typeName}}) ref readonly int32 {
                return ref buf[0]
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0591");
    }

    // ---------------------------------------------------------------------
    // (9) The ref-local-alias launder — closed by the EXISTING IsScoped path.
    // ---------------------------------------------------------------------

    /// <summary>
    /// (9) Without this test the fix would have a one-line bypass: bind the
    /// result to a <c>ref</c> local first, then return the local.
    /// <c>StatementBinder.Narrowing.cs</c> already seeds
    /// <c>localVar.IsScoped</c> from <c>HasFunctionLocalRefScope(initializer)</c>,
    /// so the new hooks close this automatically — via GS0254, not GS0591,
    /// because by the time the <c>return</c> is bound the operand is a plain
    /// scoped local and the direct-forwarding check no longer sees the call it
    /// came from. That is intentional: the rejection is what matters, and
    /// GS0254's "function-local storage" wording is literally accurate for a
    /// scoped local.
    /// </summary>
    [Fact]
    public void RefLocalAliasLaunderOverInParameter_StillRejected_WithGS0254()
    {
        var diagnostics = Bind(AccDeclaration + """

            func launder(in a Acc) ref readonly int32 {
                let ref readonly t = a.Slot()
                return ref t
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    // ---------------------------------------------------------------------
    // (10)-(15) Regression guards: these already worked and must keep working.
    // ---------------------------------------------------------------------

    /// <summary>
    /// (10) A genuine <c>ref</c> parameter receiver is NOT copied — the
    /// emitter passes its address straight through — so the forward is safe
    /// and must stay accepted. This is the over-rejection guard for the
    /// binder hook.
    /// </summary>
    [Fact]
    public void RefParameterReceiver_RefReturnThroughUnscopedRefMember_IsClean()
    {
        var diagnostics = Bind(AccDeclaration + """

            func fromRef(ref a Acc) ref int32 { return ref a.Slot() }
            """);
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// (11) A by-value LOCAL receiver is function-local storage for the
    /// ordinary, pre-existing reason — unchanged by this fix, and still
    /// GS0254 rather than the new GS0591.
    /// </summary>
    [Fact]
    public void LocalVariableReceiver_StillReportsGS0254_NotGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            func fromLocal() ref readonly int32 {
                var a = Acc{Total: 1}
                return ref a.Slot()
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (12) A BY-VALUE parameter receiver, likewise unchanged.
    /// <para>
    /// Discrepancy found implementing this (the design predicted GS0253): with
    /// the enclosing function declared <c>ref readonly</c> — which every test
    /// here must do, see the class remark — the read-only-storage gate does
    /// not fire and this lands on GS0254, exactly like the local-variable case
    /// above. GS0253 is what a plain <c>ref</c> return reports, for the
    /// unrelated read-only-storage reason. GS0254 is the correct expectation
    /// for this shape; what matters either way is that it is NOT GS0591, since
    /// the rejection here predates and is independent of the defensive copy.
    /// </para>
    /// </summary>
    [Fact]
    public void ByValueParameterReceiver_StillReportsGS0254_NotGS0591()
    {
        var diagnostics = Bind(AccDeclaration + """

            func fromByValue(a Acc) ref readonly int32 { return ref a.Slot() }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0591");
    }

    /// <summary>
    /// (13) A CLASS receiver is heap-backed; there is no defensive copy to
    /// make and nothing to reject. Both the shared predicate's callers and the
    /// new binder check keep their own value-type guard for exactly this.
    /// </summary>
    [Fact]
    public void ClassReceiver_IsClean()
    {
        var diagnostics = Bind("""
            package P
            class Box {
                var Total int32

                func Slot() ref int32 { return ref this.Total }
            }
            func fromClass(b Box) ref int32 { return ref b.Slot() }
            """);
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// (14) An ARRAY-ELEMENT receiver lives in the heap-allocated array, not
    /// in a read-only reference, so it is not copied and stays accepted.
    /// </summary>
    [Fact]
    public void ArrayElementReceiver_IsClean()
    {
        var diagnostics = Bind(AccDeclaration + """

            func fromArray(xs []Acc) ref int32 { return ref xs[0].Slot() }
            """);
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// (15) THE critical over-rejection guard. Issue #4265's shape:
    /// forwarding through a <c>Span[T]</c>/<c>ReadOnlySpan[T]</c> indexer must
    /// stay legal, including over an <c>in</c> parameter. The new check
    /// deliberately EXCLUDES the byref-like CLR-indexer branch (unless the
    /// indexer carries <c>[UnscopedRef]</c>, which is case (8)): such an
    /// indexer returns a reference into the ENCAPSULATED BUFFER the value
    /// merely wraps, not into the receiver's own storage, so a defensive copy
    /// of the receiver does not disturb the referent at all. Copying a
    /// <c>Span[T]</c> copies its pointer and length — the pointee is
    /// untouched. If this test ever starts failing, the exclusion has been
    /// "simplified away" and #4265 has regressed.
    /// </summary>
    [Theory]
    [InlineData("func first(s Span[int32]) ref int32 { return ref s[0] }")]
    [InlineData("func first(in s Span[int32]) ref readonly int32 { return ref s[0] }")]
    [InlineData("func first(s ReadOnlySpan[int32]) ref readonly int32 { return ref s[0] }")]
    [InlineData("func first(in s ReadOnlySpan[int32]) ref readonly int32 { return ref s[0] }")]
    public void SpanIndexerForwarding_StaysClean(string declaration)
    {
        var diagnostics = Bind("import System\n" + declaration);
        Assert.Empty(diagnostics);
    }

    // ---------------------------------------------------------------------
    // (16) A correct-but-non-obvious new rejection, documented on purpose.
    // ---------------------------------------------------------------------

    /// <summary>
    /// (16) The returned reference comes from <c>y</c>, a <c>ref</c> parameter
    /// — the CALLER's storage. Real csc ACCEPTS the C# analogue: a
    /// non-<c>[UnscopedRef]</c> struct method's <c>this</c> is
    /// <c>scoped ref</c>, so the receiver is excluded from the result's
    /// ref-safe-context and the result's scope is <c>ref y</c>'s alone.
    /// <para>
    /// G# used to reject it (GS0591) because its escape walk included a call's
    /// receiver unconditionally. ADR-0187 / issue #4350 adopted the C# rule
    /// (<c>RefCapabilities.ReceiverContributesRefScope</c>): the callee side is
    /// already enforced by GS0589, so a non-<c>@UnscopedRef</c> member can
    /// never return into its receiver, and the defensive copy of an
    /// <c>in</c> receiver cannot be the reference's source. Cases (1)-(12)
    /// keep their diagnostics because their member IS <c>@UnscopedRef</c>.
    /// </para>
    /// </summary>
    [Fact]
    public void RefArgumentForwardedThroughCopiedReceiver_IsClean_LikeCSharp()
    {
        var diagnostics = Bind("""
            package P
            struct Acc {
                func Pick(ref x int32) ref int32 { return ref x }
            }
            func k(in a Acc, ref y int32) ref readonly int32 { return ref a.Pick(ref y) }
            func v(a Acc, ref y int32) ref int32 { return ref a.Pick(ref y) }
            """);
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// (16b) Runtime proof for (16): the reference forwarded through a copied
    /// receiver still aliases the caller's own <c>y</c>.
    /// </summary>
    [Fact]
    public void RefArgumentForwardedThroughReceiver_AliasesCallerStorage_AtRuntime()
    {
        var result = EmittedOracle.Evaluate("""
            struct Acc {
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
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    // ---------------------------------------------------------------------
    // Runtime proof that the safe path still ALIASES rather than copies.
    // ---------------------------------------------------------------------

    /// <summary>
    /// The single strongest check that the binder hooks did not start treating
    /// the SAFE <c>ref</c>-parameter path as a copy too: mutate through the
    /// reference the member handed back and observe the change on the CALLER's
    /// own storage. A defensive copy anywhere in this chain would leave
    /// <c>answer</c> at 7.
    /// </summary>
    [Fact]
    public void RefParameterReceiver_RefResultStillAliasesCallerStorage_AtRuntime()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Diagnostics.CodeAnalysis

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
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    private static ImmutableArray<Diagnostic> BindWithFixtures(string source)
    {
        var fixturePath = typeof(GSharp.Core.Tests.Fixtures.UnscopedRefIndexerFixture).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { fixturePath });
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            resolver);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
