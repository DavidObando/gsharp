// <copyright file="ReflectionMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (PR-E-5: IsValueTypeSymbol was widened to internal in-place for ConversionEmitter; ordering is restored once Phase 2 decomposition finishes)
#pragma warning disable SA1304 // non-private readonly field naming — PR-E-11 widened several emitter-internal fields to internal so the promoted MethodBodyEmitter can read them; ordering/casing restored after E-12 root thinning
#pragma warning disable SA1307 // field naming casing — same as SA1304
#pragma warning disable SA1401 // field should be private — same as SA1304
#pragma warning disable SA1611 // parameter documentation missing — PR-E-11 widened internal helpers used by MethodBodyEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
/// </remarks>
internal sealed class ReflectionMetadataEmitter
{
    // Portable PDB metadata format version expected by all current readers
    // (System.Reflection.Metadata, dotnet-symbol, debuggers). 0x0100 = v1.0.
    private const ushort PortablePdbVersion = 0x0100;

    // PR-E-1: cross-cutting emit state (BoundProgram, ReferenceResolver,
    // MetadataBuilder, IL stream/encoder, assembly-identity overrides,
    // metadata-only flag, PDB plumbing, and the BCL core* Type cache) has
    // moved into EmitContext. Subsequent extraction PRs (MetadataTokenCache,
    // WellKnownReferences, SlotPlanner, …) will consume this same context
    // via constructor injection.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal readonly EmitContext emitCtx;

    // PR-E-2: every key→handle dictionary (assemblyRefs, typeRefs, typeSpecs,
    // methodRefs, methodSpecs, methodSpecsWithSymbolArgs, ctorRefs, fieldRefs,
    // functionHandles, methodHandles, structTypeDefs, structFieldDefs,
    // classCtorHandles, classPrimaryCtorHandles, explicitCtorHandles,
    // cctorHandles, interfaceTypeDefs, enumTypeDefs, enumMemberFieldDefs,
    // delegateTypeDefs, delegateInvokeHandles, delegateCtorHandles,
    // globalFieldDefs, propertyAccessorHandles, typesWithPropertyMap,
    // eventAccessorHandles, dataStructOpEqualityHandles) plus the single
    // systemRuntimeAssemblyRef handle and the MethodSpecSymbolKey structural
    // key have moved into MetadataTokenCache. Subsequent extraction PRs will
    // consume this same cache via constructor injection.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal readonly MetadataTokenCache cache;

    // PR-E-16: the generic type-parameter remap mutable state (the
    // outer-TP → own-slot remaps for reified state-machine / nested / closure
    // classes and generic-promoted lambdas, plus their push/pop scope
    // discipline) has moved into GenericRemapState. The root's registration
    // methods orchestrate over EmitContext/closures and call into this state
    // to record the remaps; EncodeTypeSymbol reads the active remap through it.
    internal readonly GenericRemapState remaps;

    // PR-E-17: the signature / type-encoding band (EncodeTypeSymbol /
    // EncodeClrType and their return / local-variable / function-pointer /
    // reified-delegate encoders, plus the host→reference-context CLR type
    // resolution that the reflection encoding path depends on —
    // ResolveDelegateClrType / ResolveAsyncDelegateClrType / MapToReferenceClrType)
    // has moved into SignatureEncoder. Back-bound to this root (the
    // MethodBodyEmitter idiom) because the band reaches emitCtx / cache /
    // remaps AND the user-token resolvers that only move in E-18/E-19
    // (GetTypeReference, ResolveUserStructTypeSpecArguments,
    // ResolveDelegateTypeArguments, the async-SM plans on stateMachines).
    // Constructed in the ctor alongside remaps; the many in-RME callers keep
    // compiling through the one-line forwarders below (repointed in E-21). The
    // collaborator-injection sites in EmitCore (EncodeTypeSymbol / EncodeClrType /
    // EncodeReturnSymbol delegates) rebind directly to signatures.*.
    internal readonly SignatureEncoder signatures;

    // PR-E-18: the imported / BCL member-and-type reference factory band
    // (GetTypeReference / GetMethodReference / GetCtorReference /
    // GetFieldReference, the element/typeof/assembly resolvers, the symbolic
    // nullable/tuple/map MemberRef families, and the reified Func/Action
    // delegate MemberRef producers). A near-pure move: the ref-cache
    // dictionaries it dedups against already live on MetadataTokenCache
    // (E-2). Constructed in the ctor alongside signatures; the many in-RME
    // callers keep compiling through the one-line forwarders below (repointed
    // in E-21).
    internal readonly ImportedMemberRefFactory memberRefs;

    // PR-E-19: the user-type token-resolution band (the user
    // struct/interface/delegate TypeSpec producers and their memoization
    // caches, the field/method/ctor MemberRef factories, the
    // property-accessor / static / instance / interface method-token
    // resolvers, the constructed-base ctor-token resolvers, the generic-user
    // MethodSpec builder and its structural type-argument unifier, the
    // non-capturing generic-lambda promotion, and the symbolic-substituted
    // return trio) has moved into UserTokenResolver. Back-bound to this root
    // (the SignatureEncoder / ImportedMemberRefFactory idiom) because the band
    // reaches emitCtx / cache / remaps / signatures / memberRefs AND a few
    // root-owned surfaces that stay put (the shared static predicates
    // IsUserGeneric*Reference / ArgIsSymbolicUserDefined, EncodeAsyncReturnType,
    // FindImportedMethod, the state-machine plans, wellKnown.ObjectCtorRef).
    // Constructed in the ctor after signatures + memberRefs (it uses both); the
    // many in-RME callers keep compiling through the one-line forwarders below
    // (repointed in E-21). The E-17 SignatureEncoder and E-18
    // ImportedMemberRefFactory couplings that used to point into this band
    // through the root now call userTokens directly.
    internal readonly UserTokenResolver userTokens;

    // PR-E-3: the well-known BCL MemberRef/TypeRef fields
    // (notImplementedExceptionCtorRef, delegateCombineRef/RemoveRef,
    // interlockedCompareExchangeOpenRef, isReadOnly/IsByRefLike/ObsoleteAttribute
    // ctor refs, objectTypeRef/valueTypeRef/objectCtorRef, stringConcatRef/
    // EqualsRef/ConcatArrayRef, objectStatic/InstanceXxxRef, nullRefException
    // CtorRef, convertToStringRef, cultureInvariantGetterRef, hashCodeTypeRef/
    // AddOpenRef/ToHashCodeRef/CombineOpenRefs[], systemAttribute Type/CtorRef)
    // and their paired Get* lazy initializers have moved into
    // WellKnownReferences. The lone StandaloneSignatureHandle hashCodeLocalSig
    // and its `GetHashCodeLocalSignature()` initializer were moved in PR-E-6
    // onto DataStructSynthesizer, where their sole users now live.
    // Not readonly because instantiation depends on EmitContext.Core* having
    // been resolved first — that happens during EmitCore, not the ctor.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal WellKnownReferences wellKnown;

    // PR-E-12: CustomAttributeEncoder — owns every helper that writes an
    // ECMA-335 II.23.3 custom-attribute value blob plus the per-attribute
    // orchestration (EmitBoundAttribute / EmitUserAttributes /
    // EmitStringAttribute / EmitIsReadOnlyAttributeOnParameter /
    // NextParameterHandle). Initialised in EmitCore alongside wellKnown
    // because it depends on GetTypeReference, which closes over
    // EmitContext.Core* materialised earlier in EmitCore.
    private CustomAttributeEncoder customAttrEncoder;

    // PR-E-13: AssemblyAttributeEmitter — owns the assembly-level attribute
    // orchestrators that used to sit on this root (EmitReferenceAssemblyAttribute /
    // EmitAssemblyInteropAttributes / EmitUserAssemblyAttributes /
    // EmitFriendAssemblyAttributes / EmitGSharpTypeSemantics /
    // EmitDebuggableAttribute / EmitNullableContextAttribute) plus
    // ParseAssemblyVersion, which feeds the Assembly row. Initialised in
    // EmitCore right after customAttrEncoder because it forwards blob writes
    // into that encoder and depends on wellKnown / GetTypeReference — same
    // EmitCore-ordering reason as the other E-* components.
    private AssemblyAttributeEmitter assemblyAttrs;

    // PR-E-14: InterfaceImplEmitter — owns the MethodImpl-row band that used
    // to close out this file (EmitExplicitInterfaceMethodImpls /
    // EmitExplicitInterfacePropertyMethodImpls /
    // EmitExplicitInterfaceEventMethodImpls / EmitStaticVirtualMethodImpls /
    // EmitStaticVirtualPropertyMethodImpls) plus the open-slot resolvers and
    // static-virtual signature matcher used only by that band. Back-bound to
    // this root (the MethodBodyEmitter idiom) for GetMethodReference /
    // ResolveUserInterfaceInstanceMethodToken / IsUserGenericInterfaceReference.
    private InterfaceImplEmitter interfaceImpls;

    // PR-E-15: ConstructorBodyEmitter — owns the constructor-body-bytes band
    // (EmitStaticConstructorBodyBytes / EmitInterfaceStaticConstructor /
    // EmitClassDefaultConstructorBodyBytes / EmitClassPrimaryConstructorBodyBytes /
    // EmitClassConstructorWithBaseInitializerBodyBytes /
    // EmitClassConstructorWithBodyBodyBytes / EmitClassDeinitializerBodyBytes)
    // plus the instance-field-initializer statement builders they share. The
    // five *BodyBytes helpers back the TypeDefEmitter body-emit callbacks;
    // EmitInterfaceStaticConstructor is invoked directly from EmitCore. Back-
    // bound to this root (the MethodBodyEmitter idiom) because the bodies
    // construct the still-private MethodBodyEmitSession scaffold and resolve
    // field tokens via ResolveFieldToken. The mutable static-ctor-owner flag
    // moved to EmitContext.CurrentStaticConstructorOwner (read by
    // IsStaticFieldAddressLegalHere).
    private ConstructorBodyEmitter ctorBodies;

    // Phase 4 emit parity (E1): synthesized lambda bodies (no captures).
    // Populated by a pre-pass walker over every user function/entry body.
    // Each lambda's synthetic FunctionSymbol is registered alongside user
    // functions in functionsByPackage so it gets a MethodDef row, and its
    // body is emitted via the same EmitFunction path.
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies = [];

    // Issue #1336: cached TypeSpec for the `unmanaged` constraint's
    // modreq-decorated System.ValueType GenericParamConstraint. Built lazily and
    // shared across every `where T : unmanaged` type parameter in the module.
    private EntityHandle unmanagedConstraintTypeSpec;

    // PR-E-9: closure-environment metadata and synthesized display classes
    // moved onto ClosureEmitter. Where this file used to declare:
    //   closureInfos                  -> closures.ClosureInfos
    //   goClosureInfos                -> closures.GoClosureInfos
    //   synthesizedClosureClasses     -> closures.SynthesizedClosureClasses
    //   closureInvokeToInfo           -> closures.ClosureInvokeToInfo
    //   closureCounter                -> closures.Counter
    // The state-machine synthesizers below moved onto StateMachineEmitter in
    // PR-E-10; this file still mutates closures.SynthesizedClosureClasses and
    // closures.Counter from inside StateMachineEmitter via the closures
    // back-reference.

    // PR-E-10: state-machine caches and plans moved onto StateMachineEmitter.
    // Where this file used to declare:
    //   iteratorKickoffBodies         -> stateMachines.IteratorKickoffBodies
    //   iteratorStateMachineInfos     -> stateMachines.IteratorStateMachineInfos
    //   asyncStateMachinePlans        -> stateMachines.AsyncStateMachinePlans
    //   iteratorPlans                 -> stateMachines.IteratorPlans
    //   asyncIteratorPlans            -> stateMachines.AsyncIteratorPlans
    //   asyncIteratorInfos            -> stateMachines.AsyncIteratorInfos
    //   asyncIteratorEmitContexts     -> stateMachines.AsyncIteratorEmitContexts
    //   asyncSmEnclosingClosures      -> stateMachines.AsyncSmEnclosingClosures
    // BodyEmitter reads stateMachines.AsyncIteratorEmitContexts for the async
    // iterator MoveNext path; the remaining 2 BodyEmitter-internal SM helpers
    // (EmitStateMachineAwaitOnCompleted, EmitAsyncIteratorBuilderMoveNext)
    // still live inside BodyEmitter and call back into
    // stateMachines.EmitAwaitOnCompletedCall — they move with BodyEmitter in
    // PR-E-11 MethodBodyEmitter.

    // PR-E-1: debugInformation, pdbStream, pdb moved onto EmitContext.

    // PR-E-1: the BCL core* Type fields (coreObjectType, coreStringType,
    // coreInt32Type, coreBooleanType, coreArrayType, coreValueType,
    // coreSystemType, coreRuntimeTypeHandleType, coreEnumType,
    // coreMulticastDelegateType, coreIntPtrType) moved onto EmitContext.
    // PR-E-3: objectTypeRef, valueTypeRef, objectCtorRef,
    // stringConcatRef/EqualsRef, objectStaticEqualsRef,
    // objectInstanceToStringRef/GetHashCodeRef, nullRefExceptionCtorRef,
    // stringConcatArrayRef, convertToStringRef, cultureInvariantGetterRef,
    // hashCodeAddOpenRef/ToHashCodeRef, hashCodeCombineOpenRefs[],
    // hashCodeTypeRef, systemAttributeTypeRef/CtorRef moved onto
    // WellKnownReferences.
    // PR-E-6: hashCodeLocalSig moved onto DataStructSynthesizer alongside
    // its sole user (GetHashCodeLocalSignature).

    // PR-E-4: SlotPlanner owns the slot-allocator BoundTreeWalker collectors
    // (16 of them) and the SelectSlots value object they populate. The slot
    // dictionaries themselves remain per-method-emit and stay on BodyEmitter /
    // are passed into SlotPlanner entry points as arguments; SlotPlanner does
    // not depend on this emitter — it takes its two RME-flavored dependencies
    // (the MetadataTokenCache for GlobalFieldDefs lookups, and the
    // NeedsRvalueReceiverSpill predicate) via constructor injection.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal readonly SlotPlanner slotPlanner;

    // PR-E-12: MethodBodyPlanner — the per-body planning surface that drives
    // SlotPlanner's collector classes. Owns CollectLocalsAndLabels /
    // CollectStatements / CollectPatternSwitchSlots / Walk* /
    // RegisterConstructedTypeAliases / CollectConstValues /
    // CollectLocalInfo / CollectLocalConstantInfo / Add{,Async}IteratorInterfaceImplementations /
    // GetSmPackage / TryGetUserKickoffReceiverHandle. Initialised in EmitCore
    // alongside the other E-* components so its StateMachineEmitter back-ref
    // can be wired after stateMachines is constructed. Not readonly for the
    // same EmitCore-ordering reason as memberDefEmitter / dataStructSynth /
    // wellKnown.
    private MethodBodyPlanner methodBodyPlanner;

    // PR-E-5: SlotPlanner's sibling — ConversionEmitter — owns conversion-
    // shaped IL emission. In this PR it hosts the two stateless top-level
    // helpers (EmitBoxIfNeeded, EmitDefaultValue) that take an
    // InstructionEncoder by parameter. The BodyEmitter-internal conversion
    // methods (EmitConversion, EmitErasedObjectReturnWidening,
    // EmitNarrowingTruncationIfNeeded, EmitSubI4Truncation, EmitDefault,
    // EmitClrConversionCall, EmitZeroInit) remain on BodyEmitter for now;
    // they call back into closure-emit helpers slated for E-9
    // ClosureEmitter, and BodyEmitter itself is promoted to a top-level
    // type with a MethodBodyEmitter.Conversions.cs partial in E-11
    // MethodBodyEmitter. Both motions land cleanly in E-11; bringing them
    // forward here would require widening BodyEmitter's private surface
    // only to take it apart again two PRs later.
    // Not readonly because instantiation depends on EmitContext.Core* /
    // wellKnown / GetElementTypeToken closing over fields that are only
    // valid after EmitCore has resolved the BCL core types — mirrors the
    // wellKnown pattern.
    private ConversionEmitter conversionEmitter;

    // PR-E-6: DataStructSynthesizer — sibling of ConversionEmitter — owns
    // IL emission for ADR-0029 `data struct` synthesized members
    // (Equals(object)/Equals(T), GetHashCode, ToString, op_Equality/
    // op_Inequality, Deconstruct) plus the `inline struct` single-field
    // counterparts and the inline-struct primary constructor. Unlike the
    // ConversionEmitter case (PR-E-5 Option B), every method moved here
    // was a top-level private on this emitter — none lived inside the
    // nested BodyEmitter — so the extraction is a clean Option-A move.
    // The shared DataStructOpEqualityHandles dictionary stays on
    // MetadataTokenCache; this component reads/writes it through
    // `cache.DataStructOpEqualityHandles`.
    // Not readonly for the same EmitCore-ordering reason as
    // ConversionEmitter / wellKnown.
    private DataStructSynthesizer dataStructSynth;

    // PR-E-7: MemberDefEmitter — sibling of DataStructSynthesizer — owns
    // IL emission for property and event accessor MethodDefs plus the
    // PropertyDef/EventDef/PropertyMap/EventMap/MethodSemantics rows that
    // link them to their owning TypeDef. Covers instance, static, and
    // interface variants for both properties and events. Like
    // DataStructSynthesizer, every method moved here was a top-level
    // private on this emitter — none lived inside the nested BodyEmitter —
    // so the extraction is a clean Option-A move. The shared
    // PropertyAccessorHandles / EventAccessorHandles / TypesWithPropertyMap
    // collections stay on MetadataTokenCache; this component reads/writes
    // them through `cache.*`. The four PR-E-7 private helpers
    // (PropertyImplicitlyImplementsInterface, EventImplicitlyImplementsInterface,
    // GetEventTypeHandle, GetInterlockedCompareExchangeSpec) all moved with
    // it because their callers were exclusively the 15 accessor-emit methods.
    // Not readonly for the same EmitCore-ordering reason as
    // ConversionEmitter / dataStructSynth / wellKnown.
    private MemberDefEmitter memberDefEmitter;

    // PR-E-8: TypeDefEmitter — owns IL/metadata emission for the TypeDef and
    // constructor surface of every user-defined aggregate (struct, class,
    // interface, enum, delegate) plus the assembly-level synthesized default
    // constructor used by closure / state-machine classes. Like its peers it
    // depends on EmitContext / MetadataTokenCache / WellKnownReferences and
    // consumes the remaining root-emitter helpers it needs (EncodeTypeSymbol,
    // EncodeReturnSymbol, GetTypeReference, NextParameterHandle,
    // EmitUserAttributes, EmitIsReadOnlyAttributeOnParameter,
    // GetCtorReference) as delegate callbacks. For the three constructor
    // methods that drive the still-private BodyEmitter nested class
    // (EmitStaticConstructor, EmitClassConstructorWithBaseInitializer,
    // EmitClassConstructorWithBody), the body-emission step is reached via
    // injected Func callbacks bound to the *BodyBytes helpers below; those
    // helpers stay adjacent to BodyEmitter until PR-E-11 promotes the whole
    // nested class to its own file. As of PR-E-12 the accessibility-map
    // helpers (MapTypeAccessibility / MapFieldAccessibility / etc.) live in
    // AccessibilityMap.cs — both this root and TypeDefEmitter call into that
    // single canonical home.
    // Not readonly for the same EmitCore-ordering reason as
    // memberDefEmitter / dataStructSynth / wellKnown.
    private TypeDefEmitter typeDefEmitter;

    // PR-E-9: ClosureEmitter — owns the closure-environment metadata,
    // display-class synthesis (SynthesizeClosures / SynthesizeGoClosures /
    // SynthesizeDisplayClass), and the nested ClosureInfo / CaptureRewriter /
    // ConstructedTypeCollector helpers. Constructor-injected with a shared
    // reference to this.lambdaBodies so the synthesis path can register the
    // rewritten lambda body for every closure-Invoke method without a hard
    // back-reference to this root emitter. Wired in EmitCore after wellKnown
    // is materialised (SlotPlanner already exists from the ctor; lambdaBodies
    // is a field initializer). Not readonly because EmitCore is the
    // construction site, mirroring the conversionEmitter / dataStructSynth /
    // memberDefEmitter / typeDefEmitter pattern. The BodyEmitter-internal
    // closure-emit methods (EmitFunctionLiteral, EmitMethodGroup,
    // EmitFunctionToDelegateConversion, EmitCapturedVariableLoad,
    // EmitClrEventSubscription, EmitUserEventSubscription, etc.) stay on
    // BodyEmitter and move with it in PR-E-11; this is the same Option B
    // playbook PR-E-5 ConversionEmitter used.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal ClosureEmitter closures;

    // PR-E-10: StateMachineEmitter — sibling of ClosureEmitter — owns
    // async/iterator state-machine synthesis (SynthesizeIteratorStateMachines /
    // SynthesizeAsyncIteratorStateMachines / SynthesizeAsyncLambdaStateMachines)
    // and the top-level MoveNext / SetStateMachine / AwaitOnCompleted /
    // async-kickoff IL emission, plus the nested StateMachineEmitter.IteratorStateMachineInfo /
    // StateMachineEmitter.AsyncIteratorEmitContext helpers and every SM cache/plan
    // (IteratorKickoffBodies, IteratorStateMachineInfos, AsyncStateMachinePlans,
    // IteratorPlans, AsyncIteratorPlans, AsyncIteratorInfos,
    // AsyncIteratorEmitContexts, AsyncSmEnclosingClosures). The 2 BodyEmitter-
    // internal SM helpers (EmitStateMachineAwaitOnCompleted,
    // EmitAsyncIteratorBuilderMoveNext) still live inside BodyEmitter and
    // call back into stateMachines.EmitAwaitOnCompletedCall — they move with
    // BodyEmitter in PR-E-11 MethodBodyEmitter. The BodyEmitter-driven
    // portion of EmitStateMachineMoveNext is reached via the
    // EmitMoveNextBodyBytes callback (same callback pattern PR-E-8
    // TypeDefEmitter used for the three constructor body-emit helpers).
    // Not readonly because EmitCore is the construction site, mirroring the
    // wellKnown / conversionEmitter / dataStructSynth / memberDefEmitter /
    // typeDefEmitter / closures pattern.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal StateMachineEmitter stateMachines;

    // Issue #2118: per-lambda-function ordered ORIGINAL enclosing type
    // parameters used as the MethodSpec type arguments when the lambda is
    // referenced (`ldftn <lambda><...enclosing args...>`) at its delegate
    // materialization site. The paired enclosing-TP → own-clone-ordinal remap
    // (which drives EncodeTypeSymbol) lives on GenericRemapState; this ordered
    // list is a delegate-materialization-token concern, not remap-scope state,
    // so it stays on the root.
    internal readonly Dictionary<FunctionSymbol, ImmutableArray<TypeParameterSymbol>> lambdaMethodTypeArgsByFunction =
        new Dictionary<FunctionSymbol, ImmutableArray<TypeParameterSymbol>>(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// Issue #1465: reifies an async state-machine struct over an
    /// ordinal-aligned copy of the type parameters in scope at its kickoff
    /// method — the enclosing generic type's parameters first, then the
    /// kickoff method's own type parameters (Roslyn ordering). References to
    /// those parameters inside MoveNext / hoisted-field signatures then encode
    /// as the SM type's own <c>ELEMENT_TYPE_VAR</c> slots, and references to
    /// the SM type from the kickoff method self-instantiate as
    /// <c>SM&lt;!0,…&gt;</c> using the enclosing type's parameters.
    /// </summary>
    /// <param name="smStruct">The materialized state-machine struct.</param>
    /// <param name="kickoff">The async kickoff method.</param>
    private void RegisterStateMachineEnclosingGenerics(StructSymbol smStruct, FunctionSymbol kickoff)
    {
        var receiverDef = kickoff?.ReceiverType is StructSymbol receiver
            ? (receiver.Definition ?? receiver)
            : null;
        var classTPs = receiverDef?.TypeParameters ?? ImmutableArray<TypeParameterSymbol>.Empty;
        var methodTPs = kickoff == null || kickoff.TypeParameters.IsDefaultOrEmpty
            ? ImmutableArray<TypeParameterSymbol>.Empty
            : kickoff.TypeParameters;

        if (classTPs.IsDefaultOrEmpty && methodTPs.IsDefaultOrEmpty)
        {
            return;
        }

        var total = classTPs.Length + methodTPs.Length;
        var origCombined = ImmutableArray.CreateBuilder<TypeParameterSymbol>(total);
        origCombined.AddRange(classTPs);
        origCombined.AddRange(methodTPs);

        // Issue #1499: remap self-/cross-referential constraints from the
        // enclosing parameters onto the state machine's cloned set.
        var smTPs = SynthesizedClosureReifier.CloneWithRemappedConstraints(origCombined.MoveToImmutable());
        var remap = new Dictionary<TypeParameterSymbol, int>(total);
        var ordinal = 0;
        foreach (var src in classTPs)
        {
            remap[src] = ordinal;
            ordinal++;
        }

        foreach (var src in methodTPs)
        {
            remap[src] = ordinal;
            ordinal++;
        }

        // Issue #2180: when the async state machine nests inside a synthesized
        // closure that was itself reified over an enclosing generic method /
        // type (`RunG[T]`'s `T`), the receiver's own type parameters (`T`
        // cloned onto the closure) are 1:1 with the ORIGINAL enclosing
        // parameters recorded on ReifiedFromTypeParameters. The MoveNext body
        // still references those originals — e.g. the capture-box type argument
        // `<>__Box_val_1[T]` carries `RunG`'s `T`, not the closure's clone — so
        // without an entry keyed by the original parameter, EncodeTypeSymbol
        // falls through to `MVar(idx)` (a method type-variable with no slot in
        // MoveNext), producing malformed metadata (BadImageFormatException at
        // runtime). Map each original enclosing parameter to the SM class slot
        // its clone occupies. Real user receivers have an empty reified list,
        // so this is a no-op there.
        var reifiedFrom = receiverDef?.ReifiedFromTypeParameters ?? ImmutableArray<TypeParameterSymbol>.Empty;
        if (!reifiedFrom.IsDefaultOrEmpty && reifiedFrom.Length == classTPs.Length)
        {
            for (var i = 0; i < reifiedFrom.Length; i++)
            {
                remap[reifiedFrom[i]] = i;
            }
        }

        smStruct.SetTypeParameters(smTPs);
        this.remaps.RegisterClassRemap(smStruct, remap);
    }

    // Issue #1467 / #1537: reifies every user-declared type nested inside a
    // generic type over an ordinal-aligned clone of the flattened enclosing +
    // own type-parameter list (ECMA-335 §II.10.3.1): the enclosing parameters
    // occupy the low ordinals `0..k-1` (outermost first), the nested type's OWN
    // parameters are re-ordinalized to `k..k+m-1`. A per-class remap translates
    // every reference to an original enclosing/own parameter (whose declared
    // ordinal no longer matches its reified slot) into the correct `VAR(idx)`.
    // A nested type with no own parameters (`Box[T].Tag`) reifies to arity `k`
    // (issue #1467); one that declares its own (`Outer[U].Middle[T]`) reifies to
    // arity `k + m` (`Outer`1+Middle`2`, issue #1537).
    private void RegisterNestedTypeEnclosingGenerics()
    {
        // Snapshot every type's ORIGINAL own type parameters before any
        // reification mutates them, so a DEEPER nested type collects its
        // enclosing types' ORIGINAL parameters (not the reified clones) no
        // matter the processing order.
        var originalOwnParams = new Dictionary<StructSymbol, ImmutableArray<TypeParameterSymbol>>(ReferenceEqualityComparer.Instance);
        foreach (var s in this.emitCtx.Program.Structs)
        {
            var def = s.Definition ?? s;
            if (!originalOwnParams.ContainsKey(def))
            {
                originalOwnParams[def] = def.TypeParameters;
            }
        }

        foreach (var s in this.emitCtx.Program.Structs)
        {
            if (s.ContainingType is not StructSymbol)
            {
                continue;
            }

            var enclosing = CollectOriginalEnclosingTypeParameters(s, originalOwnParams);
            if (enclosing.IsDefaultOrEmpty)
            {
                continue;
            }

            var def = s.Definition ?? s;
            var own = originalOwnParams.TryGetValue(def, out var snapshot) ? snapshot : def.TypeParameters;

            var combined = ImmutableArray.CreateBuilder<TypeParameterSymbol>(
                enclosing.Length + (own.IsDefaultOrEmpty ? 0 : own.Length));
            combined.AddRange(enclosing);
            if (!own.IsDefaultOrEmpty)
            {
                combined.AddRange(own);
            }

            var combinedList = combined.ToImmutable();

            // Issue #1499: remap self-/cross-referential constraints onto the
            // nested type's cloned combined-parameter set.
            s.SetTypeParameters(SynthesizedClosureReifier.CloneWithRemappedConstraints(combinedList));

            // Record the enclosing arity so a use site can split its combined
            // type-argument vector into enclosing/own halves.
            this.remaps.SetNestedTypeEnclosingArity(def, enclosing.Length);

            // Build the original-parameter -> reified-slot remap so member
            // signatures/bodies encode the correct VAR(idx). An enclosing
            // parameter of a single generic level keeps its ordinal (remap is a
            // no-op then); a re-ordinalized own parameter or an enclosing
            // parameter of a DEEPER level (whose ordinals collide) is translated.
            var remap = new Dictionary<TypeParameterSymbol, int>(combinedList.Length);
            for (var i = 0; i < combinedList.Length; i++)
            {
                remap[combinedList[i]] = i;
            }

            this.remaps.RegisterClassRemap(s, remap);
        }
    }

    // Issue #1537: gathers the flattened ORIGINAL generic parameters of every
    // enclosing type of <paramref name="nested"/>, in CLR order (outermost
    // first), reading each enclosing type's pre-reification parameters from
    // <paramref name="originalOwnParams"/> so a deeply-nested type sees the
    // originals even after an intermediate enclosing type has been reified.
    private static ImmutableArray<TypeParameterSymbol> CollectOriginalEnclosingTypeParameters(
        StructSymbol nested,
        Dictionary<StructSymbol, ImmutableArray<TypeParameterSymbol>> originalOwnParams)
    {
        List<ImmutableArray<TypeParameterSymbol>> levels = null;
        for (var c = nested.ContainingType as StructSymbol; c != null; c = c.ContainingType as StructSymbol)
        {
            var def = c.Definition ?? c;
            var tps = originalOwnParams.TryGetValue(def, out var snapshot) ? snapshot : def.TypeParameters;
            if (!tps.IsDefaultOrEmpty)
            {
                levels ??= new List<ImmutableArray<TypeParameterSymbol>>();

                // Prepend so the outermost enclosing type's parameters come first.
                levels.Insert(0, tps);
            }
        }

        if (levels == null)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<TypeParameterSymbol>();
        foreach (var level in levels)
        {
            builder.AddRange(level);
        }

        return builder.ToImmutable();
    }

    // Issue #1477: builds the outer-TP → own-TP-ordinal remap for every
    // synthesized closure / capture-box class that was reified generic over its
    // enclosing type parameters (SynthesizedClosureReifier records the original
    // referenced parameters on ReifiedFromTypeParameters in declaration order,
    // 1:1 with the class's own freshly cloned parameters). Registering the
    // remap on the shared state-machine remap channel makes EncodeTypeSymbol
    // translate every enclosing-type-parameter reference in a capture field /
    // Invoke signature into the synthesized class's own VAR(idx) slot.
    private void RegisterSynthesizedClosureReifiedGenerics()
    {
        void Register(StructSymbol s)
        {
            var origTPs = s.ReifiedFromTypeParameters;
            if (origTPs.IsDefaultOrEmpty)
            {
                return;
            }

            var remap = new Dictionary<TypeParameterSymbol, int>(origTPs.Length);
            for (var i = 0; i < origTPs.Length; i++)
            {
                remap[origTPs[i]] = i;
            }

            this.remaps.RegisterClassRemap(s, remap);
        }

        foreach (var s in this.emitCtx.Program.Structs)
        {
            Register(s);
        }

        foreach (var s in this.closures.SynthesizedClosureClasses)
        {
            Register(s);
        }
    }

    /// <summary>
    /// Issue #2123: eagerly resolves the interface-constraint handles of the
    /// <c>GenericParam</c> rows added for a synthesized closure / capture-box /
    /// reified class since <paramref name="gpRowStart"/>, while that class's
    /// enclosing-TP → own-<c>VAR(idx)</c> remap
    /// (<see cref="GenericRemapState.ActiveIteratorStateMachineRemap"/>) is still active.
    /// </summary>
    /// <remarks>
    /// A class reified generic over its enclosing type parameters
    /// (<see cref="SynthesizedClosureReifier.Reify"/>) carries type-parameter
    /// constraints that still textually reference the ORIGINAL enclosing type
    /// parameters: <see cref="SynthesizedClosureReifier.CloneWithRemappedConstraints"/>
    /// cannot rewrite an imported constructed-generic constraint such as
    /// <c>IComparable[T]</c> (its <see cref="ImportedTypeSymbol"/> substitution
    /// leaves the original symbolic argument in place). The deferred
    /// <c>GenericParamConstraint</c> rows would otherwise be resolved at flush
    /// time — after the remap is gone — encoding the enclosing METHOD type
    /// parameter as <c>!!0</c> (MVar) instead of this class's own <c>!0</c>
    /// (Var). That mismatch makes the class's constraint unsatisfiable, so the
    /// <c>constrained.</c> interface call inside a capturing lambda's
    /// display-class <c>Invoke</c> fails verification
    /// (<c>StackUnexpected</c>). Resolving here, with the remap active, encodes
    /// the class's own <c>Var</c> slot. Mirrors the #2118 non-capturing method
    /// path (which resolves against <see cref="GenericRemapState.ActiveLambdaMethodTypeParamRemap"/>).
    /// No-op when no reified-class remap is active (unregistered class).
    /// </remarks>
    /// <param name="gpRowStart">The <c>PendingGenericParameters</c> count captured before the class's TypeDef was emitted.</param>
    private void PreResolveReifiedGenericConstraints(int gpRowStart)
    {
        if (this.remaps.ActiveIteratorStateMachineRemap == null)
        {
            return;
        }

        var pendingRows = this.emitCtx.PendingGenericParameters;
        for (var gi = gpRowStart; gi < pendingRows.Count; gi++)
        {
            var gpRow = pendingRows[gi];
            if (gpRow.InterfaceConstraintType != null && gpRow.PreResolvedConstraintHandle == null)
            {
                pendingRows[gi] = gpRow with
                {
                    PreResolvedConstraintHandle = this.GetElementTypeToken(gpRow.InterfaceConstraintType),
                };
            }
        }
    }

    private ReflectionMetadataEmitter(BoundProgram program, ReferenceResolver references, string assemblyName, bool metadataOnly)
    {
        this.emitCtx = new EmitContext(program, references, assemblyName, metadataOnly);
        this.cache = new MetadataTokenCache();
        this.remaps = new GenericRemapState();
        this.signatures = new SignatureEncoder(this);
        this.memberRefs = new ImportedMemberRefFactory(this);
        this.userTokens = new UserTokenResolver(this);
        this.slotPlanner = new SlotPlanner(this.emitCtx, this.cache, this.NeedsRvalueReceiverSpill);
    }

    // PR-E-17: transitional forwarders into the extracted SignatureEncoder.
    // The signature/type-encoding band moved to SignatureEncoder; these
    // one-line forwarders keep the ~90 untouched in-RME call sites (and the
    // external `outer.<Encode…>` call sites in MethodBodyEmitter.*) compiling
    // without touching them now. The E-21 cleanup repoints those call sites to
    // `signatures.*` and deletes these forwarders. The collaborator-injection
    // delegates in EmitCore (EncodeTypeSymbol / EncodeReturnSymbol / EncodeClrType)
    // are rebound directly to `signatures.*` — they do not use these forwarders.
    internal void EncodeTypeSymbol(SignatureTypeEncoder encoder, TypeSymbol type)
        => this.signatures.EncodeTypeSymbol(encoder, type);

    internal void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type, RefKind returnRefKind)
        => this.signatures.EncodeReturnSymbol(encoder, type, returnRefKind);

