// <copyright file="UserTokenResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis

/// PR-E-19 (#1361): the user-type token-resolution band. Owns every method that
/// renders a reference to a user-declared (same-compilation) generic type,
/// interface, delegate, field, method, property accessor, or constructor into
/// the correct ECMA-335 token — a bare `TypeDef`/`MethodDef`/
/// `FieldDef` for a non-generic declarer, or a `TypeSpec`-parented
/// `MemberRef` (over the constructed or self-instantiation) for a generic
/// one. Covers the user struct/interface/delegate `TypeSpec` producers and
/// their memoization caches, the field/method/ctor MemberRef factories, the
/// property-accessor and static/instance/interface method-token resolvers, the
/// constructed-base ctor-token resolvers, the generic-user-call
/// `MethodSpec` builder and its structural type-argument unifier, the
/// non-capturing generic-lambda promotion and its `ldftn` token, and the
/// symbolic-substituted-return trio the erasure-widening short-circuits on.
/// @remarks This is the consolidation commit the Wave-1 emitter decomposition built
/// toward: it resolves the temporary couplings PR-E-17 (SignatureEncoder) and
/// PR-E-18 (ImportedMemberRefFactory) left pointing into this band. Those
/// siblings now reach the user-token resolvers directly through the root's
/// (cref:ReflectionMetadataEmitter.userTokens) field, and the two
/// PR-E-17 widenings (`ResolveUserStructTypeSpecArguments` /
/// `ResolveDelegateTypeArguments`) that had been promoted on the root are
/// relocated / restored here.
///
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// SignatureEncoder / ImportedMemberRefFactory idiom) because the band reaches
/// (cref:EmitContext), (cref:MetadataTokenCache),
/// (cref:GenericRemapState), the extracted (cref:SignatureEncoder)
/// and (cref:ImportedMemberRefFactory), and a few root-owned surfaces
/// that stay put (the shared static predicates
/// (cref:ReflectionMetadataEmitter.IsUserGenericTypeReference) /
/// (cref:ReflectionMetadataEmitter.ArgIsSymbolicUserDefined), the
/// async-return encoder (cref:ReflectionMetadataEmitter.EncodeAsyncReturnType),
/// `FindImportedMethod`, and the state-machine plans / well-known refs).
/// Direct convenience fields hold the shared (cref:EmitContext) /
/// (cref:MetadataTokenCache) / (cref:GenericRemapState) /
/// (cref:SignatureEncoder) / (cref:ImportedMemberRefFactory) read
/// off the back-reference. Method bodies are verbatim moves; emitted PEs are
/// byte-identical with the pre-E-19 baseline.
internal class UserTokenResolver {
    private let outer ReflectionMetadataEmitter
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let remaps GenericRemapState
    private let signatures SignatureEncoder
    private let memberRefs ImportedMemberRefFactory

    // Issue #2793: user-declared generic metadata is encoding-sensitive to
    // BOTH active remap channels — the class/state-machine remap
    // (ActiveIteratorStateMachineRemap, VAR) and the generic-promoted-lambda
    // remap (ActiveLambdaMethodTypeParamRemap, MVAR). The same user generic
    // struct referenced inside a generic-promoted lambda encodes its type
    // arguments under the lambda method's own MVAR ordinals, which differ from
    // the enclosing method's MVAR ordinals at its outer use site. Keying only
    // on the class remap let a lambda-scope TypeSpec/MemberRef leak into the
    // enclosing scope (and vice versa), producing an out-of-range MVAR index
    // (ilverify get_GenericParameters IndexOutOfRange / runtime
    // BadImageFormatException). Both channels are part of every key,
    // reified as a single RemapScope value (issue #3163).
    private let userStructTypeSpecCache Dictionary[(Sym StructSymbol, Scope RemapScope), EntityHandle] = Dictionary[
        (Sym StructSymbol, Scope RemapScope),
        EntityHandle
    ]()

    private let userEnumTypeSpecCache Dictionary[(Sym EnumSymbol, Scope RemapScope), EntityHandle] = Dictionary[
        (Sym EnumSymbol, Scope RemapScope),
        EntityHandle
    ]()
    private let userStructFieldRefCache Dictionary[
        (Containing StructSymbol, DefField FieldSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Containing StructSymbol, DefField FieldSymbol, Scope RemapScope), EntityHandle]()
    private let userStructMethodRefCache Dictionary[
        (Containing StructSymbol, OpenMember EntityHandle, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Containing StructSymbol, OpenMember EntityHandle, Scope RemapScope), EntityHandle]()
    private let userInterfaceTypeSpecCache Dictionary[
        (Sym InterfaceSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Sym InterfaceSymbol, Scope RemapScope), EntityHandle]()
    private let userInterfaceMethodRefCache Dictionary[UserInterfaceMethodRefKey, EntityHandle] = Dictionary[
        UserInterfaceMethodRefKey,
        EntityHandle
    ]()
    private let userInterfaceFieldRefCache Dictionary[
        (Containing InterfaceSymbol, DefField FieldSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Containing InterfaceSymbol, DefField FieldSymbol, Scope RemapScope), EntityHandle]()
    private let userDelegateTypeSpecCache Dictionary[
        (Sym DelegateTypeSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Sym DelegateTypeSymbol, Scope RemapScope), EntityHandle]()
    private let userDelegateCtorRefCache Dictionary[
        (Sym DelegateTypeSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Sym DelegateTypeSymbol, Scope RemapScope), EntityHandle]()
    private let userDelegateInvokeRefCache Dictionary[
        (Sym DelegateTypeSymbol, Scope RemapScope),
        EntityHandle
    ] = Dictionary[(Sym DelegateTypeSymbol, Scope RemapScope), EntityHandle]()

    // Issue #2118: per-lambda-function ordered ORIGINAL enclosing type
    // parameters used as the MethodSpec type arguments when the lambda is
    // referenced (`ldftn <lambda><...enclosing args...>`) at its delegate
    // materialization site. The paired enclosing-TP → own-clone-ordinal remap
    // (which drives EncodeTypeSymbol) lives on GenericRemapState; this ordered
    // list is a delegate-materialization-token concern, not remap-scope state.
    // PR-E-19: moved off the root with its sole users
    // (TryPromoteNonCapturingGenericLambda / ResolveLambdaFunctionFtnToken).
    private let lambdaMethodTypeArgsByFunction Dictionary[
        FunctionSymbol,
        ImmutableArray[TypeParameterSymbol]
    ] = Dictionary[FunctionSymbol, ImmutableArray[TypeParameterSymbol]](ReferenceEqualityComparer.Instance)

    // Issue #4223: a zero-capture local function's TRUE own (pre-promotion)
    // type-parameter list, captured the first time TryPromoteNonCapturingGenericLambda
    // sees it. TryPromoteNonCapturingGenericLambda runs to a FIXED POINT (a
    // promoted callee's extra type parameters can require its caller — another
    // zero-capture local in the same pass — to also carry them, so the call
    // site can supply them), so on a later pass `fn.TypeParameters` already
    // includes previously-appended clones; this is the stable baseline that
    // distinguishes "this function's own declared slots" from "slots already
    // promoted onto it" across repeated calls for the same function.
    private let ownTypeParametersByFunction Dictionary[
        FunctionSymbol,
        ImmutableArray[TypeParameterSymbol]
    ] = Dictionary[FunctionSymbol, ImmutableArray[TypeParameterSymbol]](ReferenceEqualityComparer.Instance)

    init(outer ReflectionMetadataEmitter) {
        this.outer = outer ?? throw ArgumentNullException("outer")
        this.emitCtx = outer.emitCtx
        this.cache = outer.cache
        this.remaps = outer.remaps
        this.signatures = outer.signatures ?? throw ArgumentNullException("outer")
        this.memberRefs = outer.memberRefs ?? throw ArgumentNullException("outer")
    }

