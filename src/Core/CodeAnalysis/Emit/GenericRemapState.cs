// <copyright file="GenericRemapState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1214 // readonly fields should appear before non-readonly fields — the two mutable `active*` remap pointers are grouped with the readonly registration maps they mirror, preserving the original ReflectionMetadataEmitter band's field order

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-16 (#1361): owns the generic type-parameter <em>remap</em> mutable
/// state that <see cref="ReflectionMetadataEmitter"/> threads through
/// <c>EncodeTypeSymbol</c> so that references to enclosing type parameters
/// encode against the correct <c>ELEMENT_TYPE_VAR</c> / <c>ELEMENT_TYPE_MVAR</c>
/// slot while emitting the members of a reified generic type or a
/// generic-promoted lambda.
/// </summary>
/// <remarks>
/// <para>
/// Three registration channels feed this state, all keyed by the class /
/// function whose members are about to be emitted:
/// </para>
/// <list type="bullet">
/// <item>
/// Issue #810 / #1465 / #1489 / #1467 / #1537 / #1477: the per-class
/// outer-TP → own-class-TP remap for a generic iterator/async state machine, a
/// user type nested in a generic type, or a synthesized closure / capture-box
/// reified over its enclosing type parameters. Pushed via
/// <see cref="PushSmRemap"/> around each such class's member-emit boundary and
/// consulted through <see cref="ActiveIteratorStateMachineRemap"/>.
/// </item>
/// <item>
/// Issue #1537: <see cref="TryGetNestedTypeEnclosingArity"/> — the number of
/// ENCLOSING parameters `k` of a nested type reified over the flattened
/// enclosing+own list, so a use site can split its combined type-argument
/// vector into enclosing/own halves.
/// </item>
/// <item>
/// Issue #2118: the per-lambda enclosing-TP → own-clone-ordinal remap for a
/// generic-promoted non-capturing lambda, pushed via
/// <see cref="PushLambdaMethodRemap"/> and consulted through
/// <see cref="ActiveLambdaMethodTypeParamRemap"/>.
/// </item>
/// </list>
/// <para>
/// This type owns only the remap dictionaries and their push/pop scope
/// discipline — the push/pop <em>semantics</em> are preserved verbatim from
/// the pre-E-16 <see cref="ReflectionMetadataEmitter"/> band because they feed
/// generic/MVAR token encoding, where any ordering drift produces wrong IL.
/// The <em>registration</em> methods that build the remaps
/// (<c>RegisterStateMachineEnclosingGenerics</c>,
/// <c>RegisterNestedTypeEnclosingGenerics</c>,
/// <c>RegisterSynthesizedClosureReifiedGenerics</c>) stay on the root emitter:
/// they orchestrate over <see cref="EmitContext"/>.<c>Program</c> and the
/// closure collector, so they call into this state through
/// <see cref="RegisterClassRemap"/> / <see cref="SetNestedTypeEnclosingArity"/>
/// / <see cref="RegisterLambdaMethodRemap"/> rather than owning it.
/// </para>
/// </remarks>
internal sealed class GenericRemapState
{
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
    private Dictionary<TypeParameterSymbol, int> activeIteratorStateMachineRemap;

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
    private Dictionary<TypeParameterSymbol, int> activeLambdaMethodTypeParamRemap;

    // Issue #810: per-SM-class remap, populated when SynthesizeIteratorStateMachines
    // creates each generic state-machine. Used to auto-push the remap inside
    // GetUserStructFieldRef when the containing type is a generic SM class
    // (so its field-signature MemberRef matches the FieldDef blob exactly).
    private readonly Dictionary<StructSymbol, Dictionary<TypeParameterSymbol, int>> iteratorStateMachineRemapsByClass =
        new Dictionary<StructSymbol, Dictionary<TypeParameterSymbol, int>>();

    // Issue #1537: for each user-declared type nested inside a generic enclosing
    // type that the emitter reifies over the flattened enclosing+own parameter
    // list (RegisterNestedTypeEnclosingGenerics), the number of ENCLOSING
    // parameters `k` (the low ordinals `0..k-1` of the reified TypeDef, ECMA-335
    // §II.10.3.1). The nested type's own parameters occupy `k..k+m-1`.
    // ResolveUserStructTypeSpecArguments consults this to split a use-site's
    // combined type-argument vector into its enclosing and own halves. Keyed by
    // the nested type's DEFINITION.
    private readonly Dictionary<StructSymbol, int> nestedTypeEnclosingArity =
        new Dictionary<StructSymbol, int>(ReferenceEqualityComparer.Instance);

    // Issue #2118: per-lambda-function original-enclosing-TP -> own-clone-ordinal
    // remap, produced by ClosureEmitter.PromoteGenericLambda and consulted via
    // PushLambdaMethodRemap while the lambda's MethodDef signature and body are
    // emitted.
    private readonly Dictionary<FunctionSymbol, Dictionary<TypeParameterSymbol, int>> lambdaMethodTypeParamRemapsByFunction =
        new Dictionary<FunctionSymbol, Dictionary<TypeParameterSymbol, int>>(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// Gets the currently active iterator/state-machine/nested/closure class
    /// remap (outer-TP → own-class-<c>VAR(idx)</c>), or <see langword="null"/>
    /// when none is pushed. Read by <c>EncodeTypeSymbol</c> for the
    /// null-check-plus-<c>TryGetValue</c> translation, and used as a component
    /// of the user-struct TypeSpec / field-ref / method-ref cache keys (its
    /// object identity distinguishes the same symbol encoded under different
    /// active remaps).
    /// </summary>
    internal Dictionary<TypeParameterSymbol, int> ActiveIteratorStateMachineRemap => this.activeIteratorStateMachineRemap;

    /// <summary>
    /// Gets the currently active generic-promoted-lambda remap
    /// (enclosing-TP → own-method-<c>MVar(idx)</c>), or <see langword="null"/>
    /// when none is pushed. Read by <c>EncodeTypeSymbol</c> and the deferred
    /// lambda constraint resolver.
    /// </summary>
    internal Dictionary<TypeParameterSymbol, int> ActiveLambdaMethodTypeParamRemap => this.activeLambdaMethodTypeParamRemap;

    /// <summary>
    /// Issue #810: push the SM remap for <paramref name="smClass"/> so that
    /// every <see cref="ReflectionMetadataEmitter.EncodeTypeSymbol"/> call made
    /// before the returned disposable is disposed translates outer-method
    /// type-parameter references into the SM class's own type-parameter slots
    /// (Var(idx) instead of MVar(idx)). Calls are nestable; on dispose the
    /// previous remap (or <see langword="null"/>) is restored.
    /// </summary>
    /// <param name="smClass">The reified generic class whose remap to activate.</param>
    /// <returns>A disposable scope that restores the previous remap.</returns>
    internal SmRemapScope PushSmRemap(StructSymbol smClass)
    {
        if (smClass == null
            || !this.iteratorStateMachineRemapsByClass.TryGetValue(smClass, out var remap)
            || remap == null)
        {
            return new SmRemapScope(this, null, restore: false);
        }

        var prev = this.activeIteratorStateMachineRemap;
        this.activeIteratorStateMachineRemap = remap;
        return new SmRemapScope(this, prev, restore: true);
    }

    /// <summary>
    /// Issue #2118: pushes the enclosing-TP -> own-clone-ordinal remap for a
    /// generic-promoted non-capturing lambda so that every
    /// <see cref="ReflectionMetadataEmitter.EncodeTypeSymbol"/> call made while
    /// its signature and body are emitted translates references to the
    /// enclosing type parameters into the lambda method's own <c>MVar(idx)</c>
    /// slots. Restores the previous remap on dispose.
    /// </summary>
    /// <param name="function">The lambda function being emitted.</param>
    /// <returns>A disposable scope that restores the previous remap.</returns>
    internal LambdaMethodRemapScope PushLambdaMethodRemap(FunctionSymbol function)
    {
        if (function == null
            || !this.lambdaMethodTypeParamRemapsByFunction.TryGetValue(function, out var remap)
            || remap == null)
        {
            return new LambdaMethodRemapScope(this, null, restore: false);
        }

        var prev = this.activeLambdaMethodTypeParamRemap;
        this.activeLambdaMethodTypeParamRemap = remap;
        return new LambdaMethodRemapScope(this, prev, restore: true);
    }

    /// <summary>
    /// Registers (or replaces) the outer-TP → own-class-TP remap for
    /// <paramref name="reifiedClass"/> on the shared state-machine remap
    /// channel. Called by the root emitter's registration methods
    /// (state-machine / nested-type / synthesized-closure) and the EmitCore
    /// iterator/async-iterator info loops.
    /// </summary>
    /// <param name="reifiedClass">The reified generic class the remap is keyed by.</param>
    /// <param name="remap">The original-parameter → reified-slot remap.</param>
    internal void RegisterClassRemap(StructSymbol reifiedClass, Dictionary<TypeParameterSymbol, int> remap)
    {
        this.iteratorStateMachineRemapsByClass[reifiedClass] = remap;
    }

    /// <summary>
    /// Records the enclosing arity `k` of a nested type reified over the
    /// flattened enclosing+own parameter list (issue #1537), keyed by the
    /// nested type's DEFINITION.
    /// </summary>
    /// <param name="nestedTypeDef">The nested type's definition.</param>
    /// <param name="enclosingArity">The number of enclosing type parameters.</param>
    internal void SetNestedTypeEnclosingArity(StructSymbol nestedTypeDef, int enclosingArity)
    {
        this.nestedTypeEnclosingArity[nestedTypeDef] = enclosingArity;
    }

    /// <summary>
    /// Issue #1537: attempts to read the enclosing arity `k` recorded for a
    /// nested type's DEFINITION so a use site can split its combined
    /// type-argument vector into enclosing/own halves.
    /// </summary>
    /// <param name="nestedTypeDef">The nested type's definition.</param>
    /// <param name="enclosingArity">The recorded enclosing arity, when present.</param>
    /// <returns><see langword="true"/> when an arity was recorded.</returns>
    internal bool TryGetNestedTypeEnclosingArity(StructSymbol nestedTypeDef, out int enclosingArity) =>
        this.nestedTypeEnclosingArity.TryGetValue(nestedTypeDef, out enclosingArity);

    /// <summary>
    /// Issue #2118: registers the enclosing-TP → own-clone-ordinal remap for a
    /// generic-promoted non-capturing lambda so a later
    /// <see cref="PushLambdaMethodRemap"/> can activate it while the lambda's
    /// signature and body are emitted.
    /// </summary>
    /// <param name="function">The promoted lambda function.</param>
    /// <param name="remap">The enclosing-TP → own-clone-ordinal remap.</param>
    internal void RegisterLambdaMethodRemap(FunctionSymbol function, Dictionary<TypeParameterSymbol, int> remap)
    {
        this.lambdaMethodTypeParamRemapsByFunction[function] = remap;
    }

    internal readonly struct SmRemapScope : IDisposable
    {
        private readonly GenericRemapState owner;
        private readonly Dictionary<TypeParameterSymbol, int> previous;
        private readonly bool restore;

        public SmRemapScope(GenericRemapState owner, Dictionary<TypeParameterSymbol, int> previous, bool restore)
        {
            this.owner = owner;
            this.previous = previous;
            this.restore = restore;
        }

        public void Dispose()
        {
            if (this.restore)
            {
                this.owner.activeIteratorStateMachineRemap = this.previous;
            }
        }
    }

    internal readonly struct LambdaMethodRemapScope : IDisposable
    {
        private readonly GenericRemapState owner;
        private readonly Dictionary<TypeParameterSymbol, int> previous;
        private readonly bool restore;

        public LambdaMethodRemapScope(GenericRemapState owner, Dictionary<TypeParameterSymbol, int> previous, bool restore)
        {
            this.owner = owner;
            this.previous = previous;
            this.restore = restore;
        }

        public void Dispose()
        {
            if (this.restore)
            {
                this.owner.activeLambdaMethodTypeParamRemap = this.previous;
            }
        }
    }
}