    internal void EncodeReturnClr(ReturnTypeEncoder encoder, ParameterInfo returnParameter, Type type)
        => this.signatures.EncodeReturnClr(encoder, returnParameter, type);

    internal void EncodeClrType(SignatureTypeEncoder encoder, Type type)
        => this.signatures.EncodeClrType(encoder, type);

    internal void EncodeLocalVariableType(LocalVariableTypeEncoder enc, TypeSymbol t)
        => this.signatures.EncodeLocalVariableType(enc, t);

    internal void EncodeFunctionTypeSymbol(SignatureTypeEncoder encoder, FunctionTypeSymbol fnType)
        => this.signatures.EncodeFunctionTypeSymbol(encoder, fnType);

    internal StandaloneSignatureHandle GetFunctionPointerCallSiteSignature(FunctionPointerTypeSymbol fnPtr)
        => this.signatures.GetFunctionPointerCallSiteSignature(fnPtr);

    internal Type ResolveTargetDelegateClrType(Type hostDelegate)
        => this.signatures.ResolveTargetDelegateClrType(hostDelegate);

    internal Type ResolveDelegateClrType(FunctionTypeSymbol fnType)
        => this.signatures.ResolveDelegateClrType(fnType);

    internal Type ResolveAsyncDelegateClrType(FunctionTypeSymbol fnType, FunctionSymbol function)
        => this.signatures.ResolveAsyncDelegateClrType(fnType, function);

    internal Type MapToReferenceClrType(Type hostType)
        => this.signatures.MapToReferenceClrType(hostType);

    /// <summary>
    /// Emits <paramref name="program"/> to <paramref name="peStream"/> as a
    /// managed PE.
    /// </summary>
    /// <param name="program">The bound program to emit.</param>
    /// <param name="peStream">Destination stream for the PE bytes.</param>
    /// <param name="references">
    /// Reference resolver providing the target framework's core types
    /// (<c>System.Object</c>, <c>System.String</c>) and any user-supplied
    /// imports. Pass <c>null</c> to resolve from the gsc host's loaded
    /// runtime (in-process scenarios only — produces an assembly bound to
    /// the gsc host's TFM).
    /// </param>
    /// <param name="assemblyName">
    /// Optional override for the assembly identity (module + assembly rows).
    /// When <c>null</c>, the entry-point package's name is used. Supplied by
    /// the SDK BuildTask from MSBuild's <c>AssemblyName</c>.
    /// </param>
    /// <param name="metadataOnly">
    /// When true, emits a metadata-only reference assembly: method bodies
    /// are omitted (RVA 0) and the assembly is marked with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute</c>.
    /// </param>
    /// <param name="asyncRewriteResult">
    /// Optional result from the async state-machine rewriter. When non-null,
    /// contains plans for emitting state-machine types and kickoff bodies.
    /// </param>
    /// <param name="iteratorRewriteResult">
    /// Optional result from the iterator rewriter. When non-null, contains plans
    /// for emitting iterator state-machine types and kickoff bodies.
    /// </param>
    /// <param name="asyncIteratorRewriteResult">
    /// Optional result from the async iterator rewriter. When non-null, contains plans
    /// for emitting async iterator state-machine types and kickoff bodies.
    /// </param>
    /// <param name="debugInformation">
    /// Phase 3 (ADR-0027 §7.7a) PDB-related emit options. When <see langword="null"/>
    /// or when <see cref="DebugInformationOptions.Format"/> is
    /// <see cref="DebugInformationFormat.None"/> the emitter behaves exactly as
    /// it did before Phase 3 (no PDB sidecar, no <c>DebugDirectory</c> entries).
    /// The actual production of PDB content lands across Phases 4–7; Phase 3
    /// only plumbs the option onto the emitter so subsequent phases can consume
    /// it without further signature churn.
    /// </param>
    /// <param name="pdbStream">
    /// Optional destination for the Portable PDB sidecar stream. Only consumed
    /// when <paramref name="debugInformation"/> requests
    /// <see cref="DebugInformationFormat.Portable"/>; ignored in every other
    /// configuration. Plumbed here so callers can open the file once and have
    /// the emitter write to it directly without intermediate buffering.
    /// </param>
    /// <param name="assemblyVersion">
    /// Optional informational version string. When non-null, emitted as
    /// <c>AssemblyInformationalVersionAttribute</c> on the assembly so NuGet
    /// and consumer tooling can display the package version.
    /// </param>
    public static void Emit(
        BoundProgram program,
        Stream peStream,
        ReferenceResolver references = null,
        string assemblyName = null,
        bool metadataOnly = false,
        AsyncStateMachineRewriteResult asyncRewriteResult = null,
        IteratorRewriteResult iteratorRewriteResult = null,
        Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult = null,
        DebugInformationOptions debugInformation = null,
        Stream pdbStream = null,
        string assemblyVersion = null)
    {
        var emitter = new ReflectionMetadataEmitter(program, references, assemblyName, metadataOnly);
        emitter.emitCtx.AssemblyVersionOverride = assemblyVersion;

        emitter.emitCtx.DebugInformation = debugInformation ?? new DebugInformationOptions();
        emitter.emitCtx.PdbStream = pdbStream;

        emitter.EmitCore(peStream, asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult);
    }

    private void EmitCore(
        Stream peStream,
        AsyncStateMachineRewriteResult asyncRewriteResult = null,
        IteratorRewriteResult iteratorRewriteResult = null,
        Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult = null)
    {
        // Phase 4 (ADR-0027 §7.7a): instantiate the Portable PDB collaborator
        // before any method body is emitted, but only when the caller asked
        // for portable PDBs or for embedded PDBs (Phase 7). Sidecar emission
        // additionally requires a destination stream; embedded emission does
        // not because the blob is written into the PE itself. Leaving
        // `this.emitCtx.Pdb` null in every other configuration is what keeps the
        // legacy emit path bit-for-bit identical.
        var format = this.emitCtx.DebugInformation.Format;
        var needsPdb = (format == DebugInformationFormat.Portable && this.emitCtx.PdbStream != null)
            || format == DebugInformationFormat.Embedded;
        if (needsPdb)
        {
            this.emitCtx.Pdb = new PortablePdbEmitter(this.emitCtx.DebugInformation);

            // #217: Wire per-file import information so the PDB emitter can
            // produce per-tree ImportScope rows. Group only the explicit
            // (user-written) imports — implicit ones have a null Declaration
            // and therefore no syntax-tree anchor.
            var importsGrouped = new Dictionary<SyntaxTree, ImmutableArray<ImportSymbol>>();
            foreach (var import in this.emitCtx.Program.Imports)
            {
                var tree = import.Declaration?.SyntaxTree;
                if (tree is null)
                {
                    continue;
                }

                if (!importsGrouped.TryGetValue(tree, out var list))
                {
                    list = ImmutableArray<ImportSymbol>.Empty;
                }

                importsGrouped[tree] = list.Add(import);
            }

            this.emitCtx.Pdb.SetImportsPerTree(importsGrouped);

            // Wire per-reference metadata so the PDB emitter can produce the
            // CompilationMetadataReferences CDI blob (issue #219).
            this.emitCtx.Pdb.SetReferenceInfos(this.emitCtx.References.GetReferenceInfos());
        }

        // 1. Seed Object reference. Resolve from the supplied references so the type-ref
        //    assembly identity (mscorlib / System.Runtime / netstandard) matches the
        //    target framework rather than the gsc host's System.Private.CoreLib.
        this.emitCtx.CoreObjectType = this.ResolveCoreType("System.Object", typeof(object));
        this.emitCtx.CoreStringType = this.ResolveCoreType("System.String", typeof(string));
        this.emitCtx.CoreInt32Type = this.ResolveCoreType("System.Int32", typeof(int));
        this.emitCtx.CoreBooleanType = this.ResolveCoreType("System.Boolean", typeof(bool));
        this.emitCtx.CoreArrayType = this.ResolveCoreType("System.Array", typeof(System.Array));
        this.emitCtx.CoreValueType = this.ResolveCoreType("System.ValueType", typeof(System.ValueType));
        this.emitCtx.CoreSystemType = this.ResolveCoreType("System.Type", typeof(System.Type));
        this.emitCtx.CoreRuntimeTypeHandleType = this.ResolveCoreType("System.RuntimeTypeHandle", typeof(System.RuntimeTypeHandle));

        // Issue #2373: needed to materialise a runtime MethodInfo for a CLR
        // operator method (op_Equality, op_Addition, ...) passed as an
        // Expression factory argument (Expression.Equal(l, r, liftToNull,
        // method), Expression.Add(l, r, method), ...) — see
        // WellKnownReferences.GetMethodFromHandleReference /
        // GetMethodFromHandleWithDeclaringTypeReference.
        this.emitCtx.CoreRuntimeMethodHandleType = this.ResolveCoreType("System.RuntimeMethodHandle", typeof(System.RuntimeMethodHandle));
        this.emitCtx.CoreMethodBaseType = this.ResolveCoreType("System.Reflection.MethodBase", typeof(System.Reflection.MethodBase));
        this.emitCtx.CoreEnumType = this.ResolveCoreType("System.Enum", typeof(System.Enum));
        // ADR-0059 / issue #255: cache the base type and `IntPtr` parameter
        // type for user-declared named delegate emission.
        this.emitCtx.CoreMulticastDelegateType = this.ResolveCoreType("System.MulticastDelegate", typeof(System.MulticastDelegate));
        this.emitCtx.CoreIntPtrType = this.ResolveCoreType("System.IntPtr", typeof(nint));

        // PR-E-3: WellKnownReferences depends on EmitContext.Core* and on the
        // dedup-cached GetTypeReference / GetMethodReference resolvers that
        // still live on this emitter. Its ctor eagerly resolves the three
        // refs the rest of EmitCore needs immediately (Object/ValueType
        // TypeRefs, Object..ctor MemberRef); every other well-known ref is
        // lazily materialised on first access via its paired Get* method.
        this.wellKnown = new WellKnownReferences(this.emitCtx, this.GetTypeReference, this.GetMethodReference);

        // PR-E-12: CustomAttributeEncoder depends on GetTypeReference (the
        // dedup-cached root resolver) and wellKnown's GetIsReadOnlyAttributeCtorRef.
        // It owns every custom-attribute blob-encoding helper; the assembly-
        // level orchestrators on this root forward into it.
        this.customAttrEncoder = new CustomAttributeEncoder(
            this.emitCtx,
            this.wellKnown,
            this.GetTypeReference,
            this.ResolveUserCtorTokenForPrimary,
            this.ResolveUserCtorTokenForDefault,
            this.ResolveUserCtorTokenForExplicit);

        // PR-E-13: AssemblyAttributeEmitter owns the assembly-level attribute
        // orchestrators and ParseAssemblyVersion. It wires up after
        // customAttrEncoder because it forwards the string/pair/bound blob
        // writes into that encoder; GetTypeReference is threaded as a delegate
        // (same pattern as the encoder itself) so it needs no back-reference
        // to this emitter.
        this.assemblyAttrs = new AssemblyAttributeEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.customAttrEncoder,
            this.GetTypeReference);

        // PR-E-14: InterfaceImplEmitter owns the explicit-interface and
        // static-virtual MethodImpl-row emitters. Back-bound to this root
        // (the MethodBodyEmitter idiom) because its token resolution runs
        // through GetMethodReference / ResolveUserInterfaceInstanceMethodToken,
        // which stay on the root; it reads emitCtx/cache directly off the
        // back-reference in its ctor.
        this.interfaceImpls = new InterfaceImplEmitter(this);

        // PR-E-15: ConstructorBodyEmitter owns the constructor-body-bytes band.
        // Back-bound to this root (the MethodBodyEmitter idiom) because the
        // bodies construct the still-private MethodBodyEmitSession scaffold and
        // resolve field tokens via ResolveFieldToken; it reads emitCtx/cache
        // directly off the back-reference in its ctor. The interface-.cctor
        // MethodDef's parameter-list anchor comes in through the
        // NextParameterHandle callback (the same method-group TypeDefEmitter
        // receives). Wired after customAttrEncoder for that callback.
        this.ctorBodies = new ConstructorBodyEmitter(this, this.customAttrEncoder.NextParameterHandle);

        // PR-E-12: MethodBodyPlanner owns the per-body planning orchestrators
        // (CollectLocalsAndLabels and friends) that drive SlotPlanner's
        // collector classes. It needs GetTypeReference / GetTypeHandleForMember
        // for AddIteratorInterfaceImplementations, so it wires up after
        // wellKnown is materialised. StateMachineEmitter is back-bound via
        // SetStateMachines once stateMachines exists below.
        this.methodBodyPlanner = new MethodBodyPlanner(
            this.emitCtx,
            this.cache,
            this.slotPlanner,
            this.lambdaBodies,
            this.GetTypeReference,
            this.GetTypeHandleForMember,
            this.signatures.EncodeTypeSymbol);

        // PR-E-5: now that wellKnown is materialised, wire ConversionEmitter.
        // GetElementTypeToken is passed as a delegate (same pattern as
        // SlotPlanner's needsRvalueReceiverSpill) so the new component does
        // not need a hard back-reference to this emitter.
        this.conversionEmitter = new ConversionEmitter(this.emitCtx, this.cache, this.wellKnown, this.GetElementTypeToken);

        // PR-E-6: DataStructSynthesizer wires up after ConversionEmitter
        // because it needs `conversionEmitter.EmitBoxIfNeeded` for every
        // field load. Like ConversionEmitter and SlotPlanner, it consumes
        // the remaining root-emitter helpers it depends on as delegates so
        // it does not need a hard back-reference to this emitter.
        this.dataStructSynth = new DataStructSynthesizer(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.conversionEmitter,
            this.signatures.EncodeTypeSymbol,
            this.GetElementTypeToken,
            this.GetTypeReference,
            this.customAttrEncoder.NextParameterHandle,
            this.ResolveUserTypeToken,
            this.ResolveFieldToken,
            this.GetUserStructMethodRef);