    /// Issue #2118, extended by #4223: promotes a zero-capture local
    /// function/lambda that references one or more ENCLOSING method/class type
    /// parameters into a genuine generic method. Clones each referenced
    /// enclosing type parameter (with its constraints remapped onto the clone)
    /// and appends the clones after the function's own declared type
    /// parameters (if any — a plain, non-generic-own local function has none,
    /// so the clones become its entire list, exactly the original #2118
    /// shape). Records the enclosing-TP -> own-clone-ordinal remap (so the
    /// signature/body encode translates references into the method's own
    /// `MVar` slots) and the ordered originals (used as MethodSpec type
    /// arguments both at the delegate-materialization `ldftn` site and,
    /// for the direct-call generic-own-TP shape, at every call site — see
    /// (cref:BuildMethodSpecForGenericCall)). No-op for a lambda that
    /// references no enclosing type parameter.
    /// @remarks Issue #4223 (transitive case): promoting a CALLEE can, in turn, require
    /// its CALLER (another zero-capture local in the same pass) to also carry
    /// the same enclosing type parameters, purely so the call site has
    /// something to pass — a caller whose own signature/body never mentions
    /// the parameter directly (e.g. `let A = func(x T) int32 { return B(x) }`
    /// calling `let B = func(x T) int32 { return Public() }`, where only `B`
    /// mentions the enclosing type via an implicit static-owner call).
    /// Confirmed by direct repro: without this, the caller's emitted call
    /// site falls back to encoding the extra argument as a dangling `VAR`
    /// slot (silently WRONG at runtime whenever that slot's ordinal
    /// coincidentally collides with one of the caller's own — worse than a
    /// crash) or an invalid one (`System.BadImageFormatException`). The
    /// caller in turn discovers this need through (cref:LambdaEnclosingTypeParameterCollector)
    /// consulting (cref:GetPromotedExtras) for every call it makes, so
    /// this method must be invoked to a FIXED POINT over every zero-capture
    /// literal in a pass (see `ReflectionMetadataEmitter.SynthesizeClosuresAndStateMachines`) —
    /// a callee promoted on a later iteration still reaches its not-yet-reprocessed
    /// callers. Each call re-derives the function's full referenced set from
    /// scratch (including whatever was already promoted, since a caller's own
    /// call sites are re-scanned every pass) rather than computing a delta, which
    /// is safe because promotion runs entirely before any metadata is emitted —
    /// no (cref:GenericRemapState) push observes an intermediate state.
    /// @param literal The non-capturing lambda literal being hosted as a top-level static method.
    /// @param loweredBody The lambda's lowered body (walked for type-parameter references).
    internal func TryPromoteNonCapturingGenericLambda(
        literal BoundFunctionLiteralExpression,
        loweredBody BoundBlockStatement
    ) {
        let fn FunctionSymbol? = literal?.Function
        if fn == nil {
            return
        }
        if !this.ownTypeParametersByFunction.TryGetValue(fn, out var ownTypeParameters) {
            ownTypeParameters = fn.TypeParameters
            this.ownTypeParametersByFunction[fn] = ownTypeParameters
        }
        let referenced = List[TypeParameterSymbol]()
        for parameter in fn.Parameters {
            TypeSymbol.CollectReferencedTypeParameters(parameter.Type, referenced)
        }
        TypeSymbol.CollectReferencedTypeParameters(fn.Type, referenced)
        // Issue #4223: a generic local function's OWN type-parameter
        // constraint can reference an enclosing type parameter too
        // (`Keep[T IComparable[U]]`, `U` owned by the enclosing method/class).
        for ownTp in ownTypeParameters {
            TypeSymbol.CollectReferencedTypeParameters(ownTp.ConstraintReferenceType, referenced)
        }
        LambdaEnclosingTypeParameterCollector.Collect(loweredBody, referenced, this.GetPromotedExtras)
        // Only an ENCLOSING type parameter gets cloned/promoted here — the
        // function's own declared type parameters (if any) already have a
        // valid MVar slot on this very method.
        if !ownTypeParameters.IsDefaultOrEmpty {
            referenced.RemoveAll((tp TypeParameterSymbol) -> ownTypeParameters.Contains(tp))
        }
        if referenced.Count == 0 {
            return
        }
        // Canonical order: class type parameters (Var) before method type
        // parameters (MVar), each by original ordinal — matching
        // SynthesizedClosureReifier.CollectOrdered so the clone list is
        // deterministic. Deduplicated (a repeated pass, or a callee's extras,
        // can rediscover a parameter this function's own scan already found).
        let seen = HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance)
        referenced.RemoveAll((tp TypeParameterSymbol) -> !seen.Add(tp))
        referenced.Sort(
            (a TypeParameterSymbol, b TypeParameterSymbol) -> {
                let ak = if a.IsMethodTypeParameter {
                    1
                } else {
                    0
                }
                let bk = if b.IsMethodTypeParameter {
                    1
                } else {
                    0
                }
                return if ak != bk {
                    ak - bk
                } else {
                    a.Ordinal - b.Ordinal
                }
            }
        )
        let origTPs = referenced.ToImmutableArray()
        let ownCount = ownTypeParameters.Length
        let clones = SynthesizedClosureReifier.CloneWithRemappedConstraints(origTPs, ordinalOffset: ownCount)
        // Setting TypeParameters flips each clone's IsMethodTypeParameter flag,
        // so the emitter encodes body/signature references as MVar(idx). Own
        // type parameters (if any) keep their existing 0..ownCount-1 ordinals
        // and are simply carried along ahead of the promoted clones. Assigned
        // wholesale (not appended) since this recomputes the function's
        // complete extra set from scratch every pass, and no push has yet
        // observed the previous value.
        fn.TypeParameters = if ownCount == 0 {
            clones
        } else {
            ownTypeParameters.AddRange(clones)
        }
        let remap = Dictionary[TypeParameterSymbol, int32](origTPs.Length, ReferenceEqualityComparer.Instance)
        for var i = 0; i < origTPs.Length; i++ {
            remap[origTPs[i]] = ownCount + i
        }
        this.remaps.RegisterLambdaMethodRemap(fn, remap)
        this.lambdaMethodTypeArgsByFunction[fn] = origTPs
    }

    /// Issue #4223: the ordered ENCLOSING type parameters
    /// (cref:TryPromoteNonCapturingGenericLambda) promoted onto
    /// [`fn`](paramref) as its trailing method type parameters — the
    /// exact type arguments a call site must append after [`fn`](paramref)'s
    /// own to build a valid `MethodSpec` (see
    /// (cref:BuildMethodSpecForGenericCall)) — or empty when
    /// [`fn`](paramref) was never promoted. Also consulted by
    /// (cref:LambdaEnclosingTypeParameterCollector) so a CALLER
    /// discovers it must promote itself for the same parameters purely to
    /// have something to pass at its own call site to [`fn`](paramref).
    /// @param fn The (possibly promoted) callee function.
    /// @returns The ordered promoted-extra type parameters, or empty.
    internal func GetPromotedExtras(fn FunctionSymbol) ImmutableArray[TypeParameterSymbol] -> if this
        .lambdaMethodTypeArgsByFunction
        .TryGetValue(fn, out var extras) {
        extras
    } else {
        ImmutableArray[TypeParameterSymbol].Empty
    }

    /// Issue #2118: resolves the `ldftn` target token for a non-capturing
    /// lambda function. When the lambda was generic-promoted
    /// ((cref:TryPromoteNonCapturingGenericLambda)) the token is a
    /// MethodSpec instantiating the open lambda method with the enclosing type
    /// parameters (in the referencing method's context); otherwise it is the
    /// bare MethodDef handle.
    /// @param fn The lambda function whose function pointer is loaded.
    /// @returns The MethodDef or MethodSpec token for the `ldftn`.
    internal func ResolveLambdaFunctionFtnToken(fn FunctionSymbol) EntityHandle {
        let methodHandle = this.cache.FunctionHandles[fn]
        if this.lambdaMethodTypeArgsByFunction.TryGetValue(fn, out var typeArgs) && !typeArgs.IsDefaultOrEmpty {
            let args = [typeArgs.Length]TypeSymbol
            for var i = 0; i < typeArgs.Length; i++ {
                args[i] = typeArgs[i]
            }
            return this.BuildMethodSpec(methodHandle, args)
        }
        return methodHandle
    }

    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// function call. Derives the type arguments from the call's
    /// arguments and substituted return type. Required because the
    /// post-R2 MethodDef carries MVAR slots; the call site must
    /// reference a MethodSpec naming the substituted instantiation.
    internal func BuildMethodSpecForGenericCall(openMethod EntityHandle, call BoundCallExpression) EntityHandle {
        let tps = call.Function.TypeParameters
        // Issue #4223: a generic local function promoted by
        // TryPromoteNonCapturingGenericLambda to ALSO carry cloned enclosing
        // type parameters (issue #2118) appends them after its own declared
        // list. Those trailing slots can never be inferred from the call's
        // arguments — the function's own parameter/return types still name
        // the ORIGINAL enclosing type parameter, never the clone — they are
        // exactly the in-scope originals recorded when the clones were made,
        // valid as-is at any call site still lexically nested in that scope.
        let extras = if this.lambdaMethodTypeArgsByFunction.TryGetValue(call.Function, out var extraOriginals) {
            extraOriginals
        } else {
            ImmutableArray[TypeParameterSymbol].Empty
        }
        let ownCount = tps.Length - extras.Length
        // Issue #1931: prefer the bind-time-resolved OWN method type
        // arguments (explicit `[T]` list or inference) stashed on the bound
        // node — see BuildMethodSpecForGenericInstanceCall for the rationale.
        // The bound node was recorded before any enclosing-type-parameter
        // promotion, so its arity always matches the OWN (pre-promotion) list.
        var ownArgs[]TypeSymbol
        if !call.MethodTypeArguments.IsDefaultOrEmpty && call.MethodTypeArguments.Length == ownCount {
            ownArgs = call.MethodTypeArguments.ToArray()
        } else {
            ownArgs = [ownCount]TypeSymbol
            let inferenceReturn = AsyncReturnTypeNormalizer.GetDeclaredResultType(
                call.Function,
                Invariant.Required(
                    call.ReturnType,
                    "a generic call has a return type for inference",
                    expression: "call.ReturnType"
                )
            )
            for var i = 0; i < ownCount; i++ {
                ownArgs[i] = InferMethodTypeArgument(call.Function, call.Arguments, inferenceReturn, tps[i])
            }
        }
        if extras.IsDefaultOrEmpty {
            return this.BuildMethodSpec(openMethod, ownArgs)
        }
        let args = [tps.Length]TypeSymbol
        Array.Copy(ownArgs, args, ownCount)
        for var i = 0; i < extras.Length; i++ {
            args[ownCount + i] = extras[i]
        }
        return this.BuildMethodSpec(openMethod, args)
    }

    internal func BuildMethodSpecForGenericMethodGroup(
        openMethod EntityHandle,
        methodGroup BoundMethodGroupExpression
    ) EntityHandle -> this.BuildMethodSpec(openMethod, methodGroup.MethodTypeArguments.ToArray())

    /// Issue #3226: builds a MethodSpec for a generic G# user function call
    /// whose instantiation was LIFTED at the call site — an unconstrained
    /// `T?` parameter slot instantiated at a value type substitutes
    /// `Nullable<X>` for the bind-time `X` so the erased
    /// `!!T` slots carry the nullable representation. The caller
    /// ((cref:MethodBodyEmitter)'s lift planner) supplies the already
    /// lifted type-argument vector.
    /// @param openMethod The open generic MethodDef handle.
    /// @param liftedTypeArguments The lifted instantiation vector.
    /// @returns The MethodSpec handle.
    internal func BuildMethodSpecForLiftedGenericCall(
        openMethod EntityHandle,
        liftedTypeArguments[]TypeSymbol
    ) EntityHandle -> this.BuildMethodSpec(openMethod, liftedTypeArguments)

    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// instance method call (`h.Box[int32](42)`). Same inference rules
    /// as (cref:BuildMethodSpecForGenericCall).
    internal func BuildMethodSpecForGenericInstanceCall(
        openMethod EntityHandle,
        call BoundUserInstanceCallExpression
    ) EntityHandle {
        let tps = call.Method.TypeParameters
        // Issue #1931: prefer the authoritative (explicit-or-inferred) method
        // type arguments the binder already resolved and stashed on the bound
        // node. Falling back to structural re-inference over the call's
        // arguments/return shape is unsafe in general — e.g. an explicit
        // `shower.Show[string](nil)` call has no argument or return shape that
        // structurally mentions `T`, so re-deriving it here would fail even
        // though the call bound successfully.
        if !call.MethodTypeArguments.IsDefaultOrEmpty && call.MethodTypeArguments.Length == tps.Length {
            return this.BuildMethodSpec(openMethod, call.MethodTypeArguments.ToArray())
        }
        let args = [tps.Length]TypeSymbol
        let calleeParameterOffset = if call.Method.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        let inferenceReturn = AsyncReturnTypeNormalizer.GetDeclaredResultType(call.Method, call.Type)
        // The user-instance call's Arguments excludes the receiver,
        // but Method.Parameters includes the explicit receiver (when
        // present) at index 0. We pass a sliced view to the inference
        // helper so positional indices line up.
        var userParams = call.Method.Parameters
        if calleeParameterOffset > 0 {
            userParams = call.Method.Parameters.RemoveAt(0)
        }
        for var i = 0; i < tps.Length; i++ {
            args[i] = InferMethodTypeArgument(userParams, call.Arguments, inferenceReturn, call.Method.Type, tps[i])
        }
        return this.BuildMethodSpec(openMethod, args)
    }

    private func BuildMethodSpec(openMethod EntityHandle, args[]TypeSymbol) EntityHandle {
        let sigBlob = BlobBuilder()
        let argsEnc = BlobEncoder(sigBlob).MethodSpecificationSignature(args.Length)
        for var i = 0; i < args.Length; i++ {
            this.signatures.EncodeTypeSymbol(argsEnc.AddArgument(), args[i])
        }
        return this.emitCtx.MetadataRows.AddMethodSpecification(openMethod, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #2793: builds the user-struct `TypeSpec` cache key for
    /// [`structSym`](paramref) under the two encoding-sensitive remap
    /// channels — the class/state-machine remap
    /// ((cref:GenericRemapState.ActiveIteratorStateMachineRemap), VAR)
    /// and the generic-promoted-lambda remap
    /// ((cref:GenericRemapState.ActiveLambdaMethodTypeParamRemap), MVAR).
    /// The object identity of each active remap distinguishes the same symbol
    /// encoded under different scopes so a lambda-scope encoding is never
    /// reused at an enclosing-method use site.
    private func GetUserStructRemapKey(structSym StructSymbol)(Sym StructSymbol, Scope RemapScope) -> (
        structSym,
        this.remaps.CurrentScope
    )

    /// Issue #2793: user-interface variant of (cref:GetUserStructRemapKey).
    /// A user-declared generic interface's `TypeSpec`/`MemberRef` is
    /// equally sensitive to both active remap channels through its encoded type
    /// arguments (directly for the TypeSpec, transitively via the parent
    /// TypeSpec for its member refs).
    private func GetUserInterfaceRemapKey(ifaceSym InterfaceSymbol)(Sym InterfaceSymbol, Scope RemapScope) -> (
        ifaceSym,
        this.remaps.CurrentScope
    )

    private func GetUserEnumRemapKey(enumSym EnumSymbol)(Sym EnumSymbol, Scope RemapScope) -> (
        enumSym,
        this.remaps.CurrentScope
    )

    /// Issue #2793: user-delegate variant of (cref:GetUserStructRemapKey).
    /// A user-declared generic named delegate's `TypeSpec`, `.ctor`
    /// and `Invoke` refs are sensitive to both active remap channels
    /// through the encoded type arguments of the (possibly shared) parent
    /// TypeSpec.
    private func GetUserDelegateRemapKey(delegateSym DelegateTypeSymbol)(Sym DelegateTypeSymbol, Scope RemapScope) -> (
        delegateSym,
        this.remaps.CurrentScope
    )

    /// ADR-0087 §3 R3: returns a `TypeSpec` EntityHandle for a
    /// user-declared generic type. When [`structSym`](paramref)
    /// carries (cref:StructSymbol.TypeArguments) the spec
    /// encodes the construction (`Box`1<int32>`); when it is
    /// the open definition the spec encodes the self-instantiation
    /// (`Box`1<!0,...>`) which is the only valid receiver
    /// type for the definition's own instance bodies (ECMA-335 II.10.3.1).
    internal func GetUserStructTypeSpec(structSym StructSymbol) EntityHandle {
        let cacheKey = this.GetUserStructRemapKey(structSym)
        if this.userStructTypeSpecCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let def = structSym.Definition ?? structSym
        if !this.cache.StructTypeDefs.TryGetValue(def, out var defHandle) {
            throw InvalidOperationException(
                "User generic type '${def.Name}' has no emitted TypeDef when constructing TypeSpec."
            )
        }
        let typeArgs = ResolveUserStructTypeSpecArguments(structSym, def)
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
        let gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: !def.IsClass)
        for arg in typeArgs {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg)
        }
        let spec = EntityHandle(
            this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        )
        this.userStructTypeSpecCache[cacheKey] = spec
        return spec
    }

    // PR-E-19: the E-17 widening is resolved here — this now lives on
    // UserTokenResolver alongside its sole users, and SignatureEncoder reaches it
    // through `outer.userTokens.ResolveUserStructTypeSpecArguments`
    // (EncodeTypeSymbol's user-generic struct branch) rather than a root
    // forwarder.
    /// ADR-0087 §3 R3 / issue #1521: resolves the type-argument vector encoded
    /// for a reference to a user-declared generic struct (or a type nested
    /// inside one). A constructed instance uses its own
    /// (cref:StructSymbol.TypeArguments) (`Box`1<int32>`); a
    /// constructed reference to a nested type uses the enclosing construction's
    /// (cref:StructSymbol.EnclosingTypeArguments)
    /// (`Box`1+Tag`1<int32>`); the open definition (including a nested
    /// type referenced from within its enclosing generic's own members) uses the
    /// self-instantiation over the definition's own type parameters, each of
    /// which encodes as `VAR(idx)` (`Box`1+Tag`1<!0>`).
    /// @param structSym The struct reference being encoded.
    /// @param def The struct's emitted definition.
    /// @returns The type-argument vector aligned with [`def`](paramref)'s type parameters.
    internal func ResolveUserStructTypeSpecArguments(structSym StructSymbol, def StructSymbol) ImmutableArray[
        TypeSymbol
    ] {
        // Issue #1537: a type nested inside a generic enclosing type is reified
        // over the flattened enclosing+own parameter list (`Outer`1+Middle`2`),
        // so its use-site argument vector is built from TWO halves — the
        // enclosing arguments (`0..k-1`) then the nested type's own arguments
        // (`k..k+m-1`). Each half is concrete when the reference carries it and
        // the open reified parameters (encoded `VAR(idx)`) otherwise, so the
        // vector is context-correct for constructed and open references alike.
        if this.remaps.TryGetNestedTypeEnclosingArity(def, out var enclosingArity) && enclosingArity > 0 {
            let defTps = def.TypeParameters
            let total = defTps.Length
            // A self-reference from within the nested type's OWN body (the
            // implicit `this` receiver, e.g. reading `FromU` inside a `Middle`
            // method) is the self-instantiation over the reified definition's
            // full parameter list, so its argument vector already spans BOTH
            // halves (`<U, T>` == `<!0, !1>`). Emit it verbatim — splitting it
            // into halves would double-count the enclosing slots.
            if structSym.EnclosingTypeArguments.IsDefaultOrEmpty && structSym.TypeArguments.Length == total {
                return structSym.TypeArguments
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](total)
            // Enclosing half (`0..k-1`): the threaded enclosing arguments when
            // present (constructed use site, `<int32, …>`), else the reified
            // enclosing parameters (open reference from within the enclosing
            // generic's members, `<!0, …>`).
            if !structSym.EnclosingTypeArguments.IsDefaultOrEmpty {
                for var i = 0; i < enclosingArity && i < structSym.EnclosingTypeArguments.Length; i++ {
                    builder.Add(structSym.EnclosingTypeArguments[i])
                }
                for var i = builder.Count; i < enclosingArity && i < total; i++ {
                    builder.Add(defTps[i])
                }
            } else {
                for var i = 0; i < enclosingArity && i < total; i++ {
                    builder.Add(defTps[i])
                }
            }
            // Own half (`k..k+m-1`): the nested type's own arguments when
            // present (`Middle[string]`), else its reified own parameters (open,
            // `<…, !k>`).
            if !structSym.TypeArguments.IsDefaultOrEmpty {
                builder.AddRange(structSym.TypeArguments)
                for var i = builder.Count; i < total; i++ {
                    builder.Add(defTps[i])
                }
            } else {
                for var i = enclosingArity; i < total; i++ {
                    builder.Add(defTps[i])
                }
            }
            if builder.Count > total {
                let trimmed = ImmutableArray.CreateBuilder[TypeSymbol](total)
                for var i = 0; i < total; i++ {
                    trimmed.Add(builder[i])
                }
                return trimmed.MoveToImmutable()
            }
            return builder.ToImmutable()
        }
        if !structSym.TypeArguments.IsDefaultOrEmpty {
            return structSym.TypeArguments
        }
        // Issue #1521: a constructed reference to a type nested inside a generic
        // enclosing type threads the enclosing construction's arguments as the
        // reified nested type's argument vector (`Box`1+Tag`1<int32>`).
        if !structSym.EnclosingTypeArguments.IsDefaultOrEmpty {
            return structSym.EnclosingTypeArguments
        }
        // Open definition → encode self-instantiation using the definition's
        // own type parameters as arguments. Each will encode as `VAR(idx)` via
        // EncodeTypeSymbol. For a nested type referenced from within its
        // enclosing generic's own members these are the reified enclosing
        // parameters, so the reference correctly threads `!0…`.
        let openTps = def.TypeParameters
        let bld = ImmutableArray.CreateBuilder[TypeSymbol](openTps.Length)
        for tp in openTps {
            bld.Add(tp)
        }
        return bld.MoveToImmutable()
    }

    /// Returns a TypeSpec for a nested enum reified over generic enclosing types.
    internal func GetUserEnumTypeSpec(enumSym EnumSymbol) EntityHandle {
        let cacheKey = this.GetUserEnumRemapKey(enumSym)
        if this.userEnumTypeSpecCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let def = enumSym.Definition ?? enumSym
        if !this.cache.EnumTypeDefs.TryGetValue(def, out var defHandle) {
            throw InvalidOperationException(
                "User enum '${def.Name}' has no emitted TypeDef when constructing TypeSpec."
            )
        }
        let typeArgs = ResolveUserEnumTypeSpecArguments(enumSym, def)
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
        let gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: true)
        for arg in typeArgs {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg)
        }
        let spec = EntityHandle(
            this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        )
        this.userEnumTypeSpecCache[cacheKey] = spec
        return spec
    }

    /// Resolves a nested enum's enclosing construction.
    internal func ResolveUserEnumTypeSpecArguments(enumSym EnumSymbol, def EnumSymbol) ImmutableArray[TypeSymbol] {
        if !enumSym.EnclosingTypeArguments.IsDefaultOrEmpty {
            return enumSym.EnclosingTypeArguments
        }
        throw InvalidOperationException(
            "Open nested enum '${def.ContainingType}.${def.Name}' escaped its generic context; enclosing type arguments must be resolved before emission."
        )
    }

    /// Issue #1503: returns a `TypeSpec` EntityHandle for a generic
    /// user-declared named delegate. A constructed instance encodes the
    /// construction (`Predicate`1<int32>`); the open definition
    /// encodes the self-instantiation (`Predicate`1<!0,…>`). Mirrors
    /// (cref:GetUserStructTypeSpec).
    /// @param delegateSym The generic delegate reference.
    /// @returns The TypeSpec handle.
    internal func GetUserDelegateTypeSpec(delegateSym DelegateTypeSymbol) EntityHandle {
        let cacheKey = this.GetUserDelegateRemapKey(delegateSym)
        if this.userDelegateTypeSpecCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let def = delegateSym.Definition ?? delegateSym
        if !this.cache.DelegateTypeDefs.TryGetValue(def, out var defHandle) {
            throw InvalidOperationException(
                "Generic delegate '${def.Name}' has no emitted TypeDef when constructing TypeSpec."
            )
        }
        let typeArgs = ReflectionMetadataEmitter.ResolveDelegateTypeArguments(delegateSym)
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
        let gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: false)
        for arg in typeArgs {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg)
        }
        let spec = EntityHandle(
            this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        )
        this.userDelegateTypeSpecCache[cacheKey] = spec
        return spec
    }

    /// Issue #1503: resolves the token used to construct a named-delegate
    /// value (`newobj` of its `.ctor(object, native int)`). A
    /// non-generic delegate uses the bare `.ctor` MethodDef; a generic
    /// delegate uses a `MemberRef` parented at the constructed (or self-)
    /// `TypeSpec` so the IL verifies against the locally-typed slot.
    /// @param delegateSym The (possibly constructed) delegate symbol.
    /// @returns The ctor token.
    internal func ResolveDelegateCtorToken(delegateSym DelegateTypeSymbol) EntityHandle {
        let def = delegateSym.Definition ?? delegateSym
        if !ReflectionMetadataEmitter.IsUserGenericDelegateReference(delegateSym) {
            if !this.cache.DelegateCtorHandles.TryGetValue(def, out var ctorHandle) {
                throw InvalidOperationException("Named delegate '${def.Name}' has no emitted .ctor MethodDef.")
            }
            return ctorHandle
        }
        if this.userDelegateCtorRefCache.TryGetValue(this.GetUserDelegateRemapKey(delegateSym), out var cached) {
            return cached
        }
        // The delegate ctor signature is the canonical `(object, native int)`
        // for every delegate — it never references the type parameters — so the
        // MemberRef signature is the same regardless of construction.
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Object()
                ps.AddParameter().Type().IntPtr()
            }
        )
        let parent = this.GetUserDelegateTypeSpec(delegateSym)
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
        )
        this.userDelegateCtorRefCache[this.GetUserDelegateRemapKey(delegateSym)] = memberRef
        return memberRef
    }

    /// Issue #1503: resolves the token used to invoke a named-delegate value
    /// (`callvirt` of its `Invoke`). A non-generic delegate uses the
    /// bare `Invoke` MethodDef; a generic delegate uses a `MemberRef`
    /// parented at the constructed (or self-) `TypeSpec`, with the Invoke
    /// signature encoded from the OPEN definition (so type-parameter slots
    /// round-trip as `VAR(idx)`, matching the emitted MethodDef).
    /// @param delegateSym The (possibly constructed) delegate symbol.
    /// @returns The Invoke token.
    internal func ResolveDelegateInvokeToken(delegateSym DelegateTypeSymbol) EntityHandle {
        let def = delegateSym.Definition ?? delegateSym
        if !ReflectionMetadataEmitter.IsUserGenericDelegateReference(delegateSym) {
            if !this.cache.DelegateInvokeHandles.TryGetValue(def, out var invokeHandle) {
                throw InvalidOperationException("Named delegate '${def.Name}' has no emitted Invoke MethodDef.")
            }
            return invokeHandle
        }
        if this.userDelegateInvokeRefCache.TryGetValue(this.GetUserDelegateRemapKey(delegateSym), out var cached) {
            return cached
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            def.Parameters.Length,
            (r ReturnTypeEncoder) -> this.signatures.EncodeReturnSymbol(
                r,
                def.ReturnType ?? TypeSymbol.Void,
                RefKind.None
            ),
            (ps ParametersEncoder) -> {
                for p in def.Parameters {
                    TypeDefEmitter.EncodeParameterSignature(
                        ps,
                        p,
                        this.signatures.EncodeTypeSymbol,
                        this.outer.wellKnown
                    )
                }
            }
        )
        let parent = this.GetUserDelegateTypeSpec(delegateSym)
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
        )
        this.userDelegateInvokeRefCache[this.GetUserDelegateRemapKey(delegateSym)] = memberRef
        return memberRef
    }

    /// Issue #1465: returns the metadata token for a state-machine (or any
    /// user) struct type used as an operand (`initobj`) or type
    /// argument. A non-generic struct uses its bare `TypeDef`; a generic
    /// struct uses the constructed (or self-) `TypeSpec` so references
    /// from a generic context carry the correct `Var` instantiation.
    /// @param structSym The struct symbol.
    /// @returns The type token.
    internal func GetStructTypeToken(structSym StructSymbol) EntityHandle {
        return if ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
            this.GetUserStructTypeSpec(structSym)
        } else {
            this.cache.StructTypeDefs[structSym]
        }
    }

    /// Issue #1465: internal forwarder so the body emitter can encode a
    /// (cref:TypeSymbol) into a signature blob (e.g. a MethodSpec type
    /// argument) using the same generic-aware path as the rest of the emitter.
    /// @param encoder The signature type encoder to write into.
    /// @param type The type symbol to encode.
    internal func EncodeTypeSymbolIntoSignature(encoder SignatureTypeEncoder, type TypeSymbol) {
        this.signatures.EncodeTypeSymbol(encoder, type)
    }

    /// ADR-0087 §3 R3: returns a `MemberRef` handle for a field
    /// on a user-declared generic type, parented at the
    /// `TypeSpec` for [`containingType`](paramref).
    /// The MemberRef's signature is encoded from the OPEN definition's
    /// field — type-parameter slots round-trip as `VAR(idx)`.
    internal func GetUserStructFieldRef(containingType StructSymbol, fieldOnContaining FieldSymbol) EntityHandle {
        let def = containingType.Definition ?? containingType
        var defField FieldSymbol? = nil
        for candidate in def.Fields {
            // Issue #3689: prefer the exact field instance. Matching by name
            // alone silently aliases two same-named slots with different
            // signatures onto the first one's blob (state machines used to
            // hoist every lowered `for` temp as `<>5__$enum`).
            if object.ReferenceEquals(candidate, fieldOnContaining) {
                defField = candidate
                break
            }
            if defField == nil && candidate.Name == fieldOnContaining.Name {
                defField = candidate
            }
        }
        if defField == nil {
            // ADR-0029 backing-field fallback: synthesised members (auto-property,
            // field-like event) live alongside Fields under different containers.
            defField = fieldOnContaining
        }
        let key = (containingType, defField, this.remaps.CurrentScope)
        if this.userStructFieldRefCache.TryGetValue(key, out var cached) {
            return cached
        }
        let parent = this.GetUserStructTypeSpec(containingType)
        let sigBlob = BlobBuilder()
        // Issue #810: when the containing type is a generic iterator
        // state-machine class, the FieldDef's signature was encoded with
        // outer-method TPs translated to Var(idx). The MemberRef sig
        // MUST match — push the SM's remap so EncodeTypeSymbol routes
        // the same TPs through the same Var(idx) slots here.
        {
            using let _ = this.remaps.PushSmRemap(containingType.Definition ?? containingType)
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), defField.Type)
        }
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(defField.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
        )
        this.userStructFieldRefCache[key] = memberRef
        return memberRef
    }

    /// ADR-0087 §3 R3: returns the correct token for a field reference.
    /// For a non-generic type returns the bare `FieldDef`; for a
    /// user-declared generic type returns a `MemberRef` parented
    /// at the constructed (or self-) `TypeSpec`.
    internal func ResolveFieldToken(containingType StructSymbol, field FieldSymbol) EntityHandle {
        if ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType) {
            return this.GetUserStructFieldRef(containingType, field)
        }
        if !this.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle) && containingType.ClrType != nil {
            let importedField FieldInfo? = containingType.ClrType.GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            if importedField != nil {
                return this.memberRefs.GetFieldReference(importedField)
            }
        }
        if this.cache.StructFieldDefs.TryGetValue(field, out fieldHandle) {
            return fieldHandle
        }
        // Interface initializers are emitted before later aggregate FieldDefs.
        // Their source-declared fields can be referenced through the reserved
        // TypeDef without changing field-row order or visibility.
        if containingType.ClrType == nil && containingType.Fields.Contains(field) {
            let signature = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(signature).FieldSignature(), field.Type)
            return this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                this.ResolveUserTypeToken(containingType),
                this.emitCtx.Metadata.GetOrAddString(field.Name),
                this.emitCtx.Metadata.GetOrAddBlob(signature)
            )
        }
        throw InvalidOperationException(
            "Field '${containingType.Name}.${field.Name}' has no declared or emitted field token."
        )
    }

    /// ADR-0089 / issue #1030: returns the correct token for an interface
    /// static field reference. A non-generic interface uses the bare
    /// `FieldDef` row emitted on its TypeDef; a generic interface uses a
    /// `MemberRef` parented at the constructed (or self-) `TypeSpec`
    /// so each closed construction observes independent static storage.
    /// @param containingInterface The owning interface (definition or constructed).
    /// @param field The interface static field.
    /// @returns The field reference token.
    internal func ResolveInterfaceFieldToken(containingInterface InterfaceSymbol, field FieldSymbol) EntityHandle {
        if ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface) {
            return this.GetUserInterfaceFieldRef(containingInterface, field)
        }
        return this.cache.StructFieldDefs[field]
    }

    /// ADR-0089 / issue #1030: returns a `MemberRef` handle for a static
    /// field on a user-declared generic interface, parented at the
    /// `TypeSpec` for [`containingInterface`](paramref). Mirrors
    /// (cref:GetUserStructFieldRef). The field signature is encoded from
    /// the open definition's field type.
    /// @param containingInterface The constructed (or open) interface reference.
    /// @param fieldOnContaining The static field being referenced.
    /// @returns The MemberRef token parented at the interface TypeSpec.
    internal func GetUserInterfaceFieldRef(
        containingInterface InterfaceSymbol,
        fieldOnContaining FieldSymbol
    ) EntityHandle {
        let def = containingInterface.Definition ?? containingInterface
        let defField = def.GetStaticField(fieldOnContaining.Name) ?? fieldOnContaining
        let key = (containingInterface, defField, this.remaps.CurrentScope)
        if this.userInterfaceFieldRefCache.TryGetValue(key, out var cached) {
            return cached
        }
        let parent = this.GetUserInterfaceTypeSpec(containingInterface)
        let sigBlob = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), defField.Type)
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(defField.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
        )
        this.userInterfaceFieldRefCache[key] = memberRef
        return memberRef
    }

    /// ADR-0087 §3 R3: returns a `MemberRef` handle for an
    /// instance method or ctor on a user-declared generic type,
    /// parented at the `TypeSpec` for [`containingType`](paramref).
    /// The signature is supplied by the caller (already encoded against
    /// the open definition with `VAR` slots).
    internal func GetUserStructMethodRef(
        containingType StructSymbol,
        openMethodDef EntityHandle,
        methodName string,
        signature BlobBuilder
    ) EntityHandle {
        // A caller may encode the signature under containingType's registered
        // remap, then restore the ambient remap used here. containingType
        // determines that signature remap and is already part of the key.
        let key = (containingType, openMethodDef, this.remaps.CurrentScope)
        if this.userStructMethodRefCache.TryGetValue(key, out var cached) {
            return cached
        }
        let parent = this.GetUserStructTypeSpec(containingType)
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(methodName),
                signature: this.emitCtx.Metadata.GetOrAddBlob(signature)
            )
        )
        this.userStructMethodRefCache[key] = memberRef
        return memberRef
    }

    /// Issue #1465: encodes a function's emitted return type into a signature
    /// blob. For an `async` kickoff method the emitted return is the
    /// wrapped builder task type (`Task` / `Task<T>`), not the
    /// declared inner result type carried on (cref:FunctionSymbol.Type).
    /// MemberRef signatures built for calls into such a method on a generic
    /// receiver must match the emitted MethodDef, otherwise verification fails
    /// with a spurious `MissingMethod`.
    /// @param encoder The return-type encoder.
    /// @param fn The function whose emitted return type to encode.
    private func EncodeFunctionReturnSymbol(encoder ReturnTypeEncoder, fn FunctionSymbol) {
        if fn.IsAsyncOrSuspending && fn.StateMachineType != nil {
            for plan in this.outer.stateMachines.AsyncStateMachinePlans {
                if plan.KickoffMethod == fn {
                    this.outer.EncodeAsyncReturnType(encoder, plan)
                    return
                }
            }
        }
        if fn.IsInitOnlySetter {
            let isExternalInit = this.outer.wellKnown.GetIsExternalInitTypeRef()
            if !isExternalInit.IsNil {
                encoder.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
            }
        }
        this.signatures.EncodeReturnSymbol(encoder, fn.Type, fn.ReturnRefKind)
    }

    /// ADR-0087 §3 R3: encodes a method signature blob from a
    /// (cref:FunctionSymbol), using the OPEN definition's type
    /// information so `VAR(idx)` placeholders are produced for
    /// in-scope type-type parameters. Used to back the MemberRef
    /// signature returned by (cref:GetUserStructMethodRef).
    internal func EncodeOpenMethodSignature(openMethod FunctionSymbol) BlobBuilder {
        let sigBlob = BlobBuilder()
        // ADR-0174 D7: a reference to a suspending function must describe the
        // signature that was emitted — including its trailing `Context` — or
        // the runtime resolves nothing and the call fails with a
        // MissingMethodException at the first generic instantiation.
        let emittedParameters = openMethod.EmittedParameters
        let paramCount = emittedParameters.Length - (
            if openMethod.ExplicitReceiverParameter == nil {
                0
            } else {
                1
            }
        )
        BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: openMethod.IsInstanceMethod,
            genericParameterCount: if openMethod.TypeParameters.IsDefaultOrEmpty {
                0
            } else {
                openMethod.TypeParameters.Length
            }
        )
            .Parameters(
            paramCount,
            (r ReturnTypeEncoder) -> this.EncodeFunctionReturnSymbol(r, openMethod),
            (ps ParametersEncoder) -> {
                for p in emittedParameters {
                    if object.ReferenceEquals(p, openMethod.ThisParameter) {
                        continue
                    }
                    TypeDefEmitter.EncodeParameterSignature(
                        ps,
                        p,
                        this.signatures.EncodeTypeSymbol,
                        this.outer.wellKnown
                    )
                }
            }
        )
        return sigBlob
    }

    private func EncodeOpenStructMethodSignature(containingType StructSymbol, openMethod FunctionSymbol) BlobBuilder {
        // Nested generic definitions re-ordinalize enclosing and own type
        // parameters into one CLR VAR vector. Match the MethodDef encoding.
        {
            using let _ = this.remaps.PushSmRemap(containingType.Definition ?? containingType)
            return this.EncodeOpenMethodSignature(openMethod)
        }
    }

    /// ADR-0087 §3 R3: resolves the right token for a call to a user
    /// instance method. For a non-generic containing type returns the
    /// bare `MethodDef`; for a generic containing type returns a
    /// `MemberRef` parented at the constructed (or self-) `TypeSpec`.
    internal func ResolveUserInstanceMethodToken(containingType StructSymbol, method FunctionSymbol) EntityHandle {
        var method = method
        if containingType.Definition is {} definition && !object.ReferenceEquals(definition, containingType) &&
            containingType
            .IsData {
            if object.ReferenceEquals(method, containingType.DataEqualsSelf) {
                method = definition.DataEqualsSelf
            } else if object.ReferenceEquals(method, containingType.DataEqualsObject) {
                method = definition.DataEqualsObject
            } else if object.ReferenceEquals(method, containingType.DataEqualsBase) {
                method = Invariant.Required(
                    definition.DataEqualsBase,
                    "a constructed typed-base slot has a definition",
                    expression: "definition.DataEqualsBase"
                )
            } else if method.Name == DataPrintMembersModel.Name && object.ReferenceEquals(
                method,
                containingType.DataPrintMembers
            ) {
                method = Invariant.Required(
                    definition.DataPrintMembers,
                    "a constructed print-members slot has a definition",
                    expression: "definition.DataPrintMembers"
                )
            }
        }
        if !this.cache.MethodHandles.TryGetValue(method, out var openDef) && containingType.ClrType != nil {
            let importedMethod MethodInfo? = ReflectionMetadataEmitter.FindImportedMethod(
                containingType.ClrType,
                method,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            )
            if importedMethod != nil {
                return this.memberRefs.GetMethodReference(importedMethod)
            }
        }
        if !this.cache.MethodHandles.TryGetValue(method, out openDef) {
            throw InvalidOperationException("Instance method '${method.Name}' has no emitted handle.")
        }
        return this.ResolveUserInstanceMethodToken(containingType, method, openDef)
    }

    /// Resolves a user instance method token when the caller owns a separately
    /// planned MethodDef handle, such as a synthesized event accessor.
    /// @param containingType The method's declaring type.
    /// @param method The method symbol whose signature is encoded.
    /// @param openDef The open MethodDef handle.
    /// @returns The MethodDef or a MemberRef parented at the constructed type.
    internal func ResolveUserInstanceMethodToken(
        containingType StructSymbol,
        method FunctionSymbol,
        openDef MethodDefinitionHandle
    ) EntityHandle {
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType) {
            return openDef
        }
        return this.GetUserStructMethodRef(
            containingType,
            openDef,
            method.Name,
            this.EncodeOpenStructMethodSignature(containingType, method)
        )
    }

    /// Issue #1477: resolves the `ldftn` function token for a synthesized
    /// generic closure's `Invoke` method at the capture site. The parent
    /// `TypeSpec` must encode the CONSTRUCTED closure
    /// (`Closure`1<…enclosing args…>`) under the AMBIENT (capture-site)
    /// remap, but the MemberRef signature must encode the open `Invoke`
    /// parameters under the CLOSURE's OWN remap so enclosing-type-parameter
    /// references resolve to the closure's `VAR(idx)` slots (which is how
    /// the closure's MethodDef signature was emitted). For a non-generic closure
    /// the bare `MethodDef` is returned.
    /// @param constructedClosure The constructed closure reference.
    /// @param closureDef The open closure definition (for the sig remap).
    /// @param invoke The closure's `Invoke` method.
    /// @returns The function token suitable for `ldftn`.
    internal func ResolveClosureInvokeFtnToken(
        constructedClosure StructSymbol,
        closureDef StructSymbol,
        invoke FunctionSymbol
    ) EntityHandle {
        if !this.cache.MethodHandles.TryGetValue(invoke, out var openDef) {
            throw InvalidOperationException("Closure invoke method '${invoke.Name}' has no emitted handle.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure) {
            return openDef
        }
        var sig BlobBuilder
        {
            using let _ = this.remaps.PushSmRemap(closureDef)
            sig = this.EncodeOpenMethodSignature(invoke)
        }
        return this.GetUserStructMethodRef(constructedClosure, openDef, invoke.Name, sig)
    }

    /// Issue #1209: resolves the token for a call to a user `shared`
    /// (static) method whose declaring type is a constructed generic user type
    /// (`Box[int32].Make()`). A bare `MethodDef` token is invalid for a
    /// method of a generic type, so a `MemberRef` parented at the
    /// construction's `TypeSpec` is emitted (mirroring the static-field and
    /// static-property paths). The MemberRef signature is the open static method
    /// signature (no `this`) produced by (cref:EncodeOpenMethodSignature).
    internal func ResolveUserStaticMethodToken(containingType StructSymbol, method FunctionSymbol) EntityHandle {
        if !this
            .cache
            .MethodHandles
            .TryGetValue(method, out var openDef) &&
            !this
            .cache
            .FunctionHandles
            .TryGetValue(method, out openDef) {
            if containingType.ClrType != nil {
                let importedMethod MethodInfo? = ReflectionMetadataEmitter.FindImportedMethod(
                    containingType.ClrType,
                    method,
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                if importedMethod != nil {
                    return this.memberRefs.GetMethodReference(importedMethod)
                }
            }
            throw InvalidOperationException("Static method '${method.Name}' has no emitted handle.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType) {
            return openDef
        }
        return this.GetUserStructMethodRef(
            containingType,
            openDef,
            method.Name,
            this.EncodeOpenStructMethodSignature(containingType, method)
        )
    }

    /// Resolves a generic static accessor whose MethodDef is tracked outside the method caches.
    /// @param containingType The effective generic owner.
    /// @param method The accessor method symbol.
    /// @param openDef The accessor's emitted MethodDef.
    /// @returns The MethodDef or TypeSpec-parented MemberRef token.
    internal func ResolveUserStaticMethodToken(
        containingType StructSymbol,
        method FunctionSymbol,
        openDef EntityHandle
    ) EntityHandle {
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType) {
            return openDef
        }
        return this.GetUserStructMethodRef(
            containingType,
            openDef,
            method.Name,
            this.EncodeOpenStructMethodSignature(containingType, method)
        )
    }

    /// Issue #1433: resolves the token for a call to a user `shared`
    /// (static) method whose declaring type is a user-declared INTERFACE
    /// (`IThing.Create()` / `IBox[int32].Make()`). For a non-generic
    /// interface returns the bare `MethodDef`; for a constructed generic
    /// interface returns a `MemberRef` parented at the construction's
    /// `TypeSpec` (mirroring the interface static-field path, issue #1030).
    /// The substituted method on a constructed interface is mapped back to the
    /// open definition's slot so its emitted `MethodDef` handle and open
    /// (`VAR`-placeholdered) signature are used.
    /// @param containingInterface The constructed (or open) interface reference.
    /// @param method The static method being called.
    /// @returns The MethodDef or TypeSpec-parented MemberRef token.
    internal func ResolveUserInterfaceStaticMethodToken(
        containingInterface InterfaceSymbol,
        method FunctionSymbol
    ) EntityHandle {
        let openMethod = InterfaceImplEmitter.ResolveOpenInterfaceStaticMethod(containingInterface, method)
        if !this
            .cache
            .MethodHandles
            .TryGetValue(openMethod, out var openDef) &&
            !this
            .cache
            .FunctionHandles
            .TryGetValue(openMethod, out openDef) {
            throw InvalidOperationException("Static interface method '${method.Name}' has no emitted handle.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface) {
            return openDef
        }
        return this.GetUserInterfaceMethodRef(
            containingInterface,
            openDef,
            openMethod.Name,
            this.EncodeOpenMethodSignature(openMethod)
        )
    }

    /// Issue #1433: returns a `MemberRef` handle for a static method on a
    /// user-declared generic interface, parented at the `TypeSpec` for
    /// [`containingInterface`](paramref). Mirrors
    /// (cref:GetUserStructMethodRef); the signature is supplied by the
    /// caller (already encoded against the open definition with `VAR` slots).
    /// @param containingInterface The constructed (or open) interface reference.
    /// @param openMethodDef The open method's emitted MethodDef handle.
    /// @param methodName The method name.
    /// @param signature The open method signature blob.
    /// @returns The MemberRef token parented at the interface TypeSpec.
    internal func GetUserInterfaceMethodRef(
        containingInterface InterfaceSymbol,
        openMethodDef EntityHandle,
        methodName string,
        signature BlobBuilder
    ) EntityHandle {
        let key = UserInterfaceMethodRefKey(containingInterface, openMethodDef, this.remaps.CurrentScope)
        var cached EntityHandle
        if this.userInterfaceMethodRefCache.TryGetValue(key, out cached) {
            return cached
        }
        let parent = this.GetUserInterfaceTypeSpec(containingInterface)
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(methodName),
                signature: this.emitCtx.Metadata.GetOrAddBlob(signature)
            )
        )
        this.userInterfaceMethodRefCache[key] = memberRef
        return memberRef
    }

    /// Issue #989: resolves the right token for a call to a user property's
    /// get/set accessor. For a non-generic containing type returns the bare
    /// accessor `MethodDef`; for a constructed generic containing type
    /// returns a `MemberRef` parented at the constructed `TypeSpec`
    /// so a property whose type mentions a class type parameter (e.g.
    /// `prop Value T` on `Box[int32]`) is accessed with `T`
    /// substituted by the runtime. The MemberRef signature mirrors the open
    /// accessor MethodDef emitted by `MemberDefEmitter` (which encodes the
    /// property type with `VAR(idx)` placeholders).
    internal func ResolveUserPropertyAccessorToken(
        containingType StructSymbol,
        property PropertySymbol,
        wantSetter bool
    ) EntityHandle {
        // Property accessor MethodDef rows are planned against the OPEN
        // definition's property (the only type that is emitted), so map the
        // possibly-substituted constructed property back to the definition's
        // property by name before consulting PropertyAccessorHandles.
        let defType = containingType.Definition ?? containingType
        var defProp = property
        if !object.ReferenceEquals(defType, containingType) {
            defProp = MapToDefinitionProperty(
                if property.IsStatic {
                    containingType.StaticProperties
                } else {
                    containingType.Properties
                },
                if property.IsStatic {
                    defType.StaticProperties
                } else {
                    defType.Properties
                },
                property
            )
        }
        if !this.cache.PropertyAccessorHandles.TryGetValue(defProp, out var handles) {
            if containingType.ClrType != nil {
                let bindingFlags = (
                    if property.IsStatic {
                        BindingFlags.Static
                    } else {
                        BindingFlags.Instance
                    }
                ) | BindingFlags.Public | BindingFlags.NonPublic
                // ADR-0187: an overloaded indexer shares its `Item` name with
                // its siblings, so match the index-parameter list as well.
                let importedProperty = containingType
                    .ClrType
                    .GetProperties(bindingFlags)
                    .FirstOrDefault(
                    (candidate PropertyInfo) -> candidate.Name == defProp.Name &&
                        IndexParametersMatch(
                        candidate.GetIndexParameters(),
                        defProp.Parameters,
                        FlattenedTypeParameters(defType)
                    )
                )
                let importedAccessor MethodInfo? = if wantSetter {
                    importedProperty?.SetMethod
                } else {
                    importedProperty?.GetMethod
                }
                if importedAccessor != nil {
                    return this.memberRefs.GetMethodReference(importedAccessor)
                }
            }
            throw InvalidOperationException("Property '${property.Name}' has no emitted accessor handles.")
        }
        let accessor = if wantSetter {
            handles.Setter
        } else {
            handles.Getter
        }
        if !(accessor != nil) {
            throw InvalidOperationException(
                "Property '${property.Name}' has no emitted ${(if wantSetter { "setter" } else { "getter" })} MethodDef."
            )
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType) {
            return accessor
        }
        let accessorName = (
            if wantSetter {
                "set_"
            } else {
                "get_"
            }
        ) +
            defProp.Name
        return this.GetUserStructMethodRef(
            containingType,
            accessor,
            accessorName,
            this.EncodeOpenPropertyAccessorSignature(defProp, wantSetter)
        )
    }

    /// Resolves a user-interface property accessor against its effective
    /// interface construction. Generic interfaces use a TypeSpec-parented
    /// MemberRef so VAR slots in the open accessor signature are closed by
    /// the receiver construction.
    /// @param containingInterface Effective interface owner.
    /// @param property Property slot.
    /// @param wantSetter Whether to resolve the setter.
    /// @returns Accessor MethodDef or constructed MemberRef.
    internal func ResolveUserPropertyAccessorToken(
        containingInterface InterfaceSymbol,
        property PropertySymbol,
        wantSetter bool
    ) EntityHandle {
        let definition = containingInterface.Definition ?? containingInterface
        var definitionProperty = property
        if !object.ReferenceEquals(definition, containingInterface) {
            definitionProperty = MapToDefinitionProperty(
                containingInterface.Properties,
                definition.Properties,
                property
            )
        }
        if !this.cache.PropertyAccessorHandles.TryGetValue(definitionProperty, out var handles) {
            throw InvalidOperationException("Interface property '${property.Name}' has no emitted accessor handles.")
        }
        let accessor = if wantSetter {
            handles.Setter
        } else {
            handles.Getter
        }
        if !(accessor != nil) {
            throw InvalidOperationException(
                "Interface property '${property.Name}' has no emitted ${(if wantSetter { "setter" } else { "getter" })} MethodDef."
            )
        }
        if !ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface) {
            return accessor
        }
        let accessorName = (
            if wantSetter {
                "set_"
            } else {
                "get_"
            }
        ) +
            definitionProperty.Name
        return this.GetUserInterfaceMethodRef(
            containingInterface,
            accessor,
            accessorName,
            this.EncodeOpenPropertyAccessorSignature(definitionProperty, wantSetter)
        )
    }

    /// Issue #989: encodes the open accessor signature for a user property,
    /// matching the MethodDef shape emitted by `MemberDefEmitter`: a
    /// getter is `instance PropertyType get_Name(indexParams...)`; a setter
    /// is `instance void set_Name(indexParams..., PropertyType)`. The open
    /// definition's property type is used so type parameters encode as
    /// `VAR(idx)`, and an init-only setter retains its
    /// `modreq(IsExternalInit)` return modifier.
    private func EncodeOpenPropertyAccessorSignature(property PropertySymbol, wantSetter bool) BlobBuilder {
        let sigBlob = BlobBuilder()
        let indexParams = if property.Parameters.IsDefaultOrEmpty {
            ImmutableArray[ParameterSymbol].Empty
        } else {
            property.Parameters
        }
        // Issue #1209: a static (`shared`) property accessor on a generic user
        // type has no `this` — the MemberRef signature must NOT set HASTHIS, or
        // the runtime fails to bind the accessor (MissingMethodException).
        let isInstanceAccessor = !property.IsStatic
        if wantSetter {
            BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor).Parameters(
                indexParams.Length + 1,
                (r ReturnTypeEncoder) -> {
                    if property.IsInitOnly {
                        let isExternalInit = this.outer.wellKnown.GetIsExternalInitTypeRef()
                        if !isExternalInit.IsNil {
                            r.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
                        }
                    }
                    r.Void()
                },
                (ps ParametersEncoder) -> {
                    for p in indexParams {
                        this.signatures.EncodeTypeSymbol(
                            ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None),
                            p.Type
                        )
                    }
                    this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(), property.Type)
                }
            )
        } else {
            BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor).Parameters(
                indexParams.Length,
                (r ReturnTypeEncoder) -> this.signatures.EncodeReturnSymbol(r, property.Type, property.ReturnRefKind),
                (ps ParametersEncoder) -> {
                    for p in indexParams {
                        this.signatures.EncodeTypeSymbol(
                            ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None),
                            p.Type
                        )
                    }
                }
            )
        }
        return sigBlob
    }

    /// ADR-0091: returns a `TypeSpec` EntityHandle for a
    /// user-declared generic interface — analogue of
    /// (cref:GetUserStructTypeSpec) for (cref:InterfaceSymbol).
    internal func GetUserInterfaceTypeSpec(ifaceSym InterfaceSymbol) EntityHandle {
        let cacheKey = this.GetUserInterfaceRemapKey(ifaceSym)
        if this.userInterfaceTypeSpecCache.TryGetValue(cacheKey, out var cached) {
            return cached
        }
        let def = ifaceSym.Definition ?? ifaceSym
        if !this.cache.InterfaceTypeDefs.TryGetValue(def, out var defHandle) {
            throw InvalidOperationException(
                "User generic interface '${def.Name}' has no emitted TypeDef when constructing TypeSpec."
            )
        }
        var typeArgs ImmutableArray[TypeSymbol]
        if !ifaceSym.TypeArguments.IsDefaultOrEmpty {
            typeArgs = ifaceSym.TypeArguments
        } else {
            let defTps = def.TypeParameters
            let bld = ImmutableArray.CreateBuilder[TypeSymbol](defTps.Length)
            for tp in defTps {
                bld.Add(tp)
            }
            typeArgs = bld.MoveToImmutable()
        }
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).TypeSpecificationSignature()
        let gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: false)
        for arg in typeArgs {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg)
        }
        let spec = EntityHandle(
            this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        )
        this.userInterfaceTypeSpecCache[cacheKey] = spec
        return spec
    }

    /// ADR-0091: returns the right token for an instance call into a
    /// user-declared interface from a derived (implementing) type — used
    /// for the `base[IFoo].M(...)` explicit-base call. Returns the
    /// bare `MethodDef` for a non-generic interface, or a
    /// `MemberRef` parented at the constructed (or self-)
    /// `TypeSpec` for a generic interface.
    internal func ResolveUserInterfaceInstanceMethodToken(
        containingInterface InterfaceSymbol,
        openMethod FunctionSymbol
    ) EntityHandle {
        if !this.cache.MethodHandles.TryGetValue(openMethod, out var openDef) {
            throw InvalidOperationException(
                "Interface method '${openMethod.Name}' on '${containingInterface?.Name}' has no emitted handle."
            )
        }
        if !ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface) {
            return openDef
        }
        let key = UserInterfaceMethodRefKey(containingInterface, openDef, this.remaps.CurrentScope)
        var cached EntityHandle
        if this.userInterfaceMethodRefCache.TryGetValue(key, out cached) {
            return cached
        }
        let parent = this.GetUserInterfaceTypeSpec(containingInterface)
        let memberRef = EntityHandle(
            this
                .emitCtx
                .MetadataRows
                .AddMemberReference(
                parent: parent,
                name: this.emitCtx.Metadata.GetOrAddString(openMethod.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(this.EncodeOpenMethodSignature(openMethod))
            )
        )
        this.userInterfaceMethodRefCache[key] = memberRef
        return memberRef
    }

    /// Resolves the planned data-class clone on its effective generic owner.
    /// @param structType The receiver's constructed or self type.
    /// @returns The existing clone MethodDef or TypeSpec-parented MemberRef.
    internal func ResolveDataClassCloneToken(structType StructSymbol) EntityHandle {
        let definition = structType.Definition ?? structType
        if !this.cache.DataClassCloneHandles.TryGetValue(definition, out var clone) {
            throw InvalidOperationException("Data class '${structType.Name}' has no planned clone contract.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structType) {
            return clone
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> this.signatures.EncodeTypeSymbol(r.Type(), definition),
            (_ ParametersEncoder) -> { }
        )
        return this.GetUserStructMethodRef(structType, clone, "<Clone>$$", signature)
    }

    /// ADR-0087 §3 R3: resolves the right token for a `newobj`
    /// against a user-declared primary ctor. Returns the bare
    /// `MethodDef` for a non-generic type, or a MemberRef
    /// parented at the constructed `TypeSpec` for a generic type.
    internal func ResolveUserCtorTokenForPrimary(structType StructSymbol) EntityHandle {
        // Issue #1920: the primary ctor's MethodDef is keyed by the OPEN
        // definition (RegisterConstructedTypeAliases only mirrors it onto a
        // CONSTRUCTED StructSymbol when that exact instance is referenced
        // from a top-level function/lambda body — a construction inside a
        // class/struct instance or shared method never runs through that
        // collector). Look up via Definition first, matching the sibling
        // ResolveUserCtorTokenForDefault (issue #810) and
        // ResolveConstructedBaseParameterlessCtorToken (issue #1055).
        let ctorKey = structType.Definition ?? structType
        if !this.cache.ClassPrimaryCtorHandles.TryGetValue(ctorKey, out var primaryDef) {
            if ctorKey.HasDeclaredPrimaryConstructor && ctorKey.PrimaryConstructorParameters.IsEmpty {
                return this.ResolveUserCtorTokenForDefault(structType)
            }
            throw InvalidOperationException("Type '${structType.Name}' has no emitted primary ctor.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structType) {
            return primaryDef
        }
        let def = structType.Definition ?? structType
        let defParams = def.PrimaryConstructorParameters
        let sigBlob = BlobBuilder()
        {
            using let _ = this.remaps.PushSmRemap(def)
            BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
                defParams.Length,
                (r ReturnTypeEncoder) -> r.Void(),
                (ps ParametersEncoder) -> {
                    for p in defParams {
                        this.signatures.EncodeTypeSymbol(
                            ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None),
                            p.Type
                        )
                    }
                }
            )
        }
        return this.GetUserStructMethodRef(structType, primaryDef, ".ctor", sigBlob)
    }

    /// Issue #1254: resolves the base-constructor token for an explicit
    /// `: base(args)` initializer whose base is a CONSTRUCTED generic user
    /// class (e.g. `Derived : Base[int32]` chaining to `Base`'s
    /// primary or an explicit `init(...)` ctor). The base ctor's MethodDef
    /// is keyed by the open definition, so a bare token is invalid for a generic
    /// type; a MemberRef parented at the constructed base's TypeSpec is emitted
    /// with the open ctor's signature (type-parameter slots encode as VAR).
    internal func ResolveConstructedBaseExplicitCtorToken(
        constructedBase StructSymbol,
        ctor ConstructorSymbol?
    ) EntityHandle {
        if ctor == nil || !this.cache.ExplicitCtorHandles.TryGetValue(ctor, out var ctorDef) {
            return this.ResolveConstructedBaseParameterlessCtorToken(constructedBase)
        }
        let function = ctor.Function
        // The receiver `this` is not part of the encoded parameter list. It may
        // or may not appear in Function.Parameters, so count (and emit) only the
        // non-receiver parameters rather than assuming a fixed offset.
        var paramCount = 0
        for p in function.Parameters {
            if !object.ReferenceEquals(p, function.ThisParameter) {
                paramCount++
            }
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            paramCount,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for p in function.Parameters {
                    if object.ReferenceEquals(p, function.ThisParameter) {
                        continue
                    }
                    this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type)
                }
            }
        )
        return this.GetUserStructMethodRef(constructedBase, ctorDef, ".ctor", sigBlob)
    }

    /// Issue #1055: resolves the parameter-less base constructor token for a
    /// class whose base is a CONSTRUCTED generic user class (e.g.
    /// `Derived : Base[int32]`). The base ctor's MethodDef is keyed by the
    /// open definition, so the token is emitted as a MemberRef parented at the
    /// constructed base's TypeSpec via (cref:GetUserStructMethodRef) so
    /// the chained `call` targets the correct instantiated base subobject
    /// and the assembly verifies.
    internal func ResolveConstructedBaseParameterlessCtorToken(constructedBase StructSymbol) EntityHandle {
        let def = constructedBase.Definition ?? constructedBase
        if this.cache.ClassPrimaryCtorHandles.ContainsKey(def) {
            return this.ResolveUserCtorTokenForPrimary(constructedBase)
        }
        if this.cache.ClassCtorHandles.TryGetValue(def, out var defaultDef) {
            let defaultSig = BlobBuilder()
            BlobEncoder(defaultSig).MethodSignature(isInstanceMethod: true).Parameters(
                0,
                (r ReturnTypeEncoder) -> r.Void(),
                (_ ParametersEncoder) -> { }
            )
            return this.GetUserStructMethodRef(constructedBase, defaultDef, ".ctor", defaultSig)
        }
        return this.outer.wellKnown.ObjectCtorRef
    }

    /// ADR-0087 §3 R3: resolves the right token for a `newobj`
    /// against a user-declared default (parameter-less) ctor.
    internal func ResolveUserCtorTokenForDefault(structType StructSymbol) EntityHandle {
        // Issue #810: the kickoff body may pass a CONSTRUCTED StructSymbol
        // (e.g. `<Empty>d__1<MVar(0)>`); the ctor's MethodDef is keyed by
        // the OPEN definition, so look up via Definition when present.
        let ctorKey = structType.Definition ?? structType
        if !this.cache.ClassCtorHandles.TryGetValue(ctorKey, out var defaultDef) {
            throw InvalidOperationException("Type '${structType.Name}' has no emitted default ctor.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structType) {
            return defaultDef
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            ctorKey.LiteralInitializerMarkerCount,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for var marker = 0; marker < ctorKey.LiteralInitializerMarkerCount; marker++ {
                    this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(), TypeSymbol.Bool)
                }
            }
        )
        return this.GetUserStructMethodRef(structType, defaultDef, ".ctor", sigBlob)
    }

    /// ADR-0087 §3 R3: resolves the right token for a `newobj`
    /// against a user-declared explicit (`init(...)`) ctor
    /// (ADR-0063 §9).
    internal func ResolveUserCtorTokenForExplicit(structType StructSymbol, ctor ConstructorSymbol) EntityHandle {
        if !this.cache.ExplicitCtorHandles.TryGetValue(ctor, out var explicitDef) {
            throw InvalidOperationException("Constructor on '${ctor?.DeclaringType?.Name}' has no emitted handle.")
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structType) {
            return explicitDef
        }
        let sigBlob = BlobBuilder()
        // Match the constructor's MethodDef slots, not the caller's generic
        // context, just as the primary-constructor token path does (#4803).
        {
            using let _ = this.remaps.PushSmRemap(structType.Definition ?? structType)
            BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
                ctor.Parameters.Length,
                (r ReturnTypeEncoder) -> r.Void(),
                (ps ParametersEncoder) -> {
                    for p in ctor.Parameters {
                        this.signatures.EncodeTypeSymbol(
                            ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None),
                            p.Type
                        )
                    }
                }
            )
        }
        return this.GetUserStructMethodRef(structType, explicitDef, ".ctor", sigBlob)
    }

    /// ADR-0087 §3 R3: resolves the right token for a type operation
    /// (`isinst`, `unbox`, `unbox.any`, `initobj`,
    /// `castclass`) against a user-declared type. Returns the
    /// bare `TypeDef` for a non-generic type, or a `TypeSpec`
    /// for a generic type.
    internal func ResolveUserTypeToken(structType StructSymbol) EntityHandle {
        if ReflectionMetadataEmitter.IsUserGenericTypeReference(structType) {
            return this.GetUserStructTypeSpec(structType)
        }
        if structType.ClrType != nil {
            return this.memberRefs.GetElementTypeToken(structType)
        }
        return this.cache.StructTypeDefs[structType]
    }

    /// Issue #774: when emitting a property read on a symbolic open-generic
    /// receiver (e.g. `IEnumerator[T].Current` or
    /// `KeyValuePair[K, V].Key`), the runtime stack value after the
    /// symbolic getter MemberRef call is the substituted symbolic type, not
    /// the closed CLR `object` that the type-erased getter declares.
    /// Returning that symbolic type to the body emitter lets the widening
    /// short-circuit, avoiding a verifier-breaking `unbox.any` on a
    /// value-type `T`.
    /// @param receiverType The receiver's type as seen by the body emitter.
    /// @param property The closed-CLR property selected by the lowerer.
    /// @param substitutedReturn The substituted symbolic return type, on success.
    /// @returns `true` when the receiver is a symbolic
    /// open-generic container and the substituted return differs from the
    /// closed CLR `object` shape.
    @NullabilityFunnel
    internal func TryGetSymbolicSubstitutedPropertyReturn(
        receiverType TypeSymbol,
        property PropertyInfo?,
        @NotNullWhen(true) out substitutedReturn TypeSymbol?
    ) bool {
        substitutedReturn = nil
        if property == nil || !ImportedMemberRefFactory.TryNormalizeToSymbolicContainer(
            receiverType,
            out var openDef,
            out var typeArguments
        ) ||
            typeArguments.IsDefaultOrEmpty {
            return false
        }
        // Issue #3311: mirror the symbolic-container MemberRef bail
        // (ImportedMemberRefFactory line "#774 non-generic base"): a member
        // declared on a non-generic type is emitted through the PLAIN
        // MemberRef path (closed semantics), so the erasure-widening must
        // stay in force for it.
        let propDecl Type? = property.DeclaringType
        if propDecl != nil && !propDecl.IsGenericType && propDecl != openDef {
            return false
        }
        let openProp PropertyInfo? = ImportedMemberRefFactory.ResolvePropertyOnOpenDefinition(openDef, property)
        if openProp == nil {
            return false
        }
        // ADR-0193 Phase 2: [NullabilityFunnel] on purpose. This is the IL
        // stack type of the symbolic-container MemberRef, which decides only
        // the erasure widening; IL carries no reference nullability.
        substitutedReturn = MemberLookup.MapOpenClrTypeToSymbolic(
            ClrNullability.GetSignatureType(openProp),
            openDef,
            typeArguments
        )
        if substitutedReturn == nil || substitutedReturn == TypeSymbol.Error {
            return false
        }
        // The symbolic-container MemberRef fires for ANY non-empty argument
        // vector, so the runtime stack holds the SUBSTITUTED member type
        // whenever it differs from the closed (possibly erased) CLR shape:
        // a symbolic argument (in-scope type parameter / same-compilation
        // user type — the original #774 case), or (issue #3311) a CONCRETE
        // argument recovered through an erased closed receiver — e.g. the
        // `IEnumerator[int32]` enumerator of `Dictionary[int32, V].Keys`,
        // whose closed `Current` reports `object` while the emitted
        // MemberRef returns `!0` = int32. In both shapes the widening must
        // be skipped; when the substituted and closed CLR types agree the
        // widening is a no-op either way, so returning false there keeps
        // the historical IL byte-identical.
        return typeArguments.Any(TypeSymbol.RequiresSymbolicProjection) ||
            (
            substitutedReturn.ClrType is {} substitutedClr && !ClrTypeUtilities.AreSame(
                substitutedClr,
                property.PropertyType
            )
        )
    }

    /// Issue #832 (mirrors the property variant above for instance method calls):
    /// when an instance method call's receiver is a symbolic open-generic
    /// container (e.g. `Queue[T]` with an in-scope `T`), the call's
    /// MemberRef parent is encoded as the symbolic generic instantiation, so
    /// the runtime stack value after `callvirt` is the substituted
    /// symbolic return type (`!T`) — NOT the closed CLR `object`
    /// that (cref:MethodInfo.ReturnType) reports for the type-erased
    /// closed method. Returning that substituted return to the body emitter
    /// lets the erasure-widening short-circuit, avoiding a verifier-breaking
    /// (and runtime-crashing) `unbox.any T` when the result is discarded
    /// or otherwise consumed at the open-T slot.
    /// @param receiverType The receiver's type as seen by the body emitter.
    /// @param method The closed-CLR method selected by the lowerer.
    /// @param substitutedReturn The substituted symbolic return type, on success.
    /// @returns `true` when the receiver is a symbolic
    /// open-generic container and the substituted return resolves to a
    /// non-error symbolic type.
    @NullabilityFunnel
    internal func TryGetSymbolicSubstitutedInstanceMethodReturn(
        receiverType TypeSymbol,
        method MethodInfo?,
        @NotNullWhen(true) out substitutedReturn TypeSymbol?
    ) bool {
        substitutedReturn = nil
        if method == nil || !ImportedMemberRefFactory.TryNormalizeToSymbolicContainer(
            receiverType,
            out var openDef,
            out var typeArguments
        ) ||
            typeArguments.IsDefaultOrEmpty {
            return false
        }
        // Issue #3311: mirror the symbolic-container MemberRef bail — a
        // method declared on a non-generic type goes through the PLAIN
        // MemberRef path (closed semantics), so the erasure-widening must
        // stay in force for it. See the property variant above.
        let methodDecl Type? = method.DeclaringType
        if methodDecl != nil && !methodDecl.IsGenericType && methodDecl != openDef {
            return false
        }
        let openMethod MethodInfo? = ImportedMemberRefFactory.ResolveMethodOnOpenDefinition(openDef, method)
        if openMethod == nil {
            return false
        }
        let openReturn Type? = ClrNullability.GetSignatureType(openMethod.ReturnParameter)
        if openReturn == nil || openReturn.IsSameAs(typeof(Void)) {
            return false
        }
        // ADR-0193 Phase 2: [NullabilityFunnel] on purpose; see the property
        // variant above.
        substitutedReturn = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, openDef, typeArguments)
        if substitutedReturn == nil || substitutedReturn == TypeSymbol.Error {
            return false
        }
        // Issue #3311: also fire for a CONCRETE argument recovered through an
        // erased closed receiver (mixed instantiations such as
        // `Dictionary[int32, V]`); see the property variant above for the
        // rationale.
        return typeArguments.Any(TypeSymbol.RequiresSymbolicProjection) ||
            (
            substitutedReturn.ClrType is {} substitutedClr && !ClrTypeUtilities.AreSame(
                substitutedClr,
                method.ReturnType
            )
        )
    }

    /// Issue #903: when a generic imported (extension) call — e.g. a LINQ
    /// `Single`/`First`/`Last` whose open return type is a bare
    /// method type parameter `TSource` — is closed over a
    /// same-compilation user element type (`List[Check].Single(…)` where
    /// `Check` is a (cref:StructSymbol) struct/class still being
    /// compiled), (cref:ImportedMemberRefFactory.GetMethodEntityHandle(MethodInfo,
    /// ImmutableArray{TypeSymbol}))
    /// encodes a MethodSpec whose type argument is the symbolic `Check`
    /// (via (cref:ReflectionMetadataEmitter.ArgIsSymbolicUserDefined)). The emitted call therefore
    /// returns the reprojected element type directly on the stack — a raw
    /// `Check` value for a struct, a `Check` reference for a class —
    /// NOT the type-erased `object` that the placeholder-closed
    /// (cref:MethodInfo.ReturnType) reports.
    ///
    /// Without this guard the body emitter would feed that erased
    /// `object` placeholder into `EmitErasedObjectReturnWidening`,
    /// which for a value-type element emits a spurious `unbox.any Check`
    /// against a stack slot that already holds a `Check` value (ilverify
    /// `StackUnexpected`/`StackObjRef` and a runtime crash), and for
    /// a reference-type element emits a redundant `castclass`. Returning
    /// the substituted symbolic return lets the caller short-circuit the
    /// widening, exactly as the instance-method and property variants above do
    /// for symbolic open-generic containers.
    /// @param method The placeholder-closed generic method selected by overload resolution.
    /// @param typeArgSymbols The per-MVar symbolic type arguments carried by the bound call (issue #903
    /// surfaces same-compilation user types here).
    /// @param substitutedReturn The reprojected symbolic return type, on success.
    /// @returns `true` when the call's symbolic type arguments
    /// reproject the open return type to a same-compilation user type or an
    /// in-scope generic type parameter (issue #1445), so the erasure-widening
    /// must be skipped.
    @NullabilityFunnel
    internal func TryGetSymbolicSubstitutedImportedCallReturn(
        method MethodInfo?,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        @NotNullWhen(true) out substitutedReturn TypeSymbol?
    ) bool {
        substitutedReturn = nil
        if method == nil || !method.IsGenericMethod || typeArgSymbols.IsDefaultOrEmpty || !typeArgSymbols.Any(
            ReflectionMetadataEmitter.ArgIsSymbolicUserDefined
        ) {
            return false
        }
        let openMethod = if method.IsGenericMethodDefinition {
            method
        } else {
            method.GetGenericMethodDefinition()
        }
        let openReturn Type? = ClrNullability.GetSignatureType(openMethod.ReturnParameter)
        if openReturn == nil || openReturn.IsSameAs(typeof(Void)) {
            return false
        }
        // Map the open return signature through the symbolic method type
        // arguments only (no receiver/type-level substitution): a bare
        // `TSource` return resolves to the symbolic element type, while a
        // constructed `IEnumerable<TResult>` return resolves to a symbolic
        // instantiation. Either way, a projection that surfaces a
        // same-compilation user type OR an in-scope generic type parameter
        // means the MethodSpec deviates from the erased `object` placeholder
        // and the widening must be suppressed.
        // ADR-0193 Phase 2: [NullabilityFunnel] on purpose; an IL stack shape,
        // as in the instance variant above.
        let mapped TypeSymbol? = MemberLookup.MapOpenClrTypeToSymbolic(
            openReturn,
            nil,
            default(ImmutableArray[TypeSymbol]),
            openMethod,
            typeArgSymbols
        )
        if mapped == nil || mapped == TypeSymbol.Error {
            return false
        }
        // Issue #1445: a LINQ-style call whose open return is a bare method
        // type parameter (`First<TSource>() -> TSource`) closed over an
        // in-scope generic type parameter `T` (e.g. inside
        // `func Pick[T IThing](items IEnumerable[T]) T?`) encodes a symbolic
        // MethodSpec `First<!!T>` (ArgIsSymbolicUserDefined accepts the type
        // parameter, #833), so the call leaves a `!!T` value directly on the
        // stack — NOT the erased `object` the placeholder-closed
        // `MethodInfo.ReturnType` reports. Feeding that placeholder into the
        // erasure-widening emitted a spurious `unbox.any !!T` against a stack
        // slot that already holds `!!T` (ilverify `StackObjRef`; unverifiable
        // IL that crashes under stricter hosts). Suppress the widening for a
        // type-parameter projection too, mirroring the same-compilation
        // user-type case and the instance-method variant above.
        if !TypeSymbol.ContainsSameCompilationUserType(mapped) && !TypeSymbol.ContainsTypeParameter(mapped) {
            return false
        }
        substitutedReturn = mapped
        return true
    }

    // Issue #1502: a GSharp function type must be materialised as a CLR
    // delegate (Func/Action) through the SYMBOLIC TypeSpec path
    // (EncodeFunctionTypeSymbol / GetFunctionDelegateCtorRef) — rather than
    // the reflection path (ResolveDelegateClrType) — whenever any of its
    // parameter/return types is a type parameter OR a source-defined
    // user type (Struct/Class/Interface/Enum/Delegate), possibly nested
    // (e.g. `List[UserClass]`, `Func<UserStruct>`, `UserClass[]`). The
    // reflection path resolves such an argument through
    // MapToReferenceClrType, which returns null for a type emitted in the
    // current compilation (no MetadataLoadContext Type) and therefore
    // erases the argument to System.Object — producing an unverifiable
    // `Func<object>` where `Func<UserType>` is required.
    internal func FunctionTypeNeedsSymbolicDelegate(fnType FunctionTypeSymbol?) bool {
        if fnType == nil {
            return false
        }
        for param in fnType.ParameterTypes {
            if TypeSymbol.ContainsTypeParameter(param) || ReflectionMetadataEmitter.ArgIsSymbolicUserDefined(param) {
                return true
            }
        }
        return TypeSymbol.ContainsTypeParameter(fnType.ReturnType) ||
            ReflectionMetadataEmitter.ArgIsSymbolicUserDefined(fnType.ReturnType)
    }

    private data struct UserInterfaceMethodRefKey(
        Containing InterfaceSymbol,
        OpenMember EntityHandle,
        Scope RemapScope
    ) : IEquatable[UserInterfaceMethodRefKey] { }

    shared {
        private func InferMethodTypeArgument(
            fn FunctionSymbol,
            args ImmutableArray[BoundExpression],
            substitutedReturn TypeSymbol,
            tp TypeParameterSymbol
        ) TypeSymbol {
            return InferMethodTypeArgument(fn.Parameters, args, substitutedReturn, fn.Type, tp)
        }

        private func InferMethodTypeArgument(
            formalParams ImmutableArray[ParameterSymbol],
            actualArgs ImmutableArray[BoundExpression],
            substitutedReturn TypeSymbol?,
            formalReturn TypeSymbol?,
            tp TypeParameterSymbol
        ) TypeSymbol {
            // ADR-0087 §3 R3+R4: structural unification across the formal/
            // actual parameter shapes finds the substituted type for `tp`.
            // Covers `Id[T](x T) T`, `Pair[A,B](first A, second B)`,
            // `Echo[T](s []T) []T`, `Wrap[T](b Box[T])`, etc. Recursive
            // higher-kinded unification (e.g. `MakeList[T]() List[T]`) is
            // R5 territory and stays out of scope here.
            for var i = 0; i < formalParams.Length && i < actualArgs.Length; i++ {
                // The binder may insert a `BoundConversionExpression` widening
                // the actual to the (erased) formal type — that conversion's
                // `.Type` is the formal type, which would defeat unification.
                // Peel off the conversion to see the underlying expression's
                // pre-widening type. (We still pass the formal as-is.)
                let actualType = StripConversion(actualArgs[i]).Type
                if TryUnify(formalParams[i].Type, actualType, tp, out var inferred) {
                    return inferred
                }
            }
            if formalReturn != nil &&
                substitutedReturn != nil &&
                TryUnify(formalReturn, substitutedReturn, tp, out var fromReturn) {
                return fromReturn!!
            }
            // Issue #1431 (secondary): reaching here means no parameter, return,
            // or function-type shape mentioned `tp` after the structural unifier
            // (now including the `FunctionTypeSymbol` parameter/return branch) was
            // exhausted. For a well-formed program the binder has already either
            // inferred or rejected the call's type arguments during binding
            // (GS0151 covers the user-facing "cannot infer … supply it explicitly"
            // case), so any failure that propagates this far is a genuine internal
            // invariant violation, not user error. This emit-phase code has no
            // DiagnosticBag in scope and surfacing a clean diagnostic here would
            // require threading binder diagnostics through the metadata emitter —
            // a large architectural change for an otherwise unreachable path. The
            // throw therefore remains a defensive ICE guard (surfaced as GS9998)
            // rather than a regression risk; the primary fix above ensures it no
            // longer fires for the inferable native-function-type cases.
            throw InvalidOperationException(
                "Cannot infer type argument for '${tp.Name}'; " +
                    "the type parameter does not appear in any parameter or return shape."
            )
        }

        private func StripConversion(expr BoundExpression) BoundExpression {
            var expr = expr
            while expr is BoundConversionExpression conv {
                expr = conv.Expression
            }
            return expr
        }

        private func TryUnify(
            formal TypeSymbol,
            actual TypeSymbol,
            tp TypeParameterSymbol,
            @NotNullWhen(true) out inferred TypeSymbol?
        ) bool {
            // Issue #1570: a `ref`/`out`/`in` parameter whose declared type mentions
            // the method (or containing) type parameter arrives here with a byref
            // formal and/or a byref actual (the argument expression's type for an
            // `out`/`ref` argument is a managed pointer `T&`). A generic type
            // argument can never itself be a byref, so peel the `T&` wrapper off
            // both sides and unify the pointee types. Without this the inferred type
            // argument for `TryMake[T](out result T)` becomes `T&`, which the
            // MethodSpec encoder then rejects with "Cannot encode '*T' as a
            // non-byref signature slot" (GS9998). Stripping the pointee also lets
            // constructed byref actuals such as `out List[T]` reach the generic-
            // instantiation unification branches below.
            if formal is ByRefTypeSymbol formalByRef {
                return TryUnify(formalByRef.PointeeType, actual, tp, out inferred)
            }
            if actual is ByRefTypeSymbol actualByRef {
                return TryUnify(formal, actualByRef.PointeeType, tp, out inferred)
            }
            if object.ReferenceEquals(formal, tp) {
                inferred = actual
                return true
            }
            // Issue #1931: a `T?` formal (NullableTypeSymbol wrapping the type
            // parameter, e.g. `Show[T](value T?)` under `where T : default`)
            // arrives here unpeeled. Unify against the underlying `T`, peeling a
            // matching `T?` actual too if present, so a plain non-nullable actual
            // (`shower.Show("x")`) still infers `T = string` at emit time — the
            // binder already accepts this per the InferTypeArguments fix; this
            // mirrors that unwrap for MethodSpec inference.
            if formal is NullableTypeSymbol fn {
                let actualUnwrapped = if actual is NullableTypeSymbol an {
                    an.UnderlyingType
                } else {
                    actual
                }
                return TryUnify(fn.UnderlyingType, actualUnwrapped, tp, out inferred)
            }
            if formal is SliceTypeSymbol fs && actual is SliceTypeSymbol asl {
                return TryUnify(fs.ElementType, asl.ElementType, tp, out inferred)
            }
            if formal is ArrayTypeSymbol fa && actual is ArrayTypeSymbol aa {
                return TryUnify(fa.ElementType, aa.ElementType, tp, out inferred)
            }
            if formal is RectangularArrayTypeSymbol fr &&
                actual is RectangularArrayTypeSymbol ar &&
                fr.Rank == ar.Rank {
                return TryUnify(fr.ElementType, ar.ElementType, tp, out inferred)
            }
            // Issue #810: unify open-generic iterator returns of
            // `sequence[T]` / `async sequence[T]` against their substituted
            // counterparts so the MethodSpec for a call like
            // `Sequences.Empty[int32]()` can be built when no parameters
            // mention `T`.
            if formal is SequenceTypeSymbol fseq && actual is SequenceTypeSymbol aseq {
                return TryUnify(fseq.ElementType, aseq.ElementType, tp, out inferred)
            }
            // Issue #814 / ADR-0084 §L5: an extension method's open
            // `sequence[T]` receiver may have a call-site actual that is a
            // slice (`[]T`), a fixed-length array (`[N]T`), or any CLR
            // generic type implementing `IEnumerable<T>`. The binder
            // inserts a `BoundConversionExpression` widening to
            // `sequence[T]`, but `StripConversion` peels it off so emit
            // sees the pre-widening type. Without these branches the
            // method-spec inference falls through and throws
            // "Cannot infer type argument for 'T'" for the
            // `arr.FirstOrNil()` / `arr.LastOrNil()` / `arr.SingleOrNil()`
            // class/struct overload pair.
            if formal is SequenceTypeSymbol fseqAny {
                if actual is SliceTypeSymbol aSliceEnum {
                    return TryUnify(fseqAny.ElementType, aSliceEnum.ElementType, tp, out inferred)
                }
                if actual is ArrayTypeSymbol aArrEnum {
                    return TryUnify(fseqAny.ElementType, aArrEnum.ElementType, tp, out inferred)
                }
                if actual?.ClrType is {} actualClrSeq {
                    let openIEnumerable = typeof(System.Collections.Generic.IEnumerable[_])
                    var matched Type? = nil
                    if actualClrSeq.IsArray {
                        let elt Type? = actualClrSeq.GetElementType()
                        if elt != nil {
                            matched = openIEnumerable.MakeGenericType(elt)
                        }
                    } else if actualClrSeq.IsGenericType && actualClrSeq.GetGenericTypeDefinition() == openIEnumerable {
                        matched = actualClrSeq
                    } else {
                        for iface in actualClrSeq.GetInterfaces() {
                            if iface.IsGenericType && iface.GetGenericTypeDefinition() == openIEnumerable {
                                matched = iface
                                break
                            }
                        }
                    }
                    if matched != nil {
                        let elementSym = TypeSymbol.FromClrTypeWithoutNullability(
                            matched.GetGenericArguments()[0],
                            NullabilityFreeReason.TypeStructure
                        )
                        if TryUnify(fseqAny.ElementType, elementSym, tp, out inferred) {
                            return true
                        }
                    }
                }
            }
            if formal is AsyncSequenceTypeSymbol faseq && actual is AsyncSequenceTypeSymbol aaseq {
                return TryUnify(faseq.ElementType, aaseq.ElementType, tp, out inferred)
            }
            // Issue #814: mirror of the synchronous sequence-vs-enumerable
            // unification above for `async sequence[T]` receivers against
            // any CLR generic implementing `IAsyncEnumerable<T>`.
            if formal is AsyncSequenceTypeSymbol faseqAny && actual?.ClrType is {} actualClrAseq {
                let openIAsync = typeof(System.Collections.Generic.IAsyncEnumerable[_])
                var matched Type? = nil
                if actualClrAseq.IsGenericType && actualClrAseq.GetGenericTypeDefinition() == openIAsync {
                    matched = actualClrAseq
                } else {
                    for iface in actualClrAseq.GetInterfaces() {
                        if iface.IsGenericType && iface.GetGenericTypeDefinition() == openIAsync {
                            matched = iface
                            break
                        }
                    }
                }
                if matched != nil {
                    let elementSym = TypeSymbol.FromClrTypeWithoutNullability(
                        matched.GetGenericArguments()[0],
                        NullabilityFreeReason.TypeStructure
                    )
                    if TryUnify(faseqAny.ElementType, elementSym, tp, out inferred) {
                        return true
                    }
                }
            }
            if formal is NullableTypeSymbol fnu && actual is NullableTypeSymbol anu {
                return TryUnify(fnu.UnderlyingType, anu.UnderlyingType, tp, out inferred)
            }
            // Issue #813: unify value-tuple element types so the MethodSpec
            // for an iterator-returning call like
            // `Sequences.Indexed[int32](source)` resolves `T` from the
            // formal return shape `sequence[(int32, T)]` against the
            // substituted `sequence[(int32, int32)]`. Without this branch
            // the recursive sequence unification above would only see the
            // tuple wrapper and fail to descend into its element types.
            // The actual side may arrive either as a TupleTypeSymbol (when
            // the binder's SubstituteType produced one) or as an
            // ImportedTypeSymbol whose ClrType is a closed `ValueTuple<…>`
            // (when SubstituteType lifted it back through
            // TypeSymbol.FromClrType on the closed CLR shape).
            if formal is TupleTypeSymbol ftup {
                var actualElements = default(ImmutableArray[TypeSymbol])
                if actual is TupleTypeSymbol atup && ftup.ElementTypes.Length == atup.ElementTypes.Length {
                    actualElements = atup.ElementTypes
                } else if actual?.ClrType is {} actualClr &&
                    actualClr.IsGenericType &&
                    IsValueTupleOpenDefinition(actualClr.GetGenericTypeDefinition()) &&
                    actualClr
                    .GenericTypeArguments
                    .Length == ftup
                    .ElementTypes
                    .Length {
                    let b = ImmutableArray.CreateBuilder[TypeSymbol](actualClr.GenericTypeArguments.Length)
                    for arg in actualClr.GenericTypeArguments {
                        b.Add(TypeSymbol.FromClrTypeWithoutNullability(arg, NullabilityFreeReason.TypeStructure))
                    }
                    actualElements = b.MoveToImmutable()
                }
                if !actualElements.IsDefault {
                    for var i = 0; i < ftup.ElementTypes.Length; i++ {
                        if TryUnify(ftup.ElementTypes[i], actualElements[i], tp, out inferred) {
                            return true
                        }
                    }
                }
            }
            // Issue #821: when the formal is a constructed CLR generic
            // interface that the actual's backing array satisfies — e.g.
            // `IEnumerable[T]` / `IList[T]` / `ICollection[T]` /
            // `IReadOnlyList[T]` (any interface implemented by `T[]`) — and
            // the actual is a `[]T` slice or `[N]T` fixed-length array,
            // bridge their generic arguments by locating the matching
            // interface instantiation on the actual's backing CLR `T[]` and
            // recursing into the element-type slot. Mirrors the binder's
            // slice-to-interface classifier (#570) and the
            // `sequence[T]`-vs-slice/array arm above (#774/#814) at the
            // static-method / free-function argument-slot inference path so
            // generic-method-spec construction can recover `T` from a
            // slice argument when the type parameter only appears in an
            // interface-typed formal parameter (no `T` in the return).
            if formal is ImportedTypeSymbol formalImported &&
                formalImported.ClrType is {IsInterface: true, IsGenericType: true} formalIface &&
                !formalImported
                .TypeArguments
                .IsDefaultOrEmpty &&
                (actual is SliceTypeSymbol || actual is ArrayTypeSymbol) &&
                actual?.ClrType is {IsArray: true} actualClrArray {
                var matched Type? = nil
                for iface in actualClrArray.GetInterfaces() {
                    if iface.IsGenericType && ClrTypeUtilities.AreSame(
                        iface.GetGenericTypeDefinition(),
                        formalIface.GetGenericTypeDefinition()
                    ) {
                        matched = iface
                        break
                    }
                }
                if matched != nil {
                    let matchedArgs = matched.GetGenericArguments()
                    if formalImported.TypeArguments.Length == matchedArgs.Length {
                        for var i = 0; i < formalImported.TypeArguments.Length; i++ {
                            if TryUnify(
                                formalImported.TypeArguments[i],
                                TypeSymbol.FromClrTypeWithoutNullability(
                                    matchedArgs[i],
                                    NullabilityFreeReason.TypeStructure
                                ),
                                tp,
                                out inferred
                            ) {
                                return true
                            }
                        }
                    }
                }
            }
            // Issue #1431: unify native G# function types `(T1, ...) -> R` so a
            // type parameter that appears ONLY in a function-type parameter or
            // return slot can be recovered when building the MethodSpec. The CLR
            // delegate form (`Func[...]` / `Action[...]`) already flows through
            // the generic-arguments fallback below because it is an
            // `ImportedTypeSymbol`; a `FunctionTypeSymbol` has no GS-side type
            // arguments (its slots live only on `ParameterTypes`/`ReturnType`)
            // so it must be unified structurally here. Both sides may arrive as a
            // native `FunctionTypeSymbol` OR as a `Func`/`Action`-shaped CLR
            // delegate after binder substitution, so the shape is normalised to a
            // flat slot list (parameter types followed by the return type unless
            // void) and unified slot-by-slot. This bridges the cross-shape case
            // where a native formal faces a `Func[...]`-shaped actual (or vice
            // versa).
            if (formal is FunctionTypeSymbol || actual is FunctionTypeSymbol) &&
                TryGetFunctionShapeSlots(formal, out var formalFnSlots) &&
                TryGetFunctionShapeSlots(actual, out var actualFnSlots) &&
                formalFnSlots.Length == actualFnSlots
                .Length {
                for var i = 0; i < formalFnSlots.Length; i++ {
                    if TryUnify(formalFnSlots[i], actualFnSlots[i], tp, out inferred) {
                        return true
                    }
                }
            }
            let formalArgs = GetGenericTypeArguments(formal)
            let actualArgs = GetGenericTypeArguments(actual)
            if !formalArgs.IsDefaultOrEmpty && !actualArgs.IsDefaultOrEmpty && formalArgs.Length == actualArgs.Length {
                for var i = 0; i < formalArgs.Length; i++ {
                    if TryUnify(formalArgs[i], actualArgs[i], tp, out inferred) {
                        return true
                    }
                }
            }
            inferred = nil
            return false
        }

        private func TryGetFunctionShapeSlots(type TypeSymbol?, out slots ImmutableArray[TypeSymbol]) bool {
            // Issue #1431: normalise a function shape into a flat slot list of
            // [parameter types..., return type?] so a native `FunctionTypeSymbol`
            // and a `Func`/`Action`-shaped CLR delegate unify uniformly. A void
            // return contributes no trailing slot, mirroring how
            // `FunctionTypeSymbol.BuildClrType` selects `Action<...>` (no return
            // slot) over `Func<..., R>` (return slot appended).
            if type is FunctionTypeSymbol fn {
                let b = ImmutableArray.CreateBuilder[TypeSymbol](fn.ParameterTypes.Length + 1)
                b.AddRange(fn.ParameterTypes)
                if !FunctionTypeSymbol.IsVoidReturn(fn.ReturnType) {
                    b.Add(fn.ReturnType)
                }
                slots = b.ToImmutable()
                return true
            }
            // A delegate that arrived in CLR form (`Func[...]` / `Action[...]`).
            // Its CLR generic arguments are already laid out as
            // [parameter types..., return type] for `Func` and
            // [parameter types...] for `Action`, matching the native slot order.
            let clr Type? = type?.ClrType
            if clr != nil && clr.IsGenericType && IsFuncOrActionDefinition(clr.GetGenericTypeDefinition()) {
                slots = GetGenericTypeArguments(type)
                return !slots.IsDefaultOrEmpty
            }
            slots = default(ImmutableArray[TypeSymbol])
            return false
        }

        private func IsFuncOrActionDefinition(openDef Type?) bool {
            if openDef == nil {
                return false
            }
            // Name-based check (rather than `typeof` identity) so it holds across
            // a `MetadataLoadContext` projection of `System.Func`/`System.Action`.
            let name = openDef.Name
            let ns = openDef.Namespace
            if ns != "System" {
                return false
            }
            return name.StartsWith("Func`", StringComparison.Ordinal) || name.StartsWith(
                "Action`",
                StringComparison.Ordinal
            )
        }

        private func GetGenericTypeArguments(type TypeSymbol?) ImmutableArray[TypeSymbol] {
            let args = switch type {
                case s is StructSymbol: s.TypeArguments
                case i is InterfaceSymbol: i.TypeArguments
                case it is ImportedTypeSymbol: it.TypeArguments
                default: default(ImmutableArray[TypeSymbol])
            }
            if !args.IsDefaultOrEmpty {
                return args
            }
            // ADR-0087 §3 R3+R4: imported CLR constructed generics may carry
            // their type arguments only on the CLR `Type` (the binder elides
            // `TypeArguments` when the GS-side use site doesn't need them).
            // Recover them by inspecting `ClrType.GenericTypeArguments` so
            // structural unification still succeeds for `List[int32]` /
            // `Dictionary[string, int32]` actual arguments.
            let clr Type? = type?.ClrType
            if clr != nil && clr.IsGenericType && !clr.IsGenericTypeDefinition {
                let clrArgs = clr.GenericTypeArguments
                let builder = ImmutableArray.CreateBuilder[TypeSymbol](clrArgs.Length)
                for var i = 0; i < clrArgs.Length; i++ {
                    builder.Add(
                        TypeSymbol.FromClrTypeWithoutNullability(clrArgs[i], NullabilityFreeReason.TypeStructure)
                    )
                }
                return builder.MoveToImmutable()
            }
            return default(ImmutableArray[TypeSymbol])
        }

        /// Issue #813: returns `true` when [`openDef`](paramref)
        /// is one of the BCL `System.ValueTuple<…>` open generic
        /// definitions (arities 1–8). Used by the structural unification
        /// engine so a formal (cref:TupleTypeSymbol) can match against
        /// an actual CLR `ValueTuple` instance recovered through
        /// (cref:TypeSymbol.FromClrType).
        private func IsValueTupleOpenDefinition(openDef Type?) bool {
            if openDef == nil {
                return false
            }
            return openDef.IsSameAs(typeof(ValueTuple[_])) || openDef.IsSameAs(typeof(ValueTuple[_, _])) ||
                openDef.IsSameAs(typeof(ValueTuple[_, _, _])) || openDef.IsSameAs(typeof(ValueTuple[_, _, _, _])) ||
                openDef.IsSameAs(typeof(ValueTuple[_, _, _, _, _])) || openDef.IsSameAs(
                typeof(ValueTuple[_, _, _, _, _, _])
            ) ||
                openDef.IsSameAs(typeof(ValueTuple[_, _, _, _, _, _, _])) || openDef.IsSameAs(
                typeof(ValueTuple[_, _, _, _, _, _, _, _])
            )
        }

        private func IndexParametersMatch(
            clrParameters[]ParameterInfo,
            parameters ImmutableArray[ParameterSymbol],
            declaringTypeParameters ImmutableArray[TypeParameterSymbol]
        ) bool {
            if clrParameters.Length != parameters.Length {
                return false
            }
            for var i = 0; i < clrParameters.Length; i++ {
                if !IndexParameterTypeMatches(
                    clrParameters[i].ParameterType,
                    parameters[i].Type,
                    declaringTypeParameters
                ) {
                    return false
                }
            }
            return true
        }

        // Review finding (#4350): a CLR nested type flattens its enclosing types'
        // generic parameters before its own, so `Outer[T].Inner[U]`'s `U` is CLR
        // generic position 1 even though its G# ordinal is 0. Returns the
        // declaring type's parameters in that CLR order.
        private func FlattenedTypeParameters(type Symbol?) ImmutableArray[TypeParameterSymbol] {
            if type == nil {
                return ImmutableArray[TypeParameterSymbol].Empty
            }
            let own = switch type {
                case structSymbol is StructSymbol: structSymbol.TypeParameters
                case interfaceSymbol is InterfaceSymbol: interfaceSymbol.TypeParameters
                default: ImmutableArray[TypeParameterSymbol].Empty
            }
            let enclosing = FlattenedTypeParameters(type.ContainingType)
            return if enclosing.IsEmpty {
                own
            } else {
                enclosing.AddRange(
                    if own.IsDefault {
                        ImmutableArray[TypeParameterSymbol].Empty
                    } else {
                        own
                    }
                )
            }
        }

        // Review finding (#4350): a symbolic index parameter has no reflected
        // `ClrType`, but it must still discriminate between same-arity overloads
        // (`this[T]` vs `this[int32]`, `this[A.Key]` vs `this[B.Key]`) rather than
        // match anything. A type parameter matches only the generic parameter at
        // the same position; a source type matches only the reflected type with
        // the same namespace, name and arity, with its type arguments matched the
        // same way; an array or slice matches element-wise. Any other symbolic
        // shape is not matched, so no overload is picked by accident.
        private func IndexParameterTypeMatches(
            clrParameterType Type,
            parameterType TypeSymbol,
            declaringTypeParameters ImmutableArray[TypeParameterSymbol]
        ) bool {
            // Review finding (#4350): a nullable parameter's `ClrType` is its
            // UNDERLYING type, but a nullable value type reflects as `Nullable<X>`.
            // Match the wrapper structurally: `Nullable<X>` against the underlying
            // type, and a nullable reference type or unconstrained `T?` (which
            // reflect as the bare type) against the underlying type directly.
            if parameterType is NullableTypeSymbol nullable {
                if !clrParameterType.IsGenericParameter &&
                    clrParameterType.IsGenericType &&
                    clrParameterType
                    .GetGenericTypeDefinition().FullName == "System.Nullable`1" {
                    return IndexParameterTypeMatches(
                        clrParameterType.GetGenericArguments()[0],
                        nullable.UnderlyingType,
                        declaringTypeParameters
                    )
                }
                return IndexParameterTypeMatches(clrParameterType, nullable.UnderlyingType, declaringTypeParameters)
            }
            if parameterType.ClrType is {} parameterClrType {
                return ClrTypeUtilities.AreSame(clrParameterType, parameterClrType)
            }
            switch parameterType {
                case typeParameter is TypeParameterSymbol {
                    let flattenedPosition = if declaringTypeParameters.IsDefault {
                        -1
                    } else {
                        declaringTypeParameters.IndexOf(typeParameter)
                    }
                    return clrParameterType.IsGenericParameter &&
                        clrParameterType.GenericParameterPosition == (
                        if flattenedPosition >= 0 {
                            flattenedPosition
                        } else {
                            typeParameter.Ordinal
                        }
                    )
                }
                case array is ArrayTypeSymbol {
                    return clrParameterType.IsArray && clrParameterType.GetElementType() is {} arrayElement &&
                        IndexParameterTypeMatches(arrayElement, array.ElementType, declaringTypeParameters)
                }
                case slice is SliceTypeSymbol {
                    return clrParameterType.IsArray && clrParameterType.GetElementType() is {} sliceElement &&
                        IndexParameterTypeMatches(sliceElement, slice.ElementType, declaringTypeParameters)
                }
                case structSymbol is StructSymbol {
                    return SourceTypeMatches(
                        clrParameterType,
                        structSymbol,
                        structSymbol.PackageName,
                        AllTypeArguments(structSymbol),
                        declaringTypeParameters
                    )
                }
                case interfaceSymbol is InterfaceSymbol {
                    return SourceTypeMatches(
                        clrParameterType,
                        interfaceSymbol,
                        interfaceSymbol.PackageName,
                        interfaceSymbol.TypeArguments,
                        declaringTypeParameters
                    )
                }
                case enumSymbol is EnumSymbol {
                    return SourceTypeMatches(
                        clrParameterType,
                        enumSymbol,
                        enumSymbol.PackageName,
                        ImmutableArray[TypeSymbol].Empty,
                        declaringTypeParameters
                    )
                }
                default {
                    return false
                }
            }
        }

        private func SourceTypeMatches(
            clrType Type,
            symbol TypeSymbol,
            packageName string,
            typeArguments ImmutableArray[TypeSymbol],
            declaringTypeParameters ImmutableArray[TypeParameterSymbol]
        ) bool {
            // Review finding: `OuterA.Key` and `OuterB.Key` share a namespace and
            // simple name, so the declaring chain is part of the identity too.
            if clrType.IsGenericParameter || !DeclarationChainMatches(clrType, symbol, packageName) {
                return false
            }
            let clrArguments = if clrType.IsGenericType {
                clrType.GetGenericArguments()
            } else {
                Type.EmptyTypes
            }
            let symbolArguments = if typeArguments.IsDefault {
                ImmutableArray[TypeSymbol].Empty
            } else {
                typeArguments
            }
            if clrArguments.Length != symbolArguments.Length {
                return false
            }
            for var i = 0; i < clrArguments.Length; i++ {
                if !IndexParameterTypeMatches(clrArguments[i], symbolArguments[i], declaringTypeParameters) {
                    return false
                }
            }
            return true
        }

        // A CLR nested type in a generic outer type lists the enclosing type's
        // arguments before its own.
        private func AllTypeArguments(structSymbol StructSymbol) ImmutableArray[TypeSymbol] {
            let own = if structSymbol.TypeArguments.IsDefault {
                ImmutableArray[TypeSymbol].Empty
            } else {
                structSymbol.TypeArguments
            }
            return if structSymbol.EnclosingTypeArguments.IsDefaultOrEmpty {
                own
            } else {
                structSymbol.EnclosingTypeArguments.AddRange(own)
            }
        }

        private func DeclarationChainMatches(clrType Type, symbol Symbol, packageName string) bool {
            let clrName = clrType.Name
            let arityMarker = clrName.IndexOf('`', StringComparison.Ordinal)
            if !string.Equals(
                if arityMarker < 0 {
                    clrName
                } else {
                    clrName.Substring(0, arityMarker)
                },
                symbol.Name,
                StringComparison.Ordinal
            ) {
                return false
            }
            if symbol.ContainingType is {} container {
                return clrType.IsNested &&
                    clrType.DeclaringType is {} declaringType &&
                    DeclarationChainMatches(declaringType, container, packageName)
            }
            return !clrType.IsNested && string.Equals(
                clrType.Namespace ?? string.Empty,
                packageName ?? string.Empty,
                StringComparison.Ordinal
            )
        }

        /// ADR-0187 / issue #4350: maps a property of a constructed type (or the
        /// definition's own property) to the definition's property. A type may
        /// declare several overloaded `Item` indexers, so the mapping is by
        /// identity, then by position in the substituted member list (which
        /// preserves the definition's order), and only then by name.
        /// @param constructedProperties The constructed type's properties.
        /// @param definitionProperties The definition's properties.
        /// @param property The property to map.
        /// @returns The definition's property.
        private func MapToDefinitionProperty(
            constructedProperties ImmutableArray[PropertySymbol],
            definitionProperties ImmutableArray[PropertySymbol],
            property PropertySymbol
        ) PropertySymbol {
            if definitionProperties.IsDefaultOrEmpty {
                return property
            }
            if definitionProperties.Contains(property) {
                return property
            }
            let position = if constructedProperties.IsDefault {
                -1
            } else {
                constructedProperties.IndexOf(property)
            }
            if position >= 0 && position < definitionProperties.Length {
                return definitionProperties[position]
            }
            for candidate in definitionProperties {
                if candidate.Name == property.Name &&
                    candidate.IsIndexer == property.IsIndexer &&
                    candidate
                    .Parameters
                    .Length == property
                    .Parameters
                    .Length {
                    return candidate
                }
            }
            return property
        }
    }
}
