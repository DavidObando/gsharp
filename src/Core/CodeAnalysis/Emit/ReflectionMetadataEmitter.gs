// <copyright file="ReflectionMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Security.Cryptography

/// Emits a managed PE for a (cref:BoundProgram) using
/// (cref:System.Reflection.Metadata) directly.
/// @remarks Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on `<Program>`), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
internal class ReflectionMetadataEmitter {
    // PR-E-1: cross-cutting emit state (BoundProgram, ReferenceResolver,
    // MetadataBuilder, IL stream/encoder, assembly-identity overrides,
    // metadata-only flag, PDB plumbing, and the BCL core* Type cache) has
    // moved into EmitContext. Subsequent extraction PRs (MetadataTokenCache,
    // WellKnownReferences, SlotPlanner, …) will consume this same context
    // via constructor injection.
    // PR-E-11: widened to internal so the promoted MethodBodyEmitter can read it.
    internal let emitCtx EmitContext
    internal let utf8Data Utf8LiteralData
    private var workBudget CompilationWorkBudget = CompilationWorkBudget()

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
    internal let cache MetadataTokenCache

    // PR-E-16: the generic type-parameter remap mutable state (the
    // outer-TP → own-slot remaps for reified state-machine / nested / closure
    // classes and generic-promoted lambdas, plus their push/pop scope
    // discipline) has moved into GenericRemapState. The root's registration
    // methods orchestrate over EmitContext/closures and call into this state
    // to record the remaps; EncodeTypeSymbol reads the active remap through it.
    internal let remaps GenericRemapState

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
    internal let signatures SignatureEncoder

    // PR-E-18: the imported / BCL member-and-type reference factory band
    // (GetTypeReference / GetMethodReference / GetCtorReference /
    // GetFieldReference, the element/typeof/assembly resolvers, the symbolic
    // nullable/tuple/map MemberRef families, and the reified Func/Action
    // delegate MemberRef producers). A near-pure move: the ref-cache
    // dictionaries it dedups against already live on MetadataTokenCache
    // (E-2). Constructed in the ctor alongside signatures; the many in-RME
    // callers keep compiling through the one-line forwarders below (repointed
    // in E-21).
    internal let memberRefs ImportedMemberRefFactory

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
    internal let userTokens UserTokenResolver

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
    internal let functions FunctionEmitter

    private let embeddedResources IReadOnlyList[(Name string, Data[]uint8, IsPublic bool)]?
    private let moduleInitializers ImmutableArray[FunctionSymbol]

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
    internal var wellKnown WellKnownReferences

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
    internal var customAttrEncoder CustomAttributeEncoder

    // PR-E-13: AssemblyAttributeEmitter — owns the assembly-level attribute
    // orchestrators that used to sit on this root (EmitReferenceAssemblyAttribute /
    // EmitAssemblyInteropAttributes / EmitUserAssemblyAttributes /
    // EmitFriendAssemblyAttributes / EmitGSharpTypeSemantics /
    // EmitDebuggableAttribute / EmitNullableContextAttribute) plus
    // ParseAssemblyVersion, which feeds the Assembly row. Initialised in
    // EmitCore right after customAttrEncoder because it forwards blob writes
    // into that encoder and depends on wellKnown / GetTypeReference — same
    // EmitCore-ordering reason as the other E-* components.
    private var assemblyAttrs AssemblyAttributeEmitter

    // PR-E-14: InterfaceImplEmitter — owns the MethodImpl-row band that used
    // to close out this file (EmitExplicitInterfaceMethodImpls /
    // EmitExplicitInterfacePropertyMethodImpls /
    // EmitExplicitInterfaceEventMethodImpls / EmitStaticVirtualMethodImpls /
    // EmitStaticVirtualPropertyMethodImpls) plus the open-slot resolvers and
    // static-virtual signature matcher used only by that band. Back-bound to
    // this root (the MethodBodyEmitter idiom) for GetMethodReference /
    // ResolveUserInterfaceInstanceMethodToken / IsUserGenericInterfaceReference.
    private var interfaceImpls InterfaceImplEmitter

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
    private var ctorBodies ConstructorBodyEmitter