        // PR-E-7: MemberDefEmitter wires up after DataStructSynthesizer.
        // It depends on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio and threads delegate callbacks for the five root-emitter
        // helpers it uses (EmitFunction, EncodeTypeSymbol, NextParameterHandle,
        // GetTypeReference, GetTypeHandleForMember) — same composition pattern
        // as DataStructSynthesizer / ConversionEmitter / SlotPlanner. No hard
        // back-reference to this emitter.
        this.memberDefEmitter = new MemberDefEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.EmitFunction,
            this.signatures.EncodeTypeSymbol,
            this.customAttrEncoder.NextParameterHandle,
            this.GetTypeReference,
            this.GetTypeHandleForMember,
            this.ResolveFieldToken,
            this.customAttrEncoder.EmitNullableAttributeOnProperty,
            this.customAttrEncoder.EmitUserAttributes);

        // PR-E-8: TypeDefEmitter wires up after MemberDefEmitter. It depends
        // on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio. The body-emission step inside the three constructor methods
        // that drive BodyEmitter (EmitStaticConstructor,
        // EmitClassConstructorWithBaseInitializer, EmitClassConstructorWithBody)
        // is routed through three injected Func callbacks bound to the
        // *BodyBytes helper methods on this emitter so TypeDefEmitter never
        // holds a hard reference to this root or to BodyEmitter — same
        // composition pattern as MemberDefEmitter / DataStructSynthesizer.
        this.typeDefEmitter = new TypeDefEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.signatures.EncodeTypeSymbol,
            this.signatures.EncodeReturnSymbol,
            this.GetTypeReference,
            this.GetUserStructTypeSpec,
            this.ResolveConstructedBaseParameterlessCtorToken,
            this.ResolveConstructedBaseExplicitCtorToken,
            this.customAttrEncoder.NextParameterHandle,
            this.customAttrEncoder.EmitUserAttributes,
            handle => this.customAttrEncoder.EmitNullableContextAttributeOnType(handle, NullableFlagsBuilder.NotAnnotated),
            this.customAttrEncoder.EmitNullableAttributeOnField,
            this.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter,
            this.customAttrEncoder.EmitParamArrayAttributeOnParameter,
            this.GetCtorReference,
            this.ctorBodies.EmitStaticConstructorBodyBytes,
            this.ctorBodies.EmitClassDefaultConstructorBodyBytes,
            this.ctorBodies.EmitClassPrimaryConstructorBodyBytes,
            this.ctorBodies.EmitClassConstructorWithBaseInitializerBodyBytes,
            this.ctorBodies.EmitClassConstructorWithBodyBodyBytes,
            this.ctorBodies.EmitClassDeinitializerBodyBytes);

        // PR-E-9: ClosureEmitter wires up after TypeDefEmitter. It depends
        // on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio plus the SlotPlanner (for go-statement capture discovery)
        // and a shared reference to this.lambdaBodies so the synthesis
        // path can register the rewritten lambda-body for every
        // closure-Invoke method without taking a hard back-reference to
        // this root emitter — same composition pattern as the other
        // PR-E-* components.
        this.closures = new ClosureEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.slotPlanner,
            this.lambdaBodies);

        // PR-E-10: StateMachineEmitter wires up after ClosureEmitter. It
        // depends on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio plus the ClosureEmitter (for the shared Counter +
        // SynthesizedClosureClasses) and a shared reference to
        // this.lambdaBodies. The BodyEmitter-driven portion of
        // EmitStateMachineMoveNext is reached via the
        // BuildMoveNextBodyBytes callback bound to the helper below — same
        // composition pattern as PR-E-8 TypeDefEmitter's three constructor
        // body-emit callbacks. No hard back-reference to this emitter.
        this.stateMachines = new StateMachineEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.closures,
            this.lambdaBodies,
            this.GetTypeReference,
            this.GetTypeHandleForMember,
            this.GetMethodEntityHandle,
            this.GetMethodEntityHandle,
            this.GetMethodReference,
            this.customAttrEncoder.NextParameterHandle,
            this.signatures.EncodeTypeSymbol,
            this.signatures.EncodeClrType,
            this.GetStructTypeToken,
            this.ResolveFieldToken,
            this.BuildMoveNextBodyBytes);

        if (asyncRewriteResult != null)
        {
            this.stateMachines.AsyncStateMachinePlans = asyncRewriteResult.StateMachines;
        }

        if (iteratorRewriteResult != null)
        {
            this.stateMachines.IteratorPlans = iteratorRewriteResult.Plans;
        }

        if (asyncIteratorRewriteResult != null)
        {
            this.stateMachines.AsyncIteratorPlans = asyncIteratorRewriteResult.Plans;
        }

        // PR-E-12: late-bind stateMachines into the body planner so
        // TryGetUserKickoffReceiverHandle can consult AsyncStateMachinePlans.
        this.methodBodyPlanner.SetStateMachines(this.stateMachines);

        // Pre-assign FieldDefinitionHandles for user struct fields. Struct
        // TypeDefs are emitted between <Module> and the per-package <Program>
        // types so the field/method-row ranges fall out correctly:
        //
        //   TypeDef 1: <Module>   fieldList=1    methodList=1
        //   TypeDef 2: Struct A   fieldList=1    methodList=1   (owns rows 1..K1)
        //   TypeDef 3: Struct B   fieldList=K1+1 methodList=1   (owns rows K1+1..K2)
        //   TypeDef 4: <Program>  fieldList=N+1  methodList=1
        //
        // Where N = total struct fields. <Module> "owns" rows [1, 1) = none.
        // Phase 4 emit parity (E1+E2): discover all function literals before
        // any row planning. No-capture literals add MethodDef rows alongside
        // user functions; capture-bearing literals are lowered into synthesized
        // closure classes that fold into the existing class TypeDef/method/
        // field row planning. The host package for both is the entry-point
        // package (which always exists for compilable programs that run).
        var lambdaLiterals = this.methodBodyPlanner.CollectFunctionLiterals();
        var goStatements = this.methodBodyPlanner.CollectGoStatements();
        var hostPackageGuess = this.emitCtx.Program.EntryPoint?.Package
            ?? this.emitCtx.Program.EntryPointPackage
            ?? (this.emitCtx.Program.Packages.IsDefaultOrEmpty ? null : this.emitCtx.Program.Packages[0]);
        this.closures.SynthesizeClosures(lambdaLiterals, hostPackageGuess);
        this.closures.SynthesizeGoClosures(goStatements, hostPackageGuess);
        this.stateMachines.SynthesizeIteratorStateMachines(hostPackageGuess);
        this.stateMachines.SynthesizeAsyncIteratorStateMachines(hostPackageGuess);
        this.stateMachines.SynthesizeAsyncLambdaStateMachines(lambdaLiterals, hostPackageGuess);

        // Issue #810: register per-SM-class outer-method TP → class-TP-ordinal
        // remaps so that EncodeTypeSymbol can auto-translate outer-method
        // type-parameter references into the SM's own class type-parameter
        // slots when emitting field signatures and method signatures for
        // generic iterator state-machine classes.
        foreach (var kvp in this.stateMachines.IteratorStateMachineInfos)
        {
            var remap = kvp.Value.BuildRemap();
            if (remap != null)
            {
                this.remaps.RegisterClassRemap(kvp.Key, remap);
            }
        }

        // Issue #1489: same registration for GENERIC async-iterator SM classes
        // so their field / method / interface signatures translate the kickoff
        // method's type-parameter references (MVar) into the SM class's own
        // class-type-parameter slots (Var) during emit.
        foreach (var kvp in this.stateMachines.AsyncIteratorStateMachineGenericInfos)
        {
            var remap = kvp.Value.BuildRemap();
            if (remap != null)
            {
                this.remaps.RegisterClassRemap(kvp.Key, remap);
            }
        }

        // Issue #1467: a user-declared type nested inside a generic type must
        // declare the enclosing type's generic parameters (ECMA-335 §II.10.3.1:
        // a nested type's generic parameters include the encloser's). Reify
        // those nested types over an ordinal-aligned copy of the enclosing
        // type-parameter list — mirroring the state-machine treatment — so
        // member/field/ctor signatures that reference an enclosing type
        // parameter encode a valid `VAR` slot (`!0[]`) rather than a dangling
        // type variable, and references to the nested type construct a real
        // `Nested`1<!0>` TypeSpec.
        this.RegisterNestedTypeEnclosingGenerics();

        // Issue #1477: register the outer-TP → own-TP-ordinal remap for each
        // synthesized closure / capture-box class that was reified generic over
        // its enclosing type parameters (recorded on
        // ReifiedFromTypeParameters). This reuses the state-machine remap
        // channel so EncodeTypeSymbol routes every capture-field / Invoke
        // signature through a valid VAR(idx) slot of the synthesized class.
        this.RegisterSynthesizedClosureReifiedGenerics();

        // Phase 3.B.4: user-defined interface TypeDefs (planned below).
        // Synthesized closure classes are appended after user aggregates so
        // their TypeDefs come last among the class block; field-row planning
        // walks the combined list so closure fields get well-defined rows.
        var allAggregates = this.emitCtx.Program.Structs;
        if (this.closures.SynthesizedClosureClasses.Count > 0)
        {
            allAggregates = allAggregates.AddRange(this.closures.SynthesizedClosureClasses);
        }

        // Async state-machine types: materialized structs with their hoisted
        // fields are appended so they get TypeDef + FieldDef rows alongside
        // user structs. Method rows (MoveNext, SetStateMachine) are planned
        // separately below.
        var asyncSmStructs = new List<StructSymbol>();
        var asyncSmPlansByStruct = new Dictionary<StructSymbol, AsyncStateMachinePlan>();
        foreach (var plan in this.stateMachines.AsyncStateMachinePlans)
        {
            var smStruct = plan.StateMachine.MaterializeAsStructSymbol();

            // Issue #1465: when the async kickoff method lives inside a
            // generic type (or is itself a generic method), the synthesized
            // state-machine type must be reified over an ordinal-aligned copy
            // of the enclosing type's (and the method's) type parameters —
            // mirroring Roslyn's `<M>d__0<T>`. Without this the hoisted
            // `<>4__this` field, the `this`-proxy, and the self-call targets
            // inside MoveNext reference the class's `!0` from a non-generic
            // SM context, producing unverifiable IL.
            this.RegisterStateMachineEnclosingGenerics(smStruct, plan.StateMachine.KickoffMethod);

            asyncSmStructs.Add(smStruct);
            asyncSmPlansByStruct[smStruct] = plan;
        }

        if (asyncSmStructs.Count > 0)
        {
            allAggregates = allAggregates.AddRange(asyncSmStructs);
        }

        // Separate state-machine types from non-SM types. SM types will be
        // nested inside their declaring type (<Program> or closure class) per
        // Roslyn convention. To satisfy ECMA-335 §II.22.32 (enclosing row <
        // nested row), <Program> TypeDefs must precede SM TypeDefs.
        var smClassSet = new HashSet<StructSymbol>(
            this.stateMachines.IteratorStateMachineInfos.Keys.Concat(this.stateMachines.AsyncIteratorInfos.Keys));
        var smStructSet = new HashSet<StructSymbol>(asyncSmStructs);

        var nonSmClasses = new List<StructSymbol>();
        var smClasses = new List<StructSymbol>();
        var nonSmStructs = new List<StructSymbol>();
        var smStructsOrdered = new List<StructSymbol>();

        foreach (var s in allAggregates)
        {
            if (s.IsClass)
            {
                if (smClassSet.Contains(s))
                {
                    smClasses.Add(s);
                }
                else
                {
                    nonSmClasses.Add(s);
                }
            }
            else
            {
                if (smStructSet.Contains(s))
                {
                    smStructsOrdered.Add(s);
                }
                else
                {
                    nonSmStructs.Add(s);
                }
            }
        }

        var interfaces = this.emitCtx.Program.Interfaces;
        var enumsAll = this.emitCtx.Program.Enums;

        // Issue #910 / ADR-0110: split user-declared NESTED types (their
        // ContainingType is set by BindNestedTypeDeclarations) from top-level
        // ones. Top-level types keep their historical kind-partitioned emission
        // order (so non-nested programs are byte-identical). Every nested type
        // — regardless of kind/encloser combination — is emitted in a single
        // unified pre-order block AFTER all top-level types so that each
        // enclosing TypeDef row always precedes its nested rows, satisfying
        // ECMA-335 §II.22.32 for every combination (including nested interfaces
        // and class-in-struct, which no fixed kind partition can order).
        // Closure/state-machine types never set ContainingType, so they stay in
        // the top-level partitions and their nesting is handled separately.
        static bool IsUserNested(TypeSymbol t) => t switch
        {
            StructSymbol ss => ss.ContainingType != null,
            EnumSymbol es => es.ContainingType != null,
            InterfaceSymbol ifs => ifs.ContainingType != null,
            _ => false,
        };

        static TypeSymbol ContainingOf(TypeSymbol t) => t switch
        {
            StructSymbol ss => ss.ContainingType,
            EnumSymbol es => es.ContainingType,
            InterfaceSymbol ifs => ifs.ContainingType,
            _ => null,
        };

        var topInterfaces = interfaces.Where(i => !IsUserNested(i)).ToList();
        var topClasses = nonSmClasses.Where(c => !IsUserNested(c)).ToList();
        var topStructs = nonSmStructs.Where(s => !IsUserNested(s)).ToList();
        var topEnums = enumsAll.Where(e => !IsUserNested(e)).ToList();

        // Build the unified nested-type pre-order: each enclosing type is
        // followed by its nested children (recursively), with siblings ordered
        // interface → class → struct → enum so an implementer is emitted after
        // any sibling interface it implements (mirrors the global "interfaces
        // first" convention used for top-level types).
        var nestedChildrenByParent = new Dictionary<TypeSymbol, List<TypeSymbol>>();
        void RegisterNestedChild(TypeSymbol child)
        {
            var parent = ContainingOf(child);
            if (parent == null)
            {
                return;
            }

            if (!nestedChildrenByParent.TryGetValue(parent, out var list))
            {
                list = [];
                nestedChildrenByParent[parent] = list;
            }

            list.Add(child);
        }

        foreach (var i in interfaces.Where(IsUserNested))
        {
            RegisterNestedChild(i);
        }

        foreach (var c in nonSmClasses.Where(IsUserNested))
        {
            RegisterNestedChild(c);
        }

        foreach (var s in nonSmStructs.Where(IsUserNested))
        {
            RegisterNestedChild(s);
        }

        foreach (var e in enumsAll.Where(IsUserNested))
        {
            RegisterNestedChild(e);
        }

        var nestedOrdered = new List<TypeSymbol>();
        void VisitNested(TypeSymbol parent)
        {
            if (!nestedChildrenByParent.TryGetValue(parent, out var children))
            {
                return;
            }

            foreach (var child in children)
            {
                nestedOrdered.Add(child);
                VisitNested(child);
            }
        }

        foreach (var i in topInterfaces)
        {
            VisitNested(i);
        }

        foreach (var c in topClasses)
        {
            VisitNested(c);
        }

        foreach (var s in topStructs)
        {
            VisitNested(s);
        }

        foreach (var e in topEnums)
        {
            VisitNested(e);
        }

        // Per-nested-type FieldList/MethodList boundary pointers, assigned in
        // nested pre-order so the monotone-non-decreasing TypeDef column
        // invariant holds across the nested block.
        var nestedFieldListRow = new Dictionary<TypeSymbol, int>();
        var nestedMethodListRow = new Dictionary<TypeSymbol, int>();

        // Field-row planning: non-SM types first, then SM types. This ensures
        // fieldList pointers are non-decreasing when <Program> (which owns no
        // fields) sits between non-SM and SM TypeDefs.
        //
        //   TypeDef row order (new):
        //     <Module>   fieldList=1     methodList=1
        //     Interfaces ...
        //     Non-SM classes ...
        //     Non-SM structs ...
        //     <Program>  fieldList=M+1   methodList=...
        //     SM classes fieldList=M+1.. methodList=...
        //     SM structs fieldList=...   methodList=...
        //
        // Where M = total non-SM fields. <Program> owns 0 fields so its
        // fieldList equals the first SM type's fieldList.
        int nextFieldRow = 1;

        // ADR-0089 / issue #1030: interface static fields occupy the FIRST
        // FieldDef rows. Interface TypeDefs are emitted immediately after
        // <Module> and before every class/struct/enum TypeDef, so their field
        // rows must precede all aggregate field rows to keep the metadata
        // fieldList column monotone non-decreasing. const fields are emitted as
        // literal FieldDefs too, so both static and const fields are counted.
        var interfaceFirstFieldRow = new Dictionary<InterfaceSymbol, int>();
        foreach (var i in topInterfaces)
        {
            interfaceFirstFieldRow[i] = nextFieldRow;
            nextFieldRow += i.StaticFields.Length + i.ConstFields.Length;
        }

        var structFirstFieldRow = new Dictionary<StructSymbol, int>();

        // Issue #910 / ADR-0110: field-row planning for one aggregate (class or
        // struct). Shared by the top-level field pass and the nested-type pass
        // so a nested aggregate's FieldDef range is assigned in the same order
        // its TypeDef row is emitted, preserving the monotone fieldList column.
        void PlanAggregateFields(StructSymbol s)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;

            // ADR-0051 Phase 6: backing fields for auto-properties.
            foreach (var p in s.Properties)
            {
                if (p.IsAutoProperty && p.BackingField != null && !s.Fields.Contains(p.BackingField))
                {
                    nextFieldRow++;
                }
            }

            // ADR-0052: backing fields for field-like events.
            foreach (var ev in s.Events)
            {
                if (ev.IsFieldLike && ev.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // ADR-0053: static fields from shared block.
            if (!s.StaticFields.IsDefaultOrEmpty)
            {
                nextFieldRow += s.StaticFields.Length;
            }

            // Issue #948 / issue #1070: const fields are emitted as CLR literal
            // field rows (see TypeDefEmitter.EmitStructTypeDef), so they must be
            // counted here too. Omitting them under-reserved the FieldDef range
            // and shifted every following type's fieldList pointer by the const
            // count, leaking the last field of a const-bearing type onto the next
            // TypeDef (producing invalid IL such as `stsfld` of another type's
            // initonly field in a `.cctor`).
            if (!s.ConstFields.IsDefaultOrEmpty)
            {
                nextFieldRow += s.ConstFields.Length;
            }

            // Issue #263: backing fields for static auto-properties.
            foreach (var p in s.StaticProperties)
            {
                if (p.IsAutoProperty && p.BackingField != null)
                {
                    nextFieldRow++;
                }
            }

            // Issue #263: backing fields for static field-like events.
            foreach (var ev in s.StaticEvents)
            {
                if (ev.IsFieldLike && ev.BackingField != null)
                {
                    nextFieldRow++;
                }
            }
        }

        // Issue #193: each user-defined enum contributes 1 instance field
        // (value__) plus one literal field per member.
        var enums = enumsAll;
        var enumFirstFieldRow = new Dictionary<EnumSymbol, int>();
        void PlanEnumFields(EnumSymbol e)
        {
            enumFirstFieldRow[e] = nextFieldRow;
            nextFieldRow += 1 + e.Members.Length;
        }

        // Walk top-level non-SM types for field assignment (classes, then
        // structs, then enums) — historical kind-partitioned order.
        foreach (var s in topClasses)
        {
            PlanAggregateFields(s);
        }

        foreach (var s in topStructs)
        {
            PlanAggregateFields(s);
        }

        // Enum field rows are planned right after non-SM struct fields so the
        // enum TypeDef can be emitted between non-SM struct TypeDefs and the
        // nested block without violating the monotone fieldList constraint.
        foreach (var e in topEnums)
        {
            PlanEnumFields(e);
        }

        // Issue #910 / ADR-0110: nested-type field rows form a contiguous block
        // after all top-level field rows and before <Program>/global fields.
        foreach (var nested in nestedOrdered)
        {
            nestedFieldListRow[nested] = nextFieldRow;
            switch (nested)
            {
                case StructSymbol ns:
                    PlanAggregateFields(ns);
                    break;
                case EnumSymbol ne:
                    PlanEnumFields(ne);
                    break;

                case InterfaceSymbol ni:
                    // ADR-0089 / issue #1030: a nested interface may declare
                    // static fields. Reserve its FieldDef rows in the nested
                    // block (its TypeDef row is emitted in this same pass).
                    interfaceFirstFieldRow[ni] = nextFieldRow;
                    nextFieldRow += ni.StaticFields.Length + ni.ConstFields.Length;
                    break;

                // Other nested kinds own no fields; the boundary pointer above
                // is what their nested TypeDef row will reference.
            }
        }

        // Issue #191: user-declared top-level var/let/const live as static
        // fields on the entry-point package's <Program> TypeDef. Reserve their
        // field rows immediately before <Program>'s fieldList pointer so the
        // existing monotone constraint holds and programFirstFieldRow points
        // at the first global field (when any). SM struct fields are planned
        // after these globals so SM field rows remain strictly greater than
        // <Program>'s fieldList pointer.
        var globals = this.emitCtx.Program.Globals;
        int programFirstFieldRow = nextFieldRow;
        var globalFieldRows = new Dictionary<GlobalVariableSymbol, int>();
        foreach (var g in globals)
        {
            globalFieldRows[g] = nextFieldRow++;
        }

        // SM types get field rows after <Program>'s fieldList pointer.
        foreach (var s in smClasses)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
        }

        foreach (var s in smStructsOrdered)
        {
            structFirstFieldRow[s] = nextFieldRow;
            nextFieldRow += s.Fields.Length;
        }

        var moduleFirstFieldRow = 1;

        int methodRow = 1;
        var interfaceFirstMethodRow = new Dictionary<InterfaceSymbol, int>();
        var interfaceCctorRows = new Dictionary<InterfaceSymbol, int>();
        void PlanInterfaceMethods(InterfaceSymbol i)
        {
            interfaceFirstMethodRow[i] = methodRow;
            foreach (var m in i.Methods)
            {
                this.cache.MethodHandles[m] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }

            // ADR-0089 / issue #755: plan MethodDef rows for static-virtual
            // interface members. They occupy the same MethodList run as
            // instance interface methods so the parent TypeDef's methodList
            // pointer correctly bounds the entire group.
            foreach (var sm in i.StaticMethods)
            {
                this.cache.MethodHandles[sm] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }

            // ADR-0090 / issue #756: plan MethodDef rows for private interface
            // helper methods (instance + static). They live inside the same
            // interface TypeDef methodList run so the bounds remain correct.
            if (!i.PrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var pm in i.PrivateMethods)
                {
                    this.cache.MethodHandles[pm] = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }
            }

            if (!i.StaticPrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var spm in i.StaticPrivateMethods)
                {
                    this.cache.MethodHandles[spm] = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }
            }

            // Plan accessor method rows for interface properties (issue #248).
            foreach (var prop in i.Properties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle);

                // ADR-0089 / issue #1019, #2293: register the accessor
                // FunctionSymbols against their planned MethodDef rows for
                // BOTH static-virtual and ordinary instance interface
                // properties, mirroring the instance-method registration
                // above (`i.Methods`). This lets `constrained.` dispatch
                // (`T.Prop` → get_Prop) and ordinary interface-typed callvirt
                // sites resolve the accessor's slot handle even when the
                // implementer relies on the interface's default body.
                if (prop.GetterSymbol != null && getterHandle.HasValue)
                {
                    this.cache.MethodHandles[prop.GetterSymbol] = getterHandle.Value;
                }

                if (prop.SetterSymbol != null && setterHandle.HasValue)
                {
                    this.cache.MethodHandles[prop.SetterSymbol] = setterHandle.Value;
                }
            }

            // ADR-0052: plan accessor method rows for interface events.
            foreach (var ev in i.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);

                // ADR-0149: register the interface event's own add/remove/
                // raise FunctionSymbols against their planned MethodDef rows,
                // mirroring the property accessor registration above — this
                // is what lets EmitExplicitInterfaceEventMethodImpls resolve
                // the interface-side MethodImpl target token for an explicit
                // event implementation (`event (IFoo) Changed T`).
                if (ev.AddMethodSymbol != null)
                {
                    this.cache.MethodHandles[ev.AddMethodSymbol] = addHandle;
                }

                if (ev.RemoveMethodSymbol != null)
                {
                    this.cache.MethodHandles[ev.RemoveMethodSymbol] = removeHandle;
                }

                if (ev.RaiseMethodSymbol != null && raiseHandle.HasValue)
                {
                    this.cache.MethodHandles[ev.RaiseMethodSymbol] = raiseHandle.Value;
                }
            }

            // ADR-0089 / issue #1030: plan the .cctor row for an interface that
            // declares static-field initializers. It is the LAST method in the
            // interface's MethodList run (emitted after property/event accessors
            // in EmitInterfaceMethodBodies), so reserve it here last.
            if (!i.StaticFieldInitializers.IsEmpty)
            {
                interfaceCctorRows[i] = methodRow++;
            }
        }

        // Phase 3.B.4: plan method rows for interface abstract methods FIRST.
        // Interface TypeDefs sit between <Module> and the class TypeDefs in
        // row order so their methodList pointer (= first abstract method) is
        // strictly less than the first class ctor row.
        foreach (var i in topInterfaces)
        {
            PlanInterfaceMethods(i);
        }

        // ADR-0059 / issue #255: plan method rows for each named delegate
        // (one ctor + one Invoke per delegate) AFTER interface methods and
        // BEFORE non-SM class ctors. The delegate TypeDef rows themselves are
        // emitted immediately after interfaces so methodList pointers stay
        // monotone non-decreasing across the table.
        var delegates = this.emitCtx.Program.Delegates;
        var delegateCtorRows = new Dictionary<DelegateTypeSymbol, int>();
        var delegateInvokeRows = new Dictionary<DelegateTypeSymbol, int>();
        foreach (var d in delegates)
        {
            delegateCtorRows[d] = methodRow++;
            delegateInvokeRows[d] = methodRow++;
        }

        // Plan method rows for non-SM class ctors + instance methods.
        var classCtorRows = new Dictionary<StructSymbol, int>();
        var classPrimaryCtorRows = new Dictionary<StructSymbol, int>();
        var aggregateMethodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
        void PlanClassMethods(StructSymbol c)
        {
            classCtorRows[c] = methodRow++;

            // Issue #656 / ADR-0065: when the class declares explicit init(...)
            // constructors, each overload beyond the first requires an additional
            // method row. The first overload occupies the classCtorRows slot above.
            if (c.ExplicitConstructor != null && c.ExplicitConstructors.Length > 1)
            {
                methodRow += c.ExplicitConstructors.Length - 1;
            }

            // Issue #306: a class with an explicit base-constructor initializer
            // emits a single forwarding constructor (no separate parameterless
            // ctor), so reserve only one ctor row in that case.
            // ADR-0065 §5: when the class also declares explicit `init(...)`
            // bodies, the synthesized primary ctor is allocated as one of the
            // ExplicitConstructors rows above — do not reserve an additional
            // primary-ctor row here.
            if (c.HasPrimaryConstructor && c.BaseConstructorInitializer == null && c.ExplicitConstructor == null)
            {
                classPrimaryCtorRows[c] = methodRow++;
            }

            // Issue #2228: a `data class` synthesizes the same seven
            // MethodDef rows as a `data struct` (Equals(object),
            // Equals(Name), GetHashCode, ToString, op_Equality,
            // op_Inequality, Deconstruct) — see PlanStructMethods' matching
            // reservation and EmitClassMethodBodies' matching emit call,
            // which must run in the same relative order (before
            // user-declared methods) so the MethodDef rows line up.
            // Issue #2363: a zero-field data class skips Deconstruct (one
            // fewer row) — see DataStructSynthesizer.HasZeroSynthesisFields
            // and EmitDataStructSynthesizedMembers's matching skip.
            // Issue #2361: when the class declares a compatible hand-written
            // ToString, one fewer row is reserved here too — the "ToString"
            // row is instead reserved by the ordinary c.Methods loop below,
            // matching DataStructSynthesizer.EmitDataStructSynthesizedMembers
            // skipping the synthesized ToString body in that case. The two
            // skips are independent and compose (a zero-field data class
            // with a user ToString override reserves five rows).
            if (c.IsData)
            {
                methodRow += 7
                    - (DataStructSynthesizer.HasZeroSynthesisFields(c) ? 1 : 0)
                    - (DataStructSynthesizer.HasUserToStringOverride(c) ? 1 : 0);
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                    aggregateMethodHandles[m] = handle;
                    this.cache.MethodHandles[m] = handle;
                }
            }

            // ADR-0068 / issue #698: reserve a row for the synthesized
            // `Finalize` override produced by a class `deinit { … }`. The
            // emitter materialises it as a regular instance method between
            // user-declared methods and property accessors in the row order.
            if (c.Deinitializer != null)
            {
                var deinitHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                this.cache.MethodHandles[c.Deinitializer.Function] = deinitHandle;
            }

            // ADR-0051 Phase 6: plan accessor method rows for class properties.
            foreach (var prop in c.Properties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle);
                this.RegisterIndexerAccessorHandles(prop, getterHandle, setterHandle);
            }

            // ADR-0052: plan accessor method rows for class events.
            foreach (var ev in c.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // ADR-0053: plan method rows for static methods on classes.
            if (!c.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in c.StaticMethods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                    aggregateMethodHandles[m] = handle;
                    this.cache.MethodHandles[m] = handle;
                }
            }

            // Issue #263: plan accessor method rows for static properties on classes.
            foreach (var prop in c.StaticProperties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // Issue #263: plan accessor method rows for static events on classes.
            foreach (var ev in c.StaticEvents)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // Issue #262: plan .cctor row for classes with static field initializers.
            // ADR-0140 / issue #2131: also plan it when the class declares a
            // `shared { init { … } }` static-initializer block.
            if (!c.StaticFieldInitializers.IsEmpty || c.HasStaticInitializerBlock)
            {
                this.cache.CctorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }
        }

        foreach (var c in topClasses)
        {
            PlanClassMethods(c);
        }

        // Issue #1996: a class-scoped static `Main` is emitted as an ordinary
        // TypeDef-owned static method (its MethodDef row was already reserved
        // above by PlanClassMethods' StaticMethods loop). It must NOT also get
        // a package-level <Program> row/emission — the per-package entry-point
        // reservation/emission below is skipped for it, and the emitted
        // TypeDef-owned MethodDef row is reused directly as the PE entry point.
        var entryPointIsClassOwned = this.emitCtx.Program.EntryPoint is not null
            && aggregateMethodHandles.ContainsKey(this.emitCtx.Program.EntryPoint);

        // Plan method rows for non-SM structs.
        var structFirstMethodRows = new Dictionary<StructSymbol, int>();
        void PlanStructMethods(StructSymbol s)
        {
            if (s.Methods.IsDefaultOrEmpty && !s.IsInline && !s.IsData && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty && !s.HasStaticInitializerBlock)
            {
                return;
            }

            structFirstMethodRows[s] = methodRow;
            if (s.IsInline)
            {
                methodRow += 8;
            }
            else if (s.IsData)
            {
                // Issue #410 / ADR-0029: data structs synthesize 7 MethodDef
                // rows: Equals(object), Equals(Name), GetHashCode, ToString,
                // Issue #410 / ADR-0029: data structs synthesize 7 MethodDef
                // rows: Equals(object), Equals(Name), GetHashCode, ToString,
                // op_Equality, op_Inequality, Deconstruct. Issue #2363: a
                // zero-field data struct skips Deconstruct (one fewer row).
                // Issue #2361: one fewer row also when the struct declares a
                // compatible hand-written ToString — see the matching
                // class-side comment in PlanClassMethods above. The two
                // skips compose independently.
                methodRow += 7
                    - (DataStructSynthesizer.HasZeroSynthesisFields(s) ? 1 : 0)
                    - (DataStructSynthesizer.HasUserToStringOverride(s) ? 1 : 0);

                // Rubber-duck follow-up to issue #2224: an anonymous-class
                // literal's synthesized type has no plain fields (only
                // get-only auto-properties — see AnonymousTypeCache), so its
                // primary-ctor "call" sugar can't route through
                // BoundStructLiteralExpression's field-initializer emission
                // like an ordinary `data struct Foo(x int32)` does (that one
                // keeps Fields non-empty and never needs a real .ctor row —
                // see the OverloadResolver comment near
                // `!classType.IsClass`). It needs one extra reserved row for
                // a real newobj-callable instance constructor, emitted by
                // DataStructSynthesizer.EmitDataStructSynthesizedMembers.
                if (s.Fields.IsDefaultOrEmpty && s.HasPrimaryConstructor)
                {
                    classPrimaryCtorRows[s] = methodRow++;
                }
            }

            foreach (var m in s.Methods)
            {
                var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                aggregateMethodHandles[m] = handle;
                this.cache.MethodHandles[m] = handle;
            }

            // ADR-0051 Phase 6: plan accessor method rows for struct properties.
            foreach (var prop in s.Properties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle);
                this.RegisterIndexerAccessorHandles(prop, getterHandle, setterHandle);
            }

            // ADR-0052: plan accessor method rows for struct events.
            foreach (var ev in s.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // ADR-0053: plan method rows for static methods on structs.
            if (!s.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in s.StaticMethods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                    aggregateMethodHandles[m] = handle;
                    this.cache.MethodHandles[m] = handle;
                }
            }

            // Issue #263: plan accessor method rows for static properties on structs.
            foreach (var prop in s.StaticProperties)
            {
                MethodDefinitionHandle? getterHandle = null;
                MethodDefinitionHandle? setterHandle = null;
                if (prop.HasGetter)
                {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                if (prop.HasSetter)
                {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                }

                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle);
            }

            // Issue #263: plan accessor method rows for static events on structs.
            foreach (var ev in s.StaticEvents)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
            }

            // Issue #262: plan .cctor row for structs with static field initializers.
            // ADR-0140 / issue #2131: also plan it when the struct declares a
            // `shared { init { … } }` static-initializer block.
            if (!s.StaticFieldInitializers.IsEmpty || s.HasStaticInitializerBlock)
            {
                this.cache.CctorHandles[s] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }
        }

        foreach (var s in topStructs)
        {
            PlanStructMethods(s);
        }

        // Issue #910 / ADR-0110: nested-type method rows form a contiguous
        // block after all top-level method rows and before the per-package
        // <Program> ctor/method rows. Each nested type records its methodList
        // boundary so the monotone MethodList column holds across the block.
        int firstNestedMethodRow = methodRow;
        foreach (var nested in nestedOrdered)
        {
            nestedMethodListRow[nested] = methodRow;
            switch (nested)
            {
                case InterfaceSymbol ni:
                    PlanInterfaceMethods(ni);
                    break;
                case StructSymbol ns when ns.IsClass:
                    PlanClassMethods(ns);
                    break;
                case StructSymbol ns:
                    PlanStructMethods(ns);
                    break;

                // Enums own no methods; the boundary pointer above is the row
                // their nested TypeDef will reference.
            }
        }

        int firstPackageCtorRow = methodRow;

        // 2. <Module> type (TypeDef row #1 must always be <Module> per ECMA-335).
        this.emitCtx.Metadata.AddTypeDefinition(
            attributes: default(TypeAttributes),
            @namespace: default(StringHandle),
            name: this.emitCtx.Metadata.GetOrAddString("<Module>"),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(moduleFirstFieldRow),
            methodList: MetadataTokens.MethodDefinitionHandle(1));

        // Issue #973: pre-reserve the TypeDefinitionHandle for every user
        // TypeDef (interfaces, delegates, classes, structs, enums — top-level
        // and nested) BEFORE any member signature is encoded. A field, method,
        // or return signature may reference a user type whose TypeDef row is
        // emitted later in this same pass — e.g. a `class` field whose type is a
        // user `struct`, since classes are emitted before structs below. Without
        // a pre-reserved handle, EncodeTypeSymbol cannot resolve such a forward
        // reference and throws ("type has no emitted TypeDef").
        //
        // The emission order below is fixed and each type contributes exactly
        // one TypeDef row (the first being `<Module>` at row 1 per ECMA-335), so
        // the row numbers are fully deterministic at this point. Pre-populating
        // the caches with the predicted handles lets EncodeTypeSymbol resolve a
        // referenced type regardless of relative emission order. Each
        // EmitXxxTypeDef call below re-assigns the identical handle, so emitted
        // metadata is byte-for-byte unchanged for programs that already
        // compiled.
        int reservedTypeDefRow = this.emitCtx.Metadata.GetRowCount(TableIndex.TypeDef) + 1;
        void ReserveTypeDefHandle(TypeSymbol type)
        {
            var handle = MetadataTokens.TypeDefinitionHandle(reservedTypeDefRow++);
            switch (type)
            {
                case InterfaceSymbol ifaceSym:
                    this.cache.InterfaceTypeDefs[ifaceSym] = handle;
                    break;
                case DelegateTypeSymbol delegateSym:
                    this.cache.DelegateTypeDefs[delegateSym] = handle;
                    break;
                case StructSymbol structSym:
                    this.cache.StructTypeDefs[structSym] = handle;
                    break;
                case EnumSymbol enumSym:
                    this.cache.EnumTypeDefs[enumSym] = handle;
                    break;
            }
        }

        foreach (var i in topInterfaces)
        {
            ReserveTypeDefHandle(i);
        }

        foreach (var d in delegates)
        {
            ReserveTypeDefHandle(d);
        }

        foreach (var c in topClasses)
        {
            ReserveTypeDefHandle(c);
        }

        foreach (var s in topStructs)
        {
            ReserveTypeDefHandle(s);
        }

        foreach (var e in topEnums)
        {
            ReserveTypeDefHandle(e);
        }

        foreach (var nested in nestedOrdered)
        {
            ReserveTypeDefHandle(nested);
        }

        // 2a. Phase 3.B.4: Emit interface TypeDefs + their abstract method
        // rows. Interfaces have no fields and only abstract method bodies, so
        // they are the simplest TypeDefs to emit. Their methodList points at
        // the first of their reserved abstract method rows.
        foreach (var i in topInterfaces)
        {
            this.typeDefEmitter.EmitInterfaceTypeDef(i, interfaceFirstMethodRow[i], interfaceFirstFieldRow[i]);
        }

        // Issue #1006: emit the InterfaceImpl rows recording each interface's
        // base interfaces (`interface B : A` → InterfaceImpl{B -> A}). All
        // interface TypeDefs are emitted above, so the cache is fully populated
        // before any base reference is resolved. Emitting here — before the
        // class/struct TypeDefs — keeps the InterfaceImpl Class column
        // ascending (interface TypeDef RIDs precede class/struct RIDs).
        void EmitInterfaceBaseImplRows(InterfaceSymbol iface)
        {
            if (!this.cache.InterfaceTypeDefs.TryGetValue(iface, out var ifaceTypeDef))
            {
                return;
            }

            if (!iface.BaseInterfaces.IsDefaultOrEmpty)
            {
                foreach (var baseIface in iface.BaseInterfaces)
                {
                    if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(baseIface))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            ifaceTypeDef,
                            this.GetUserInterfaceTypeSpec(baseIface));
                    }
                    else if (this.cache.InterfaceTypeDefs.TryGetValue(baseIface, out var baseHandle))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(ifaceTypeDef, baseHandle);
                    }
                }
            }

            if (!iface.BaseClrInterfaces.IsDefaultOrEmpty)
            {
                foreach (var clrBase in iface.BaseClrInterfaces)
                {
                    if (clrBase?.ClrType is System.Type clrType)
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            ifaceTypeDef,
                            this.GetTypeHandleForMember(clrType));
                    }
                }
            }
        }

        foreach (var i in topInterfaces)
        {
            EmitInterfaceBaseImplRows(i);
        }

        // Issue #1433 regression fix: an interface method body emitted below
        // (e.g. a static-virtual `shared func Create(...)` factory) may
        // `newobj` a non-SM class's primary/explicit ctor — including a class
        // declared later in source order. cache.ClassCtorHandles /
        // ClassPrimaryCtorHandles / ExplicitCtorHandles are normally
        // pre-registered from the planned rows (classCtorRows /
        // classPrimaryCtorRows, reserved by PlanClassMethods above) much
        // later in this pass, right before class method bodies are emitted.
        // That pre-registration must happen here too — before interface
        // bodies are emitted — so a ctor call site inside an interface body
        // can resolve the handle. The later pre-registration loop was
        // removed; the handles claimed here are final (see the comment near
        // `firstSmClassMethodRow` below, right before class method bodies are
        // emitted, which documents that no further pre-registration runs).
        foreach (var c in nonSmClasses)
        {
            if (!classCtorRows.TryGetValue(c, out var firstCtorRow))
            {
                continue;
            }

            if (c.ExplicitConstructor != null)
            {
                var firstHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow);
                for (int i = 0; i < c.ExplicitConstructors.Length; i++)
                {
                    this.cache.ExplicitCtorHandles[c.ExplicitConstructors[i]] =
                        MetadataTokens.MethodDefinitionHandle(firstCtorRow + i);
                }

                this.cache.ClassCtorHandles[c] = firstHandle;
                this.cache.ClassPrimaryCtorHandles[c] = firstHandle;
            }
            else if (c.BaseConstructorInitializer != null)
            {
                var forwardingHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow);
                this.cache.ClassCtorHandles[c] = forwardingHandle;
                this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle;
            }
            else
            {
                this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(firstCtorRow);

                if (c.HasPrimaryConstructor && classPrimaryCtorRows.TryGetValue(c, out var primaryRow))
                {
                    this.cache.ClassPrimaryCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(primaryRow);
                }
            }
        }

        // Same hazard, same fix, for an `inline struct`'s primary ctor: an
        // interface body may `newobj Box(n)` where `Box` is an inline struct
        // (single-field value type). Its ctor handle is normally registered
        // inside EmitInlineStructSynthesizedMembers, called from
        // EmitStructMethodBodies — which also runs after interface bodies.
        // Pre-register it from the row structFirstMethodRows reserved for it
        // (PlanStructMethods above): the inline-struct ctor always occupies
        // the first of its reserved rows. A `data struct` primary-ctor call
        // is bound as a field-by-field BoundStructLiteralExpression instead
        // of a ctor call, so it never needs a ClassPrimaryCtorHandles entry —
        // EXCEPT for a synthesized anonymous-class-literal's backing type
        // (rubber-duck follow-up to issue #2224), which has no plain fields
        // and so needs a real newobj-callable ctor (see the comment near
        // PlanStructMethods' `classPrimaryCtorRows[s] = methodRow++` above and
        // DataStructSynthesizer.EmitDataStructSynthesizedMembers). That row is
        // reserved during planning but the handle is normally only cached
        // inside EmitDataStructSynthesizedMembers, called from
        // EmitStructMethodBodies for topStructs — which runs AFTER class
        // method bodies (topClasses), so a class method that constructs an
        // anonymous-class literal would resolve against an empty cache. Same
        // fix as the inline-struct case: pre-register it here from
        // classPrimaryCtorRows.
        foreach (var s in nonSmStructs)
        {
            if (s.IsInline && structFirstMethodRows.TryGetValue(s, out var inlineCtorRow))
            {
                this.cache.ClassPrimaryCtorHandles[s] = MetadataTokens.MethodDefinitionHandle(inlineCtorRow);
            }
            else if (s.IsData && s.Fields.IsDefaultOrEmpty && s.HasPrimaryConstructor
                && classPrimaryCtorRows.TryGetValue(s, out var dataPrimaryCtorRow))
            {
                this.cache.ClassPrimaryCtorHandles[s] = MetadataTokens.MethodDefinitionHandle(dataPrimaryCtorRow);
            }
        }

        // Same hazard, same fix, for a NAMED DELEGATE's ctor: an interface
        // body may perform a method-group -> named-delegate conversion
        // (`newobj` the delegate's compiler-provided ctor). DelegateCtorHandles
        // is normally registered inside EmitDelegateTypeDef, which runs after
        // interface bodies (see the Issue #1716 comment below). Pre-register
        // it here from the row already reserved in delegateCtorRows above.
        foreach (var d in delegates)
        {
            this.cache.DelegateCtorHandles[d] = MetadataTokens.MethodDefinitionHandle(delegateCtorRows[d]);
        }

        // Issue #1716: interface abstract/default method MethodDef rows are
        // reserved (PlanInterfaceMethods, above) BEFORE the delegate ctor/
        // Invoke rows, so they must also be *actually emitted* before the
        // delegate TypeDefs below — EmitDelegateTypeDef adds its ctor/Invoke
        // MethodDefs eagerly (not deferred to a later body-emission pass like
        // classes/structs), so any deferred-reservation member scheduled
        // ahead of delegates in the MethodDef row plan must be flushed here to
        // keep actual AddMethodDefinition call order monotone with the
        // reserved row plan. Interfaces are currently the only such member
        // category planned ahead of delegates; emitting their bodies here
        // (instead of in the later EmitInterfaceMethodBodies pass alongside
        // classes/structs) preserves the invariant for any interface/delegate
        // combination, not just one hard-coded shape.
        foreach (var i in topInterfaces)
        {
            EmitInterfaceMethodBodies(i);
        }

        // ADR-0059 / issue #255: emit named delegate TypeDefs immediately
        // after interfaces and before non-SM classes/structs. Each delegate's
        // TypeDef methodList points at the ctor row reserved above; the
        // runtime-implemented ctor and Invoke MethodDefs are added inside
        // EmitDelegateTypeDef.
        foreach (var d in delegates)
        {
            this.typeDefEmitter.EmitDelegateTypeDef(d, delegateCtorRows[d]);
        }

        // Issue #910 / ADR-0110: emit one class TypeDef row plus its
        // InterfaceImpl rows. Shared by the top-level class pass and the nested
        // block so nested classes are real CLR nested types with identical
        // interface-implementation metadata.
        void EmitClassTypeDefRow(StructSymbol c)
        {
            // Issue #1477: a synthesized closure / capture-box class reified
            // generic over enclosing type parameters needs its remap active so
            // its capture-field signatures encode the class's own VAR(idx)
            // slots. No-op for every other class (unregistered → restore:false).
            using (this.remaps.PushSmRemap(c))
            {
                var gpRowStart = this.emitCtx.PendingGenericParameters.Count;
                this.typeDefEmitter.EmitStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);
                this.PreResolveReifiedGenericConstraints(gpRowStart);
            }

            EmitInterfaceImplRows(c);
        }

        // Issue #976: emit the InterfaceImpl metadata rows for an aggregate
        // (class OR struct) TypeDef. Value types (structs) declare interface
        // implementation exactly like classes, so the rows are emitted from a
        // shared helper rather than only on the class path.
        void EmitInterfaceImplRows(StructSymbol c)
        {
            if (!c.Interfaces.IsDefaultOrEmpty)
            {
                foreach (var iface in c.Interfaces)
                {
                    // ADR-0087 R5 / issue #765: when the implemented user
                    // interface is a constructed instance (e.g. `IBox[int32]`),
                    // the InterfaceImpl row must reference a TypeSpec built
                    // from the constructed shape; the bare TypeDef key only
                    // resolves the open definition.
                    if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.GetUserInterfaceTypeSpec(iface));
                    }
                    else if (this.cache.InterfaceTypeDefs.TryGetValue(iface, out var ifaceHandle))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[c], ifaceHandle);
                    }
                }
            }

            // Issue #525: emit InterfaceImpl rows for imported CLR interfaces
            // declared in the base-type clause so the resulting type is a
            // real CLR implementer (`Type.GetInterfaces()` surfaces them and
            // dispatch through an interface receiver hits the G# method).
            if (!c.ImplementedClrInterfaces.IsDefaultOrEmpty)
            {
                foreach (var ifaceSym in c.ImplementedClrInterfaces)
                {
                    // Issue #949: a CLR generic interface closed over a user G#
                    // type (e.g. `IEquatable[Shape]`) carries symbolic type
                    // arguments alongside its type-erased ClrType. Emit the
                    // InterfaceImpl over the real constructed shape
                    // (`IEquatable<Shape>`) via a symbolic TypeSpec rather than
                    // the erased `IEquatable<object>`.
                    if (MemberLookup.TryGetSymbolicClrGenericInterface(ifaceSym, out _, out _))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.GetElementTypeToken(ifaceSym));
                        continue;
                    }

                    if (ifaceSym?.ClrType is System.Type clrIface)
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.GetTypeHandleForMember(clrIface));
                    }
                }
            }

            // Issue #985: a covariant-return interface bridge (e.g. the
            // non-generic IEnumerable.GetEnumerator) explicitly implements an
            // INHERITED base interface that is not itself named in the base
            // clause. Emit an explicit InterfaceImpl row for that base
            // interface so the metadata matches the C# shape (both
            // `IEnumerable<T>` and `IEnumerable` appear) and the MethodImpl row
            // resolves against a declared interface.
            if (!c.Methods.IsDefaultOrEmpty)
            {
                System.Collections.Generic.HashSet<System.Type> bridgeInterfaces = null;
                foreach (var method in c.Methods)
                {
                    var declaringIface = method.ExplicitInterfaceSlot?.DeclaringType;
                    if (declaringIface == null)
                    {
                        continue;
                    }

                    bridgeInterfaces ??= new System.Collections.Generic.HashSet<System.Type>();
                    if (bridgeInterfaces.Add(declaringIface))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.GetTypeHandleForMember(declaringIface));
                    }
                }
            }
        }

        // Issue #242: the ECMA-335 methodList column must be monotonically
        // non-decreasing across TypeDef rows. A struct without methods must use
        // the NEXT available method row — the first method row of the next
        // top-level struct that HAS methods, or the start of the nested-type
        // method block (firstNestedMethodRow) when none follows.
        int TopStructMethodListRow(StructSymbol s)
        {
            if (structFirstMethodRows.TryGetValue(s, out var firstStructMethodRow))
            {
                return firstStructMethodRow;
            }

            var methodListRow = firstNestedMethodRow;
            bool foundSelf = false;
            foreach (var s2 in topStructs)
            {
                if (ReferenceEquals(s2, s))
                {
                    foundSelf = true;
                    continue;
                }

                if (foundSelf && structFirstMethodRows.TryGetValue(s2, out var nextMethodRow))
                {
                    methodListRow = nextMethodRow;
                    break;
                }
            }

            return methodListRow;
        }

        // 2b. Emit non-SM class TypeDefs (so methodLists stay non-decreasing),
        // then non-SM struct TypeDefs. SM types are emitted AFTER <Program>.
        foreach (var c in topClasses)
        {
            EmitClassTypeDefRow(c);
        }

        foreach (var s in topStructs)
        {
            this.typeDefEmitter.EmitStructTypeDef(s, structFirstFieldRow[s], TopStructMethodListRow(s));
            EmitInterfaceImplRows(s);
        }

        // Issue #193: emit enum TypeDefs between non-SM structs and the nested
        // block. Each enum has no methods, so its methodList points at the
        // first nested-type method row (or firstPackageCtorRow when no nested
        // types follow — the two are equal in that case).
        foreach (var e in topEnums)
        {
            this.typeDefEmitter.EmitEnumTypeDef(e, enumFirstFieldRow[e], firstNestedMethodRow);
        }

        // Issue #910 / ADR-0110: emit the unified nested-type block. Every
        // enclosing TypeDef row (top-level above, or an earlier nested row) is
        // already emitted, so each nested row satisfies ECMA-335 §II.22.32. The
        // NestedClass rows themselves are added in the post-pass below.
        foreach (var nested in nestedOrdered)
        {
            switch (nested)
            {
                case InterfaceSymbol ni:
                    this.typeDefEmitter.EmitInterfaceTypeDef(ni, interfaceFirstMethodRow[ni], nestedFieldListRow[ni]);
                    EmitInterfaceBaseImplRows(ni);
                    break;
                case StructSymbol ns when ns.IsClass:
                    EmitClassTypeDefRow(ns);
                    break;
                case StructSymbol ns:
                    // Issue #1537: a nested struct reified over its enclosing +
                    // own type parameters needs its remap active so field
                    // signatures (and the TypeDef's own generic-param
                    // constraints) encode the correct re-ordinalized VAR(idx)
                    // slots. No-op for every other struct.
                    using (this.remaps.PushSmRemap(ns))
                    {
                        var gpRowStart = this.emitCtx.PendingGenericParameters.Count;
                        this.typeDefEmitter.EmitStructTypeDef(ns, structFirstFieldRow[ns], nestedMethodListRow[ns]);
                        this.PreResolveReifiedGenericConstraints(gpRowStart);
                    }

                    EmitInterfaceImplRows(ns);
                    break;
                case EnumSymbol ne:
                    this.typeDefEmitter.EmitEnumTypeDef(ne, enumFirstFieldRow[ne], nestedMethodListRow[ne]);
                    break;
            }
        }

        // 3. Group functions by their declaring package. One <Program> type
        //    is emitted per package, in BoundProgram.Packages declaration
        //    order; method-row layout for each package is:
        //        package.ctor  → [package's non-entry user fns]  → [package's entry point if any]
        //    The entry-point function (if any) is placed last in its package
        //    so the EntryPoint token resolves cleanly.
        var packages = this.emitCtx.Program.Packages.IsDefaultOrEmpty
            ? ImmutableArray.Create(this.emitCtx.Program.EntryPointPackage ?? new PackageSymbol("Default", declaration: null))
            : this.emitCtx.Program.Packages;

        var functionsByPackage = new Dictionary<PackageSymbol, List<FunctionSymbol>>();
        foreach (var pkg in packages)
        {
            functionsByPackage[pkg] = [];
        }

        foreach (var kvp in this.emitCtx.Program.Functions)
        {
            if (kvp.Key == this.emitCtx.Program.EntryPoint)
            {
                continue;
            }

            // Class instance methods are owned by their class TypeDef, not by
            // a package's <Program> container.
            if (kvp.Key.IsInstanceMethod)
            {
                continue;
            }

            // ADR-0053: static methods on structs/classes are emitted as part of
            // their owning TypeDef, not as package-level functions.
            if (kvp.Key.IsStatic && aggregateMethodHandles.ContainsKey(kvp.Key))
            {
                continue;
            }

            // ADR-0089 / issue #755: static-virtual interface members emit
            // as part of the interface's TypeDef, not as <Program>-hosted
            // top-level statics. The interface's emit phase already routed
            // these through EmitFunction.
            if (kvp.Key.IsStatic && kvp.Key.StaticOwnerType is InterfaceSymbol)
            {
                continue;
            }

            // Issue #2004: a static (shared-block) property/event accessor's
            // FunctionSymbol (get_X/set_X/add_X/remove_X/raise_X) is NOT added
            // to aggregateMethodHandles above — only StaticMethods are. Only
            // static plain methods are registered there; static property and
            // event accessors are instead tracked solely via
            // cache.PropertyAccessorHandles / cache.EventAccessorHandles,
            // keyed by the property/event symbol, not the FunctionSymbol. Left
            // unchecked, such an accessor's FunctionSymbol falls through to
            // the package-function bucket below and gets a SECOND MethodDef
            // row emitted on the package's <Program> TypeDef, with a body that
            // still reads/writes the struct/class's (possibly private) static
            // backing field — a field access the unrelated <Program> type has
            // no visibility into, which ilverify rejects as "Field is not
            // visible". PlanClassMethods/PlanStructMethods set StaticOwnerType
            // to the declaring struct/class for these accessors, so skip them
            // here exactly like the interface case above.
            if (kvp.Key.IsStatic && kvp.Key.StaticOwnerType is StructSymbol)
            {
                continue;
            }

            var owningPackage = kvp.Key.Package ?? this.emitCtx.Program.EntryPointPackage ?? packages[0];
            if (!functionsByPackage.TryGetValue(owningPackage, out var bucket))
            {
                bucket = [];
                functionsByPackage[owningPackage] = bucket;
                packages = packages.Add(owningPackage);
            }

            bucket.Add(kvp.Key);
        }

        var entryPointPackage = this.emitCtx.Program.EntryPoint?.Package ?? this.emitCtx.Program.EntryPointPackage;

        // Issue #456: enumeration of `program.Functions` walks a
        // Dictionary<FunctionSymbol, ...> whose hash buckets depend on
        // FunctionSymbol identity, which is not stable across Compilation
        // instances. Two functions with identical signatures (e.g.
        // `func f(int32) int32` and `func g(int32) int32`) can therefore
        // be assigned MethodDef rows in flipped order across runs, breaking
        // byte-deterministic emit. Sort each bucket by source declaration
        // position (with Name as a stable tiebreaker for synthesized
        // functions that share or lack a Declaration) so the MethodDef
        // table is emitted in the same order every run.
        foreach (var pkgKey in functionsByPackage.Keys.ToList())
        {
            functionsByPackage[pkgKey].Sort(FunctionEmitOrderComparer.Instance);
        }

        // Phase 4 emit parity (E1): non-capture function literals are attached
        // to the entry-point package's <Program> container as ordinary static
        // methods. Capture-bearing literals were already redirected into
        // closure-class invoke methods by SynthesizeClosures, so we skip them
        // here.
        var lambdaHostPackage = entryPointPackage ?? packages[0];
        if (lambdaLiterals.Count > 0)
        {
            if (!functionsByPackage.TryGetValue(lambdaHostPackage, out var hostBucket))
            {
                hostBucket = [];
                functionsByPackage[lambdaHostPackage] = hostBucket;
                packages = packages.Add(lambdaHostPackage);
            }

            foreach (var literal in lambdaLiterals)
            {
                if (literal.CapturedVariables.Length > 0)
                {
                    continue;
                }

                // Issue #1469: a non-capturing lambda lexically nested inside a
                // user type was rerouted by SynthesizeClosures into a display
                // class nested in that type (so it shares the type's
                // accessibility domain). Such a literal now carries a ClosureInfo
                // and its body is already registered against the synthesized
                // Invoke method, so it must NOT also be hosted as a top-level
                // <Program> static method.
                if (this.closures.ClosureInfos.ContainsKey(literal))
                {
                    continue;
                }

                var loweredLambdaBody = (BoundBlockStatement)Lowerer.Lower(literal.Body);
                this.lambdaBodies[literal.Function] = loweredLambdaBody;

                // Issue #2118: a non-capturing lambda hosted as a top-level
                // <Program> static method must be promoted to a GENERIC method
                // declaring its own type parameters (cloned, with constraints,
                // from the enclosing type parameters its signature/body
                // references) — otherwise its body's `!!0`/`!0` references a
                // type parameter the method never declares, producing
                // unverifiable IL (DelegateCtor at the delegate site and
                // StackUnexpected on any `constrained.` call in the body).
                this.TryPromoteNonCapturingGenericLambda(literal, loweredLambdaBody);

                hostBucket.Add(literal.Function);
            }
        }

        // Issue #2392: the "Phase A" <Program> TypeDef loop below always
        // emits the entry-point/globals-host package's <Program> TypeDef
        // FIRST (so its FieldDef range stays monotone — issue #191), no
        // matter where that package sits in `packages`. MethodDef row
        // planning must mirror that exact TypeDef order: ECMA-335 requires
        // TypeDef.MethodList to be non-decreasing down the TypeDef table,
        // since the CLR (and ilverify/decompilers) derive each TypeDef's
        // owned method range from consecutive MethodList values. `packages`
        // is ordered by first-seen syntax tree — itself a function of
        // build-tool/file enumeration order, not package identity — so
        // whenever the entry-point package is NOT `packages[0]` (e.g. its
        // package-less file wasn't bound first), planning ctor/function
        // rows in that raw order while still emitting its TypeDef first
        // produces a non-monotone MethodList sequence. The synthesized
        // entry point (`<Main>$`), hoisted top-level local functions, and
        // non-capturing top-level lambdas then silently attribute to
        // whichever OTHER package's <Program> the row-range lookup resolves
        // to, causing spurious cross-package FieldAccess/MethodAccess
        // ilverify failures. Reorder here, once, so every package-ordered
        // loop below (row planning, method-body emission, and the TypeDef
        // loop itself) shares one entry-point-first order.
        var programEntryPackage = entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
        if (programEntryPackage != null && packages.Length > 0 && packages[0] != programEntryPackage)
        {
            var reorderedPackages = ImmutableArray.CreateBuilder<PackageSymbol>(packages.Length);
            reorderedPackages.Add(programEntryPackage);
            foreach (var pkg in packages)
            {
                if (pkg != programEntryPackage)
                {
                    reorderedPackages.Add(pkg);
                }
            }

            packages = reorderedPackages.MoveToImmutable();
        }

        // Plan method rows for packages (per-package ctor + functions + entry).
        var packageCtorRows = new Dictionary<PackageSymbol, int>();
        var nextRow = firstPackageCtorRow;
        foreach (var pkg in packages)
        {
            packageCtorRows[pkg] = nextRow++;
            foreach (var fn in functionsByPackage[pkg])
            {
                this.cache.FunctionHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow++);

                // ADR-0092 / issue #758: a LibraryImport function emits TWO
                // MethodDef rows — the user-visible managed stub (handle above)
                // and a hidden blittable inner P/Invoke that the stub calls.
                if (fn.IsPInvoke && fn.PInvokeMetadata.IsLibraryImport)
                {
                    this.cache.LibraryImportInnerHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow++);
                }
            }

            if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage && !entryPointIsClassOwned)
            {
                this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint] = MetadataTokens.MethodDefinitionHandle(nextRow++);
            }
        }

        // Plan method rows for SM classes (after package methods).
        int firstSmClassMethodRow = nextRow;
        foreach (var c in smClasses)
        {
            classCtorRows[c] = nextRow++;
            if (c.HasPrimaryConstructor)
            {
                classPrimaryCtorRows[c] = nextRow++;
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    var handle = MetadataTokens.MethodDefinitionHandle(nextRow++);
                    aggregateMethodHandles[m] = handle;
                    this.cache.MethodHandles[m] = handle;
                }
            }
        }

        // Plan method rows for SM structs (MoveNext + SetStateMachine each).
        foreach (var s in smStructsOrdered)
        {
            structFirstMethodRows[s] = nextRow;
            nextRow += 2; // MoveNext, SetStateMachine
        }

        MethodDefinitionHandle entryHandle = default;
        if (this.emitCtx.Program.EntryPoint is not null)
        {
            entryHandle = entryPointIsClassOwned
                ? aggregateMethodHandles[this.emitCtx.Program.EntryPoint]
                : this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint];
        }

        // Pre-register SM class ctor handles so iterator kickoff bodies
        // (emitted during B4) can reference them for newobj calls.
        foreach (var c in smClasses)
        {
            this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(classCtorRows[c]);
        }

        // Issue #503 / #523 / #920 / #1433: non-SM user class ctor handles
        // (ClassCtorHandles / ClassPrimaryCtorHandles / ExplicitCtorHandles)
        // are pre-registered from the planned rows earlier in this pass (see
        // the loop above, right before interface method bodies are emitted —
        // an interface body may itself `newobj` a class ctor), so no further
        // pre-registration is needed here before class method bodies below.

        // === PHASE A: Emit remaining TypeDefs (Program + SM) ===
        // <Program> TypeDefs BEFORE SM TypeDefs (ECMA-335 §II.22.32: enclosing row < nested row).
        var programTypeDefHandles = new Dictionary<PackageSymbol, TypeDefinitionHandle>();

        // Issue #191: emit global FieldDefs into the entry-point package's
        // <Program> field range. The entry-point package's <Program> TypeDef
        // is emitted first so its fieldList (= start of globals) is strictly
        // less than every subsequent <Program>'s fieldList (= past globals).
        var globalsHostPkg = entryPointPackage
            ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
        if (globals.Length > 0 && globalsHostPkg != null && packages.Contains(globalsHostPkg))
        {
            // Globals whose type is a constructed generic (e.g. Box[int]) need
            // the alias map populated so EncodeTypeSymbol can resolve the
            // constructed StructSymbol to its definition's TypeDef. We call
            // RegisterConstructedTypeAliases again later (line 798) to pick
            // up ctor handles populated during the rest of Phase A.
            this.methodBodyPlanner.RegisterConstructedTypeAliases();
            this.EmitGlobalFieldDefs(globals);

            var programHandle = this.emitCtx.Metadata.AddTypeDefinition(
                attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                    | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
                    | TypeAttributes.Sealed | TypeAttributes.Abstract,
                @namespace: this.emitCtx.Metadata.GetOrAddString(globalsHostPkg.Name),
                name: this.emitCtx.Metadata.GetOrAddString("<Program>"),
                baseType: this.wellKnown.ObjectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(programFirstFieldRow),
                methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[globalsHostPkg]));
            programTypeDefHandles[globalsHostPkg] = programHandle;
            this.customAttrEncoder.EmitNullableContextAttributeOnType(programHandle, NullableFlagsBuilder.NotAnnotated);
        }

        foreach (var pkg in packages)
        {
            if (programTypeDefHandles.ContainsKey(pkg))
            {
                continue;
            }

            // Packages without globals (or non-entry-point packages when globals
            // were emitted above) point their fieldList past the global field
            // range so the monotone <Program> fieldList constraint holds.
            var fieldListRow = programFirstFieldRow + globals.Length;
            var programHandle = this.emitCtx.Metadata.AddTypeDefinition(
                attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout
                    | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
                    | TypeAttributes.Sealed | TypeAttributes.Abstract,
                @namespace: this.emitCtx.Metadata.GetOrAddString(pkg.Name),
                name: this.emitCtx.Metadata.GetOrAddString("<Program>"),
                baseType: this.wellKnown.ObjectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(fieldListRow),
                methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[pkg]));
            programTypeDefHandles[pkg] = programHandle;
            this.customAttrEncoder.EmitNullableContextAttributeOnType(programHandle, NullableFlagsBuilder.NotAnnotated);
        }

        // Issue #792 / ADR-0084. Stamp [ExtensionAttribute] on every
        // <Program> TypeDef that hosts at least one top-level extension
        // function. C# extension-method discovery (ECMA-334 §13.6.9)
        // requires both the host static class and each candidate static
        // method to carry the marker; the per-method marker lands in
        // EmitFunction.
        foreach (var pkg in packages)
        {
            if (!programTypeDefHandles.TryGetValue(pkg, out var programHandle))
            {
                continue;
            }

            if (!functionsByPackage.TryGetValue(pkg, out var pkgFuncs))
            {
                continue;
            }

            var hostsAnyExtension = false;
            foreach (var f in pkgFuncs)
            {
                if (f.IsExtension && !f.IsInstanceMethod)
                {
                    hostsAnyExtension = true;
                    break;
                }
            }

            if (hostsAnyExtension)
            {
                this.EmitExtensionAttribute(programHandle);
            }
        }

        // SM class TypeDefs (sync iterators + async iterators).
        foreach (var c in smClasses)
        {
            // Issue #810: when the iterator state-machine class is generic
            // over the outer method's type parameters, push the per-SM
            // remap so EncodeTypeSymbol translates outer-method TP
            // references to the SM class's own TP slots (Var(idx)) while
            // encoding field signatures and interface implementations.
            using (this.remaps.PushSmRemap(c))
            {
                this.typeDefEmitter.EmitNestedStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);

                if (this.stateMachines.IteratorStateMachineInfos.TryGetValue(c, out var iteratorInfo))
                {
                    this.methodBodyPlanner.AddIteratorInterfaceImplementations(c, iteratorInfo);
                }

                if (this.stateMachines.AsyncIteratorInfos.TryGetValue(c, out var asyncIterPlan))
                {
                    this.methodBodyPlanner.AddAsyncIteratorInterfaceImplementations(c, asyncIterPlan);
                }
            }
        }

        // SM struct TypeDefs (async method/lambda state machines).
        foreach (var s in smStructsOrdered)
        {
            var smMethodListRow = structFirstMethodRows[s];

            // Issue #1465: push the SM's enclosing-type/method TP → SM-TP
            // remap so hoisted-field signatures (e.g. `<>4__this`) translate
            // method-type-parameter references into the SM type's own Var
            // slots. A no-op when the SM is non-generic.
            using (this.remaps.PushSmRemap(s))
            {
                this.typeDefEmitter.EmitNestedStructTypeDef(s, structFirstFieldRow[s], smMethodListRow);
            }

            var iAsyncSmType = typeof(System.Runtime.CompilerServices.IAsyncStateMachine);
            var iAsyncSmRef = this.GetTypeReference(iAsyncSmType);
            this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[s], iAsyncSmRef);
        }

        // === PHASE B: Emit MethodDefs in row order ===
        // B1. Interface methods (abstract + default-interface methods).
        void EmitInterfaceMethodBodies(InterfaceSymbol i)
        {
            foreach (var m in i.Methods)
            {
                // ADR-0085 / issue #726: a default-interface method (the
                // method's declaring syntax carries a non-null Body) is
                // emitted as a normal virtual MethodDef with a real body —
                // the EmitFunction pipeline handles signature, body, and
                // ParameterRow plumbing, and the receiver-is-interface
                // branch above stamps it as Public | Virtual | NewSlot
                // (no Final, no Abstract). Abstract interface methods
                // (no body) continue to use EmitAbstractMethod.
                if (InterfaceSymbol.HasDefaultBody(m)
                    && this.emitCtx.Program.Functions.TryGetValue(m, out var dimBody))
                {
                    var emittedHandle = this.EmitFunction(m, dimBody, isEntryPoint: false);
                    this.cache.MethodHandles[m] = emittedHandle;
                }
                else
                {
                    this.typeDefEmitter.EmitAbstractMethod(m);
                }
            }

            // ADR-0089 / issue #755: emit static-virtual interface members.
            // When the declaration carries a default body, route through
            // EmitFunction (which handles signature + IL body + parameter
            // rows). When there is no body, emit a Static|Virtual|Abstract
            // MethodDef with no IL.
            foreach (var sm in i.StaticMethods)
            {
                if (InterfaceSymbol.HasDefaultBody(sm)
                    && this.emitCtx.Program.Functions.TryGetValue(sm, out var defBody))
                {
                    var emittedHandle = this.EmitFunction(sm, defBody, isEntryPoint: false);
                    this.cache.MethodHandles[sm] = emittedHandle;
                }
                else
                {
                    this.typeDefEmitter.EmitStaticVirtualMethod(sm, hasBody: false, bodyOffset: -1);
                }
            }

            // ADR-0090 / issue #756: emit private interface helper methods
            // (instance and static). These always carry a body (GS0335
            // enforces this); skip if for some reason the body is missing.
            if (!i.PrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var pm in i.PrivateMethods)
                {
                    if (this.emitCtx.Program.Functions.TryGetValue(pm, out var pBody))
                    {
                        var emittedHandle = this.EmitFunction(pm, pBody, isEntryPoint: false);
                        this.cache.MethodHandles[pm] = emittedHandle;
                    }
                }
            }

            if (!i.StaticPrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var spm in i.StaticPrivateMethods)
                {
                    if (this.emitCtx.Program.Functions.TryGetValue(spm, out var sBody))
                    {
                        var emittedHandle = this.EmitFunction(spm, sBody, isEntryPoint: false);
                        this.cache.MethodHandles[spm] = emittedHandle;
                    }
                }
            }

            // Issue #248: emit abstract accessor MethodDefs + PropertyDef rows for interface properties.
            this.memberDefEmitter.EmitInterfacePropertyAccessors(i);

            // ADR-0149 (issue #944 follow-up): mirror EmitDefaultMemberAttributeIfIndexer
            // (struct/class-side) for an interface that declares its own
            // indexer contract.
            this.EmitDefaultMemberAttributeIfIndexer(i);

            // ADR-0052: emit abstract accessor MethodDefs + EventDef rows for interface events.
            this.memberDefEmitter.EmitInterfaceEventAccessors(i);

            // ADR-0089 / issue #1030: emit the interface .cctor running static
            // field initializers. Emitted LAST (after property/event accessors)
            // to match the row reserved in PlanInterfaceMethods.
            if (!i.StaticFieldInitializers.IsEmpty)
            {
                this.ctorBodies.EmitInterfaceStaticConstructor(i);
            }
        }

        // B2. Non-SM class ctors + instance methods.
        void EmitClassMethodBodies(StructSymbol c)
        {
            if (c.ExplicitConstructor != null)
            {
                // Issue #306 / ADR-0063 §9: a class with explicit `init(...)`
                // constructors emits one `.ctor` per declared overload. The first
                // overload also serves as the legacy classCtor/primaryCtor handle.
                // ADR-0065 §5: when the class also declares a primary-ctor
                // parameter list, the first overload is a synthesized
                // designated init whose body is the conventional primary-ctor
                // field-assignment sequence — route it through
                // EmitClassPrimaryConstructor instead of the user-body path.
                MethodDefinitionHandle firstHandle = default;
                var firstAssigned = false;
                foreach (var explicitCtor in c.ExplicitConstructors)
                {
                    MethodDefinitionHandle ctorHandle;
                    if (explicitCtor.IsSynthesizedFromPrimaryConstructor)
                    {
                        // The synthesized primary follows the same emission
                        // shape as a primary-ctor-only class. If the class
                        // declaration also carries `: Base(args)`, that base
                        // initializer must be honored — route through the
                        // forwarding-ctor emitter; otherwise emit the plain
                        // primary-ctor shape (default chain to `object::.ctor`
                        // or the parameterless base).
                        if (c.BaseConstructorInitializer != null)
                        {
                            ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBaseInitializer(c, c.PrimaryConstructorParameters);
                        }
                        else
                        {
                            ctorHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c);
                        }
                    }
                    else
                    {
                        ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBody(c, explicitCtor);
                    }

                    this.cache.ExplicitCtorHandles[explicitCtor] = ctorHandle;
                    if (!firstAssigned)
                    {
                        firstHandle = ctorHandle;
                        firstAssigned = true;
                    }
                }

                this.cache.ClassCtorHandles[c] = firstHandle;
                this.cache.ClassPrimaryCtorHandles[c] = firstHandle;
            }
            else if (c.BaseConstructorInitializer != null)
            {
                // Issue #306: emit a single constructor that forwards arguments
                // to the resolved base ctor. When a primary constructor is
                // present its parameters drive both the forwarded arguments and
                // the field initialization; otherwise the forwarding ctor is
                // parameterless (constant base arguments). No separate
                // parameterless ctor is emitted because the base may lack one.
                var ctorParams = c.HasPrimaryConstructor
                    ? c.PrimaryConstructorParameters
                    : ImmutableArray<ParameterSymbol>.Empty;
                var forwardingHandle = this.typeDefEmitter.EmitClassConstructorWithBaseInitializer(c, ctorParams);
                this.cache.ClassCtorHandles[c] = forwardingHandle;
                this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle;
            }
            else
            {
                var ctorHandle = this.typeDefEmitter.EmitClassDefaultConstructor(c);
                this.cache.ClassCtorHandles[c] = ctorHandle;

                if (c.HasPrimaryConstructor)
                {
                    var primaryHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c);
                    this.cache.ClassPrimaryCtorHandles[c] = primaryHandle;
                }
            }

            // Issue #2228: emit the seven synthesized members for a `data
            // class` (Equals(object), Equals(Name), GetHashCode, ToString,
            // op_Equality, op_Inequality, Deconstruct) BEFORE user-declared
            // methods, matching PlanClassMethods' reservation order above.
            // Without this a `data class` silently falls back to reference
            // identity for `==`/`.Equals`/`GetHashCode` (inherited from
            // System.Object), which is exactly the ADR-0029 value-equality
            // contract a data type promises.
            if (c.IsData)
            {
                this.dataStructSynth.EmitDataStructSynthesizedMembers(c);
            }

            if (!c.Methods.IsDefaultOrEmpty)
            {
                foreach (var m in c.Methods)
                {
                    if (!this.emitCtx.Program.Functions.TryGetValue(m, out var body))
                    {
                        body = this.lambdaBodies[m];
                    }

                    var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                    this.cache.MethodHandles[m] = emittedHandle;
                }
            }

            // ADR-0068 / issue #698: emit the synthesized `Finalize` override
            // produced by the class's `deinit { … }` body. The emitted method
            // wraps the lowered user body in `try { … } finally { base.Finalize(); }`.
            if (c.Deinitializer != null
                && this.emitCtx.Program.Functions.TryGetValue(c.Deinitializer.Function, out var deinitBody))
            {
                var deinitHandle = this.typeDefEmitter.EmitClassDeinitializer(c, c.Deinitializer, deinitBody);
                this.cache.MethodHandles[c.Deinitializer.Function] = deinitHandle;
            }

            // ADR-0051 Phase 6: emit property accessor methods for classes.
            this.memberDefEmitter.EmitPropertyAccessors(c);
            this.EmitDefaultMemberAttributeIfIndexer(c);

            // ADR-0052: emit event accessor methods for classes.
            this.memberDefEmitter.EmitEventAccessors(c);

            // ADR-0053: emit static methods for classes.
            if (!c.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in c.StaticMethods)
                {
                    if (this.emitCtx.Program.Functions.TryGetValue(m, out var staticBody))
                    {
                        // Issue #1996: a class-scoped static `Main` is the PE
                        // entry point when picked by ResolveEntryPoint — wire
                        // isEntryPoint through so EmitFunction applies the same
                        // async-Main sync-wrapper lowering (GetAwaiter().GetResult())
                        // used for package-scope entry points.
                        var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: m == this.emitCtx.Program.EntryPoint);
                        this.cache.MethodHandles[m] = emittedHandle;
                    }
                }
            }

            // Issue #263: emit static property accessor methods for classes.
            this.memberDefEmitter.EmitStaticPropertyAccessors(c);

            // Issue #263: emit static event accessor methods for classes.
            this.memberDefEmitter.EmitStaticEventAccessors(c);

            // Issue #262: emit .cctor for classes with static field initializers.
            if (this.cache.CctorHandles.ContainsKey(c))
            {
                this.typeDefEmitter.EmitStaticConstructor(c);
            }

            // ADR-0089 / issue #755: emit MethodImpl rows for static-virtual
            // interface members. See structs path for the same call.
            this.interfaceImpls.EmitStaticVirtualMethodImpls(c);

            // ADR-0089 / issue #1019: emit MethodImpl rows for static-virtual
            // interface properties (accessor methods).
            this.interfaceImpls.EmitStaticVirtualPropertyMethodImpls(c);

            // Issue #985: emit MethodImpl rows for covariant-return interface
            // bridges (e.g. the non-generic IEnumerable.GetEnumerator).
            this.interfaceImpls.EmitExplicitInterfaceMethodImpls(c);

            // Issue #2362: emit MethodImpl rows for mangled-name explicit
            // interface property implementations (accessor methods).
            this.interfaceImpls.EmitExplicitInterfacePropertyMethodImpls(c);

            // ADR-0149: emit MethodImpl rows for explicit-interface-clause
            // event implementations (add/remove/raise accessors).
            this.interfaceImpls.EmitExplicitInterfaceEventMethodImpls(c);
        }

        foreach (var c in topClasses)
        {
            // Issue #1477: keep the synthesized closure / capture-box class's
            // remap active while emitting its ctor + Invoke bodies/signatures
            // so enclosing type-parameter references resolve to the class's own
            // VAR(idx) slots. No-op for every other class.
            using (this.remaps.PushSmRemap(c))
            {
                EmitClassMethodBodies(c);
            }
        }

        // 4b. Non-SM struct methods.
        void EmitStructMethodBodies(StructSymbol s)
        {
            if (s.IsInline)
            {
                this.dataStructSynth.EmitInlineStructSynthesizedMembers(s);
            }
            else if (s.IsData)
            {
                // Issue #410 / ADR-0029: emit synthesized members BEFORE
                // user-declared methods so the MethodDef rows match the
                // planning order (the first 7 rows reserved by the planner).
                this.dataStructSynth.EmitDataStructSynthesizedMembers(s);
            }

            if (s.Methods.IsDefaultOrEmpty && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty && !s.HasStaticInitializerBlock)
            {
                return;
            }

            foreach (var m in s.Methods)
            {
                if (!this.emitCtx.Program.Functions.TryGetValue(m, out var body))
                {
                    body = this.lambdaBodies[m];
                }

                var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                this.cache.MethodHandles[m] = emittedHandle;
            }

            // ADR-0051 Phase 6: emit property accessor methods for structs.
            this.memberDefEmitter.EmitPropertyAccessors(s);
            this.EmitDefaultMemberAttributeIfIndexer(s);

            // ADR-0052: emit event accessor methods for structs.
            this.memberDefEmitter.EmitEventAccessors(s);

            // ADR-0053: emit static methods for structs.
            if (!s.StaticMethods.IsDefaultOrEmpty)
            {
                foreach (var m in s.StaticMethods)
                {
                    if (this.emitCtx.Program.Functions.TryGetValue(m, out var staticBody))
                    {
                        var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: false);
                        this.cache.MethodHandles[m] = emittedHandle;
                    }
                }
            }

            // Issue #263: emit static property accessor methods for structs.
            this.memberDefEmitter.EmitStaticPropertyAccessors(s);

            // Issue #263: emit static event accessor methods for structs.
            this.memberDefEmitter.EmitStaticEventAccessors(s);

            // Issue #262: emit .cctor for structs with static field initializers.
            if (this.cache.CctorHandles.ContainsKey(s))
            {
                this.typeDefEmitter.EmitStaticConstructor(s);
            }

            // ADR-0089 / issue #755: emit MethodImpl rows for static-virtual
            // interface members. The CLR (per ECMA-335 §II.10.3.3 with the
            // C# 11 / .NET 7 static-virtual extension) cannot pair an
            // implementer's static method with an interface's static-virtual
            // slot by name+signature alone — an explicit MethodImpl row is
            // required so `constrained.` dispatch finds the right body. The
            // row points the interface slot's MethodDef at the implementer's
            // static MethodDef on the struct's TypeDef.
            this.interfaceImpls.EmitStaticVirtualMethodImpls(s);

            // ADR-0089 / issue #1019: emit MethodImpl rows for static-virtual
            // interface properties (accessor methods).
            this.interfaceImpls.EmitStaticVirtualPropertyMethodImpls(s);

            // Issue #985: emit MethodImpl rows for covariant-return interface
            // bridges declared on a struct that implements `IEnumerable[T]` &c.
            this.interfaceImpls.EmitExplicitInterfaceMethodImpls(s);

            // Issue #2362: emit MethodImpl rows for mangled-name explicit
            // interface property implementations (accessor methods).
            this.interfaceImpls.EmitExplicitInterfacePropertyMethodImpls(s);

            // ADR-0149: emit MethodImpl rows for explicit-interface-clause
            // event implementations (add/remove/raise accessors).
            this.interfaceImpls.EmitExplicitInterfaceEventMethodImpls(s);
        }

        foreach (var s in topStructs)
        {
            EmitStructMethodBodies(s);
        }

        // B3.5 / Issue #910 / ADR-0110: emit method bodies for the unified
        // nested-type block, in the same pre-order the rows were planned and
        // the TypeDefs emitted, so MethodDef row order stays consistent.
        foreach (var nested in nestedOrdered)
        {
            switch (nested)
            {
                case InterfaceSymbol ni:
                    EmitInterfaceMethodBodies(ni);
                    break;
                case StructSymbol ns when ns.IsClass:
                    // Issue #1477: a closure / capture-box class synthesized for
                    // a lambda inside a GENERIC METHOD is nested in the (possibly
                    // non-generic) declaring type and was reified generic over
                    // the method's type parameters; push its remap so the Invoke
                    // signature + body translate method-TP references to the
                    // class's own Var slots. No-op for every other nested class.
                    using (this.remaps.PushSmRemap(ns))
                    {
                        EmitClassMethodBodies(ns);
                    }

                    break;
                case StructSymbol ns:
                    // Issue #1465: async state-machine structs are reified
                    // over their enclosing-type/method type parameters; push
                    // the SM TP remap so MoveNext bodies and signatures
                    // translate method-TP references to the SM's own Var
                    // slots. A no-op for non-generic structs.
                    using (this.remaps.PushSmRemap(ns))
                    {
                        EmitStructMethodBodies(ns);
                    }

                    break;

                // Enums own no method bodies.
            }
        }

        // Phase 4 emit parity (F2, type-erased): now that every generic
        // definition has its TypeDef + FieldDefs + ctor handles in the
        // lookup dictionaries, walk the bound program for constructed
        // StructSymbols (Box[int], Pair[string, int], ...) and alias them
        // to their definitions' rows.
        this.methodBodyPlanner.RegisterConstructedTypeAliases();        // B4. Per-package methods (ctor + user functions + entry).
        foreach (var pkg in packages)
        {
            this.typeDefEmitter.EmitDefaultConstructor();

            foreach (var fn in functionsByPackage[pkg])
            {
                if (!this.emitCtx.Program.Functions.TryGetValue(fn, out var body))
                {
                    body = this.lambdaBodies[fn];
                }

                // Issue #2118: a generic-promoted non-capturing lambda's
                // signature and body reference the enclosing type parameters;
                // push the remap so they encode as this method's own MVar slots.
                using (this.remaps.PushLambdaMethodRemap(fn))
                {
                    this.EmitFunction(fn, body, isEntryPoint: false);
                }
            }

            if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage && !entryPointIsClassOwned)
            {
                var entryBody = this.emitCtx.Program.Functions[this.emitCtx.Program.EntryPoint];
                this.EmitFunction(this.emitCtx.Program.EntryPoint, entryBody, isEntryPoint: true);
            }
        }

        // B5. SM class method bodies (ctors + instance methods).
        foreach (var c in smClasses)
        {
            // Issue #810: push the SM's outer-method-TP → class-TP remap so
            // that method signatures (return type, parameter types) and
            // bodies emitted for SM members translate outer-method TP
            // references to the SM class's own TP slots (Var(idx)).
            using (this.remaps.PushSmRemap(c))
            {
                var ctorHandle = this.typeDefEmitter.EmitClassDefaultConstructor(c);
                this.cache.ClassCtorHandles[c] = ctorHandle;

                if (c.HasPrimaryConstructor)
                {
                    var primaryHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c);
                    this.cache.ClassPrimaryCtorHandles[c] = primaryHandle;
                }

                if (!c.Methods.IsDefaultOrEmpty)
                {
                    foreach (var m in c.Methods)
                    {
                        if (!this.emitCtx.Program.Functions.TryGetValue(m, out var body))
                        {
                            body = this.lambdaBodies[m];
                        }

                        var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
                        this.cache.MethodHandles[m] = emittedHandle;
                    }
                }
            }
        }

        // B6. SM struct method bodies (MoveNext + SetStateMachine).
        foreach (var s in smStructsOrdered)
        {
            if (asyncSmPlansByStruct.TryGetValue(s, out var smPlan))
            {
                // Issue #2030 (gap 2): mirror the TypeDef emission above —
                // MoveNext/SetStateMachine bodies must see the same
                // outer-method-TP → SM-TP remap as the FieldDefs, or a
                // reference to a hoisted field/local whose declared type was
                // the kickoff's own type parameter (e.g. the retVal local for
                // `async func Foo[U](x U) U`) encodes as a dangling method
                // type-var (`!!0`) instead of the SM's own class type-var
                // (`!0`) — unverifiable IL / BadImageFormatException at load.
                using (this.remaps.PushSmRemap(s))
                {
                    this.stateMachines.EmitStateMachineMoveNext(smPlan);
                    this.stateMachines.EmitStateMachineSetStateMachine(smPlan);
                }
            }
        }

        // Issue #910 / ADR-0110: NestedClass rows for user-declared nested
        // types (class/struct/enum/interface declared inside a class/struct
        // body). The enclosing TypeDef row was emitted before the nested row
        // (ECMA-335 §II.22.32) because of the kind-partitioned emission order;
        // see BindNestedTypeDeclarations and the emission-order notes above.
        // The enclosing handle is always a StructSymbol (class or struct).
        void AddUserNestedTypeRow(TypeSymbol nested, TypeDefinitionHandle nestedHandle)
        {
            TypeSymbol containing = nested switch
            {
                StructSymbol ss => ss.ContainingType,
                EnumSymbol es => es.ContainingType,
                InterfaceSymbol ifs => ifs.ContainingType,
                _ => null,
            };

            if (containing is StructSymbol enclosingStruct
                && this.cache.StructTypeDefs.TryGetValue(enclosingStruct, out var enclosingHandle))
            {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle);
            }
        }

        // Issue #910 / ADR-0110: emit NestedClass rows in the same pre-order
        // the nested TypeDef rows were assigned. The NestedClass metadata table
        // must be sorted by the nested-type RID; nestedOrdered yields nested
        // handles in monotonically increasing RID order, so iterating it keeps
        // the table sorted across all nested kinds (class/struct/enum/interface).
        foreach (var nested in nestedOrdered)
        {
            switch (nested)
            {
                case StructSymbol ns when this.cache.StructTypeDefs.TryGetValue(ns, out var nsh):
                    AddUserNestedTypeRow(ns, nsh);
                    break;
                case EnumSymbol ne when this.cache.EnumTypeDefs.TryGetValue(ne, out var neh):
                    AddUserNestedTypeRow(ne, neh);
                    break;
                case InterfaceSymbol ni when this.cache.InterfaceTypeDefs.TryGetValue(ni, out var nih):
                    AddUserNestedTypeRow(ni, nih);
                    break;
            }
        }

        // NestedType entries. Each SM is nested inside its declaring type:
        // capture-bearing async lambda SMs inside their closure class,
        // an instance-method kickoff's SM inside the receiver type (so the
        // kickoff method retains access to the SM's `<>t__builder` field —
        // issue #502), and all others inside the per-package <Program>.
        var hostPkg = entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]);
        var defaultProgramHandle = hostPkg != null && programTypeDefHandles.TryGetValue(hostPkg, out var h) ? h : default;

        foreach (var c in smClasses)
        {
            var nestedHandle = this.cache.StructTypeDefs[c];
            if (this.methodBodyPlanner.TryGetUserKickoffReceiverHandle(c, out var receiverEnclosing))
            {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, receiverEnclosing);
                continue;
            }

            var smPkg = this.methodBodyPlanner.GetSmPackage(c, packages, entryPointPackage);
            var enclosingHandle = programTypeDefHandles.TryGetValue(smPkg, out var ph) ? ph : defaultProgramHandle;
            this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle);
        }

        foreach (var s in smStructsOrdered)
        {
            var nestedHandle = this.cache.StructTypeDefs[s];
            if (this.stateMachines.AsyncSmEnclosingClosures.TryGetValue(s, out var closureSym)
                && this.cache.StructTypeDefs.TryGetValue(closureSym, out var closureHandle))
            {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, closureHandle);
            }
            else if (this.methodBodyPlanner.TryGetUserKickoffReceiverHandle(s, out var receiverEnclosing))
            {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, receiverEnclosing);
            }
            else
            {
                var smPkg = this.methodBodyPlanner.GetSmPackage(s, packages, entryPointPackage);
                var enclosingHandle = programTypeDefHandles.TryGetValue(smPkg, out var ph) ? ph : defaultProgramHandle;
                this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle);
            }
        }

        // 6. Module + assembly rows. Reserve the MVID guid heap slot so we can
        // patch it with a content-derived value after PE serialization.
        var assemblyName = this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "Default";
        var mvidFixup = this.emitCtx.Metadata.ReserveGuid();
        this.emitCtx.Metadata.AddModule(
            generation: 0,
            moduleName: this.emitCtx.Metadata.GetOrAddString(assemblyName + ".dll"),
            mvid: mvidFixup.Handle,
            encId: default(GuidHandle),
            encBaseId: default(GuidHandle));

        var assemblyHandle = this.emitCtx.Metadata.AddAssembly(
            name: this.emitCtx.Metadata.GetOrAddString(assemblyName),
            version: this.assemblyAttrs.ParseAssemblyVersion(),
            culture: default(StringHandle),
            publicKey: default(BlobHandle),
            flags: 0,
            hashAlgorithm: AssemblyHashAlgorithm.Sha1);

        if (this.emitCtx.MetadataOnly)
        {
            this.assemblyAttrs.EmitReferenceAssemblyAttribute(assemblyHandle);
        }

        // Phase 7.7b: emit cross-language interop attributes for NuGet consumability.
        this.assemblyAttrs.EmitAssemblyInteropAttributes(assemblyHandle);
        if (!this.emitCtx.MetadataOnly && this.emitCtx.Pdb != null)
        {
            this.assemblyAttrs.EmitDebuggableAttribute(assemblyHandle);
        }

        // 7. Build the Portable PDB blob FIRST so we can wire its content id
        // (CodeView), SHA-256 checksum (PdbChecksum), and — when embedded —
        // the blob itself into the PE's DebugDirectory. PortablePdbEmitter
        // does not touch any stream here; we own sidecar / embedded routing.
        BlobBuilder pdbBlob = null;
        BlobContentId pdbContentId = default;
        byte[] pdbChecksum = null;
        var pdbEnabled = this.emitCtx.Pdb != null;
        if (pdbEnabled)
        {
            var peRowCounts = this.emitCtx.Metadata.GetRowCounts();
            (pdbBlob, pdbContentId) = this.emitCtx.Pdb.Serialize(
                peRowCounts,
                this.emitCtx.MetadataOnly ? default : entryHandle,
                ComputeDeterministicContentId);
            pdbChecksum = ComputePdbChecksum(pdbBlob);
        }

        // 8. Construct a DebugDirectoryBuilder when PDB emit is on, so the PE
        // image gains a real CodeView entry (sidecar discovery), PdbChecksum
        // entry (PE ↔ PDB pairing), Reproducible entry (deterministic emit),
        // and — when embedded — an EmbeddedPortablePdb entry containing the
        // full PDB blob inline. Pass null to ManagedPEBuilder when PDB is off
        // so the legacy emit path stays bit-for-bit identical.
        DebugDirectoryBuilder debugDirectory = null;
        var isEmbedded = this.emitCtx.DebugInformation.Format == DebugInformationFormat.Embedded;
        if (pdbEnabled)
        {
            debugDirectory = new DebugDirectoryBuilder();

            // CodeView: identifies the PDB the runtime/debugger should fetch.
            // For embedded format the path is conventionally just the bare
            // pdb file name (no directory) because the consumer reads it out
            // of the PE itself; for sidecar it must be an absolute path so
            // vsdbg/coreclr can locate the sidecar regardless of the
            // debugger's working directory. A relative path here would leave
            // breakpoints unbound. Mirrors the source-path fix in 34002ff.
            string codeViewPath;
            if (!string.IsNullOrEmpty(this.emitCtx.DebugInformation.PdbFilePath))
            {
                codeViewPath = isEmbedded
                    ? Path.GetFileName(this.emitCtx.DebugInformation.PdbFilePath)
                    : Path.GetFullPath(this.emitCtx.DebugInformation.PdbFilePath);
            }
            else
            {
                codeViewPath = (this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "module") + ".pdb";
            }

            debugDirectory.AddCodeViewEntry(
                pdbPath: codeViewPath,
                pdbContentId: pdbContentId,
                portablePdbVersion: PortablePdbVersion);

            // PdbChecksum: always emitted; lets symbol servers verify PE↔PDB
            // by content hash without trusting the file path.
            debugDirectory.AddPdbChecksumEntry(
                algorithmName: "SHA256",
                checksum: ImmutableArray.Create(pdbChecksum));

            // Reproducible: opt-in marker that this build is byte-deterministic.
            if (this.emitCtx.DebugInformation.Deterministic)
            {
                debugDirectory.AddReproducibleEntry();
            }

            // EmbeddedPortablePdb: only when /debug:embedded was requested.
            // The blob is compressed inside the PE; readers transparently
            // inflate via System.Reflection.PortableExecutable.PEReader.
            if (isEmbedded)
            {
                debugDirectory.AddEmbeddedPortablePdbEntry(pdbBlob, PortablePdbVersion);
            }
        }

        // 9. Serialize PE deterministically: a SHA-256 of the serialized PE
        // content produces the BlobContentId, which patches both the PE
        // TimeDateStamp and the reserved MVID guid in the metadata heap.
        // For reference assemblies we use MvidPEBuilder which adds a .mvid
        // PE section so MSBuild's CopyRefAssembly can efficiently extract
        // the module version identifier without loading full metadata.
        //
        // ADR-0087 §3 R1: the GenericParam table is required by ECMA-335
        // II.22.20 to be sorted by (Owner, Number). Because TypeDefs and
        // MethodDefs are emitted in interleaved visit orders, the rows
        // were buffered into emitCtx.PendingGenericParameters and are
        // flushed in sorted order here, just before PE serialisation.
        TypeDefEmitter.FlushPendingGenericParameters(this.emitCtx, this.GetElementTypeToken, this.BuildUnmanagedConstraintTypeSpec);
        var peHeaderBuilder = new PEHeaderBuilder(
            imageCharacteristics: entryHandle.IsNil
                ? Characteristics.Dll | Characteristics.ExecutableImage
                : Characteristics.ExecutableImage);
        var peBlob = new BlobBuilder();
        BlobContentId contentId;
        if (this.emitCtx.MetadataOnly)
        {
            var mvidBuilder = new MvidPEBuilder(
                header: peHeaderBuilder,
                metadataRootBuilder: new MetadataRootBuilder(this.emitCtx.Metadata),
                ilStream: this.emitCtx.IlStream,
                entryPoint: default,
                debugDirectoryBuilder: debugDirectory,
                deterministicIdProvider: ComputeDeterministicContentId);
            contentId = mvidBuilder.Serialize(peBlob, out var mvidSectionFixup);
            new BlobWriter(mvidSectionFixup).WriteGuid(contentId.Guid);
        }
        else
        {
            var peBuilder = new ManagedPEBuilder(
                header: peHeaderBuilder,
                metadataRootBuilder: new MetadataRootBuilder(this.emitCtx.Metadata),
                ilStream: this.emitCtx.IlStream,
                entryPoint: entryHandle,
                debugDirectoryBuilder: debugDirectory,
                deterministicIdProvider: ComputeDeterministicContentId);
            contentId = peBuilder.Serialize(peBlob);
        }

        mvidFixup.CreateWriter().WriteGuid(contentId.Guid);
        peBlob.WriteContentTo(peStream);

        // 10. Phase 4–7 PDB sidecar routing. Embedded format suppresses the
        // sidecar — the blob already lives in the PE. Portable format writes
        // to the supplied stream when one was provided (callers that want
        // only an embedded PDB pass `pdbStream: null`).
        if (pdbEnabled && !isEmbedded && this.emitCtx.PdbStream != null)
        {
            pdbBlob.WriteContentTo(this.emitCtx.PdbStream);
        }
    }

    /// <summary>
    /// Computes the SHA-256 checksum of the serialized Portable PDB content,
    /// matching the algorithm name written into the <c>PdbChecksum</c> debug
    /// directory entry. Returning a fresh byte array keeps callers from
    /// having to thread <see cref="IncrementalHash"/> through the call site.
    /// </summary>
    private static byte[] ComputePdbChecksum(BlobBuilder pdbBlob)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var blob in pdbBlob.GetBlobs())
        {
            var bytes = blob.GetBytes();
            sha.AppendData(bytes.Array, bytes.Offset, bytes.Count);
        }

        return sha.GetHashAndReset();
    }

    /// <summary>
    /// Derives the module MVID and PE timestamp from a SHA-256 hash of the
    /// serialized PE content blobs, mirroring Roslyn's deterministic emit so
    /// the same bound program always produces a byte-for-byte identical PE.
    /// </summary>
    private static BlobContentId ComputeDeterministicContentId(IEnumerable<Blob> content)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var blob in content)
        {
            var bytes = blob.GetBytes();
            sha.AppendData(bytes.Array, bytes.Offset, bytes.Count);
        }

        return BlobContentId.FromHash(sha.GetHashAndReset());
    }

    /// <summary>
    /// Issue #191: emits one static <c>FieldDef</c> per user-declared top-level
    /// <c>var</c>/<c>let</c>/<c>const</c> on the entry-point package's
    /// <c>&lt;Program&gt;</c> TypeDef. Initialization stays in the entry-point
    /// method body and runs via <c>stsfld</c> as each declaration is reached,
    /// preserving existing side-effect ordering (e.g. a top-level
    /// <c>let ch = make(chan int)</c> followed by sends/receives).
    /// </summary>
    /// <remarks>
    /// The <c>InitOnly</c> flag is intentionally omitted for <c>let</c>/<c>const</c>
    /// globals: enforcing it would require moving initialization into a
    /// <c>.cctor</c>, which would reorder execution relative to interleaved
    /// top-level statements. Tracking InitOnly is left as a #191 follow-up.
    /// </remarks>
    private void EmitGlobalFieldDefs(ImmutableArray<GlobalVariableSymbol> globals)
    {
        foreach (var g in globals)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), g.Type);

            var attrs = AccessibilityMap.MapFieldAccessibility(g.Accessibility) | FieldAttributes.Static;

            var handle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(g.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));

            this.cache.GlobalFieldDefs[g] = handle;

            // Route any @-annotations bound by #187 onto the FieldDef row so
            // attributes like @Obsolete round-trip into CustomAttribute rows.
            this.customAttrEncoder.EmitUserAttributes(handle, g, AttributeTargetKind.Field);
            this.customAttrEncoder.EmitNullableAttributeOnField(handle, g.Type);
        }
    }

    /// <summary>
    /// PR-E-10 body-emit callback used by
    /// <see cref="StateMachineEmitter.EmitStateMachineMoveNext"/>. Builds the
    /// Shared plumbing for every method-body scaffold in this emitter. It owns
    /// the ~19 slot-tracking dictionaries, runs the
    /// <see cref="MethodBodyPlanner.CollectLocalsAndLabels"/> slot planner,
    /// encodes the locals signature, and constructs the
    /// <see cref="MethodBodyEmitter"/>. Centralizing the dictionaries, the
    /// 22-argument planner call and the 25-argument emitter construction keeps
    /// them in exactly one place so a fix applies to every scaffold at once and
    /// can no longer drift between the near-identical copies.
    /// </summary>
    internal sealed class MethodBodyEmitSession
    {
        private readonly ReflectionMetadataEmitter outer;
        private readonly Dictionary<VariableSymbol, int> locals = new();
        private readonly Dictionary<BoundLabel, LabelHandle> labels = new();
        private readonly List<TypeSymbol> localTypes = new();
        private readonly Dictionary<BoundAppendExpression, (int Src, int Dst)> appendSlots = new();
        private readonly Dictionary<BoundStructLiteralExpression, int> structLiteralSlots = new();
        private readonly Dictionary<BoundDefaultExpression, int> defaultExpressionSlots = new();
        private readonly Dictionary<BoundIndexExpression, int> mapIndexSlots = new();
        private readonly Dictionary<BoundPatternSwitchStatement, int> patternSwitchSlots = new();
        private readonly Dictionary<BoundTypePattern, int> typePatternScratchSlots = new();
        private readonly Dictionary<BoundSwitchExpression, (int Result, int Discriminant)> switchExpressionSlots = new();
        private readonly Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)> channelOpSlots = new();
        private readonly Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)> scopeFrameSlots = new();
        private readonly Dictionary<BoundSelectStatement, SelectSlots> selectStatementSlots = new();
        private readonly Dictionary<BoundExpression, int> receiverSpillSlots = new();
        private readonly Dictionary<BoundStackAllocExpression, int> stackAllocResultSlots = new();
        private readonly Dictionary<BoundExpression, int> indexAssignmentValueSlots = new();
        private readonly Dictionary<BoundGoStatement, BoundScopeStatement> goEnclosingScopes = new();
        private readonly Dictionary<BoundExpression, LiftedBinarySlots> liftedBinarySlots = new();
        private readonly Dictionary<BoundBinaryExpression, int> nullableCoalesceSpillSlots = new();
        private readonly Dictionary<VariableSymbol, object> constValues = new();

        public MethodBodyEmitSession(ReflectionMetadataEmitter outer, InstructionEncoder il)
        {
            this.outer = outer;
            this.Il = il;
        }

        /// <summary>Gets the instruction encoder that all planned/emitted IL flows through.</summary>
        public InstructionEncoder Il { get; }

        /// <summary>Gets the collected local-variable slot map (for PDB local info capture).</summary>
        public Dictionary<VariableSymbol, int> Locals => this.locals;

        /// <summary>Gets the collected compile-time constant bindings (for PDB local-constant capture).</summary>
        public Dictionary<VariableSymbol, object> ConstValues => this.constValues;

        /// <summary>Issue #216: collects compile-time const bindings before slot allocation.</summary>
        /// <param name="body">The bound body to scan for const bindings.</param>
        public void CollectConstValues(BoundBlockStatement body)
            => MethodBodyPlanner.CollectConstValues(body, this.constValues);

        /// <summary>
        /// Runs the slot planner for one body region, appending to the shared
        /// slot dictionaries. May be called more than once (e.g. base-initializer
        /// arguments and field initializers are planned separately).
        /// </summary>
        /// <param name="body">The bound body region contributing locals/labels.</param>
        /// <param name="function">The owning function, or <see langword="null"/> for synthesized bodies.</param>
        public void Plan(BoundBlockStatement body, FunctionSymbol function = null)
        {
            this.outer.methodBodyPlanner.CollectLocalsAndLabels(
                body,
                function,
                this.locals,
                this.localTypes,
                this.labels,
                this.appendSlots,
                this.structLiteralSlots,
                this.defaultExpressionSlots,
                this.mapIndexSlots,
                this.patternSwitchSlots,
                this.typePatternScratchSlots,
                this.switchExpressionSlots,
                this.channelOpSlots,
                this.scopeFrameSlots,
                this.selectStatementSlots,
                this.receiverSpillSlots,
                this.indexAssignmentValueSlots,
                this.goEnclosingScopes,
                this.liftedBinarySlots,
                this.nullableCoalesceSpillSlots,
                this.Il,
                this.stackAllocResultSlots);
        }

        /// <summary>Encodes the collected locals into a standalone signature (default when there are none).</summary>
        /// <returns>The locals signature handle, or <c>default</c> when no locals were collected.</returns>
        public StandaloneSignatureHandle BuildLocalsSignature()
        {
            if (this.localTypes.Count == 0)
            {
                return default;
            }

            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(this.localTypes.Count);
            foreach (var t in this.localTypes)
            {
                this.outer.EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            return this.outer.emitCtx.Metadata.AddStandaloneSignature(
                this.outer.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        /// <summary>Constructs the body emitter over the collected slot dictionaries.</summary>
        /// <param name="parameters">The parameter-to-IL-slot map for the method.</param>
        /// <param name="structThisParameter">The struct <c>this</c> parameter, when arg0 is a managed pointer.</param>
        /// <param name="asyncFieldMap">The async state-machine field map (MoveNext only).</param>
        /// <param name="asyncPlan">The async state-machine plan (MoveNext only).</param>
        /// <param name="asyncIteratorEmitCtx">The async-iterator emit context (async-iterator MoveNext only).</param>
        /// <param name="enclosingClosure">The enclosing closure info (closure invoke methods only).</param>
        /// <returns>A configured <see cref="MethodBodyEmitter"/>.</returns>
        public MethodBodyEmitter CreateEmitter(
            Dictionary<ParameterSymbol, int> parameters,
            ParameterSymbol structThisParameter = null,
            AsyncStateMachineFieldMap asyncFieldMap = null,
            AsyncStateMachinePlan asyncPlan = null,
            StateMachineEmitter.AsyncIteratorEmitContext asyncIteratorEmitCtx = null,
            ClosureEmitter.ClosureInfo enclosingClosure = null)
        {
            return new MethodBodyEmitter(
                this.outer,
                this.Il,
                this.locals,
                parameters,
                this.labels,
                this.appendSlots,
                this.structLiteralSlots,
                this.defaultExpressionSlots,
                this.mapIndexSlots,
                this.patternSwitchSlots,
                this.typePatternScratchSlots,
                this.switchExpressionSlots,
                this.channelOpSlots,
                this.scopeFrameSlots,
                this.selectStatementSlots,
                this.receiverSpillSlots,
                this.indexAssignmentValueSlots,
                this.goEnclosingScopes,
                liftedBinarySlots: this.liftedBinarySlots,
                nullableCoalesceSpillSlots: this.nullableCoalesceSpillSlots,
                structThisParameter: structThisParameter,
                asyncFieldMap: asyncFieldMap,
                asyncPlan: asyncPlan,
                asyncIteratorEmitCtx: asyncIteratorEmitCtx,
                constValues: this.constValues,
                enclosingClosure: enclosingClosure,
                stackAllocResultSlots: this.stackAllocResultSlots);
        }
    }

    /// <summary>
    /// raw method-body bytes for an async state-machine MoveNext using the
    /// rewritten bound-tree from <see cref="MoveNextBodyRewriter"/>. Returns
    /// <c>BodyOffset = -1</c> under <see cref="EmitContext.MetadataOnly"/>.
    /// This helper retains the BodyEmitter-driven IL emission so the
    /// still-private BodyEmitter nested class doesn't need a sibling-facing
    /// surface — StateMachineEmitter consumes it via an injected
    /// <c>Func&lt;AsyncStateMachinePlan, MoveNextBodyResult&gt;</c> callback.
    /// Scheduled to move with BodyEmitter in PR-E-11 MethodBodyEmitter.
    /// </summary>
    private StateMachineEmitter.MoveNextBodyResult BuildMoveNextBodyBytes(AsyncStateMachinePlan plan)
    {
        int bodyOffset = -1;
        IReadOnlyList<SequencePoint> capturedSequencePoints = null;
        IReadOnlyList<LocalInfo> capturedLocals = null;
        IReadOnlyList<LocalConstantInfo> capturedConstants = null;
        int capturedCodeSize = 0;
        StandaloneSignatureHandle capturedLocalsSignature = default;
        if (!this.emitCtx.MetadataOnly)
        {
            var moveNextBody = MoveNextBodyRewriter.Build(plan);
            var body = moveNextBody.Body;

            var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
            var session = new MethodBodyEmitSession(this, il);

            // Issue #216: collect compile-time const bindings before slot allocation.
            session.CollectConstValues(body);
            session.Plan(body);

            // MoveNext is instance on the SM struct: arg0 = this.
            var parameters = new Dictionary<ParameterSymbol, int>
            {
                [moveNextBody.ThisParameter] = 0,
            };

            var localsSignature = session.BuildLocalsSignature();
            var emitter = session.CreateEmitter(
                parameters,
                structThisParameter: moveNextBody.ThisParameter,
                asyncFieldMap: plan.FieldMap,
                asyncPlan: plan);

            try
            {
                emitter.EmitBlock(body);
            }
            catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
            {
                var anchor = emitter.CurrentAnchor ?? plan.KickoffMethod?.Declaration ?? body.Syntax;
                EmitDiagnosticException.Wrap(anchor, ex);
            }

            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
            capturedSequencePoints = emitter.SequencePoints;
            capturedLocals = MethodBodyPlanner.CollectLocalInfo(session.Locals);
            capturedConstants = MethodBodyPlanner.CollectLocalConstantInfo(session.ConstValues);
            capturedCodeSize = il.Offset;
            capturedLocalsSignature = localsSignature;
        }

        return new StateMachineEmitter.MoveNextBodyResult(
            bodyOffset,
            capturedSequencePoints,
            capturedLocals,
            capturedConstants,
            capturedCodeSize,
            capturedLocalsSignature);
    }

    // PR-E-5: EmitDefaultValue(InstructionEncoder, Type) moved to
    // ConversionEmitter. The pre-refactor source had no callers for this
    // helper — it sits in the conversion-shaped emit surface alongside
    // EmitBoxIfNeeded and is preserved for parity / future use.

    /// <summary>
    /// Encodes the CLR return type for an async kickoff method:
    /// <c>Task</c>, <c>Task&lt;T&gt;</c>, or <c>void</c> for async-void.
    /// </summary>
    // PR-E-19: widened private → internal so the extracted UserTokenResolver can
    // call it through the `outer` back-reference (EncodeFunctionReturnSymbol's
    // async-kickoff branch). Stays on the root because it is part of the async
    // return-type emission band (used by EmitCore too), not the user-token band.
    internal void EncodeAsyncReturnType(ReturnTypeEncoder encoder, AsyncStateMachinePlan plan)
    {
        var builderInfo = plan.StateMachine.BuilderInfo;
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            encoder.Void();
        }
        else if (builderInfo.TaskProperty != null)
        {
            if (TryCreateSymbolicAsyncTaskType(plan.StateMachine, out var symbolicTaskType))
            {
                this.EncodeTypeSymbol(encoder.Type(), symbolicTaskType);
            }
            else
            {
                // The Task property's return type IS the kickoff return type.
                var taskClrType = builderInfo.TaskProperty.PropertyType;
                this.EncodeClrType(encoder.Type(), taskClrType);
            }
        }
        else
        {
            encoder.Void();
        }
    }

    private MethodDefinitionHandle EmitFunction(FunctionSymbol function, BoundBlockStatement body, bool isEntryPoint)
    {
        // ADR-0086 / issue #727 + ADR-0092 / issue #758: P/Invoke functions
        // skip body emission. Classic @DllImport functions route through the
        // ImplMap / ModuleRef path; @LibraryImport functions route through
        // the explicit-stub path that emits a managed marshalling wrapper
        // plus a hidden blittable inner P/Invoke.
        if (function.IsPInvoke)
        {
            if (function.PInvokeMetadata.IsLibraryImport)
            {
                return this.EmitLibraryImportFunction(function);
            }

            return this.EmitPInvokeFunction(function);
        }

        if (this.stateMachines.IteratorKickoffBodies.TryGetValue(function, out var iteratorKickoffBody))
        {
            body = iteratorKickoffBody;
        }

        // Async kickoff body: replace the user body with the kickoff stub
        // that creates the state machine, initializes it, and calls Start.
        AsyncStateMachinePlan asyncPlan = null;
        if (function.IsAsync && function.StateMachineType != null)
        {
            foreach (var plan in this.stateMachines.AsyncStateMachinePlans)
            {
                if (plan.KickoffMethod == function)
                {
                    asyncPlan = plan;
                    break;
                }
            }
        }

        // Phase 4 emit parity (F1): generic functions are emitted with a
        // type-erased signature — each open type parameter is encoded as
        // System.Object via EncodeTypeSymbol. Call sites insert the box /
        // unbox.any around the boundary. This matches the interpreter's
        // type-erased semantics. ADR-0004 still calls for CLR reified
        // generics as the long-term goal; F2 will widen to GenericParam +
        // MVAR/VAR encoding and add a MethodSpec at call sites.
        int bodyOffset = -1;
        IReadOnlyList<SequencePoint> capturedSequencePoints = null;
        IReadOnlyList<LocalInfo> capturedLocals = null;
        IReadOnlyList<LocalConstantInfo> capturedConstants = null;
        int capturedCodeSize = 0;
        StandaloneSignatureHandle capturedLocalsSignature = default;

        // Issue #987: an abstract method (a no-body `open func F() R;`) has no
        // IL body — leave bodyOffset at -1 so AddMethodDefinition writes an
        // abstract virtual slot. The MethodAttributes.Abstract bit is OR'd in
        // below alongside Virtual/NewSlot.
        if (!this.emitCtx.MetadataOnly && !function.IsAbstract)
        {
            if (asyncPlan != null)
            {
                // Issue #1904: an async entry point (`async func Main()` /
                // top-level `await`) must expose a CLR-valid void/int32
                // signature — never Task/Task<T> (the runtime throws
                // MethodAccessException at process start otherwise). Drive
                // the task to completion synchronously right inside the
                // kickoff body instead of returning it.
                var driveSynchronously = isEntryPoint && asyncPlan.StateMachine.BuilderInfo.TaskProperty != null;
                bodyOffset = this.stateMachines.EmitAsyncKickoffBody(function, asyncPlan, driveSynchronously);
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var session = new MethodBodyEmitSession(this, il);

                // Issue #216: collect compile-time const bindings before slot allocation.
                session.CollectConstValues(body);
                session.Plan(body, function);

                // For instance methods, IL slot 0 is the implicit `this`, so user
                // parameters shift up by one. Both the synthesized `ThisParameter`
                // (slot 0) and the user parameters are registered so emit sites
                // can resolve either.
                var parameters = new Dictionary<ParameterSymbol, int>();
                int paramSlotShift = function.IsInstanceMethod ? 1 : 0;
                if (function.IsInstanceMethod)
                {
                    parameters[function.ThisParameter] = 0;
                }

                var emittedParameterIndex = 0;
                for (var i = 0; i < function.Parameters.Length; i++)
                {
                    if (ReferenceEquals(function.Parameters[i], function.ThisParameter))
                    {
                        continue;
                    }

                    parameters[function.Parameters[i]] = emittedParameterIndex + paramSlotShift;
                    emittedParameterIndex++;
                }

                var localsSignature = session.BuildLocalsSignature();

                // Detect async iterator MoveNext and thread emit context.
                StateMachineEmitter.AsyncIteratorEmitContext aiEmitCtx = null;
                if (function.Name == "MoveNext" && function.ReceiverType is StructSymbol owningSmClass)
                {
                    this.stateMachines.AsyncIteratorEmitContexts.TryGetValue(owningSmClass, out aiEmitCtx);
                }

                // For struct instance methods, pass structThisParameter so the
                // BodyEmitter knows arg0 is already a managed pointer (ref T) and
                // emits ldarg.0 instead of ldarga.0 when accessing fields via this.
                ParameterSymbol structThis = null;
                if (function.IsInstanceMethod
                    && function.ReceiverType is StructSymbol recvStruct
                    && !recvStruct.IsClass)
                {
                    structThis = function.ThisParameter;
                }

                var enclosingClosureInfo = this.closures.ClosureInvokeToInfo.TryGetValue(function, out var ec) ? ec : null;
                var emitter = session.CreateEmitter(
                    parameters,
                    structThisParameter: structThis,
                    asyncIteratorEmitCtx: aiEmitCtx,
                    enclosingClosure: enclosingClosureInfo);

                // 6.2 SilentEmitFailure invariant: wrap the per-function
                // EmitBlock in a try/catch so any exception that escapes the
                // body emitter is re-thrown as EmitDiagnosticException anchored
                // at the last-visited BoundNode (or the function's syntax).
                try
                {
                    emitter.EmitBlock(body);
                }
                catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
                {
                    var anchor = emitter.CurrentAnchor ?? function.Declaration ?? body.Syntax;
                    EmitDiagnosticException.Wrap(anchor, ex);
                }

                // Always cap with a trailing ret. Lowering does not guarantee one for void.
                if (function.Type == TypeSymbol.Void)
                {
                    il.OpCode(ILOpCode.Ret);
                }

                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
                capturedSequencePoints = emitter.SequencePoints;
                capturedLocals = MethodBodyPlanner.CollectLocalInfo(session.Locals);
                capturedConstants = MethodBodyPlanner.CollectLocalConstantInfo(session.ConstValues);
                capturedCodeSize = il.Offset;
                capturedLocalsSignature = localsSignature;
            } // end else (non-async path)
        }

        var sigBlob = new BlobBuilder();
        var signatureParameterCount = function.Parameters.Length - (function.ExplicitReceiverParameter == null ? 0 : 1);
        new BlobEncoder(sigBlob).MethodSignature(
                isInstanceMethod: function.IsInstanceMethod,
                genericParameterCount: function.TypeParameters.IsDefaultOrEmpty ? 0 : function.TypeParameters.Length)
            .Parameters(
                signatureParameterCount,
                r =>
                {
                    // Issue #1904: an async entry point signature must be
                    // void/int32/uint32 (function.Type), not the async
                    // builder's Task/Task<T> — the kickoff body above already
                    // blocks on the task and unwraps the result to match.
                    if (asyncPlan != null && !(isEntryPoint && asyncPlan.StateMachine.BuilderInfo.TaskProperty != null))
                    {
                        this.EncodeAsyncReturnType(r, asyncPlan);
                    }
                    else
                    {
                        EncodeReturnSymbol(r, function.Type, function.ReturnRefKind);
                    }
                },
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        if (ReferenceEquals(p, function.ThisParameter))
                        {
                            continue;
                        }

                        // ADR-0060: encode ref-kind parameters as `T&` (managed pointer).
                        // The pointee type is encoded via the inner Type() encoder. For `in`,
                        // emit a modreq(System.Runtime.CompilerServices.IsReadOnlyAttribute) on
                        // the parameter signature so consumers (e.g. C#) treat the call site as
                        // readonly. ParameterAttributes (Out / In) are stamped on the per-parameter
                        // metadata row below. Issue #1610: this encoding is shared with the
                        // interface abstract / static-virtual slot paths so the interface
                        // signature and its implementation can never drift apart.
                        TypeDefEmitter.EncodeParameterSignature(ps, p, this.signatures.EncodeTypeSymbol, this.wellKnown);
                    }
                });

        // Synthesized entry point uses the C#-style mangled name; explicit Main / user funcs keep their source name.
        // ADR-0149: a method declared with an explicit-interface qualifier
        // clause keeps its plain source name on the FunctionSymbol (for
        // diagnostics and any ordinary same-type call resolution), but the
        // emitted CLR metadata name must be collision-free — see
        // ExplicitInterfaceMetadataNaming's remarks. Checked via
        // ExplicitInterfaceClauseTarget != null rather than
        // HasExplicitInterfaceClause (which is Declaration-derived): a
        // computed property's getter/setter accessor is its OWN
        // FunctionSymbol whose Declaration is a PropertyAccessorSyntax with
        // no clause of its own, so only the settable ExplicitInterfaceClauseTarget
        // (propagated from the owning PropertySymbol by
        // DeclarationBinder.ResolveExplicitInterfaceClauses) reflects it.
        var methodName = isEntryPoint && function.Declaration is null
            ? "<Main>$"
            : function.ExplicitInterfaceClauseTarget != null
                ? ExplicitInterfaceMetadataNaming.GetMetadataName(function.Name, function.ExplicitInterfaceClauseTarget)
                : function.Name;

        // The synthesized entry point must remain Public so the runtime can find it.
        // ADR-0149: an explicit-interface qualifier clause member is ALWAYS
        // private in CLR metadata, exactly like C#'s explicit interface
        // implementations (which don't even accept an accessibility
        // modifier in source — CS0106) — it is reachable only through
        // interface dispatch (via the MethodImpl row bound elsewhere), never
        // by an ordinary same-type call or external caller. This overrides
        // whatever accessibility the member's declaration happens to carry
        // (defaulting to Public like any other member with no modifier)
        // and applies uniformly to methods and to property/event accessor
        // FunctionSymbols reached through this same shared emission path.
        var effectiveAccessibility = function.ExplicitInterfaceClauseTarget != null
            ? Accessibility.Private
            : function.Accessibility;
        var visibility = isEntryPoint && function.Declaration is null
            ? MethodAttributes.Public
            : AccessibilityMap.ToMethodVisibility(effectiveAccessibility, AccessibilityMap.IsTopLevelProgramMember(function));

        // Instance methods omit MethodAttributes.Static. Phase 3.B.3 sub-step 3
        // models open/override per ADR-0017 for classes:
        //   plain (neither):    Virtual | NewSlot | Final  (callvirt-safe, non-overridable)
        //   open:               Virtual | NewSlot          (overridable in derived)
        //   override (sealed):  Virtual | Final            (reuses base slot, no further override)
        //   open override:      Virtual                    (reuses base slot, still overridable)
        //
        // Issue #409 follow-up: plain instance methods on value-type StructSymbol
        // receivers use the C#-conventional HideBySig-only shape. Value-type
        // overrides and interface implementations still need virtual slots for
        // CLR dispatch through the base/interface vtable.
        var methodAttrs = visibility | MethodAttributes.HideBySig;

        // Stream D: extension functions whose name follows the CLR `op_*`
        // convention came from `func (a T) operator +(...)` and should round-
        // trip as SpecialName so consumers (e.g. C#) see them as operators.
        if (function.IsExtension && function.Name != null && function.Name.StartsWith("op_"))
        {
            methodAttrs |= MethodAttributes.SpecialName;
        }

        // Issue #257: event accessor methods (add_X, remove_X, raise_X) are marked SpecialName.
        if (function.IsSpecialName)
        {
            methodAttrs |= MethodAttributes.SpecialName;
        }

        if (function.IsInstanceMethod)
        {
            var receiverStruct = function.ReceiverType as StructSymbol;
            var receiverIsValueType = receiverStruct != null && !receiverStruct.IsClass;
            var receiverIsInterface = function.ReceiverType is InterfaceSymbol;

            // Issue #2361: a user-declared "ToString" on a data class/struct
            // suppresses the synthesized ToString (see
            // DataStructSynthesizer.HasUserToStringOverride /
            // EmitDataStructSynthesizedMembers) and must take over its exact
            // CLR vtable slot instead of getting a brand-new one — otherwise
            // polymorphic dispatch through a base-typed reference would still
            // resolve to System.Object.ToString (or, for a derived data
            // class, the base's synthesized/user ToString would stop being
            // re-overridable). The binder only ever lets a "ToString"-named
            // method reach an IsData type's Methods list when its shape
            // exactly matches the synthesized one (see
            // DeclarationBinder.IsCompatibleDataToStringOverride), so no
            // extra shape check is needed here.
            bool isDataToStringOverride = receiverStruct != null && receiverStruct.IsData && function.Name == "ToString";

            if (receiverIsInterface && function.Accessibility != Accessibility.Private)
            {
                // ADR-0085 / issue #726: an instance method whose receiver is
                // an interface is a default-interface method (DIM). Emit it
                // as Public | HideBySig | Virtual | NewSlot — NOT Final
                // (implementers may override) and NOT Abstract (the body is
                // emitted below). `MethodImplAttributes.IL | Managed` is
                // already the default for EmitFunction's AddMethodDefinition
                // call, so no further tweak is needed.
                methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
            }
            else if (receiverIsInterface)
            {
                // ADR-0090 / issue #756: a `private` interface helper is NOT
                // part of the v-table — it does not get Virtual / NewSlot /
                // Final. It is emitted as Private | HideBySig (instance) with
                // a body and is callable only from sibling members of the
                // same interface. Visibility was set above via AccessibilityMap.
                //
                // Fall through — no further attribute stamping needed.
            }
            else if (isDataToStringOverride || !receiverIsValueType || MethodInfoHelpers.RequiresVirtualOnValueType(function, receiverStruct))
            {
                methodAttrs |= MethodAttributes.Virtual;
                if (!function.IsOverride && !isDataToStringOverride)
                {
                    methodAttrs |= MethodAttributes.NewSlot;
                }

                if (isDataToStringOverride ? DataStructSynthesizer.IsDataObjectOverrideFinal(receiverStruct) : !function.IsOpen)
                {
                    methodAttrs |= MethodAttributes.Final;
                }

                // Issue #987: an abstract method declares a virtual slot with no
                // implementation. It is always `open` (so never Final above) and
                // carries the Abstract bit; the body-emission block was skipped
                // and bodyOffset stays -1.
                if (function.IsAbstract)
                {
                    methodAttrs |= MethodAttributes.Abstract;
                }
            }
        }
        else
        {
            methodAttrs |= MethodAttributes.Static;

            // ADR-0089 / issue #755: a static-virtual interface method
            // *with* a default body still needs the virtual / newslot
            // flags so the slot remains overridable by implementers.
            // <c>FunctionSymbol.IsStatic</c> + <c>StaticOwnerType is
            // InterfaceSymbol</c> identifies this case.
            //
            // ADR-0090 / issue #756: a `private static` interface helper is
            // NOT virtual — it is private-by-default and the type-parameter
            // dispatch table does not include it. Suppress Virtual / NewSlot.
            if (function.IsStatic && function.StaticOwnerType is InterfaceSymbol && function.Accessibility != Accessibility.Private)
            {
                methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
            }
        }

        // Issue #170 / ADR-0047 §3: emit a Parameter row per source parameter
        // so we can attach a CustomAttribute to each one. The first emitted
        // ParameterHandle becomes the MethodDef.parameterList anchor; if the
        // function has no parameters we leave it pointing at the next ordinal.
        //
        // Issue #172: when the function carries any `@return:` annotations,
        // emit a Parameter row with sequence number 0 (ECMA-335 II.22.33) in
        // front of the source-parameter rows so we can attach return-target
        // CustomAttribute rows to it.
        //
        // Issue #834: per-parameter / return [NullableAttribute] also needs to
        // attach to its corresponding Param row. Compute the nullable byte
        // arrays up front so we know whether to synthesise a sequence-0 return
        // Param row before emitting the source-parameter rows (the order
        // matters: ECMA-335 II.22.33 mandates that Param rows for a method
        // appear in ascending sequence number, anchored by
        // MethodDef.parameterList).
        var firstParamHandle = this.customAttrEncoder.NextParameterHandle();
        var hasReturnAttributes = !function.Attributes.IsDefaultOrEmpty
            && function.Attributes.Any(a => a.Target == AttributeTargetKind.Return);

        // Compute nullable flags for return + each non-`this` parameter. Async
        // kickoff methods get an empty return-slot here because the actual
        // emitted return type is `Task` / `Task<T>`, not `function.Type`; its
        // reference-non-nullable shape (byte 1) matches the assembly-level
        // NullableContextAttribute(1) default, so omitting the per-return
        // attribute is equivalent to emitting `[NullableAttribute(1)]`.
        var returnFlags = asyncPlan != null
            ? ImmutableArray<byte>.Empty
            : NullableFlagsBuilder.Build(function.Type);
        var paramFlagsList = new List<ImmutableArray<byte>>();
        foreach (var p in function.Parameters)
        {
            if (ReferenceEquals(p, function.ThisParameter))
            {
                continue;
            }

            paramFlagsList.Add(NullableFlagsBuilder.Build(p.Type));
        }

        // Pick a method-level NullableContextAttribute. Roslyn picks the
        // single byte value that appears most often across return + parameter
        // positions (ties go to NotAnnotated = 1, which is also the assembly
        // default), emits NullableContextAttribute(common) on the method when
        // `common` differs from the assembly default, and skips per-position
        // NullableAttribute rows that match `common` exactly. The result is
        // the most compact metadata shape C# emits for the same source.
        var (effectiveDefault, contextByteToEmit) = ChooseMethodNullableContext(returnFlags, paramFlagsList);

        var returnNeedsNullableAttribute =
            !returnFlags.IsDefaultOrEmpty
            && !(returnFlags.Length == 1 && returnFlags[0] == effectiveDefault);

        ParameterHandle? returnParamHandle = null;
        if (hasReturnAttributes || returnNeedsNullableAttribute)
        {
            returnParamHandle = this.emitCtx.Metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: default(StringHandle),
                sequenceNumber: 0);
        }

        var paramHandles = new List<(ParameterSymbol Symbol, ParameterHandle Handle, ImmutableArray<byte> NullableFlags)>();
        var sequenceNumber = 1;
        var flagsIndex = 0;
        foreach (var p in function.Parameters)
        {
            if (ReferenceEquals(p, function.ThisParameter))
            {
                continue;
            }

            // ADR-0060 §6: stamp the per-parameter row with ParameterAttributes.Out for
            // `out`, .In for `in`. `ref` carries neither (the CLR distinguishes ref from
            // out only via the .out flag); the `in` parameter also gets an
            // IsReadOnlyAttribute custom attribute below.
            var paramAttributes = ParameterAttributes.None;
            if (p.RefKind == RefKind.Out)
            {
                paramAttributes |= ParameterAttributes.Out;
            }
            else if (p.RefKind == RefKind.In)
            {
                paramAttributes |= ParameterAttributes.In;
            }

            // ADR-0063 §10: optional parameters with a compile-time constant
            // default get the Optional+HasDefault flags plus a Constant row.
            if (p.HasExplicitDefaultValue)
            {
                paramAttributes |= ParameterAttributes.Optional | ParameterAttributes.HasDefault;
            }

            var paramHandle = this.emitCtx.Metadata.AddParameter(
                attributes: paramAttributes,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: sequenceNumber++);

            if (p.RefKind == RefKind.In)
            {
                this.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(paramHandle);
            }

            // ADR-0101 / issue #799: emit [ParamArrayAttribute] on the
            // trailing variadic parameter so C#/F# consumers expand the
            // argument list at the call site exactly as they would for a
            // C# `params T[]` method. The variadic flag is propagated
            // through the ParameterSymbol by DeclarationBinder.
            if (p.IsVariadic)
            {
                this.customAttrEncoder.EmitParamArrayAttributeOnParameter(paramHandle);
            }

            // ADR-0063 §10: emit the Constant row carrying the default value.
            if (p.HasExplicitDefaultValue)
            {
                this.emitCtx.Metadata.AddConstant(paramHandle, p.ExplicitDefaultValue);
            }

            paramHandles.Add((p, paramHandle, paramFlagsList[flagsIndex++]));
        }

        // ADR-0084 §L5 / issue #806: honour `@MethodImpl(MethodImplOptions.…)`
        // as a pseudo-custom attribute. The recognised
        // MethodImplOptions bits OR into the MethodImpl field of the
        // emitted MethodDef so reflection (GetMethodImplementationFlags)
        // sees AggressiveInlining / NoInlining / Synchronized / etc.
        // without a parallel CustomAttribute row. The attribute itself is
        // elided from EmitUserAttributes via KnownAttributes.IsPseudoCustomAttribute.
        var implAttributes = MethodImplAttributes.IL | MethodImplAttributes.Managed;
        var methodImpl = KnownAttributes.FindMethodImpl(function.Attributes);
        if (methodImpl != null)
        {
            var opts = KnownAttributes.GetMethodImplOptions(methodImpl);
            // MethodImplOptions bit positions match MethodImplAttributes
            // bit positions exactly (ECMA-335 II.23.1.11), so a direct
            // OR onto the IL|Managed default lands on the correct slot.
            implAttributes |= (MethodImplAttributes)(int)opts;
        }

        var handle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: implAttributes,
            name: this.emitCtx.Metadata.GetOrAddString(methodName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);

        // ADR-0087 §3 R1: emit GenericParam rows for a user-declared generic
        // method immediately after AddMethodDefinition. The signature's
        // genericParameterCount above and these rows together make the method
        // a proper CLR generic method definition.
        var gpRowStart = this.emitCtx.PendingGenericParameters.Count;
        TypeDefEmitter.EmitGenericParamRows(this.emitCtx, handle, function.TypeParameters);

        // Issue #2118: a generic-promoted non-capturing lambda's type-parameter
        // constraints textually reference the *enclosing* type parameters they
        // were cloned from (the interface-constraint symbol is cached and does
        // not carry the clone). Their deferred GenericParamConstraint rows would
        // otherwise be resolved at flush time — after this method's remap is
        // gone — encoding the enclosing Var/MVar slot instead of this method's
        // own MVar. Resolve them now, while the remap is active, so the
        // constraint encodes `!!idx` for both class- and method-parameter roots.
        if (this.remaps.ActiveLambdaMethodTypeParamRemap != null)
        {
            var pendingRows = this.emitCtx.PendingGenericParameters;
            for (var gi = gpRowStart; gi < pendingRows.Count; gi++)
            {
                var gpRow = pendingRows[gi];
                if (gpRow.InterfaceConstraintType != null)
                {
                    pendingRows[gi] = gpRow with
                    {
                        PreResolvedConstraintHandle = this.GetElementTypeToken(gpRow.InterfaceConstraintType),
                    };
                }
            }
        }

        // Phase 4/5 (ADR-0027 §7.7a): hand the body's sequence points and
        // locals to the PDB emitter, keyed by the freshly minted MethodDef row
        // number. Skipped when PDB emit is off (pdb == null) or for the
        // async-kickoff path (the kickoff stub is fully synthesised — visible
        // PDB rows for the user's async body land via EmitStateMachineMoveNext
        // below).
        this.emitCtx.Pdb?.RecordMethod(handle, capturedSequencePoints, capturedLocals, capturedConstants, capturedCodeSize, capturedLocalsSignature, function.Declaration?.SyntaxTree);

        // Phase 3 of #141: attach user annotations (method target) to the
        // MethodDef. Issue #170: per-parameter annotations attach to each
        // emitted Parameter row. Issue #172: return-target annotations attach
        // to the synthesised sequence-0 Parameter row.
        this.customAttrEncoder.EmitUserAttributes(handle, function, AttributeTargetKind.Method);
        if (returnParamHandle is { } retHandle)
        {
            this.customAttrEncoder.EmitUserAttributes(retHandle, function, AttributeTargetKind.Return);
        }

        foreach (var (paramSym, paramHandle, _) in paramHandles)
        {
            this.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
        }

        // Issue #834: emit [NullableContextAttribute] on the MethodDef when
        // the chosen method-level default differs from the assembly default
        // (1 = NotAnnotated). Then stamp [NullableAttribute] on every Param
        // row whose nullability bytes deviate from that effective default.
        // C# consumers then see `T?` reference parameters / returns as
        // annotated (CS8602 silenced) and non-nullable positions stay
        // implicit. The byte-array form is used only for nested generic
        // inner-position bytes (e.g. `IEnumerable<string?>?`).
        if (contextByteToEmit is byte ctxByte)
        {
            this.customAttrEncoder.EmitNullableContextAttributeOnMethod(handle, ctxByte);
        }

        if (returnParamHandle is { } returnHandleForNullable && returnNeedsNullableAttribute)
        {
            this.customAttrEncoder.EmitNullableAttributeOnParameter(returnHandleForNullable, returnFlags);
        }

        foreach (var (_, paramHandle, paramFlags) in paramHandles)
        {
            if (paramFlags.IsDefaultOrEmpty)
            {
                continue;
            }

            if (paramFlags.Length == 1 && paramFlags[0] == effectiveDefault)
            {
                continue;
            }

            this.customAttrEncoder.EmitNullableAttributeOnParameter(paramHandle, paramFlags);
        }

        // Issue #792 / ADR-0084. Stamp [ExtensionAttribute] on every G#-
        // authored extension MethodDef so C#/F# call-site lookup picks them
        // up via the standard ECMA-334 §13.6.9 extension-method discovery
        // (which scans for [Extension] static methods on [Extension] static
        // classes). The host TypeDef is stamped in EmitProgramExtensionMarker.
        if (function.IsExtension && !function.IsInstanceMethod)
        {
            this.EmitExtensionAttribute(handle);
        }

        return handle;
    }

    /// <summary>
    /// Issue #834: chooses the method-level <c>NullableContextAttribute</c>
    /// byte for an emitted method. Mirrors Roslyn's compaction: pick the
    /// most frequent byte across return + per-parameter flag bytes; emit a
    /// <c>NullableContextAttribute(common)</c> on the MethodDef only when
    /// <c>common</c> differs from the assembly default (1 = NotAnnotated).
    /// Per-position <c>NullableAttribute</c> rows are then required only for
    /// positions whose single byte deviates from <c>effectiveDefault</c>.
    /// </summary>
    /// <param name="returnFlags">The return slot's nullable byte array (DFS pre-order).</param>
    /// <param name="paramFlags">Each non-`this` parameter's nullable byte array.</param>
    /// <returns>
    /// A tuple of the effective method-level default byte (used by per-position
    /// emission to decide which rows to skip) and the optional context byte to
    /// stamp on the MethodDef. The context byte is <see langword="null"/>
    /// when the assembly default (1) wins and there's nothing to emit on the
    /// method itself.
    /// </returns>
    private static (byte EffectiveDefault, byte? ContextByteToEmit) ChooseMethodNullableContext(
        ImmutableArray<byte> returnFlags,
        List<ImmutableArray<byte>> paramFlags)
    {
        const byte AssemblyDefault = NullableFlagsBuilder.NotAnnotated;

        int countOblivious = 0;
        int countNotAnnotated = 0;
        int countAnnotated = 0;

        void Tally(ImmutableArray<byte> flags)
        {
            if (flags.IsDefaultOrEmpty)
            {
                return;
            }

            foreach (var b in flags)
            {
                switch (b)
                {
                    case 0: countOblivious++; break;
                    case 1: countNotAnnotated++; break;
                    case 2: countAnnotated++; break;
                }
            }
        }

        Tally(returnFlags);
        foreach (var pf in paramFlags)
        {
            Tally(pf);
        }

        if (countOblivious + countNotAnnotated + countAnnotated == 0)
        {
            // No reference-typed positions at all — assembly default wins,
            // nothing to emit. Per-position emission also has nothing to do.
            return (AssemblyDefault, null);
        }

        // Pick the most frequent byte. Tie-breakers favour the assembly
        // default (NotAnnotated = 1) so we emit the smallest amount of
        // metadata when a method is half non-null / half annotated.
        byte common = AssemblyDefault;
        int best = countNotAnnotated;
        if (countAnnotated > best)
        {
            common = NullableFlagsBuilder.Annotated;
            best = countAnnotated;
        }

        if (countOblivious > best)
        {
            common = 0;
        }

        if (common == AssemblyDefault)
        {
            return (AssemblyDefault, null);
        }

        return (common, common);
    }

    /// <summary>
    /// Issue #792 / ADR-0084. Attaches the parameterless
    /// <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c> to the
    /// supplied entity (MethodDef row for an extension method, or a TypeDef
    /// row for the static class that hosts the extension methods).
    /// </summary>
    private void EmitExtensionAttribute(EntityHandle parent)
    {
        var ctorRef = this.wellKnown.GetExtensionAttributeCtorRef();
        if (ctorRef.IsNil)
        {
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteUInt16(0);      // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Emits a P/Invoke (`@DllImport`) function as a PinvokeImpl MethodDef
    /// with an associated ImplMap row pointing at a ModuleRef
    /// (ADR-0086 / issue #727). The function carries no managed body —
    /// <c>bodyOffset</c> is -1 and <see cref="MethodImplAttributes.PreserveSig"/>
    /// is set so the runtime knows to leave the return value untouched.
    /// </summary>
    /// <param name="function">The P/Invoke function symbol.</param>
    /// <returns>The handle of the emitted MethodDef.</returns>
    private MethodDefinitionHandle EmitPInvokeFunction(FunctionSymbol function)
    {
        var pInvoke = function.PInvokeMetadata;

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                function.Parameters.Length,
                r => EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        // ADR-0086 §6: PinvokeImpl + Static + visibility. PreserveSig
        // mirrors the ImplMap; we set MethodImplAttributes.PreserveSig when
        // the metadata says so (default true) so the CLR does not synthesise
        // an HRESULT-to-exception translation.
        var visibility = AccessibilityMap.ToMethodVisibility(function.Accessibility, AccessibilityMap.IsTopLevelProgramMember(function));
        var methodAttrs = visibility | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.PinvokeImpl;
        var implAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed;
        if (pInvoke.PreserveSig)
        {
            implAttrs |= MethodImplAttributes.PreserveSig;
        }

        // Allocate Parameter rows so each source parameter shows up in
        // metadata. Matches the regular EmitFunction path.
        var firstParamHandle = this.customAttrEncoder.NextParameterHandle();
        var paramHandles = new List<(ParameterSymbol Symbol, ParameterHandle Handle)>();
        var sequenceNumber = 1;
        foreach (var p in function.Parameters)
        {
            // ADR-0096 / issue #762: stamp HasFieldMarshal when the
            // parameter carries a resolved `@MarshalAs(...)` override.
            // The FieldMarshal table row is added immediately below
            // and is keyed off the Parameter handle.
            var paramAttrs = ParameterAttributes.None;
            if (p.MarshalAsMetadata != null)
            {
                paramAttrs |= ParameterAttributes.HasFieldMarshal;
            }

            var paramHandle = this.emitCtx.Metadata.AddParameter(
                attributes: paramAttrs,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: sequenceNumber++);
            paramHandles.Add((p, paramHandle));

            if (p.MarshalAsMetadata != null)
            {
                EmitFieldMarshalRow(paramHandle, p.MarshalAsMetadata);
            }
        }

        var methodHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: implAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(function.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: -1,
            parameterList: firstParamHandle);

        // ModuleRef (deduplicated by library name).
        if (!this.cache.PInvokeModuleRefs.TryGetValue(pInvoke.LibraryName, out var moduleRef))
        {
            moduleRef = this.emitCtx.Metadata.AddModuleReference(this.emitCtx.Metadata.GetOrAddString(pInvoke.LibraryName));
            this.cache.PInvokeModuleRefs[pInvoke.LibraryName] = moduleRef;
        }

        var importAttrs = MapPInvokeImportAttributes(pInvoke);
        this.emitCtx.Metadata.AddMethodImport(
            methodHandle,
            importAttrs,
            this.emitCtx.Metadata.GetOrAddString(pInvoke.EntryPoint ?? function.Name),
            moduleRef);

        // Attach user-written method-target attributes (other than the
        // @DllImport itself, which is fully consumed by the ImplMap row —
        // duplicating it as a CustomAttribute would create a misleading
        // reflection view; this mirrors C#'s behavior).
        this.customAttrEncoder.EmitUserAttributesExcept(methodHandle, function, AttributeTargetKind.Method, KnownAttributes.IsDllImport);

        foreach (var (paramSym, paramHandle) in paramHandles)
        {
            this.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
        }

        return methodHandle;
    }

    /// <summary>
    /// ADR-0096 / issue #762: writes a CLR <c>FieldMarshal</c> table
    /// row keyed off <paramref name="paramHandle"/> carrying the
    /// per-parameter marshalling descriptor blob encoded per ECMA-335
    /// II.23.4. The corresponding <see cref="ParameterAttributes.HasFieldMarshal"/>
    /// bit must be set on the Param row by the caller (the runtime uses
    /// the bit to decide whether to read this table).
    /// </summary>
    /// <param name="paramHandle">The owning Parameter row handle.</param>
    /// <param name="metadata">The resolved per-parameter <c>@MarshalAs</c> metadata.</param>
    private void EmitFieldMarshalRow(ParameterHandle paramHandle, MarshalAsMetadata metadata)
    {
        var blobBuilder = new BlobBuilder();
        blobBuilder.WriteBytes(metadata.EncodeFieldMarshalBlob());
        this.emitCtx.Metadata.AddMarshallingDescriptor(
            paramHandle,
            this.emitCtx.Metadata.GetOrAddBlob(blobBuilder));
    }

    private static MethodImportAttributes MapPInvokeImportAttributes(PInvokeMetadata pInvoke)
    {
        var attrs = MethodImportAttributes.None;

        switch (pInvoke.CallingConvention)
        {
            case System.Runtime.InteropServices.CallingConvention.Cdecl:
                attrs |= MethodImportAttributes.CallingConventionCDecl;
                break;
            case System.Runtime.InteropServices.CallingConvention.StdCall:
                attrs |= MethodImportAttributes.CallingConventionStdCall;
                break;
            case System.Runtime.InteropServices.CallingConvention.ThisCall:
                attrs |= MethodImportAttributes.CallingConventionThisCall;
                break;
            case System.Runtime.InteropServices.CallingConvention.FastCall:
                attrs |= MethodImportAttributes.CallingConventionFastCall;
                break;
            case System.Runtime.InteropServices.CallingConvention.Winapi:
            default:
                attrs |= MethodImportAttributes.CallingConventionWinApi;
                break;
        }

        switch (pInvoke.CharSet)
        {
            case System.Runtime.InteropServices.CharSet.Ansi:
                attrs |= MethodImportAttributes.CharSetAnsi;
                break;
            case System.Runtime.InteropServices.CharSet.Unicode:
                attrs |= MethodImportAttributes.CharSetUnicode;
                break;
            case System.Runtime.InteropServices.CharSet.Auto:
                attrs |= MethodImportAttributes.CharSetAuto;
                break;
            case System.Runtime.InteropServices.CharSet.None:
            default:
                // CLR default — leave bits clear.
                break;
        }

        if (pInvoke.SetLastError)
        {
            attrs |= MethodImportAttributes.SetLastError;
        }

        if (pInvoke.ExactSpelling)
        {
            attrs |= MethodImportAttributes.ExactSpelling;
        }

        if (pInvoke.BestFitMapping is bool bfm)
        {
            attrs |= bfm
                ? MethodImportAttributes.BestFitMappingEnable
                : MethodImportAttributes.BestFitMappingDisable;
        }

        if (pInvoke.ThrowOnUnmappableChar is bool tum)
        {
            attrs |= tum
                ? MethodImportAttributes.ThrowOnUnmappableCharEnable
                : MethodImportAttributes.ThrowOnUnmappableCharDisable;
        }

        return attrs;
    }

    /// <summary>
    /// ADR-0092 / issue #758: emits an <c>@LibraryImport</c> function as a
    /// pair of MethodDef rows — the user-visible managed stub (planned at
    /// <c>cache.FunctionHandles[function]</c>) and a hidden blittable inner
    /// P/Invoke (planned at <c>cache.LibraryImportInnerHandles[function]</c>).
    /// The stub:
    /// <list type="bullet">
    ///   <item>For each <c>string</c> parameter, marshals it explicitly into
    ///         a CoTaskMem buffer (UTF-8 or UTF-16 per the resolved
    ///         <see cref="System.Runtime.InteropServices.StringMarshalling"/>
    ///         mode) and stores the resulting <c>IntPtr</c> in a local.</item>
    ///   <item>Calls the inner P/Invoke inside a <c>try</c> block, passing
    ///         the marshalled <c>IntPtr</c> in place of each <c>string</c>
    ///         parameter.</item>
    ///   <item>Frees the marshalled buffers in a <c>finally</c> block via
    ///         <see cref="Marshal.FreeCoTaskMem(IntPtr)"/>, which is a no-op
    ///         on <see cref="IntPtr.Zero"/>.</item>
    ///   <item>When the function returns <c>string</c>, the inner P/Invoke
    ///         returns the raw native pointer (encoded as <c>IntPtr</c>) and
    ///         the outer stub materializes the managed string via
    ///         <see cref="Marshal.PtrToStringUTF8(IntPtr)"/> /
    ///         <see cref="Marshal.PtrToStringUni(IntPtr)"/>. The returned
    ///         native buffer is non-owning (the native side owns it, e.g.
    ///         <c>getenv</c>) and is never freed — see the ADR-0092
    ///         return-marshalling table.</item>
    /// </list>
    /// The result is verifiable IL that has no runtime marshalling stub —
    /// every transition is explicit and AOT-publishable.
    /// </summary>
    /// <param name="function">The <c>@LibraryImport</c> function symbol.</param>
    /// <returns>The handle of the emitted outer managed stub.</returns>
    private MethodDefinitionHandle EmitLibraryImportFunction(FunctionSymbol function)
    {
        var pInvoke = function.PInvokeMetadata;

        // Plan which parameters need string marshalling. Indices are into
        // the function's parameter list.
        var stringParamIndices = new List<int>();
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            if (function.Parameters[i].Type == TypeSymbol.String)
            {
                stringParamIndices.Add(i);
            }
        }

        var innerMethodRef = this.cache.LibraryImportInnerHandles[function];

        // === Outer managed stub ===
        var outerSigBlob = new BlobBuilder();
        new BlobEncoder(outerSigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                function.Parameters.Length,
                r => EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        var outerVisibility = AccessibilityMap.ToMethodVisibility(function.Accessibility, AccessibilityMap.IsTopLevelProgramMember(function));
        var outerMethodAttrs = outerVisibility | MethodAttributes.HideBySig | MethodAttributes.Static;
        var outerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed;

        // Allocate outer Parameter rows BEFORE the inner ones so they
        // line up with the outer MethodDef row.
        var outerFirstParam = this.customAttrEncoder.NextParameterHandle();
        var outerParamHandles = new List<(ParameterSymbol Symbol, ParameterHandle Handle)>();
        var outerSeq = 1;
        foreach (var p in function.Parameters)
        {
            // ADR-0096 / issue #762: stamp HasFieldMarshal on the outer
            // Param row when the parameter carries an `@MarshalAs(...)`
            // override. The outer stub uses the user-visible managed
            // type (e.g. `int32`) so the override applies here; the
            // inner blittable P/Invoke has no FieldMarshal row.
            var outerParamAttrs = ParameterAttributes.None;
            if (p.MarshalAsMetadata != null)
            {
                outerParamAttrs |= ParameterAttributes.HasFieldMarshal;
            }

            var paramHandle = this.emitCtx.Metadata.AddParameter(
                attributes: outerParamAttrs,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: outerSeq++);
            outerParamHandles.Add((p, paramHandle));

            if (p.MarshalAsMetadata != null)
            {
                EmitFieldMarshalRow(paramHandle, p.MarshalAsMetadata);
            }
        }

        // Build the IL body of the outer stub.
        var (outerBodyOffset, outerLocalsSig) = EmitLibraryImportOuterBody(function, stringParamIndices, innerMethodRef);

        var outerMethodHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: outerMethodAttrs,
            implAttributes: outerImplAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(function.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(outerSigBlob),
            bodyOffset: outerBodyOffset,
            parameterList: outerFirstParam);

        // Surface user-written method-target attributes other than the
        // @LibraryImport itself (which is fully consumed by the inner
        // ImplMap row — duplicating it as a CustomAttribute would create
        // a misleading reflection view).
        this.customAttrEncoder.EmitUserAttributesExcept(outerMethodHandle, function, AttributeTargetKind.Method, KnownAttributes.IsLibraryImport);

        foreach (var (paramSym, paramHandle) in outerParamHandles)
        {
            this.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
        }

        // === Inner blittable P/Invoke ===
        var innerSigBlob = new BlobBuilder();
        new BlobEncoder(innerSigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                function.Parameters.Length,
                r =>
                {
                    if (function.Type == TypeSymbol.String)
                    {
                        // ADR-0092 §2 — a `string` return is marshalled by the
                        // outer stub. The PreserveSig/blittable inner returns the
                        // raw native pointer as IntPtr (symmetric to the IntPtr
                        // string-parameter form); the outer materializes the
                        // managed string via Marshal.PtrToString*.
                        r.Type(isByRef: false).IntPtr();
                    }
                    else
                    {
                        EncodeReturnSymbol(r, function.Type, function.ReturnRefKind);
                    }
                },
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        var slot = ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None);
                        if (p.Type == TypeSymbol.String)
                        {
                            // Marshal-as-IntPtr — the blittable form the
                            // outer stub passes after explicit marshalling.
                            slot.IntPtr();
                        }
                        else
                        {
                            EncodeTypeSymbol(slot, p.Type);
                        }
                    }
                });

        // The inner method is private static, PinvokeImpl, PreserveSig.
        // No body. PinvokeImpl with no managed IL: bodyOffset = -1, IL +
        // Managed + PreserveSig (matching the @DllImport emit shape).
        var innerMethodAttrs = MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.PinvokeImpl;
        var innerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed | MethodImplAttributes.PreserveSig;

        var innerFirstParam = this.customAttrEncoder.NextParameterHandle();
        var innerSeq = 1;
        foreach (var p in function.Parameters)
        {
            this.emitCtx.Metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: innerSeq++);
        }

        var innerName = "<" + function.Name + ">g__PInvoke|0_0";
        var innerMethodHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: innerMethodAttrs,
            implAttributes: innerImplAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(innerName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(innerSigBlob),
            bodyOffset: -1,
            parameterList: innerFirstParam);

        // Sanity check: the planned row must match the row we just emitted.
        if (innerMethodHandle != innerMethodRef)
        {
            throw new InvalidOperationException(
                $"LibraryImport inner-method row mismatch for '{function.Name}': planned {MetadataTokens.GetRowNumber(innerMethodRef)}, emitted {MetadataTokens.GetRowNumber(innerMethodHandle)}.");
        }

        // ModuleRef (deduplicated by library name, same cache as @DllImport).
        if (!this.cache.PInvokeModuleRefs.TryGetValue(pInvoke.LibraryName, out var moduleRef))
        {
            moduleRef = this.emitCtx.Metadata.AddModuleReference(this.emitCtx.Metadata.GetOrAddString(pInvoke.LibraryName));
            this.cache.PInvokeModuleRefs[pInvoke.LibraryName] = moduleRef;
        }

        var importAttrs = MapPInvokeImportAttributes(pInvoke);
        this.emitCtx.Metadata.AddMethodImport(
            innerMethodHandle,
            importAttrs,
            this.emitCtx.Metadata.GetOrAddString(pInvoke.EntryPoint ?? function.Name),
            moduleRef);

        return outerMethodHandle;
    }

    /// <summary>
    /// Emits the IL body of an <c>@LibraryImport</c> outer managed stub
    /// and returns the body offset + the locals-signature handle.
    /// </summary>
    private (int BodyOffset, StandaloneSignatureHandle LocalsSignature) EmitLibraryImportOuterBody(
        FunctionSymbol function,
        IReadOnlyList<int> stringParamIndices,
        MethodDefinitionHandle innerMethodHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

        // Locals plan: one IntPtr per string parameter, in order; an
        // optional result local when the function returns a value (so we
        // can ret AFTER the finally that frees the marshalled buffers).
        var stringLocalIndex = new Dictionary<int, int>(stringParamIndices.Count);
        var localTypes = new List<TypeSymbol>();
        foreach (var idx in stringParamIndices)
        {
            stringLocalIndex[idx] = localTypes.Count;
            localTypes.Add(TypeSymbol.NInt);
        }

        var hasResult = function.Type != TypeSymbol.Void;
        int resultLocalIndex = -1;
        if (hasResult)
        {
            resultLocalIndex = localTypes.Count;
            localTypes.Add(function.Type);
        }

        // Resolve the Marshal-helper MemberRefs lazily based on the
        // configured StringMarshalling mode. Both helpers are no-ops on
        // null / IntPtr.Zero respectively, so the stub does not need null
        // guards.
        var marshalType = typeof(Marshal);
        var isUtf16 = function.PInvokeMetadata.StringMarshalling == StringMarshalling.Utf16;

        MemberReferenceHandle convertRef = default;
        MemberReferenceHandle freeRef = default;
        if (stringParamIndices.Count > 0)
        {
            var convertName = isUtf16
                ? "StringToCoTaskMemUni"
                : "StringToCoTaskMemUTF8";
            var convertMethod = marshalType.GetMethod(convertName, new[] { typeof(string) })
                ?? throw new InvalidOperationException($"Cannot resolve Marshal.{convertName}(string).");
            var freeMethod = marshalType.GetMethod("FreeCoTaskMem", new[] { typeof(nint) })
                ?? throw new InvalidOperationException("Cannot resolve Marshal.FreeCoTaskMem(IntPtr).");
            convertRef = this.GetMethodReference(convertMethod);
            freeRef = this.GetMethodReference(freeMethod);
        }

        // ADR-0092 §2 — for a `string` return the inner P/Invoke yields the
        // raw native pointer (encoded as IntPtr); the outer stub materializes
        // a managed string via Marshal.PtrToStringUTF8 / PtrToStringUni. The
        // returned native buffer is NON-OWNING (the native side owns it, e.g.
        // `getenv`), so the stub never frees it — see the ADR-0092
        // return-marshalling table.
        var returnIsString = function.Type == TypeSymbol.String;
        MemberReferenceHandle ptrToStringRef = default;
        if (returnIsString)
        {
            var ptrToStringName = isUtf16 ? "PtrToStringUni" : "PtrToStringUTF8";
            var ptrToStringMethod = marshalType.GetMethod(ptrToStringName, new[] { typeof(nint) })
                ?? throw new InvalidOperationException($"Cannot resolve Marshal.{ptrToStringName}(IntPtr).");
            ptrToStringRef = this.GetMethodReference(ptrToStringMethod);
        }

        // 1) Marshal each string argument to a CoTaskMem IntPtr before the try.
        foreach (var idx in stringParamIndices)
        {
            il.LoadArgument(idx);
            il.OpCode(ILOpCode.Call);
            il.Token(convertRef);
            il.StoreLocal(stringLocalIndex[idx]);
        }

        var tryStart = il.DefineLabel();
        var finallyStart = il.DefineLabel();
        var finallyEnd = il.DefineLabel();

        il.MarkLabel(tryStart);

        // 2) Push each argument onto the eval stack — IntPtr for strings,
        //    plain arg for everything else — then call the inner P/Invoke.
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            if (stringLocalIndex.TryGetValue(i, out var localIdx))
            {
                il.LoadLocal(localIdx);
            }
            else
            {
                il.LoadArgument(i);
            }
        }

        il.OpCode(ILOpCode.Call);
        il.Token(innerMethodHandle);

        if (hasResult)
        {
            if (returnIsString)
            {
                // Inner returned a raw native pointer (IntPtr) on the stack;
                // convert it to a managed string in place. PtrToString* is a
                // no-op (returns null) on IntPtr.Zero, so no null guard is
                // needed. The native buffer is non-owning and is NOT freed.
                il.OpCode(ILOpCode.Call);
                il.Token(ptrToStringRef);
            }

            il.StoreLocal(resultLocalIndex);
        }

        il.Branch(ILOpCode.Leave, finallyEnd);

        // 3) Finally: free every marshalled buffer.
        il.MarkLabel(finallyStart);
        foreach (var idx in stringParamIndices)
        {
            il.LoadLocal(stringLocalIndex[idx]);
            il.OpCode(ILOpCode.Call);
            il.Token(freeRef);
        }

        il.OpCode(ILOpCode.Endfinally);
        il.MarkLabel(finallyEnd);

        if (stringParamIndices.Count > 0)
        {
            il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
        }

        if (hasResult)
        {
            il.LoadLocal(resultLocalIndex);
        }

        il.OpCode(ILOpCode.Ret);

        // Encode locals signature.
        StandaloneSignatureHandle localsSig = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSig = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var offset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSig);
        return (offset, localsSig);
    }

    private bool NeedsRvalueReceiverSpill(
        BoundExpression receiver,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (!IsValueTypeSymbol(receiver.Type))
        {
            return false;
        }

        if (receiver is BoundVariableExpression bve
            && this.CanLoadVariableAddressForReceiverSpill(bve.Variable, function, locals))
        {
            return false;
        }

        if (receiver is BoundFieldAccessExpression fa
            && this.cache.StructFieldDefs.ContainsKey(fa.Field)
            && this.IsAddressableFieldAccessForReceiverSpill(fa, function, locals))
        {
            return false;
        }

        return true;
    }

    private bool CanLoadVariableAddressForReceiverSpill(
        VariableSymbol variable,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (variable is ParameterSymbol ps
            && function != null
            && function.Parameters.Any(p => ReferenceEquals(p, ps)))
        {
            return true;
        }

        if (locals.ContainsKey(variable))
        {
            return true;
        }

        if (variable is GlobalVariableSymbol gv && this.cache.GlobalFieldDefs.ContainsKey(gv))
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1525: returns <c>true</c> when taking the address of
    /// <paramref name="field"/> via <c>ldsflda</c> is verifiable in the current
    /// emit context — i.e. the field is not an <c>initonly</c> static field, or
    /// it is but we are currently emitting the synthesized static constructor
    /// (<c>.cctor</c>) of the field's own declaring type (the only place ECMA-335
    /// permits mutating/addressing an <c>initonly</c> static field). Otherwise a
    /// static readonly value-type field used as an instance-method or
    /// property-getter receiver must be spilled to a temp (defensive copy)
    /// rather than addressed in place.
    /// </summary>
    /// <param name="field">The field whose address is being considered.</param>
    /// <returns><c>true</c> when <c>ldsflda</c> of the field is legal here.</returns>
    internal bool IsStaticFieldAddressLegalHere(FieldSymbol field)
    {
        if (!(field.IsReadOnly && field.IsStatic) || field.IsConst)
        {
            return true;
        }

        switch (this.emitCtx.CurrentStaticConstructorOwner)
        {
            case StructSymbol s:
                return !s.StaticFields.IsDefaultOrEmpty && s.StaticFields.Contains(field);
            case InterfaceSymbol i:
                return !i.StaticFields.IsDefaultOrEmpty && i.StaticFields.Contains(field);
            default:
                return false;
        }
    }

    private bool IsAddressableFieldAccessForReceiverSpill(
        BoundFieldAccessExpression fa,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (fa.Receiver == null)
        {
            // Issue #1525: a static field receiver is normally addressable
            // (ldsflda), but an initonly (readonly) static value-type field
            // is only addressable inside its declaring type's .cctor; anywhere
            // else force an rvalue spill (defensive copy) so the emitted IL is
            // verifiable.
            return this.IsStaticFieldAddressLegalHere(fa.Field);
        }

        if (fa.Receiver.Type is StructSymbol rs && rs.IsClass)
        {
            return true;
        }

        if (fa.Receiver.Type?.ClrType != null && !fa.Receiver.Type.ClrType.IsValueType)
        {
            return true;
        }

        if (fa.Receiver is BoundVariableExpression bv
            && this.CanLoadVariableAddressForReceiverSpill(bv.Variable, function, locals))
        {
            return true;
        }

        if (fa.Receiver is BoundFieldAccessExpression nested
            && this.cache.StructFieldDefs.ContainsKey(nested.Field))
        {
            return this.IsAddressableFieldAccessForReceiverSpill(nested, function, locals);
        }

        return false;
    }

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetElementTypeToken(TypeSymbol element)
        => this.memberRefs.GetElementTypeToken(element);

    private Type ResolveCoreType(string fullName, Type fallback)
    {
        if (this.emitCtx.References.TryResolveType(fullName, requireExternalVisibility: false, out var t))
        {
            return t;
        }

        return fallback;
    }

    /// <summary>
    /// Issue #1336: builds the <c>TypeSpec</c> used as the <c>Constraint</c> of
    /// the <c>GenericParamConstraint</c> row that encodes a <c>where T :
    /// unmanaged</c> constraint. The signature is
    /// <c>System.ValueType modreq(System.Runtime.InteropServices.UnmanagedType)</c>
    /// — the exact metadata shape C# emits — written as a raw type signature
    /// blob: <c>ELEMENT_TYPE_CMOD_REQD &lt;UnmanagedType&gt;
    /// ELEMENT_TYPE_CLASS &lt;System.ValueType&gt;</c>.
    /// </summary>
    /// <returns>The TypeSpec handle for the modreq-decorated ValueType constraint.</returns>
    private EntityHandle BuildUnmanagedConstraintTypeSpec()
    {
        if (!this.unmanagedConstraintTypeSpec.IsNil)
        {
            return this.unmanagedConstraintTypeSpec;
        }

        var unmanagedTypeRef = this.GetTypeReference(
            this.ResolveCoreType("System.Runtime.InteropServices.UnmanagedType", typeof(System.Runtime.InteropServices.UnmanagedType)));
        var valueTypeRef = this.GetTypeReference(this.emitCtx.CoreValueType);

        var blob = new BlobBuilder();
        blob.WriteByte((byte)SignatureTypeCode.RequiredModifier);
        blob.WriteCompressedInteger(CodedIndex.TypeDefOrRefOrSpec(unmanagedTypeRef));

        // System.ValueType is itself a reference type (an abstract class), so it
        // must be encoded as ELEMENT_TYPE_CLASS (0x12) — NOT ELEMENT_TYPE_VALUETYPE
        // (0x11). This matches exactly what the C# compiler emits; encoding it as
        // VALUETYPE makes the CLR loader reject the type with a "value type
        // mismatch" TypeLoadException at runtime.
        blob.WriteByte((byte)SignatureTypeKind.Class);
        blob.WriteCompressedInteger(CodedIndex.TypeDefOrRefOrSpec(valueTypeRef));

        this.unmanagedConstraintTypeSpec = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(blob));
        return this.unmanagedConstraintTypeSpec;
    }

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetTypeOfToken(TypeSymbol type)
        => this.memberRefs.GetTypeOfToken(type);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal TypeReferenceHandle GetTypeReference(Type type)
        => this.memberRefs.GetTypeReference(type);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetTypeHandleForMember(Type type)
        => this.memberRefs.GetTypeHandleForMember(type);

    // -----------------------------------------------------------------
    // ADR-0087 §3 R3: user-defined generic-type TypeSpec / MemberRef
    // plumbing. After R1 a user-declared generic TypeDef carries
    // GenericParam rows and a backtick-arity name; after R2 its
    // field/parameter/return signatures encode VAR(idx)/MVAR(idx).
    // CLR verification then rejects any body reference (`ldfld`,
    // `stfld`, `call`, `newobj`, `callvirt`, `isinst`, `unbox`,
    // `unbox.any`) that targets the bare TypeDef row or a bare
    // FieldDef/MethodDef on it — every such reference must go through
    // a MemberRef parented at a TypeSpec naming the instantiation
    // (the self-instantiation `Box`1<!0,...>` for the type's own
    // bodies, the constructed instantiation `Box`1<int32>` for
    // external uses). The helpers below provide that routing.
    // -----------------------------------------------------------------

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    private void TryPromoteNonCapturingGenericLambda(BoundFunctionLiteralExpression literal, BoundBlockStatement loweredBody)
        => this.userTokens.TryPromoteNonCapturingGenericLambda(literal, loweredBody);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveLambdaFunctionFtnToken(FunctionSymbol fn)
        => this.userTokens.ResolveLambdaFunctionFtnToken(fn);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle BuildMethodSpecForGenericCall(EntityHandle openMethod, BoundCallExpression call)
        => this.userTokens.BuildMethodSpecForGenericCall(openMethod, call);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle BuildMethodSpecForGenericInstanceCall(EntityHandle openMethod, BoundUserInstanceCallExpression call)
        => this.userTokens.BuildMethodSpecForGenericInstanceCall(openMethod, call);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle GetUserStructTypeSpec(StructSymbol structSym)
        => this.userTokens.GetUserStructTypeSpec(structSym);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveDelegateCtorToken(DelegateTypeSymbol delegateSym)
        => this.userTokens.ResolveDelegateCtorToken(delegateSym);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveDelegateInvokeToken(DelegateTypeSymbol delegateSym)
        => this.userTokens.ResolveDelegateInvokeToken(delegateSym);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle GetStructTypeToken(StructSymbol structSym)
        => this.userTokens.GetStructTypeToken(structSym);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal void EncodeTypeSymbolIntoSignature(SignatureTypeEncoder encoder, TypeSymbol type)
        => this.userTokens.EncodeTypeSymbolIntoSignature(encoder, type);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle GetUserStructFieldRef(StructSymbol containingType, FieldSymbol fieldOnContaining)
        => this.userTokens.GetUserStructFieldRef(containingType, fieldOnContaining);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveFieldToken(StructSymbol containingType, FieldSymbol field)
        => this.userTokens.ResolveFieldToken(containingType, field);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveInterfaceFieldToken(InterfaceSymbol containingInterface, FieldSymbol field)
        => this.userTokens.ResolveInterfaceFieldToken(containingInterface, field);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle GetUserStructMethodRef(
        StructSymbol containingType,
        EntityHandle openMethodDef,
        string methodName,
        BlobBuilder signature)
        => this.userTokens.GetUserStructMethodRef(containingType, openMethodDef, methodName, signature);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserInstanceMethodToken(StructSymbol containingType, FunctionSymbol method)
        => this.userTokens.ResolveUserInstanceMethodToken(containingType, method);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveClosureInvokeFtnToken(StructSymbol constructedClosure, StructSymbol closureDef, FunctionSymbol invoke)
        => this.userTokens.ResolveClosureInvokeFtnToken(constructedClosure, closureDef, invoke);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserStaticMethodToken(StructSymbol containingType, FunctionSymbol method)
        => this.userTokens.ResolveUserStaticMethodToken(containingType, method);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserInterfaceStaticMethodToken(InterfaceSymbol containingInterface, FunctionSymbol method)
        => this.userTokens.ResolveUserInterfaceStaticMethodToken(containingInterface, method);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserPropertyAccessorToken(StructSymbol containingType, PropertySymbol property, bool wantSetter)
        => this.userTokens.ResolveUserPropertyAccessorToken(containingType, property, wantSetter);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle GetUserInterfaceTypeSpec(InterfaceSymbol ifaceSym)
        => this.userTokens.GetUserInterfaceTypeSpec(ifaceSym);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserInterfaceInstanceMethodToken(InterfaceSymbol containingInterface, FunctionSymbol openMethod)
        => this.userTokens.ResolveUserInterfaceInstanceMethodToken(containingInterface, openMethod);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserCtorTokenForPrimary(StructSymbol structType)
        => this.userTokens.ResolveUserCtorTokenForPrimary(structType);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveConstructedBaseExplicitCtorToken(StructSymbol constructedBase, ConstructorSymbol ctor)
        => this.userTokens.ResolveConstructedBaseExplicitCtorToken(constructedBase, ctor);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveConstructedBaseParameterlessCtorToken(StructSymbol constructedBase)
        => this.userTokens.ResolveConstructedBaseParameterlessCtorToken(constructedBase);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserCtorTokenForDefault(StructSymbol structType)
        => this.userTokens.ResolveUserCtorTokenForDefault(structType);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserCtorTokenForExplicit(StructSymbol structType, ConstructorSymbol ctor)
        => this.userTokens.ResolveUserCtorTokenForExplicit(structType, ctor);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal EntityHandle ResolveUserTypeToken(StructSymbol structType)
        => this.userTokens.ResolveUserTypeToken(structType);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal bool TryGetSymbolicSubstitutedPropertyReturn(
        TypeSymbol receiverType,
        PropertyInfo property,
        out TypeSymbol substitutedReturn)
        => this.userTokens.TryGetSymbolicSubstitutedPropertyReturn(receiverType, property, out substitutedReturn);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal bool TryGetSymbolicSubstitutedInstanceMethodReturn(
        TypeSymbol receiverType,
        MethodInfo method,
        out TypeSymbol substitutedReturn)
        => this.userTokens.TryGetSymbolicSubstitutedInstanceMethodReturn(receiverType, method, out substitutedReturn);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal bool TryGetSymbolicSubstitutedImportedCallReturn(
        MethodInfo method,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        out TypeSymbol substitutedReturn)
        => this.userTokens.TryGetSymbolicSubstitutedImportedCallReturn(method, typeArgSymbols, out substitutedReturn);

    // PR-E-19: transitional forwarder into the extracted UserTokenResolver.
    internal bool FunctionTypeNeedsSymbolicDelegate(FunctionTypeSymbol fnType)
        => this.userTokens.FunctionTypeNeedsSymbolicDelegate(fnType);

    /// <summary>
    /// Rubber-duck follow-up to issue #2224: resolves the field a primary
    /// constructor parameter named <paramref name="name"/> assigns into.
    /// Normally this is a same-named plain field (<see cref="StructSymbol.TryGetField"/>);
    /// an anonymous-class literal's synthesized type
    /// (<see cref="Binding.AnonymousTypeCache"/>) has no plain fields at all —
    /// only get-only auto-properties — so its primary-ctor parameters instead
    /// resolve to the same-named property's <see cref="PropertySymbol.BackingField"/>.
    /// </summary>
    /// <param name="type">The declaring type.</param>
    /// <param name="name">The primary-ctor parameter (and target member) name.</param>
    /// <param name="field">The resolved backing field on success.</param>
    /// <returns><see langword="true"/> if a field or auto-property backing field was found.</returns>
    internal static bool TryGetPrimaryCtorTargetField(StructSymbol type, string name, out FieldSymbol field)
    {
        if (type.TryGetField(name, out field))
        {
            return true;
        }

        if (TypeMemberModel.TryGetProperty(type, name, out var property) && property.BackingField != null)
        {
            field = property.BackingField;
            return true;
        }

        field = null;
        return false;
    }

    /// <summary>
    /// ADR-0087 §3 R3: returns <see langword="true"/> when
    /// <paramref name="structSym"/> is a user-declared generic type
    /// reference whose body/field/method/ctor references must be
    /// parented at a <c>TypeSpec</c> rather than the bare TypeDef row.
    /// </summary>
    internal static bool IsUserGenericTypeReference(StructSymbol structSym)
    {
        if (structSym == null)
        {
            return false;
        }

        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            return true;
        }

        var def = structSym.Definition ?? structSym;
        return !def.TypeParameters.IsDefaultOrEmpty;
    }

    /// <summary>
    /// Issue #1503: returns <see langword="true"/> when
    /// <paramref name="delegateSym"/> is a generic named-delegate reference —
    /// either a constructed instance (carrying <see cref="DelegateTypeSymbol.TypeArguments"/>)
    /// or the open definition of a generic delegate — whose ctor/Invoke
    /// references must be parented at a <c>TypeSpec</c> rather than the bare
    /// TypeDef/MethodDef rows. Mirrors <see cref="IsUserGenericTypeReference"/>.
    /// </summary>
    /// <param name="delegateSym">The named-delegate symbol.</param>
    /// <returns>Whether the delegate is a generic reference.</returns>
    internal static bool IsUserGenericDelegateReference(DelegateTypeSymbol delegateSym)
    {
        if (delegateSym == null)
        {
            return false;
        }

        if (!delegateSym.TypeArguments.IsDefaultOrEmpty)
        {
            return true;
        }

        var def = delegateSym.Definition ?? delegateSym;
        return !def.TypeParameters.IsDefaultOrEmpty;
    }

    /// <summary>
    /// Issue #1503: resolves the type arguments used to encode a generic named
    /// delegate reference. A constructed instance uses its
    /// <see cref="DelegateTypeSymbol.TypeArguments"/>; the open definition uses
    /// the self-instantiation (its own type parameters, each encoded as
    /// <c>VAR(idx)</c>).
    /// </summary>
    /// <param name="delegateSym">The generic delegate reference.</param>
    /// <returns>The type arguments to encode in the <c>GENERICINST</c> signature.</returns>
    // PR-E-17: widened private → internal so the extracted SignatureEncoder can
    // call it (EncodeTypeSymbol's user-generic delegate branch). Static, so
    // referenced as ReflectionMetadataEmitter.ResolveDelegateTypeArguments.
    // PR-E-19: stays on the root as a shared static (SignatureEncoder and
    // UserTokenResolver's own delegate resolvers both reach it by static
    // qualification), alongside the other IsUserGeneric*Reference predicates.
    internal static ImmutableArray<TypeSymbol> ResolveDelegateTypeArguments(DelegateTypeSymbol delegateSym)
    {
        if (!delegateSym.TypeArguments.IsDefaultOrEmpty)
        {
            return delegateSym.TypeArguments;
        }

        var def = delegateSym.Definition ?? delegateSym;
        var defTps = def.TypeParameters;
        var bld = ImmutableArray.CreateBuilder<TypeSymbol>(defTps.Length);
        foreach (var tp in defTps)
        {
            bld.Add(tp);
        }

        return bld.MoveToImmutable();
    }

    // ADR-0118 / issue #944: a type that declares a user indexer member must
    // carry a System.Reflection.DefaultMemberAttribute("Item") so the CLR (and
    // C# consumers) recognise its `Item` property as the default indexer.
    private void EmitDefaultMemberAttributeIfIndexer(StructSymbol structSym)
    {
        if (structSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        var hasIndexer = false;
        foreach (var prop in structSym.Properties)
        {
            if (prop.IsIndexer)
            {
                hasIndexer = true;
                break;
            }
        }

        if (!hasIndexer)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        this.customAttrEncoder.EmitStringAttribute(
            typeDefHandle,
            "System.Reflection.DefaultMemberAttribute",
            typeof(System.Reflection.DefaultMemberAttribute),
            "Item");
    }

    /// <summary>
    /// ADR-0149 (issue #944 follow-up): interface-side counterpart of
    /// <see cref="EmitDefaultMemberAttributeIfIndexer(StructSymbol)"/> — an
    /// interface that declares its own indexer contract (<c>prop this[…] T</c>)
    /// gets the same <see cref="System.Reflection.DefaultMemberAttribute"/>
    /// on its TypeDef, so reflection-based indexed access
    /// (<c>Type.GetProperty("Item")</c> / <c>PropertyInfo.GetValue(obj, args)</c>)
    /// and the C#-style <c>obj[i]</c> syntax work identically whether the
    /// static type is the interface or a concrete implementer.
    /// </summary>
    private void EmitDefaultMemberAttributeIfIndexer(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        var hasIndexer = false;
        foreach (var prop in ifaceSym.Properties)
        {
            if (prop.IsIndexer)
            {
                hasIndexer = true;
                break;
            }
        }

        if (!hasIndexer)
        {
            return;
        }

        if (!this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle))
        {
            return;
        }

        this.customAttrEncoder.EmitStringAttribute(
            typeDefHandle,
            "System.Reflection.DefaultMemberAttribute",
            typeof(System.Reflection.DefaultMemberAttribute),
            "Item");
    }

    // ADR-0118 / issue #944: indexer get_Item/set_Item accessors are reached
    // through BoundUserInstanceCallExpression (obj[i] / obj[i]=v), whose emit
    // resolves the accessor via cache.MethodHandles. Mirror the planned
    // PropertyAccessorHandles rows into MethodHandles for indexer accessors.
    // Issue #1104: a base-property access (`base.Prop` / `base.Prop = v`) is
    // lowered to a BoundBaseClassCallExpression over the property's getter /
    // setter FunctionSymbol, which the emitter also resolves via
    // cache.MethodHandles — so register ordinary instance property accessors
    // there too (not just indexers).
    private void RegisterIndexerAccessorHandles(
        PropertySymbol prop,
        MethodDefinitionHandle? getterHandle,
        MethodDefinitionHandle? setterHandle)
    {
        if (prop.GetterSymbol != null && getterHandle.HasValue)
        {
            this.cache.MethodHandles[prop.GetterSymbol] = getterHandle.Value;
        }

        if (prop.SetterSymbol != null && setterHandle.HasValue)
        {
            this.cache.MethodHandles[prop.SetterSymbol] = setterHandle.Value;
        }
    }

    /// <summary>
    /// ADR-0091: returns <see langword="true"/> when
    /// <paramref name="ifaceSym"/> is a user-declared generic interface
    /// reference whose method references must be parented at a
    /// <c>TypeSpec</c> rather than the bare TypeDef row.
    /// </summary>
    internal static bool IsUserGenericInterfaceReference(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym == null)
        {
            return false;
        }

        if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
        {
            return true;
        }

        var def = ifaceSym.Definition ?? ifaceSym;
        return !def.TypeParameters.IsDefaultOrEmpty;
    }

    // PR-E-19: widened private → internal static so the extracted
    // UserTokenResolver can call it (ResolveUserInstanceMethodToken /
    // ResolveUserStaticMethodToken). Stays on the root — it is a shared
    // imported-method lookup, not user-token-cache state.
    internal static MethodInfo FindImportedMethod(Type declaringType, FunctionSymbol method, BindingFlags bindingFlags)
    {
        foreach (var candidate in declaringType.GetMethods(bindingFlags))
        {
            if (!string.Equals(candidate.Name, method.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var parameters = candidate.GetParameters();
            if (parameters.Length != method.Parameters.Length)
            {
                continue;
            }

            var matches = true;
            for (var i = 0; i < parameters.Length; i++)
            {
                var candidateType = parameters[i].ParameterType;
                var methodType = method.Parameters[i].Type.ClrType;
                if (parameters[i].ParameterType.IsByRef != (method.Parameters[i].RefKind != RefKind.None))
                {
                    matches = false;
                    break;
                }

                if (methodType != null && candidateType != methodType && candidateType != methodType.MakeByRefType())
                {
                    matches = false;
                    break;
                }
            }

            if (matches)
            {
                return candidate;
            }
        }

        return null;
    }

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal static MethodInfo GetTypeBuilderSafePropertyAccessor(PropertyInfo property, bool wantSetter, bool nonPublic = false)
        => ImportedMemberRefFactory.GetTypeBuilderSafePropertyAccessor(property, wantSetter, nonPublic);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetMethodReference(MethodInfo method)
        => this.memberRefs.GetMethodReference(method);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method)
        => this.memberRefs.GetMethodEntityHandle(method);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method, TypeSymbol containingTypeSymbol)
        => this.memberRefs.GetMethodEntityHandle(method, containingTypeSymbol);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols)
        => this.memberRefs.GetMethodEntityHandle(method, typeArgSymbols);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols, TypeSymbol containingTypeSymbol)
        => this.memberRefs.GetMethodEntityHandle(method, typeArgSymbols, containingTypeSymbol);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor)
        => this.memberRefs.GetCtorReference(ctor);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor, TypeSymbol containingTypeSymbol)
        => this.memberRefs.GetCtorReference(ctor, containingTypeSymbol);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetNullableCtorMemberRefForOpenTypeParameter(NullableTypeSymbol nullableOfTp)
        => this.memberRefs.GetNullableCtorMemberRefForOpenTypeParameter(nullableOfTp);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetNullableCtorMemberRefForUserEnum(NullableTypeSymbol nullableOfEnum)
        => this.memberRefs.GetNullableCtorMemberRefForUserEnum(nullableOfEnum);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetNullableCtorMemberRefForUserValueType(NullableTypeSymbol nullableOfUserVt)
        => this.memberRefs.GetNullableCtorMemberRefForUserValueType(nullableOfUserVt);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetNullableGetValueMemberRefForUserValueType(NullableTypeSymbol nullableOfUserVt)
        => this.memberRefs.GetNullableGetValueMemberRefForUserValueType(nullableOfUserVt);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetNullableGetHasValueMemberRefForUserValueType(NullableTypeSymbol nullableOfUserVt)
        => this.memberRefs.GetNullableGetHasValueMemberRefForUserValueType(nullableOfUserVt);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetFieldReference(FieldInfo field)
        => this.memberRefs.GetFieldReference(field);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetFieldReferenceOnConstructedGeneric(Type closedGenericType, string fieldName)
        => this.memberRefs.GetFieldReferenceOnConstructedGeneric(closedGenericType, fieldName);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetCtorReferenceOnConstructedGeneric(Type closedGenericType, int paramCount)
        => this.memberRefs.GetCtorReferenceOnConstructedGeneric(closedGenericType, paramCount);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetDelegateCtorReference(Type delegateType)
        => this.memberRefs.GetDelegateCtorReference(delegateType);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetTupleFieldReference(TupleTypeSymbol tupleType, string fieldName)
        => this.memberRefs.GetTupleFieldReference(tupleType, fieldName);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetTupleCtorReference(TupleTypeSymbol tupleType)
        => this.memberRefs.GetTupleCtorReference(tupleType);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetMapCtorReference(MapTypeSymbol mapType)
        => this.memberRefs.GetMapCtorReference(mapType);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal MemberReferenceHandle GetMapSetItemReference(MapTypeSymbol mapType)
        => this.memberRefs.GetMapSetItemReference(mapType);

    // Issue #1785: `async func f(...) T?` for a same-compilation user value
    // type (struct/enum) has a ResultTypeSymbol that is a NullableTypeSymbol
    // wrapping the struct/enum, not the bare struct/enum symbol itself.
    // Recognize that shape too — symbol-based (NullableLifting), not
    // ClrType.IsValueType, which is null for in-flight user types — so the
    // kickoff method's real Task<T?> return type is closed over the emitted
    // Nullable<UserT> instead of falling back to the erased Task<object>.
    // Issue #2381: generalized to reuse ArgIsSymbolicUserDefined so an
    // imported generic collection closed over a same-compilation argument
    // (`List[DiagnosticCheck]`, `Dictionary[string, DiagnosticCheck]`,
    // `List[List[DiagnosticCheck]]`, arrays/slices of a user type, a
    // nullable-wrapped user value type held as a type argument, …) routes
    // through the same symbolic Task<T> construction as the bare
    // struct/interface/enum/type-parameter case, instead of trusting the
    // erased CLR type cached on the constructed ImportedTypeSymbol.
    private static bool IsAsyncUserDefinedResultType(TypeSymbol type)
        => ArgIsSymbolicUserDefined(type);

    private static bool TryCreateSymbolicAsyncTaskType(SynthesizedStateMachineType stateMachine, out TypeSymbol taskType)
    {
        taskType = null;
        if (stateMachine?.ResultTypeSymbol == null
            || !IsAsyncUserDefinedResultType(stateMachine.ResultTypeSymbol)
            || stateMachine.BuilderInfo?.TaskProperty?.PropertyType is not Type taskClrType
            || !taskClrType.IsConstructedGenericType)
        {
            return false;
        }

        taskType = ImportedTypeSymbol.GetConstructed(
            taskClrType,
            taskClrType.GetGenericTypeDefinition(),
            ImmutableArray.Create(stateMachine.ResultTypeSymbol));
        return true;
    }

    // Phase 4 emit parity (F1): used by call sites to decide whether a value
    // crossing the open-generic boundary needs box / unbox.any. Mirrors the
    // CLR's value-type predicate over GSharp type symbols.
    // PR-E-5: widened from `private static` to `internal static` so the
    // extracted ConversionEmitter (a sibling file in this assembly) can
    // call into the canonical value-type test without taking a hard
    // back-reference to the root emitter. The predicate itself is
    // structurally pure and has no other dependencies.
    internal static bool IsValueTypeSymbol(TypeSymbol type)
    {
        if (type == TypeSymbol.Int32 || type == TypeSymbol.Bool)
        {
            return true;
        }

        if (type is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        // Issue #193: a user-defined enum is a CLR value type (sealed,
        // derives from System.Enum). Boundary boxing logic (e.g. generic
        // argument passing) must treat it as such even though it has no
        // ClrType on the symbol.
        if (type is EnumSymbol)
        {
            return true;
        }

        // Issue #813: a tuple type is always a CLR value type
        // (`System.ValueTuple<...>`). When one or more of its element types
        // is an open generic parameter the symbol's ClrType is null and
        // the ClrType-based branch below misses it, so boxing decisions
        // (e.g. `(int32, T) → object`) on iterator yield paths would
        // throw GS9998 from the emitter's NotSupportedException. Recognise
        // the symbolic form directly.
        if (type is TupleTypeSymbol)
        {
            return true;
        }

        // Issue #806: a `T?` over a value-type-constrained type parameter
        // lowers to `Nullable<T>` (a struct). Without recognising this
        // symbolic form, instance-method calls on the receiver would emit
        // `callvirt` + value-on-stack instead of `call` + managed pointer,
        // producing PEVerify-rejected IL.
        if (type is NullableTypeSymbol nullableTp
            && nullableTp.UnderlyingType is TypeParameterSymbol tp
            && tp.HasValueTypeConstraint)
        {
            return true;
        }

        // Issue #1298: `E?` over a user-declared enum lowers to the CLR struct
        // `System.Nullable<E>`. The enum has no ClrType on the symbol, so the
        // ClrType-based branch below misses it; recognise the symbolic form so
        // default-init (`ldloca; initobj; ldloc`) and boxing decisions treat it
        // as a value type.
        //
        // Issue #1572: the same applies to `S?` over a user-declared value-type
        // struct (`!IsClass`). Both underlyings have a null ClrType during emit,
        // so without this arm `EmitDefault` takes the `ldnull` reference path
        // for a `Nullable<UserStruct>` nil-default — producing invalid IL.
        if (type is NullableTypeSymbol nullableUserVt
            && NullableLifting.IsUserValueTypeNullable(nullableUserVt))
        {
            return true;
        }

        // Issue #2335: a bare (non-nullable) value-type-constrained generic
        // type parameter (`where T : struct`, optionally combined with an
        // `Enum`/other constraint) lowers to an unboxed CLR value on the
        // evaluation stack — the same as `Nullable<T>`'s underlying, which
        // the arm above already recognises. Without this check, a bare
        // `TypeParameterSymbol` with `HasValueTypeConstraint` (no
        // `NullableTypeSymbol` wrapper, and — since it is an open generic
        // parameter — no `ClrType` at emit time) fell through to `return
        // false`, misclassifying it as a reference type. Consumers such as
        // `MethodBodyEmitter.EmitTypePattern` then selected `castclass`
        // instead of `unbox.any` for a `case enm is TEnum` pattern,
        // producing IL that ILVerify rejects ("found ref TEnum, expected
        // value TEnum").
        if (type is TypeParameterSymbol bareTp && bareTp.HasValueTypeConstraint)
        {
            return true;
        }

        if (type?.ClrType != null && type.ClrType.IsValueType)
        {
            return true;
        }

        return false;
    }

    // Issue #671 (construction-call follow-up): a generic type-argument
    // position carries a "user-defined" symbol when it is itself a
    // user-declared type (Struct/Class/Interface/Enum/Delegate) — its
    // ClrType is only produced during emit — or when it is a nested
    // constructed generic whose own arguments transitively carry one.
    // This predicate gates the symbolic-container emit paths so a
    // <c>List[List[MyGs]]</c> receiver is recognised even though its
    // outer argument is an <see cref="ImportedTypeSymbol"/> rather than a
    // direct user-defined symbol.
    // Issue #2381: widened from `private` to `internal` so
    // AsyncStateMachineTypeBuilder can reuse this exact same-compilation /
    // type-parameter detection to decide when an async kickoff's Task<T> /
    // AsyncTaskMethodBuilder<T> / builder-field type must be constructed
    // symbolically (ImportedTypeSymbol.GetConstructed) rather than via a
    // reflection-resolved (and, for a same-compilation argument, object-
    // erased) CLR type — instead of re-deriving an equivalent but separately
    // maintained predicate.
    internal static bool ArgIsSymbolicUserDefined(TypeSymbol arg)
    {
        if (arg is StructSymbol or InterfaceSymbol or EnumSymbol or DelegateTypeSymbol)
        {
            return true;
        }

        // Issue #833: an in-scope generic type parameter (MVar/Var) carried
        // through as a call-site type argument must drive the symbolic
        // encoding path so the resulting MethodSpec references `MVar(idx)`
        // / `Var(idx)` instead of the type-erased `System.Object`
        // placeholder.
        if (arg is TypeParameterSymbol)
        {
            return true;
        }

        if (arg is ImportedTypeSymbol nested
            && nested.OpenDefinition != null
            && !nested.TypeArguments.IsDefaultOrEmpty
            && nested.TypeArguments.Any(ArgIsSymbolicUserDefined))
        {
            return true;
        }

        if (arg is ArrayTypeSymbol arr)
        {
            return ArgIsSymbolicUserDefined(arr.ElementType);
        }

        if (arg is SliceTypeSymbol slice)
        {
            return ArgIsSymbolicUserDefined(slice.ElementType);
        }

        if (arg is NullableTypeSymbol nullable && nullable.UnderlyingType != null)
        {
            return ArgIsSymbolicUserDefined(nullable.UnderlyingType);
        }

        // Issue #1902: a positional tuple element may itself carry a
        // same-compilation user type (e.g. the `(Owner, Pet)` transparent
        // identifier a query's Join/GroupJoin result-selector returns).
        // Without recursing here, `FunctionTypeNeedsSymbolicDelegate` misses
        // the tuple-typed return and picks the reflection-resolved
        // `overrideDelegateType` (whose ClrType was closed with the erased
        // `object` placeholders from `TryBuildErasedClosedGeneric` — see
        // MemberLookup.cs), so the lambda gets emitted as
        // `Func<Owner,Pet,ValueTuple<object,object>>` while the body it
        // targets is really typed `ValueTuple<Owner,Pet>` — a stack-shape
        // mismatch ilverify rejects (StackUnexpected).
        if (arg is TupleTypeSymbol tuple)
        {
            return tuple.ElementTypes.Any(ArgIsSymbolicUserDefined);
        }

        return false;
    }

    // Issue #504: a NullableTypeSymbol whose underlying CLR type is a value
    // type maps to the CLR struct `System.Nullable<T>` — a distinct CLR
    // value type with its own layout and ctor. NullableTypeSymbol over a
    // reference type, by contrast, shares the CLR representation of T (the
    // wrapper is a binder-level annotation; ldnull is a valid value for it).
    // Emit-time conversion logic for value-type Nullable<T> needs a
    // `newobj Nullable<T>::.ctor(T)` for the lift, an `initobj` for the
    // default value, and `box Nullable<T>` for object widening — none of
    // which the reference-type path handles.
    internal static bool IsValueTypeNullable(NullableTypeSymbol nullable)
        => NullableLifting.IsValueTypeNullable(nullable);

    // PR-E-18: the three reified-delegate-shape caches
    // (functionDelegateTypeSpecCache / functionDelegateCtorRefCache /
    // functionDelegateInvokeRefCache) moved with the delegate MemberRef
    // producers to ImportedMemberRefFactory as its private fields, since they
    // were RME privates consumed solely by that band.

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetFunctionDelegateTypeSpec(FunctionTypeSymbol fnType)
        => this.memberRefs.GetFunctionDelegateTypeSpec(fnType);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetConstructedDelegateCtorRef(ImportedTypeSymbol symbolicDelegate)
        => this.memberRefs.GetConstructedDelegateCtorRef(symbolicDelegate);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetFunctionDelegateCtorRef(FunctionTypeSymbol fnType)
        => this.memberRefs.GetFunctionDelegateCtorRef(fnType);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle GetFunctionDelegateInvokeRef(FunctionTypeSymbol fnType)
        => this.memberRefs.GetFunctionDelegateInvokeRef(fnType);

    // PR-E-18: transitional forwarder into the extracted ImportedMemberRefFactory.
    internal EntityHandle? TryGetSymbolicAsyncDelegateCtorRef(FunctionTypeSymbol fnType, FunctionSymbol function)
        => this.memberRefs.TryGetSymbolicAsyncDelegateCtorRef(fnType, function);

    /// <summary>
    /// Issue #456: deterministic ordering for FunctionSymbols emitted into
    /// the MethodDef table. Sort first by the function's source declaration
    /// start (so user-visible order matches source order), then by name
    /// (Ordinal) for synthesized helpers that lack a Declaration or share a
    /// span. This guarantees byte-identical MethodDef layout across
    /// Compilation instances, which is required for byte-deterministic emit
    /// (cf. <see cref="DebugInformationOptions.Deterministic"/>).
    /// </summary>
    private sealed class FunctionEmitOrderComparer : IComparer<FunctionSymbol>
    {
        public static readonly FunctionEmitOrderComparer Instance = new FunctionEmitOrderComparer();

        private FunctionEmitOrderComparer()
        {
        }

        public int Compare(FunctionSymbol x, FunctionSymbol y)
        {
            if (ReferenceEquals(x, y))
            {
                return 0;
            }

            if (x is null)
            {
                return -1;
            }

            if (y is null)
            {
                return 1;
            }

            int xPos = x.Declaration?.Span.Start ?? int.MaxValue;
            int yPos = y.Declaration?.Span.Start ?? int.MaxValue;
            int cmp = xPos.CompareTo(yPos);
            if (cmp != 0)
            {
                return cmp;
            }

            cmp = string.CompareOrdinal(x.Name ?? string.Empty, y.Name ?? string.Empty);
            if (cmp != 0)
            {
                return cmp;
            }

            // Final tiebreaker for distinct-but-otherwise-equal symbols (e.g.
            // synthesized partial-method shadows): fall back to a stable
            // signature string so equal-named overloads get a deterministic
            // order even when source positions and names coincide.
            return string.CompareOrdinal(FormatSignature(x), FormatSignature(y));
        }

        private static string FormatSignature(FunctionSymbol fn)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(fn.Type?.Name ?? "?");
            sb.Append('(');
            for (int i = 0; i < fn.Parameters.Length; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }

                sb.Append(fn.Parameters[i].Type?.Name ?? "?");
            }

            sb.Append(')');
            return sb.ToString();
        }
    }

    // PR-E-11: BodyEmitter promoted to top-level MethodBodyEmitter
    // (src/Core/CodeAnalysis/Emit/MethodBodyEmitter.cs and partials).
    // PR-E-2: MethodSpecSymbolKey moved into MetadataTokenCache.
}
