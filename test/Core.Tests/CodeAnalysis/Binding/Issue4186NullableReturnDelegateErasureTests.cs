// <copyright file="Issue4186NullableReturnDelegateErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4186 — the RETURN-side, reverse-direction sibling of issue #4184
/// (parameter-side <c>T? -&gt; T</c> / <c>T -&gt; T?</c>). A method group whose
/// own declared return type is a bare non-nullable value type <c>T</c>
/// satisfied a delegate's nullable <c>T?</c> return slot — a conversion
/// <c>csc</c> rejects with <c>CS0407</c>. This was reachable through TWO
/// independent code paths, both fixed here:
/// <list type="bullet">
/// <item><description><b>The repro's actual path:</b> <c>Conversion.Classify</c>'s
/// preferred symbolic route recovers a delegate's structural
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionTypeSymbol"/> shape (via
/// <c>MemberLookup.TryGetDelegateFunctionTypeFromSymbol</c>) and compares it
/// structurally through <c>IsFunctionShapeAssignable</c> /
/// <c>ReturnTypeWidens</c>. That method's issue #1356 rule ("a function
/// returning bare <c>T</c> widens to a function returning <c>T?</c>") was
/// written for an unconstrained type parameter or a reference-type return
/// (its own <c>Issue1356FuncReturnNullableWideningConversionTests</c> /
/// <c>Issue1356FuncReturnCovarianceEmitTests</c> pin only those two shapes) but
/// applied unconditionally, so it also silently widened a concrete VALUE
/// type's bare-<c>T</c> return — exactly this issue's gap. Now gated by
/// <c>NullableLifting.IsAnyValueTypeNullable</c> (which covers both a
/// CLR-backed value type AND a same-compilation user <c>struct</c>/<c>enum</c>
/// — a Copilot review finding on this PR caught that the narrower
/// <c>IsValueTypeNullable</c> alone missed the latter, since such a type has
/// no <c>ClrType</c> mid-binding), which is <see langword="false"/> for both
/// of that rule's own pinned shapes.</description></item>
/// <item><description><b>The reflective fallback:</b> <c>IsFunctionToDelegateConvertible</c>'s
/// own return-type identity check (reached when the symbolic route above
/// can't recover a shape — e.g. a nested function-typed parameter position,
/// resolved via this method's own recursive call with no
/// <c>delegateTypeSymbol</c>) relied on <c>Type.IsAssignableFrom</c>'s
/// CLR-level special case where <c>Nullable&lt;T&gt;.IsAssignableFrom(T)</c> is
/// <see langword="true"/> (measured directly:
/// <c>typeof(bool?).IsAssignableFrom(typeof(bool))</c>). Now guarded by
/// <c>IsClrNullableWideningMismatch</c>, the same narrow detector #4184 added
/// for the parameter-side sibling of this gap.</description></item>
/// </list>
/// <para>
/// This is a same-compilation-only probe (a bare <c>Func[int32, bool?]</c>
/// target needs no imported library), following the lightweight
/// <c>Issue4065MethodGroupValueDiagnosticTests</c> pattern rather than the
/// full compile-and-run harness used by <c>Issue4184NullableParameterDelegateMatrixTests</c>.
/// </para>
/// <para>
/// The critical non-regression case is any LITERAL function expression (an
/// arrow lambda, or a <c>func(...) { }</c> literal with an explicit
/// non-nullable return clause) target-typed against a nullable delegate
/// return: <c>csc</c> accepts the arrow-lambda shape directly (measured).
/// For the arrow-lambda case this is confirmed directly against
/// <c>LambdaBinder.BindLambdaExpression</c>/<c>InferLambdaReturnType</c> — its
/// own <c>FunctionTypeSymbol.ReturnType</c> is already the target's nullable
/// return before this conversion machinery runs, so identity (not the
/// widening rule this fix restricts) is what satisfies the target. For the
/// <c>func(...) { }</c> literal shape only the OUTCOME is confirmed here
/// (empirically: compiles clean) — <c>BindFunctionLiteralExpression</c> binds
/// an explicit return clause from its own syntax rather than a
/// <c>targetFunctionType</c>, so whatever lifts it (most likely an
/// assignment-site conversion applied to the whole literal, e.g. an
/// <c>ApplyInferredReturnTypeConversion</c>-style wrap) was not traced here.
/// </para>
/// <para>
/// By contrast, any NAMED, already-bound function value — a method group, OR
/// a plain identifier that already holds a function value of the bare-return
/// shape (see <see cref="StoredFunctionValue_NonNullableReturnToNullableNativeFunctionTypeReturn_IsNewlyRejected"/>)
/// — is rejected, because it is exactly the shape with a fixed signature that
/// cannot absorb an implicit return-type lift without a synthesized wrapper.
/// </para>
/// <para>
/// <b>Deliberate scope extension beyond the issue's own CLR-delegate repro:</b>
/// the <c>ReturnTypeWidens</c> guard above is reached from BOTH the
/// CLR-delegate route and a plain native-function-type-to-native-function-type
/// comparison (<c>Conversion.Classify</c>'s <c>from is FunctionTypeSymbol
/// &amp;&amp; to is FunctionTypeSymbol</c> branch — no CLR delegate involved at
/// all). Measured directly against a pre-fix build (reverting only
/// <c>Conversion.cs</c> to the commit immediately before this fix, from the
/// same worktree): a plain identifier already holding a
/// <c>(int32) -&gt; bool</c> value assigned to a <c>(int32) -&gt; bool?</c> slot
/// compiled CLEAN before this fix and is REJECTED after it — see
/// <see cref="StoredFunctionValue_NonNullableReturnToNullableNativeFunctionTypeReturn_IsNewlyRejected"/>.
/// This is the correct, consistent generalization of the same underlying gap
/// (a fixed-signature callable cannot silently gain a nullable-return lift),
/// but it is new behavior beyond the issue's literal CS0407/CLR-delegate
/// repro, called out explicitly here rather than left for a reviewer to find.
/// </para>
/// </summary>
public sealed class Issue4186NullableReturnDelegateErasureTests
{
    [Fact]
    public void MethodGroup_NonNullableReturnToNullableDelegateReturn_IsRejected()
    {
        // The issue's own repro: `RTN(x int32) bool` cannot satisfy
        // `Func[int32, bool?]` — csc measured: CS0407.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186Repro
            import System

            func RTN(x int32) bool -> x != 0

            func Main() {
                var f Func[int32, bool?] = RTN
                Console.WriteLine(f(5))
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_NonNullableReturnToNullableDelegateReturn_ArgumentPosition_IsRejected()
    {
        // Same shape at argument position rather than assignment, guarding
        // against the return-type check being reached differently during
        // overload resolution / output-type inference (see the #4165
        // regression note inline in Conversion.cs above the return check).
        var diagnostic = Assert.Single(Errors("""
            package Issue4186ReproArg
            import System

            func RTN(x int32) bool -> x != 0
            func Consume(f Func[int32, bool?]) {}

            func Main() {
                Consume(RTN)
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_NonNullableReturnToNullableDelegateReturn_NestedParameterPosition_IsRejected()
    {
        // Reaches the REFLECTIVE fallback guard specifically: a delegate
        // parameter that is itself a function type forces
        // `IsFunctionToDelegateConvertible`'s own recursive call (no
        // `delegateTypeSymbol`), bypassing `Conversion.Classify`'s symbolic
        // `ReturnTypeWidens` route entirely. `Handler`'s own parameter type
        // `(int32) -> bool` cannot satisfy `Action[Func[int32, bool?]]`'s
        // parameter `Func[int32, bool?]` for the same bare-return reason as
        // the top-level repro.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186ReproNested
            import System

            func Handler(callback (int32) -> bool) {}

            func Main() {
                var h Action[Func[int32, bool?]] = Handler
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_NullableReturnToNonNullableDelegateReturn_RemainsRejected()
    {
        // Regression guard for the OTHER direction (T? -> T), fixed earlier
        // for issue #4165 / covered by Issue1518NullableDelegateInferenceEmitTests
        // — must remain rejected after this fix.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186RegressionNT
            import System

            func NT(x int32) bool? -> x != 0

            func Main() {
                var f Func[int32, bool] = NT
                Console.WriteLine(f(5))
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_NonNullableReturnToNonNullableDelegateReturn_StillBinds()
    {
        // T -> T identity must keep working.
        Assert.Empty(Errors("""
            package Issue4186RegressionTT
            import System

            func TT(x int32) bool -> x != 0

            func Main() {
                var f Func[int32, bool] = TT
                Console.WriteLine(f(5))
            }
            """));
    }

    [Fact]
    public void MethodGroup_NullableReturnToNullableDelegateReturn_StillBinds()
    {
        // T? -> T? identity must keep working.
        Assert.Empty(Errors("""
            package Issue4186RegressionNN
            import System

            func NN(x int32) bool? -> x != 0

            func Main() {
                var f Func[int32, bool?] = NN
                Console.WriteLine(f(5))
            }
            """));
    }

    [Fact]
    public void Lambda_InferredNonNullableBodyTargetTypedAgainstNullableDelegateReturn_StillBinds()
    {
        // The critical non-regression case: csc accepts this (measured
        // directly). The lambda's own return type is target-typed to bool?
        // before this conversion check runs, so it must keep compiling clean.
        Assert.Empty(Errors("""
            package Issue4186LambdaAssignment
            import System

            func Main() {
                var f Func[int32, bool?] = (x int32) -> x != 0
                Console.WriteLine(f(5))
            }
            """));
    }

    [Fact]
    public void Lambda_InferredNonNullableBodyTargetTypedAgainstNullableDelegateReturn_ArgumentPosition_StillBinds()
    {
        Assert.Empty(Errors("""
            package Issue4186LambdaArg
            import System

            func Consume(f Func[int32, bool?]) {}

            func Main() {
                Consume((x int32) -> x != 0)
            }
            """));
    }

    [Fact]
    public void Lambda_InferredNonNullableBodyViaGenericOutputTypeInference_AgainstNullableDelegateReturn_StillBinds()
    {
        // The dangerous path named in the pre-existing #4165 comment inline in
        // Conversion.cs (above the return-type check this fix guards): during
        // generic OUTPUT-type inference `S` is fixed from `items` before the
        // trailing lambda argument is bound against `Func[S, bool?]`, which is
        // a different code path than a direct single-candidate assignment or
        // argument — must still accept the lambda's natural `bool` body.
        Assert.Empty(Errors("""
            package Issue4186LambdaGenericInference
            import System
            import System.Collections.Generic

            func Probe[S](items List[S], f Func[S, bool?]) {}

            func Main() {
                let items = List[int32]()
                items.Add(5)
                Probe(items, (x int32) -> x != 0)
            }
            """));
    }

    [Fact]
    public void FunctionLiteral_ExplicitNonNullableReturnTargetTypedAgainstNullableDelegateReturn_StillBinds()
    {
        // A `func(...) { }` literal with an EXPLICIT non-nullable return
        // clause, assigned directly to a nullable-return native function-type
        // slot, must keep compiling clean — same literal-expression
        // discriminator as the arrow-lambda case above, empirically confirmed
        // (unlike a STORED function value of the same declared shape, which
        // this fix correctly starts rejecting — see the class doc).
        Assert.Empty(Errors("""
            package Issue4186FuncLiteralAssignment
            import System

            func Main() {
                let g (int32) -> bool? = func(x int32) bool { return x != 0 }
                Console.WriteLine(g(5))
            }
            """));
    }

    [Fact]
    public void StoredFunctionValue_NonNullableReturnToNullableNativeFunctionTypeReturn_IsNewlyRejected()
    {
        // Deliberate scope extension (see the class doc): a plain identifier
        // already holding a bare-return `(int32) -> bool` function value —
        // NOT a method group, and NOT a literal target-typed at its binding
        // site — assigned to a `(int32) -> bool?` slot. This has no direct
        // CLR-delegate involvement at all (both sides are native G# function
        // types), so it is a pure `Conversion.Classify`
        // `FunctionTypeSymbol`-to-`FunctionTypeSymbol` comparison. Measured
        // directly against a pre-fix build (`Conversion.cs` reverted to the
        // commit immediately before this fix): this source not only compiled
        // clean before this fix, it EXECUTED and printed the wrong answer --
        // `Console.WriteLine(g(5))` printed `False` (the correct answer for
        // `5 != 0` is `True`) -- because invoking through a mismatched CLR
        // signature (`bool` vs. `Nullable<bool>` have different runtime
        // layouts) silently reads the wrong bytes. This was not merely an
        // overly permissive compile-time check; it was a genuine runtime
        // unsoundness, which is why this fix closes it at the native
        // function-type level too rather than restricting the guard to the
        // CLR-delegate path the issue's own repro used.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186StoredFunctionValue
            import System

            func TT(x int32) bool -> x != 0

            func Main() {
                let src (int32) -> bool = TT
                let g (int32) -> bool? = src
                Console.WriteLine(g(5))
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void StoredFunctionValue_StructConstrainedTypeParameterReturn_IsRejected()
    {
        // A struct-constrained `T` (unlike #1356's own UNCONSTRAINED `T` case
        // pinned in Issue1356FuncReturnNullableWideningConversionTests /
        // Issue1356FuncReturnCovarianceEmitTests) closes `T?` over
        // `Nullable<T>` at the IL level -- a distinct value type with its own
        // layout, exactly the same class of mismatch as `bool` -> `bool?`
        // above. `NullableLifting.IsValueTypeNullable` returns true for this
        // shape (it checks `TypeParameterSymbol.HasValueTypeConstraint`), so
        // this guard correctly extends to it too.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186StructConstrained

            class Box[T struct] {
                let f (T) -> T?
                init(g (T) -> T) {
                    this.f = g
                }
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_SameCompilationStructReturn_ToNullableNativeFunctionTypeReturn_IsRejected()
    {
        // Copilot review finding on this PR: a same-compilation user `struct`
        // has no `ClrType` mid-binding, so `NullableLifting.IsValueTypeNullable`
        // alone (which probes `UnderlyingType.ClrType.IsValueType`) misses it,
        // leaving this exact gap open for a concrete same-compilation value
        // type's bare return. Fixed by using
        // `NullableLifting.IsAnyValueTypeNullable`, which also covers
        // `StructSymbol { IsClass: false }` via `IsUserValueTypeNullable`.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186StructReturn
            import System

            struct Point {
                var X int32
                var Y int32

                init(x int32) {
                    this.X = x
                    this.Y = x
                }
            }

            func MakePoint(x int32) Point {
                return Point(x)
            }

            func Main() {
                var f (int32) -> Point? = MakePoint
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_SameCompilationEnumReturn_ToNullableNativeFunctionTypeReturn_IsRejected()
    {
        // Same shape as the struct case above, for the `EnumSymbol` half of
        // `NullableLifting.IsUserValueTypeNullable`.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186EnumReturn
            import System

            enum Color { Red, Green, Blue }

            func FirstColor(x int32) Color -> Color.Red

            func Main() {
                var f (int32) -> Color? = FirstColor
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    [Fact]
    public void MethodGroup_SameCompilationStructReturn_ToNullableClrDelegateReturn_IsRejected()
    {
        // Same shape as the struct case above, spelled with the imported CLR
        // `Func[...]` delegate instead of a native function type -- the shape
        // closest to the issue's own literal repro. Both spellings converge
        // on the same `IsFunctionShapeAssignable`/`ReturnTypeWidens` symbolic
        // route (`MemberLookup.TryGetDelegateFunctionTypeFromSymbol` recovers
        // a structural shape for `Func[...]` too), so this is a same-root
        // confirmation rather than an independent code path.
        var diagnostic = Assert.Single(Errors("""
            package Issue4186StructReturnClrDelegate
            import System

            struct Point {
                var X int32
                var Y int32

                init(x int32) {
                    this.X = x
                    this.Y = x
                }
            }

            func MakePoint(x int32) Point {
                return Point(x)
            }

            func Main() {
                var f Func[int32, Point?] = MakePoint
            }
            """));

        Assert.Equal("GS0155", diagnostic.Id);
    }

    private static Diagnostic[] Errors(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
    }
}
