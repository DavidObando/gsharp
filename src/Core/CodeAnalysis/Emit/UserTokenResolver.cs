// <copyright file="UserTokenResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // elements should appear in the correct order (the user-token memoization caches keep their original ReflectionMetadataEmitter band position, interleaved with the resolvers that consume them)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private helpers they orchestrate)
#pragma warning disable SA1204 // static members should come before non-static (the structural-unification / open-signature helpers sit next to the resolvers that consume them, preserving band order)
#pragma warning disable SA1214 // readonly fields should appear before non-readonly fields (the memoization caches keep their original ReflectionMetadataEmitter band position)
#pragma warning disable SA1515 // single-line comment preceded by blank line (inherited from the ReflectionMetadataEmitter band; bodies are verbatim moves)
#pragma warning disable SA1611 // parameter documentation missing — the API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-19 (#1361): the user-type token-resolution band. Owns every method that
/// renders a reference to a user-declared (same-compilation) generic type,
/// interface, delegate, field, method, property accessor, or constructor into
/// the correct ECMA-335 token — a bare <c>TypeDef</c>/<c>MethodDef</c>/
/// <c>FieldDef</c> for a non-generic declarer, or a <c>TypeSpec</c>-parented
/// <c>MemberRef</c> (over the constructed or self-instantiation) for a generic
/// one. Covers the user struct/interface/delegate <c>TypeSpec</c> producers and
/// their memoization caches, the field/method/ctor MemberRef factories, the
/// property-accessor and static/instance/interface method-token resolvers, the
/// constructed-base ctor-token resolvers, the generic-user-call
/// <c>MethodSpec</c> builder and its structural type-argument unifier, the
/// non-capturing generic-lambda promotion and its <c>ldftn</c> token, and the
/// symbolic-substituted-return trio the erasure-widening short-circuits on.
/// </summary>
/// <remarks>
/// <para>
/// This is the consolidation commit the Wave-1 emitter decomposition built
/// toward: it resolves the temporary couplings PR-E-17 (SignatureEncoder) and
/// PR-E-18 (ImportedMemberRefFactory) left pointing into this band. Those
/// siblings now reach the user-token resolvers directly through the root's
/// <see cref="ReflectionMetadataEmitter.userTokens"/> field, and the two
/// PR-E-17 widenings (<c>ResolveUserStructTypeSpecArguments</c> /
/// <c>ResolveDelegateTypeArguments</c>) that had been promoted on the root are
/// relocated / restored here.
/// </para>
/// <para>
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// SignatureEncoder / ImportedMemberRefFactory idiom) because the band reaches
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>,
/// <see cref="GenericRemapState"/>, the extracted <see cref="SignatureEncoder"/>
/// and <see cref="ImportedMemberRefFactory"/>, and a few root-owned surfaces
/// that stay put (the shared static predicates
/// <see cref="ReflectionMetadataEmitter.IsUserGenericTypeReference"/> /
/// <see cref="ReflectionMetadataEmitter.ArgIsSymbolicUserDefined"/>, the
/// async-return encoder <see cref="ReflectionMetadataEmitter.EncodeAsyncReturnType"/>,
/// <c>FindImportedMethod</c>, and the state-machine plans / well-known refs).
/// Direct convenience fields hold the shared <see cref="EmitContext"/> /
/// <see cref="MetadataTokenCache"/> / <see cref="GenericRemapState"/> /
/// <see cref="SignatureEncoder"/> / <see cref="ImportedMemberRefFactory"/> read
/// off the back-reference. Method bodies are verbatim moves; emitted PEs are
/// byte-identical with the pre-E-19 baseline.
/// </para>
/// </remarks>
internal sealed class UserTokenResolver
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly GenericRemapState remaps;
    private readonly SignatureEncoder signatures;
    private readonly ImportedMemberRefFactory memberRefs;

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
    // BadImageFormatException). Both channels are part of every key.
    private readonly Dictionary<(StructSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> userStructTypeSpecCache = new();
    private readonly Dictionary<(StructSymbol Containing, FieldSymbol DefField, object ClassRemap, object MethodRemap), EntityHandle> userStructFieldRefCache = new();
    private readonly Dictionary<(StructSymbol Containing, EntityHandle OpenMember, object ClassRemap, object MethodRemap), EntityHandle> userStructMethodRefCache = new();
    private readonly Dictionary<(InterfaceSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> userInterfaceTypeSpecCache = new();
    private readonly Dictionary<(InterfaceSymbol Containing, EntityHandle OpenMember, object ClassRemap, object MethodRemap), EntityHandle> userInterfaceMethodRefCache = new();
    private readonly Dictionary<(InterfaceSymbol Containing, FieldSymbol DefField, object ClassRemap, object MethodRemap), EntityHandle> userInterfaceFieldRefCache = new();
    private readonly Dictionary<(DelegateTypeSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> userDelegateTypeSpecCache = new();
    private readonly Dictionary<(DelegateTypeSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> userDelegateCtorRefCache = new();
    private readonly Dictionary<(DelegateTypeSymbol Sym, object ClassRemap, object MethodRemap), EntityHandle> userDelegateInvokeRefCache = new();

    // Issue #2118: per-lambda-function ordered ORIGINAL enclosing type
    // parameters used as the MethodSpec type arguments when the lambda is
    // referenced (`ldftn <lambda><...enclosing args...>`) at its delegate
    // materialization site. The paired enclosing-TP → own-clone-ordinal remap
    // (which drives EncodeTypeSymbol) lives on GenericRemapState; this ordered
    // list is a delegate-materialization-token concern, not remap-scope state.
    // PR-E-19: moved off the root with its sole users
    // (TryPromoteNonCapturingGenericLambda / ResolveLambdaFunctionFtnToken).
    private readonly Dictionary<FunctionSymbol, ImmutableArray<TypeParameterSymbol>> lambdaMethodTypeArgsByFunction =
        new Dictionary<FunctionSymbol, ImmutableArray<TypeParameterSymbol>>(ReferenceEqualityComparer.Instance);

    public UserTokenResolver(ReflectionMetadataEmitter outer)
    {
        this.outer = outer ?? throw new ArgumentNullException(nameof(outer));
        this.emitCtx = outer.emitCtx;
        this.cache = outer.cache;
        this.remaps = outer.remaps;
        this.signatures = outer.signatures ?? throw new ArgumentNullException(nameof(outer));
        this.memberRefs = outer.memberRefs ?? throw new ArgumentNullException(nameof(outer));
    }

    /// <summary>
    /// Issue #2118: promotes a non-capturing lambda that references enclosing
    /// type parameters into a generic method. Clones the referenced enclosing
    /// type parameters (with their constraints remapped onto the clones) as the
    /// lambda function's own method type parameters, records the
    /// enclosing-TP -> own-clone-ordinal remap (so the signature/body encode
    /// translates references into the method's own <c>MVar</c> slots) and the
    /// ordered originals (used as MethodSpec type arguments at the delegate
    /// materialization site). No-op for a lambda that references no enclosing
    /// type parameter or that already declares its own.
    /// </summary>
    /// <param name="literal">The non-capturing lambda literal being hosted as a top-level static method.</param>
    /// <param name="loweredBody">The lambda's lowered body (walked for type-parameter references).</param>
    internal void TryPromoteNonCapturingGenericLambda(BoundFunctionLiteralExpression literal, BoundBlockStatement loweredBody)
    {
        var fn = literal?.Function;
        if (fn == null || fn.IsGeneric)
        {
            return;
        }

        var referenced = new List<TypeParameterSymbol>();
        foreach (var parameter in fn.Parameters)
        {
            TypeSymbol.CollectReferencedTypeParameters(parameter.Type, referenced);
        }

        TypeSymbol.CollectReferencedTypeParameters(fn.Type, referenced);
        LambdaEnclosingTypeParameterCollector.Collect(loweredBody, referenced);

        if (referenced.Count == 0)
        {
            return;
        }

        // Canonical order: class type parameters (Var) before method type
        // parameters (MVar), each by original ordinal — matching
        // SynthesizedClosureReifier.CollectOrdered so the clone list is
        // deterministic.
        referenced.Sort(static (a, b) =>
        {
            var ak = a.IsMethodTypeParameter ? 1 : 0;
            var bk = b.IsMethodTypeParameter ? 1 : 0;
            return ak != bk ? ak - bk : a.Ordinal - b.Ordinal;
        });

        var origTPs = referenced.ToImmutableArray();
        var clones = SynthesizedClosureReifier.CloneWithRemappedConstraints(origTPs);

        // Setting TypeParameters flips each clone's IsMethodTypeParameter flag,
        // so the emitter encodes body/signature references as MVar(idx).
        fn.TypeParameters = clones;

        var remap = new Dictionary<TypeParameterSymbol, int>(origTPs.Length, ReferenceEqualityComparer.Instance);
        for (var i = 0; i < origTPs.Length; i++)
        {
            remap[origTPs[i]] = i;
        }

        this.remaps.RegisterLambdaMethodRemap(fn, remap);
        this.lambdaMethodTypeArgsByFunction[fn] = origTPs;
    }

    /// <summary>
    /// Issue #2118: resolves the <c>ldftn</c> target token for a non-capturing
    /// lambda function. When the lambda was generic-promoted
    /// (<see cref="TryPromoteNonCapturingGenericLambda"/>) the token is a
    /// MethodSpec instantiating the open lambda method with the enclosing type
    /// parameters (in the referencing method's context); otherwise it is the
    /// bare MethodDef handle.
    /// </summary>
    /// <param name="fn">The lambda function whose function pointer is loaded.</param>
    /// <returns>The MethodDef or MethodSpec token for the <c>ldftn</c>.</returns>
    internal EntityHandle ResolveLambdaFunctionFtnToken(FunctionSymbol fn)
    {
        var methodHandle = this.cache.FunctionHandles[fn];
        if (this.lambdaMethodTypeArgsByFunction.TryGetValue(fn, out var typeArgs)
            && !typeArgs.IsDefaultOrEmpty)
        {
            var args = new TypeSymbol[typeArgs.Length];
            for (var i = 0; i < typeArgs.Length; i++)
            {
                args[i] = typeArgs[i];
            }

            return this.BuildMethodSpec(methodHandle, args);
        }

        return methodHandle;
    }

    /// <summary>
    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// function call. Derives the type arguments from the call's
    /// arguments and substituted return type. Required because the
    /// post-R2 MethodDef carries MVAR slots; the call site must
    /// reference a MethodSpec naming the substituted instantiation.
    /// </summary>
    internal EntityHandle BuildMethodSpecForGenericCall(EntityHandle openMethod, BoundCallExpression call)
    {
        var tps = call.Function.TypeParameters;

        // Issue #1931: prefer the bind-time-resolved method type arguments
        // (explicit `[T]` list or inference) stashed on the bound node — see
        // BuildMethodSpecForGenericInstanceCall for the rationale.
        if (!call.MethodTypeArguments.IsDefaultOrEmpty && call.MethodTypeArguments.Length == tps.Length)
        {
            return this.BuildMethodSpec(openMethod, call.MethodTypeArguments.ToArray());
        }

        var args = new TypeSymbol[tps.Length];
        var inferenceReturn = AsyncReturnTypeNormalizer.GetDeclaredResultType(call.Function, call.ReturnType);
        for (int i = 0; i < tps.Length; i++)
        {
            args[i] = InferMethodTypeArgument(call.Function, call.Arguments, inferenceReturn, tps[i]);
        }

        return this.BuildMethodSpec(openMethod, args);
    }

    internal EntityHandle BuildMethodSpecForGenericMethodGroup(EntityHandle openMethod, BoundMethodGroupExpression methodGroup)
        => this.BuildMethodSpec(openMethod, methodGroup.MethodTypeArguments.ToArray());

    /// <summary>
    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// instance method call (`h.Box[int32](42)`). Same inference rules
    /// as <see cref="BuildMethodSpecForGenericCall"/>.
    /// </summary>
    internal EntityHandle BuildMethodSpecForGenericInstanceCall(EntityHandle openMethod, BoundUserInstanceCallExpression call)
    {
        var tps = call.Method.TypeParameters;

        // Issue #1931: prefer the authoritative (explicit-or-inferred) method
        // type arguments the binder already resolved and stashed on the bound
        // node. Falling back to structural re-inference over the call's
        // arguments/return shape is unsafe in general — e.g. an explicit
        // `shower.Show[string](nil)` call has no argument or return shape that
        // structurally mentions `T`, so re-deriving it here would fail even
        // though the call bound successfully.
        if (!call.MethodTypeArguments.IsDefaultOrEmpty && call.MethodTypeArguments.Length == tps.Length)
        {
            return this.BuildMethodSpec(openMethod, call.MethodTypeArguments.ToArray());
        }

        var args = new TypeSymbol[tps.Length];
        var calleeParameterOffset = call.Method.ExplicitReceiverParameter == null ? 0 : 1;
        var inferenceReturn = AsyncReturnTypeNormalizer.GetDeclaredResultType(call.Method, call.Type);

        // The user-instance call's Arguments excludes the receiver,
        // but Method.Parameters includes the explicit receiver (when
        // present) at index 0. We pass a sliced view to the inference
        // helper so positional indices line up.
        var userParams = call.Method.Parameters;
        if (calleeParameterOffset > 0)
        {
            userParams = call.Method.Parameters.RemoveAt(0);
        }

        for (int i = 0; i < tps.Length; i++)
        {
            args[i] = InferMethodTypeArgument(userParams, call.Arguments, inferenceReturn, call.Method.Type, tps[i]);
        }

        return this.BuildMethodSpec(openMethod, args);
    }

    private EntityHandle BuildMethodSpec(EntityHandle openMethod, TypeSymbol[] args)
    {
        var sigBlob = new BlobBuilder();
        var argsEnc = new BlobEncoder(sigBlob).MethodSpecificationSignature(args.Length);
        for (int i = 0; i < args.Length; i++)
        {
            this.signatures.EncodeTypeSymbol(argsEnc.AddArgument(), args[i]);
        }

        return this.emitCtx.Metadata.AddMethodSpecification(openMethod, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    private static TypeSymbol InferMethodTypeArgument(FunctionSymbol fn, ImmutableArray<BoundExpression> args, TypeSymbol substitutedReturn, TypeParameterSymbol tp)
    {
        return InferMethodTypeArgument(fn.Parameters, args, substitutedReturn, fn.Type, tp);
    }

    private static TypeSymbol InferMethodTypeArgument(
        ImmutableArray<ParameterSymbol> formalParams,
        ImmutableArray<BoundExpression> actualArgs,
        TypeSymbol substitutedReturn,
        TypeSymbol formalReturn,
        TypeParameterSymbol tp)
    {
        // ADR-0087 §3 R3+R4: structural unification across the formal/
        // actual parameter shapes finds the substituted type for `tp`.
        // Covers `Id[T](x T) T`, `Pair[A,B](first A, second B)`,
        // `Echo[T](s []T) []T`, `Wrap[T](b Box[T])`, etc. Recursive
        // higher-kinded unification (e.g. `MakeList[T]() List[T]`) is
        // R5 territory and stays out of scope here.
        for (int i = 0; i < formalParams.Length && i < actualArgs.Length; i++)
        {
            // The binder may insert a `BoundConversionExpression` widening
            // the actual to the (erased) formal type — that conversion's
            // `.Type` is the formal type, which would defeat unification.
            // Peel off the conversion to see the underlying expression's
            // pre-widening type. (We still pass the formal as-is.)
            var actualType = StripConversion(actualArgs[i]).Type;
            if (TryUnify(formalParams[i].Type, actualType, tp, out var inferred))
            {
                return inferred;
            }
        }

        if (formalReturn != null && substitutedReturn != null &&
            TryUnify(formalReturn, substitutedReturn, tp, out var fromReturn))
        {
            return fromReturn;
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
        throw new InvalidOperationException(
            $"Cannot infer type argument for '{tp.Name}'; "
            + "the type parameter does not appear in any parameter or return shape.");
    }

    private static BoundExpression StripConversion(BoundExpression expr)
    {
        while (expr is BoundConversionExpression conv)
        {
            expr = conv.Expression;
        }

        return expr;
    }

    private static bool TryUnify(TypeSymbol formal, TypeSymbol actual, TypeParameterSymbol tp, out TypeSymbol inferred)
    {
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
        if (formal is ByRefTypeSymbol formalByRef)
        {
            return TryUnify(formalByRef.PointeeType, actual, tp, out inferred);
        }

        if (actual is ByRefTypeSymbol actualByRef)
        {
            return TryUnify(formal, actualByRef.PointeeType, tp, out inferred);
        }

        if (ReferenceEquals(formal, tp))
        {
            inferred = actual;
            return true;
        }

        // Issue #1931: a `T?` formal (NullableTypeSymbol wrapping the type
        // parameter, e.g. `Show[T](value T?)` under `where T : default`)
        // arrives here unpeeled. Unify against the underlying `T`, peeling a
        // matching `T?` actual too if present, so a plain non-nullable actual
        // (`shower.Show("x")`) still infers `T = string` at emit time — the
        // binder already accepts this per the InferTypeArguments fix; this
        // mirrors that unwrap for MethodSpec inference.
        if (formal is NullableTypeSymbol fn)
        {
            var actualUnwrapped = actual is NullableTypeSymbol an ? an.UnderlyingType : actual;
            return TryUnify(fn.UnderlyingType, actualUnwrapped, tp, out inferred);
        }

        if (formal is SliceTypeSymbol fs && actual is SliceTypeSymbol asl)
        {
            return TryUnify(fs.ElementType, asl.ElementType, tp, out inferred);
        }

        if (formal is ArrayTypeSymbol fa && actual is ArrayTypeSymbol aa)
        {
            return TryUnify(fa.ElementType, aa.ElementType, tp, out inferred);
        }

        // Issue #810: unify open-generic iterator returns of
        // `sequence[T]` / `async sequence[T]` against their substituted
        // counterparts so the MethodSpec for a call like
        // `Sequences.Empty[int32]()` can be built when no parameters
        // mention `T`.
        if (formal is SequenceTypeSymbol fseq && actual is SequenceTypeSymbol aseq)
        {
            return TryUnify(fseq.ElementType, aseq.ElementType, tp, out inferred);
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
        if (formal is SequenceTypeSymbol fseqAny)
        {
            if (actual is SliceTypeSymbol aSliceEnum)
            {
                return TryUnify(fseqAny.ElementType, aSliceEnum.ElementType, tp, out inferred);
            }

            if (actual is ArrayTypeSymbol aArrEnum)
            {
                return TryUnify(fseqAny.ElementType, aArrEnum.ElementType, tp, out inferred);
            }

            if (actual?.ClrType is { } actualClrSeq)
            {
                var openIEnumerable = typeof(System.Collections.Generic.IEnumerable<>);
                System.Type matched = null;
                if (actualClrSeq.IsArray)
                {
                    var elt = actualClrSeq.GetElementType();
                    if (elt != null)
                    {
                        matched = openIEnumerable.MakeGenericType(elt);
                    }
                }
                else if (actualClrSeq.IsGenericType
                    && actualClrSeq.GetGenericTypeDefinition() == openIEnumerable)
                {
                    matched = actualClrSeq;
                }
                else
                {
                    foreach (var iface in actualClrSeq.GetInterfaces())
                    {
                        if (iface.IsGenericType
                            && iface.GetGenericTypeDefinition() == openIEnumerable)
                        {
                            matched = iface;
                            break;
                        }
                    }
                }

                if (matched != null)
                {
                    var elementSym = TypeSymbol.FromClrType(matched.GetGenericArguments()[0]);
                    if (TryUnify(fseqAny.ElementType, elementSym, tp, out inferred))
                    {
                        return true;
                    }
                }
            }
        }

        if (formal is AsyncSequenceTypeSymbol faseq && actual is AsyncSequenceTypeSymbol aaseq)
        {
            return TryUnify(faseq.ElementType, aaseq.ElementType, tp, out inferred);
        }

        // Issue #814: mirror of the synchronous sequence-vs-enumerable
        // unification above for `async sequence[T]` receivers against
        // any CLR generic implementing `IAsyncEnumerable<T>`.
        if (formal is AsyncSequenceTypeSymbol faseqAny && actual?.ClrType is { } actualClrAseq)
        {
            var openIAsync = typeof(System.Collections.Generic.IAsyncEnumerable<>);
            System.Type matched = null;
            if (actualClrAseq.IsGenericType
                && actualClrAseq.GetGenericTypeDefinition() == openIAsync)
            {
                matched = actualClrAseq;
            }
            else
            {
                foreach (var iface in actualClrAseq.GetInterfaces())
                {
                    if (iface.IsGenericType
                        && iface.GetGenericTypeDefinition() == openIAsync)
                    {
                        matched = iface;
                        break;
                    }
                }
            }

            if (matched != null)
            {
                var elementSym = TypeSymbol.FromClrType(matched.GetGenericArguments()[0]);
                if (TryUnify(faseqAny.ElementType, elementSym, tp, out inferred))
                {
                    return true;
                }
            }
        }

        if (formal is NullableTypeSymbol fnu && actual is NullableTypeSymbol anu)
        {
            return TryUnify(fnu.UnderlyingType, anu.UnderlyingType, tp, out inferred);
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
        if (formal is TupleTypeSymbol ftup)
        {
            ImmutableArray<TypeSymbol> actualElements = default;
            if (actual is TupleTypeSymbol atup
                && ftup.ElementTypes.Length == atup.ElementTypes.Length)
            {
                actualElements = atup.ElementTypes;
            }
            else if (actual?.ClrType is { } actualClr
                && actualClr.IsGenericType
                && IsValueTupleOpenDefinition(actualClr.GetGenericTypeDefinition())
                && actualClr.GenericTypeArguments.Length == ftup.ElementTypes.Length)
            {
                var b = ImmutableArray.CreateBuilder<TypeSymbol>(actualClr.GenericTypeArguments.Length);
                foreach (var arg in actualClr.GenericTypeArguments)
                {
                    b.Add(TypeSymbol.FromClrType(arg));
                }

                actualElements = b.MoveToImmutable();
            }

            if (!actualElements.IsDefault)
            {
                for (int i = 0; i < ftup.ElementTypes.Length; i++)
                {
                    if (TryUnify(ftup.ElementTypes[i], actualElements[i], tp, out inferred))
                    {
                        return true;
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
        if (formal is ImportedTypeSymbol formalImported
            && formalImported.ClrType is { IsInterface: true, IsGenericType: true } formalIface
            && !formalImported.TypeArguments.IsDefaultOrEmpty
            && (actual is SliceTypeSymbol || actual is ArrayTypeSymbol)
            && actual?.ClrType is { IsArray: true } actualClrArray)
        {
            Type matched = null;
            foreach (var iface in actualClrArray.GetInterfaces())
            {
                if (iface.IsGenericType
                    && ClrTypeUtilities.AreSame(
                        iface.GetGenericTypeDefinition(),
                        formalIface.GetGenericTypeDefinition()))
                {
                    matched = iface;
                    break;
                }
            }

            if (matched != null)
            {
                var matchedArgs = matched.GetGenericArguments();
                if (formalImported.TypeArguments.Length == matchedArgs.Length)
                {
                    for (int i = 0; i < formalImported.TypeArguments.Length; i++)
                    {
                        if (TryUnify(
                                formalImported.TypeArguments[i],
                                TypeSymbol.FromClrType(matchedArgs[i]),
                                tp,
                                out inferred))
                        {
                            return true;
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
        if ((formal is FunctionTypeSymbol || actual is FunctionTypeSymbol)
            && TryGetFunctionShapeSlots(formal, out var formalFnSlots)
            && TryGetFunctionShapeSlots(actual, out var actualFnSlots)
            && formalFnSlots.Length == actualFnSlots.Length)
        {
            for (int i = 0; i < formalFnSlots.Length; i++)
            {
                if (TryUnify(formalFnSlots[i], actualFnSlots[i], tp, out inferred))
                {
                    return true;
                }
            }
        }

        var formalArgs = GetGenericTypeArguments(formal);
        var actualArgs = GetGenericTypeArguments(actual);
        if (!formalArgs.IsDefaultOrEmpty && !actualArgs.IsDefaultOrEmpty
            && formalArgs.Length == actualArgs.Length)
        {
            for (int i = 0; i < formalArgs.Length; i++)
            {
                if (TryUnify(formalArgs[i], actualArgs[i], tp, out inferred))
                {
                    return true;
                }
            }
        }

        inferred = null;
        return false;
    }

    private static bool TryGetFunctionShapeSlots(TypeSymbol type, out ImmutableArray<TypeSymbol> slots)
    {
        // Issue #1431: normalise a function shape into a flat slot list of
        // [parameter types..., return type?] so a native `FunctionTypeSymbol`
        // and a `Func`/`Action`-shaped CLR delegate unify uniformly. A void
        // return contributes no trailing slot, mirroring how
        // `FunctionTypeSymbol.BuildClrType` selects `Action<...>` (no return
        // slot) over `Func<..., R>` (return slot appended).
        if (type is FunctionTypeSymbol fn)
        {
            var b = ImmutableArray.CreateBuilder<TypeSymbol>(fn.ParameterTypes.Length + 1);
            b.AddRange(fn.ParameterTypes);
            if (!FunctionTypeSymbol.IsVoidReturn(fn.ReturnType))
            {
                b.Add(fn.ReturnType);
            }

            slots = b.ToImmutable();
            return true;
        }

        // A delegate that arrived in CLR form (`Func[...]` / `Action[...]`).
        // Its CLR generic arguments are already laid out as
        // [parameter types..., return type] for `Func` and
        // [parameter types...] for `Action`, matching the native slot order.
        var clr = type?.ClrType;
        if (clr != null && clr.IsGenericType && IsFuncOrActionDefinition(clr.GetGenericTypeDefinition()))
        {
            slots = GetGenericTypeArguments(type);
            return !slots.IsDefaultOrEmpty;
        }

        slots = default;
        return false;
    }

    private static bool IsFuncOrActionDefinition(Type openDef)
    {
        if (openDef == null)
        {
            return false;
        }

        // Name-based check (rather than `typeof` identity) so it holds across
        // a `MetadataLoadContext` projection of `System.Func`/`System.Action`.
        var name = openDef.Name;
        var ns = openDef.Namespace;
        if (ns != "System")
        {
            return false;
        }

        return name.StartsWith("Func`", StringComparison.Ordinal)
            || name.StartsWith("Action`", StringComparison.Ordinal);
    }

    private static ImmutableArray<TypeSymbol> GetGenericTypeArguments(TypeSymbol type)
    {
        var args = type switch
        {
            StructSymbol s => s.TypeArguments,
            InterfaceSymbol i => i.TypeArguments,
            ImportedTypeSymbol it => it.TypeArguments,
            _ => default,
        };

        if (!args.IsDefaultOrEmpty)
        {
            return args;
        }

        // ADR-0087 §3 R3+R4: imported CLR constructed generics may carry
        // their type arguments only on the CLR `Type` (the binder elides
        // `TypeArguments` when the GS-side use site doesn't need them).
        // Recover them by inspecting `ClrType.GenericTypeArguments` so
        // structural unification still succeeds for `List[int32]` /
        // `Dictionary[string, int32]` actual arguments.
        var clr = type?.ClrType;
        if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var clrArgs = clr.GenericTypeArguments;
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(clrArgs.Length);
            for (int i = 0; i < clrArgs.Length; i++)
            {
                builder.Add(TypeSymbol.FromClrType(clrArgs[i]));
            }

            return builder.MoveToImmutable();
        }

        return default;
    }

    /// <summary>
    /// Issue #813: returns <see langword="true"/> when <paramref name="openDef"/>
    /// is one of the BCL <c>System.ValueTuple&lt;…&gt;</c> open generic
    /// definitions (arities 1–8). Used by the structural unification
    /// engine so a formal <see cref="TupleTypeSymbol"/> can match against
    /// an actual CLR <c>ValueTuple</c> instance recovered through
    /// <see cref="TypeSymbol.FromClrType"/>.
    /// </summary>
    private static bool IsValueTupleOpenDefinition(Type openDef)
    {
        if (openDef == null)
        {
            return false;
        }

        return openDef.IsSameAs(typeof(ValueTuple<>))
            || openDef.IsSameAs(typeof(ValueTuple<,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,,,>))
            || openDef.IsSameAs(typeof(ValueTuple<,,,,,,,>));
    }

    /// <summary>
    /// Issue #2793: builds the user-struct <c>TypeSpec</c> cache key for
    /// <paramref name="structSym"/> under the two encoding-sensitive remap
    /// channels — the class/state-machine remap
    /// (<see cref="GenericRemapState.ActiveIteratorStateMachineRemap"/>, VAR)
    /// and the generic-promoted-lambda remap
    /// (<see cref="GenericRemapState.ActiveLambdaMethodTypeParamRemap"/>, MVAR).
    /// The object identity of each active remap distinguishes the same symbol
    /// encoded under different scopes so a lambda-scope encoding is never
    /// reused at an enclosing-method use site.
    /// </summary>
    private (StructSymbol Sym, object ClassRemap, object MethodRemap) GetUserStructRemapKey(StructSymbol structSym)
        => (structSym, this.remaps.ActiveIteratorStateMachineRemap, this.remaps.ActiveLambdaMethodTypeParamRemap);

    /// <summary>
    /// Issue #2793: user-interface variant of <see cref="GetUserStructRemapKey"/>.
    /// A user-declared generic interface's <c>TypeSpec</c>/<c>MemberRef</c> is
    /// equally sensitive to both active remap channels through its encoded type
    /// arguments (directly for the TypeSpec, transitively via the parent
    /// TypeSpec for its member refs).
    /// </summary>
    private (InterfaceSymbol Sym, object ClassRemap, object MethodRemap) GetUserInterfaceRemapKey(InterfaceSymbol ifaceSym)
        => (ifaceSym, this.remaps.ActiveIteratorStateMachineRemap, this.remaps.ActiveLambdaMethodTypeParamRemap);

    /// <summary>
    /// Issue #2793: user-delegate variant of <see cref="GetUserStructRemapKey"/>.
    /// A user-declared generic named delegate's <c>TypeSpec</c>, <c>.ctor</c>
    /// and <c>Invoke</c> refs are sensitive to both active remap channels
    /// through the encoded type arguments of the (possibly shared) parent
    /// TypeSpec.
    /// </summary>
    private (DelegateTypeSymbol Sym, object ClassRemap, object MethodRemap) GetUserDelegateRemapKey(DelegateTypeSymbol delegateSym)
        => (delegateSym, this.remaps.ActiveIteratorStateMachineRemap, this.remaps.ActiveLambdaMethodTypeParamRemap);

    /// <summary>
    /// ADR-0087 §3 R3: returns a <c>TypeSpec</c> EntityHandle for a
    /// user-declared generic type. When <paramref name="structSym"/>
    /// carries <see cref="StructSymbol.TypeArguments"/> the spec
    /// encodes the construction (<c>Box`1&lt;int32&gt;</c>); when it is
    /// the open definition the spec encodes the self-instantiation
    /// (<c>Box`1&lt;!0,...&gt;</c>) which is the only valid receiver
    /// type for the definition's own instance bodies (ECMA-335 II.10.3.1).
    /// </summary>
    internal EntityHandle GetUserStructTypeSpec(StructSymbol structSym)
    {
        var cacheKey = this.GetUserStructRemapKey(structSym);
        if (this.userStructTypeSpecCache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        var def = structSym.Definition ?? structSym;
        if (!this.cache.StructTypeDefs.TryGetValue(def, out var defHandle))
        {
            throw new InvalidOperationException(
                $"User generic type '{def.Name}' has no emitted TypeDef when constructing TypeSpec.");
        }

        var typeArgs = ResolveUserStructTypeSpecArguments(structSym, def);

        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: !def.IsClass);
        foreach (var arg in typeArgs)
        {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userStructTypeSpecCache[cacheKey] = spec;
        return spec;
    }

    /// <summary>
    /// ADR-0087 §3 R3 / issue #1521: resolves the type-argument vector encoded
    /// for a reference to a user-declared generic struct (or a type nested
    /// inside one). A constructed instance uses its own
    /// <see cref="StructSymbol.TypeArguments"/> (<c>Box`1&lt;int32&gt;</c>); a
    /// constructed reference to a nested type uses the enclosing construction's
    /// <see cref="StructSymbol.EnclosingTypeArguments"/>
    /// (<c>Box`1+Tag`1&lt;int32&gt;</c>); the open definition (including a nested
    /// type referenced from within its enclosing generic's own members) uses the
    /// self-instantiation over the definition's own type parameters, each of
    /// which encodes as <c>VAR(idx)</c> (<c>Box`1+Tag`1&lt;!0&gt;</c>).
    /// </summary>
    /// <param name="structSym">The struct reference being encoded.</param>
    /// <param name="def">The struct's emitted definition.</param>
    /// <returns>The type-argument vector aligned with <paramref name="def"/>'s type parameters.</returns>
    // PR-E-19: the E-17 widening is resolved here — this now lives on
    // UserTokenResolver alongside its sole users, and SignatureEncoder reaches it
    // through `outer.userTokens.ResolveUserStructTypeSpecArguments`
    // (EncodeTypeSymbol's user-generic struct branch) rather than a root
    // forwarder.
    internal ImmutableArray<TypeSymbol> ResolveUserStructTypeSpecArguments(StructSymbol structSym, StructSymbol def)
    {
        // Issue #1537: a type nested inside a generic enclosing type is reified
        // over the flattened enclosing+own parameter list (`Outer`1+Middle`2`),
        // so its use-site argument vector is built from TWO halves — the
        // enclosing arguments (`0..k-1`) then the nested type's own arguments
        // (`k..k+m-1`). Each half is concrete when the reference carries it and
        // the open reified parameters (encoded `VAR(idx)`) otherwise, so the
        // vector is context-correct for constructed and open references alike.
        if (this.remaps.TryGetNestedTypeEnclosingArity(def, out var enclosingArity) && enclosingArity > 0)
        {
            var defTps = def.TypeParameters;
            var total = defTps.Length;

            // A self-reference from within the nested type's OWN body (the
            // implicit `this` receiver, e.g. reading `FromU` inside a `Middle`
            // method) is the self-instantiation over the reified definition's
            // full parameter list, so its argument vector already spans BOTH
            // halves (`<U, T>` == `<!0, !1>`). Emit it verbatim — splitting it
            // into halves would double-count the enclosing slots.
            if (structSym.EnclosingTypeArguments.IsDefaultOrEmpty
                && structSym.TypeArguments.Length == total)
            {
                return structSym.TypeArguments;
            }

            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(total);

            // Enclosing half (`0..k-1`): the threaded enclosing arguments when
            // present (constructed use site, `<int32, …>`), else the reified
            // enclosing parameters (open reference from within the enclosing
            // generic's members, `<!0, …>`).
            if (!structSym.EnclosingTypeArguments.IsDefaultOrEmpty)
            {
                for (var i = 0; i < enclosingArity && i < structSym.EnclosingTypeArguments.Length; i++)
                {
                    builder.Add(structSym.EnclosingTypeArguments[i]);
                }

                for (var i = builder.Count; i < enclosingArity && i < total; i++)
                {
                    builder.Add(defTps[i]);
                }
            }
            else
            {
                for (var i = 0; i < enclosingArity && i < total; i++)
                {
                    builder.Add(defTps[i]);
                }
            }

            // Own half (`k..k+m-1`): the nested type's own arguments when
            // present (`Middle[string]`), else its reified own parameters (open,
            // `<…, !k>`).
            if (!structSym.TypeArguments.IsDefaultOrEmpty)
            {
                builder.AddRange(structSym.TypeArguments);
                for (var i = builder.Count; i < total; i++)
                {
                    builder.Add(defTps[i]);
                }
            }
            else
            {
                for (var i = enclosingArity; i < total; i++)
                {
                    builder.Add(defTps[i]);
                }
            }

            if (builder.Count > total)
            {
                var trimmed = ImmutableArray.CreateBuilder<TypeSymbol>(total);
                for (var i = 0; i < total; i++)
                {
                    trimmed.Add(builder[i]);
                }

                return trimmed.MoveToImmutable();
            }

            return builder.ToImmutable();
        }

        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            return structSym.TypeArguments;
        }

        // Issue #1521: a constructed reference to a type nested inside a generic
        // enclosing type threads the enclosing construction's arguments as the
        // reified nested type's argument vector (`Box`1+Tag`1<int32>`).
        if (!structSym.EnclosingTypeArguments.IsDefaultOrEmpty)
        {
            return structSym.EnclosingTypeArguments;
        }

        // Open definition → encode self-instantiation using the definition's
        // own type parameters as arguments. Each will encode as `VAR(idx)` via
        // EncodeTypeSymbol. For a nested type referenced from within its
        // enclosing generic's own members these are the reified enclosing
        // parameters, so the reference correctly threads `!0…`.
        var openTps = def.TypeParameters;
        var bld = ImmutableArray.CreateBuilder<TypeSymbol>(openTps.Length);
        foreach (var tp in openTps)
        {
            bld.Add(tp);
        }

        return bld.MoveToImmutable();
    }

    /// <summary>
    /// Issue #1503: returns a <c>TypeSpec</c> EntityHandle for a generic
    /// user-declared named delegate. A constructed instance encodes the
    /// construction (<c>Predicate`1&lt;int32&gt;</c>); the open definition
    /// encodes the self-instantiation (<c>Predicate`1&lt;!0,…&gt;</c>). Mirrors
    /// <see cref="GetUserStructTypeSpec"/>.
    /// </summary>
    /// <param name="delegateSym">The generic delegate reference.</param>
    /// <returns>The TypeSpec handle.</returns>
    internal EntityHandle GetUserDelegateTypeSpec(DelegateTypeSymbol delegateSym)
    {
        var cacheKey = this.GetUserDelegateRemapKey(delegateSym);
        if (this.userDelegateTypeSpecCache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        var def = delegateSym.Definition ?? delegateSym;
        if (!this.cache.DelegateTypeDefs.TryGetValue(def, out var defHandle))
        {
            throw new InvalidOperationException(
                $"Generic delegate '{def.Name}' has no emitted TypeDef when constructing TypeSpec.");
        }

        var typeArgs = ReflectionMetadataEmitter.ResolveDelegateTypeArguments(delegateSym);
        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: false);
        foreach (var arg in typeArgs)
        {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userDelegateTypeSpecCache[cacheKey] = spec;
        return spec;
    }

    /// <summary>
    /// Issue #1503: resolves the token used to construct a named-delegate
    /// value (<c>newobj</c> of its <c>.ctor(object, native int)</c>). A
    /// non-generic delegate uses the bare <c>.ctor</c> MethodDef; a generic
    /// delegate uses a <c>MemberRef</c> parented at the constructed (or self-)
    /// <c>TypeSpec</c> so the IL verifies against the locally-typed slot.
    /// </summary>
    /// <param name="delegateSym">The (possibly constructed) delegate symbol.</param>
    /// <returns>The ctor token.</returns>
    internal EntityHandle ResolveDelegateCtorToken(DelegateTypeSymbol delegateSym)
    {
        var def = delegateSym.Definition ?? delegateSym;
        if (!ReflectionMetadataEmitter.IsUserGenericDelegateReference(delegateSym))
        {
            if (!this.cache.DelegateCtorHandles.TryGetValue(def, out var ctorHandle))
            {
                throw new InvalidOperationException(
                    $"Named delegate '{def.Name}' has no emitted .ctor MethodDef.");
            }

            return ctorHandle;
        }

        if (this.userDelegateCtorRefCache.TryGetValue(this.GetUserDelegateRemapKey(delegateSym), out var cached))
        {
            return cached;
        }

        // The delegate ctor signature is the canonical `(object, native int)`
        // for every delegate — it never references the type parameters — so the
        // MemberRef signature is the same regardless of construction.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), ps =>
            {
                ps.AddParameter().Type().Object();
                ps.AddParameter().Type().IntPtr();
            });

        var parent = this.GetUserDelegateTypeSpec(delegateSym);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userDelegateCtorRefCache[this.GetUserDelegateRemapKey(delegateSym)] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// Issue #1503: resolves the token used to invoke a named-delegate value
    /// (<c>callvirt</c> of its <c>Invoke</c>). A non-generic delegate uses the
    /// bare <c>Invoke</c> MethodDef; a generic delegate uses a <c>MemberRef</c>
    /// parented at the constructed (or self-) <c>TypeSpec</c>, with the Invoke
    /// signature encoded from the OPEN definition (so type-parameter slots
    /// round-trip as <c>VAR(idx)</c>, matching the emitted MethodDef).
    /// </summary>
    /// <param name="delegateSym">The (possibly constructed) delegate symbol.</param>
    /// <returns>The Invoke token.</returns>
    internal EntityHandle ResolveDelegateInvokeToken(DelegateTypeSymbol delegateSym)
    {
        var def = delegateSym.Definition ?? delegateSym;
        if (!ReflectionMetadataEmitter.IsUserGenericDelegateReference(delegateSym))
        {
            if (!this.cache.DelegateInvokeHandles.TryGetValue(def, out var invokeHandle))
            {
                throw new InvalidOperationException(
                    $"Named delegate '{def.Name}' has no emitted Invoke MethodDef.");
            }

            return invokeHandle;
        }

        if (this.userDelegateInvokeRefCache.TryGetValue(this.GetUserDelegateRemapKey(delegateSym), out var cached))
        {
            return cached;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                def.Parameters.Length,
                r => this.signatures.EncodeReturnSymbol(r, def.ReturnType ?? TypeSymbol.Void, RefKind.None),
                ps =>
                {
                    foreach (var p in def.Parameters)
                    {
                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        var parent = this.GetUserDelegateTypeSpec(delegateSym);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userDelegateInvokeRefCache[this.GetUserDelegateRemapKey(delegateSym)] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// Issue #1465: returns the metadata token for a state-machine (or any
    /// user) struct type used as an operand (<c>initobj</c>) or type
    /// argument. A non-generic struct uses its bare <c>TypeDef</c>; a generic
    /// struct uses the constructed (or self-) <c>TypeSpec</c> so references
    /// from a generic context carry the correct <c>Var</c> instantiation.
    /// </summary>
    /// <param name="structSym">The struct symbol.</param>
    /// <returns>The type token.</returns>
    internal EntityHandle GetStructTypeToken(StructSymbol structSym)
    {
        return ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym)
            ? this.GetUserStructTypeSpec(structSym)
            : this.cache.StructTypeDefs[structSym];
    }

    /// <summary>
    /// Issue #1465: internal forwarder so the body emitter can encode a
    /// <see cref="TypeSymbol"/> into a signature blob (e.g. a MethodSpec type
    /// argument) using the same generic-aware path as the rest of the emitter.
    /// </summary>
    /// <param name="encoder">The signature type encoder to write into.</param>
    /// <param name="type">The type symbol to encode.</param>
    internal void EncodeTypeSymbolIntoSignature(SignatureTypeEncoder encoder, TypeSymbol type)
    {
        this.signatures.EncodeTypeSymbol(encoder, type);
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns a <c>MemberRef</c> handle for a field
    /// on a user-declared generic type, parented at the
    /// <c>TypeSpec</c> for <paramref name="containingType"/>.
    /// The MemberRef's signature is encoded from the OPEN definition's
    /// field — type-parameter slots round-trip as <c>VAR(idx)</c>.
    /// </summary>
    internal EntityHandle GetUserStructFieldRef(StructSymbol containingType, FieldSymbol fieldOnContaining)
    {
        var def = containingType.Definition ?? containingType;
        FieldSymbol defField = null;
        foreach (var candidate in def.Fields)
        {
            if (candidate.Name == fieldOnContaining.Name)
            {
                defField = candidate;
                break;
            }
        }

        if (defField == null)
        {
            // ADR-0029 backing-field fallback: synthesised members (auto-property,
            // field-like event) live alongside Fields under different containers.
            defField = fieldOnContaining;
        }

        var key = (containingType, defField, (object)this.remaps.ActiveIteratorStateMachineRemap, (object)this.remaps.ActiveLambdaMethodTypeParamRemap);
        if (this.userStructFieldRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserStructTypeSpec(containingType);
        var sigBlob = new BlobBuilder();

        // Issue #810: when the containing type is a generic iterator
        // state-machine class, the FieldDef's signature was encoded with
        // outer-method TPs translated to Var(idx). The MemberRef sig
        // MUST match — push the SM's remap so EncodeTypeSymbol routes
        // the same TPs through the same Var(idx) slots here.
        using (this.remaps.PushSmRemap(containingType.Definition ?? containingType))
        {
            this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), defField.Type);
        }

        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(defField.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userStructFieldRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns the correct token for a field reference.
    /// For a non-generic type returns the bare <c>FieldDef</c>; for a
    /// user-declared generic type returns a <c>MemberRef</c> parented
    /// at the constructed (or self-) <c>TypeSpec</c>.
    /// </summary>
    internal EntityHandle ResolveFieldToken(StructSymbol containingType, FieldSymbol field)
    {
        if (ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType))
        {
            return this.GetUserStructFieldRef(containingType, field);
        }

        if (!this.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle) && containingType.ClrType != null)
        {
            var importedField = containingType.ClrType.GetField(field.Name, BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (importedField != null)
            {
                return this.memberRefs.GetFieldReference(importedField);
            }
        }

        return this.cache.StructFieldDefs[field];
    }

    /// <summary>
    /// ADR-0089 / issue #1030: returns the correct token for an interface
    /// static field reference. A non-generic interface uses the bare
    /// <c>FieldDef</c> row emitted on its TypeDef; a generic interface uses a
    /// <c>MemberRef</c> parented at the constructed (or self-) <c>TypeSpec</c>
    /// so each closed construction observes independent static storage.
    /// </summary>
    /// <param name="containingInterface">The owning interface (definition or constructed).</param>
    /// <param name="field">The interface static field.</param>
    /// <returns>The field reference token.</returns>
    internal EntityHandle ResolveInterfaceFieldToken(InterfaceSymbol containingInterface, FieldSymbol field)
    {
        if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface))
        {
            return this.GetUserInterfaceFieldRef(containingInterface, field);
        }

        return this.cache.StructFieldDefs[field];
    }

    /// <summary>
    /// ADR-0089 / issue #1030: returns a <c>MemberRef</c> handle for a static
    /// field on a user-declared generic interface, parented at the
    /// <c>TypeSpec</c> for <paramref name="containingInterface"/>. Mirrors
    /// <see cref="GetUserStructFieldRef"/>. The field signature is encoded from
    /// the open definition's field type.
    /// </summary>
    /// <param name="containingInterface">The constructed (or open) interface reference.</param>
    /// <param name="fieldOnContaining">The static field being referenced.</param>
    /// <returns>The MemberRef token parented at the interface TypeSpec.</returns>
    internal EntityHandle GetUserInterfaceFieldRef(InterfaceSymbol containingInterface, FieldSymbol fieldOnContaining)
    {
        var def = containingInterface.Definition ?? containingInterface;
        var defField = def.GetStaticField(fieldOnContaining.Name) ?? fieldOnContaining;

        var key = (containingInterface, defField, (object)this.remaps.ActiveIteratorStateMachineRemap, (object)this.remaps.ActiveLambdaMethodTypeParamRemap);
        if (this.userInterfaceFieldRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserInterfaceTypeSpec(containingInterface);
        var sigBlob = new BlobBuilder();
        this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), defField.Type);

        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(defField.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userInterfaceFieldRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns a <c>MemberRef</c> handle for an
    /// instance method or ctor on a user-declared generic type,
    /// parented at the <c>TypeSpec</c> for <paramref name="containingType"/>.
    /// The signature is supplied by the caller (already encoded against
    /// the open definition with <c>VAR</c> slots).
    /// </summary>
    internal EntityHandle GetUserStructMethodRef(
        StructSymbol containingType,
        EntityHandle openMethodDef,
        string methodName,
        BlobBuilder signature)
    {
        var key = (containingType, openMethodDef, (object)this.remaps.ActiveIteratorStateMachineRemap, (object)this.remaps.ActiveLambdaMethodTypeParamRemap);
        if (this.userStructMethodRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserStructTypeSpec(containingType);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(methodName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature));
        this.userStructMethodRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// Issue #1465: encodes a function's emitted return type into a signature
    /// blob. For an <c>async</c> kickoff method the emitted return is the
    /// wrapped builder task type (<c>Task</c> / <c>Task&lt;T&gt;</c>), not the
    /// declared inner result type carried on <see cref="FunctionSymbol.Type"/>.
    /// MemberRef signatures built for calls into such a method on a generic
    /// receiver must match the emitted MethodDef, otherwise verification fails
    /// with a spurious <c>MissingMethod</c>.
    /// </summary>
    /// <param name="encoder">The return-type encoder.</param>
    /// <param name="fn">The function whose emitted return type to encode.</param>
    private void EncodeFunctionReturnSymbol(ReturnTypeEncoder encoder, FunctionSymbol fn)
    {
        if (fn.IsAsync && fn.StateMachineType != null)
        {
            foreach (var plan in this.outer.stateMachines.AsyncStateMachinePlans)
            {
                if (plan.KickoffMethod == fn)
                {
                    this.outer.EncodeAsyncReturnType(encoder, plan);
                    return;
                }
            }
        }

        this.signatures.EncodeReturnSymbol(encoder, fn.Type, fn.ReturnRefKind);
    }

    /// <summary>
    /// ADR-0087 §3 R3: encodes a method signature blob from a
    /// <see cref="FunctionSymbol"/>, using the OPEN definition's type
    /// information so <c>VAR(idx)</c> placeholders are produced for
    /// in-scope type-type parameters. Used to back the MemberRef
    /// signature returned by <see cref="GetUserStructMethodRef"/>.
    /// </summary>
    internal BlobBuilder EncodeOpenMethodSignature(FunctionSymbol openMethod)
    {
        var sigBlob = new BlobBuilder();
        var paramCount = openMethod.Parameters.Length - (openMethod.ExplicitReceiverParameter == null ? 0 : 1);
        new BlobEncoder(sigBlob)
            .MethodSignature(
                isInstanceMethod: openMethod.IsInstanceMethod,
                genericParameterCount: openMethod.TypeParameters.IsDefaultOrEmpty ? 0 : openMethod.TypeParameters.Length)
            .Parameters(
                paramCount,
                r => this.EncodeFunctionReturnSymbol(r, openMethod),
                ps =>
                {
                    foreach (var p in openMethod.Parameters)
                    {
                        if (ReferenceEquals(p, openMethod.ThisParameter))
                        {
                            continue;
                        }

                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return sigBlob;
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a call to a user
    /// instance method. For a non-generic containing type returns the
    /// bare <c>MethodDef</c>; for a generic containing type returns a
    /// <c>MemberRef</c> parented at the constructed (or self-) <c>TypeSpec</c>.
    /// </summary>
    internal EntityHandle ResolveUserInstanceMethodToken(StructSymbol containingType, FunctionSymbol method)
    {
        if (!this.cache.MethodHandles.TryGetValue(method, out var openDef)
            && containingType.ClrType != null)
        {
            var importedMethod = ReflectionMetadataEmitter.FindImportedMethod(containingType.ClrType, method, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (importedMethod != null)
            {
                return this.memberRefs.GetMethodReference(importedMethod);
            }
        }

        if (!this.cache.MethodHandles.TryGetValue(method, out openDef))
        {
            throw new InvalidOperationException(
                $"Instance method '{method.Name}' has no emitted handle.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
    }

    /// <summary>
    /// Issue #1477: resolves the <c>ldftn</c> function token for a synthesized
    /// generic closure's <c>Invoke</c> method at the capture site. The parent
    /// <c>TypeSpec</c> must encode the CONSTRUCTED closure
    /// (<c>Closure`1&lt;…enclosing args…&gt;</c>) under the AMBIENT (capture-site)
    /// remap, but the MemberRef signature must encode the open <c>Invoke</c>
    /// parameters under the CLOSURE's OWN remap so enclosing-type-parameter
    /// references resolve to the closure's <c>VAR(idx)</c> slots (which is how
    /// the closure's MethodDef signature was emitted). For a non-generic closure
    /// the bare <c>MethodDef</c> is returned.
    /// </summary>
    /// <param name="constructedClosure">The constructed closure reference.</param>
    /// <param name="closureDef">The open closure definition (for the sig remap).</param>
    /// <param name="invoke">The closure's <c>Invoke</c> method.</param>
    /// <returns>The function token suitable for <c>ldftn</c>.</returns>
    internal EntityHandle ResolveClosureInvokeFtnToken(StructSymbol constructedClosure, StructSymbol closureDef, FunctionSymbol invoke)
    {
        if (!this.cache.MethodHandles.TryGetValue(invoke, out var openDef))
        {
            throw new InvalidOperationException(
                $"Closure invoke method '{invoke.Name}' has no emitted handle.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure))
        {
            return openDef;
        }

        BlobBuilder sig;
        using (this.remaps.PushSmRemap(closureDef))
        {
            sig = this.EncodeOpenMethodSignature(invoke);
        }

        return this.GetUserStructMethodRef(constructedClosure, openDef, invoke.Name, sig);
    }

    /// <summary>
    /// Issue #1209: resolves the token for a call to a user <c>shared</c>
    /// (static) method whose declaring type is a constructed generic user type
    /// (<c>Box[int32].Make()</c>). A bare <c>MethodDef</c> token is invalid for a
    /// method of a generic type, so a <c>MemberRef</c> parented at the
    /// construction's <c>TypeSpec</c> is emitted (mirroring the static-field and
    /// static-property paths). The MemberRef signature is the open static method
    /// signature (no <c>this</c>) produced by <see cref="EncodeOpenMethodSignature"/>.
    /// </summary>
    internal EntityHandle ResolveUserStaticMethodToken(StructSymbol containingType, FunctionSymbol method)
    {
        if (!this.cache.MethodHandles.TryGetValue(method, out var openDef)
            && !this.cache.FunctionHandles.TryGetValue(method, out openDef))
        {
            if (containingType.ClrType != null)
            {
                var importedMethod = ReflectionMetadataEmitter.FindImportedMethod(containingType.ClrType, method, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                if (importedMethod != null)
                {
                    return this.memberRefs.GetMethodReference(importedMethod);
                }
            }

            throw new InvalidOperationException(
                $"Static method '{method.Name}' has no emitted handle.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
    }

    /// <summary>Resolves a generic static accessor whose MethodDef is tracked outside the method caches.</summary>
    /// <param name="containingType">The effective generic owner.</param>
    /// <param name="method">The accessor method symbol.</param>
    /// <param name="openDef">The accessor's emitted MethodDef.</param>
    /// <returns>The MethodDef or TypeSpec-parented MemberRef token.</returns>
    internal EntityHandle ResolveUserStaticMethodToken(StructSymbol containingType, FunctionSymbol method, EntityHandle openDef)
    {
        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
    }

    /// <summary>
    /// Issue #1433: resolves the token for a call to a user <c>shared</c>
    /// (static) method whose declaring type is a user-declared INTERFACE
    /// (<c>IThing.Create()</c> / <c>IBox[int32].Make()</c>). For a non-generic
    /// interface returns the bare <c>MethodDef</c>; for a constructed generic
    /// interface returns a <c>MemberRef</c> parented at the construction's
    /// <c>TypeSpec</c> (mirroring the interface static-field path, issue #1030).
    /// The substituted method on a constructed interface is mapped back to the
    /// open definition's slot so its emitted <c>MethodDef</c> handle and open
    /// (<c>VAR</c>-placeholdered) signature are used.
    /// </summary>
    /// <param name="containingInterface">The constructed (or open) interface reference.</param>
    /// <param name="method">The static method being called.</param>
    /// <returns>The MethodDef or TypeSpec-parented MemberRef token.</returns>
    internal EntityHandle ResolveUserInterfaceStaticMethodToken(InterfaceSymbol containingInterface, FunctionSymbol method)
    {
        var openMethod = InterfaceImplEmitter.ResolveOpenInterfaceStaticMethod(containingInterface, method);
        if (!this.cache.MethodHandles.TryGetValue(openMethod, out var openDef)
            && !this.cache.FunctionHandles.TryGetValue(openMethod, out openDef))
        {
            throw new InvalidOperationException(
                $"Static interface method '{method.Name}' has no emitted handle.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface))
        {
            return openDef;
        }

        return this.GetUserInterfaceMethodRef(containingInterface, openDef, openMethod.Name, this.EncodeOpenMethodSignature(openMethod));
    }

    /// <summary>
    /// Issue #1433: returns a <c>MemberRef</c> handle for a static method on a
    /// user-declared generic interface, parented at the <c>TypeSpec</c> for
    /// <paramref name="containingInterface"/>. Mirrors
    /// <see cref="GetUserStructMethodRef"/>; the signature is supplied by the
    /// caller (already encoded against the open definition with <c>VAR</c> slots).
    /// </summary>
    /// <param name="containingInterface">The constructed (or open) interface reference.</param>
    /// <param name="openMethodDef">The open method's emitted MethodDef handle.</param>
    /// <param name="methodName">The method name.</param>
    /// <param name="signature">The open method signature blob.</param>
    /// <returns>The MemberRef token parented at the interface TypeSpec.</returns>
    internal EntityHandle GetUserInterfaceMethodRef(
        InterfaceSymbol containingInterface,
        EntityHandle openMethodDef,
        string methodName,
        BlobBuilder signature)
    {
        var key = (containingInterface, openMethodDef, (object)this.remaps.ActiveIteratorStateMachineRemap, (object)this.remaps.ActiveLambdaMethodTypeParamRemap);
        if (this.userInterfaceMethodRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserInterfaceTypeSpec(containingInterface);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(methodName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature));
        this.userInterfaceMethodRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// Issue #989: resolves the right token for a call to a user property's
    /// get/set accessor. For a non-generic containing type returns the bare
    /// accessor <c>MethodDef</c>; for a constructed generic containing type
    /// returns a <c>MemberRef</c> parented at the constructed <c>TypeSpec</c>
    /// so a property whose type mentions a class type parameter (e.g.
    /// <c>prop Value T</c> on <c>Box[int32]</c>) is accessed with <c>T</c>
    /// substituted by the runtime. The MemberRef signature mirrors the open
    /// accessor MethodDef emitted by <c>MemberDefEmitter</c> (which encodes the
    /// property type with <c>VAR(idx)</c> placeholders).
    /// </summary>
    internal EntityHandle ResolveUserPropertyAccessorToken(StructSymbol containingType, PropertySymbol property, bool wantSetter)
    {
        // Property accessor MethodDef rows are planned against the OPEN
        // definition's property (the only type that is emitted), so map the
        // possibly-substituted constructed property back to the definition's
        // property by name before consulting PropertyAccessorHandles.
        var defType = containingType.Definition ?? containingType;
        var defProp = property;
        if (!ReferenceEquals(defType, containingType))
        {
            foreach (var candidate in property.IsStatic ? defType.StaticProperties : defType.Properties)
            {
                if (candidate.Name == property.Name && candidate.IsIndexer == property.IsIndexer)
                {
                    defProp = candidate;
                    break;
                }
            }
        }

        if (!this.cache.PropertyAccessorHandles.TryGetValue(defProp, out var handles))
        {
            if (containingType.ClrType != null)
            {
                var bindingFlags = (property.IsStatic ? BindingFlags.Static : BindingFlags.Instance) | BindingFlags.Public | BindingFlags.NonPublic;
                var importedProperty = containingType.ClrType.GetProperty(defProp.Name, bindingFlags);
                var importedAccessor = wantSetter ? importedProperty?.SetMethod : importedProperty?.GetMethod;
                if (importedAccessor != null)
                {
                    return this.memberRefs.GetMethodReference(importedAccessor);
                }
            }

            throw new InvalidOperationException(
                $"Property '{property.Name}' has no emitted accessor handles.");
        }

        var accessor = wantSetter ? handles.Setter : handles.Getter;
        if (!accessor.HasValue)
        {
            throw new InvalidOperationException(
                $"Property '{property.Name}' has no emitted {(wantSetter ? "setter" : "getter")} MethodDef.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(containingType))
        {
            return accessor.Value;
        }

        var accessorName = (wantSetter ? "set_" : "get_") + defProp.Name;
        return this.GetUserStructMethodRef(
            containingType,
            accessor.Value,
            accessorName,
            this.EncodeOpenPropertyAccessorSignature(defProp, wantSetter));
    }

    /// <summary>
    /// Issue #989: encodes the open accessor signature for a user property,
    /// matching the MethodDef shape emitted by <c>MemberDefEmitter</c>: a
    /// getter is <c>instance PropertyType get_Name(indexParams...)</c>; a setter
    /// is <c>instance void set_Name(indexParams..., PropertyType)</c>. The open
    /// definition's property type is used so type parameters encode as
    /// <c>VAR(idx)</c>, and an init-only setter retains its
    /// <c>modreq(IsExternalInit)</c> return modifier.
    /// </summary>
    private BlobBuilder EncodeOpenPropertyAccessorSignature(PropertySymbol property, bool wantSetter)
    {
        var sigBlob = new BlobBuilder();
        var indexParams = property.Parameters.IsDefaultOrEmpty
            ? ImmutableArray<ParameterSymbol>.Empty
            : property.Parameters;

        // Issue #1209: a static (`shared`) property accessor on a generic user
        // type has no `this` — the MemberRef signature must NOT set HASTHIS, or
        // the runtime fails to bind the accessor (MissingMethodException).
        var isInstanceAccessor = !property.IsStatic;
        if (wantSetter)
        {
            new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor)
                .Parameters(
                    indexParams.Length + 1,
                    r =>
                    {
                        if (property.IsInitOnly)
                        {
                            var isExternalInit = this.outer.wellKnown.GetIsExternalInitTypeRef();
                            if (!isExternalInit.IsNil)
                            {
                                r.CustomModifiers().AddModifier(isExternalInit, isOptional: false);
                            }
                        }

                        r.Void();
                    },
                    ps =>
                    {
                        foreach (var p in indexParams)
                        {
                            this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }

                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(), property.Type);
                    });
        }
        else
        {
            new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor)
                .Parameters(
                    indexParams.Length,
                    r => this.signatures.EncodeTypeSymbol(r.Type(), property.Type),
                    ps =>
                    {
                        foreach (var p in indexParams)
                        {
                            this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }
                    });
        }

        return sigBlob;
    }

    /// <summary>
    /// ADR-0091: returns a <c>TypeSpec</c> EntityHandle for a
    /// user-declared generic interface — analogue of
    /// <see cref="GetUserStructTypeSpec"/> for <see cref="InterfaceSymbol"/>.
    /// </summary>
    internal EntityHandle GetUserInterfaceTypeSpec(InterfaceSymbol ifaceSym)
    {
        var cacheKey = this.GetUserInterfaceRemapKey(ifaceSym);
        if (this.userInterfaceTypeSpecCache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        var def = ifaceSym.Definition ?? ifaceSym;
        if (!this.cache.InterfaceTypeDefs.TryGetValue(def, out var defHandle))
        {
            throw new InvalidOperationException(
                $"User generic interface '{def.Name}' has no emitted TypeDef when constructing TypeSpec.");
        }

        ImmutableArray<TypeSymbol> typeArgs;
        if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
        {
            typeArgs = ifaceSym.TypeArguments;
        }
        else
        {
            var defTps = def.TypeParameters;
            var bld = ImmutableArray.CreateBuilder<TypeSymbol>(defTps.Length);
            foreach (var tp in defTps)
            {
                bld.Add(tp);
            }

            typeArgs = bld.MoveToImmutable();
        }

        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
        var gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: false);
        foreach (var arg in typeArgs)
        {
            this.signatures.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userInterfaceTypeSpecCache[cacheKey] = spec;
        return spec;
    }

    /// <summary>
    /// ADR-0091: returns the right token for an instance call into a
    /// user-declared interface from a derived (implementing) type — used
    /// for the <c>base[IFoo].M(...)</c> explicit-base call. Returns the
    /// bare <c>MethodDef</c> for a non-generic interface, or a
    /// <c>MemberRef</c> parented at the constructed (or self-)
    /// <c>TypeSpec</c> for a generic interface.
    /// </summary>
    internal EntityHandle ResolveUserInterfaceInstanceMethodToken(InterfaceSymbol containingInterface, FunctionSymbol openMethod)
    {
        if (!this.cache.MethodHandles.TryGetValue(openMethod, out var openDef))
        {
            throw new InvalidOperationException(
                $"Interface method '{openMethod.Name}' on '{containingInterface?.Name}' has no emitted handle.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericInterfaceReference(containingInterface))
        {
            return openDef;
        }

        var key = (containingInterface, openDef, (object)this.remaps.ActiveIteratorStateMachineRemap, (object)this.remaps.ActiveLambdaMethodTypeParamRemap);
        if (this.userInterfaceMethodRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserInterfaceTypeSpec(containingInterface);
        var memberRef = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(openMethod.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(this.EncodeOpenMethodSignature(openMethod)));
        this.userInterfaceMethodRefCache[key] = memberRef;
        return memberRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a <c>newobj</c>
    /// against a user-declared primary ctor. Returns the bare
    /// <c>MethodDef</c> for a non-generic type, or a MemberRef
    /// parented at the constructed <c>TypeSpec</c> for a generic type.
    /// </summary>
    internal EntityHandle ResolveUserCtorTokenForPrimary(StructSymbol structType)
    {
        // Issue #1920: the primary ctor's MethodDef is keyed by the OPEN
        // definition (RegisterConstructedTypeAliases only mirrors it onto a
        // CONSTRUCTED StructSymbol when that exact instance is referenced
        // from a top-level function/lambda body — a construction inside a
        // class/struct instance or shared method never runs through that
        // collector). Look up via Definition first, matching the sibling
        // ResolveUserCtorTokenForDefault (issue #810) and
        // ResolveConstructedBaseParameterlessCtorToken (issue #1055).
        var ctorKey = structType.Definition ?? structType;
        if (!this.cache.ClassPrimaryCtorHandles.TryGetValue(ctorKey, out var primaryDef))
        {
            throw new InvalidOperationException($"Type '{structType.Name}' has no emitted primary ctor.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(structType))
        {
            return primaryDef;
        }

        var def = structType.Definition ?? structType;
        var defParams = def.PrimaryConstructorParameters;
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(
                defParams.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in defParams)
                    {
                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return this.GetUserStructMethodRef(structType, primaryDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// Issue #1254: resolves the base-constructor token for an explicit
    /// <c>: base(args)</c> initializer whose base is a CONSTRUCTED generic user
    /// class (e.g. <c>Derived : Base[int32]</c> chaining to <c>Base</c>'s
    /// primary or an explicit <c>init(...)</c> ctor). The base ctor's MethodDef
    /// is keyed by the open definition, so a bare token is invalid for a generic
    /// type; a MemberRef parented at the constructed base's TypeSpec is emitted
    /// with the open ctor's signature (type-parameter slots encode as VAR).
    /// </summary>
    internal EntityHandle ResolveConstructedBaseExplicitCtorToken(StructSymbol constructedBase, ConstructorSymbol ctor)
    {
        if (ctor == null || !this.cache.ExplicitCtorHandles.TryGetValue(ctor, out var ctorDef))
        {
            return this.ResolveConstructedBaseParameterlessCtorToken(constructedBase);
        }

        var function = ctor.Function;

        // The receiver `this` is not part of the encoded parameter list. It may
        // or may not appear in Function.Parameters, so count (and emit) only the
        // non-receiver parameters rather than assuming a fixed offset.
        var paramCount = 0;
        foreach (var p in function.Parameters)
        {
            if (!ReferenceEquals(p, function.ThisParameter))
            {
                paramCount++;
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(
                paramCount,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        if (ReferenceEquals(p, function.ThisParameter))
                        {
                            continue;
                        }

                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return this.GetUserStructMethodRef(constructedBase, ctorDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// Issue #1055: resolves the parameter-less base constructor token for a
    /// class whose base is a CONSTRUCTED generic user class (e.g.
    /// <c>Derived : Base[int32]</c>). The base ctor's MethodDef is keyed by the
    /// open definition, so the token is emitted as a MemberRef parented at the
    /// constructed base's TypeSpec via <see cref="GetUserStructMethodRef"/> so
    /// the chained <c>call</c> targets the correct instantiated base subobject
    /// and the assembly verifies.
    /// </summary>
    internal EntityHandle ResolveConstructedBaseParameterlessCtorToken(StructSymbol constructedBase)
    {
        var def = constructedBase.Definition ?? constructedBase;

        if (this.cache.ClassPrimaryCtorHandles.TryGetValue(def, out var primaryDef))
        {
            var defParams = def.PrimaryConstructorParameters;
            var primarySig = new BlobBuilder();
            new BlobEncoder(primarySig)
                .MethodSignature(isInstanceMethod: true)
                .Parameters(
                    defParams.IsDefaultOrEmpty ? 0 : defParams.Length,
                    r => r.Void(),
                    ps =>
                    {
                        if (defParams.IsDefaultOrEmpty)
                        {
                            return;
                        }

                        foreach (var p in defParams)
                        {
                            this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }
                    });
            return this.GetUserStructMethodRef(constructedBase, primaryDef, ".ctor", primarySig);
        }

        if (this.cache.ClassCtorHandles.TryGetValue(def, out var defaultDef))
        {
            var defaultSig = new BlobBuilder();
            new BlobEncoder(defaultSig)
                .MethodSignature(isInstanceMethod: true)
                .Parameters(0, r => r.Void(), _ => { });
            return this.GetUserStructMethodRef(constructedBase, defaultDef, ".ctor", defaultSig);
        }

        return this.outer.wellKnown.ObjectCtorRef;
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a <c>newobj</c>
    /// against a user-declared default (parameter-less) ctor.
    /// </summary>
    internal EntityHandle ResolveUserCtorTokenForDefault(StructSymbol structType)
    {
        // Issue #810: the kickoff body may pass a CONSTRUCTED StructSymbol
        // (e.g. `<Empty>d__1<MVar(0)>`); the ctor's MethodDef is keyed by
        // the OPEN definition, so look up via Definition when present.
        var ctorKey = structType.Definition ?? structType;
        if (!this.cache.ClassCtorHandles.TryGetValue(ctorKey, out var defaultDef))
        {
            throw new InvalidOperationException($"Type '{structType.Name}' has no emitted default ctor.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(structType))
        {
            return defaultDef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        return this.GetUserStructMethodRef(structType, defaultDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a <c>newobj</c>
    /// against a user-declared explicit (<c>init(...)</c>) ctor
    /// (ADR-0063 §9).
    /// </summary>
    internal EntityHandle ResolveUserCtorTokenForExplicit(StructSymbol structType, ConstructorSymbol ctor)
    {
        if (!this.cache.ExplicitCtorHandles.TryGetValue(ctor, out var explicitDef))
        {
            throw new InvalidOperationException($"Constructor on '{ctor?.DeclaringType?.Name}' has no emitted handle.");
        }

        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(structType))
        {
            return explicitDef;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob)
            .MethodSignature(isInstanceMethod: true)
            .Parameters(
                ctor.Parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in ctor.Parameters)
                    {
                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });
        return this.GetUserStructMethodRef(structType, explicitDef, ".ctor", sigBlob);
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for a type operation
    /// (<c>isinst</c>, <c>unbox</c>, <c>unbox.any</c>, <c>initobj</c>,
    /// <c>castclass</c>) against a user-declared type. Returns the
    /// bare <c>TypeDef</c> for a non-generic type, or a <c>TypeSpec</c>
    /// for a generic type.
    /// </summary>
    internal EntityHandle ResolveUserTypeToken(StructSymbol structType)
    {
        if (ReflectionMetadataEmitter.IsUserGenericTypeReference(structType))
        {
            return this.GetUserStructTypeSpec(structType);
        }

        if (structType.ClrType != null)
        {
            return this.memberRefs.GetElementTypeToken(structType);
        }

        return this.cache.StructTypeDefs[structType];
    }

    /// <summary>
    /// Issue #774: when emitting a property read on a symbolic open-generic
    /// receiver (e.g. <c>IEnumerator[T].Current</c> or
    /// <c>KeyValuePair[K, V].Key</c>), the runtime stack value after the
    /// symbolic getter MemberRef call is the substituted symbolic type, not
    /// the closed CLR <c>object</c> that the type-erased getter declares.
    /// Returning that symbolic type to the body emitter lets the widening
    /// short-circuit, avoiding a verifier-breaking <c>unbox.any</c> on a
    /// value-type <c>T</c>.
    /// </summary>
    /// <param name="receiverType">The receiver's type as seen by the body emitter.</param>
    /// <param name="property">The closed-CLR property selected by the lowerer.</param>
    /// <param name="substitutedReturn">The substituted symbolic return type, on success.</param>
    /// <returns><see langword="true"/> when the receiver is a symbolic
    /// open-generic container and the substituted return differs from the
    /// closed CLR <c>object</c> shape.</returns>
    internal bool TryGetSymbolicSubstitutedPropertyReturn(
        TypeSymbol receiverType,
        PropertyInfo property,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (property == null
            || !ImportedMemberRefFactory.TryNormalizeToSymbolicContainer(receiverType, out var openDef, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !typeArguments.Any(TypeSymbol.RequiresSymbolicProjection))
        {
            return false;
        }

        var openProp = ImportedMemberRefFactory.ResolvePropertyOnOpenDefinition(openDef, property);
        if (openProp == null)
        {
            return false;
        }

        substitutedReturn = MemberLookup.MapOpenClrTypeToSymbolic(openProp.PropertyType, openDef, typeArguments);
        return substitutedReturn != null && substitutedReturn != TypeSymbol.Error;
    }

    /// <summary>
    /// Issue #832 (mirrors the property variant above for instance method calls):
    /// when an instance method call's receiver is a symbolic open-generic
    /// container (e.g. <c>Queue[T]</c> with an in-scope <c>T</c>), the call's
    /// MemberRef parent is encoded as the symbolic generic instantiation, so
    /// the runtime stack value after <c>callvirt</c> is the substituted
    /// symbolic return type (<c>!T</c>) — NOT the closed CLR <c>object</c>
    /// that <see cref="MethodInfo.ReturnType"/> reports for the type-erased
    /// closed method. Returning that substituted return to the body emitter
    /// lets the erasure-widening short-circuit, avoiding a verifier-breaking
    /// (and runtime-crashing) <c>unbox.any T</c> when the result is discarded
    /// or otherwise consumed at the open-T slot.
    /// </summary>
    /// <param name="receiverType">The receiver's type as seen by the body emitter.</param>
    /// <param name="method">The closed-CLR method selected by the lowerer.</param>
    /// <param name="substitutedReturn">The substituted symbolic return type, on success.</param>
    /// <returns><see langword="true"/> when the receiver is a symbolic
    /// open-generic container and the substituted return resolves to a
    /// non-error symbolic type.</returns>
    internal bool TryGetSymbolicSubstitutedInstanceMethodReturn(
        TypeSymbol receiverType,
        MethodInfo method,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (method == null
            || !ImportedMemberRefFactory.TryNormalizeToSymbolicContainer(receiverType, out var openDef, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !typeArguments.Any(TypeSymbol.RequiresSymbolicProjection))
        {
            return false;
        }

        var openMethod = ImportedMemberRefFactory.ResolveMethodOnOpenDefinition(openDef, method);
        if (openMethod == null)
        {
            return false;
        }

        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return false;
        }

        substitutedReturn = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, openDef, typeArguments);
        return substitutedReturn != null && substitutedReturn != TypeSymbol.Error;
    }

    /// <summary>
    /// Issue #903: when a generic imported (extension) call — e.g. a LINQ
    /// <c>Single</c>/<c>First</c>/<c>Last</c> whose open return type is a bare
    /// method type parameter <c>TSource</c> — is closed over a
    /// same-compilation user element type (<c>List[Check].Single(…)</c> where
    /// <c>Check</c> is a <see cref="StructSymbol"/> struct/class still being
    /// compiled), <see cref="ImportedMemberRefFactory.GetMethodEntityHandle(MethodInfo, ImmutableArray{TypeSymbol})"/>
    /// encodes a MethodSpec whose type argument is the symbolic <c>Check</c>
    /// (via <see cref="ReflectionMetadataEmitter.ArgIsSymbolicUserDefined"/>). The emitted call therefore
    /// returns the reprojected element type directly on the stack — a raw
    /// <c>Check</c> value for a struct, a <c>Check</c> reference for a class —
    /// NOT the type-erased <c>object</c> that the placeholder-closed
    /// <see cref="MethodInfo.ReturnType"/> reports.
    /// <para>
    /// Without this guard the body emitter would feed that erased
    /// <c>object</c> placeholder into <c>EmitErasedObjectReturnWidening</c>,
    /// which for a value-type element emits a spurious <c>unbox.any Check</c>
    /// against a stack slot that already holds a <c>Check</c> value (ilverify
    /// <c>StackUnexpected</c>/<c>StackObjRef</c> and a runtime crash), and for
    /// a reference-type element emits a redundant <c>castclass</c>. Returning
    /// the substituted symbolic return lets the caller short-circuit the
    /// widening, exactly as the instance-method and property variants above do
    /// for symbolic open-generic containers.
    /// </para>
    /// </summary>
    /// <param name="method">The placeholder-closed generic method selected by overload resolution.</param>
    /// <param name="typeArgSymbols">The per-MVar symbolic type arguments carried by the bound call (issue #903 surfaces same-compilation user types here).</param>
    /// <param name="substitutedReturn">The reprojected symbolic return type, on success.</param>
    /// <returns><see langword="true"/> when the call's symbolic type arguments
    /// reproject the open return type to a same-compilation user type or an
    /// in-scope generic type parameter (issue #1445), so the erasure-widening
    /// must be skipped.</returns>
    internal bool TryGetSymbolicSubstitutedImportedCallReturn(
        MethodInfo method,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (method == null
            || !method.IsGenericMethod
            || typeArgSymbols.IsDefaultOrEmpty
            || !typeArgSymbols.Any(ReflectionMetadataEmitter.ArgIsSymbolicUserDefined))
        {
            return false;
        }

        var openMethod = method.IsGenericMethodDefinition ? method : method.GetGenericMethodDefinition();
        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return false;
        }

        // Map the open return signature through the symbolic method type
        // arguments only (no receiver/type-level substitution): a bare
        // `TSource` return resolves to the symbolic element type, while a
        // constructed `IEnumerable<TResult>` return resolves to a symbolic
        // instantiation. Either way, a projection that surfaces a
        // same-compilation user type OR an in-scope generic type parameter
        // means the MethodSpec deviates from the erased `object` placeholder
        // and the widening must be suppressed.
        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, null, default, openMethod, typeArgSymbols);
        if (mapped == null || mapped == TypeSymbol.Error)
        {
            return false;
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
        if (!TypeSymbol.ContainsSameCompilationUserType(mapped)
            && !TypeSymbol.ContainsTypeParameter(mapped))
        {
            return false;
        }

        substitutedReturn = mapped;
        return true;
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
    internal bool FunctionTypeNeedsSymbolicDelegate(FunctionTypeSymbol fnType)
    {
        if (fnType == null)
        {
            return false;
        }

        foreach (var param in fnType.ParameterTypes)
        {
            if (TypeSymbol.ContainsTypeParameter(param) || ReflectionMetadataEmitter.ArgIsSymbolicUserDefined(param))
            {
                return true;
            }
        }

        return TypeSymbol.ContainsTypeParameter(fnType.ReturnType)
            || ReflectionMetadataEmitter.ArgIsSymbolicUserDefined(fnType.ReturnType);
    }
}
