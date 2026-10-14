// <copyright file="GenericRemapState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis

/// PR-E-16 (#1361): owns the generic type-parameter <em>remap</em> mutable
/// state that (cref:ReflectionMetadataEmitter) threads through
/// `EncodeTypeSymbol` so that references to enclosing type parameters
/// encode against the correct `ELEMENT_TYPE_VAR` / `ELEMENT_TYPE_MVAR`
/// slot while emitting the members of a reified generic type or a
/// generic-promoted lambda.
/// @remarks Three registration channels feed this state, all keyed by the class /
/// function whose members are about to be emitted:
///
/// - Issue #810 / #1465 / #1489 / #1467 / #1537 / #1477: the per-class outer-TP → own-class-TP remap
/// for a generic iterator/async state machine, a user type nested in a generic type, or a synthesized
/// closure / capture-box reified over its enclosing type parameters. Pushed via (cref:PushSmRemap)
/// around each such class's member-emit boundary and consulted through
/// (cref:ActiveIteratorStateMachineRemap).
/// - Issue #1537: (cref:TryGetNestedTypeEnclosingArity) — the number of ENCLOSING parameters `k` of a
/// nested type reified over the flattened enclosing+own list, so a use site can split its combined
/// type-argument vector into enclosing/own halves.
/// - Issue #2118: the per-lambda enclosing-TP → own-clone-ordinal remap for a generic-promoted
/// non-capturing lambda, pushed via (cref:PushLambdaMethodRemap) and consulted through
/// (cref:ActiveLambdaMethodTypeParamRemap).
///
/// This type owns only the remap dictionaries and their push/pop scope
/// discipline — the push/pop <em>semantics</em> are preserved verbatim from
/// the pre-E-16 (cref:ReflectionMetadataEmitter) band because they feed
/// generic/MVAR token encoding, where any ordering drift produces wrong IL.
/// The <em>registration</em> methods that build the remaps
/// (`RegisterStateMachineEnclosingGenerics`,
/// `RegisterNestedTypeEnclosingGenerics`,
/// `RegisterSynthesizedClosureReifiedGenerics`) stay on the root emitter:
/// they orchestrate over (cref:EmitContext).`Program` and the
/// closure collector, so they call into this state through
/// (cref:RegisterClassRemap) / (cref:SetNestedTypeEnclosingArity)
/// / (cref:RegisterLambdaMethodRemap) rather than owning it.
internal class GenericRemapState {
    // Issue #810: when emitting a member of a generic iterator state-machine
    // class (the SM's own field-defs, MoveNext body, get_Current signature,
    // interface impls, etc.), the body and signatures still reference the
    // OUTER method's `TypeParameterSymbol` instances (which carry
    // `IsMethodTypeParameter=true`). The state-machine class is itself
    // generic over class-level type parameters (Var(0..N-1)) that mirror the
    // outer method's TPs. EncodeTypeSymbol consults this remap to translate
    // each outer-method TP reference into a `Var(classOrdinal)` slot. The
    // remap is pushed by StateMachineEmitter around each SM-member emit
    // boundary (TypeDef, FieldDefs, interface impls, MethodDefs) and popped
    // afterward, so non-SM code paths see the normal Var/MVar discrimination.
    private var activeIteratorStateMachineRemap Dictionary[TypeParameterSymbol, int32]?

    // Issue #2118: a non-capturing lambda whose signature/body references an
    // enclosing method/type parameter (e.g. `func Build[T IComparable[T]]() ...
    // = (x T, y T) -> x.CompareTo(y)`) is hosted as a top-level `<Program>`
    // static method. To emit verifiable IL that method must be a genuine
    // GENERIC method declaring its OWN type parameters — cloned from the
    // referenced enclosing ones (carrying their constraints) — otherwise the
    // body's `!!0` references a method type parameter the method never declares
    // (ilverify DelegateCtor at the delegate site + StackUnexpected on any
    // `constrained.` call inside the body). While emitting such a lambda's
    // signature and body, this remap translates each referenced ENCLOSING type
    // parameter into the lambda method's own freshly-cloned method
    // type-parameter ordinal (MVar(idx)). Pushed around the lambda's
    // EmitFunction call; null everywhere else.
    private var activeLambdaMethodTypeParamRemap Dictionary[TypeParameterSymbol, int32]?