    // Phase 4 emit parity (E1): synthesized lambda bodies (no captures).
    // Populated by a pre-pass walker over every user function/entry body.
    // Each lambda's synthetic FunctionSymbol is registered alongside user
    // functions in functionsByPackage so it gets a MethodDef row, and its
    // body is emitted via the same EmitFunction path.
    internal let lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement] = Dictionary[
        FunctionSymbol,
        BoundBlockStatement
    ]()

    // Issue #1336: cached TypeSpec for the `unmanaged` constraint's
    // modreq-decorated System.ValueType GenericParamConstraint. Built lazily and
    // shared across every `where T : unmanaged` type parameter in the module.
    private var unmanagedConstraintTypeSpec EntityHandle

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
    //   asyncIteratorEmitContexts     -> stateMachines.IteratorEmitContexts
    //   asyncSmEnclosingClosures      -> stateMachines.AsyncSmEnclosingClosures
    // BodyEmitter reads stateMachines.IteratorEmitContexts for iterator
    // MoveNext paths; the remaining 2 async-only BodyEmitter-internal SM helpers
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
    internal let slotPlanner SlotPlanner

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
    private var methodBodyPlanner MethodBodyPlanner

    // Reusable slot collections for method-body emit sessions that run one at a
    // time on the coordinator thread (see MethodBodyEmitSession).
    internal let sessionScratchPool ScratchPool[SessionScratch] = ScratchPool[SessionScratch](
        "emit.session-scratch",
        () -> SessionScratch(),
        (scratch SessionScratch) -> scratch.Reset()
    )

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
    private var conversionEmitter ConversionEmitter

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
    private var dataStructSynth DataStructSynthesizer

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
    private var memberDefEmitter MemberDefEmitter

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
    private var typeDefEmitter TypeDefEmitter

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
    internal var closures ClosureEmitter

    // PR-E-10: StateMachineEmitter — sibling of ClosureEmitter — owns
    // async/iterator state-machine synthesis (SynthesizeIteratorStateMachines /
    // SynthesizeAsyncIteratorStateMachines / SynthesizeAsyncLambdaStateMachines)
    // and the top-level MoveNext / SetStateMachine / AwaitOnCompleted /
    // async-kickoff IL emission, plus the nested StateMachineEmitter.IteratorStateMachineInfo /
    // StateMachineEmitter.IteratorEmitContext helpers and every SM cache/plan
    // (IteratorKickoffBodies, IteratorStateMachineInfos, AsyncStateMachinePlans,
    // IteratorPlans, AsyncIteratorPlans, AsyncIteratorInfos,
    // IteratorEmitContexts, AsyncSmEnclosingClosures). The 2 BodyEmitter-
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
    internal var stateMachines StateMachineEmitter

    // Issue #3883: the MethodDef row of the synthesized `<Main>$` entry-point
    // stub that blocks on an AUTHORED async `Main`. Held separately from
    // cache.FunctionHandles because the authored `Main` keeps its own
    // (Task-returning) row there — the stub is a second, distinct MethodDef
    // that nothing but the PE header's EntryPoint token references.
    private var entryPointStubHandle MethodDefinitionHandle

    // Issue #2118: per-lambda-function ordered ORIGINAL enclosing type
    // parameters used as the MethodSpec type arguments when the lambda is
    // referenced (`ldftn <lambda><...enclosing args...>`) at its delegate
    // materialization site. The paired enclosing-TP → own-clone-ordinal remap
    // (which drives EncodeTypeSymbol) lives on GenericRemapState; this ordered
    // list is a delegate-materialization-token concern, not remap-scope state,
    // so it stays on the root.
    internal let lambdaMethodTypeArgsByFunction Dictionary[
        FunctionSymbol,
        ImmutableArray[TypeParameterSymbol]
    ] = Dictionary[FunctionSymbol, ImmutableArray[TypeParameterSymbol]](ReferenceEqualityComparer.Instance)

    /// Issue #1465: reifies an async state-machine struct over an
    /// ordinal-aligned copy of the type parameters in scope at its kickoff
    /// method — the enclosing generic type's parameters first, then the
    /// kickoff method's own type parameters (Roslyn ordering). References to
    /// those parameters inside MoveNext / hoisted-field signatures then encode
    /// as the SM type's own `ELEMENT_TYPE_VAR` slots, and references to
    /// the SM type from the kickoff method self-instantiate as
    /// `SM<!0,…>` using the enclosing type's parameters.
    /// @param smStruct The materialized state-machine struct.
    /// @param kickoff The async kickoff method.
    private func RegisterStateMachineEnclosingGenerics(smStruct StructSymbol, kickoff FunctionSymbol) {
        // Issue #3932: a STATIC (`shared`) async method has no `ReceiverType`,
        // so reading only that left `classTPs` empty and the state machine was
        // reified at arity ZERO even though the owning type is generic — every
        // hoisted field then carried a dangling `!0`
        // (`Chan`1/ChanReader/'<ReadSlowAsync>d__0'` where csc emits
        // `…/<ReadSlowAsync>d__0`1<T>`), which ILVerify reports as
        // `[found …`1<T0>][expected …`1<!0>]`. `StaticOwnerType` is the static
        // counterpart of `ReceiverType`, and the ITERATOR sibling
        // (`StateMachineEmitter.GetIteratorTypeParametersInScope`) has always
        // consulted both — this is the async path catching up. Instance methods
        // were unaffected, which is why the failure needed a `shared async
        // func` on a generic type to surface at all.
        //
        // Issue #3939: the same decision is needed by the KICKOFF BODY, which
        // self-instantiates the struct this method reifies, so both now read it
        // from one primitive on StateMachineEmitter instead of each deriving it
        // — the kickoff's copy had never picked up the `StaticOwnerType` half.
        let (receiverDef, classTPs, methodTPs) = StateMachineEmitter.GetAsyncKickoffGenericScope(kickoff)
        if classTPs.IsDefaultOrEmpty && methodTPs.IsDefaultOrEmpty {
            return
        }
        let total = classTPs.Length + methodTPs.Length
        let origCombined = ImmutableArray.CreateBuilder[TypeParameterSymbol](total)
        origCombined.AddRange(classTPs)
        origCombined.AddRange(methodTPs)
        // Issue #1499: remap self-/cross-referential constraints from the
        // enclosing parameters onto the state machine's cloned set.
        let smTPs = SynthesizedClosureReifier.CloneWithRemappedConstraints(origCombined.MoveToImmutable())
        let remap = Dictionary[TypeParameterSymbol, int32](total)
        var ordinal = 0
        for src in classTPs {
            remap[src] = ordinal
            ordinal++
        }
        for src in methodTPs {
            remap[src] = ordinal
            ordinal++
        }
        // Issue #4223: when the kickoff method is a zero-capture local
        // function/lambda that TryPromoteNonCapturingGenericLambda (#2118)
        // promoted to ALSO carry cloned ENCLOSING type parameters, `methodTPs`
        // above are those CLONES, not the originals the lowered body actually
        // names (the promotion never rewrites parameter/body references, only
        // the method's own declared type-parameter list — see
        // UserTokenResolver.TryPromoteNonCapturingGenericLambda). Without an
        // entry keyed by each ORIGINAL enclosing type parameter, a body
        // reference to it falls through to a dangling `MVar` slot that
        // MoveNext (a non-generic member of the now-generic SM struct) does
        // not have, producing invalid metadata
        // (System.BadImageFormatException at load). Alias each original onto
        // the same SM class slot its clone occupies — this is the exact
        // pattern RegisterGeneratedGenericRemaps already applies to the
        // ITERATOR sibling of this promotion (issue #810 + #2118 combined).
        if this.remaps.TryGetLambdaMethodRemap(kickoff, out var lambdaRemap) {
            // `pair.Value` is already the promoted clone's absolute ordinal
            // within `kickoff.TypeParameters` (== methodTPs above), so the
            // same `classTPs.Length` base the methodTPs loop just used
            // relocates it onto the matching SM class slot.
            for pair in lambdaRemap!! {
                remap[pair.Key] = classTPs.Length + pair.Value
            }
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
        let reifiedFrom = receiverDef?.ReifiedFromTypeParameters ?? ImmutableArray[TypeParameterSymbol].Empty
        let reifiedOffset = receiverDef?.ReifiedTypeParameterOrdinalOffset ?? 0
        if !reifiedFrom.IsDefaultOrEmpty &&
            reifiedOffset >= 0 &&
            reifiedOffset +
            reifiedFrom.Length <= classTPs.Length {
            for var i = 0; i < reifiedFrom.Length; i++ {
                remap[reifiedFrom[i]] = reifiedOffset + i
            }
        }
        smStruct.SetTypeParameters(smTPs)
        this.remaps.RegisterClassRemap(smStruct, remap)
    }

    // Issue #3883: whether the entry point is an AUTHORED `async func Main`
    // whose async builder exposes a Task. Such a Main must keep its
    // Task/Task<T> return type in metadata — it is an ordinary, callable,
    // awaitable member, possibly from another assembly — so the CLR
    // entry-point signature rewrite (issue #1904) cannot be applied to its
    // own MethodDef row. A separate `<Main>$` stub row is emitted instead,
    // exactly as csc does. The TLS-synthesized entry point (Declaration is
    // null) is excluded: it has no authored declaration to preserve, so
    // rewriting it in place remains correct.
    private prop EntryPointNeedsSeparateStub bool {
        get {
            let entryPoint = this.emitCtx.Program.EntryPoint
            if !(entryPoint != nil && entryPoint.Declaration != nil && entryPoint.IsAsync == true) {
                return false
            }
            for plan in this.stateMachines.AsyncStateMachinePlans {
                if plan.KickoffMethod == entryPoint {
                    return plan.StateMachine.BuilderInfo.TaskProperty != nil
                }
            }
            return false
        }
    }

    // ADR-0092 / issue #758: a LibraryImport function emits TWO MethodDef
    // rows — the user-visible managed stub (already planned by the caller at
    // `row - 1`) and, immediately after it, the hidden blittable inner
    // P/Invoke the stub calls (FunctionEmitter.EmitLibraryImportFunction
    // writes them back to back). Issue #4370: every planner that reserves a
    // row for a function that may be a P/Invoke — package-level functions
    // AND class/struct `shared` members — must reserve the inner row too, or
    // the emitter's LibraryImportInnerHandles lookup has nothing to find.
    // Returns the next free row.
    private func PlanLibraryImportInnerRow(function FunctionSymbol, row int32) int32 {
        if function.PInvokeMetadata is {IsLibraryImport: true} {
            this.cache.LibraryImportInnerHandles[function] = MetadataTokens.MethodDefinitionHandle(row)
            return row + 1
        }
        return row
    }

    // Issue #3883: whether <paramref name="c"/> is the class that declares the
    // authored async `Main`, and therefore owns the synthesized `<Main>$`
    // entry-point stub's MethodDef row.
    private func ClassOwnsEntryPointStub(c StructSymbol) bool -> this.EntryPointNeedsSeparateStub &&
        this
        .emitCtx
        .Program
        .EntryPoint is {} entryPoint &&
        !c
        .StaticMethods
        .IsDefaultOrEmpty &&
        c
        .StaticMethods
        .Contains(entryPoint)

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
    private func RegisterNestedTypeEnclosingGenerics() {
        // Snapshot every type's ORIGINAL own type parameters before any
        // reification mutates them, so a DEEPER nested type collects its
        // enclosing types' ORIGINAL parameters (not the reified clones) no
        // matter the processing order.
        let originalOwnParams = Dictionary[StructSymbol, ImmutableArray[TypeParameterSymbol]](
            ReferenceEqualityComparer.Instance
        )
        for s in this.emitCtx.Program.Structs {
            let def = s.Definition ?? s
            if !originalOwnParams.ContainsKey(def) {
                originalOwnParams[def] = def.TypeParameters
            }
        }
        for s in this.emitCtx.Program.Structs {
            if !(s.ContainingType is StructSymbol) {
                continue
            }
            let enclosing = CollectOriginalEnclosingTypeParameters(s, originalOwnParams)
            if enclosing.IsDefaultOrEmpty {
                continue
            }
            let def = s.Definition ?? s
            if def.HasCompleteReifiedTypeParameterVector {
                // Synthesized helpers explicitly seeded with the complete
                // enclosing-plus-own parameter vector need only the split.
                this.remaps.SetNestedTypeEnclosingArity(def, enclosing.Length)
                continue
            }
            let own = if originalOwnParams.TryGetValue(def, out var snapshot) {
                snapshot
            } else {
                def.TypeParameters
            }
            let combined = ImmutableArray.CreateBuilder[TypeParameterSymbol](
                enclosing.Length +
                    (
                    if own.IsDefaultOrEmpty {
                        0
                    } else {
                        own.Length
                    }
                )
            )
            combined.AddRange(enclosing)
            if !own.IsDefaultOrEmpty {
                combined.AddRange(own)
            }
            let combinedList = combined.ToImmutable()
            // Issue #1499: remap self-/cross-referential constraints onto the
            // nested type's cloned combined-parameter set.
            s.SetTypeParameters(SynthesizedClosureReifier.CloneWithRemappedConstraints(combinedList))
            // Record the enclosing arity so a use site can split its combined
            // type-argument vector into enclosing/own halves.
            this.remaps.SetNestedTypeEnclosingArity(def, enclosing.Length)
            // Build the original-parameter -> reified-slot remap so member
            // signatures/bodies encode the correct VAR(idx). An enclosing
            // parameter of a single generic level keeps its ordinal (remap is a
            // no-op then); a re-ordinalized own parameter or an enclosing
            // parameter of a DEEPER level (whose ordinals collide) is translated.
            let remap = Dictionary[TypeParameterSymbol, int32](combinedList.Length)
            for var i = 0; i < combinedList.Length; i++ {
                remap[combinedList[i]] = i
            }
            this.remaps.RegisterClassRemap(s, remap)
        }
        for e in this.emitCtx.Program.Enums {
            if !(e.ContainingType is StructSymbol) {
                continue
            }
            let enclosing = CollectOriginalEnclosingTypeParameters(e, originalOwnParams)
            if !enclosing.IsDefaultOrEmpty {
                e.SetTypeParameters(SynthesizedClosureReifier.CloneWithRemappedConstraints(enclosing))
            }
        }
    }

    // Issue #1477: builds the outer-TP → own-TP-ordinal remap for every
    // synthesized closure / capture-box class that was reified generic over its
    // enclosing type parameters (SynthesizedClosureReifier records the original
    // referenced parameters on ReifiedFromTypeParameters in declaration order,
    // 1:1 with the class's own freshly cloned parameters). Registering the
    // remap on the shared state-machine remap channel makes EncodeTypeSymbol
    // translate every enclosing-type-parameter reference in a capture field /
    // Invoke signature into the synthesized class's own VAR(idx) slot.
    private func RegisterSynthesizedClosureReifiedGenerics() {
        let Register = func (s StructSymbol) {
            let origTPs = s.ReifiedFromTypeParameters
            if origTPs.IsDefaultOrEmpty {
                return
            }
            let remap = Dictionary[TypeParameterSymbol, int32](origTPs.Length)
            let offset = s.ReifiedTypeParameterOrdinalOffset
            for var i = 0; i < origTPs.Length; i++ {
                remap[origTPs[i]] = offset + i
            }
            this.remaps.RegisterClassRemap(s, remap)
        }
        for s in this.emitCtx.Program.Structs {
            Register(s)
        }
        for s in this.closures.SynthesizedClosureClasses {
            Register(s)
        }
    }

    /// Issue #2123: eagerly resolves the interface-constraint handles of the
    /// `GenericParam` rows added for a synthesized closure / capture-box /
    /// reified class since [`gpRowStart`](paramref), while that class's
    /// enclosing-TP → own-`VAR(idx)` remap
    /// ((cref:GenericRemapState.ActiveIteratorStateMachineRemap)) is still active.
    /// @remarks A class reified generic over its enclosing type parameters
    /// ((cref:SynthesizedClosureReifier.Reify)) carries type-parameter
    /// constraints that still textually reference the ORIGINAL enclosing type
    /// parameters: (cref:SynthesizedClosureReifier.CloneWithRemappedConstraints)
    /// cannot rewrite an imported constructed-generic constraint such as
    /// `IComparable[T]` (its (cref:ImportedTypeSymbol) substitution
    /// leaves the original symbolic argument in place). The deferred
    /// `GenericParamConstraint` rows would otherwise be resolved at flush
    /// time — after the remap is gone — encoding the enclosing METHOD type
    /// parameter as `!!0` (MVar) instead of this class's own `!0`
    /// (Var). That mismatch makes the class's constraint unsatisfiable, so the
    /// `constrained.` interface call inside a capturing lambda's
    /// display-class `Invoke` fails verification
    /// (`StackUnexpected`). Resolving here, with the remap active, encodes
    /// the class's own `Var` slot. Mirrors the #2118 non-capturing method
    /// path (which resolves against (cref:GenericRemapState.ActiveLambdaMethodTypeParamRemap)).
    /// No-op when no reified-class remap is active (unregistered class).
    /// @param gpRowStart The `PendingGenericParameters` count captured before the class's TypeDef was
    /// emitted.
    private func PreResolveReifiedGenericConstraints(gpRowStart int32) {
        if this.remaps.ActiveIteratorStateMachineRemap == nil {
            return
        }
        let pendingRows = this.emitCtx.PendingGenericParameters
        for var gi = gpRowStart; gi < pendingRows.Count; gi++ {
            let gpRow = pendingRows[gi]
            if gpRow.InterfaceConstraintType != nil && gpRow.PreResolvedConstraintHandle == nil {
                pendingRows[gi] = gpRow with{
                    PreResolvedConstraintHandle = this.memberRefs.GetElementTypeToken(gpRow.InterfaceConstraintType)
                }
            }
        }
    }

    private init(
        program BoundProgram?,
        references ReferenceResolver?,
        assemblyName string?,
        metadataOnly bool,
        embeddedResources IReadOnlyList[(Name string, Data[]uint8, IsPublic bool)]?
    ) {
        this.emitCtx = EmitContext(program!!, references, assemblyName, metadataOnly)
        this.utf8Data = Utf8LiteralData(program!!, metadataOnly)
        this.embeddedResources = embeddedResources
        this.moduleInitializers = if program == nil {
            ImmutableArray[FunctionSymbol].Empty
        } else {
            program
                .Functions
                .Keys
                .Where(IsModuleInitializer)
                .OrderBy((function FunctionSymbol) -> function, SymbolSourceOrderComparer.Instance)
                .ToImmutableArray()
        }
        this.cache = MetadataTokenCache()
        this.remaps = GenericRemapState()
        this.signatures = SignatureEncoder(this)
        this.memberRefs = ImportedMemberRefFactory(this)
        this.userTokens = UserTokenResolver(this)
        this.functions = FunctionEmitter(this)
        this.slotPlanner = SlotPlanner(this.emitCtx, this.cache, this.NeedsRvalueReceiverSpill)
        // The dozen PR-E-* sub-emitters below form one dependency chain over
        // the state above and nothing else -- no sub-emitter constructor reads
        // an option the factory sets after construction. Wiring them here
        // rather than at the top of EmitCore makes each field definitely
        // assigned, which is what lets them stay non-nullable.
        this.ResolveCoreTypesAndWireEmitters()
    }

    // Phase records retain the original mutable collection instances so row
    // planning and emission share the same handles, counters, and ordering.
    private data struct GeneratedTypeSet(
        LambdaLiterals List[BoundFunctionLiteralExpression],
        AllAggregates ImmutableArray[StructSymbol],
        AsyncStateMachineStructs List[StructSymbol],
        AsyncStateMachinePlansByStruct Dictionary[StructSymbol, AsyncStateMachinePlan]
    ) : IEquatable[GeneratedTypeSet] { }

    private data struct NestedTypeOrder(
        Types List[TypeSymbol],
        FirstFieldRows Dictionary[TypeSymbol, int32],
        FirstMethodRows Dictionary[TypeSymbol, int32]
    ) : IEquatable[NestedTypeOrder] { }

    private data struct AggregatePartitions(
        NonStateMachineClasses List[StructSymbol],
        StateMachineClasses List[StructSymbol],
        NonStateMachineStructs List[StructSymbol],
        StateMachineStructs List[StructSymbol]
    ) : IEquatable[AggregatePartitions] { }

    private data struct TopLevelTypeOrder(
        Interfaces List[InterfaceSymbol],
        Classes List[StructSymbol],
        Structs List[StructSymbol],
        Enums List[EnumSymbol]
    ) : IEquatable[TopLevelTypeOrder] { }

    private data struct AggregateTypeLayout(
        Aggregates AggregatePartitions,
        TopLevel TopLevelTypeOrder,
        AllEnums ImmutableArray[EnumSymbol],
        NestedTypes NestedTypeOrder
    ) : IEquatable[AggregateTypeLayout] { }

    private data struct FieldRowPlan(
        InterfaceFirstRows Dictionary[InterfaceSymbol, int32],
        AggregateFirstRows Dictionary[StructSymbol, int32],
        EnumFirstRows Dictionary[EnumSymbol, int32],
        Globals ImmutableArray[GlobalVariableSymbol],
        ProgramFirstRow int32,
        ModuleFirstRow int32
    ) : IEquatable[FieldRowPlan] { }

    private data struct TypeMethodRows(
        InterfaceFirstRows Dictionary[InterfaceSymbol, int32],
        DelegateConstructorRows Dictionary[DelegateTypeSymbol, int32],
        ClassConstructorRows Dictionary[StructSymbol, int32],
        ClassPrimaryConstructorRows Dictionary[StructSymbol, int32],
        AggregateMethodHandles Dictionary[FunctionSymbol, MethodDefinitionHandle],
        StructFirstRows Dictionary[StructSymbol, int32]
    ) : IEquatable[TypeMethodRows] { }

    private data struct MethodRowPlan(
        Delegates ImmutableArray[DelegateTypeSymbol],
        TypeRows TypeMethodRows,
        EntryPointIsClassOwned bool,
        FirstNestedRow int32,
        FirstPackageConstructorRow int32
    ) : IEquatable[MethodRowPlan] { }

    private data struct PackageMethodPlan(
        Packages ImmutableArray[PackageSymbol],
        FunctionsByPackage Dictionary[PackageSymbol, List[FunctionSymbol]],
        EntryPointPackage PackageSymbol?,
        ConstructorRows Dictionary[PackageSymbol, int32],
        EntryPointHandle MethodDefinitionHandle
    ) : IEquatable[PackageMethodPlan] { }

    private data struct DebugArtifacts(
        PdbBlob BlobBuilder?,
        DebugDirectory DebugDirectoryBuilder?,
        IsEmbedded bool
    ) : IEquatable[DebugArtifacts] { }

    private func EmitCore(
        peStream Stream,
        asyncRewriteResult AsyncStateMachineRewriteResult? = nil,
        iteratorRewriteResult IteratorRewriteResult? = nil,
        asyncIteratorRewriteResult AsyncIteratorRewriteResult? = nil
    ) {
        using let planningPhase = CompilationMeasurements.BeginPhase("emit.planning")
        this.InitializePortablePdb()
        this.RegisterRewriteResults(asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult)
        let lambdaLiterals = this.SynthesizeClosuresAndStateMachines()
        this.RegisterGeneratedGenericRemaps()
        let generatedTypes = this.MaterializeGeneratedTypes(lambdaLiterals)
        let aggregateTypes = this.DiscoverAndOrderAggregateTypes(generatedTypes)
        let fieldRows = this.PlanFieldRows(aggregateTypes)
        let methodRows = this.PlanMethodRows(aggregateTypes)
        let packageMethods = this.PlanPackageAndStateMachineMethods(generatedTypes, aggregateTypes, methodRows)
        planningPhase?.Dispose()
        this.functions.PrepareIndependentBodies(this.workBudget)
        this.EmitUserTypeDefinitionsAndEarlyMethods(aggregateTypes, fieldRows, methodRows)
        let programTypeDefinitions = this.EmitProgramAndStateMachineTypeDefinitions(
            aggregateTypes,
            fieldRows,
            methodRows,
            packageMethods
        )
        this.EmitRemainingMethodDefinitions(generatedTypes, aggregateTypes, methodRows, packageMethods)
        this.EmitNestedTypeRows(aggregateTypes, packageMethods, programTypeDefinitions)
        if this.utf8Data.HasData {
            this.utf8Data.Emit(
                this.emitCtx.Metadata,
                this.memberRefs.GetElementTypeToken(TypeSymbol.Object),
                this.memberRefs.GetElementTypeToken(
                    TypeSymbol.FromClrTypeWithoutNullability(
                        this.emitCtx.CoreValueType,
                        NullabilityFreeReason.ResolvedTypeName
                    )
                )
            )
        }
        let mvidFixup = this.EmitModuleAndAssemblyRows()
        let debugArtifacts = this.BuildPortablePdbAndDebugDirectory(packageMethods.EntryPointHandle)
        this.SerializePeAndWriteOutputs(peStream, packageMethods.EntryPointHandle, mvidFixup, debugArtifacts)
    }

    private func InitializePortablePdb() {
        // Phase 4 (ADR-0027 §7.7a): instantiate the Portable PDB collaborator
        // before any method body is emitted, but only when the caller asked
        // for portable PDBs or for embedded PDBs (Phase 7). Sidecar emission
        // additionally requires a destination stream; embedded emission does
        // not because the blob is written into the PE itself. Leaving
        // `this.emitCtx.Pdb` null in every other configuration is what keeps the
        // legacy emit path bit-for-bit identical.
        let format = this.emitCtx.DebugInformation.Format
        let needsPdb = (format == DebugInformationFormat.Portable && this.emitCtx.PdbStream != nil) ||
            format == DebugInformationFormat.Embedded
        if needsPdb {
            this.emitCtx.Pdb = PortablePdbEmitter(this.emitCtx.DebugInformation)
            // #217: Wire per-file import information so the PDB emitter can
            // produce per-tree ImportScope rows. Group only the explicit
            // (user-written) imports — implicit ones have a null Declaration
            // and therefore no syntax-tree anchor.
            let importsGrouped = Dictionary[SyntaxTree, ImmutableArray[ImportSymbol]]()
            for import_ in this.emitCtx.Program.Imports {
                let tree SyntaxTree? = import_.Declaration?.SyntaxTree
                if tree == nil {
                    continue
                }
                if !importsGrouped.TryGetValue(tree, out var list) {
                    list = ImmutableArray[ImportSymbol].Empty
                }
                importsGrouped[tree] = list.Add(import_)
            }
            this.emitCtx.Pdb!!.SetImportsPerTree(importsGrouped)
            // Wire per-reference metadata so the PDB emitter can produce the
            // CompilationMetadataReferences CDI blob (issue #219).
            this.emitCtx.Pdb!!.SetReferenceInfos(this.emitCtx.References.GetReferenceInfos())
        }
    }

    @MemberNotNull(
        "wellKnown",
        "customAttrEncoder",
        "assemblyAttrs",
        "interfaceImpls",
        "conversionEmitter",
        "dataStructSynth",
        "ctorBodies",
        "memberDefEmitter",
        "typeDefEmitter",
        "closures",
        "stateMachines",
        "methodBodyPlanner"
    )
    private func ResolveCoreTypesAndWireEmitters() {
        // Issue #2373: needed to materialise a runtime MethodInfo for a CLR
        // operator method (op_Equality, op_Addition, ...) passed as an
        // Expression factory argument (Expression.Equal(l, r, liftToNull,
        // method), Expression.Add(l, r, method), ...) — see
        // WellKnownReferences.GetMethodFromHandleReference /
        // GetMethodFromHandleWithDeclaringTypeReference.
        // ADR-0059 / issue #255: cache the base type and `IntPtr` parameter
        // type for user-declared named delegate emission.
        // PR-E-3: WellKnownReferences depends on EmitContext.Core* and on the
        // dedup-cached GetTypeReference / GetMethodReference resolvers that
        // still live on this emitter. Its ctor eagerly resolves the three
        // refs the rest of EmitCore needs immediately (Object/ValueType
        // TypeRefs, Object..ctor MemberRef); every other well-known ref is
        // lazily materialised on first access via its paired Get* method.
        this.wellKnown = WellKnownReferences(
            this.emitCtx,
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetMethodReference,
            this.cache
        )
        // PR-E-12: CustomAttributeEncoder depends on GetTypeReference (the
        // dedup-cached root resolver) and wellKnown's GetIsReadOnlyAttributeCtorRef.
        // It owns every custom-attribute blob-encoding helper; the assembly-
        // level orchestrators on this root forward into it.
        this.customAttrEncoder = CustomAttributeEncoder(
            this.emitCtx,
            this.wellKnown,
            this.memberRefs.GetTypeReference,
            this.userTokens.ResolveUserCtorTokenForPrimary,
            this.userTokens.ResolveUserCtorTokenForDefault,
            this.userTokens.ResolveUserCtorTokenForExplicit
        )
        // PR-E-13: AssemblyAttributeEmitter owns the assembly-level attribute
        // orchestrators and ParseAssemblyVersion. It wires up after
        // customAttrEncoder because it forwards the string/pair/bound blob
        // writes into that encoder; GetTypeReference is threaded as a delegate
        // (same pattern as the encoder itself) so it needs no back-reference
        // to this emitter.
        this.assemblyAttrs = AssemblyAttributeEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.customAttrEncoder,
            this.memberRefs.GetTypeReference
        )
        // PR-E-14: InterfaceImplEmitter owns the explicit-interface and
        // static-virtual MethodImpl-row emitters. Back-bound to this root
        // (the MethodBodyEmitter idiom) because its token resolution runs
        // through GetMethodReference / ResolveUserInterfaceInstanceMethodToken,
        // which stay on the root; it reads emitCtx/cache directly off the
        // back-reference in its ctor.
        this.interfaceImpls = InterfaceImplEmitter(this)
        // PR-E-15: ConstructorBodyEmitter owns the constructor-body-bytes band.
        // Back-bound to this root (the MethodBodyEmitter idiom) because the
        // bodies construct the still-private MethodBodyEmitSession scaffold and
        // resolve field tokens via ResolveFieldToken; it reads emitCtx/cache
        // directly off the back-reference in its ctor. The interface-.cctor
        // MethodDef's parameter-list anchor comes in through the
        // NextParameterHandle callback (the same method-group TypeDefEmitter
        // receives). Wired after customAttrEncoder for that callback.
        this.ctorBodies = ConstructorBodyEmitter(this, this.customAttrEncoder.NextParameterHandle)
        // PR-E-12: MethodBodyPlanner owns the per-body planning orchestrators
        // (CollectLocalsAndLabels and friends) that drive SlotPlanner's
        // collector classes. It needs GetTypeReference / GetTypeHandleForMember
        // for AddIteratorInterfaceImplementations, so it wires up after
        // wellKnown is materialised. StateMachineEmitter is back-bound via
        // SetStateMachines once stateMachines exists below.
        this.methodBodyPlanner = MethodBodyPlanner(
            this.emitCtx,
            this.cache,
            this.slotPlanner,
            this.lambdaBodies,
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetTypeHandleForMember,
            this.signatures.EncodeTypeSymbol
        )
        // PR-E-5: now that wellKnown is materialised, wire ConversionEmitter.
        // GetElementTypeToken is passed as a delegate (same pattern as
        // SlotPlanner's needsRvalueReceiverSpill) so the new component does
        // not need a hard back-reference to this emitter.
        this.conversionEmitter = ConversionEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.memberRefs.GetElementTypeToken
        )
        // PR-E-7: MemberDefEmitter wires up after ConversionEmitter.
        // It depends on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio and threads delegate callbacks for the five root-emitter
        // helpers it uses (EmitFunction, EncodeTypeSymbol, NextParameterHandle,
        // GetTypeReference, GetTypeHandleForMember) — same composition pattern
        // as DataStructSynthesizer / ConversionEmitter / SlotPlanner. No hard
        // back-reference to this emitter.
        this.memberDefEmitter = MemberDefEmitter(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            (fn FunctionSymbol, fnBody BoundBlockStatement, fnIsEntryPoint bool) -> this.functions.EmitFunction(
                fn,
                fnBody,
                fnIsEntryPoint
            ),
            this.signatures.EncodeTypeSymbol,
            this.customAttrEncoder.NextParameterHandle,
            this.memberRefs.GetTypeReference,
            this.memberRefs.GetTypeHandleForMember,
            (owner StructSymbol, field FieldSymbol) -> this.userTokens.ResolveFieldToken(owner, field),
            this.customAttrEncoder.EmitNullableAttributeOnProperty,
            this.customAttrEncoder.EmitNullableAttributeOnEvent,
            this.customAttrEncoder.EmitMethodNullability,
            this.customAttrEncoder.EmitTupleElementNamesAttribute,
            this.customAttrEncoder.EmitUserAttributes,
            (handle EntityHandle) -> this.customAttrEncoder.EmitStringAttribute(
                handle,
                "System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute",
                typeof(System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute),
                NativeProtocolMetadata.FeatureName
            )
        )
        // PR-E-8: TypeDefEmitter wires up after MemberDefEmitter. It depends
        // on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio. The body-emission step inside the three constructor methods
        // that drive BodyEmitter (EmitStaticConstructor,
        // EmitClassConstructorWithBaseInitializer, EmitClassConstructorWithBody)
        // is routed through three injected Func callbacks bound to the
        // *BodyBytes helper methods on this emitter so TypeDefEmitter never
        // holds a hard reference to this root or to BodyEmitter — same
        // composition pattern as MemberDefEmitter / DataStructSynthesizer.
        this.typeDefEmitter = TypeDefEmitter(
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
            (handle TypeDefinitionHandle) -> this.customAttrEncoder.EmitNullableContextAttributeOnType(
                handle,
                NullableFlagsBuilder.NotAnnotated
            ),
            this.customAttrEncoder.EmitNullableAttributeOnField,
            this.customAttrEncoder.EmitMethodNullability,
            (paramHandle ParameterHandle, paramType TypeSymbol) -> this
                .customAttrEncoder
                .EmitTupleElementNamesAttribute(paramHandle, paramType),
            this.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter,
            this.customAttrEncoder.EmitParamArrayAttributeOnParameter,
            this.customAttrEncoder.EmitParamCollectionAttributeOnParameter,
            this.memberRefs.GetCtorReference,
            (ctor ConstructorInfo, containingType TypeSymbol?) -> this.memberRefs.GetCtorReference(
                ctor,
                containingType
            ),
            this.ctorBodies.EmitStaticConstructorBodyBytes,
            this.ctorBodies.EmitClassDefaultConstructorBodyBytes,
            this.ctorBodies.EmitValueStructDefaultConstructorBodyBytes,
            this.ctorBodies.EmitClassPrimaryConstructorBodyBytes,
            this.ctorBodies.EmitClassConstructorWithBaseInitializerBodyBytes,
            this.ctorBodies.EmitClassConstructorWithBodyBodyBytes,
            this.ctorBodies.EmitClassDeinitializerBodyBytes
        )
        // Data structs reuse the owning initializer constructor rather than
        // emitting a second constructor with the same primary signature.
        this.dataStructSynth = DataStructSynthesizer(
            this.emitCtx,
            this.cache,
            this.wellKnown,
            this.conversionEmitter,
            this.ctorBodies.EmitDataStructPrimaryConstructorBodyBytes,
            this.signatures.EncodeTypeSymbol,
            this.memberRefs.GetElementTypeToken,
            this.memberRefs.GetTypeReference,
            this.customAttrEncoder.NextParameterHandle,
            this.typeDefEmitter.AddPrimaryCtorParameters,
            this.userTokens.ResolveUserTypeToken,
            (owner StructSymbol, field FieldSymbol) -> this.userTokens.ResolveFieldToken(owner, field),
            this.userTokens.GetUserStructMethodRef,
            (method MethodInfo, containingType TypeSymbol) -> this.memberRefs.GetMethodEntityHandle(
                method,
                containingType
            ),
            this.userTokens.ResolveUserInstanceMethodToken,
            this.customAttrEncoder.EmitMethodNullability,
            this.memberRefs.GetCtorReference,
            this.userTokens.ResolveUserPropertyAccessorToken
        )
        // PR-E-9: ClosureEmitter wires up after TypeDefEmitter. It depends
        // on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio plus the SlotPlanner (for go-statement capture discovery)
        // and a shared reference to this.lambdaBodies so the synthesis
        // path can register the rewritten lambda-body for every
        // closure-Invoke method without taking a hard back-reference to
        // this root emitter — same composition pattern as the other
        // PR-E-* components.
        this.closures = ClosureEmitter(this.emitCtx, this.cache, this.wellKnown, this.slotPlanner, this.lambdaBodies)
        // PR-E-10: StateMachineEmitter wires up after ClosureEmitter. It
        // depends on the same EmitContext/MetadataTokenCache/WellKnownReferences
        // trio plus the ClosureEmitter (for the shared Counter +
        // SynthesizedClosureClasses) and a shared reference to
        // this.lambdaBodies. The BodyEmitter-driven portion of
        // EmitStateMachineMoveNext is reached via the
        // BuildMoveNextBodyBytes callback bound to the helper below — same
        // composition pattern as PR-E-8 TypeDefEmitter's three constructor
        // body-emit callbacks. No hard back-reference to this emitter.
        this.stateMachines = StateMachineEmitter(
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
            (owner StructSymbol, field FieldSymbol) -> this.userTokens.ResolveFieldToken(owner, field),
            this.functions.BuildMoveNextBodyBytes
        )
    }

    private func RegisterRewriteResults(
        asyncRewriteResult AsyncStateMachineRewriteResult?,
        iteratorRewriteResult IteratorRewriteResult?,
        asyncIteratorRewriteResult AsyncIteratorRewriteResult?
    ) {
        if asyncRewriteResult != nil {
            this.stateMachines.AsyncStateMachinePlans = asyncRewriteResult.StateMachines
        }
        if iteratorRewriteResult != nil {
            this.stateMachines.IteratorPlans = iteratorRewriteResult.Plans
        }
        if asyncIteratorRewriteResult != nil {
            this.stateMachines.AsyncIteratorPlans = asyncIteratorRewriteResult.Plans
        }
        // PR-E-12: late-bind stateMachines into the body planner so
        // TryGetUserKickoffReceiverHandle can consult AsyncStateMachinePlans.
        this.methodBodyPlanner.SetStateMachines(this.stateMachines)
    }

    private func SynthesizeClosuresAndStateMachines() List[BoundFunctionLiteralExpression] {
        using let planningPhase = CompilationMeasurements.BeginPhase("emit.discovery")
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
        let lambdaLiterals = this.methodBodyPlanner.CollectFunctionLiterals()
        let goStatements = this.methodBodyPlanner.CollectGoStatements()
        let hostPackageGuess PackageSymbol? = this
            .emitCtx
            .Program
            .EntryPoint
            ?.Package ??
            this
            .emitCtx
            .Program
            .EntryPointPackage ??
            (
            if this.emitCtx.Program.Packages.IsDefaultOrEmpty {
                default(PackageSymbol?)
            } else {
                this.emitCtx.Program.Packages[0]
            }
        )
        // A program with no package at all has no syntax tree either -- the
        // binder puts every tree in one, defaulting to "Default" -- so it
        // declares no literal, go statement or iterator for the synthesis
        // steps to host, and each was already a no-op for it. Guarding here
        // keeps that case working rather than asserting a host package that
        // cannot exist.
        if hostPackageGuess != nil {
            this.closures.SynthesizeClosures(lambdaLiterals, hostPackageGuess)
        }
        // Lower non-capturing literals once so iterator plans and emitted bodies
        // share the same synthesized local symbols.
        let zeroCaptureLiterals = List[BoundFunctionLiteralExpression]()
        for literal in lambdaLiterals {
            if literal.CapturedVariables.Length == 0 && !this.closures.ClosureInfos.ContainsKey(literal) {
                zeroCaptureLiterals.Add(literal)
            }
        }
        using let loweringPhase = CompilationMeasurements.BeginPhase("lowering.emit-lambdas")
        let localJobs = List[int32]()
        let bodies = [zeroCaptureLiterals.Count]BoundBlockStatement?
        var largestBody int64 = 0
        for var index = 0; index < zeroCaptureLiterals.Count; index++ {
            let literal = zeroCaptureLiterals[index]
            if literal.Function.TypeParameters.IsDefaultOrEmpty && IndependentMethodBody.IsLocal(literal.Body) {
                if this.emitCtx.MetadataOnly {
                    bodies[index] = literal.Body
                    CompilationMeasurements.Count("emit.reference.lambda-lowering-skipped")
                } else {
                    localJobs.Add(index)
                    largestBody = Math.Max(
                        largestBody,
                        literal.Syntax?.Span.Length ?? literal.Body.Syntax?.Span.Length ?? 0
                    )
                }
            } else {
                bodies[index] = Lowerer.Lower(literal.Body)
            }
        }
        this.workBudget.Run(
            localJobs.Count,
            (index int32) -> {
                let slot = localJobs[index]
                bodies[slot] = Lowerer.Lower(zeroCaptureLiterals[slot].Body)
            },
            workspaceBytes: Math.Max(100663296, largestBody * 128),
            allowParallel: localJobs.Count >= 8 || largestBody >= 8192
        )
        CompilationMeasurements.Count("lowering.emit-lambdas.completed", localJobs.Count)
        CompilationMeasurements.Count("lowering.emit-lambdas.observed-workers", this.workBudget.LastObservedWorkers)
        if this.workBudget.LastObservedWorkers > 1 {
            CompilationMeasurements.Count("lowering.emit-lambdas.parallel-batches")
        }
        for var index = 0; index < zeroCaptureLiterals.Count; index++ {
            this.lambdaBodies[zeroCaptureLiterals[index].Function] = Invariant.Required(
                bodies[index],
                "joined lowering produced its body"
            )
        }
        loweringPhase?.Dispose()
        // Issue #4223: promoting a callee to carry extra enclosing type
        // parameters (UserTokenResolver.TryPromoteNonCapturingGenericLambda)
        // can in turn require its CALLER — another zero-capture local
        // function in this same pass — to also carry them, purely so its own
        // call site has something to supply (LambdaEnclosingTypeParameterCollector
        // discovers this via UserTokenResolver.GetPromotedExtras). A single
        // forward pass over `zeroCaptureLiterals` therefore depends on
        // declaration order — a caller processed before its (later-declared)
        // callee would miss the requirement entirely. Iterate to a fixed
        // point instead: keep re-running the promotion over every literal
        // until a full pass promotes nothing further.
        var promotedAnyThisPass bool
        do {
            promotedAnyThisPass = false
            for literal in zeroCaptureLiterals {
                let beforeCount = literal.Function.TypeParameters.Length
                this.userTokens.TryPromoteNonCapturingGenericLambda(literal, this.lambdaBodies[literal.Function])
                if literal.Function.TypeParameters.Length != beforeCount {
                    promotedAnyThisPass = true
                }
            }
        } while promotedAnyThisPass
        this.RetargetIteratorPlans(lambdaLiterals)
        if hostPackageGuess != nil {
            this.closures.SynthesizeGoClosures(goStatements, hostPackageGuess)
            this.stateMachines.SynthesizeIteratorStateMachines(hostPackageGuess)
            this.stateMachines.SynthesizeAsyncIteratorStateMachines(hostPackageGuess)
            this.stateMachines.SynthesizeAsyncLambdaStateMachines(lambdaLiterals, hostPackageGuess)
        }
        return lambdaLiterals
    }

    private func RetargetIteratorPlans(lambdaLiterals List[BoundFunctionLiteralExpression]) {
        if this.stateMachines.IteratorPlans.IsDefaultOrEmpty {
            return
        }
        let plans = this.stateMachines.IteratorPlans.ToBuilder()
        for literal in lambdaLiterals {
            var function = literal.Function
            if this.closures.ClosureInfos.TryGetValue(literal, out var closure) {
                function = closure.InvokeMethod
            }
            for var i = 0; i < plans.Count; i++ {
                if !object.ReferenceEquals(plans[i].Function, literal.Function) {
                    continue
                }
                let body = this.lambdaBodies[function]
                if IteratorRewriter.TryBuildPlan(function, body, out var plan) {
                    plans[i] = plan
                }
                break
            }
        }
        this.stateMachines.IteratorPlans = plans.ToImmutable()
    }

    private func RegisterGeneratedGenericRemaps() {
        // Issue #810: register per-SM-class outer-method TP → class-TP-ordinal
        // remaps so that EncodeTypeSymbol can auto-translate outer-method
        // type-parameter references into the SM's own class type-parameter
        // slots when emitting field signatures and method signatures for
        // generic iterator state-machine classes.
        for kvp in this.stateMachines.IteratorStateMachineInfos {
            var remap Dictionary[TypeParameterSymbol, int32]? = kvp.Value.BuildRemap()
            if this.remaps.TryGetLambdaMethodRemap(kvp.Value.Plan.Function, out var lambdaRemap) {
                remap ??= Dictionary[TypeParameterSymbol, int32]()
                let offset = kvp.Value.SourceTypeParameters.Length - kvp.Value.Plan.Function.TypeParameters.Length
                for pair in lambdaRemap!! {
                    remap!![pair.Key] = offset + pair.Value
                }
            }
            if remap != nil {
                this.remaps.RegisterClassRemap(kvp.Key, remap)
            }
        }
        // Issue #1489: same registration for GENERIC async-iterator SM classes
        // so their field / method / interface signatures translate the kickoff
        // method's type-parameter references (MVar) into the SM class's own
        // class-type-parameter slots (Var) during emit.
        for kvp in this.stateMachines.AsyncIteratorStateMachineGenericInfos {
            let remap Dictionary[TypeParameterSymbol, int32]? = kvp.Value.BuildRemap()
            if remap != nil {
                this.remaps.RegisterClassRemap(kvp.Key, remap)
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
        this.RegisterNestedTypeEnclosingGenerics()
        // Issue #1477: register the outer-TP → own-TP-ordinal remap for each
        // synthesized closure / capture-box class that was reified generic over
        // its enclosing type parameters (recorded on
        // ReifiedFromTypeParameters). This reuses the state-machine remap
        // channel so EncodeTypeSymbol routes every capture-field / Invoke
        // signature through a valid VAR(idx) slot of the synthesized class.
        this.RegisterSynthesizedClosureReifiedGenerics()
    }

    private func MaterializeGeneratedTypes(lambdaLiterals List[BoundFunctionLiteralExpression]) GeneratedTypeSet {
        // Phase 3.B.4: user-defined interface TypeDefs (planned below).
        // Synthesized closure classes are appended after user aggregates so
        // their TypeDefs come last among the class block; field-row planning
        // walks the combined list so closure fields get well-defined rows.
        var allAggregates = this.emitCtx.Program.Structs
        if this.closures.SynthesizedClosureClasses.Count > 0 {
            allAggregates = allAggregates.AddRange(this.closures.SynthesizedClosureClasses)
        }
        // Async state-machine types: materialized structs with their hoisted
        // fields are appended so they get TypeDef + FieldDef rows alongside
        // user structs. Method rows (MoveNext, SetStateMachine) are planned
        // separately below.
        let asyncSmStructs = List[StructSymbol]()
        let asyncSmPlansByStruct = Dictionary[StructSymbol, AsyncStateMachinePlan]()
        for plan in this.stateMachines.AsyncStateMachinePlans {
            let smStruct = plan.StateMachine.MaterializeAsStructSymbol()
            // Issue #1465: when the async kickoff method lives inside a
            // generic type (or is itself a generic method), the synthesized
            // state-machine type must be reified over an ordinal-aligned copy
            // of the enclosing type's (and the method's) type parameters —
            // mirroring Roslyn's `<M>d__0<T>`. Without this the hoisted
            // `<>4__this` field, the `this`-proxy, and the self-call targets
            // inside MoveNext reference the class's `!0` from a non-generic
            // SM context, producing unverifiable IL.
            this.RegisterStateMachineEnclosingGenerics(smStruct, plan.StateMachine.KickoffMethod)
            asyncSmStructs.Add(smStruct)
            asyncSmPlansByStruct[smStruct] = plan
        }
        if asyncSmStructs.Count > 0 {
            allAggregates = allAggregates.AddRange(asyncSmStructs)
        }
        return GeneratedTypeSet(lambdaLiterals, allAggregates, asyncSmStructs, asyncSmPlansByStruct)
    }

    private func DiscoverAndOrderAggregateTypes(generatedTypes GeneratedTypeSet) AggregateTypeLayout {
        let allAggregates = generatedTypes.AllAggregates
        let asyncSmStructs = generatedTypes.AsyncStateMachineStructs
        // Separate state-machine types from non-SM types. SM types will be
        // nested inside their declaring type (<Program> or closure class) per
        // Roslyn convention. To satisfy ECMA-335 §II.22.32 (enclosing row <
        // nested row), <Program> TypeDefs must precede SM TypeDefs.
        let smClassSet = HashSet[StructSymbol](
            this.stateMachines.IteratorStateMachineInfos.Keys.Concat(this.stateMachines.AsyncIteratorInfos.Keys)
        )
        let smStructSet = HashSet[StructSymbol](asyncSmStructs)
        let nonSmClasses = List[StructSymbol]()
        let smClasses = List[StructSymbol]()
        let nonSmStructs = List[StructSymbol]()
        let smStructsOrdered = List[StructSymbol]()
        for s in allAggregates {
            if s.IsClass {
                if smClassSet.Contains(s) {
                    smClasses.Add(s)
                } else {
                    nonSmClasses.Add(s)
                }
            } else {
                if smStructSet.Contains(s) {
                    smStructsOrdered.Add(s)
                } else {
                    nonSmStructs.Add(s)
                }
            }
        }
        let interfaces = this.emitCtx.Program.Interfaces
        let enumsAll = this.emitCtx.Program.Enums
        // Issue #910 / ADR-0110: split user-declared NESTED types (their
        // ContainingType is set by BindNestedTypeDeclarations) from top-level
        // ones. Top-level types keep their historical kind-partitioned emission
        // order (so non-nested programs are byte-identical). Every nested type
        // — regardless of kind/encloser combination — is emitted in a single
        // unified pre-order block AFTER all top-level types so that each
        // enclosing TypeDef row always precedes its nested rows, satisfying
        // ECMA-335 §II.22.32 for every combination (including nested interfaces
        // and class-in-struct, which no fixed kind partition can order).
        // Lexically hosted closures also participate in this order; other
        // closure/state-machine types have their nesting handled separately.
        let IsUserNested = func (t TypeSymbol) bool {
            return switch t {
                case ss is StructSymbol: ss.ContainingType != nil
                case es is EnumSymbol: es.ContainingType != nil
                case ifs is InterfaceSymbol: ifs.ContainingType != nil
                default: false
            }
        }
        let ContainingOf = func (t TypeSymbol) TypeSymbol? {
            return switch t {
                case ss is StructSymbol: ss.ContainingType
                case es is EnumSymbol: es.ContainingType
                case ifs is InterfaceSymbol: ifs.ContainingType
                default: default(TypeSymbol?)
            }
        }
        let topInterfaces = interfaces.Where((i InterfaceSymbol) -> !IsUserNested(i)).ToList()
        let topClasses = nonSmClasses.Where((c StructSymbol) -> !IsUserNested(c)).ToList()
        let topStructs = nonSmStructs.Where((s StructSymbol) -> !IsUserNested(s)).ToList()
        let topEnums = enumsAll.Where((e EnumSymbol) -> !IsUserNested(e)).ToList()
        // Build the unified nested-type pre-order: each enclosing type is
        // followed by its nested children (recursively), with siblings ordered
        // interface → class → struct → enum so an implementer is emitted after
        // any sibling interface it implements (mirrors the global "interfaces
        // first" convention used for top-level types).
        let nestedChildrenByParent = Dictionary[TypeSymbol, List[TypeSymbol]]()
        let RegisterNestedChild = func (child TypeSymbol) {
            let parent TypeSymbol? = ContainingOf(child)
            if parent == nil {
                return
            }
            if !nestedChildrenByParent.TryGetValue(parent, out var list) {
                list = List[TypeSymbol]()
                nestedChildrenByParent[parent] = list
            }
            list.Add(child)
        }
        for i in interfaces.Where(IsUserNested) {
            RegisterNestedChild(i)
        }
        for c in nonSmClasses.Where(IsUserNested) {
            RegisterNestedChild(c)
        }
        for s in nonSmStructs.Where(IsUserNested) {
            RegisterNestedChild(s)
        }
        for e in enumsAll.Where(IsUserNested) {
            RegisterNestedChild(e)
        }
        let nestedOrdered = List[TypeSymbol]()
        let VisitNested = func (parent TypeSymbol) {
            if !nestedChildrenByParent.TryGetValue(parent, out var children) {
                return
            }
            for child in children {
                nestedOrdered.Add(child)
                VisitNested(child)
            }
        }
        for i in topInterfaces {
            VisitNested(i)
        }
        for c in topClasses {
            VisitNested(c)
        }
        for s in topStructs {
            VisitNested(s)
        }
        for e in topEnums {
            VisitNested(e)
        }
        // Per-nested-type FieldList/MethodList boundary pointers, assigned in
        // nested pre-order so the monotone-non-decreasing TypeDef column
        // invariant holds across the nested block.
        let nestedFieldListRow = Dictionary[TypeSymbol, int32]()
        let nestedMethodListRow = Dictionary[TypeSymbol, int32]()
        return AggregateTypeLayout(
            AggregatePartitions(nonSmClasses, smClasses, nonSmStructs, smStructsOrdered),
            TopLevelTypeOrder(topInterfaces, topClasses, topStructs, topEnums),
            enumsAll,
            NestedTypeOrder(nestedOrdered, nestedFieldListRow, nestedMethodListRow)
        )
    }

    private func PlanFieldRows(aggregateTypes AggregateTypeLayout) FieldRowPlan {
        let smClasses = aggregateTypes.Aggregates.StateMachineClasses
        let smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs
        let topInterfaces = aggregateTypes.TopLevel.Interfaces
        let topClasses = aggregateTypes.TopLevel.Classes
        let topStructs = aggregateTypes.TopLevel.Structs
        let topEnums = aggregateTypes.TopLevel.Enums
        let enumsAll = aggregateTypes.AllEnums
        let nestedOrdered = aggregateTypes.NestedTypes.Types
        let nestedFieldListRow = aggregateTypes.NestedTypes.FirstFieldRows
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
        var nextFieldRow = 1
        let PlanField = func (field FieldSymbol) {
            this.cache.DeclaredFieldDefs[field] = MetadataTokens.FieldDefinitionHandle(nextFieldRow)
            nextFieldRow++
        }
        // ADR-0089 / issue #1030: interface static fields occupy the FIRST
        // FieldDef rows. Interface TypeDefs are emitted immediately after
        // <Module> and before every class/struct/enum TypeDef, so their field
        // rows must precede all aggregate field rows to keep the metadata
        // fieldList column monotone non-decreasing. const fields are emitted as
        // literal FieldDefs too, so both static and const fields are counted.
        let interfaceFirstFieldRow = Dictionary[InterfaceSymbol, int32]()
        for i in topInterfaces {
            interfaceFirstFieldRow[i] = nextFieldRow
            nextFieldRow += i.StaticFields.Length + i.ConstFields.Length
        }
        let structFirstFieldRow = Dictionary[StructSymbol, int32]()
        // Issue #910 / ADR-0110: field-row planning for one aggregate (class or
        // struct). Shared by the top-level field pass and the nested-type pass
        // so a nested aggregate's FieldDef range is assigned in the same order
        // its TypeDef row is emitted, preserving the monotone fieldList column.
        let PlanAggregateFields = func (s StructSymbol) {
            structFirstFieldRow[s] = nextFieldRow
            for field in s.Fields {
                PlanField(field)
            }
            // ADR-0051 Phase 6: backing fields for auto-properties.
            for p in s.Properties {
                if p.IsAutoProperty && p.BackingField != nil && !s.Fields.Contains(p.BackingField!!) {
                    PlanField(p.BackingField!!)
                }
            }
            // ADR-0052: backing fields for field-like events.
            for ev in s.Events {
                if ev.IsFieldLike && ev.BackingField != nil {
                    PlanField(ev.BackingField!!)
                }
            }
            // ADR-0053: static fields from shared block.
            for field in s.StaticFields {
                PlanField(field)
            }
            // Issue #948 / issue #1070: const fields are emitted as CLR literal
            // field rows (see TypeDefEmitter.EmitStructTypeDef), so they must be
            // counted here too. Omitting them under-reserved the FieldDef range
            // and shifted every following type's fieldList pointer by the const
            // count, leaking the last field of a const-bearing type onto the next
            // TypeDef (producing invalid IL such as `stsfld` of another type's
            // initonly field in a `.cctor`).
            for field in s.ConstFields {
                PlanField(field)
            }
            // Issue #263: backing fields for static auto-properties.
            for p in s.StaticProperties {
                if p.IsAutoProperty && p.BackingField != nil {
                    PlanField(p.BackingField!!)
                }
            }
            // Issue #263: backing fields for static field-like events.
            for ev in s.StaticEvents {
                if ev.IsFieldLike && ev.BackingField != nil {
                    PlanField(ev.BackingField!!)
                }
            }
        }
        // Issue #193: each user-defined enum contributes 1 instance field
        // (value__) plus one literal field per member.
        let enums = enumsAll
        let enumFirstFieldRow = Dictionary[EnumSymbol, int32]()
        let PlanEnumFields = func (e EnumSymbol) {
            enumFirstFieldRow[e] = nextFieldRow
            nextFieldRow += 1 + e.Members.Length
        }
        // Walk top-level non-SM types for field assignment (classes, then
        // structs, then enums) — historical kind-partitioned order.
        for s in topClasses {
            PlanAggregateFields(s)
        }
        for s in topStructs {
            PlanAggregateFields(s)
        }
        // Enum field rows are planned right after non-SM struct fields so the
        // enum TypeDef can be emitted between non-SM struct TypeDefs and the
        // nested block without violating the monotone fieldList constraint.
        for e in topEnums {
            PlanEnumFields(e)
        }
        // Issue #910 / ADR-0110: nested-type field rows form a contiguous block
        // after all top-level field rows and before <Program>/global fields.
        for nested in nestedOrdered {
            nestedFieldListRow[nested] = nextFieldRow
            switch nested {
                case ns is StructSymbol {
                    PlanAggregateFields(ns)
                }
                case ne is EnumSymbol {
                    PlanEnumFields(ne)
                }
                case ni is InterfaceSymbol {
                    // ADR-0089 / issue #1030: a nested interface may declare
                    // static fields. Reserve its FieldDef rows in the nested
                    // block (its TypeDef row is emitted in this same pass).
                    interfaceFirstFieldRow[ni] = nextFieldRow
                    nextFieldRow += ni.StaticFields.Length + ni.ConstFields.Length
                }
            }
        }
        // Issue #191: user-declared top-level var/let/const live as static
        // fields on the entry-point package's <Program> TypeDef. Reserve their
        // field rows immediately before <Program>'s fieldList pointer so the
        // existing monotone constraint holds and programFirstFieldRow points
        // at the first global field (when any). SM struct fields are planned
        // after these globals so SM field rows remain strictly greater than
        // <Program>'s fieldList pointer.
        var globals = this.emitCtx.Program.Globals
        // Issue #3215: a top-level `var p = &x` binds `p` as a global whose
        // type is a managed pointer (`*T`, ByRefTypeSymbol). ECMA-335 §II.14.4.2
        // forbids ELEMENT_TYPE_BYREF in a field signature, so such a variable
        // cannot be hoisted to a static FieldDef at all — the signature
        // encoder (correctly) refuses to encode it and the whole emit died
        // with an ICE. Keep byref-typed globals out of the hoist plan instead:
        // every consumer (SlotPlanner, MethodBodyPlanner, the member-access
        // emit paths) already falls back to an ordinary method-local slot when
        // a GlobalVariableSymbol has no registered FieldDef, and a byref LOCAL
        // slot is legal IL (EncodeLocalVariableType emits `T&`). The variable
        // keeps evaluator-identical single-run semantics; it simply is not
        // observable as a CLR static field (which no legal PE could express).
        globals = globals.RemoveAll((g GlobalVariableSymbol) -> g.Type is ByRefTypeSymbol)
        let programFirstFieldRow = nextFieldRow
        let globalFieldRows = Dictionary[GlobalVariableSymbol, int32]()
        for g in globals {
            globalFieldRows[g] = nextFieldRow
            nextFieldRow++
        }
        // SM types get field rows after <Program>'s fieldList pointer.
        for s in smClasses {
            structFirstFieldRow[s] = nextFieldRow
            for field in s.Fields {
                PlanField(field)
            }
        }
        for s in smStructsOrdered {
            structFirstFieldRow[s] = nextFieldRow
            for field in s.Fields {
                PlanField(field)
            }
        }
        let moduleFirstFieldRow = 1
        this.utf8Data.PlanFields(nextFieldRow)
        return FieldRowPlan(
            interfaceFirstFieldRow,
            structFirstFieldRow,
            enumFirstFieldRow,
            globals,
            programFirstFieldRow,
            moduleFirstFieldRow
        )
    }

    private func PlanMethodRows(aggregateTypes AggregateTypeLayout) MethodRowPlan {
        let topInterfaces = aggregateTypes.TopLevel.Interfaces
        let topClasses = aggregateTypes.TopLevel.Classes
        let topStructs = aggregateTypes.TopLevel.Structs
        let nestedOrdered = aggregateTypes.NestedTypes.Types
        let nestedMethodListRow = aggregateTypes.NestedTypes.FirstMethodRows
        // A real CLR module initializer is emitted as <Module>..cctor in row 1.
        // Every ordinary MethodDef shifts by one only when at least one valid
        // [ModuleInitializer] method exists, preserving historical PE hashes
        // for all other compilations.
        var methodRow = if this.moduleInitializers.IsDefaultOrEmpty {
            1
        } else {
            2
        }
        let interfaceFirstMethodRow = Dictionary[InterfaceSymbol, int32]()
        let interfaceCctorRows = Dictionary[InterfaceSymbol, int32]()
        let PlanInterfaceMethods = func (i InterfaceSymbol) {
            interfaceFirstMethodRow[i] = methodRow
            for m in i.Methods {
                this.cache.MethodHandles[m] = MetadataTokens.MethodDefinitionHandle(methodRow)
                methodRow++
            }
            // ADR-0089 / issue #755: plan MethodDef rows for static-virtual
            // interface members. They occupy the same MethodList run as
            // instance interface methods so the parent TypeDef's methodList
            // pointer correctly bounds the entire group.
            for sm in i.StaticMethods {
                this.cache.MethodHandles[sm] = MetadataTokens.MethodDefinitionHandle(methodRow)
                methodRow++
            }
            // ADR-0090 / issue #756: plan MethodDef rows for private interface
            // helper methods (instance + static). They live inside the same
            // interface TypeDef methodList run so the bounds remain correct.
            if !i.PrivateMethods.IsDefaultOrEmpty {
                for pm in i.PrivateMethods {
                    this.cache.MethodHandles[pm] = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
            }
            if !i.StaticPrivateMethods.IsDefaultOrEmpty {
                for spm in i.StaticPrivateMethods {
                    this.cache.MethodHandles[spm] = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
            }
            // Plan accessor method rows for interface properties (issue #248).
            for prop in i.Properties {
                var getterHandle MethodDefinitionHandle? = nil
                var setterHandle MethodDefinitionHandle? = nil
                if prop.HasGetter {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                if prop.HasSetter {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle)
                // ADR-0089 / issue #1019, #2293: register the accessor
                // FunctionSymbols against their planned MethodDef rows for
                // BOTH static-virtual and ordinary instance interface
                // properties, mirroring the instance-method registration
                // above (`i.Methods`). This lets `constrained.` dispatch
                // (`T.Prop` → get_Prop) and ordinary interface-typed callvirt
                // sites resolve the accessor's slot handle even when the
                // implementer relies on the interface's default body.
                if prop.GetterSymbol != nil && (getterHandle != nil) {
                    this.cache.MethodHandles[prop.GetterSymbol!!] = getterHandle
                }
                if prop.SetterSymbol != nil && (setterHandle != nil) {
                    this.cache.MethodHandles[prop.SetterSymbol!!] = setterHandle
                }
            }
            // ADR-0052: plan accessor method rows for interface events.
            for ev in i.Events {
                let addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let raiseHandle MethodDefinitionHandle? = if ev.RaiseMethodSymbol != nil {
                    MetadataTokens.MethodDefinitionHandle(methodRow++)
                } else {
                    nil
                }
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle)
                // ADR-0149: register the interface event's own add/remove/
                // raise FunctionSymbols against their planned MethodDef rows,
                // mirroring the property accessor registration above — this
                // is what lets EmitExplicitInterfaceEventMethodImpls resolve
                // the interface-side MethodImpl target token for an explicit
                // event implementation (`event (IFoo) Changed T`).
                let addMethodSymbol FunctionSymbol? = ev.AddMethodSymbol
                if addMethodSymbol != nil {
                    this.cache.MethodHandles[addMethodSymbol] = addHandle
                }
                let removeMethodSymbol FunctionSymbol? = ev.RemoveMethodSymbol
                if removeMethodSymbol != nil {
                    this.cache.MethodHandles[removeMethodSymbol] = removeHandle
                }
                if ev.RaiseMethodSymbol != nil && (raiseHandle != nil) {
                    this.cache.MethodHandles[ev.RaiseMethodSymbol!!] = raiseHandle
                }
            }
            // ADR-0089 / issue #1030: plan the .cctor row for an interface that
            // declares static-field initializers. It is the LAST method in the
            // interface's MethodList run (emitted after property/event accessors
            // in EmitInterfaceMethodBodies), so reserve it here last.
            if !i.StaticFieldInitializers.IsEmpty || ConstantFieldMetadataEmitter.ContainsRuntimeInitializedConstant(
                i.ConstFields
            ) {
                interfaceCctorRows[i] = methodRow
                methodRow++
            }
        }
        // Phase 3.B.4: plan method rows for interface abstract methods FIRST.
        // Interface TypeDefs sit between <Module> and the class TypeDefs in
        // row order so their methodList pointer (= first abstract method) is
        // strictly less than the first class ctor row.
        for i in topInterfaces {
            PlanInterfaceMethods(i)
        }
        // ADR-0059 / issue #255: plan method rows for each named delegate
        // (one ctor + one Invoke per delegate) AFTER interface methods and
        // BEFORE non-SM class ctors. The delegate TypeDef rows themselves are
        // emitted immediately after interfaces so methodList pointers stay
        // monotone non-decreasing across the table.
        let delegates = this.emitCtx.Program.Delegates
        let delegateCtorRows = Dictionary[DelegateTypeSymbol, int32]()
        let delegateInvokeRows = Dictionary[DelegateTypeSymbol, int32]()
        for d in delegates {
            delegateCtorRows[d] = methodRow
            methodRow++
            delegateInvokeRows[d] = methodRow
            methodRow++
        }
        // Plan method rows for non-SM class ctors + instance methods.
        let classCtorRows = Dictionary[StructSymbol, int32]()
        let classPrimaryCtorRows = Dictionary[StructSymbol, int32]()
        let aggregateMethodHandles = Dictionary[FunctionSymbol, MethodDefinitionHandle]()
        let dataCopyConstructorClasses = HashSet[StructSymbol]()
        // Clone MethodImpl rows may skip non-data intermediaries, but instance
        // constructors must call the direct base. Give every user class in a
        // data-class ancestry chain a planned copy constructor.
        for dataClass in topClasses.Concat(
            nestedOrdered.OfType[StructSymbol]().Where((type StructSymbol) -> type.IsClass)
        )
            .Where((type StructSymbol) -> type.IsData) {
            for current in dataClass.GetHierarchy() {
                dataCopyConstructorClasses.Add(current.Definition ?? current)
            }
        }
        let PlanClassMethods = func (c StructSymbol) {
            classCtorRows[c] = methodRow
            methodRow++
            let dataPrimaryOnly = c.IsData &&
                c.HasPrimaryConstructor &&
                c.BaseConstructorInitializer == nil &&
                c.ExplicitConstructor == nil
            if dataPrimaryOnly {
                classPrimaryCtorRows[c] = classCtorRows[c]
            }
            // Issue #656 / ADR-0065: when the class declares explicit init(...)
            // constructors, each overload beyond the first requires an additional
            // method row. The first overload occupies the classCtorRows slot above.
            if c.ExplicitConstructor != nil && c.ExplicitConstructors.Length > 1 {
                methodRow += c.ExplicitConstructors.Length - 1
            }
            // Issue #306: a class with an explicit base-constructor initializer
            // emits a single forwarding constructor (no separate parameterless
            // ctor), so reserve only one ctor row in that case.
            // ADR-0065 §5: when the class also declares explicit `init(...)`
            // bodies, the synthesized primary ctor is allocated as one of the
            // ExplicitConstructors rows above — do not reserve an additional
            // primary-ctor row here.
            if c.HasPrimaryConstructor &&
                c.BaseConstructorInitializer == nil &&
                c.ExplicitConstructor == nil &&
                !dataPrimaryOnly {
                classPrimaryCtorRows[c] = methodRow
                methodRow++
            }
            if !c.IsData && dataCopyConstructorClasses.Contains(c) {
                this.cache.DataClassCopyConstructorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow)
                methodRow++
            }
            // Issue #2228: a `data class` synthesizes the same seven
            // MethodDef rows as a `data struct` (Equals(object),
            // Equals(Name), GetHashCode, ToString, op_Equality,
            // op_Inequality, Deconstruct) — see PlanStructMethods' matching
            // reservation and EmitClassMethodBodies' matching emit call,
            // which must run in the same relative order (before
            // user-declared methods) so the MethodDef rows line up.
            // Issue #2363: a zero-field data class skips Deconstruct (one
            // fewer row) — see DataStructSynthesizer.HasZeroDeconstructionMembers
            // and EmitDataStructSynthesizedMembers's matching skip.
            // Issue #2361: when the class declares a compatible hand-written
            // ToString, one fewer row is reserved here too — the "ToString"
            // row is instead reserved by the ordinary c.Methods loop below,
            // matching DataStructSynthesizer.EmitDataStructSynthesizedMembers
            // skipping the synthesized ToString body in that case. The two
            // skips are independent and compose (a zero-field data class
            // with a user ToString override reserves five rows).
            if c.IsData {
                // Issue #2871: `<Clone>$` is the third synthesized data-class
                // row (after EqualityContract.get and the copy constructor).
                // Record it during planning so derived covariant clones can
                // emit a MethodImpl against the base slot regardless of body
                // emission order. Abstract data classes still reserve and emit
                // this row; their clone is abstract and has no body.
                this.cache.DataClassCopyConstructorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow + 1)
                this.cache.DataClassCloneHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow + 2)
                this.cache.MethodHandles[c.DataClassCloneMethod] = this.cache.DataClassCloneHandles[c]
                this.cache.MethodHandles[c.DataEqualsSelf] = MetadataTokens.MethodDefinitionHandle(methodRow + 3)
                this.cache.MethodHandles[c.DataEqualsObject] = MetadataTokens.MethodDefinitionHandle(methodRow + 4)
                if c.DataEqualsBase is {} baseEquals {
                    this.cache.MethodHandles[baseEquals] = MetadataTokens.MethodDefinitionHandle(methodRow + 5)
                }
                this.cache.MethodHandles[c.DataClassCloneMethod] = this.cache.DataClassCloneHandles[c]
                var synthesizedRows = 10 +
                    (
                    if c.DataEqualsBase != nil {
                        1
                    } else {
                        0
                    }
                ) - (
                    if DataStructSynthesizer.HasZeroDeconstructionMembers(c) {
                        1
                    } else {
                        0
                    }
                ) - (
                    if DataStructSynthesizer.HasUserToStringOverride(c) {
                        1
                    } else {
                        0
                    }
                )
                // ADR-0199: the synthesized C#-record PrintMembers is the last
                // synthesized row (a hand-written one is an ordinary method).
                if c.DataPrintMembers is {} printMembers {
                    this.cache.MethodHandles[printMembers] = MetadataTokens.MethodDefinitionHandle(
                        methodRow + synthesizedRows
                    )
                    synthesizedRows++
                }
                methodRow += synthesizedRows
            }
            if !c.Methods.IsDefaultOrEmpty {
                for m in c.Methods {
                    let handle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                    aggregateMethodHandles[m] = handle
                    this.cache.MethodHandles[m] = handle
                }
            }
            // ADR-0068 / issue #698: reserve a row for the synthesized
            // `Finalize` override produced by a class `deinit { … }`. The
            // emitter materialises it as a regular instance method between
            // user-declared methods and property accessors in the row order.
            if c.Deinitializer != nil {
                let deinitHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                this.cache.MethodHandles[c.Deinitializer!!.Function] = deinitHandle
            }
            // ADR-0051 Phase 6: plan accessor method rows for class properties.
            for prop in c.Properties {
                var getterHandle MethodDefinitionHandle? = nil
                var setterHandle MethodDefinitionHandle? = nil
                if prop.HasGetter {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                if prop.HasSetter {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle)
                this.RegisterIndexerAccessorHandles(prop, getterHandle, setterHandle)
            }
            // ADR-0052: plan accessor method rows for class events.
            for ev in c.Events {
                let addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let raiseHandle MethodDefinitionHandle? = if ev.RaiseMethodSymbol != nil {
                    MetadataTokens.MethodDefinitionHandle(methodRow++)
                } else {
                    nil
                }
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle)
            }
            methodRow += this.interfaceImpls.PlanInheritedEventBridges(c, methodRow)
            methodRow += this.interfaceImpls.PlanImportedAccessorBridges(c, methodRow)
            // ADR-0053: plan method rows for static methods on classes.
            if !c.StaticMethods.IsDefaultOrEmpty {
                for m in c.StaticMethods {
                    let handle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                    aggregateMethodHandles[m] = handle
                    this.cache.MethodHandles[m] = handle
                    methodRow = this.PlanLibraryImportInnerRow(m, methodRow)
                }
                // Issue #3883: one extra row on THIS class for the synthesized
                // `<Main>$` stub that blocks on its authored async `Main`. It
                // must live on the same type: the stub body is a second async
                // kickoff, and the state-machine struct it initializes is a
                // private nested type of this class.
                if this.ClassOwnsEntryPointStub(c) {
                    this.entryPointStubHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
            }
            // Issue #263: plan accessor method rows for static properties on classes.
            for prop in c.StaticProperties {
                var getterHandle MethodDefinitionHandle? = nil
                var setterHandle MethodDefinitionHandle? = nil
                if prop.HasGetter {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                if prop.HasSetter {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle)
            }
            // Issue #263: plan accessor method rows for static events on classes.
            for ev in c.StaticEvents {
                let addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let raiseHandle MethodDefinitionHandle? = if ev.RaiseMethodSymbol != nil {
                    MetadataTokens.MethodDefinitionHandle(methodRow++)
                } else {
                    nil
                }
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle)
            }
            // Issue #262: plan .cctor row for classes with static field initializers.
            // ADR-0140 / issue #2131: also plan it when the class declares a
            // `shared { init { … } }` static-initializer block.
            if !c.StaticFieldInitializers.IsEmpty || ConstantFieldMetadataEmitter.ContainsRuntimeInitializedConstant(
                c.ConstFields
            ) ||
                c.HasStaticInitializerBlock {
                this.cache.CctorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow)
                methodRow++
            }
        }
        for c in topClasses {
            PlanClassMethods(c)
        }
        // Issue #1996: a class-scoped static `Main` is emitted as an ordinary
        // TypeDef-owned static method (its MethodDef row was already reserved
        // above by PlanClassMethods' StaticMethods loop). It must NOT also get
        // a package-level <Program> row/emission — the per-package entry-point
        // reservation/emission below is skipped for it, and the emitted
        // TypeDef-owned MethodDef row is reused directly as the PE entry point.
        //
        // Issue #3883: when that class-scoped `Main` is ASYNC its own row can
        // no longer double as the PE entry point — reusing it forces the CLR
        // entry-point signature (void/int32) onto the user's declaration and
        // erases `Task<T>` from metadata, so cross-assembly consumers see a
        // synchronous method (`await Program.Main(args)` fails with GS0159 on
        // ConfigureAwait). csc keeps the authored `Main` Task-shaped and
        // synthesizes a SEPARATE `<Main>$` stub that blocks on it. The stub's
        // row is reserved by PlanClassMethods on the SAME class (it reads the
        // state machine's private fields, so a <Program>-hosted stub would
        // fail CLR field-access checks); `entryPointIsClassOwned` stays true
        // so no package-level row is reserved as well.
        let entryPointIsClassOwned = this.emitCtx.Program.EntryPoint != nil && aggregateMethodHandles.ContainsKey(
            this.emitCtx.Program.EntryPoint
        )
        // Plan method rows for non-SM structs.
        let structFirstMethodRows = Dictionary[StructSymbol, int32]()
        let PlanStructMethods = func (s StructSymbol) {
            // Issue #3219: a value struct with a non-public declared field
            // initializer gets a synthesized parameterless .ctor (planned as
            // the struct's LAST row, below, so the explicit-ctor /
            // inline-struct first-row offsets pre-registered later in this
            // pass stay valid).
            let needsSynthesizedDefaultCtor = ConstructorBodyEmitter.NeedsSynthesizedValueStructDefaultCtor(s)
            if s
                .Methods
                .IsDefaultOrEmpty &&
                s
                .ExplicitConstructors
                .IsDefaultOrEmpty &&
                !s.IsInline &&
                !s.IsData &&
                s
                .Properties
                .IsDefaultOrEmpty &&
                s
                .Events
                .IsDefaultOrEmpty &&
                s
                .StaticMethods
                .IsDefaultOrEmpty &&
                s
                .StaticProperties
                .IsDefaultOrEmpty &&
                s
                .StaticEvents
                .IsDefaultOrEmpty &&
                s
                .StaticFieldInitializers
                .IsEmpty &&
                !ConstantFieldMetadataEmitter.ContainsRuntimeInitializedConstant(s.ConstFields) &&
                !s.HasStaticInitializerBlock &&
                !needsSynthesizedDefaultCtor {
                return
            }
            structFirstMethodRows[s] = methodRow
            if !s.ExplicitConstructors.IsDefaultOrEmpty {
                methodRow += s.ExplicitConstructors.Count(
                    (constructor ConstructorSymbol) -> !constructor.IsSynthesizedFromPrimaryConstructor
                )
            }
            if s.IsInline {
                methodRow += 8
            } else if s.IsData {
                this.cache.MethodHandles[s.DataEqualsSelf] = MetadataTokens.MethodDefinitionHandle(methodRow)
                this.cache.MethodHandles[s.DataEqualsObject] = MetadataTokens.MethodDefinitionHandle(methodRow + 1)
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
                var structSynthesizedRows = 7 - (
                    if DataStructSynthesizer.HasZeroDeconstructionMembers(s) {
                        1
                    } else {
                        0
                    }
                ) - (
                    if DataStructSynthesizer.HasUserToStringOverride(s) {
                        1
                    } else {
                        0
                    }
                )
                // ADR-0199: PrintMembers is the last synthesized row, before the
                // primary constructor; an anonymous literal has none.
                if s.DataPrintMembers is {} structPrintMembers {
                    this.cache.MethodHandles[structPrintMembers] = MetadataTokens.MethodDefinitionHandle(
                        methodRow + structSynthesizedRows
                    )
                    structSynthesizedRows++
                }
                methodRow += structSynthesizedRows
                // Native positional data construction invokes a real primary
                // constructor, including anonymous-class literal backing types.
                if s.HasSynthesizedDataConstructor {
                    classPrimaryCtorRows[s] = methodRow
                    methodRow++
                }
            }
            for m in s.Methods {
                let handle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                aggregateMethodHandles[m] = handle
                this.cache.MethodHandles[m] = handle
            }
            // ADR-0051 Phase 6: plan accessor method rows for struct properties.
            for prop in s.Properties {
                var getterHandle MethodDefinitionHandle? = nil
                var setterHandle MethodDefinitionHandle? = nil
                if prop.HasGetter {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                if prop.HasSetter {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle)
                this.RegisterIndexerAccessorHandles(prop, getterHandle, setterHandle)
            }
            // ADR-0052: plan accessor method rows for struct events.
            for ev in s.Events {
                let addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let raiseHandle MethodDefinitionHandle? = if ev.RaiseMethodSymbol != nil {
                    MetadataTokens.MethodDefinitionHandle(methodRow++)
                } else {
                    nil
                }
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle)
            }
            // ADR-0053: plan method rows for static methods on structs.
            if !s.StaticMethods.IsDefaultOrEmpty {
                for m in s.StaticMethods {
                    let handle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                    aggregateMethodHandles[m] = handle
                    this.cache.MethodHandles[m] = handle
                    methodRow = this.PlanLibraryImportInnerRow(m, methodRow)
                }
            }
            // Issue #263: plan accessor method rows for static properties on structs.
            for prop in s.StaticProperties {
                var getterHandle MethodDefinitionHandle? = nil
                var setterHandle MethodDefinitionHandle? = nil
                if prop.HasGetter {
                    getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                if prop.HasSetter {
                    setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow)
                    methodRow++
                }
                this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle)
            }
            // Issue #263: plan accessor method rows for static events on structs.
            for ev in s.StaticEvents {
                let addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++)
                let raiseHandle MethodDefinitionHandle? = if ev.RaiseMethodSymbol != nil {
                    MetadataTokens.MethodDefinitionHandle(methodRow++)
                } else {
                    nil
                }
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle)
            }
            // Issue #262: plan .cctor row for structs with static field initializers.
            // ADR-0140 / issue #2131: also plan it when the struct declares a
            // `shared { init { … } }` static-initializer block.
            if !s.StaticFieldInitializers.IsEmpty || ConstantFieldMetadataEmitter.ContainsRuntimeInitializedConstant(
                s.ConstFields
            ) ||
                s.HasStaticInitializerBlock {
                this.cache.CctorHandles[s] = MetadataTokens.MethodDefinitionHandle(methodRow)
                methodRow++
            }
            // Issue #3219: plan (and pre-register, so bodies emitted before
            // EmitStructMethodBodies can construct through it) the synthesized
            // parameterless .ctor as the struct's last row. ClassCtorHandles
            // doubles as the default-ctor registry ResolveUserCtorTokenForDefault
            // consults for constructed-generic MemberRef parenting.
            if needsSynthesizedDefaultCtor && (!s.IsData || s.NeedsValueStructZeroHelper) {
                let initializerCtor = MetadataTokens.MethodDefinitionHandle(methodRow++)
                if s.HasPrimaryConstructor && !s.ValueStructDefaultCtorIsZeroInitialization {
                    this.cache.ClassPrimaryCtorHandles[s] = initializerCtor
                } else {
                    this.cache.ClassCtorHandles[s] = initializerCtor
                }
            }
        }
        for s in topStructs {
            PlanStructMethods(s)
        }
        // Issue #910 / ADR-0110: nested-type method rows form a contiguous
        // block after all top-level method rows and before the per-package
        // <Program> ctor/method rows. Each nested type records its methodList
        // boundary so the monotone MethodList column holds across the block.
        let firstNestedMethodRow = methodRow
        for nested in nestedOrdered {
            nestedMethodListRow[nested] = methodRow
            switch nested {
                case ni is InterfaceSymbol {
                    PlanInterfaceMethods(ni)
                }
                case ns is StructSymbol when ns.IsClass {
                    PlanClassMethods(ns)
                }
                case ns is StructSymbol {
                    PlanStructMethods(ns)
                }
            }
        }
        let firstPackageCtorRow = methodRow
        return MethodRowPlan(
            delegates,
            TypeMethodRows(
                interfaceFirstMethodRow,
                delegateCtorRows,
                classCtorRows,
                classPrimaryCtorRows,
                aggregateMethodHandles,
                structFirstMethodRows
            ),
            entryPointIsClassOwned,
            firstNestedMethodRow,
            firstPackageCtorRow
        )
    }

    private func EmitUserTypeDefinitionsAndEarlyMethods(
        aggregateTypes AggregateTypeLayout,
        fieldRows FieldRowPlan,
        methodRows MethodRowPlan
    ) {
        // Issue #976: emit the InterfaceImpl metadata rows for an aggregate
        // (class OR struct) TypeDef. Value types (structs) declare interface
        // implementation exactly like classes, so the rows are emitted from a
        // shared helper rather than only on the class path.
        let EmitInterfaceImplRows = func (c StructSymbol) {
            if !c.Interfaces.IsDefaultOrEmpty {
                for iface in c.Interfaces {
                    // ADR-0087 R5 / issue #765: when the implemented user
                    // interface is a constructed instance (e.g. `IBox[int32]`),
                    // the InterfaceImpl row must reference a TypeSpec built
                    // from the constructed shape; the bare TypeDef key only
                    // resolves the open definition.
                    if ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface) {
                        this
                            .emitCtx
                            .Metadata
                            .AddInterfaceImplementation(
                            this.cache.StructTypeDefs[c],
                            this.userTokens.GetUserInterfaceTypeSpec(iface)
                        )
                    } else if this.cache.InterfaceTypeDefs.TryGetValue(iface, out var ifaceHandle) {
                        this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[c], ifaceHandle)
                    }
                }
            }
            // Issue #525 / #4601: emit InterfaceImpl rows for the imported CLR
            // interfaces declared in the base-type clause, each followed by its
            // transitive base interfaces, as csc emits them. The CLR re-maps
            // only the interfaces a type itself lists, so with `IList[int32]`
            // alone a G# member for an `ICollection[int32]` slot that an
            // imported base class already implements was silently ignored by
            // interface dispatch. `ClrInterfaceClosure` is the single source
            // for these rows and for the static-virtual MethodImpls (#4614);
            // the #985 bridge rows below add to the same de-duplicated set.
            let clrClosure = ClrInterfaceClosure.Build(c, this.signatures)
            for (symbolicIface, concreteIface) in clrClosure.Entries {
                if symbolicIface != nil {
                    this
                        .emitCtx
                        .Metadata
                        .AddInterfaceImplementation(
                        this.cache.StructTypeDefs[c],
                        this.memberRefs.GetElementTypeToken(symbolicIface)
                    )
                } else if concreteIface != nil {
                    this
                        .emitCtx
                        .Metadata
                        .AddInterfaceImplementation(
                        this.cache.StructTypeDefs[c],
                        this.memberRefs.GetTypeHandleForMember(concreteIface)
                    )
                }
            }
            let EmitClrInterfaceRow = func (clrIface Type) {
                if clrClosure.TryAddConcrete(clrIface) {
                    this
                        .emitCtx
                        .Metadata
                        .AddInterfaceImplementation(
                        this.cache.StructTypeDefs[c],
                        this.memberRefs.GetTypeHandleForMember(clrIface)
                    )
                }
            }
            let EmitSymbolicInterfaceRow = func (symbolicIface TypeSymbol) {
                if clrClosure.TryAddSymbolic(symbolicIface) {
                    this
                        .emitCtx
                        .Metadata
                        .AddInterfaceImplementation(
                        this.cache.StructTypeDefs[c],
                        this.memberRefs.GetElementTypeToken(symbolicIface)
                    )
                }
            }
            // Issue #985: a covariant-return interface bridge (e.g. the
            // non-generic IEnumerable.GetEnumerator) explicitly implements an
            // INHERITED base interface that is not itself named in the base
            // clause. Emit an explicit InterfaceImpl row for that base
            // interface so the metadata matches the C# shape (both
            // `IEnumerable<T>` and `IEnumerable` appear) and the MethodImpl row
            // resolves against a declared interface.
            if !c.Methods.IsDefaultOrEmpty {
                for method in c.Methods {
                    let declaringIface Type? = method.ExplicitInterfaceSlot?.DeclaringType
                    if declaringIface == nil {
                        continue
                    }
                    var alreadyDeclared = false
                    for implemented in c.ImplementedClrInterfaces {
                        if implemented?.ClrType != nil && ClrTypeUtilities.AreSame(
                            implemented.ClrType,
                            declaringIface
                        ) {
                            alreadyDeclared = true
                            break
                        }
                        if implemented != nil && MemberLookup.TryGetSymbolicClrGenericInterface(
                            implemented,
                            out var openImplemented,
                            out _
                        ) &&
                            openImplemented != nil &&
                            ClrTypeUtilities.AreSame(openImplemented, declaringIface) {
                            alreadyDeclared = true
                            break
                        }
                    }
                    if alreadyDeclared {
                        continue
                    }
                    if method.ExplicitInterfaceSlotContainingType is {} symbolicDeclaring &&
                        MemberLookup.TryGetSymbolicClrGenericInterface(
                        symbolicDeclaring,
                        out var openDeclaring,
                        out _
                    ) &&
                        openDeclaring != nil &&
                        ClrTypeUtilities.AreSame(openDeclaring, declaringIface) {
                        EmitSymbolicInterfaceRow(symbolicDeclaring)
                        continue
                    }
                    EmitClrInterfaceRow(declaringIface)
                }
            }
        }
        let nonSmClasses = aggregateTypes.Aggregates.NonStateMachineClasses
        let nonSmStructs = aggregateTypes.Aggregates.NonStateMachineStructs
        let topInterfaces = aggregateTypes.TopLevel.Interfaces
        let topClasses = aggregateTypes.TopLevel.Classes
        let topStructs = aggregateTypes.TopLevel.Structs
        let topEnums = aggregateTypes.TopLevel.Enums
        let nestedOrdered = aggregateTypes.NestedTypes.Types
        let nestedFieldListRow = aggregateTypes.NestedTypes.FirstFieldRows
        let nestedMethodListRow = aggregateTypes.NestedTypes.FirstMethodRows
        let interfaceFirstFieldRow = fieldRows.InterfaceFirstRows
        let structFirstFieldRow = fieldRows.AggregateFirstRows
        let enumFirstFieldRow = fieldRows.EnumFirstRows
        let moduleFirstFieldRow = fieldRows.ModuleFirstRow
        let interfaceFirstMethodRow = methodRows.TypeRows.InterfaceFirstRows
        let delegates = methodRows.Delegates
        let delegateCtorRows = methodRows.TypeRows.DelegateConstructorRows
        let classCtorRows = methodRows.TypeRows.ClassConstructorRows
        let classPrimaryCtorRows = methodRows.TypeRows.ClassPrimaryConstructorRows
        let structFirstMethodRows = methodRows.TypeRows.StructFirstRows
        let firstNestedMethodRow = methodRows.FirstNestedRow
        // 2. <Module> type (TypeDef row #1 must always be <Module> per ECMA-335).
        this
            .emitCtx
            .Metadata
            .AddTypeDefinition(
            attributes: default(TypeAttributes),
            namespace: default(StringHandle),
            name: this.emitCtx.Metadata.GetOrAddString("<Module>"),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(moduleFirstFieldRow),
            methodList: MetadataTokens.MethodDefinitionHandle(1)
        )
        this.EmitModuleInitializer()
        let PreRegisterClassCtorHandles = func (c StructSymbol) {
            if !classCtorRows.TryGetValue(c, out var firstCtorRow) {
                return
            }
            if c.ExplicitConstructor != nil {
                let firstHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow)
                for var i = 0; i < c.ExplicitConstructors.Length; i++ {
                    this.cache.ExplicitCtorHandles[c.ExplicitConstructors[i]] = MetadataTokens.MethodDefinitionHandle(
                        firstCtorRow + i
                    )
                }
                this.cache.ClassCtorHandles[c] = firstHandle
                this.cache.ClassPrimaryCtorHandles[c] = firstHandle
            } else if c.BaseConstructorInitializer != nil {
                let forwardingHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow)
                this.cache.ClassCtorHandles[c] = forwardingHandle
                this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle
            } else {
                this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(firstCtorRow)
                if c.HasPrimaryConstructor && classPrimaryCtorRows.TryGetValue(c, out var primaryRow) {
                    this.cache.ClassPrimaryCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(primaryRow)
                }
            }
        }
        // Issue #4922: a compilation-embedded NullableAttribute / NullableContextAttribute
        // (see EmbeddedAttributeSource) is stamped on members of every other type,
        // including interfaces and delegates that are emitted before the general
        // registration below. Register just those classes' ctor handles now, from the
        // same planned rows, so the stamps can bind to them whatever the emission order.
        for c in nonSmClasses {
            if EmbeddedAttributeSource.IsEmbeddableAttributeName(c.PackageName + "." + c.Name) {
                PreRegisterClassCtorHandles(c)
            }
        }
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
        var reservedTypeDefRow = this.emitCtx.Metadata.GetRowCount(TableIndex.TypeDef) + 1
        let ReserveTypeDefHandle = func (type TypeSymbol) {
            let handle = MetadataTokens.TypeDefinitionHandle(reservedTypeDefRow++)
            switch type {
                case ifaceSym is InterfaceSymbol {
                    this.cache.InterfaceTypeDefs[ifaceSym] = handle
                }
                case delegateSym is DelegateTypeSymbol {
                    this.cache.DelegateTypeDefs[delegateSym] = handle
                }
                case structSym is StructSymbol {
                    this.cache.StructTypeDefs[structSym] = handle
                }
                case enumSym is EnumSymbol {
                    this.cache.EnumTypeDefs[enumSym] = handle
                }
            }
        }
        for i in topInterfaces {
            ReserveTypeDefHandle(i)
        }
        for d in delegates {
            ReserveTypeDefHandle(d)
        }
        for c in topClasses {
            ReserveTypeDefHandle(c)
        }
        for s in topStructs {
            ReserveTypeDefHandle(s)
        }
        for e in topEnums {
            ReserveTypeDefHandle(e)
        }
        for nested in nestedOrdered {
            ReserveTypeDefHandle(nested)
        }
        // 2a. Phase 3.B.4: Emit interface TypeDefs + their abstract method
        // rows. Interfaces have no fields and only abstract method bodies, so
        // they are the simplest TypeDefs to emit. Their methodList points at
        // the first of their reserved abstract method rows.
        for i in topInterfaces {
            this.typeDefEmitter.EmitInterfaceTypeDef(i, interfaceFirstMethodRow[i], interfaceFirstFieldRow[i])
        }
        // Issue #1006: emit the InterfaceImpl rows recording each interface's
        // base interfaces (`interface B : A` → InterfaceImpl{B -> A}). All
        // interface TypeDefs are emitted above, so the cache is fully populated
        // before any base reference is resolved. Emitting here — before the
        // class/struct TypeDefs — keeps the InterfaceImpl Class column
        // ascending (interface TypeDef RIDs precede class/struct RIDs).
        let EmitInterfaceBaseImplRows = func (iface InterfaceSymbol) {
            if !this.cache.InterfaceTypeDefs.TryGetValue(iface, out var ifaceTypeDef) {
                return
            }
            if !iface.BaseInterfaces.IsDefaultOrEmpty {
                for baseIface in iface.BaseInterfaces {
                    if ReflectionMetadataEmitter.IsUserGenericInterfaceReference(baseIface) {
                        this
                            .emitCtx
                            .Metadata
                            .AddInterfaceImplementation(
                            ifaceTypeDef,
                            this.userTokens.GetUserInterfaceTypeSpec(baseIface)
                        )
                    } else if this.cache.InterfaceTypeDefs.TryGetValue(baseIface, out var baseHandle) {
                        this.emitCtx.Metadata.AddInterfaceImplementation(ifaceTypeDef, baseHandle)
                    }
                }
            }
            if !iface.BaseClrInterfaces.IsDefaultOrEmpty {
                for clrBase in iface.BaseClrInterfaces {
                    if MemberLookup.TryGetSymbolicClrGenericInterface(clrBase, out _, out _) {
                        this
                            .emitCtx
                            .Metadata
                            .AddInterfaceImplementation(ifaceTypeDef, this.memberRefs.GetElementTypeToken(clrBase))
                        continue
                    }
                    if clrBase?.ClrType is Type clrType {
                        this
                            .emitCtx
                            .Metadata
                            .AddInterfaceImplementation(ifaceTypeDef, this.memberRefs.GetTypeHandleForMember(clrType))
                    }
                }
            }
        }
        for i in topInterfaces {
            EmitInterfaceBaseImplRows(i)
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
        for c in nonSmClasses {
            PreRegisterClassCtorHandles(c)
        }
        // Same hazard, same fix, for an `inline struct`'s primary ctor: an
        // interface body may `newobj Box(n)` where `Box` is an inline struct
        // (single-field value type). Its ctor handle is normally registered
        // inside EmitInlineStructSynthesizedMembers, called from
        // EmitStructMethodBodies — which also runs after interface bodies.
        // Pre-register it from the row structFirstMethodRows reserved for it
        // (PlanStructMethods above): the inline-struct ctor always occupies
        // the first of its reserved rows. Native positional data structs also
        // invoke their primary constructor. Pre-register their reserved rows
        // before class/interface bodies can construct a later-declared type.
        for s in nonSmStructs {
            if !s.ExplicitConstructors.IsDefaultOrEmpty && structFirstMethodRows.TryGetValue(
                s,
                out var explicitCtorRow
            ) {
                for constructor in s.ExplicitConstructors {
                    if constructor.IsSynthesizedFromPrimaryConstructor {
                        continue
                    }
                    this.cache.ExplicitCtorHandles[constructor] = MetadataTokens.MethodDefinitionHandle(
                        explicitCtorRow++
                    )
                }
            } else if s.IsInline && structFirstMethodRows.TryGetValue(s, out var inlineCtorRow) {
                this.cache.ClassPrimaryCtorHandles[s] = MetadataTokens.MethodDefinitionHandle(inlineCtorRow)
            }
            if s.HasSynthesizedDataConstructor && classPrimaryCtorRows.TryGetValue(s, out var dataPrimaryCtorRow) {
                let primaryHandle = MetadataTokens.MethodDefinitionHandle(dataPrimaryCtorRow)
                this.cache.ClassPrimaryCtorHandles[s] = primaryHandle
                // The overload symbol names the existing constructor row; it does not add another method.
                for constructor in s.ExplicitConstructors {
                    if constructor.IsSynthesizedFromPrimaryConstructor {
                        this.cache.ExplicitCtorHandles[constructor] = primaryHandle
                    }
                }
            }
        }
        // Same hazard, same fix, for a NAMED DELEGATE's ctor: an interface
        // body may perform a method-group -> named-delegate conversion
        // (`newobj` the delegate's compiler-provided ctor). DelegateCtorHandles
        // is normally registered inside EmitDelegateTypeDef, which runs after
        // interface bodies (see the Issue #1716 comment below). Pre-register
        // it here from the row already reserved in delegateCtorRows above.
        for d in delegates {
            this.cache.DelegateCtorHandles[d] = MetadataTokens.MethodDefinitionHandle(delegateCtorRows[d])
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
        for i in topInterfaces {
            EmitInterfaceMethodBodies(i)
        }
        // ADR-0059 / issue #255: emit named delegate TypeDefs immediately
        // after interfaces and before non-SM classes/structs. Each delegate's
        // TypeDef methodList points at the ctor row reserved above; the
        // runtime-implemented ctor and Invoke MethodDefs are added inside
        // EmitDelegateTypeDef.
        for d in delegates {
            this.typeDefEmitter.EmitDelegateTypeDef(d, delegateCtorRows[d])
        }
        // Issue #910 / ADR-0110: emit one class TypeDef row plus its
        // InterfaceImpl rows. Shared by the top-level class pass and the nested
        // block so nested classes are real CLR nested types with identical
        // interface-implementation metadata.
        let EmitClassTypeDefRow = func (c StructSymbol) {
            // Issue #1477: a synthesized closure / capture-box class reified
            // generic over enclosing type parameters needs its remap active so
            // its capture-field signatures encode the class's own VAR(idx)
            // slots. No-op for every other class (unregistered → restore:false).
            {
                using let _ = this.remaps.PushSmRemap(c)
                let gpRowStart = this.emitCtx.PendingGenericParameters.Count
                this.typeDefEmitter.EmitStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c])
                this.PreResolveReifiedGenericConstraints(gpRowStart)
                EmitInterfaceImplRows(c)
            }
        }
        // Issue #242: the ECMA-335 methodList column must be monotonically
        // non-decreasing across TypeDef rows. A struct without methods must use
        // the NEXT available method row — the first method row of the next
        // top-level struct that HAS methods, or the start of the nested-type
        // method block (firstNestedMethodRow) when none follows.
        let TopStructMethodListRow = func (s StructSymbol) int32 {
            if structFirstMethodRows.TryGetValue(s, out var firstStructMethodRow) {
                return firstStructMethodRow
            }
            var methodListRow = firstNestedMethodRow
            var foundSelf = false
            for s2 in topStructs {
                if object.ReferenceEquals(s2, s) {
                    foundSelf = true
                    continue
                }
                if foundSelf && structFirstMethodRows.TryGetValue(s2, out var nextMethodRow) {
                    methodListRow = nextMethodRow
                    break
                }
            }
            return methodListRow
        }
        // 2b. Emit non-SM class TypeDefs (so methodLists stay non-decreasing),
        // then non-SM struct TypeDefs. SM types are emitted AFTER <Program>.
        for c in topClasses {
            EmitClassTypeDefRow(c)
        }
        for s in topStructs {
            this.typeDefEmitter.EmitStructTypeDef(s, structFirstFieldRow[s], TopStructMethodListRow(s))
            EmitInterfaceImplRows(s)
        }
        // Issue #193: emit enum TypeDefs between non-SM structs and the nested
        // block. Each enum has no methods, so its methodList points at the
        // first nested-type method row (or firstPackageCtorRow when no nested
        // types follow — the two are equal in that case).
        for e in topEnums {
            this.typeDefEmitter.EmitEnumTypeDef(e, enumFirstFieldRow[e], firstNestedMethodRow)
        }
        // Issue #910 / ADR-0110: emit the unified nested-type block. Every
        // enclosing TypeDef row (top-level above, or an earlier nested row) is
        // already emitted, so each nested row satisfies ECMA-335 §II.22.32. The
        // NestedClass rows themselves are added in the post-pass below.
        for nested in nestedOrdered {
            switch nested {
                case ni is InterfaceSymbol {
                    this.typeDefEmitter.EmitInterfaceTypeDef(ni, interfaceFirstMethodRow[ni], nestedFieldListRow[ni])
                    EmitInterfaceBaseImplRows(ni)
                }
                case ns is StructSymbol when ns.IsClass {
                    EmitClassTypeDefRow(ns)
                }
                case ns is StructSymbol {
                    // Issue #1537: a nested struct reified over its enclosing +
                    // own type parameters needs its remap active so field
                    // signatures (and the TypeDef's own generic-param
                    // constraints) encode the correct re-ordinalized VAR(idx)
                    // slots. No-op for every other struct.
                    {
                        using let _ = this.remaps.PushSmRemap(ns)
                        let gpRowStart = this.emitCtx.PendingGenericParameters.Count
                        this.typeDefEmitter.EmitStructTypeDef(ns, structFirstFieldRow[ns], nestedMethodListRow[ns])
                        this.PreResolveReifiedGenericConstraints(gpRowStart)
                    }
                    EmitInterfaceImplRows(ns)
                }
                case ne is EnumSymbol {
                    this.typeDefEmitter.EmitEnumTypeDef(ne, enumFirstFieldRow[ne], nestedMethodListRow[ne])
                }
            }
        }
    }

    private func PlanPackageAndStateMachineMethods(
        generatedTypes GeneratedTypeSet,
        aggregateTypes AggregateTypeLayout,
        methodRows MethodRowPlan
    ) PackageMethodPlan {
        let lambdaLiterals = generatedTypes.LambdaLiterals
        let smClasses = aggregateTypes.Aggregates.StateMachineClasses
        let smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs
        let classCtorRows = methodRows.TypeRows.ClassConstructorRows
        let classPrimaryCtorRows = methodRows.TypeRows.ClassPrimaryConstructorRows
        let aggregateMethodHandles = methodRows.TypeRows.AggregateMethodHandles
        let entryPointIsClassOwned = methodRows.EntryPointIsClassOwned
        let structFirstMethodRows = methodRows.TypeRows.StructFirstRows
        let firstPackageCtorRow = methodRows.FirstPackageConstructorRow
        // 3. Group functions by their declaring package. One <Program> type
        //    is emitted per package, in BoundProgram.Packages declaration
        //    order; method-row layout for each package is:
        //        package initializer → [non-entry user fns] → [entry point if any]
        //    The initializer row is normally .ctor; a package with a decimal
        //    constant uses it for the required .cctor instead.
        //    The entry-point function (if any) is placed last in its package
        //    so the EntryPoint token resolves cleanly.
        var packages = if this.emitCtx.Program.Packages.IsDefaultOrEmpty {
            ImmutableArray.Create(this.emitCtx.Program.EntryPointPackage ?? PackageSymbol("Default", declaration: nil))
        } else {
            this.emitCtx.Program.Packages
        }
        let functionsByPackage = Dictionary[PackageSymbol, List[FunctionSymbol]]()
        for pkg in packages {
            functionsByPackage[pkg] = List[FunctionSymbol]()
        }
        // Issue #4663: deterministic order, never identity-hash order.
        for kvp in BoundProgramOrder.Functions(this.emitCtx.Program) {
            // Issue #3883: an AUTHORED async `Main` is NOT skipped here — it
            // needs its own ordinary (Task-returning) row alongside the
            // separate `<Main>$` entry-point stub reserved further below.
            if kvp.Key == this.emitCtx.Program.EntryPoint && !this.EntryPointNeedsSeparateStub {
                continue
            }
            // Class instance methods are owned by their class TypeDef, not by
            // a package's <Program> container.
            if kvp.Key.IsInstanceMethod {
                continue
            }
            // ADR-0053: static methods on structs/classes are emitted as part of
            // their owning TypeDef, not as package-level functions.
            if kvp.Key.IsStatic && aggregateMethodHandles.ContainsKey(kvp.Key) {
                continue
            }
            // ADR-0089 / issue #755: static-virtual interface members emit
            // as part of the interface's TypeDef, not as <Program>-hosted
            // top-level statics. The interface's emit phase already routed
            // these through EmitFunction.
            if kvp.Key.IsStatic && kvp.Key.StaticOwnerType is InterfaceSymbol {
                continue
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
            if kvp.Key.IsStatic && kvp.Key.StaticOwnerType is StructSymbol {
                continue
            }
            let owningPackage = kvp.Key.Package ?? this.emitCtx.Program.EntryPointPackage ?? packages[0]
            if !functionsByPackage.TryGetValue(owningPackage, out var bucket) {
                bucket = List[FunctionSymbol]()
                functionsByPackage[owningPackage] = bucket
                packages = packages.Add(owningPackage)
            }
            bucket.Add(kvp.Key)
        }
        let entryPointPackage PackageSymbol? = this
            .emitCtx
            .Program
            .EntryPoint
            ?.Package ??
            this
            .emitCtx
            .Program
            .EntryPointPackage
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
        for pkgKey in functionsByPackage.Keys.ToList() {
            functionsByPackage[pkgKey].Sort(SymbolSourceOrderComparer.Instance)
        }
        // Phase 4 emit parity (E1): non-capture function literals are attached
        // to the entry-point package's <Program> container as ordinary static
        // methods. Capture-bearing literals were already redirected into
        // closure-class invoke methods by SynthesizeClosures, so we skip them
        // here.
        let lambdaHostPackage = entryPointPackage ?? packages[0]
        if lambdaLiterals.Count > 0 {
            if !functionsByPackage.TryGetValue(lambdaHostPackage, out var hostBucket) {
                hostBucket = List[FunctionSymbol]()
                functionsByPackage[lambdaHostPackage] = hostBucket
                packages = packages.Add(lambdaHostPackage)
            }
            for literal in lambdaLiterals {
                if literal.CapturedVariables.Length > 0 {
                    continue
                }
                // Issue #1469: a non-capturing lambda lexically nested inside a
                // user type was rerouted by SynthesizeClosures into a display
                // class nested in that type (so it shares the type's
                // accessibility domain). Such a literal now carries a ClosureInfo
                // and its body is already registered against the synthesized
                // Invoke method, so it must NOT also be hosted as a top-level
                // <Program> static method.
                if this
                    .closures
                    .ClosureInfos
                    .ContainsKey(literal) ||
                    literal.Function is {LocalDeclaration: not nil, StaticOwnerType: not nil} {
                    continue
                }
                hostBucket.Add(literal.Function)
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
        let programEntryPackage PackageSymbol? = entryPointPackage ??
            (
            if packages.IsDefaultOrEmpty {
                default(PackageSymbol?)
            } else {
                packages[0]
            }
        )
        if programEntryPackage != nil && packages.Length > 0 && packages[0] != programEntryPackage {
            let reorderedPackages = ImmutableArray.CreateBuilder[PackageSymbol](packages.Length)
            reorderedPackages.Add(programEntryPackage)
            for pkg in packages {
                if pkg != programEntryPackage {
                    reorderedPackages.Add(pkg)
                }
            }
            packages = reorderedPackages.MoveToImmutable()
        }
        // Plan method rows for packages (initializer + functions + entry).
        let packageCtorRows = Dictionary[PackageSymbol, int32]()
        var nextRow = firstPackageCtorRow
        for pkg in packages {
            packageCtorRows[pkg] = nextRow
            nextRow++
            for fn in functionsByPackage[pkg] {
                this.cache.FunctionHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow)
                nextRow++
                nextRow = this.PlanLibraryImportInnerRow(fn, nextRow)
            }
            if this.emitCtx.Program.EntryPoint != nil && pkg == entryPointPackage && !entryPointIsClassOwned {
                let entryRow = MetadataTokens.MethodDefinitionHandle(nextRow++)
                // Issue #3883: for an authored async `Main` this row is the
                // synthesized `<Main>$` stub, NOT the authored function — the
                // authored function already has its own row (above, or on its
                // owning class's TypeDef), and cache.FunctionHandles must keep
                // pointing at THAT row so ordinary calls to `Main()` bind to
                // the Task-returning member.
                if this.EntryPointNeedsSeparateStub {
                    this.entryPointStubHandle = entryRow
                } else {
                    this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint!!] = entryRow
                }
            }
        }
        // Plan method rows for SM classes (after package methods).
        let firstSmClassMethodRow = nextRow
        for c in smClasses {
            classCtorRows[c] = nextRow
            nextRow++
            if c.HasPrimaryConstructor {
                classPrimaryCtorRows[c] = nextRow
                nextRow++
            }
            if !c.Methods.IsDefaultOrEmpty {
                for m in c.Methods {
                    let handle = MetadataTokens.MethodDefinitionHandle(nextRow++)
                    aggregateMethodHandles[m] = handle
                    this.cache.MethodHandles[m] = handle
                }
            }
        }
        // Plan method rows for SM structs (MoveNext + SetStateMachine each).
        for s in smStructsOrdered {
            structFirstMethodRows[s] = nextRow
            nextRow += 2 // MoveNext, SetStateMachine

        }
        var entryHandle = default(MethodDefinitionHandle)
        if this.emitCtx.Program.EntryPoint != nil {
            entryHandle = if this.EntryPointNeedsSeparateStub {
                this.entryPointStubHandle
            } else {
                (
                    if entryPointIsClassOwned {
                        aggregateMethodHandles[this.emitCtx.Program.EntryPoint]
                    } else {
                        this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint]
                    }
                )
            }
        }
        // Pre-register SM class ctor handles so iterator kickoff bodies
        // (emitted during B4) can reference them for newobj calls.
        for c in smClasses {
            this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(classCtorRows[c])
        }
        // Issue #503 / #523 / #920 / #1433: non-SM user class ctor handles
        // (ClassCtorHandles / ClassPrimaryCtorHandles / ExplicitCtorHandles)
        // are pre-registered from the planned rows earlier in this pass (see
        // the loop above, right before interface method bodies are emitted —
        // an interface body may itself `newobj` a class ctor), so no further
        // pre-registration is needed here before class method bodies below.
        return PackageMethodPlan(packages, functionsByPackage, entryPointPackage, packageCtorRows, entryHandle)
    }

    private func EmitProgramAndStateMachineTypeDefinitions(
        aggregateTypes AggregateTypeLayout,
        fieldRows FieldRowPlan,
        methodRows MethodRowPlan,
        packageMethods PackageMethodPlan
    ) Dictionary[PackageSymbol, TypeDefinitionHandle] {
        let smClasses = aggregateTypes.Aggregates.StateMachineClasses
        let smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs
        let structFirstFieldRow = fieldRows.AggregateFirstRows
        let globals = fieldRows.Globals
        let programFirstFieldRow = fieldRows.ProgramFirstRow
        let classCtorRows = methodRows.TypeRows.ClassConstructorRows
        let structFirstMethodRows = methodRows.TypeRows.StructFirstRows
        let packages = packageMethods.Packages
        let functionsByPackage = packageMethods.FunctionsByPackage
        let entryPointPackage PackageSymbol? = packageMethods.EntryPointPackage
        let packageCtorRows = packageMethods.ConstructorRows
        // === PHASE A: Emit remaining TypeDefs (Program + SM) ===
        // <Program> TypeDefs BEFORE SM TypeDefs (ECMA-335 §II.22.32: enclosing row < nested row).
        let programTypeDefHandles = Dictionary[PackageSymbol, TypeDefinitionHandle]()
        // Issue #191: emit global FieldDefs into the entry-point package's
        // <Program> field range. The entry-point package's <Program> TypeDef
        // is emitted first so its fieldList (= start of globals) is strictly
        // less than every subsequent <Program>'s fieldList (= past globals).
        let globalsHostPkg PackageSymbol? = entryPointPackage ??
            (
            if packages.IsDefaultOrEmpty {
                default(PackageSymbol?)
            } else {
                packages[0]
            }
        )
        if globals.Length > 0 && globalsHostPkg != nil && packages.Contains(globalsHostPkg) {
            // Globals whose type is a constructed generic (e.g. Box[int]) need
            // the alias map populated so EncodeTypeSymbol can resolve the
            // constructed StructSymbol to its definition's TypeDef. We call
            // RegisterConstructedTypeAliases again later (line 798) to pick
            // up ctor handles populated during the rest of Phase A.
            this.methodBodyPlanner.RegisterConstructedTypeAliases()
            this.functions.EmitGlobalFieldDefs(globals)
            let programHandle = this
                .emitCtx
                .Metadata
                .AddTypeDefinition(
                attributes: TypeAttributes.Class | ProgramHostAccessibility(
                    globalsHostPkg,
                    this.emitCtx.Program.EntryPoint != nil,
                    packageMethods
                ) | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | TypeAttributes.Sealed | TypeAttributes.Abstract,
                namespace: this.emitCtx.Metadata.GetOrAddString(globalsHostPkg.Name),
                name: this.emitCtx.Metadata.GetOrAddString("<Program>"),
                baseType: this.wellKnown.ObjectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(programFirstFieldRow),
                methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[globalsHostPkg])
            )
            programTypeDefHandles[globalsHostPkg] = programHandle
            this.customAttrEncoder.EmitNullableContextAttributeOnType(programHandle, NullableFlagsBuilder.NotAnnotated)
        }
        for pkg in packages {
            if programTypeDefHandles.ContainsKey(pkg) {
                continue
            }
            // Packages without globals (or non-entry-point packages when globals
            // were emitted above) point their fieldList past the global field
            // range so the monotone <Program> fieldList constraint holds.
            let fieldListRow = programFirstFieldRow + globals.Length
            let programHandle = this
                .emitCtx
                .Metadata
                .AddTypeDefinition(
                attributes: TypeAttributes.Class | ProgramHostAccessibility(
                    pkg,
                    this.emitCtx.Program.EntryPoint != nil,
                    packageMethods
                ) | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | TypeAttributes.Sealed | TypeAttributes.Abstract,
                namespace: this.emitCtx.Metadata.GetOrAddString(pkg.Name),
                name: this.emitCtx.Metadata.GetOrAddString("<Program>"),
                baseType: this.wellKnown.ObjectTypeRef,
                fieldList: MetadataTokens.FieldDefinitionHandle(fieldListRow),
                methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[pkg])
            )
            programTypeDefHandles[pkg] = programHandle
            this.customAttrEncoder.EmitNullableContextAttributeOnType(programHandle, NullableFlagsBuilder.NotAnnotated)
        }
        // Issue #792 / ADR-0084. Stamp [ExtensionAttribute] on every
        // <Program> TypeDef that hosts at least one top-level extension
        // function. C# extension-method discovery (ECMA-334 §13.6.9)
        // requires both the host static class and each candidate static
        // method to carry the marker; the per-method marker lands in
        // EmitFunction.
        for pkg in packages {
            if !programTypeDefHandles.TryGetValue(pkg, out var programHandle) {
                continue
            }
            if !functionsByPackage.TryGetValue(pkg, out var pkgFuncs) {
                continue
            }
            var hostsAnyExtension = false
            for f in pkgFuncs {
                if f.IsExtension && !f.IsInstanceMethod {
                    hostsAnyExtension = true
                    break
                }
            }
            if hostsAnyExtension {
                this.EmitExtensionAttribute(programHandle)
            }
        }
        // Issue #4234: the same [ExtensionAttribute] marker, but for a
        // user-declared class hosting an `@ExtensionOwner`-routed extension
        // function (TypeDefEmitter.ResolveStructTypeShape already forced its
        // TypeDef Abstract+Sealed for exactly this case). Every such class
        // TypeDef row was already emitted by this point — TypeDefs precede
        // the per-package <Program> rows just stamped above.
        for kvp in this.cache.StructTypeDefs {
            if TypeDefEmitter.HostsExtensionMethod(kvp.Key) {
                this.EmitExtensionAttribute(kvp.Value)
            }
        }
        // SM class TypeDefs (sync iterators + async iterators).
        for c in smClasses {
            // Issue #810: when the iterator state-machine class is generic
            // over the outer method's type parameters, push the per-SM
            // remap so EncodeTypeSymbol translates outer-method TP
            // references to the SM class's own TP slots (Var(idx)) while
            // encoding field signatures and interface implementations.
            {
                using let _ = this.remaps.PushSmRemap(c)
                let gpRowStart = this.emitCtx.PendingGenericParameters.Count
                this.typeDefEmitter.EmitNestedStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c])
                this.PreResolveReifiedGenericConstraints(gpRowStart)
                if this.stateMachines.IteratorStateMachineInfos.TryGetValue(c, out var iteratorInfo) {
                    this.methodBodyPlanner.AddIteratorInterfaceImplementations(c, iteratorInfo)
                }
                if this.stateMachines.AsyncIteratorInfos.TryGetValue(c, out var asyncIterPlan) {
                    this.methodBodyPlanner.AddAsyncIteratorInterfaceImplementations(c, asyncIterPlan)
                }
            }
        }
        // SM struct TypeDefs (async method/lambda state machines).
        for s in smStructsOrdered {
            let smMethodListRow = structFirstMethodRows[s]
            // Issue #1465: push the SM's enclosing-type/method TP → SM-TP
            // remap so hoisted-field signatures (e.g. `<>4__this`) translate
            // method-type-parameter references into the SM type's own Var
            // slots. A no-op when the SM is non-generic.
            {
                using let _ = this.remaps.PushSmRemap(s)
                this.typeDefEmitter.EmitNestedStructTypeDef(s, structFirstFieldRow[s], smMethodListRow)
            }
            let iAsyncSmType = typeof(IAsyncStateMachine)
            let iAsyncSmRef = this.memberRefs.GetTypeReference(iAsyncSmType)
            this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[s], iAsyncSmRef)
        }
        return programTypeDefHandles
    }

    // B1. Interface methods (abstract + default-interface methods).
    private func EmitInterfaceMethodBodies(i InterfaceSymbol) {
        for m in i.Methods {
            // ADR-0085 / issue #726: a default-interface method (the
            // method's declaring syntax carries a non-null Body) is
            // emitted as a normal virtual MethodDef with a real body —
            // the EmitFunction pipeline handles signature, body, and
            // ParameterRow plumbing, and the receiver-is-interface
            // branch above stamps it as Public | Virtual | NewSlot
            // (no Final, no Abstract). Abstract interface methods
            // (no body) continue to use EmitAbstractMethod.
            if InterfaceSymbol.HasDefaultBody(m) && this.emitCtx.Program.Functions.TryGetValue(m, out var dimBody) {
                let emittedHandle = this.functions.EmitFunction(m, dimBody, isEntryPoint: false)
                this.cache.MethodHandles[m] = emittedHandle
            } else {
                this.typeDefEmitter.EmitAbstractMethod(m)
            }
        }
        // ADR-0089 / issue #755: emit static-virtual interface members.
        // When the declaration carries a default body, route through
        // EmitFunction (which handles signature + IL body + parameter
        // rows). When there is no body, emit a Static|Virtual|Abstract
        // MethodDef with no IL.
        for sm in i.StaticMethods {
            if InterfaceSymbol.HasDefaultBody(sm) && this.emitCtx.Program.Functions.TryGetValue(sm, out var defBody) {
                let emittedHandle = this.functions.EmitFunction(sm, defBody, isEntryPoint: false)
                this.cache.MethodHandles[sm] = emittedHandle
            } else {
                this.typeDefEmitter.EmitStaticVirtualMethod(sm, hasBody: false, bodyOffset: -1)
            }
        }
        // ADR-0090 / issue #756: emit private interface helper methods
        // (instance and static). These always carry a body (GS0335
        // enforces this); skip if for some reason the body is missing.
        if !i.PrivateMethods.IsDefaultOrEmpty {
            for pm in i.PrivateMethods {
                if this.emitCtx.Program.Functions.TryGetValue(pm, out var pBody) {
                    let emittedHandle = this.functions.EmitFunction(pm, pBody, isEntryPoint: false)
                    this.cache.MethodHandles[pm] = emittedHandle
                }
            }
        }
        if !i.StaticPrivateMethods.IsDefaultOrEmpty {
            for spm in i.StaticPrivateMethods {
                if this.emitCtx.Program.Functions.TryGetValue(spm, out var sBody) {
                    let emittedHandle = this.functions.EmitFunction(spm, sBody, isEntryPoint: false)
                    this.cache.MethodHandles[spm] = emittedHandle
                }
            }
        }
        // Issue #248: emit abstract accessor MethodDefs + PropertyDef rows for interface properties.
        this.memberDefEmitter.EmitInterfacePropertyAccessors(i)
        // ADR-0149 (issue #944 follow-up): mirror EmitDefaultMemberAttributeIfIndexer
        // (struct/class-side) for an interface that declares its own
        // indexer contract.
        this.EmitDefaultMemberAttributeIfIndexer(i)
        // ADR-0052: emit abstract accessor MethodDefs + EventDef rows for interface events.
        this.memberDefEmitter.EmitInterfaceEventAccessors(i)
        // ADR-0089 / issue #1030: emit the interface .cctor running static
        // field initializers. Emitted LAST (after property/event accessors)
        // to match the row reserved in PlanInterfaceMethods.
        if !i.StaticFieldInitializers.IsEmpty || ConstantFieldMetadataEmitter.ContainsRuntimeInitializedConstant(
            i.ConstFields
        ) {
            this.ctorBodies.EmitInterfaceStaticConstructor(i)
        }
    }

    private func EmitRemainingMethodDefinitions(
        generatedTypes GeneratedTypeSet,
        aggregateTypes AggregateTypeLayout,
        methodRows MethodRowPlan,
        packageMethods PackageMethodPlan
    ) {
        let asyncSmPlansByStruct = generatedTypes.AsyncStateMachinePlansByStruct
        let smClasses = aggregateTypes.Aggregates.StateMachineClasses
        let smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs
        let topClasses = aggregateTypes.TopLevel.Classes
        let topStructs = aggregateTypes.TopLevel.Structs
        let nestedOrdered = aggregateTypes.NestedTypes.Types
        let entryPointIsClassOwned = methodRows.EntryPointIsClassOwned
        let packages = packageMethods.Packages
        let functionsByPackage = packageMethods.FunctionsByPackage
        let entryPointPackage = packageMethods.EntryPointPackage
        // === PHASE B: Emit MethodDefs in row order ===
        // B2. Non-SM class ctors + instance methods.
        let EmitClassMethodBodies = func (c StructSymbol) {
            if c.ExplicitConstructor != nil {
                // Issue #306 / ADR-0063 §9: a class with explicit `init(...)`
                // constructors emits one `.ctor` per declared overload. The first
                // overload also serves as the legacy classCtor/primaryCtor handle.
                // ADR-0065 §5: when the class also declares a primary-ctor
                // parameter list, the first overload is a synthesized
                // designated init whose body is the conventional primary-ctor
                // field-assignment sequence — route it through
                // EmitClassPrimaryConstructor instead of the user-body path.
                var firstHandle = default(MethodDefinitionHandle)
                var firstAssigned = false
                for explicitCtor in c.ExplicitConstructors {
                    var ctorHandle MethodDefinitionHandle
                    if explicitCtor.IsSynthesizedFromPrimaryConstructor {
                        // The synthesized primary follows the same emission
                        // shape as a primary-ctor-only class. If the class
                        // declaration also carries `: Base(args)`, that base
                        // initializer must be honored — route through the
                        // forwarding-ctor emitter; otherwise emit the plain
                        // primary-ctor shape (default chain to `object::.ctor`
                        // or the parameterless base).
                        if c.BaseConstructorInitializer != nil {
                            ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBaseInitializer(
                                c,
                                c.PrimaryConstructorParameters
                            )
                        } else {
                            ctorHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c)
                        }
                    } else {
                        ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBody(c, explicitCtor)
                    }
                    this.cache.ExplicitCtorHandles[explicitCtor] = ctorHandle
                    if !firstAssigned {
                        firstHandle = ctorHandle
                        firstAssigned = true
                    }
                }
                this.cache.ClassCtorHandles[c] = firstHandle
                this.cache.ClassPrimaryCtorHandles[c] = firstHandle
            } else if c.BaseConstructorInitializer != nil {
                // Issue #306: emit a single constructor that forwards arguments
                // to the resolved base ctor. When a primary constructor is
                // present its parameters drive both the forwarded arguments and
                // the field initialization; otherwise the forwarding ctor is
                // parameterless (constant base arguments). No separate
                // parameterless ctor is emitted because the base may lack one.
                let ctorParams = if c.HasPrimaryConstructor {
                    c.PrimaryConstructorParameters
                } else {
                    ImmutableArray[ParameterSymbol].Empty
                }
                let forwardingHandle = this.typeDefEmitter.EmitClassConstructorWithBaseInitializer(c, ctorParams)
                this.cache.ClassCtorHandles[c] = forwardingHandle
                this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle
            } else {
                if c.IsData && c.HasPrimaryConstructor {
                    this.cache.ClassPrimaryCtorHandles[c] = this.typeDefEmitter.EmitClassPrimaryConstructor(c)
                } else {
                    let ctorHandle = this.typeDefEmitter.EmitClassDefaultConstructor(c)
                    this.cache.ClassCtorHandles[c] = ctorHandle
                    if c.HasPrimaryConstructor {
                        this.cache.ClassPrimaryCtorHandles[c] = this.typeDefEmitter.EmitClassPrimaryConstructor(c)
                    }
                }
            }
            if !c.IsData && this.cache.DataClassCopyConstructorHandles.ContainsKey(c) {
                this.dataStructSynth.EmitDataClassCopyConstructor(c)
            }
            // Issue #2228: emit the seven synthesized members for a `data
            // class` (Equals(object), Equals(Name), GetHashCode, ToString,
            // op_Equality, op_Inequality, Deconstruct) BEFORE user-declared
            // methods, matching PlanClassMethods' reservation order above.
            // Without this a `data class` silently falls back to reference
            // identity for `==`/`.Equals`/`GetHashCode` (inherited from
            // System.Object), which is exactly the ADR-0029 value-equality
            // contract a data type promises.
            if c.IsData {
                this.dataStructSynth.EmitDataStructSynthesizedMembers(c)
            }
            if !c.Methods.IsDefaultOrEmpty {
                for m in c.Methods {
                    if !this.emitCtx.Program.Functions.TryGetValue(m, out var body) {
                        body = this.lambdaBodies[m]
                    }
                    let emittedHandle = this.functions.EmitFunction(m, body, isEntryPoint: false)
                    this.cache.MethodHandles[m] = emittedHandle
                }
            }
            // ADR-0068 / issue #698: emit the synthesized `Finalize` override
            // produced by the class's `deinit { … }` body. The emitted method
            // wraps the lowered user body in `try { … } finally { base.Finalize(); }`.
            if c.Deinitializer != nil &&
                this
                .emitCtx
                .Program
                .Functions
                .TryGetValue(c.Deinitializer!!.Function, out var deinitBody) {
                let deinitHandle = this.typeDefEmitter.EmitClassDeinitializer(c, c.Deinitializer!!, deinitBody)
                this.cache.MethodHandles[c.Deinitializer!!.Function] = deinitHandle
            }
            // ADR-0051 Phase 6: emit property accessor methods for classes.
            this.memberDefEmitter.EmitPropertyAccessors(c)
            // cs2gs uses this stable synthetic-name shape for translated C#
            // anonymous types. Keep data-class value semantics, but omit the
            // record-only EqualityContract PropertyInfo that reflection-based
            // consumers such as EF Core would mistake for an anonymous member.
            if c.IsData && !IsTranslatedAnonymousType(c.Name) {
                this.dataStructSynth.EmitDataClassEqualityContractProperty(c)
            }
            this.EmitDefaultMemberAttributeIfIndexer(c)
            // ADR-0052: emit event accessor methods for classes.
            this.memberDefEmitter.EmitEventAccessors(c)
            this.interfaceImpls.EmitInheritedEventBridges(c)
            this.interfaceImpls.EmitImportedAccessorBridges(c)
            // ADR-0053: emit static methods for classes.
            if !c.StaticMethods.IsDefaultOrEmpty {
                for m in c.StaticMethods {
                    if this.emitCtx.Program.Functions.TryGetValue(m, out var staticBody) {
                        // Issue #1996: a class-scoped static `Main` is the PE
                        // entry point when picked by ResolveEntryPoint — wire
                        // isEntryPoint through so EmitFunction applies the same
                        // async-Main sync-wrapper lowering (GetAwaiter().GetResult())
                        // used for package-scope entry points.
                        // Issue #3883: an authored async `Main` is emitted here
                        // as an ORDINARY static method (Task-returning); the
                        // CLR entry-point shape lives on the separate
                        // `<Main>$` stub emitted right after this loop.
                        let emittedHandle = this.functions.EmitFunction(
                            m,
                            staticBody,
                            isEntryPoint: m == this.emitCtx.Program.EntryPoint && !this.EntryPointNeedsSeparateStub
                        )
                        this.cache.MethodHandles[m] = emittedHandle
                    }
                }
                // Issue #3883: the synthesized `<Main>$` entry-point stub for
                // this class's authored async `Main` — a second kickoff body
                // over the same state machine, encoded with the CLR
                // entry-point signature and driven to completion
                // synchronously. Its row was reserved by PlanClassMethods
                // immediately after the static-method rows.
                //
                // ClassOwnsEntryPointStub is only true when Program.EntryPoint
                // is non-null (it is one of this class's StaticMethods), so
                // the two `!`s below are guarded by the preceding conjunct.
                if this.ClassOwnsEntryPointStub(c) &&
                    this
                    .emitCtx
                    .Program
                    .Functions
                    .TryGetValue(this.emitCtx.Program.EntryPoint!!, out var stubBody) {
                    this.functions.EmitFunction(
                        this.emitCtx.Program.EntryPoint!!,
                        stubBody,
                        isEntryPoint: true,
                        isSynthesizedEntryPointStub: true
                    )
                }
            }
            // Issue #263: emit static property accessor methods for classes.
            this.memberDefEmitter.EmitStaticPropertyAccessors(c)
            // Issue #263: emit static event accessor methods for classes.
            this.memberDefEmitter.EmitStaticEventAccessors(c)
            // Issue #262: emit .cctor for classes with static field initializers.
            if this.cache.CctorHandles.ContainsKey(c) {
                this.typeDefEmitter.EmitStaticConstructor(c)
            }
            // ADR-0089 / issue #755: emit MethodImpl rows for static-virtual
            // interface members. See structs path for the same call.
            this.interfaceImpls.EmitStaticVirtualMethodImpls(c)
            this.interfaceImpls.EmitClrStaticVirtualMethodImpls(c)
            // ADR-0089 / issue #1019: emit MethodImpl rows for static-virtual
            // interface properties (accessor methods).
            this.interfaceImpls.EmitStaticVirtualPropertyMethodImpls(c)
            // Issue #985: emit MethodImpl rows for covariant-return interface
            // bridges (e.g. the non-generic IEnumerable.GetEnumerator).
            this.interfaceImpls.EmitExplicitInterfaceMethodImpls(c)
            // Issue #2443: bind overrides to virtual members inherited from an
            // imported CLR base class (including covariant-return slots).
            this.interfaceImpls.EmitExternalBaseMethodImpls(c)
            // Issue #2362: emit MethodImpl rows for mangled-name explicit
            // interface property implementations (accessor methods).
            this.interfaceImpls.EmitExplicitInterfacePropertyMethodImpls(c)
            // ADR-0149: emit MethodImpl rows for explicit-interface-clause
            // event implementations (add/remove/raise accessors).
            this.interfaceImpls.EmitExplicitInterfaceEventMethodImpls(c)
            // Issues #2718/#2742: bind custom and inherited event accessors
            // directly to matching user/imported interface event slots.
            this.interfaceImpls.EmitImplicitEventMethodImpls(c)
        }
        for c in topClasses {
            // Issue #1477: keep the synthesized closure / capture-box class's
            // remap active while emitting its ctor + Invoke bodies/signatures
            // so enclosing type-parameter references resolve to the class's own
            // VAR(idx) slots. No-op for every other class.
            {
                using let _ = this.remaps.PushSmRemap(c)
                EmitClassMethodBodies(c)
            }
        }
        // 4b. Non-SM struct methods.
        let EmitStructMethodBodies = func (s StructSymbol) {
            if !s.ExplicitConstructors.IsDefaultOrEmpty {
                for explicitCtor in s.ExplicitConstructors {
                    if explicitCtor.IsSynthesizedFromPrimaryConstructor {
                        continue
                    }
                    let ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBody(s, explicitCtor)
                    this.cache.ExplicitCtorHandles[explicitCtor] = ctorHandle
                }
            }
            if s.IsInline {
                this.dataStructSynth.EmitInlineStructSynthesizedMembers(s)
            } else if s.IsData {
                // Issue #410 / ADR-0029: emit synthesized members BEFORE
                // user-declared methods so the MethodDef rows match the
                // planning order (the first 7 rows reserved by the planner).
                this.dataStructSynth.EmitDataStructSynthesizedMembers(s)
            }
            // Issue #3219: the synthesized value-struct default ctor is the
            // struct's LAST planned row — emitted at the tail of this method,
            // so the early-out below must not skip a struct whose only row is
            // that ctor.
            let emitsSynthesizedDefaultCtor = ConstructorBodyEmitter.NeedsSynthesizedValueStructDefaultCtor(s) &&
                (!s.IsData || s.NeedsValueStructZeroHelper)
            if s
                .Methods
                .IsDefaultOrEmpty &&
                s
                .ExplicitConstructors
                .IsDefaultOrEmpty &&
                s
                .Properties
                .IsDefaultOrEmpty &&
                s
                .Events
                .IsDefaultOrEmpty &&
                s
                .StaticMethods
                .IsDefaultOrEmpty &&
                s
                .StaticProperties
                .IsDefaultOrEmpty &&
                s
                .StaticEvents
                .IsDefaultOrEmpty &&
                s
                .StaticFieldInitializers
                .IsEmpty &&
                !ConstantFieldMetadataEmitter.ContainsRuntimeInitializedConstant(s.ConstFields) &&
                !s
                .HasStaticInitializerBlock {
                if emitsSynthesizedDefaultCtor {
                    this.typeDefEmitter.EmitValueStructDefaultConstructor(s)
                }
                return
            }
            for m in s.Methods {
                if !this.emitCtx.Program.Functions.TryGetValue(m, out var body) {
                    body = this.lambdaBodies[m]
                }
                let emittedHandle = this.functions.EmitFunction(m, body, isEntryPoint: false)
                this.cache.MethodHandles[m] = emittedHandle
            }
            // ADR-0051 Phase 6: emit property accessor methods for structs.
            this.memberDefEmitter.EmitPropertyAccessors(s)
            this.EmitDefaultMemberAttributeIfIndexer(s)
            // ADR-0052: emit event accessor methods for structs.
            this.memberDefEmitter.EmitEventAccessors(s)
            // ADR-0053: emit static methods for structs.
            if !s.StaticMethods.IsDefaultOrEmpty {
                for m in s.StaticMethods {
                    if this.emitCtx.Program.Functions.TryGetValue(m, out var staticBody) {
                        let emittedHandle = this.functions.EmitFunction(m, staticBody, isEntryPoint: false)
                        this.cache.MethodHandles[m] = emittedHandle
                    }
                }
            }
            // Issue #263: emit static property accessor methods for structs.
            this.memberDefEmitter.EmitStaticPropertyAccessors(s)
            // Issue #263: emit static event accessor methods for structs.
            this.memberDefEmitter.EmitStaticEventAccessors(s)
            // Issue #262: emit .cctor for structs with static field initializers.
            if this.cache.CctorHandles.ContainsKey(s) {
                this.typeDefEmitter.EmitStaticConstructor(s)
            }
            // ADR-0089 / issue #755: emit MethodImpl rows for static-virtual
            // interface members. The CLR (per ECMA-335 §II.10.3.3 with the
            // C# 11 / .NET 7 static-virtual extension) cannot pair an
            // implementer's static method with an interface's static-virtual
            // slot by name+signature alone — an explicit MethodImpl row is
            // required so `constrained.` dispatch finds the right body. The
            // row points the interface slot's MethodDef at the implementer's
            // static MethodDef on the struct's TypeDef.
            this.interfaceImpls.EmitStaticVirtualMethodImpls(s)
            this.interfaceImpls.EmitClrStaticVirtualMethodImpls(s)
            // ADR-0089 / issue #1019: emit MethodImpl rows for static-virtual
            // interface properties (accessor methods).
            this.interfaceImpls.EmitStaticVirtualPropertyMethodImpls(s)
            // Issue #985: emit MethodImpl rows for covariant-return interface
            // bridges declared on a struct that implements `IEnumerable[T]` &c.
            this.interfaceImpls.EmitExplicitInterfaceMethodImpls(s)
            this.interfaceImpls.EmitExternalBaseMethodImpls(s)
            // Issue #2362: emit MethodImpl rows for mangled-name explicit
            // interface property implementations (accessor methods).
            this.interfaceImpls.EmitExplicitInterfacePropertyMethodImpls(s)
            // ADR-0149: emit MethodImpl rows for explicit-interface-clause
            // event implementations (add/remove/raise accessors).
            this.interfaceImpls.EmitExplicitInterfaceEventMethodImpls(s)
            // Issue #3219: emit the synthesized value-struct default ctor at
            // the tail so its MethodDef lands on the last planned row.
            if emitsSynthesizedDefaultCtor {
                this.typeDefEmitter.EmitValueStructDefaultConstructor(s)
            }
            // Issues #2718/#2742: see the class path above.
            this.interfaceImpls.EmitImplicitEventMethodImpls(s)
        }
        for s in topStructs {
            EmitStructMethodBodies(s)
        }
        // B3.5 / Issue #910 / ADR-0110: emit method bodies for the unified
        // nested-type block, in the same pre-order the rows were planned and
        // the TypeDefs emitted, so MethodDef row order stays consistent.
        for nested in nestedOrdered {
            switch nested {
                case ni is InterfaceSymbol {
                    EmitInterfaceMethodBodies(ni)
                }
                case ns is StructSymbol when ns.IsClass {
                    // Issue #1477: a closure / capture-box class synthesized for
                    // a lambda inside a GENERIC METHOD is nested in the (possibly
                    // non-generic) declaring type and was reified generic over
                    // the method's type parameters; push its remap so the Invoke
                    // signature + body translate method-TP references to the
                    // class's own Var slots. No-op for every other nested class.
                    {
                        using let _ = this.remaps.PushSmRemap(ns)
                        EmitClassMethodBodies(ns)
                    }
                }
                case ns is StructSymbol {
                    // Issue #1465: async state-machine structs are reified
                    // over their enclosing-type/method type parameters; push
                    // the SM TP remap so MoveNext bodies and signatures
                    // translate method-TP references to the SM's own Var
                    // slots. A no-op for non-generic structs.
                    {
                        using let _ = this.remaps.PushSmRemap(ns)
                        EmitStructMethodBodies(ns)
                    }
                }
            }
        }
        // Phase 4 emit parity (F2, type-erased): now that every generic
        // definition has its TypeDef + FieldDefs + ctor handles in the
        // lookup dictionaries, walk the bound program for constructed
        // StructSymbols (Box[int], Pair[string, int], ...) and alias them
        // to their definitions' rows.
        this.methodBodyPlanner.RegisterConstructedTypeAliases()
        // B4. Per-package methods (initializer + user functions + entry).
        let runtimePackageConstants = this
            .emitCtx
            .Program
            .Globals
            .Where(
            (global GlobalVariableSymbol) -> global.IsConst &&
                ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(global.ConstantValue)
        )
            .ToImmutableArray()
        for pkg in packages {
            if pkg == entryPointPackage && !runtimePackageConstants.IsDefaultOrEmpty {
                this.ctorBodies.EmitProgramStaticConstructor(pkg, runtimePackageConstants)
            } else {
                this.typeDefEmitter.EmitDefaultConstructor()
            }
            for fn in functionsByPackage[pkg] {
                if !this.emitCtx.Program.Functions.TryGetValue(fn, out var body) {
                    body = this.lambdaBodies[fn]
                }
                // Issue #2118: a generic-promoted non-capturing lambda's
                // signature and body reference the enclosing type parameters;
                // push the remap so they encode as this method's own MVar slots.
                {
                    using let _ = this.remaps.PushLambdaMethodRemap(fn)
                    this.functions.EmitFunction(fn, body, isEntryPoint: false)
                }
            }
            if this.emitCtx.Program.EntryPoint != nil && pkg == entryPointPackage && !entryPointIsClassOwned {
                let entryBody = this.emitCtx.Program.Functions[this.emitCtx.Program.EntryPoint]
                this.functions.EmitFunction(
                    this.emitCtx.Program.EntryPoint,
                    entryBody,
                    isEntryPoint: true,
                    isSynthesizedEntryPointStub: this.EntryPointNeedsSeparateStub
                )
            }
        }
        // B5. SM class method bodies (ctors + instance methods).
        for c in smClasses {
            // Issue #810: push the SM's outer-method-TP → class-TP remap so
            // that method signatures (return type, parameter types) and
            // bodies emitted for SM members translate outer-method TP
            // references to the SM class's own TP slots (Var(idx)).
            {
                using let _ = this.remaps.PushSmRemap(c)
                let ctorHandle = this.typeDefEmitter.EmitClassDefaultConstructor(c)
                this.cache.ClassCtorHandles[c] = ctorHandle
                if c.HasPrimaryConstructor {
                    let primaryHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c)
                    this.cache.ClassPrimaryCtorHandles[c] = primaryHandle
                }
                if !c.Methods.IsDefaultOrEmpty {
                    for m in c.Methods {
                        if !this.emitCtx.Program.Functions.TryGetValue(m, out var body) {
                            body = this.lambdaBodies[m]
                        }
                        // Iterator interfaces are attached directly to metadata, not
                        // to the receiver symbol. Every synthesized method here
                        // implements one of those slots and must remain virtual.
                        let emittedHandle = this.functions.EmitFunction(
                            m,
                            body,
                            isEntryPoint: false,
                            isInterfaceImplementation: true
                        )
                        this.cache.MethodHandles[m] = emittedHandle
                    }
                }
            }
        }
        // B6. SM struct method bodies (MoveNext + SetStateMachine).
        for s in smStructsOrdered {
            if asyncSmPlansByStruct.TryGetValue(s, out var smPlan) {
                // Issue #2030 (gap 2): mirror the TypeDef emission above —
                // MoveNext/SetStateMachine bodies must see the same
                // outer-method-TP → SM-TP remap as the FieldDefs, or a
                // reference to a hoisted field/local whose declared type was
                // the kickoff's own type parameter (e.g. the retVal local for
                // `async func Foo[U](x U) U`) encodes as a dangling method
                // type-var (`!!0`) instead of the SM's own class type-var
                // (`!0`) — unverifiable IL / BadImageFormatException at load.
                {
                    using let _ = this.remaps.PushSmRemap(s)
                    this.stateMachines.EmitStateMachineMoveNext(smPlan)
                    this.stateMachines.EmitStateMachineSetStateMachine(smPlan)
                }
            }
        }
    }

    private func EmitNestedTypeRows(
        aggregateTypes AggregateTypeLayout,
        packageMethods PackageMethodPlan,
        programTypeDefHandles Dictionary[PackageSymbol, TypeDefinitionHandle]
    ) {
        let smClasses = aggregateTypes.Aggregates.StateMachineClasses
        let smStructsOrdered = aggregateTypes.Aggregates.StateMachineStructs
        let nestedOrdered = aggregateTypes.NestedTypes.Types
        let packages = packageMethods.Packages
        let entryPointPackage PackageSymbol? = packageMethods.EntryPointPackage
        // Issue #910 / ADR-0110: NestedClass rows for user-declared nested
        // types (class/struct/enum/interface declared inside a class/struct
        // body). The enclosing TypeDef row was emitted before the nested row
        // (ECMA-335 §II.22.32) because of the kind-partitioned emission order;
        // see BindNestedTypeDeclarations and the emission-order notes above.
        // Direct generic-local hosts can also be nested in an interface.
        let AddUserNestedTypeRow = func (nested TypeSymbol, nestedHandle TypeDefinitionHandle) {
            let containing TypeSymbol? = switch nested {
                case ss is StructSymbol: ss.ContainingType
                case es is EnumSymbol: es.ContainingType
                case ifs is InterfaceSymbol: ifs.ContainingType
                default: default(TypeSymbol?)
            }
            if containing is StructSymbol enclosingStruct &&
                this
                .cache
                .StructTypeDefs
                .TryGetValue(enclosingStruct, out var enclosingHandle) {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle)
            } else if containing is InterfaceSymbol enclosingInterface &&
                this
                .cache
                .InterfaceTypeDefs
                .TryGetValue(enclosingInterface, out var interfaceHandle) {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, interfaceHandle)
            }
        }
        // Issue #910 / ADR-0110: emit NestedClass rows in the same pre-order
        // the nested TypeDef rows were assigned. The NestedClass metadata table
        // must be sorted by the nested-type RID; nestedOrdered yields nested
        // handles in monotonically increasing RID order, so iterating it keeps
        // the table sorted across all nested kinds (class/struct/enum/interface).
        for nested in nestedOrdered {
            switch nested {
                case ns is StructSymbol when this.cache.StructTypeDefs.TryGetValue(ns, out var nsh) {
                    AddUserNestedTypeRow(ns, nsh)
                }
                case ne is EnumSymbol when this.cache.EnumTypeDefs.TryGetValue(ne, out var neh) {
                    AddUserNestedTypeRow(ne, neh)
                }
                case ni is InterfaceSymbol when this.cache.InterfaceTypeDefs.TryGetValue(ni, out var nih) {
                    AddUserNestedTypeRow(ni, nih)
                }
            }
        }
        // NestedType entries. Each SM is nested inside its declaring type:
        // capture-bearing async lambda SMs inside their closure class,
        // an instance-method kickoff's SM inside the receiver type (so the
        // kickoff method retains access to the SM's `<>t__builder` field —
        // issue #502), and all others inside the per-package <Program>.
        let hostPkg PackageSymbol? = entryPointPackage ??
            (
            if packages.IsDefaultOrEmpty {
                default(PackageSymbol?)
            } else {
                packages[0]
            }
        )
        let defaultProgramHandle = if hostPkg != nil && programTypeDefHandles.TryGetValue(hostPkg, out var h) {
            h
        } else {
            default(TypeDefinitionHandle)
        }
        for c in smClasses {
            let nestedHandle = this.cache.StructTypeDefs[c]
            this.EmitCompilerGeneratedAttribute(nestedHandle)
            if this.methodBodyPlanner.TryGetUserKickoffReceiverHandle(c, out var receiverEnclosing) {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, receiverEnclosing)
                continue
            }
            // A program with no packages at all resolves no state-machine
            // package either; such a state machine nests in the default
            // <Program>, which is the same fallback the lookup miss takes.
            let smPkg PackageSymbol? = this.methodBodyPlanner.GetSmPackage(c, packages, entryPointPackage)
            let enclosingHandle = if smPkg != nil && programTypeDefHandles.TryGetValue(smPkg, out var ph) {
                ph
            } else {
                defaultProgramHandle
            }
            this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle)
        }
        for s in smStructsOrdered {
            let nestedHandle = this.cache.StructTypeDefs[s]
            var enclosingTypeName string
            if this
                .stateMachines
                .AsyncSmEnclosingClosures
                .TryGetValue(s, out var closureSym) &&
                this
                .cache
                .StructTypeDefs
                .TryGetValue(closureSym, out var closureHandle) {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, closureHandle)
                enclosingTypeName = CustomAttributeEncoder.GetMetadataTypeName(closureSym)
            } else if this.methodBodyPlanner.TryGetUserKickoffReceiverHandle(s, out var receiverEnclosing) &&
                this
                .methodBodyPlanner
                .TryGetUserKickoffReceiverSymbol(s, out var receiverSym) {
                this.emitCtx.Metadata.AddNestedType(nestedHandle, receiverEnclosing)
                enclosingTypeName = CustomAttributeEncoder.GetMetadataTypeName(receiverSym!!)
            } else {
                let smPkg PackageSymbol? = this.methodBodyPlanner.GetSmPackage(s, packages, entryPointPackage)
                let enclosingHandle = if smPkg != nil && programTypeDefHandles.TryGetValue(smPkg, out var ph) {
                    ph
                } else {
                    defaultProgramHandle
                }
                this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle)
                let programPkg PackageSymbol? = if smPkg != nil && programTypeDefHandles.ContainsKey(smPkg) {
                    smPkg
                } else {
                    hostPkg
                }
                enclosingTypeName = if programPkg == nil {
                    "<Program>"
                } else {
                    programPkg.Name + ".<Program>"
                }
            }
            this.EmitCompilerGeneratedAttribute(nestedHandle)
            this.EmitStateMachineKickoffDebugAttributes(s, enclosingTypeName)
        }
    }

    /// ADR-0174 P3-8: `[CompilerGenerated]` on a synthesized state-machine
    /// type. The runtime's `StackTrace` only tries to map a `MoveNext`
    /// frame back to its logical method when the frame's declaring type is
    /// marked compiler-generated; debuggers use the same signal to hide the
    /// type's internals.
    /// @param typeHandle The state machine's TypeDef.
    private func EmitCompilerGeneratedAttribute(typeHandle TypeDefinitionHandle) {
        let ctorRef = this.wellKnown.GetCompilerGeneratedAttributeCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// ADR-0174 P3-8: stamps the kickoff of an async / suspending state machine
    /// with `[AsyncStateMachine(typeof(SM))]` and `[DebuggerStepThrough]`.
    /// The runtime's `StackTrace` resolves a `MoveNext` frame to the
    /// logical function through the first (the state machine must be nested
    /// in the kickoff's declaring type, which `EmitNestedTypeRows`
    /// guarantees); debuggers step through the stub because of the second.
    /// The state machine's serialized name is its nesting chain — the
    /// enclosing TypeDef's metadata name, `+`, the struct's own name
    /// with its generic arity suffix — with no assembly qualifier, since the
    /// type lives in the assembly being emitted.
    /// @param stateMachine The state-machine struct.
    /// @param enclosingTypeName The metadata name of the TypeDef the struct is nested in.
    private func EmitStateMachineKickoffDebugAttributes(stateMachine StructSymbol, enclosingTypeName string) {
        var kickoff FunctionSymbol? = nil
        for plan in this.stateMachines.AsyncStateMachinePlans {
            if object.ReferenceEquals(plan.StateMachine.MaterializeAsStructSymbol(), stateMachine) {
                kickoff = plan.KickoffMethod
                break
            }
        }
        if kickoff == nil ||
            (
            !this
                .cache
                .FunctionHandles
                .TryGetValue(kickoff, out var kickoffHandle) &&
                !this
                .cache
                .MethodHandles
                .TryGetValue(kickoff, out kickoffHandle)
        ) ||
            kickoffHandle.IsNil {
            return
        }
        let ctorRef = this.wellKnown.GetAsyncStateMachineAttributeCtorRef()
        if !ctorRef.IsNil {
            let smName = TypeDefEmitter.MangleGenericName(stateMachine.Name, stateMachine.TypeParameters)
            let valueBlob = BlobBuilder()
            valueBlob.WriteUInt16(0x0001) // Prolog
            valueBlob.WriteSerializedString(enclosingTypeName + "+" + smName)
            valueBlob.WriteUInt16(0) // NumNamed
            this
                .emitCtx
                .Metadata
                .AddCustomAttribute(
                parent: kickoffHandle,
                constructor: ctorRef,
                value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
            )
        }
        let stepThroughRef = this.wellKnown.GetDebuggerStepThroughAttributeCtorRef()
        if !stepThroughRef.IsNil {
            let valueBlob = BlobBuilder()
            valueBlob.WriteUInt16(0x0001)
            valueBlob.WriteUInt16(0)
            this
                .emitCtx
                .Metadata
                .AddCustomAttribute(
                parent: kickoffHandle,
                constructor: stepThroughRef,
                value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
            )
        }
    }

    private func EmitModuleInitializer() {
        if this.moduleInitializers.IsDefaultOrEmpty {
            return
        }
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            for initializer in this.moduleInitializers {
                if !this.cache.MethodHandles.TryGetValue(initializer, out var initializerHandle) {
                    throw InvalidOperationException(
                        "Module initializer '${initializer.Name}' has no planned MethodDef handle."
                    )
                }
                il.Call(initializerHandle)
            }
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: false).Parameters(
            0,
            (returnType ReturnTypeEncoder) -> returnType.Void(),
            (_ ParametersEncoder) -> { }
        )
        this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset: bodyOffset,
            parameterList: this.customAttrEncoder.NextParameterHandle()
        )
    }

    private func EmitModuleAndAssemblyRows() ReservedBlob[GuidHandle] {
        // 6. Module + assembly rows. Reserve the MVID guid heap slot so we can
        // patch it with a content-derived value after PE serialization.
        let assemblyName = this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "Default"
        let mvidFixup = this.emitCtx.Metadata.ReserveGuid()
        let moduleHandle = this
            .emitCtx
            .Metadata
            .AddModule(
            generation: 0,
            moduleName: this.emitCtx.Metadata.GetOrAddString(assemblyName + ".dll"),
            mvid: mvidFixup.Handle,
            encId: default(GuidHandle),
            encBaseId: default(GuidHandle)
        )
        this.assemblyAttrs.EmitUserModuleAttributes(moduleHandle)
        let assemblyHandle = this
            .emitCtx
            .Metadata
            .AddAssembly(
            this.emitCtx.Metadata.GetOrAddString(assemblyName),
            this.assemblyAttrs.ParseAssemblyVersion(),
            default(StringHandle),
            default(BlobHandle),
            AssemblyFlags(0),
            AssemblyHashAlgorithm.Sha1
        )
        if this.emitCtx.MetadataOnly {
            this.assemblyAttrs.EmitReferenceAssemblyAttribute(assemblyHandle)
        }
        // Phase 7.7b: emit cross-language interop attributes for NuGet consumability.
        this.assemblyAttrs.EmitAssemblyInteropAttributes(assemblyHandle)
        if !this.emitCtx.MetadataOnly && (this.emitCtx.Pdb != nil || !this.emitCtx.Optimize) {
            this.assemblyAttrs.EmitDebuggableAttribute(assemblyHandle, this.emitCtx.Optimize)
        }
        return mvidFixup
    }

    private func BuildPortablePdbAndDebugDirectory(entryHandle MethodDefinitionHandle) DebugArtifacts {
        using let measurement = CompilationMeasurements.BeginPhase("emit.debug-directory")
        // 7. Build the Portable PDB blob FIRST so we can wire its content id
        // (CodeView), SHA-256 checksum (PdbChecksum), and — when embedded —
        // the blob itself into the PE's DebugDirectory. PortablePdbEmitter
        // does not touch any stream here; we own sidecar / embedded routing.
        var pdbBlob BlobBuilder? = nil
        var pdbContentId = default(BlobContentId)
        var pdbChecksum[]?uint8 = nil
        // Hold the emitter rather than a `pdbEnabled` bool: the serialize call
        // below needs it, and the bool cannot carry that it is present.
        let pdb PortablePdbEmitter? = this.emitCtx.Pdb
        if pdb != nil {
            let peRowCounts = this.emitCtx.Metadata.GetRowCounts()
            pdbBlob, pdbContentId = pdb.Serialize(
                peRowCounts,
                if this.emitCtx.MetadataOnly {
                    default(MethodDefinitionHandle)
                } else {
                    entryHandle
                },
                ComputeDeterministicContentId
            )
            pdbChecksum = ComputePdbChecksum(pdbBlob!!)
        }
        // 8. Construct a DebugDirectoryBuilder when PDB emit is on, so the PE
        // image gains a real CodeView entry (sidecar discovery), PdbChecksum
        // entry (PE ↔ PDB pairing), Reproducible entry (deterministic emit),
        // and — when embedded — an EmbeddedPortablePdb entry containing the
        // full PDB blob inline. Pass null to ManagedPEBuilder when PDB is off
        // so the legacy emit path stays bit-for-bit identical.
        var debugDirectory DebugDirectoryBuilder? = nil
        let isEmbedded = this.emitCtx.DebugInformation.Format == DebugInformationFormat.Embedded
        if pdbBlob != nil {
            debugDirectory = DebugDirectoryBuilder()
            // CodeView: identifies the PDB the runtime/debugger should fetch.
            // For embedded format the path is conventionally just the bare
            // pdb file name (no directory) because the consumer reads it out
            // of the PE itself; for sidecar it must be an absolute path so
            // vsdbg/coreclr can locate the sidecar regardless of the
            // debugger's working directory. A relative path here would leave
            // breakpoints unbound. Mirrors the source-path fix in 34002ff.
            var codeViewPath string
            if !string.IsNullOrEmpty(this.emitCtx.DebugInformation.PdbFilePath) {
                codeViewPath = if isEmbedded {
                    Path.GetFileName(this.emitCtx.DebugInformation.PdbFilePath)!!
                } else {
                    Path.GetFullPath(this.emitCtx.DebugInformation.PdbFilePath!!)
                }
            } else {
                codeViewPath = (this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "module") +
                    ".pdb"
            }
            debugDirectory.AddCodeViewEntry(
                pdbPath: codeViewPath,
                pdbContentId: pdbContentId,
                portablePdbVersion: PortablePdbVersion
            )
            // PdbChecksum: always emitted; lets symbol servers verify PE↔PDB
            // by content hash without trusting the file path.
            debugDirectory.AddPdbChecksumEntry(algorithmName: "SHA256", checksum: ImmutableArray.Create(pdbChecksum))
            // Reproducible: opt-in marker that this build is byte-deterministic.
            if this.emitCtx.DebugInformation.Deterministic {
                debugDirectory.AddReproducibleEntry()
            }
            // EmbeddedPortablePdb: only when /debug:embedded was requested.
            // The blob is compressed inside the PE; readers transparently
            // inflate via System.Reflection.PortableExecutable.PEReader.
            if isEmbedded {
                debugDirectory.AddEmbeddedPortablePdbEntry(pdbBlob, PortablePdbVersion)
            }
        }
        return DebugArtifacts(pdbBlob, debugDirectory, isEmbedded)
    }

    private func SerializePeAndWriteOutputs(
        peStream Stream,
        entryHandle MethodDefinitionHandle,
        mvidFixup ReservedBlob[GuidHandle],
        debugArtifacts DebugArtifacts
    ) {
        using let measurement = CompilationMeasurements.BeginPhase("emit.serialization")
        let pdbBlob BlobBuilder? = debugArtifacts.PdbBlob
        let debugDirectory = debugArtifacts.DebugDirectory
        let isEmbedded = debugArtifacts.IsEmbedded
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
        TypeDefEmitter.FlushPendingGenericParameters(
            this.emitCtx,
            this.memberRefs.GetElementTypeToken,
            this.BuildUnmanagedConstraintTypeSpec
        )
        let managedResources = this.BuildManagedResources()
        let peHeaderBuilder = PEHeaderBuilder(
            imageCharacteristics: if entryHandle.IsNil {
                Characteristics.Dll | Characteristics.ExecutableImage
            } else {
                Characteristics.ExecutableImage
            }
        )
        let peBlob = BlobBuilder()
        var contentId BlobContentId
        if this.emitCtx.MetadataOnly {
            let mvidBuilder = MvidPEBuilder(
                header: peHeaderBuilder,
                metadataRootBuilder: MetadataRootBuilder(this.emitCtx.Metadata),
                ilStream: this.emitCtx.IlStream,
                entryPoint: default(MethodDefinitionHandle),
                debugDirectoryBuilder: debugDirectory,
                deterministicIdProvider: ComputeDeterministicContentId
            )
            contentId = mvidBuilder.Serialize(peBlob, out var mvidSectionFixup)
            BlobWriter(mvidSectionFixup).WriteGuid(contentId.Guid)
        } else {
            let peBuilder = ManagedPEBuilder(
                header: peHeaderBuilder,
                metadataRootBuilder: MetadataRootBuilder(this.emitCtx.Metadata),
                ilStream: this.emitCtx.IlStream,
                managedResources: managedResources,
                mappedFieldData: this.utf8Data.Data,
                entryPoint: entryHandle,
                debugDirectoryBuilder: debugDirectory,
                deterministicIdProvider: ComputeDeterministicContentId
            )
            contentId = peBuilder.Serialize(peBlob)
        }
        mvidFixup.CreateWriter().WriteGuid(contentId.Guid)
        this.workBudget.CancellationToken.ThrowIfCancellationRequested()
        peBlob.WriteContentTo(peStream)
        // 10. Phase 4–7 PDB sidecar routing. Embedded format suppresses the
        // sidecar — the blob already lives in the PE. Portable format writes
        // to the supplied stream when one was provided (callers that want
        // only an embedded PDB pass `pdbStream: null`).
        if pdbBlob != nil && !isEmbedded && this.emitCtx.PdbStream != nil {
            pdbBlob.WriteContentTo(this.emitCtx.PdbStream!!)
        }
    }

    private func BuildManagedResources() BlobBuilder? {
        if this.emitCtx.MetadataOnly || this.embeddedResources == nil || this.embeddedResources.Count == 0 {
            return nil
        }
        let embeddedResources = this.embeddedResources
        let blob = BlobBuilder()
        for resource in embeddedResources {
            blob.Align(8)
            let offset = uint32(blob.Count)
            let data = resource.Data ?? Array.Empty[uint8]()
            blob.WriteInt32(data.Length)
            blob.WriteBytes(data)
            this
                .emitCtx
                .Metadata
                .AddManifestResource(
                if resource.IsPublic {
                    ManifestResourceAttributes.Public
                } else {
                    ManifestResourceAttributes.Private
                },
                this.emitCtx.Metadata.GetOrAddString(resource.Name),
                implementation: default(EntityHandle),
                offset
            )
        }
        return blob
    }

    /// PR-E-10 body-emit callback used by
    /// (cref:StateMachineEmitter.EmitStateMachineMoveNext). Builds the
    /// Shared plumbing for every method-body scaffold in this emitter. It owns
    /// the ~19 slot-tracking dictionaries, runs the
    /// (cref:MethodBodyPlanner.CollectLocalsAndLabels) slot planner,
    /// encodes the locals signature, and constructs the
    /// (cref:MethodBodyEmitter). Centralizing the dictionaries, the
    /// 22-argument planner call and the 25-argument emitter construction keeps
    /// them in exactly one place so a fix applies to every scaffold at once and
    /// can no longer drift between the near-identical copies.
    internal class MethodBodyEmitSession : IDisposable {
        private let outer ReflectionMetadataEmitter
        private var scratch SessionScratch?
        private var lease ScratchLease[SessionScratch]?
        private let locals Dictionary[VariableSymbol, int32]
        private let labels Dictionary[BoundLabel, LabelHandle]
        private let localTypes List[TypeSymbol]
        private let structLiteralSlots Dictionary[BoundStructLiteralExpression, int32]
        private let defaultExpressionSlots Dictionary[BoundDefaultExpression, int32]
        private let mapIndexSlots Dictionary[BoundIndexExpression, int32]
        private let patternSwitchSlots Dictionary[BoundPatternSwitchStatement, int32]
        private let typePatternScratchSlots Dictionary[BoundTypePattern, int32]
        private let switchExpressionSlots Dictionary[BoundSwitchExpression, (Result int32, Discriminant int32)]
        private let channelOpSlots Dictionary[BoundNode, (VT int32, TA int32, Result int32, Spare int32)]
        private let receiverSpillSlots Dictionary[BoundExpression, int32]
        private let stackAllocResultSlots Dictionary[BoundStackAllocExpression, int32]
        private let indexAssignmentValueSlots Dictionary[BoundExpression, int32]
        private let liftedBinarySlots Dictionary[BoundExpression, LiftedBinarySlots]
        private let nullableCoalesceSpillSlots Dictionary[BoundBinaryExpression, int32]
        private let constValues Dictionary[VariableSymbol, object]
        private var hasFixedReturns bool
        private var fixedReturnSlot int32 = -1

        /// Creates a session over fresh slot collections, or over pooled ones.
        /// @param outer The owning emitter.
        /// @param il The instruction encoder the body is emitted into.
        /// @param pooled When `true`, the collections come from the emitter's pool and
        /// go back to it on (cref:Dispose); the session must then not be used after
        /// it is disposed, and must not outlive the body it plans.
        init(outer ReflectionMetadataEmitter, il InstructionEncoder, pooled bool = false) {
            this.outer = outer
            this.Il = il
            var scratch SessionScratch
            if pooled {
                let lease = outer.sessionScratchPool.Rent()
                this.lease = lease
                scratch = lease.Item
            } else {
                scratch = SessionScratch()
            }
            this.scratch = scratch
            this.locals = scratch.Locals
            this.labels = scratch.Labels
            this.localTypes = scratch.LocalTypes
            this.structLiteralSlots = scratch.StructLiteralSlots
            this.defaultExpressionSlots = scratch.DefaultExpressionSlots
            this.mapIndexSlots = scratch.MapIndexSlots
            this.patternSwitchSlots = scratch.PatternSwitchSlots
            this.typePatternScratchSlots = scratch.TypePatternScratchSlots
            this.switchExpressionSlots = scratch.SwitchExpressionSlots
            this.channelOpSlots = scratch.ChannelOpSlots
            this.receiverSpillSlots = scratch.ReceiverSpillSlots
            this.stackAllocResultSlots = scratch.StackAllocResultSlots
            this.indexAssignmentValueSlots = scratch.IndexAssignmentValueSlots
            this.liftedBinarySlots = scratch.LiftedBinaryOperatorSlots
            this.nullableCoalesceSpillSlots = scratch.NullableCoalesceSpillSlots
            this.constValues = scratch.ConstValues
        }

        /// Returns pooled collections to the emitter's pool. Safe to call more than once.
        func Dispose() {
            this.scratch = nil
            this.lease?.Release()
        }

        /// Gets the instruction encoder that all planned/emitted IL flows through.
        prop Il InstructionEncoder {
            get;
        }

        /// Gets the collected local-variable slot map (for PDB local info capture).
        prop Locals Dictionary[VariableSymbol, int32] -> this.locals

        /// Gets the collected compile-time constant bindings (for PDB local-constant capture).
        prop ConstValues Dictionary[VariableSymbol, object] -> this.constValues

        /// Issue #216: collects compile-time const bindings before slot allocation.
        /// @param body The bound body to scan for const bindings.
        func CollectConstValues(body BoundBlockStatement) -> MethodBodyPlanner.CollectConstValues(
            body,
            this.constValues
        )

        /// Runs the slot planner for one body region, appending to the shared
        /// slot dictionaries. May be called more than once (e.g. base-initializer
        /// arguments and field initializers are planned separately).
        /// @param body The bound body region contributing locals/labels.
        /// @param function The owning function, or `null` for synthesized bodies.
        func Plan(body BoundBlockStatement, function FunctionSymbol? = nil) {
            if TryGetFixedReturnType(body, out var fixedReturnType) {
                this.hasFixedReturns = true
                if fixedReturnType != nil && this.fixedReturnSlot < 0 {
                    this.fixedReturnSlot = this.localTypes.Count
                    this.localTypes.Add(fixedReturnType)
                }
            }
            this
                .outer
                .methodBodyPlanner
                .CollectLocalsAndLabels(
                body,
                function,
                this.locals,
                this.localTypes,
                this.labels,
                this.structLiteralSlots,
                this.defaultExpressionSlots,
                this.mapIndexSlots,
                this.patternSwitchSlots,
                this.typePatternScratchSlots,
                this.switchExpressionSlots,
                this.channelOpSlots,
                this.receiverSpillSlots,
                this.indexAssignmentValueSlots,
                this.liftedBinarySlots,
                this.nullableCoalesceSpillSlots,
                this.Il,
                this.stackAllocResultSlots,
                this.scratch?.GetPlanner()
            )
        }

        /// Plans the proven primitive body without accessing the coordinator or metadata.
        func PlanIndependent(body BoundBlockStatement) -> MethodBodyPlanner.CollectIndependentLocalsAndLabels(
            body,
            this.locals,
            this.localTypes,
            this.labels,
            this.Il
        )

        /// Encodes the collected locals into a standalone signature (default when there are none).
        /// @returns The locals signature handle, or `default` when no locals were collected.
        func BuildLocalsSignature() StandaloneSignatureHandle {
            if this.localTypes.Count == 0 {
                return default(StandaloneSignatureHandle)
            }
            let localsSigBlob = BlobBuilder()
            let encoder = BlobEncoder(localsSigBlob).LocalVariableSignature(this.localTypes.Count)
            for t in this.localTypes {
                this.outer.signatures.EncodeLocalVariableType(encoder.AddVariable(), t)
            }
            return this
                .outer
                .emitCtx
                .Metadata
                .AddStandaloneSignature(this.outer.emitCtx.Metadata.GetOrAddBlob(localsSigBlob))
        }

        /// Constructs the body emitter over the collected slot dictionaries.
        /// @param parameters The parameter-to-IL-slot map for the method.
        /// @param structThisParameter The struct `this` parameter, when arg0 is a managed pointer.
        /// @param asyncFieldMap The async state-machine field map (MoveNext only).
        /// @param asyncPlan The async state-machine plan (MoveNext only).
        /// @param iteratorEmitCtx The iterator emit context (iterator MoveNext only).
        /// @param enclosingClosure The enclosing closure info (closure invoke methods only).
        /// @returns A configured (cref:MethodBodyEmitter).
        func CreateEmitter(
            parameters Dictionary[ParameterSymbol, int32],
            structThisParameter ParameterSymbol? = nil,
            asyncFieldMap AsyncStateMachineFieldMap? = nil,
            asyncPlan AsyncStateMachinePlan? = nil,
            iteratorEmitCtx StateMachineEmitter.IteratorEmitContext? = nil,
            enclosingClosure ClosureEmitter.ClosureInfo? = nil,
            isolated bool = false,
            recordLocalSequencePoint((int32, SyntaxNode?) -> void)? = nil,
            suppressNativeProtocolValidation bool = false
        ) MethodBodyEmitter {
            let emitter = MethodBodyEmitter(
                if isolated {
                    nil
                } else {
                    this.outer
                },
                this.Il,
                this.locals,
                parameters,
                this.labels,
                this.structLiteralSlots,
                this.defaultExpressionSlots,
                this.mapIndexSlots,
                this.patternSwitchSlots,
                this.typePatternScratchSlots,
                this.switchExpressionSlots,
                this.channelOpSlots,
                this.receiverSpillSlots,
                this.indexAssignmentValueSlots,
                liftedBinarySlots: this.liftedBinarySlots,
                nullableCoalesceSpillSlots: this.nullableCoalesceSpillSlots,
                structThisParameter: structThisParameter,
                asyncFieldMap: asyncFieldMap,
                asyncPlan: asyncPlan,
                iteratorEmitCtx: iteratorEmitCtx,
                constValues: this.constValues,
                enclosingClosure: enclosingClosure,
                stackAllocResultSlots: this.stackAllocResultSlots,
                hasFixedReturns: this.hasFixedReturns,
                fixedReturnSlot: this.fixedReturnSlot,
                recordLocalSequencePoint: recordLocalSequencePoint
            )
            emitter.SuppressNativeProtocolValidation = suppressNativeProtocolValidation
            emitter.EmitNativeProtocolParameterValidation()
            return emitter
        }

        shared {
            private func TryGetFixedReturnType(
                statement BoundStatement,
                @NotNullWhen(true) out returnType TypeSymbol?
            ) bool {
                var foundType TypeSymbol? = nil
                let Find = func (current BoundStatement, insideFixed bool) bool {
                    switch current {
                        case returnStatement is BoundReturnStatement when insideFixed {
                            foundType ??= returnStatement.Expression?.Type
                            return true
                        }
                        case block is BoundBlockStatement {
                            var found = false
                            for nested in block.Statements {
                                found |= Find(nested, insideFixed)
                            }
                            return found
                        }
                        case fixedStatement is BoundFixedStatement {
                            return Find(fixedStatement.Body, true)
                        }
                        case switchStatement is BoundPatternSwitchStatement {
                            var switchFound = false
                            for arm in switchStatement.Arms {
                                switchFound |= Find(arm.Body, insideFixed)
                            }
                            return switchFound
                        }
                        default {
                            return false
                        }
                    }
                }
                let found = Find(statement, false)
                returnType = foundType
                return found
            }
        }
    }

    // PR-E-5: EmitDefaultValue(InstructionEncoder, Type) moved to
    // ConversionEmitter. The pre-refactor source had no callers for this
    // helper — it sits in the conversion-shaped emit surface alongside
    // EmitBoxIfNeeded and is preserved for parity / future use.
    // PR-E-19: widened private → internal so the extracted UserTokenResolver can
    // call it through the `outer` back-reference (EncodeFunctionReturnSymbol's
    // async-kickoff branch). Stays on the root because it is part of the async
    // return-type emission band (used by EmitCore too), not the user-token band.
    /// Encodes the CLR return type for an async kickoff method:
    /// `Task`, `Task<T>`, or `void` for async-void.
    internal func EncodeAsyncReturnType(encoder ReturnTypeEncoder, plan AsyncStateMachinePlan) {
        if this.GetAsyncReturnTypeSymbol(plan) is not{} returnType {
            encoder.Void()
        } else {
            this.signatures.EncodeTypeSymbol(encoder.Type(), returnType)
        }
    }

    /// Gets the physical return type shared by async kickoff signature and
    /// nullable-metadata emission.
    internal func GetAsyncReturnTypeSymbol(plan AsyncStateMachinePlan) TypeSymbol? {
        let stateMachine = plan.StateMachine
        let builderInfo = stateMachine.BuilderInfo
        if builderInfo.Kind == AsyncMethodBuilderKind.Void ||
            builderInfo
            .TaskProperty
            ?.PropertyType is not Type taskClrType {
            return nil
        }
        let taskType TypeSymbol = if taskClrType.IsConstructedGenericType && taskClrType.GetGenericArguments()
            .Length == 1 &&
            stateMachine.ResultTypeSymbol is {} resultType {
            ImportedTypeSymbol.GetConstructed(
                taskClrType,
                taskClrType.GetGenericTypeDefinition(),
                ImmutableArray.Create(resultType)
            )
        } else {
            ImportedTypeSymbol.GetWithoutNullability(taskClrType, NullabilityFreeReason.EmitShape)
        }
        let declaration SyntaxNode? = cast[SyntaxNode?](plan.KickoffMethod.Declaration) ??
            plan
            .KickoffMethod
            .LocalDeclaration
        return if !taskClrType.IsValueType && declaration != nil && ObliviousScope.IsInObliviousScope(declaration) {
            ObliviousScope.Wrap(taskType)
        } else {
            taskType
        }
    }

    /// Gets nullable flags for the physical async kickoff return. Generic value
    /// tasks whose result contributes no nullable positions keep csc's
    /// attribute-free shape.
    internal func GetAsyncReturnNullableFlags(plan AsyncStateMachinePlan) ImmutableArray[uint8] {
        let returnType TypeSymbol? = this.GetAsyncReturnTypeSymbol(plan)
        if returnType == nil {
            return ImmutableArray[uint8].Empty
        }
        let builderInfo = plan.StateMachine.BuilderInfo
        if builderInfo
            .TaskProperty
            ?.PropertyType
            .IsValueType == true &&
            plan
            .StateMachine
            .ResultTypeSymbol is {} resultType &&
            NullableFlagsBuilder
            .Build(resultType).IsEmpty {
            return ImmutableArray[uint8].Empty
        }
        return NullableFlagsBuilder.Build(returnType)
    }

    /// ADR-0174 D4. Attaches the parameterless
    /// `[Gsharp.Concurrency.SuspendingAttribute]` to a suspending
    /// function's MethodDef. Skipped silently when the channel runtime is not in
    /// the reference set (the function still compiles; only cross-assembly
    /// recognition is lost).
    /// @param parent The MethodDef row.
    internal func EmitSuspendingAttribute(parent EntityHandle) {
        let ctorRef = this.wellKnown.GetSuspendingAttributeCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        valueBlob.WriteUInt16(0) // NumNamed
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    // PR-E-20: widened private → internal so the extracted FunctionEmitter can
    // stamp [Extension] on a G#-authored extension MethodDef through the `outer`
    // back-reference. Stays on the root because it is shared with EmitCore's
    // EmitProgramExtensionMarker (which stamps the host <Program> TypeDef).
    /// Issue #792 / ADR-0084. Attaches the parameterless
    /// `[System.Runtime.CompilerServices.ExtensionAttribute]` to the
    /// supplied entity (MethodDef row for an extension method, or a TypeDef
    /// row for the static class that hosts the extension methods).
    internal func EmitExtensionAttribute(parent EntityHandle) {
        let ctorRef = this.wellKnown.GetExtensionAttributeCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        valueBlob.WriteUInt16(0) // NumNamed
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    private func NeedsRvalueReceiverSpill(
        receiver BoundExpression,
        function FunctionSymbol?,
        locals IReadOnlyDictionary[VariableSymbol, int32]
    ) bool {
        // A constrained type parameter needs an address even though its
        // value/reference shape is unknown until the generic is closed.
        if !IsValueTypeSymbol(receiver.Type) && !(receiver.Type is TypeParameterSymbol) {
            return false
        }
        // ADR-0184 amendment: shared with the binder's ref-safe-scope walk —
        // see RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy.
        if RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(receiver) {
            return true
        }
        if receiver is BoundDereferenceExpression {
            return false
        }
        if receiver is BoundTupleElementAccessExpression && RefCapabilities.IsDirectlyAddressableForImplicitIn(
            receiver
        ) {
            return false
        }
        if receiver is BoundVariableExpression bve &&
            bve.NarrowedType == nil &&
            this.CanLoadVariableAddressForReceiverSpill(bve.Variable, function, locals) {
            return false
        }
        // Keep lvalue storage in place even when generic construction
        // substituted the FieldSymbol. MethodBodyEmitter resolves the token
        // against the open definition; StructFieldDefs identity is not an
        // addressability test.
        if receiver is BoundFieldAccessExpression fa && this.IsAddressableFieldAccessForReceiverSpill(
            fa,
            function,
            locals
        ) {
            return false
        }
        // The constrained emitter still needs a spill for CLR type-parameter fields.
        if receiver.Type is not TypeParameterSymbol &&
            receiver is BoundClrPropertyAccessExpression clrField &&
            IsAddressableClrFieldChain(clrField) {
            return false
        }
        return true
    }

    private func CanLoadVariableAddressForReceiverSpill(
        variable VariableSymbol,
        function FunctionSymbol?,
        locals IReadOnlyDictionary[VariableSymbol, int32]
    ) bool {
        if variable is ParameterSymbol ps && function != nil && function.Parameters.Any(
            (p ParameterSymbol) -> object.ReferenceEquals(p, ps)
        ) {
            return true
        }
        if locals.ContainsKey(variable) {
            return true
        }
        if variable is GlobalVariableSymbol{IsConst: false} gv && this.cache.GlobalFieldDefs.ContainsKey(gv) {
            return true
        }
        return false
    }

    /// Issue #1525: returns `true` when taking the address of
    /// [`field`](paramref) via `ldsflda` is verifiable in the current
    /// emit context — i.e. the field is not an `initonly` static field, or
    /// it is but we are currently emitting the synthesized static constructor
    /// (`.cctor`) of the field's own declaring type (the only place ECMA-335
    /// permits mutating/addressing an `initonly` static field). Otherwise a
    /// static readonly value-type field used as an instance-method or
    /// property-getter receiver must be spilled to a temp (defensive copy)
    /// rather than addressed in place.
    /// @param field The field whose address is being considered.
    /// @returns `true` when `ldsflda` of the field is legal here.
    internal func IsStaticFieldAddressLegalHere(field FieldSymbol) bool -> field.IsStaticAddressLegal(
        this.emitCtx.CurrentStaticConstructorOwner
    )

    private func IsAddressableFieldAccessForReceiverSpill(
        fa BoundFieldAccessExpression,
        function FunctionSymbol?,
        locals IReadOnlyDictionary[VariableSymbol, int32]
    ) bool {
        if fa.Receiver == nil {
            // Issue #1525: a static field receiver is normally addressable
            // (ldsflda), but an initonly (readonly) static value-type field
            // is only addressable inside its declaring type's .cctor; anywhere
            // else force an rvalue spill (defensive copy) so the emitted IL is
            // verifiable.
            return this.IsStaticFieldAddressLegalHere(fa.Field)
        }
        if fa.Receiver!!.Type is StructSymbol rs && rs.IsClass {
            return true
        }
        if fa.Receiver!!.Type?.ClrType != nil && !fa.Receiver!!.Type.ClrType!!.IsValueType {
            return true
        }
        if fa.Receiver is BoundVariableExpression bv && this.CanLoadVariableAddressForReceiverSpill(
            bv.Variable,
            function,
            locals
        ) {
            return true
        }
        if fa.Receiver is BoundFieldAccessExpression nested {
            return this.IsAddressableFieldAccessForReceiverSpill(nested, function, locals)
        }
        if fa.Receiver is BoundTupleElementAccessExpression tuple {
            return RefCapabilities.IsDirectlyAddressableForImplicitIn(tuple)
        }
        return RefCapabilities.IsDirectlyAddressableForImplicitIn(fa.Receiver!!)
    }

    private func ResolveCoreType(fullName string, fallback Type) Type {
        if this.emitCtx.References.TryResolveType(fullName, requireExternalVisibility: false, out var t) {
            return t!!
        }
        return fallback
    }

    /// Issue #1336: builds the `TypeSpec` used as the `Constraint` of
    /// the `GenericParamConstraint` row that encodes a `where T :
    /// unmanaged` constraint. The signature is
    /// `System.ValueType modreq(System.Runtime.InteropServices.UnmanagedType)`
    /// — the exact metadata shape C# emits — written as a raw type signature
    /// blob: `ELEMENT_TYPE_CMOD_REQD <UnmanagedType>
    /// ELEMENT_TYPE_CLASS <System.ValueType>`.
    /// @returns The TypeSpec handle for the modreq-decorated ValueType constraint.
    private func BuildUnmanagedConstraintTypeSpec() EntityHandle {
        if !this.unmanagedConstraintTypeSpec.IsNil {
            return this.unmanagedConstraintTypeSpec
        }
        let unmanagedTypeRef = this.memberRefs.GetTypeReference(
            this.ResolveCoreType("System.Runtime.InteropServices.UnmanagedType", typeof(UnmanagedType))
        )
        let valueTypeRef = this.memberRefs.GetTypeReference(this.emitCtx.CoreValueType)
        let blob = BlobBuilder()
        blob.WriteByte(uint8(SignatureTypeCode.RequiredModifier))
        blob.WriteCompressedInteger(CodedIndex.TypeDefOrRefOrSpec(unmanagedTypeRef))
        // System.ValueType is itself a reference type (an abstract class), so it
        // must be encoded as ELEMENT_TYPE_CLASS (0x12) — NOT ELEMENT_TYPE_VALUETYPE
        // (0x11). This matches exactly what the C# compiler emits; encoding it as
        // VALUETYPE makes the CLR loader reject the type with a "value type
        // mismatch" TypeLoadException at runtime.
        blob.WriteByte(uint8(SignatureTypeKind.Class))
        blob.WriteCompressedInteger(CodedIndex.TypeDefOrRefOrSpec(valueTypeRef))
        this.unmanagedConstraintTypeSpec = this
            .emitCtx
            .MetadataRows
            .AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(blob))
        return this.unmanagedConstraintTypeSpec
    }

    // ADR-0118 / issue #944: a type that declares a user indexer member must
    // carry a System.Reflection.DefaultMemberAttribute("Item") so the CLR (and
    // C# consumers) recognise its `Item` property as the default indexer.
    private func EmitDefaultMemberAttributeIfIndexer(structSym StructSymbol) {
        if structSym.Properties.IsDefaultOrEmpty {
            return
        }
        var hasIndexer = false
        for prop in structSym.Properties {
            if prop.IsIndexer {
                hasIndexer = true
                break
            }
        }
        if !hasIndexer {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle) {
            return
        }
        this.customAttrEncoder.EmitStringAttribute(
            typeDefHandle,
            "System.Reflection.DefaultMemberAttribute",
            typeof(DefaultMemberAttribute),
            "Item"
        )
    }

    /// ADR-0149 (issue #944 follow-up): interface-side counterpart of
    /// (cref:EmitDefaultMemberAttributeIfIndexer(StructSymbol)) — an
    /// interface that declares its own indexer contract (`prop this[…] T`)
    /// gets the same (cref:System.Reflection.DefaultMemberAttribute)
    /// on its TypeDef, so reflection-based indexed access
    /// (`Type.GetProperty("Item")` / `PropertyInfo.GetValue(obj, args)`)
    /// and the C#-style `obj[i]` syntax work identically whether the
    /// static type is the interface or a concrete implementer.
    private func EmitDefaultMemberAttributeIfIndexer(ifaceSym InterfaceSymbol) {
        if ifaceSym.Properties.IsDefaultOrEmpty {
            return
        }
        var hasIndexer = false
        for prop in ifaceSym.Properties {
            if prop.IsIndexer {
                hasIndexer = true
                break
            }
        }
        if !hasIndexer {
            return
        }
        if !this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle) {
            return
        }
        this.customAttrEncoder.EmitStringAttribute(
            typeDefHandle,
            "System.Reflection.DefaultMemberAttribute",
            typeof(DefaultMemberAttribute),
            "Item"
        )
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
    private func RegisterIndexerAccessorHandles(
        prop PropertySymbol,
        getterHandle MethodDefinitionHandle?,
        setterHandle MethodDefinitionHandle?
    ) {
        if prop.GetterSymbol != nil && (getterHandle != nil) {
            this.cache.MethodHandles[prop.GetterSymbol!!] = getterHandle
        }
        if prop.SetterSymbol != nil && (setterHandle != nil) {
            this.cache.MethodHandles[prop.SetterSymbol!!] = setterHandle
        }
    }

    shared {
        /// CLR field storage remains addressable after a reference owner is
        /// captured into a local. Share this decision with receiver emission so
        /// neither path replaces a stored struct with a spilled copy.
        internal func IsAddressableClrFieldChain(access BoundClrPropertyAccessExpression) bool {
            return access.Member is FieldInfo && RefCapabilities.IsDirectlyAddressableForImplicitIn(access)
        }

        private const ModuleInitializerAttributeName string = "System.Runtime.CompilerServices.ModuleInitializerAttribute"

        // Portable PDB metadata format version expected by all current readers
        // (System.Reflection.Metadata, dotnet-symbol, debuggers). 0x0100 = v1.0.
        private const PortablePdbVersion uint16 = uint16(0x0100)

        // Issue #1537: gathers the flattened ORIGINAL generic parameters of every
        // enclosing type of <paramref name="nested"/>, in CLR order (outermost
        // first), reading each enclosing type's pre-reification parameters from
        // <paramref name="originalOwnParams"/> so a deeply-nested type sees the
        // originals even after an intermediate enclosing type has been reified.
        private func CollectOriginalEnclosingTypeParameters(
            nested TypeSymbol,
            originalOwnParams Dictionary[StructSymbol, ImmutableArray[TypeParameterSymbol]]
        ) ImmutableArray[TypeParameterSymbol] {
            var levels List[ImmutableArray[TypeParameterSymbol]]? = nil
            let containingType = switch nested {
                case s is StructSymbol: s.ContainingType
                case e is EnumSymbol: e.ContainingType
                default: default(TypeSymbol?)
            }
            for var c StructSymbol? = containingType as StructSymbol; c != nil; c = c!!.ContainingType as StructSymbol {
                let def = c.Definition ?? c
                let tps = if originalOwnParams.TryGetValue(def, out var snapshot) {
                    snapshot
                } else {
                    def.TypeParameters
                }
                if !tps.IsDefaultOrEmpty {
                    levels ??= List[ImmutableArray[TypeParameterSymbol]]()
                    // Prepend so the outermost enclosing type's parameters come first.
                    levels!!.Insert(0, tps)
                }
            }
            if levels == nil {
                return ImmutableArray[TypeParameterSymbol].Empty
            }
            let builder = ImmutableArray.CreateBuilder[TypeParameterSymbol]()
            for level in levels {
                builder.AddRange(level)
            }
            return builder.ToImmutable()
        }

        /// Emits [`program`](paramref) to [`peStream`](paramref) as a
        /// managed PE.
        /// @param program The bound program to emit.
        /// @param peStream Destination stream for the PE bytes.
        /// @param references Reference resolver providing the target framework's core types
        /// (`System.Object`, `System.String`) and any user-supplied
        /// imports. Pass `null` to resolve from the gsc host's loaded
        /// runtime (in-process scenarios only — produces an assembly bound to
        /// the gsc host's TFM).
        /// @param assemblyName Optional override for the assembly identity (module + assembly rows).
        /// When `null`, the entry-point package's name is used. Supplied by
        /// the SDK BuildTask from MSBuild's `AssemblyName`.
        /// @param metadataOnly When true, emits a metadata-only reference assembly: method bodies
        /// are omitted (RVA 0) and the assembly is marked with
        /// `System.Runtime.CompilerServices.ReferenceAssemblyAttribute`.
        /// @param asyncRewriteResult Optional result from the async state-machine rewriter. When non-null,
        /// contains plans for emitting state-machine types and kickoff bodies.
        /// @param iteratorRewriteResult Optional result from the iterator rewriter. When non-null, contains
        /// plans
        /// for emitting iterator state-machine types and kickoff bodies.
        /// @param asyncIteratorRewriteResult Optional result from the async iterator rewriter. When non-null,
        /// contains plans
        /// for emitting async iterator state-machine types and kickoff bodies.
        /// @param debugInformation Phase 3 (ADR-0027 §7.7a) PDB-related emit options. When `null`
        /// or when (cref:DebugInformationOptions.Format) is
        /// (cref:DebugInformationFormat.None) the emitter behaves exactly as
        /// it did before Phase 3 (no PDB sidecar, no `DebugDirectory` entries).
        /// The actual production of PDB content lands across Phases 4–7; Phase 3
        /// only plumbs the option onto the emitter so subsequent phases can consume
        /// it without further signature churn.
        /// @param pdbStream Optional destination for the Portable PDB sidecar stream. Only consumed
        /// when [`debugInformation`](paramref) requests
        /// (cref:DebugInformationFormat.Portable); ignored in every other
        /// configuration. Plumbed here so callers can open the file once and have
        /// the emitter write to it directly without intermediate buffering.
        /// @param assemblyVersion Optional informational version string. When non-null, emitted as
        /// `AssemblyInformationalVersionAttribute` on the assembly so NuGet
        /// and consumer tooling can display the package version.
        /// @param targetFrameworkMoniker Optional long target framework moniker emitted as
        /// `TargetFrameworkAttribute`.
        /// @param embeddedResources Managed resources to embed in runtime assemblies.
        /// @param optimize Whether the emitted runtime assembly allows JIT optimization.
        func Emit(
            program BoundProgram,
            peStream Stream,
            references ReferenceResolver? = nil,
            assemblyName string? = nil,
            metadataOnly bool = false,
            asyncRewriteResult AsyncStateMachineRewriteResult? = nil,
            iteratorRewriteResult IteratorRewriteResult? = nil,
            asyncIteratorRewriteResult AsyncIteratorRewriteResult? = nil,
            debugInformation DebugInformationOptions? = nil,
            pdbStream Stream? = nil,
            assemblyVersion string? = nil,
            targetFrameworkMoniker string? = nil,
            embeddedResources IReadOnlyList[(Name string, Data[]uint8, IsPublic bool)]? = nil,
            optimize bool = true,
            workBudget CompilationWorkBudget? = nil
        ) {
            let emitter = ReflectionMetadataEmitter(program, references, assemblyName, metadataOnly, embeddedResources)
            emitter.workBudget = workBudget ?? CompilationWorkBudget()
            emitter.emitCtx.AssemblyVersionOverride = assemblyVersion
            emitter.emitCtx.TargetFrameworkMoniker = targetFrameworkMoniker
            emitter.emitCtx.Optimize = optimize
            emitter.emitCtx.DebugInformation = debugInformation ?? DebugInformationOptions()
            emitter.emitCtx.PdbStream = pdbStream
            // Lazy data signatures must use source vectors, not emission-scoped
            // enclosing+own vectors installed by nested generic reification.
            for symbol in program.Structs {
                if symbol.IsData && symbol.ClrType == nil {
                    let _ = symbol.DataEqualsSelf
                    let _ = symbol.DataEqualsBase
                    let _ = symbol.DataEqualsObject
                    let _ = symbol.DataPrintMembers
                }
            }
            // Nested generic reification belongs to this emission. A following
            // reference-assembly emission must start from the same source vector.
            let structParameters = program
                .Structs
                .Select((s StructSymbol) -> (Symbol: s, Parameters: s.TypeParameters))
                .ToArray()
            let enumParameters = program
                .Enums
                .Select((e EnumSymbol) -> (Symbol: e, Parameters: e.TypeParameters))
                .ToArray()
            try {
                emitter.EmitCore(peStream, asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult)
            } finally {
                for (symbol, parameters) in structParameters {
                    symbol.SetTypeParameters(parameters)
                }
                for (symbol, parameters) in enumParameters {
                    symbol.SetTypeParameters(parameters)
                }
            }
        }

        /// Issue #4676: the accessibility of a package's synthesized `<Program>`
        /// host type. The host is how a package exposes its top-level functions to
        /// other assemblies, so it stays `public` whenever it carries a function
        /// another assembly can reach, and in an executable (every package of
        /// an executable keeps its host public, to leave application behaviour alone).
        /// A LIBRARY package that hosts no such member (every GSharp.Core
        /// namespace whose code is all types, say) is a compiler-generated detail,
        /// like the C# compiler's own generated types, and is emitted NotPublic so it
        /// is not part of the assembly's API (reflection-based tooling such as an
        /// analyzer-target enumeration no longer sees one `<Program>` per
        /// namespace). An assembly granted InternalsVisibleTo still reaches the
        /// host's internal members, since it can see the NotPublic type too.
        /// @param pkg The package whose host is being emitted.
        /// @param hasEntryPoint Whether the compilation has an entry point (an executable).
        /// @param packageMethods The planned per-package functions.
        /// @returns The type visibility flag for the host's TypeDef.
        private func ProgramHostAccessibility(
            pkg PackageSymbol,
            hasEntryPoint bool,
            packageMethods PackageMethodPlan
        ) TypeAttributes {
            // A library has no globals (a top-level variable is a top-level statement, GS0285),
            // so only an executable can host one, and an executable keeps every host public.
            if hasEntryPoint {
                return TypeAttributes.Public
            }
            let IsReachableFromOtherAssemblies = func (accessibility Accessibility) bool {
                return accessibility == Accessibility.Public || accessibility == Accessibility.Protected
            }
            // Only AUTHORED top-level functions count. The package's bucket also holds the
            // zero-capture function literals and hoisted local functions the emitter hosts on
            // `<Program>`, whose symbols default to public accessibility but which no other
            // assembly can name.
            if packageMethods.FunctionsByPackage.TryGetValue(pkg, out var functions) && functions.Any(
                (function FunctionSymbol) -> !function.IsFunctionLiteral &&
                    !function.IsLocalFunction &&
                    function.LocalDeclaration == nil &&
                    IsReachableFromOtherAssemblies(function.Accessibility)
            ) {
                return TypeAttributes.Public
            }
            return TypeAttributes.NotPublic
        }

        private func IsModuleInitializer(function FunctionSymbol) bool -> function.IsStatic &&
            function.StaticOwnerType != nil &&
            !function.IsGeneric &&
            function
            .Parameters
            .IsDefaultOrEmpty &&
            function.Type == TypeSymbol.Void &&
            (function.Accessibility is Accessibility.Public or Accessibility.Internal) &&
            function
            .Attributes
            .Any(
            (attribute BoundAttribute) -> string.Equals(
                attribute.AttributeType?.ClrType?.FullName,
                ModuleInitializerAttributeName,
                StringComparison.Ordinal
            )
        )

        /// Computes the SHA-256 checksum of the serialized Portable PDB content,
        /// matching the algorithm name written into the `PdbChecksum` debug
        /// directory entry. Returning a fresh byte array keeps callers from
        /// having to thread (cref:IncrementalHash) through the call site.
        private func ComputePdbChecksum(pdbBlob BlobBuilder)[]uint8 {
            using let sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            for blob in pdbBlob.GetBlobs() {
                sha.AppendData(blob.GetBytes())
            }
            return sha.GetHashAndReset()
        }

        /// Derives the module MVID and PE timestamp from a SHA-256 hash of the
        /// serialized PE content blobs, mirroring Roslyn's deterministic emit so
        /// the same bound program always produces a byte-for-byte identical PE.
        private func ComputeDeterministicContentId(content IEnumerable[Blob]) BlobContentId {
            using let sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            for blob in content {
                sha.AppendData(blob.GetBytes())
            }
            return BlobContentId.FromHash(sha.GetHashAndReset())
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
        /// Rubber-duck follow-up to issue #2224: resolves the field a primary
        /// constructor parameter named [`name`](paramref) assigns into.
        /// Normally this is a same-named plain field ((cref:StructSymbol.TryGetField));
        /// an anonymous-class literal's synthesized type
        /// ((cref:Binding.AnonymousTypeCache)) has no plain fields at all —
        /// only get-only auto-properties — so its primary-ctor parameters instead
        /// resolve to the same-named property's (cref:PropertySymbol.BackingField).
        /// A data type may replace a positional property with a computed getter;
        /// only that case intentionally has no parameter store.
        /// @param type The declaring type.
        /// @param name The primary-ctor parameter (and target member) name.
        /// @param field The resolved backing field on success.
        /// @returns `true` if storage was found; `false` for a computed positional property.
        /// @exception InvalidOperationException A primary parameter has neither storage nor a computed
        /// positional property.
        internal func TryGetPrimaryCtorTargetField(
            type StructSymbol,
            name string,
            @NotNullWhen(true) out field FieldSymbol?
        ) bool {
            if type.TryGetField(name, out field) {
                return true
            }
            if TypeMemberModel.TryGetProperty(type, name, out var property) && property!!.BackingField != nil {
                field = property!!.BackingField
                return true
            }
            field = nil
            if type.IsData &&
                property != nil &&
                property.IsAutoProperty == false &&
                property.HasGetter == true &&
                property.IsStatic == false {
                return false
            }
            throw InvalidOperationException("Type '${type.Name}' has no field for primary ctor parameter '$name'.")
        }

        /// ADR-0087 §3 R3: returns `true` when
        /// [`structSym`](paramref) is a user-declared generic type
        /// reference whose body/field/method/ctor references must be
        /// parented at a `TypeSpec` rather than the bare TypeDef row.
        internal func IsUserGenericTypeReference(structSym StructSymbol?) bool {
            if structSym == nil {
                return false
            }
            if !structSym.TypeArguments.IsDefaultOrEmpty {
                return true
            }
            let def = structSym.Definition ?? structSym
            return !def.TypeParameters.IsDefaultOrEmpty
        }

        /// Returns whether a nested enum reference must be encoded as a TypeSpec
        /// reified over its generic enclosing type arguments.
        /// @param enumSym The enum definition or constructed reference.
        /// @returns Whether the enum reference is generic in metadata.
        internal func IsUserGenericEnumReference(enumSym EnumSymbol?) bool {
            if enumSym == nil {
                return false
            }
            let def = enumSym.Definition ?? enumSym
            return !def.TypeParameters.IsDefaultOrEmpty
        }

        /// Issue #1503: returns `true` when
        /// [`delegateSym`](paramref) is a generic named-delegate reference —
        /// either a constructed instance (carrying (cref:DelegateTypeSymbol.TypeArguments))
        /// or the open definition of a generic delegate — whose ctor/Invoke
        /// references must be parented at a `TypeSpec` rather than the bare
        /// TypeDef/MethodDef rows. Mirrors (cref:IsUserGenericTypeReference).
        /// @param delegateSym The named-delegate symbol.
        /// @returns Whether the delegate is a generic reference.
        internal func IsUserGenericDelegateReference(delegateSym DelegateTypeSymbol?) bool {
            if delegateSym == nil {
                return false
            }
            if !delegateSym.TypeArguments.IsDefaultOrEmpty {
                return true
            }
            let def = delegateSym.Definition ?? delegateSym
            return !def.TypeParameters.IsDefaultOrEmpty
        }

        // PR-E-17: widened private → internal so the extracted SignatureEncoder can
        // call it (EncodeTypeSymbol's user-generic delegate branch). Static, so
        // referenced as ReflectionMetadataEmitter.ResolveDelegateTypeArguments.
        // PR-E-19: stays on the root as a shared static (SignatureEncoder and
        // UserTokenResolver's own delegate resolvers both reach it by static
        // qualification), alongside the other IsUserGeneric*Reference predicates.
        /// Issue #1503: resolves the type arguments used to encode a generic named
        /// delegate reference. A constructed instance uses its
        /// (cref:DelegateTypeSymbol.TypeArguments); the open definition uses
        /// the self-instantiation (its own type parameters, each encoded as
        /// `VAR(idx)`).
        /// @param delegateSym The generic delegate reference.
        /// @returns The type arguments to encode in the `GENERICINST` signature.
        internal func ResolveDelegateTypeArguments(delegateSym DelegateTypeSymbol) ImmutableArray[TypeSymbol] {
            if !delegateSym.TypeArguments.IsDefaultOrEmpty {
                return delegateSym.TypeArguments
            }
            let def = delegateSym.Definition ?? delegateSym
            let defTps = def.TypeParameters
            let bld = ImmutableArray.CreateBuilder[TypeSymbol](defTps.Length)
            for tp in defTps {
                bld.Add(tp)
            }
            return bld.MoveToImmutable()
        }

        /// ADR-0091: returns `true` when
        /// [`ifaceSym`](paramref) is a user-declared generic interface
        /// reference whose method references must be parented at a
        /// `TypeSpec` rather than the bare TypeDef row.
        internal func IsUserGenericInterfaceReference(ifaceSym InterfaceSymbol?) bool {
            if ifaceSym == nil {
                return false
            }
            if !ifaceSym.TypeArguments.IsDefaultOrEmpty {
                return true
            }
            let def = ifaceSym.Definition ?? ifaceSym
            return !def.TypeParameters.IsDefaultOrEmpty
        }

        // PR-E-19: widened private → internal static so the extracted
        // UserTokenResolver can call it (ResolveUserInstanceMethodToken /
        // ResolveUserStaticMethodToken). Stays on the root — it is a shared
        // imported-method lookup, not user-token-cache state.
        internal func FindImportedMethod(
            declaringType Type,
            method FunctionSymbol,
            bindingFlags BindingFlags
        ) MethodInfo? {
            var match MethodInfo? = nil
            for candidate in declaringType.GetMethods(bindingFlags) {
                if !string.Equals(candidate.Name, method.Name, StringComparison.Ordinal) {
                    continue
                }
                let parameters = candidate.GetParameters()
                if parameters.Length != method.Parameters.Length {
                    continue
                }
                var matches = true
                for var i = 0; i < parameters.Length; i++ {
                    var candidateType Type? = parameters[i].ParameterType
                    let methodType Type? = method.Parameters[i].Type.ClrType
                    let isByRef = candidateType!!.IsByRef
                    if isByRef != (method.Parameters[i].RefKind != RefKind.None) {
                        matches = false
                        break
                    }
                    if isByRef {
                        candidateType = candidateType!!.GetElementType()
                    }
                    if methodType != nil &&
                        (candidateType == nil || !ClrTypeUtilities.AreSame(candidateType, methodType)) {
                        matches = false
                        break
                    }
                }
                if matches {
                    if match != nil {
                        // Normalization can collapse metadata-distinct overloads.
                        return nil
                    }
                    match = candidate
                }
            }
            return match
        }

        private func IsTranslatedAnonymousType(name string?) bool {
            const Prefix = "AnonymousType"
            if name == nil {
                return false
            }
            let start = name.LastIndexOf('.') + 1
            if !name.AsSpan(start).StartsWith(Prefix, StringComparison.Ordinal) {
                return false
            }
            let prefixEnd = start + Prefix.Length
            let separator = name.IndexOf('_', prefixEnd)
            if separator <= prefixEnd || name.Length - separator - 1 != 16 {
                return false
            }
            for var i = prefixEnd; i < separator; i++ {
                if !char.IsDigit(name[i]) {
                    return false
                }
            }
            for var i = separator + 1; i < name.Length; i++ {
                if !Uri.IsHexDigit(name[i]) {
                    return false
                }
            }
            return true
        }

        // Phase 4 emit parity (F1): used by call sites to decide whether a value
        // crossing the open-generic boundary needs box / unbox.any. Mirrors the
        // CLR's value-type predicate over GSharp type symbols.
        // PR-E-5: widened from `private static` to `internal static` so the
        // extracted ConversionEmitter (a sibling file in this assembly) can
        // call into the canonical value-type test without taking a hard
        // back-reference to the root emitter. The predicate itself is
        // structurally pure and has no other dependencies.
        internal func IsValueTypeSymbol(type TypeSymbol) bool {
            if type == TypeSymbol.Int32 || type == TypeSymbol.Bool {
                return true
            }
            if type is StructSymbol s && !s.IsClass {
                return true
            }
            // Issue #193: a user-defined enum is a CLR value type (sealed,
            // derives from System.Enum). Boundary boxing logic (e.g. generic
            // argument passing) must treat it as such even though it has no
            // ClrType on the symbol.
            if type is EnumSymbol {
                return true
            }
            // Issue #813: a tuple type is always a CLR value type
            // (`System.ValueTuple<...>`). When one or more of its element types
            // is an open generic parameter the symbol's ClrType is null and
            // the ClrType-based branch below misses it, so boxing decisions
            // (e.g. `(int32, T) → object`) on iterator yield paths would
            // throw GS9998 from the emitter's NotSupportedException. Recognise
            // the symbolic form directly.
            if type is TupleTypeSymbol {
                return true
            }
            if type is NullableTypeSymbol && type.UnderlyingType is TupleTypeSymbol {
                return true
            }
            // Issue #806: a `T?` over a value-type-constrained type parameter
            // lowers to `Nullable<T>` (a struct). Without recognising this
            // symbolic form, instance-method calls on the receiver would emit
            // `callvirt` + value-on-stack instead of `call` + managed pointer,
            // producing PEVerify-rejected IL.
            if type is NullableTypeSymbol nullableTp {
                let tp = nullableTp.UnderlyingType as TypeParameterSymbol
                if tp?.HasValueTypeConstraint == true {
                    return true
                }
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
            if type is NullableTypeSymbol nullableUserVt && NullableLifting.IsUserValueTypeNullable(nullableUserVt) {
                return true
            }
            if type is NullableTypeSymbol symbolicNullable && NullableLifting.RequiresSymbolicNullableGetValue(
                symbolicNullable
            ) {
                return true
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
            if type is TypeParameterSymbol bareTp && bareTp.HasValueTypeConstraint {
                return true
            }
            // Issue #3764: `ClrType.IsValueType` is asked through
            // `IsValueTypeSafe`, not directly. The raw property compares the type's
            // base against the *asking context's* `System.ValueType`, so a struct
            // that reached the compilation from outside its MetadataLoadContext's
            // core assembly answers `false` — and this predicate then selected
            // `callvirt` plus a by-value receiver for its instance calls.
            if (type?.ClrType).IsValueTypeSafe() {
                return true
            }
            return false
        }

        internal func ImportedInstanceReceiverRequiresBoxing(receiverType TypeSymbol, method MethodInfo) bool {
            var receiverType = receiverType
            if receiverType is ByRefTypeSymbol byRef {
                receiverType = byRef.PointeeType
            }
            // Issue #3764: the declaring-type question goes through the same
            // cross-context-safe predicate as the receiver one above. Asking the
            // raw property here would box a value-type receiver before calling a
            // method the value type declares itself — invalid outright for a
            // `ref struct` such as `DefaultInterpolatedStringHandler`.
            return IsValueTypeSymbol(receiverType) &&
                method?.DeclaringType != nil &&
                !method
                .DeclaringType
                .IsValueTypeSafe()
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
        internal func ArgIsSymbolicUserDefined(arg TypeSymbol?) bool {
            if arg == nil {
                return false
            }
            // Issue #2876: an IMPORTED data type's semantic aggregate is also a
            // StructSymbol (see ImportedTypeSymbol.BuildSemanticAggregate, which
            // passes `clrType: type`), yet it is fully reflection-resolvable and
            // therefore NOT symbolic. Symbolic encoding exists precisely because a
            // same-compilation user type has no CLR backing yet, which is exactly
            // the `ClrType == null` case — the identical guard already used by
            // TypeSymbol.IsSameCompilationUserTypeTopLevel for these same four
            // symbol kinds. Without it, a lambda over an imported data class made
            // its whole function type look symbolic, so
            // EmitFunctionToDelegateConversion discarded the real target delegate
            // and materialised the natural `Func`/`Action` shape instead — pushing
            // a `Func<T,bool>` where a `Predicate<T>` was expected (unverifiable
            // IL, ilverify StackUnexpected).
            if (arg is StructSymbol or InterfaceSymbol or EnumSymbol or DelegateTypeSymbol) {
                return arg.ClrType == nil
            }
            // Issue #833: an in-scope generic type parameter (MVar/Var) carried
            // through as a call-site type argument must drive the symbolic
            // encoding path so the resulting MethodSpec references `MVar(idx)`
            // / `Var(idx)` instead of the type-erased `System.Object`
            // placeholder.
            if arg is TypeParameterSymbol {
                return true
            }
            if arg is ImportedTypeSymbol nested &&
                nested.OpenDefinition != nil &&
                !nested
                .TypeArguments
                .IsDefaultOrEmpty &&
                nested
                .TypeArguments
                .Any(ArgIsSymbolicUserDefined) {
                return true
            }
            if arg is ArrayTypeSymbol arr {
                return ArgIsSymbolicUserDefined(arr.ElementType)
            }
            if arg is RectangularArrayTypeSymbol rectangular {
                return ArgIsSymbolicUserDefined(rectangular.ElementType)
            }
            if arg is SliceTypeSymbol slice {
                return ArgIsSymbolicUserDefined(slice.ElementType)
            }
            if arg is NullableTypeSymbol nullable && nullable.UnderlyingType != nil {
                return ArgIsSymbolicUserDefined(nullable.UnderlyingType)
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
            //
            // Issue #4358: `tuple.ClrType` is ALSO null whenever any element
            // merely carries a reference-nullable annotation (`(string?, int32)`)
            // — `TupleTypeSymbol.BuildClrType` deliberately nulls the whole tuple
            // out in that case (ADR-0186 / #2119 / #2702) so signature encoding
            // keeps the nullable shape symbolic. The per-element recursion above
            // does not see this: `ArgIsSymbolicUserDefined` unwraps a
            // `NullableTypeSymbol` down to its non-nullable underlying type before
            // recursing, which is correct for a bare reference-nullable
            // parameter/return (erasure keeps its own `ClrType` non-null) but
            // hides exactly the condition that poisons a *containing tuple's*
            // `ClrType`. Missing this made `FunctionTypeNeedsSymbolicDelegate`
            // answer false for a tuple-returning function type with a nullable
            // element, so both the delegate-construction site and the
            // `Invoke` call site fell back to the naive reflection path
            // (`ResolveDelegateClrType` / `ResolveDelegateArgClrType`), which
            // resolves the poisoned-null tuple `ClrType` through
            // `MapToReferenceClrType` and silently erases it to `object` —
            // producing an `Invoke` MemberRef typed `Func<string, object>` over a
            // delegate instance that is actually `Func<string, ValueTuple<string,
            // int32>>`. The struct-vs-object return calling convention mismatch
            // segfaults the runtime instead of throwing (a P0: no diagnostic, no
            // catchable exception). Checking `tuple.ClrType == null` directly
            // catches this alongside the existing same-compilation-user-type
            // recursion.
            if arg is TupleTypeSymbol tuple {
                return tuple.ClrType == nil || tuple.ElementTypes.Any(ArgIsSymbolicUserDefined)
            }
            // Issue #3501 (ilverify): a function-typed argument
            // (`List[(BoundNode) -> object?]`) reifies to `Func<…>` over its
            // parameter/return symbols in signatures, so a user type anywhere in
            // its shape makes the whole argument symbolic. Without this the
            // ctor/member refs stay erased (`List<object>`) while the local slot
            // reifies (`List<Func<BoundNode, object>>`) — a stack mismatch.
            if arg is FunctionTypeSymbol fnArg {
                return fnArg.ParameterTypes.Any(ArgIsSymbolicUserDefined) || ArgIsSymbolicUserDefined(fnArg.ReturnType)
            }
            return false
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
        internal func IsValueTypeNullable(nullable NullableTypeSymbol) bool -> NullableLifting.IsValueTypeNullable(
            nullable
        )
    }
}
