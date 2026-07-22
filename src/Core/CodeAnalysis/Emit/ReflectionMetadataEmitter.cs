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

    // PR-E-20: the function-emission band (the ordinary managed-body emitter
    // EmitFunction + its method-level NullableContextAttribute compaction
    // ChooseMethodNullableContext, the @DllImport / @LibraryImport interop
    // shapes and their FieldMarshal / import-attribute helpers, the top-level
    // global FieldDef emitter EmitGlobalFieldDefs, and the async state-machine
    // MoveNext body-bytes callback BuildMoveNextBodyBytes) has moved into
    // FunctionEmitter. Back-bound to this root (the ConstructorBodyEmitter /
    // MethodBodyEmitter idiom) because the band drives MethodBodyEmitSession
    // scaffolds and reaches emitCtx / cache / remaps / signatures / memberRefs
    // plus the later-constructed wellKnown / closures / stateMachines /
    // customAttrEncoder peers AND two root-owned surfaces that stay put and are
    // shared with EmitCore (EncodeAsyncReturnType, EmitExtensionAttribute).
    // Constructed in the ctor after userTokens (it only reads emitCtx / cache /
    // remaps / signatures / memberRefs at construction time); EmitFunction /
    // EmitGlobalFieldDefs / BuildMoveNextBodyBytes keep compiling their in-RME
    // callers and delegate bindings through the one-line forwarders below
    // (repointed in E-21).
    internal readonly FunctionEmitter functions;
    private readonly IReadOnlyList<(string Name, byte[] Data, bool IsPublic)> embeddedResources;

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
    // PR-E-20: widened private → internal so the extracted FunctionEmitter can
    // read it through the `outer` back-reference (EmitFunction / EmitPInvoke /
    // EmitLibraryImport stamp Param / Nullable / user-attribute rows via it).
    internal CustomAttributeEncoder customAttrEncoder;

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
                    PreResolvedConstraintHandle = this.memberRefs.GetElementTypeToken(gpRow.InterfaceConstraintType),
                };
            }
        }
    }

    private ReflectionMetadataEmitter(BoundProgram program, ReferenceResolver references, string assemblyName, bool metadataOnly, IReadOnlyList<(string Name, byte[] Data, bool IsPublic)> embeddedResources)
    {
        this.emitCtx = new EmitContext(program, references, assemblyName, metadataOnly);
        this.embeddedResources = embeddedResources;
        this.cache = new MetadataTokenCache();
        this.remaps = new GenericRemapState();
        this.signatures = new SignatureEncoder(this);
        this.memberRefs = new ImportedMemberRefFactory(this);
        this.userTokens = new UserTokenResolver(this);
        this.functions = new FunctionEmitter(this);
        this.slotPlanner = new SlotPlanner(this.emitCtx, this.cache, this.NeedsRvalueReceiverSpill);
    }

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
    /// <param name="targetFrameworkMoniker">
    /// Optional long target framework moniker emitted as
    /// <c>TargetFrameworkAttribute</c>.
    /// </param>
    /// <param name="embeddedResources">Managed resources to embed in runtime assemblies.</param>
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
        string assemblyVersion = null,
        string targetFrameworkMoniker = null,
        IReadOnlyList<(string Name, byte[] Data, bool IsPublic)> embeddedResources = null)
    {
        var emitter = new ReflectionMetadataEmitter(program, references, assemblyName, metadataOnly, embeddedResources);
        emitter.emitCtx.AssemblyVersionOverride = assemblyVersion;
        emitter.emitCtx.TargetFrameworkMoniker = targetFrameworkMoniker;

        emitter.emitCtx.DebugInformation = debugInformation ?? new DebugInformationOptions();
        emitter.emitCtx.PdbStream = pdbStream;

        emitter.EmitCore(peStream, asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult);
    }

    // Phase records retain the original mutable collection instances so row
    // planning and emission share the same handles, counters, and ordering.
    private readonly record struct GeneratedTypeSet(
        List<BoundFunctionLiteralExpression> LambdaLiterals,
        ImmutableArray<StructSymbol> AllAggregates,
        List<StructSymbol> AsyncStateMachineStructs,
        Dictionary<StructSymbol, AsyncStateMachinePlan> AsyncStateMachinePlansByStruct);

    private readonly record struct NestedTypeOrder(
        List<TypeSymbol> Types,
        Dictionary<TypeSymbol, int> FirstFieldRows,
        Dictionary<TypeSymbol, int> FirstMethodRows);

    private readonly record struct AggregatePartitions(
        List<StructSymbol> NonStateMachineClasses,
        List<StructSymbol> StateMachineClasses,
        List<StructSymbol> NonStateMachineStructs,
        List<StructSymbol> StateMachineStructs);

    private readonly record struct TopLevelTypeOrder(
        List<InterfaceSymbol> Interfaces,
        List<StructSymbol> Classes,
        List<StructSymbol> Structs,
        List<EnumSymbol> Enums);

    private readonly record struct AggregateTypeLayout(
        AggregatePartitions Aggregates,
        TopLevelTypeOrder TopLevel,
        ImmutableArray<EnumSymbol> AllEnums,
        NestedTypeOrder NestedTypes);

    private readonly record struct FieldRowPlan(
        Dictionary<InterfaceSymbol, int> InterfaceFirstRows,
        Dictionary<StructSymbol, int> AggregateFirstRows,
        Dictionary<EnumSymbol, int> EnumFirstRows,
        ImmutableArray<GlobalVariableSymbol> Globals,
        int ProgramFirstRow,
        int ModuleFirstRow);

    private readonly record struct TypeMethodRows(
        Dictionary<InterfaceSymbol, int> InterfaceFirstRows,
        Dictionary<DelegateTypeSymbol, int> DelegateConstructorRows,
        Dictionary<StructSymbol, int> ClassConstructorRows,
        Dictionary<StructSymbol, int> ClassPrimaryConstructorRows,
        Dictionary<FunctionSymbol, MethodDefinitionHandle> AggregateMethodHandles,
        Dictionary<StructSymbol, int> StructFirstRows);

    private readonly record struct MethodRowPlan(
        ImmutableArray<DelegateTypeSymbol> Delegates,
        TypeMethodRows TypeRows,
        bool EntryPointIsClassOwned,
        int FirstNestedRow,
        int FirstPackageConstructorRow);

    private readonly record struct PackageMethodPlan(
        ImmutableArray<PackageSymbol> Packages,
        Dictionary<PackageSymbol, List<FunctionSymbol>> FunctionsByPackage,
        PackageSymbol EntryPointPackage,
        Dictionary<PackageSymbol, int> ConstructorRows,
        MethodDefinitionHandle EntryPointHandle);

    private readonly record struct DebugArtifacts(
        BlobBuilder PdbBlob,
        DebugDirectoryBuilder DebugDirectory,
        bool PdbEnabled,
        bool IsEmbedded);

    private void EmitCore(
        Stream peStream,
        AsyncStateMachineRewriteResult asyncRewriteResult = null,
        IteratorRewriteResult iteratorRewriteResult = null,
        Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult = null)
    {
        this.InitializePortablePdb();
        this.ResolveCoreTypesAndWireEmitters();
        this.RegisterRewriteResults(asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult);

        var lambdaLiterals = this.SynthesizeClosuresAndStateMachines();
        this.RegisterGeneratedGenericRemaps();
        var generatedTypes = this.MaterializeGeneratedTypes(lambdaLiterals);
        var aggregateTypes = this.DiscoverAndOrderAggregateTypes(generatedTypes);
        var fieldRows = this.PlanFieldRows(aggregateTypes);
        var methodRows = this.PlanMethodRows(aggregateTypes);

        this.EmitUserTypeDefinitionsAndEarlyMethods(aggregateTypes, fieldRows, methodRows);
        var packageMethods = this.PlanPackageAndStateMachineMethods(generatedTypes, aggregateTypes, methodRows);
        var programTypeDefinitions = this.EmitProgramAndStateMachineTypeDefinitions(
            aggregateTypes,
            fieldRows,
            methodRows,
            packageMethods);
        this.EmitRemainingMethodDefinitions(generatedTypes, aggregateTypes, methodRows, packageMethods);
        this.EmitNestedTypeRows(aggregateTypes, packageMethods, programTypeDefinitions);

        var mvidFixup = this.EmitModuleAndAssemblyRows();
        var debugArtifacts = this.BuildPortablePdbAndDebugDirectory(packageMethods.EntryPointHandle);
        this.SerializePeAndWriteOutputs(peStream, packageMethods.EntryPointHandle, mvidFixup, debugArtifacts);
    }

    private void InitializePortablePdb()
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
    }

    private void ResolveCoreTypesAndWireEmitters()
    {
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
        this.wellKnown = new WellKnownReferences(this.emitCtx, this.memberRefs.GetTypeReference, this.memberRefs.GetMethodReference);

        // PR-E-12: CustomAttributeEncoder depends on GetTypeReference (the
        // dedup-cached root resolver) and wellKnown's GetIsReadOnlyAttributeCtorRef.
        // It owns every custom-attribute blob-encoding helper; the assembly-
        // level orchestrators on this root forward into it.
        this.customAttrEncoder = new CustomAttributeEncoder(
            this.emitCtx,
            this.wellKnown,
            this.memberRefs.GetTypeReference,
            this.userTokens.ResolveUserCtorTokenForPrimary,
            this.userTokens.ResolveUserCtorTokenForDefault,
            this.userTokens.ResolveUserCtorTokenForExplicit);

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
            this.memberRefs.GetTypeReference);

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
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetTypeHandleForMember,
            this.signatures.EncodeTypeSymbol);

        // PR-E-5: now that wellKnown is materialised, wire ConversionEmitter.
        // GetElementTypeToken is passed as a delegate (same pattern as
        // SlotPlanner's needsRvalueReceiverSpill) so the new component does
        // not need a hard back-reference to this emitter.
        this.conversionEmitter = new ConversionEmitter(this.emitCtx, this.cache, this.wellKnown, this.memberRefs.GetElementTypeToken);

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
            this.memberRefs.GetElementTypeToken,
            this.memberRefs.GetTypeReference,
            this.customAttrEncoder.NextParameterHandle,
            this.userTokens.ResolveUserTypeToken,
            this.userTokens.ResolveFieldToken,
            this.userTokens.GetUserStructMethodRef);

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
            this.functions.EmitFunction,
            this.signatures.EncodeTypeSymbol,
            this.customAttrEncoder.NextParameterHandle,
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetTypeHandleForMember,
            this.userTokens.ResolveFieldToken,
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
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetTypeHandleForMember,
            this.userTokens.GetUserStructTypeSpec,
            this.userTokens.ResolveConstructedBaseParameterlessCtorToken,
            this.userTokens.ResolveConstructedBaseExplicitCtorToken,
            this.customAttrEncoder.NextParameterHandle,
            this.customAttrEncoder.EmitUserAttributes,
            handle => this.customAttrEncoder.EmitNullableContextAttributeOnType(handle, NullableFlagsBuilder.NotAnnotated),
            this.customAttrEncoder.EmitNullableAttributeOnField,
            this.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter,
            this.customAttrEncoder.EmitParamArrayAttributeOnParameter,
            this.memberRefs.GetCtorReference,
            (ctor, containingType) => this.memberRefs.GetCtorReference(ctor, containingType),
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
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetTypeHandleForMember,
            this.memberRefs.GetMethodEntityHandle,
            this.memberRefs.GetMethodEntityHandle,
            this.memberRefs.GetMethodReference,
            this.customAttrEncoder.NextParameterHandle,
            this.signatures.EncodeTypeSymbol,
            this.signatures.EncodeClrType,
            this.userTokens.GetStructTypeToken,
            this.userTokens.ResolveFieldToken,
            this.functions.BuildMoveNextBodyBytes);
    }

    private void RegisterRewriteResults(
        AsyncStateMachineRewriteResult asyncRewriteResult,
        IteratorRewriteResult iteratorRewriteResult,
        Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult)
    {
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
    }

    private List<BoundFunctionLiteralExpression> SynthesizeClosuresAndStateMachines()
    {
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

        return lambdaLiterals;
    }

    private void RegisterGeneratedGenericRemaps()
    {
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
    }

    private GeneratedTypeSet MaterializeGeneratedTypes(List<BoundFunctionLiteralExpression> lambdaLiterals)
    {
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

        return new GeneratedTypeSet(lambdaLiterals, allAggregates, asyncSmStructs, asyncSmPlansByStruct);
    }

    private AggregateTypeLayout DiscoverAndOrderAggregateTypes(GeneratedTypeSet generatedTypes)
    {
        var allAggregates = generatedTypes.AllAggregates;
        var asyncSmStructs = generatedTypes.AsyncStateMachineStructs;

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

        return new AggregateTypeLayout(
            new AggregatePartitions(nonSmClasses, smClasses, nonSmStructs, smStructsOrdered),
            new TopLevelTypeOrder(topInterfaces, topClasses, topStructs, topEnums),
            enumsAll,
            new NestedTypeOrder(nestedOrdered, nestedFieldListRow, nestedMethodListRow));
    }

    private FieldRowPlan PlanFieldRows(AggregateTypeLayout aggregateTypes)
    {
        var smClasses = aggregateTypes.Aggregates.StateMachineClasses;
        var smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs;
        var topInterfaces = aggregateTypes.TopLevel.Interfaces;
        var topClasses = aggregateTypes.TopLevel.Classes;
        var topStructs = aggregateTypes.TopLevel.Structs;
        var topEnums = aggregateTypes.TopLevel.Enums;
        var enumsAll = aggregateTypes.AllEnums;
        var nestedOrdered = aggregateTypes.NestedTypes.Types;
        var nestedFieldListRow = aggregateTypes.NestedTypes.FirstFieldRows;

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

        return new FieldRowPlan(
            interfaceFirstFieldRow,
            structFirstFieldRow,
            enumFirstFieldRow,
            globals,
            programFirstFieldRow,
            moduleFirstFieldRow);
    }

    private MethodRowPlan PlanMethodRows(AggregateTypeLayout aggregateTypes)
    {
        var topInterfaces = aggregateTypes.TopLevel.Interfaces;
        var topClasses = aggregateTypes.TopLevel.Classes;
        var topStructs = aggregateTypes.TopLevel.Structs;
        var nestedOrdered = aggregateTypes.NestedTypes.Types;
        var nestedMethodListRow = aggregateTypes.NestedTypes.FirstMethodRows;

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
                methodRow += 10
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

            methodRow += this.interfaceImpls.PlanInheritedEventBridges(c, methodRow);

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
                if (s.HasPrimaryConstructor)
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

        return new MethodRowPlan(
            delegates,
            new TypeMethodRows(
                interfaceFirstMethodRow,
                delegateCtorRows,
                classCtorRows,
                classPrimaryCtorRows,
                aggregateMethodHandles,
                structFirstMethodRows),
            entryPointIsClassOwned,
            firstNestedMethodRow,
            firstPackageCtorRow);
    }

    private void EmitUserTypeDefinitionsAndEarlyMethods(
        AggregateTypeLayout aggregateTypes,
        FieldRowPlan fieldRows,
        MethodRowPlan methodRows)
    {
        var nonSmClasses = aggregateTypes.Aggregates.NonStateMachineClasses;
        var nonSmStructs = aggregateTypes.Aggregates.NonStateMachineStructs;
        var topInterfaces = aggregateTypes.TopLevel.Interfaces;
        var topClasses = aggregateTypes.TopLevel.Classes;
        var topStructs = aggregateTypes.TopLevel.Structs;
        var topEnums = aggregateTypes.TopLevel.Enums;
        var nestedOrdered = aggregateTypes.NestedTypes.Types;
        var nestedFieldListRow = aggregateTypes.NestedTypes.FirstFieldRows;
        var nestedMethodListRow = aggregateTypes.NestedTypes.FirstMethodRows;
        var interfaceFirstFieldRow = fieldRows.InterfaceFirstRows;
        var structFirstFieldRow = fieldRows.AggregateFirstRows;
        var enumFirstFieldRow = fieldRows.EnumFirstRows;
        var moduleFirstFieldRow = fieldRows.ModuleFirstRow;
        var interfaceFirstMethodRow = methodRows.TypeRows.InterfaceFirstRows;
        var delegates = methodRows.Delegates;
        var delegateCtorRows = methodRows.TypeRows.DelegateConstructorRows;
        var classCtorRows = methodRows.TypeRows.ClassConstructorRows;
        var classPrimaryCtorRows = methodRows.TypeRows.ClassPrimaryConstructorRows;
        var structFirstMethodRows = methodRows.TypeRows.StructFirstRows;
        var firstNestedMethodRow = methodRows.FirstNestedRow;

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
                            this.userTokens.GetUserInterfaceTypeSpec(baseIface));
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
                    if (MemberLookup.TryGetSymbolicClrGenericInterface(clrBase, out _, out _))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            ifaceTypeDef,
                            this.memberRefs.GetElementTypeToken(clrBase));
                        continue;
                    }

                    if (clrBase?.ClrType is System.Type clrType)
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            ifaceTypeDef,
                            this.memberRefs.GetTypeHandleForMember(clrType));
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
                            this.userTokens.GetUserInterfaceTypeSpec(iface));
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
                            this.memberRefs.GetElementTypeToken(ifaceSym));
                        continue;
                    }

                    if (ifaceSym?.ClrType is System.Type clrIface)
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.memberRefs.GetTypeHandleForMember(clrIface));
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

                    var alreadyDeclared = false;
                    foreach (var implemented in c.ImplementedClrInterfaces)
                    {
                        if (implemented?.ClrType != null
                            && ClrTypeUtilities.AreSame(implemented.ClrType, declaringIface))
                        {
                            alreadyDeclared = true;
                            break;
                        }
                    }

                    if (alreadyDeclared)
                    {
                        continue;
                    }

                    bridgeInterfaces ??= new System.Collections.Generic.HashSet<System.Type>();
                    if (bridgeInterfaces.Add(declaringIface))
                    {
                        this.emitCtx.Metadata.AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.memberRefs.GetTypeHandleForMember(declaringIface));
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
    }

    private PackageMethodPlan PlanPackageAndStateMachineMethods(
        GeneratedTypeSet generatedTypes,
        AggregateTypeLayout aggregateTypes,
        MethodRowPlan methodRows)
    {
        var lambdaLiterals = generatedTypes.LambdaLiterals;
        var smClasses = aggregateTypes.Aggregates.StateMachineClasses;
        var smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs;
        var classCtorRows = methodRows.TypeRows.ClassConstructorRows;
        var classPrimaryCtorRows = methodRows.TypeRows.ClassPrimaryConstructorRows;
        var aggregateMethodHandles = methodRows.TypeRows.AggregateMethodHandles;
        var entryPointIsClassOwned = methodRows.EntryPointIsClassOwned;
        var structFirstMethodRows = methodRows.TypeRows.StructFirstRows;
        var firstPackageCtorRow = methodRows.FirstPackageConstructorRow;

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
                this.userTokens.TryPromoteNonCapturingGenericLambda(literal, loweredLambdaBody);

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
        return new PackageMethodPlan(packages, functionsByPackage, entryPointPackage, packageCtorRows, entryHandle);
    }

    private Dictionary<PackageSymbol, TypeDefinitionHandle> EmitProgramAndStateMachineTypeDefinitions(
        AggregateTypeLayout aggregateTypes,
        FieldRowPlan fieldRows,
        MethodRowPlan methodRows,
        PackageMethodPlan packageMethods)
    {
        var smClasses = aggregateTypes.Aggregates.StateMachineClasses;
        var smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs;
        var structFirstFieldRow = fieldRows.AggregateFirstRows;
        var globals = fieldRows.Globals;
        var programFirstFieldRow = fieldRows.ProgramFirstRow;
        var classCtorRows = methodRows.TypeRows.ClassConstructorRows;
        var structFirstMethodRows = methodRows.TypeRows.StructFirstRows;
        var packages = packageMethods.Packages;
        var functionsByPackage = packageMethods.FunctionsByPackage;
        var entryPointPackage = packageMethods.EntryPointPackage;
        var packageCtorRows = packageMethods.ConstructorRows;

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
            this.functions.EmitGlobalFieldDefs(globals);

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
            var iAsyncSmRef = this.memberRefs.GetTypeReference(iAsyncSmType);
            this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[s], iAsyncSmRef);
        }

        return programTypeDefHandles;
    }

    // B1. Interface methods (abstract + default-interface methods).
    private void EmitInterfaceMethodBodies(InterfaceSymbol i)
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
                var emittedHandle = this.functions.EmitFunction(m, dimBody, isEntryPoint: false);
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
                var emittedHandle = this.functions.EmitFunction(sm, defBody, isEntryPoint: false);
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
                    var emittedHandle = this.functions.EmitFunction(pm, pBody, isEntryPoint: false);
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
                    var emittedHandle = this.functions.EmitFunction(spm, sBody, isEntryPoint: false);
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

    private void EmitRemainingMethodDefinitions(
        GeneratedTypeSet generatedTypes,
        AggregateTypeLayout aggregateTypes,
        MethodRowPlan methodRows,
        PackageMethodPlan packageMethods)
    {
        var asyncSmPlansByStruct = generatedTypes.AsyncStateMachinePlansByStruct;
        var smClasses = aggregateTypes.Aggregates.StateMachineClasses;
        var smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs;
        var topClasses = aggregateTypes.TopLevel.Classes;
        var topStructs = aggregateTypes.TopLevel.Structs;
        var nestedOrdered = aggregateTypes.NestedTypes.Types;
        var entryPointIsClassOwned = methodRows.EntryPointIsClassOwned;
        var packages = packageMethods.Packages;
        var functionsByPackage = packageMethods.FunctionsByPackage;
        var entryPointPackage = packageMethods.EntryPointPackage;

        // === PHASE B: Emit MethodDefs in row order ===
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

                    var emittedHandle = this.functions.EmitFunction(m, body, isEntryPoint: false);
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
            if (c.IsData)
            {
                this.dataStructSynth.EmitDataClassEqualityContractProperty(c);
            }

            this.EmitDefaultMemberAttributeIfIndexer(c);

            // ADR-0052: emit event accessor methods for classes.
            this.memberDefEmitter.EmitEventAccessors(c);
            this.interfaceImpls.EmitInheritedEventBridges(c);

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
                        var emittedHandle = this.functions.EmitFunction(m, staticBody, isEntryPoint: m == this.emitCtx.Program.EntryPoint);
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

            // Issue #2443: bind overrides to virtual members inherited from an
            // imported CLR base class (including covariant-return slots).
            this.interfaceImpls.EmitExternalBaseMethodImpls(c);

            // Issue #2362: emit MethodImpl rows for mangled-name explicit
            // interface property implementations (accessor methods).
            this.interfaceImpls.EmitExplicitInterfacePropertyMethodImpls(c);

            // ADR-0149: emit MethodImpl rows for explicit-interface-clause
            // event implementations (add/remove/raise accessors).
            this.interfaceImpls.EmitExplicitInterfaceEventMethodImpls(c);

            // Issues #2718/#2742: bind custom and inherited event accessors
            // directly to matching user/imported interface event slots.
            this.interfaceImpls.EmitImplicitEventMethodImpls(c);
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

                var emittedHandle = this.functions.EmitFunction(m, body, isEntryPoint: false);
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
                        var emittedHandle = this.functions.EmitFunction(m, staticBody, isEntryPoint: false);
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

            this.interfaceImpls.EmitExternalBaseMethodImpls(s);

            // Issue #2362: emit MethodImpl rows for mangled-name explicit
            // interface property implementations (accessor methods).
            this.interfaceImpls.EmitExplicitInterfacePropertyMethodImpls(s);

            // ADR-0149: emit MethodImpl rows for explicit-interface-clause
            // event implementations (add/remove/raise accessors).
            this.interfaceImpls.EmitExplicitInterfaceEventMethodImpls(s);

            // Issues #2718/#2742: see the class path above.
            this.interfaceImpls.EmitImplicitEventMethodImpls(s);
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
                    this.functions.EmitFunction(fn, body, isEntryPoint: false);
                }
            }

            if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage && !entryPointIsClassOwned)
            {
                var entryBody = this.emitCtx.Program.Functions[this.emitCtx.Program.EntryPoint];
                this.functions.EmitFunction(this.emitCtx.Program.EntryPoint, entryBody, isEntryPoint: true);
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

                        var emittedHandle = this.functions.EmitFunction(m, body, isEntryPoint: false);
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
    }

    private void EmitNestedTypeRows(
        AggregateTypeLayout aggregateTypes,
        PackageMethodPlan packageMethods,
        Dictionary<PackageSymbol, TypeDefinitionHandle> programTypeDefHandles)
    {
        var smClasses = aggregateTypes.Aggregates.StateMachineClasses;
        var smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs;
        var nestedOrdered = aggregateTypes.NestedTypes.Types;
        var packages = packageMethods.Packages;
        var entryPointPackage = packageMethods.EntryPointPackage;

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
    }

    private ReservedBlob<GuidHandle> EmitModuleAndAssemblyRows()
    {
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

        return mvidFixup;
    }

    private DebugArtifacts BuildPortablePdbAndDebugDirectory(MethodDefinitionHandle entryHandle)
    {
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

        return new DebugArtifacts(pdbBlob, debugDirectory, pdbEnabled, isEmbedded);
    }

    private void SerializePeAndWriteOutputs(
        Stream peStream,
        MethodDefinitionHandle entryHandle,
        ReservedBlob<GuidHandle> mvidFixup,
        DebugArtifacts debugArtifacts)
    {
        var pdbBlob = debugArtifacts.PdbBlob;
        var debugDirectory = debugArtifacts.DebugDirectory;
        var pdbEnabled = debugArtifacts.PdbEnabled;
        var isEmbedded = debugArtifacts.IsEmbedded;

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
        TypeDefEmitter.FlushPendingGenericParameters(this.emitCtx, this.memberRefs.GetElementTypeToken, this.BuildUnmanagedConstraintTypeSpec);
        var managedResources = this.BuildManagedResources();
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
                managedResources: managedResources,
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

    private BlobBuilder BuildManagedResources()
    {
        if (this.emitCtx.MetadataOnly || this.embeddedResources == null || this.embeddedResources.Count == 0)
        {
            return null;
        }

        var blob = new BlobBuilder();
        foreach (var resource in this.embeddedResources)
        {
            blob.Align(8);
            var offset = (uint)blob.Count;
            var data = resource.Data ?? Array.Empty<byte>();
            blob.WriteInt32(data.Length);
            blob.WriteBytes(data);
            this.emitCtx.Metadata.AddManifestResource(
                resource.IsPublic ? ManifestResourceAttributes.Public : ManifestResourceAttributes.Private,
                this.emitCtx.Metadata.GetOrAddString(resource.Name),
                implementation: default,
                offset);
        }

        return blob;
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
                this.outer.signatures.EncodeLocalVariableType(encoder.AddVariable(), t);
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
                this.signatures.EncodeTypeSymbol(encoder.Type(), symbolicTaskType);
            }
            else
            {
                // The Task property's return type IS the kickoff return type.
                var taskClrType = builderInfo.TaskProperty.PropertyType;
                this.signatures.EncodeClrType(encoder.Type(), taskClrType);
            }
        }
        else
        {
            encoder.Void();
        }
    }

    /// <summary>
    /// Issue #792 / ADR-0084. Attaches the parameterless
    /// <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c> to the
    /// supplied entity (MethodDef row for an extension method, or a TypeDef
    /// row for the static class that hosts the extension methods).
    /// </summary>
    // PR-E-20: widened private → internal so the extracted FunctionEmitter can
    // stamp [Extension] on a G#-authored extension MethodDef through the `outer`
    // back-reference. Stays on the root because it is shared with EmitCore's
    // EmitProgramExtensionMarker (which stamps the host <Program> TypeDef).
    internal void EmitExtensionAttribute(EntityHandle parent)
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

    private bool NeedsRvalueReceiverSpill(
        BoundExpression receiver,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        // A constrained type parameter needs an address even though its
        // value/reference shape is unknown until the generic is closed.
        if (!IsValueTypeSymbol(receiver.Type) && receiver.Type is not TypeParameterSymbol)
        {
            return false;
        }

        if (receiver is BoundVariableExpression bve
            && bve.NarrowedType == null
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

        var unmanagedTypeRef = this.memberRefs.GetTypeReference(
            this.ResolveCoreType("System.Runtime.InteropServices.UnmanagedType", typeof(System.Runtime.InteropServices.UnmanagedType)));
        var valueTypeRef = this.memberRefs.GetTypeReference(this.emitCtx.CoreValueType);

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
        MethodInfo match = null;
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
                var isByRef = candidateType.IsByRef;
                if (isByRef != (method.Parameters[i].RefKind != RefKind.None))
                {
                    matches = false;
                    break;
                }

                if (isByRef)
                {
                    candidateType = candidateType.GetElementType();
                }

                if (methodType != null && !ClrTypeUtilities.AreSame(candidateType, methodType))
                {
                    matches = false;
                    break;
                }
            }

            if (matches)
            {
                if (match != null)
                {
                    // Normalization can collapse metadata-distinct overloads.
                    return null;
                }

                match = candidate;
            }
        }

        return match;
    }

    // Issue #1785: `async func f(...) T?` for a same-compilation user value
    // type (struct/enum) has a ResultTypeSymbol that is a NullableTypeSymbol
    // wrapping the struct/enum, not the bare struct/enum symbol itself.
    // Recognize that shape too — symbol-based (NullableLifting), not
    // ClrType.IsValueType, which is null for in-flight user types — so the
    // kickoff method's real Task<T?> return type is closed over the emitted
    // Nullable<UserT> instead of falling back to the erased Task<object>.
    // Issues #2381/#2713: use the same symbolic projection predicate as
    // WrapAsTask and async state-machine construction.
    private static bool IsAsyncUserDefinedResultType(TypeSymbol type)
        => TypeSymbol.RequiresSymbolicProjection(type);

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