    // Issue #810: per-SM-class remap, populated when SynthesizeIteratorStateMachines
    // creates each generic state-machine. Used to auto-push the remap inside
    // GetUserStructFieldRef when the containing type is a generic SM class
    // (so its field-signature MemberRef matches the FieldDef blob exactly).
    private let iteratorStateMachineRemapsByClass Dictionary[
        StructSymbol,
        Dictionary[TypeParameterSymbol, int32]
    ] = Dictionary[StructSymbol, Dictionary[TypeParameterSymbol, int32]]()

    // Issue #1537: for each user-declared type nested inside a generic enclosing
    // type that the emitter reifies over the flattened enclosing+own parameter
    // list (RegisterNestedTypeEnclosingGenerics), the number of ENCLOSING
    // parameters `k` (the low ordinals `0..k-1` of the reified TypeDef, ECMA-335
    // §II.10.3.1). The nested type's own parameters occupy `k..k+m-1`.
    // ResolveUserStructTypeSpecArguments consults this to split a use-site's
    // combined type-argument vector into its enclosing and own halves. Keyed by
    // the nested type's DEFINITION.
    private let nestedTypeEnclosingArity Dictionary[StructSymbol, int32] = Dictionary[StructSymbol, int32](
        ReferenceEqualityComparer.Instance
    )

    // Issue #2118: per-lambda-function original-enclosing-TP -> own-clone-ordinal
    // remap, produced by ClosureEmitter.PromoteGenericLambda and consulted via
    // PushLambdaMethodRemap while the lambda's MethodDef signature and body are
    // emitted.
    private let lambdaMethodTypeParamRemapsByFunction Dictionary[
        FunctionSymbol,
        Dictionary[TypeParameterSymbol, int32]
    ] = Dictionary[FunctionSymbol, Dictionary[TypeParameterSymbol, int32]](ReferenceEqualityComparer.Instance)

    /// Gets the currently active iterator/state-machine/nested/closure class
    /// remap (outer-TP → own-class-`VAR(idx)`), or `null`
    /// when none is pushed. Read by `EncodeTypeSymbol` for the
    /// null-check-plus-`TryGetValue` translation, and used as a component
    /// of the user-struct TypeSpec / field-ref / method-ref cache keys (its
    /// object identity distinguishes the same symbol encoded under different
    /// active remaps).
    internal prop ActiveIteratorStateMachineRemap Dictionary[
        TypeParameterSymbol,
        int32
    ]? -> this.activeIteratorStateMachineRemap

    /// Gets the currently active generic-promoted-lambda remap
    /// (enclosing-TP → own-method-`MVar(idx)`), or `null`
    /// when none is pushed. Read by `EncodeTypeSymbol` and the deferred
    /// lambda constraint resolver.
    internal prop ActiveLambdaMethodTypeParamRemap Dictionary[
        TypeParameterSymbol,
        int32
    ]? -> this.activeLambdaMethodTypeParamRemap

    /// Gets the current generic-remap scope identity (issue #3163): both
    /// active remap channels captured as a single equatable value for use in
    /// Emit-layer cache keys. Capture at the point of key construction —
    /// never across a push/pop boundary.
    internal prop CurrentScope RemapScope -> RemapScope(
        this.activeIteratorStateMachineRemap,
        this.activeLambdaMethodTypeParamRemap
    )

    /// Issue #810: push the SM remap for [`smClass`](paramref) so that
    /// every (cref:SignatureEncoder.EncodeTypeSymbol) call made
    /// before the returned disposable is disposed translates outer-method
    /// type-parameter references into the SM class's own type-parameter slots
    /// (Var(idx) instead of MVar(idx)). Calls are nestable; on dispose the
    /// previous remap (or `null`) is restored.
    /// @param smClass The reified generic class whose remap to activate.
    /// @returns A disposable scope that restores the previous remap.
    internal func PushSmRemap(smClass StructSymbol?) SmRemapScope {
        if smClass == nil || !this.iteratorStateMachineRemapsByClass.TryGetValue(smClass, out var remap) ||
            remap == nil {
            return SmRemapScope(this, nil, restore: false)
        }
        let prev = this.activeIteratorStateMachineRemap
        this.activeIteratorStateMachineRemap = remap
        return SmRemapScope(this, prev, restore: true)
    }

    /// Issue #2118: pushes the enclosing-TP -> own-clone-ordinal remap for a
    /// generic-promoted non-capturing lambda so that every
    /// (cref:SignatureEncoder.EncodeTypeSymbol) call made while
    /// its signature and body are emitted translates references to the
    /// enclosing type parameters into the lambda method's own `MVar(idx)`
    /// slots. Restores the previous remap on dispose.
    /// @param function The lambda function being emitted.
    /// @returns A disposable scope that restores the previous remap.
    internal func PushLambdaMethodRemap(function FunctionSymbol?) LambdaMethodRemapScope {
        if function == nil || !this.lambdaMethodTypeParamRemapsByFunction.TryGetValue(function, out var remap) ||
            remap == nil {
            return LambdaMethodRemapScope(this, nil, restore: false)
        }
        let prev = this.activeLambdaMethodTypeParamRemap
        this.activeLambdaMethodTypeParamRemap = remap
        return LambdaMethodRemapScope(this, prev, restore: true)
    }

    /// Registers (or replaces) the outer-TP → own-class-TP remap for
    /// [`reifiedClass`](paramref) on the shared state-machine remap
    /// channel. Called by the root emitter's registration methods
    /// (state-machine / nested-type / synthesized-closure) and the EmitCore
    /// iterator/async-iterator info loops.
    /// @param reifiedClass The reified generic class the remap is keyed by.
    /// @param remap The original-parameter → reified-slot remap.
    internal func RegisterClassRemap(reifiedClass StructSymbol, remap Dictionary[TypeParameterSymbol, int32]) {
        this.iteratorStateMachineRemapsByClass[reifiedClass] = remap
    }

    /// Records the enclosing arity `k` of a nested type reified over the
    /// flattened enclosing+own parameter list (issue #1537), keyed by the
    /// nested type's DEFINITION.
    /// @param nestedTypeDef The nested type's definition.
    /// @param enclosingArity The number of enclosing type parameters.
    internal func SetNestedTypeEnclosingArity(nestedTypeDef StructSymbol, enclosingArity int32) {
        this.nestedTypeEnclosingArity[nestedTypeDef] = enclosingArity
    }

    /// Issue #1537: attempts to read the enclosing arity `k` recorded for a
    /// nested type's DEFINITION so a use site can split its combined
    /// type-argument vector into enclosing/own halves.
    /// @param nestedTypeDef The nested type's definition.
    /// @param enclosingArity The recorded enclosing arity, when present.
    /// @returns `true` when an arity was recorded.
    internal func TryGetNestedTypeEnclosingArity(nestedTypeDef StructSymbol, out enclosingArity int32) bool -> this
        .nestedTypeEnclosingArity
        .TryGetValue(nestedTypeDef, out enclosingArity)

    /// Issue #2118: registers the enclosing-TP → own-clone-ordinal remap for a
    /// generic-promoted non-capturing lambda so a later
    /// (cref:PushLambdaMethodRemap) can activate it while the lambda's
    /// signature and body are emitted.
    /// @param function The promoted lambda function.
    /// @param remap The enclosing-TP → own-clone-ordinal remap.
    internal func RegisterLambdaMethodRemap(function FunctionSymbol, remap Dictionary[TypeParameterSymbol, int32]) {
        this.lambdaMethodTypeParamRemapsByFunction[function] = remap
    }

    internal func TryGetLambdaMethodRemap(
        function FunctionSymbol,
        @NotNullWhen(true) out remap Dictionary[TypeParameterSymbol, int32]?
    ) bool -> this
        .lambdaMethodTypeParamRemapsByFunction
        .TryGetValue(function, out remap)

    internal struct SmRemapScope : IDisposable {
        private let owner GenericRemapState
        private let previous Dictionary[TypeParameterSymbol, int32]?
        private let restore bool

        init(owner GenericRemapState, previous Dictionary[TypeParameterSymbol, int32]?, restore bool) {
            this.owner = owner
            this.previous = previous
            this.restore = restore
        }

        func Dispose() {
            if this.restore {
                this.owner.activeIteratorStateMachineRemap = this.previous
            }
        }
    }

    internal struct LambdaMethodRemapScope : IDisposable {
        private let owner GenericRemapState
        private let previous Dictionary[TypeParameterSymbol, int32]?
        private let restore bool

        init(owner GenericRemapState, previous Dictionary[TypeParameterSymbol, int32]?, restore bool) {
            this.owner = owner
            this.previous = previous
            this.restore = restore
        }

        func Dispose() {
            if this.restore {
                this.owner.activeLambdaMethodTypeParamRemap = this.previous
            }
        }
    }
}
