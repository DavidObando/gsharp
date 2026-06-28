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
using System.IO;
using System.Linq;
using System.Reflection;
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
    // NextParameterHandle). The four assembly-level orchestrators
    // (EmitReferenceAssemblyAttribute / EmitAssemblyInteropAttributes /
    // EmitDebuggableAttribute / EmitNullableContextAttribute) stay on the
    // root and forward into this encoder. Initialised in EmitCore alongside
    // wellKnown because it depends on GetTypeReference, which closes over
    // EmitContext.Core* materialised earlier in EmitCore.
    private CustomAttributeEncoder customAttrEncoder;

    // Phase 4 emit parity (E1): synthesized lambda bodies (no captures).
    // Populated by a pre-pass walker over every user function/entry body.
    // Each lambda's synthetic FunctionSymbol is registered alongside user
    // functions in functionsByPackage so it gets a MethodDef row, and its
    // body is emitted via the same EmitFunction path.
    private readonly Dictionary<FunctionSymbol, BoundBlockStatement> lambdaBodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();

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
    internal Dictionary<TypeParameterSymbol, int> activeIteratorStateMachineRemap;

    // Issue #810: per-SM-class remap, populated when SynthesizeIteratorStateMachines
    // creates each generic state-machine. Used to auto-push the remap inside
    // GetUserStructFieldRef when the containing type is a generic SM class
    // (so its field-signature MemberRef matches the FieldDef blob exactly).
    internal readonly Dictionary<StructSymbol, Dictionary<TypeParameterSymbol, int>> iteratorStateMachineRemapsByClass = new Dictionary<StructSymbol, Dictionary<TypeParameterSymbol, int>>();

    /// <summary>
    /// Issue #810: push the SM remap for <paramref name="smClass"/> so that
    /// every <see cref="EncodeTypeSymbol"/> call made before the returned
    /// disposable is disposed translates outer-method type-parameter
    /// references into the SM class's own type-parameter slots
    /// (Var(idx) instead of MVar(idx)). Calls are nestable; on dispose the
    /// previous remap (or <see langword="null"/>) is restored.
    /// </summary>
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

    internal readonly struct SmRemapScope : IDisposable
    {
        private readonly ReflectionMetadataEmitter owner;
        private readonly Dictionary<TypeParameterSymbol, int> previous;
        private readonly bool restore;

        public SmRemapScope(ReflectionMetadataEmitter owner, Dictionary<TypeParameterSymbol, int> previous, bool restore)
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

    private ReflectionMetadataEmitter(BoundProgram program, ReferenceResolver references, string assemblyName, bool metadataOnly)
    {
        this.emitCtx = new EmitContext(program, references, assemblyName, metadataOnly);
        this.cache = new MetadataTokenCache();
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
        this.customAttrEncoder = new CustomAttributeEncoder(this.emitCtx, this.wellKnown, this.GetTypeReference);

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
            this.EncodeTypeSymbol);

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
            this.EncodeTypeSymbol,
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
            this.EncodeTypeSymbol,
            this.customAttrEncoder.NextParameterHandle,
            this.GetTypeReference,
            this.GetTypeHandleForMember,
            this.ResolveFieldToken,
            this.customAttrEncoder.EmitNullableAttributeOnProperty);

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
            this.EncodeTypeSymbol,
            this.EncodeReturnSymbol,
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
            this.EmitStaticConstructorBodyBytes,
            this.EmitClassDefaultConstructorBodyBytes,
            this.EmitClassPrimaryConstructorBodyBytes,
            this.EmitClassConstructorWithBaseInitializerBodyBytes,
            this.EmitClassConstructorWithBodyBodyBytes,
            this.EmitClassDeinitializerBodyBytes);

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
            this.EncodeTypeSymbol,
            this.EncodeClrType,
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
                this.iteratorStateMachineRemapsByClass[kvp.Key] = remap;
            }
        }

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
                list = new List<TypeSymbol>();
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

                // ADR-0089 / issue #1019: for a static-virtual interface
                // property, register the accessor FunctionSymbols against
                // their planned MethodDef rows so `constrained.` dispatch
                // (`T.Prop` → get_Prop) resolves the slot handle, exactly as
                // for static-virtual interface methods.
                if (prop.IsStatic)
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
            }

            // ADR-0052: plan accessor method rows for interface events.
            foreach (var ev in i.Events)
            {
                var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
                MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
                this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
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
            if (!c.StaticFieldInitializers.IsEmpty)
            {
                this.cache.CctorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow++);
            }
        }

        foreach (var c in topClasses)
        {
            PlanClassMethods(c);
        }

        // Plan method rows for non-SM structs.
        var structFirstMethodRows = new Dictionary<StructSymbol, int>();
        void PlanStructMethods(StructSymbol s)
        {
            if (s.Methods.IsDefaultOrEmpty && !s.IsInline && !s.IsData && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty)
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
                // op_Equality, op_Inequality, Deconstruct.
                methodRow += 7;
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
            if (!s.StaticFieldInitializers.IsEmpty)
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
            this.typeDefEmitter.EmitStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);
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
                    this.typeDefEmitter.EmitStructTypeDef(ns, structFirstFieldRow[ns], nestedMethodListRow[ns]);
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
            functionsByPackage[pkg] = new List<FunctionSymbol>();
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

            var owningPackage = kvp.Key.Package ?? this.emitCtx.Program.EntryPointPackage ?? packages[0];
            if (!functionsByPackage.TryGetValue(owningPackage, out var bucket))
            {
                bucket = new List<FunctionSymbol>();
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
                hostBucket = new List<FunctionSymbol>();
                functionsByPackage[lambdaHostPackage] = hostBucket;
                packages = packages.Add(lambdaHostPackage);
            }

            foreach (var literal in lambdaLiterals)
            {
                if (literal.CapturedVariables.Length > 0)
                {
                    continue;
                }

                this.lambdaBodies[literal.Function] = (BoundBlockStatement)Lowerer.Lower(literal.Body);
                hostBucket.Add(literal.Function);
            }
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

            if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage)
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
            entryHandle = this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint];
        }

        // Pre-register SM class ctor handles so iterator kickoff bodies
        // (emitted during B4) can reference them for newobj calls.
        foreach (var c in smClasses)
        {
            this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(classCtorRows[c]);
        }

        // Issue #503 / #523 / #920: pre-register EVERY non-SM user class's
        // constructor handle(s) from the planned ctor rows BEFORE any method
        // body is emitted. A class method (or `init` body) may `newobj` another
        // class — including a sibling class declared later, a capturing-lambda
        // closure class, a capture box, or a NESTED class — whose ctor body is
        // emitted later in the pass. Without an up-front handle the construction
        // site cannot resolve the ctor token and EmitConstructorCall throws
        // "Type '…' has no emitted primary ctor." (issue #920: this always bites
        // nested classes, because the enclosing class's method bodies are
        // emitted in the top-level pass strictly before the unified nested-type
        // pass that records nested ctors). The closure ctor's MethodDef row is
        // already reserved by the planner at line ~733, and PlanClassMethods has
        // reserved classCtorRows/classPrimaryCtorRows for every other class
        // (top-level and nested), so claim those handles now (same trick used
        // for SM classes above). The actual ctor bodies are still emitted in the
        // planned row order during the class-method-body pass below; this loop
        // mirrors EmitClassMethodBodies' exact per-overload / primary /
        // base-forwarding row assignment so the pre-registered handles equal the
        // handles produced during emission.
        foreach (var c in nonSmClasses)
        {
            if (!classCtorRows.TryGetValue(c, out var firstCtorRow))
            {
                continue;
            }

            if (c.ExplicitConstructor != null)
            {
                // ADR-0063 §9 / ADR-0065 §5: each declared `init(...)` overload
                // (and the synthesized-from-primary designated init) occupies a
                // contiguous MethodDef row starting at firstCtorRow. The first
                // overload also doubles as the legacy class/primary ctor handle.
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
                // Issue #306: a single forwarding ctor occupies firstCtorRow and
                // serves as both the class ctor and the primary ctor handle.
                var forwardingHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow);
                this.cache.ClassCtorHandles[c] = forwardingHandle;
                this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle;
            }
            else
            {
                // Default-only ctor (covers user classes with no ctor, capture
                // boxes, and synthesized closure classes) plus an optional
                // separate primary ctor row.
                this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(firstCtorRow);

                if (c.HasPrimaryConstructor && classPrimaryCtorRows.TryGetValue(c, out var primaryRow))
                {
                    this.cache.ClassPrimaryCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(primaryRow);
                }
            }
        }

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
            using (this.PushSmRemap(c))
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
            this.typeDefEmitter.EmitNestedStructTypeDef(s, structFirstFieldRow[s], smMethodListRow);

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

            // ADR-0052: emit abstract accessor MethodDefs + EventDef rows for interface events.
            this.memberDefEmitter.EmitInterfaceEventAccessors(i);

            // ADR-0089 / issue #1030: emit the interface .cctor running static
            // field initializers. Emitted LAST (after property/event accessors)
            // to match the row reserved in PlanInterfaceMethods.
            if (!i.StaticFieldInitializers.IsEmpty)
            {
                this.EmitInterfaceStaticConstructor(i);
            }
        }

        foreach (var i in topInterfaces)
        {
            EmitInterfaceMethodBodies(i);
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
                        var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: false);
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
            this.EmitStaticVirtualMethodImpls(c);

            // ADR-0089 / issue #1019: emit MethodImpl rows for static-virtual
            // interface properties (accessor methods).
            this.EmitStaticVirtualPropertyMethodImpls(c);

            // Issue #985: emit MethodImpl rows for covariant-return interface
            // bridges (e.g. the non-generic IEnumerable.GetEnumerator).
            this.EmitExplicitInterfaceMethodImpls(c);
        }

        foreach (var c in topClasses)
        {
            EmitClassMethodBodies(c);
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

            if (s.Methods.IsDefaultOrEmpty && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty)
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
            this.EmitStaticVirtualMethodImpls(s);

            // ADR-0089 / issue #1019: emit MethodImpl rows for static-virtual
            // interface properties (accessor methods).
            this.EmitStaticVirtualPropertyMethodImpls(s);

            // Issue #985: emit MethodImpl rows for covariant-return interface
            // bridges declared on a struct that implements `IEnumerable[T]` &c.
            this.EmitExplicitInterfaceMethodImpls(s);
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
                    EmitClassMethodBodies(ns);
                    break;
                case StructSymbol ns:
                    EmitStructMethodBodies(ns);
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

                this.EmitFunction(fn, body, isEntryPoint: false);
            }

            if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage)
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
            using (this.PushSmRemap(c))
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
                this.stateMachines.EmitStateMachineMoveNext(smPlan);
                this.stateMachines.EmitStateMachineSetStateMachine(smPlan);
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
            version: this.ParseAssemblyVersion(),
            culture: default(StringHandle),
            publicKey: default(BlobHandle),
            flags: 0,
            hashAlgorithm: AssemblyHashAlgorithm.Sha1);

        if (this.emitCtx.MetadataOnly)
        {
            this.EmitReferenceAssemblyAttribute(assemblyHandle);
        }

        // Phase 7.7b: emit cross-language interop attributes for NuGet consumability.
        this.EmitAssemblyInteropAttributes(assemblyHandle);
        if (!this.emitCtx.MetadataOnly && this.emitCtx.Pdb != null)
        {
            this.EmitDebuggableAttribute(assemblyHandle);
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
    /// Marks the assembly with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute()</c> so
    /// loaders treat it as metadata-only and refuse to execute its (absent)
    /// method bodies.
    /// </summary>
    private void EmitReferenceAssemblyAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.ReferenceAssemblyAttribute", out var resolved)
            ? resolved
            : throw new InvalidOperationException(
                "Reference assembly emit requires System.Runtime.CompilerServices.ReferenceAssemblyAttribute to be resolvable from the supplied references.");
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        // Empty fixed/named argument blob: prolog 0x0001 + 0 named args.
        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Parses <see cref="EmitContext.AssemblyVersionOverride"/> into a <see cref="Version"/> suitable
    /// for the assembly row. Falls back to <c>1.0.0.0</c> when the string is absent or
    /// does not parse as a version.
    /// </summary>
    private Version ParseAssemblyVersion()
    {
        if (string.IsNullOrEmpty(this.emitCtx.AssemblyVersionOverride))
        {
            return new Version(1, 0, 0, 0);
        }

        // NuGet versions can contain pre-release suffixes (e.g. "1.2.3-beta.1").
        // Extract just the numeric prefix for System.Version.
        var versionStr = this.emitCtx.AssemblyVersionOverride;
        var dashIdx = versionStr.IndexOf('-');
        if (dashIdx >= 0)
        {
            versionStr = versionStr.Substring(0, dashIdx);
        }

        var plusIdx = versionStr.IndexOf('+');
        if (plusIdx >= 0)
        {
            versionStr = versionStr.Substring(0, plusIdx);
        }

        if (Version.TryParse(versionStr, out var v))
        {
            // Pad to four components for ECMA-335 assembly identity.
            return new Version(
                Math.Max(v.Major, 0),
                Math.Max(v.Minor, 0),
                Math.Max(v.Build, 0),
                Math.Max(v.Revision, 0));
        }

        return new Version(1, 0, 0, 0);
    }

    /// <summary>
    /// Emits assembly-level attributes required for cross-language interop (C#/F#
    /// consumability): <c>AssemblyInformationalVersionAttribute</c>,
    /// <c>AssemblyMetadataAttribute("RepositoryUrl", ...)</c>, and
    /// <c>NullableContextAttribute(1)</c>.
    /// </summary>
    private void EmitAssemblyInteropAttributes(AssemblyDefinitionHandle assemblyHandle)
    {
        // 1. AssemblyInformationalVersionAttribute — carries the full NuGet
        // version string including pre-release suffix.
        if (!string.IsNullOrEmpty(this.emitCtx.AssemblyVersionOverride))
        {
            this.customAttrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyInformationalVersionAttribute",
                typeof(System.Reflection.AssemblyInformationalVersionAttribute),
                this.emitCtx.AssemblyVersionOverride);
        }

        // 2. NullableContextAttribute(1) — declares the assembly's default
        // nullable context as "annotated" so C# consumers see non-null by
        // default for GSharp types (GSharp has no null references).
        this.EmitNullableContextAttribute(assemblyHandle);
    }

    /// <summary>
    /// Emits <c>System.Diagnostics.DebuggableAttribute(true, true)</c> when
    /// debug information is present so managed debuggers treat the assembly as
    /// JIT-tracked and non-optimized.
    /// </summary>
    private void EmitDebuggableAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.emitCtx.References.TryResolveType("System.Diagnostics.DebuggableAttribute", out var resolved)
            ? resolved
            : typeof(System.Diagnostics.DebuggableAttribute);
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), p =>
            {
                p.AddParameter().Type().Boolean();
                p.AddParameter().Type().Boolean();
            });

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteBoolean(true);  // isJITTrackingEnabled
        valueBlob.WriteBoolean(true);  // isJITOptimizerDisabled
        valueBlob.WriteUInt16(0);      // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Emits <c>System.Runtime.CompilerServices.NullableContextAttribute(1)</c>
    /// on the assembly so C# consumers see GSharp public surface as non-nullable
    /// (oblivious context = 0, annotated = 1, warnings-only = 2).
    /// </summary>
    private void EmitNullableContextAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        // Reuse the cached NullableContextAttribute(byte) ctor MemberRef so the
        // assembly-, type-, and method-level emitters all share one row (the
        // P3-11 dedup invariant; see DeterministicEmitTests).
        var ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef();
        if (ctorRef.IsNil)
        {
            // The attribute may not exist in older TFMs — skip silently.
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteByte(1);        // Flag = Annotated (non-null by default)
        valueBlob.WriteUInt16(0);      // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
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

            // Pre-scan locals, labels, and the rest for the body emitter.
            var locals = new Dictionary<VariableSymbol, int>();
            var labels = new Dictionary<BoundLabel, LabelHandle>();
            var localTypes = new List<TypeSymbol>();
            var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
            var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
            var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
            var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
            var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
            var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
            var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
            var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
            var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
            var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
            var receiverSpillSlots = new Dictionary<BoundExpression, int>();
            var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
            var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
            var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
            var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();

            // Issue #216: collect compile-time const bindings before slot allocation.
            var constValues = new Dictionary<VariableSymbol, object>();
            MethodBodyPlanner.CollectConstValues(body, constValues);

            this.methodBodyPlanner.CollectLocalsAndLabels(
                body,
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                liftedBinarySlots,
                nullableCoalesceSpillSlots,
                il);

            // MoveNext is instance on the SM struct: arg0 = this.
            var parameters = new Dictionary<ParameterSymbol, int>
            {
                [moveNextBody.ThisParameter] = 0,
            };

            StandaloneSignatureHandle localsSignature = default;
            if (localTypes.Count > 0)
            {
                var localsSigBlob = new BlobBuilder();
                var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                foreach (var t in localTypes)
                {
                    EncodeLocalVariableType(encoder.AddVariable(), t);
                }

                localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
            }

            var emitter = new MethodBodyEmitter(
                this,
                il,
                locals,
                parameters,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                liftedBinarySlots: liftedBinarySlots,
                nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
                constValues: constValues,
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

            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
            capturedSequencePoints = emitter.SequencePoints;
            capturedLocals = MethodBodyPlanner.CollectLocalInfo(locals);
            capturedConstants = MethodBodyPlanner.CollectLocalConstantInfo(constValues);
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
    private void EncodeAsyncReturnType(ReturnTypeEncoder encoder, AsyncStateMachinePlan plan)
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

    // ----- PR-E-8 TypeDefEmitter body-emission callbacks ----------------
    // These three helpers were extracted from EmitStaticConstructor,
    // EmitClassConstructorWithBaseInitializer, and EmitClassConstructorWithBody
    // when those methods moved to TypeDefEmitter. They retain the
    // BodyEmitter-driven IL emission so the still-private BodyEmitter
    // nested class doesn't need a sibling-facing surface — TypeDefEmitter
    // calls them via injected Func<…> callbacks. They are scheduled to
    // move with BodyEmitter in PR-E-11 MethodBodyEmitter.

    /// <summary>
    /// Issue #262: builds the IL body for a static constructor (<c>.cctor</c>)
    /// that runs each <see cref="StructSymbol.StaticFieldInitializers"/> in
    /// declaration order. Returns the resulting body offset.
    /// </summary>
    private int EmitStaticConstructorBodyBytes(StructSymbol typeSym)
    {
        // Build a synthetic body: for each field with an initializer,
        // emit the expression + stsfld.
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in typeSym.StaticFields)
        {
            if (typeSym.StaticFieldInitializers.TryGetValue(field, out var initExpr))
            {
                // Synthesize: field = initExpr (as an expression statement).
                var assignment = new BoundFieldAssignmentExpression(null, null, typeSym, field, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        var body = new BoundBlockStatement(null, statements.ToImmutable());
        return this.EmitStaticConstructorBodyFromBlock(body, typeSym.Declaration);
    }

    /// <summary>
    /// ADR-0089 / issue #1030: emits the interface <c>.cctor</c> (type
    /// initializer) running the interface's static-field initializers. Mirrors
    /// <c>TypeDefEmitter.EmitStaticConstructor</c> but resolves the body via the
    /// interface-specific body-bytes helper. The MethodDef lands in the row
    /// reserved by PlanInterfaceMethods (last in the interface's method run).
    /// </summary>
    /// <param name="ifaceSym">The interface whose static constructor is emitted.</param>
    private void EmitInterfaceStaticConstructor(InterfaceSymbol ifaceSym)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            bodyOffset = this.EmitInterfaceStaticConstructorBodyBytes(ifaceSym);
        }

        var cctorSig = new BlobBuilder();
        new BlobEncoder(cctorSig).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => r.Void(), _ => { });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(cctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.customAttrEncoder.NextParameterHandle());
    }

    /// <summary>
    /// ADR-0089 / issue #1030: builds the IL body for an interface
    /// <c>.cctor</c> running each interface static-field initializer in
    /// declaration order. Interface static fields are plain CLR static fields,
    /// so the synthesized assignment carries a <c>null</c> declaring struct and
    /// the emitter resolves the field handle by symbol identity.
    /// </summary>
    /// <param name="ifaceSym">The interface whose static initializers run.</param>
    /// <returns>The resulting method body offset.</returns>
    private int EmitInterfaceStaticConstructorBodyBytes(InterfaceSymbol ifaceSym)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in ifaceSym.StaticFields)
        {
            if (ifaceSym.StaticFieldInitializers.TryGetValue(field, out var initExpr))
            {
                var assignment = new BoundFieldAssignmentExpression(null, field, ifaceSym, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        var body = new BoundBlockStatement(null, statements.ToImmutable());
        return this.EmitStaticConstructorBodyFromBlock(body, ifaceSym.Declaration);
    }

    /// <summary>
    /// Shared IL-emission core for a synthesized <c>.cctor</c> body (Issue #262
    /// / issue #1030). Plans locals/labels, emits the block, appends
    /// <c>ret</c>, and returns the resulting body offset.
    /// </summary>
    /// <param name="body">The synthesized static-constructor block.</param>
    /// <param name="anchor">The declaring-type syntax used as the diagnostic anchor.</param>
    /// <returns>The resulting method body offset.</returns>
    private int EmitStaticConstructorBodyFromBlock(BoundBlockStatement body, SyntaxNode anchor)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
        var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
        var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
        var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
        var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
        var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
        var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
        var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
        var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
        var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
        var receiverSpillSlots = new Dictionary<BoundExpression, int>();
        var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
        var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
        var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();
        var constValues = new Dictionary<VariableSymbol, object>();

        this.methodBodyPlanner.CollectLocalsAndLabels(
            body,
            null,
            locals,
            localTypes,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots,
            nullableCoalesceSpillSlots,
            il);

        var parameters = new Dictionary<ParameterSymbol, int>();

        StandaloneSignatureHandle localsSignature = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var emitter = new MethodBodyEmitter(
            this,
            il,
            locals,
            parameters,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots: liftedBinarySlots,
            nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
            constValues: constValues);

        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var fallbackAnchor = emitter.CurrentAnchor ?? anchor;
            EmitDiagnosticException.Wrap(fallbackAnchor, ex);
        }

        il.OpCode(ILOpCode.Ret);

        return this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #640: builds the IL body for a default parameterless constructor
    /// that calls the base ctor and then evaluates instance field initializers
    /// in declaration order. Returns the resulting body offset.
    /// </summary>
    private int EmitClassDefaultConstructorBodyBytes(StructSymbol classSym, EntityHandle baseCtorToken)
    {
        // Synthesize a `this` parameter for the field-initializer receiver.
        var thisParam = new ParameterSymbol("this", classSym);

        // Synthesize field-initializer assignment statements.
        var statements = BuildInstanceFieldInitializerStatements(classSym, thisParam);
        var body = new BoundBlockStatement(null, statements);

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
        var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
        var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
        var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
        var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
        var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
        var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
        var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
        var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
        var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
        var receiverSpillSlots = new Dictionary<BoundExpression, int>();
        var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
        var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
        var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();
        var constValues = new Dictionary<VariableSymbol, object>();

        this.methodBodyPlanner.CollectLocalsAndLabels(
            body,
            null,
            locals,
            localTypes,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots,
            nullableCoalesceSpillSlots,
            il);

        var parameters = new Dictionary<ParameterSymbol, int>
        {
            [thisParam] = 0,
        };

        StandaloneSignatureHandle localsSignature = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var emitter = new MethodBodyEmitter(
            this,
            il,
            locals,
            parameters,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots: liftedBinarySlots,
            nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
            constValues: constValues);

        // base()
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Call);
        il.Token(baseCtorToken);

        // Instance field initializers
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #640: builds the IL body for a primary constructor that calls
    /// the base ctor, assigns primary-ctor parameters into their same-named
    /// fields, and then evaluates instance field initializers in declaration
    /// order. Returns the resulting body offset.
    /// </summary>
    private int EmitClassPrimaryConstructorBodyBytes(StructSymbol classSym, EntityHandle baseCtorToken)
    {
        var parameters = classSym.PrimaryConstructorParameters;

        // Synthesize a `this` parameter for the field-initializer receiver.
        var thisParam = new ParameterSymbol("this", classSym);

        // Synthesize field-initializer assignment statements.
        var statements = BuildInstanceFieldInitializerStatements(classSym, thisParam);
        var body = new BoundBlockStatement(null, statements);

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
        var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
        var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
        var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
        var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
        var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
        var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
        var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
        var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
        var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
        var receiverSpillSlots = new Dictionary<BoundExpression, int>();
        var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
        var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
        var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();
        var constValues = new Dictionary<VariableSymbol, object>();

        this.methodBodyPlanner.CollectLocalsAndLabels(
            body,
            null,
            locals,
            localTypes,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots,
            nullableCoalesceSpillSlots,
            il);

        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [thisParam] = 0,
        };
        for (var i = 0; i < parameters.Length; i++)
        {
            paramSlots[parameters[i]] = i + 1;
        }

        StandaloneSignatureHandle localsSignature = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var emitter = new MethodBodyEmitter(
            this,
            il,
            locals,
            paramSlots,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots: liftedBinarySlots,
            nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
            constValues: constValues);

        // base()
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Call);
        il.Token(baseCtorToken);

        // Primary ctor parameter → field assignments. ADR-0087 §3 R3:
        // for a generic class the stfld must reference the field via
        // a MemberRef parented at the self-instantiation TypeSpec so
        // ilverify accepts the receiver type (`Box`1<!0>`).
        for (var i = 0; i < parameters.Length; i++)
        {
            var param = parameters[i];
            if (!classSym.TryGetField(param.Name, out var field))
            {
                throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
            }

            var fieldHandle = this.ResolveFieldToken(classSym, field);

            il.LoadArgument(0);
            il.LoadArgument(i + 1);
            il.OpCode(ILOpCode.Stfld);
            il.Token(fieldHandle);
        }

        // Instance field initializers
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #640: builds the bound assignment statements for all instance
    /// field initializers in declaration order. Used by the default, primary,
    /// forwarding, and explicit constructor body emitters.
    /// </summary>
    private static ImmutableArray<BoundStatement> BuildInstanceFieldInitializerStatements(StructSymbol classSym, ParameterSymbol thisParam = null)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        foreach (var field in classSym.Fields)
        {
            if (classSym.InstanceFieldInitializers.TryGetValue(field, out var initExpr))
            {
                var assignment = new BoundFieldAssignmentExpression(null, thisParam, classSym, field, initExpr);
                statements.Add(new BoundExpressionStatement(null, assignment));
            }
        }

        return statements.ToImmutable();
    }

    /// <summary>
    /// Issue #306: builds the IL body for a forwarding constructor that
    /// runs <c>base(args)</c> before assigning the primary-constructor
    /// parameters into their same-named fields. Returns the resulting
    /// body offset.
    /// </summary>
    private int EmitClassConstructorWithBaseInitializerBodyBytes(
        StructSymbol classSym,
        ImmutableArray<ParameterSymbol> parameters,
        BaseConstructorInitializer init,
        EntityHandle baseCtorToken)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

        // Synthesize a `this` parameter for the field-initializer receiver.
        var thisParam = new ParameterSymbol("this", classSym);

        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
        var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
        var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
        var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
        var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
        var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
        var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
        var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
        var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
        var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
        var receiverSpillSlots = new Dictionary<BoundExpression, int>();
        var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
        var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
        var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();
        var constValues = new Dictionary<VariableSymbol, object>();

        // Pre-scan the base arguments so any scratch slots they require are
        // allocated and registered in the locals signature.
        if (!init.Arguments.IsDefaultOrEmpty)
        {
            var synth = ImmutableArray.CreateBuilder<BoundStatement>(init.Arguments.Length);
            foreach (var arg in init.Arguments)
            {
                synth.Add(new BoundExpressionStatement(null, arg));
            }

            this.methodBodyPlanner.CollectLocalsAndLabels(
                new BoundBlockStatement(null, synth.ToImmutable()),
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                liftedBinarySlots,
                nullableCoalesceSpillSlots,
                il);
        }

        // Issue #640: pre-scan instance field initializer expressions for locals.
        BoundBlockStatement fieldInitBody = null;
        if (!classSym.InstanceFieldInitializers.IsEmpty)
        {
            fieldInitBody = new BoundBlockStatement(null, BuildInstanceFieldInitializerStatements(classSym, thisParam));
            this.methodBodyPlanner.CollectLocalsAndLabels(
                fieldInitBody,
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                liftedBinarySlots,
                nullableCoalesceSpillSlots,
                il);
        }

        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [thisParam] = 0,
        };
        for (var i = 0; i < parameters.Length; i++)
        {
            paramSlots[parameters[i]] = i + 1;
        }

        StandaloneSignatureHandle localsSignature = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var emitter = new MethodBodyEmitter(
            this,
            il,
            locals,
            paramSlots,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots: liftedBinarySlots,
            nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
            constValues: constValues);

        // base(args)
        il.LoadArgument(0);
        if (!init.Arguments.IsDefaultOrEmpty)
        {
            foreach (var arg in init.Arguments)
            {
                emitter.EmitValue(arg);
            }
        }

        il.OpCode(ILOpCode.Call);
        il.Token(baseCtorToken);

        // this.<field> = arg; positional 1:1 with same-named fields.
        for (var i = 0; i < parameters.Length; i++)
        {
            var param = parameters[i];
            if (!classSym.TryGetField(param.Name, out var field))
            {
                throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
            }

            if (!this.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle))
            {
                throw new InvalidOperationException($"Class field '{field.Name}' has no emitted FieldDef.");
            }

            il.LoadArgument(0);
            il.LoadArgument(i + 1);
            il.OpCode(ILOpCode.Stfld);
            il.Token(fieldHandle);
        }

        // Issue #640: emit instance field initializer assignments.
        if (fieldInitBody != null)
        {
            try
            {
                emitter.EmitBlock(fieldInitBody);
            }
            catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
            {
                var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
                EmitDiagnosticException.Wrap(anchor, ex);
            }
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// Issue #306: builds the IL body for a class constructor materialized
    /// from an explicit <c>init(...)</c> declaration. Chains to the base
    /// (either the explicit <c>: base(args)</c> initializer or the
    /// conventional parameterless chain) and then runs the user-authored
    /// constructor body via <see cref="MethodBodyEmitter.EmitBlock"/>. Returns
    /// the resulting body offset.
    /// </summary>
    private int EmitClassConstructorWithBodyBodyBytes(
        StructSymbol classSym,
        ConstructorSymbol ctor,
        BaseConstructorInitializer init,
        EntityHandle baseCtorToken)
    {
        var function = ctor.Function;
        var body = this.emitCtx.Program.Functions[function];

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
        var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
        var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
        var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
        var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
        var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
        var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
        var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
        var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
        var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
        var receiverSpillSlots = new Dictionary<BoundExpression, int>();
        var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
        var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
        var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();
        var constValues = new Dictionary<VariableSymbol, object>();

        // Pre-scan the base arguments so any scratch slots they require are
        // allocated and registered in the locals signature. ADR-0065 §2:
        // convenience inits skip the base-call emission so their `init`
        // syntax-side `: base()` (if present, but rejected at bind time) and
        // the implicit empty-args case are irrelevant here.
        if (!ctor.IsConvenience && init != null && !init.Arguments.IsDefaultOrEmpty)
        {
            var synth = ImmutableArray.CreateBuilder<BoundStatement>(init.Arguments.Length);
            foreach (var arg in init.Arguments)
            {
                synth.Add(new BoundExpressionStatement(null, arg));
            }

            this.methodBodyPlanner.CollectLocalsAndLabels(
                new BoundBlockStatement(null, synth.ToImmutable()),
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                liftedBinarySlots,
                nullableCoalesceSpillSlots,
                il);
        }

        // Issue #640: pre-scan instance field initializer expressions for locals.
        // ADR-0065 §2: convenience inits skip field-init emission (the
        // chained-to designated init handles them), so don't reserve scratch
        // slots for those expressions either.
        BoundBlockStatement fieldInitBody = null;
        if (!ctor.IsConvenience && !classSym.InstanceFieldInitializers.IsEmpty)
        {
            fieldInitBody = new BoundBlockStatement(null, BuildInstanceFieldInitializerStatements(classSym, function.ThisParameter));
            this.methodBodyPlanner.CollectLocalsAndLabels(
                fieldInitBody,
                null,
                locals,
                localTypes,
                labels,
                appendSlots,
                structLiteralSlots,
                defaultExpressionSlots,
                mapIndexSlots,
                patternSwitchSlots,
                typePatternScratchSlots,
                switchExpressionSlots,
                channelOpSlots,
                scopeFrameSlots,
                selectStatementSlots,
                receiverSpillSlots,
                indexAssignmentValueSlots,
                goEnclosingScopes,
                liftedBinarySlots,
                nullableCoalesceSpillSlots,
                il);
        }

        MethodBodyPlanner.CollectConstValues(body, constValues);
        this.methodBodyPlanner.CollectLocalsAndLabels(
            body,
            function,
            locals,
            localTypes,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots,
            nullableCoalesceSpillSlots,
            il);

        // Slot 0 is the implicit `this`; user parameters shift up by one.
        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [function.ThisParameter] = 0,
        };
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            paramSlots[function.Parameters[i]] = i + 1;
        }

        StandaloneSignatureHandle localsSignature = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var emitter = new MethodBodyEmitter(
            this,
            il,
            locals,
            paramSlots,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots: liftedBinarySlots,
            nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
            constValues: constValues);

        // ADR-0065 §2: a `convenience init(...)` does NOT chain to the base
        // constructor itself — the user-authored body begins with an
        // `init(args)` self-delegation (BoundConstructorChainingExpression)
        // that calls a sibling constructor on the same class. That sibling
        // is responsible for the base chain. We also skip the instance
        // field-initializer emit step here: the chained-to designated
        // initializer will run those initializers exactly once.
        if (!ctor.IsConvenience)
        {
            // base(args) — `this` followed by the (ref-kind aware) base arguments.
            il.LoadArgument(0);
            if (init != null && !init.Arguments.IsDefaultOrEmpty)
            {
                emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds);
            }

            il.OpCode(ILOpCode.Call);
            il.Token(baseCtorToken);

            // Issue #640: emit instance field initializer assignments before
            // the user-authored constructor body (matching C# semantics).
            if (fieldInitBody != null)
            {
                try
                {
                    emitter.EmitBlock(fieldInitBody);
                }
                catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
                {
                    var anchor = emitter.CurrentAnchor ?? classSym.Declaration;
                    EmitDiagnosticException.Wrap(anchor, ex);
                }
            }
        }

        // Run the user-authored constructor body.
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration ?? body.Syntax;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
    }

    // ADR-0068 / issue #698: emits the body of the synthesized `Finalize`
    // override produced by a class `deinit { … }`. The body wraps the
    // lowered user body in `try { … } finally { base.Finalize(); }` exactly
    // as the C# compiler emits for `~Type()`. Mirrors the locals/labels
    // pre-scan scaffolding from `EmitClassConstructorWithBodyBodyBytes`.
    private int EmitClassDeinitializerBodyBytes(
        StructSymbol classSym,
        DeinitSymbol deinit,
        BoundBlockStatement body,
        EntityHandle baseFinalizeRef)
    {
        _ = classSym;
        var function = deinit.Function;

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

        var locals = new Dictionary<VariableSymbol, int>();
        var labels = new Dictionary<BoundLabel, LabelHandle>();
        var localTypes = new List<TypeSymbol>();
        var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
        var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
        var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
        var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
        var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
        var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
        var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
        var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
        var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
        var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
        var receiverSpillSlots = new Dictionary<BoundExpression, int>();
        var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
        var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
        var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
        var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();
        var constValues = new Dictionary<VariableSymbol, object>();

        MethodBodyPlanner.CollectConstValues(body, constValues);
        this.methodBodyPlanner.CollectLocalsAndLabels(
            body,
            function,
            locals,
            localTypes,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots,
            nullableCoalesceSpillSlots,
            il);

        // Slot 0 is the implicit `this`; deinit has no user parameters.
        var paramSlots = new Dictionary<ParameterSymbol, int>
        {
            [function.ThisParameter] = 0,
        };

        StandaloneSignatureHandle localsSignature = default;
        if (localTypes.Count > 0)
        {
            var localsSigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
            foreach (var t in localTypes)
            {
                EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var emitter = new MethodBodyEmitter(
            this,
            il,
            locals,
            paramSlots,
            labels,
            appendSlots,
            structLiteralSlots,
            defaultExpressionSlots,
            mapIndexSlots,
            patternSwitchSlots,
            typePatternScratchSlots,
            switchExpressionSlots,
            channelOpSlots,
            scopeFrameSlots,
            selectStatementSlots,
            receiverSpillSlots,
            indexAssignmentValueSlots,
            goEnclosingScopes,
            liftedBinarySlots: liftedBinarySlots,
            nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
            constValues: constValues);

        // Wrap the user body in try { … } finally { base.Finalize(); }.
        // Matches the IL shape Roslyn emits for `~Type()`. The base
        // Finalize target is the closest user-declared base `deinit` (if
        // any) — emit a non-virtual `call` to its MethodDef — otherwise
        // chain straight to System.Object::Finalize().
        var tryStart = il.DefineLabel();
        var finallyStart = il.DefineLabel();
        var finallyEnd = il.DefineLabel();

        il.MarkLabel(tryStart);
        try
        {
            emitter.EmitBlock(body);
        }
        catch (Exception ex) when (ex is not EmitDiagnosticException and not OutOfMemoryException and not StackOverflowException)
        {
            var anchor = emitter.CurrentAnchor ?? classSym.Declaration ?? body.Syntax;
            EmitDiagnosticException.Wrap(anchor, ex);
        }

        il.Branch(ILOpCode.Leave, finallyEnd);

        il.MarkLabel(finallyStart);
        il.LoadArgument(0);
        il.OpCode(ILOpCode.Call);

        EntityHandle baseFinalizeToken = baseFinalizeRef;
        for (var ancestor = classSym.BaseClass; ancestor != null; ancestor = ancestor.BaseClass)
        {
            if (ancestor.Deinitializer != null
                && this.cache.MethodHandles.TryGetValue(ancestor.Deinitializer.Function, out var ancestorHandle))
            {
                baseFinalizeToken = ancestorHandle;
                break;
            }
        }

        il.Token(baseFinalizeToken);
        il.OpCode(ILOpCode.Endfinally);
        il.MarkLabel(finallyEnd);

        il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);

        il.OpCode(ILOpCode.Ret);
        return this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
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
                bodyOffset = this.stateMachines.EmitAsyncKickoffBody(function, asyncPlan);
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());

                // Pre-scan body for locals (top-level only — Lowerer flattens blocks) and labels.
                var locals = new Dictionary<VariableSymbol, int>();
                var labels = new Dictionary<BoundLabel, LabelHandle>();
                var localTypes = new List<TypeSymbol>();
                var appendSlots = new Dictionary<BoundAppendExpression, (int Src, int Dst)>();
                var structLiteralSlots = new Dictionary<BoundStructLiteralExpression, int>();
                var defaultExpressionSlots = new Dictionary<BoundDefaultExpression, int>();
                var mapIndexSlots = new Dictionary<BoundIndexExpression, int>();
                var patternSwitchSlots = new Dictionary<BoundPatternSwitchStatement, int>();
                var typePatternScratchSlots = new Dictionary<BoundTypePattern, int>();
                var switchExpressionSlots = new Dictionary<BoundSwitchExpression, (int Result, int Discriminant)>();
                var channelOpSlots = new Dictionary<BoundNode, (int VT, int TA, int Result, int Spare)>();
                var scopeFrameSlots = new Dictionary<BoundScopeStatement, (int Tasks, int Cts, int Awaiter)>();
                var selectStatementSlots = new Dictionary<BoundSelectStatement, SelectSlots>();
                var receiverSpillSlots = new Dictionary<BoundExpression, int>();
                var indexAssignmentValueSlots = new Dictionary<BoundExpression, int>();
                var goEnclosingScopes = new Dictionary<BoundGoStatement, BoundScopeStatement>();
                var liftedBinarySlots = new Dictionary<BoundBinaryExpression, LiftedBinarySlots>();
                var nullableCoalesceSpillSlots = new Dictionary<BoundBinaryExpression, int>();

                // Issue #216: collect compile-time const bindings before slot allocation.
                var constValues = new Dictionary<VariableSymbol, object>();
                MethodBodyPlanner.CollectConstValues(body, constValues);

                this.methodBodyPlanner.CollectLocalsAndLabels(
                    body,
                    function,
                    locals,
                    localTypes,
                    labels,
                    appendSlots,
                    structLiteralSlots,
                    defaultExpressionSlots,
                    mapIndexSlots,
                    patternSwitchSlots,
                    typePatternScratchSlots,
                    switchExpressionSlots,
                    channelOpSlots,
                    scopeFrameSlots,
                    selectStatementSlots,
                    receiverSpillSlots,
                    indexAssignmentValueSlots,
                    goEnclosingScopes,
                    liftedBinarySlots,
                    nullableCoalesceSpillSlots,
                    il);

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

                StandaloneSignatureHandle localsSignature = default;
                if (localTypes.Count > 0)
                {
                    var localsSigBlob = new BlobBuilder();
                    var encoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count);
                    foreach (var t in localTypes)
                    {
                        EncodeLocalVariableType(encoder.AddVariable(), t);
                    }

                    localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
                }

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
                var emitter = new MethodBodyEmitter(
                    this,
                    il,
                    locals,
                    parameters,
                    labels,
                    appendSlots,
                    structLiteralSlots,
                    defaultExpressionSlots,
                    mapIndexSlots,
                    patternSwitchSlots,
                    typePatternScratchSlots,
                    switchExpressionSlots,
                    channelOpSlots,
                    scopeFrameSlots,
                    selectStatementSlots,
                    receiverSpillSlots,
                    indexAssignmentValueSlots,
                    goEnclosingScopes,
                    liftedBinarySlots: liftedBinarySlots,
                    nullableCoalesceSpillSlots: nullableCoalesceSpillSlots,
                    constValues: constValues,
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

                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSignature);
                capturedSequencePoints = emitter.SequencePoints;
                capturedLocals = MethodBodyPlanner.CollectLocalInfo(locals);
                capturedConstants = MethodBodyPlanner.CollectLocalConstantInfo(constValues);
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
                    if (asyncPlan != null)
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
                        // metadata row below.
                        var paramEncoder = ps.AddParameter();
                        if (p.RefKind == RefKind.In)
                        {
                            var isReadOnlyAttrType = this.wellKnown.GetIsReadOnlyAttributeTypeRef();
                            if (!isReadOnlyAttrType.IsNil)
                            {
                                paramEncoder.CustomModifiers().AddModifier(isReadOnlyAttrType, isOptional: false);
                            }
                        }

                        EncodeTypeSymbol(paramEncoder.Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        // Synthesized entry point uses the C#-style mangled name; explicit Main / user funcs keep their source name.
        var methodName = isEntryPoint && function.Declaration is null ? "<Main>$" : function.Name;

        // The synthesized entry point must remain Public so the runtime can find it.
        var visibility = isEntryPoint && function.Declaration is null
            ? MethodAttributes.Public
            : AccessibilityMap.ToMethodVisibility(function.Accessibility, AccessibilityMap.IsTopLevelProgramMember(function));

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
            else if (!receiverIsValueType || MethodInfoHelpers.RequiresVirtualOnValueType(function, receiverStruct))
            {
                methodAttrs |= MethodAttributes.Virtual;
                if (!function.IsOverride)
                {
                    methodAttrs |= MethodAttributes.NewSlot;
                }

                if (!function.IsOpen)
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
        TypeDefEmitter.EmitGenericParamRows(this.emitCtx, handle, function.TypeParameters);

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
                r => EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
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
        MemberReferenceHandle convertRef = default;
        MemberReferenceHandle freeRef = default;
        if (stringParamIndices.Count > 0)
        {
            var marshalType = typeof(Marshal);
            var convertName = function.PInvokeMetadata.StringMarshalling == StringMarshalling.Utf16
                ? "StringToCoTaskMemUni"
                : "StringToCoTaskMemUTF8";
            var convertMethod = marshalType.GetMethod(convertName, new[] { typeof(string) })
                ?? throw new InvalidOperationException($"Cannot resolve Marshal.{convertName}(string).");
            var freeMethod = marshalType.GetMethod("FreeCoTaskMem", new[] { typeof(nint) })
                ?? throw new InvalidOperationException("Cannot resolve Marshal.FreeCoTaskMem(IntPtr).");
            convertRef = this.GetMethodReference(convertMethod);
            freeRef = this.GetMethodReference(freeMethod);
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

        var offset = this.emitCtx.MethodBodyStream.AddMethodBody(il, localVariablesSignature: localsSig);
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

    private bool IsAddressableFieldAccessForReceiverSpill(
        BoundFieldAccessExpression fa,
        FunctionSymbol function,
        IReadOnlyDictionary<VariableSymbol, int> locals)
    {
        if (fa.Receiver == null)
        {
            return true;
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

    internal EntityHandle GetElementTypeToken(TypeSymbol element)
    {
        // P2-7 / Issue #421: nullable over a value type tokenises as
        // System.Nullable<T>. NullableTypeSymbol over a reference type
        // continues to share the underlying CLR type (handled below by
        // the `element.ClrType != null` branch via the NullableTypeSymbol
        // ctor that copies `underlying.ClrType`).
        if (element is NullableTypeSymbol nullableElement
            && nullableElement.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerClr)
        {
            // Issue #571: route Nullable<T> through the ReferenceResolver so the
            // open definition and the (possibly MLC-backed) inner come from the
            // same load context. The host `typeof(System.Nullable<>)` mixes
            // contexts and trips GS9998 inside the TypeBuilder/MetadataBuilder
            // ctor/member-reference paths.
            if (!NullableLifting.TryConstructNullable(this.emitCtx.References, nullableInnerClr, out var nullableClr))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{nullableInnerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            return this.GetTypeHandleForMember(nullableClr);
        }

        // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter.
        // For `[T struct]` the storage shape is `Nullable<!!T>`, encoded
        // as a TypeSpec naming the generic instantiation; this is the
        // token consumed by `initobj` when zero-initialising the slot.
        // For `[T class]` the storage shape is the bare `!!T` (a reference
        // slot that holds `null`), so we forward to the existing
        // TypeParameterSymbol branch by recursing on the underlying.
        if (element is NullableTypeSymbol nullableTpElement
            && nullableTpElement.UnderlyingType is TypeParameterSymbol nullableTpInner)
        {
            if (nullableTpInner.HasValueTypeConstraint)
            {
                var sigBlob = new BlobBuilder();
                this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableTpElement);
                return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            }

            return this.GetElementTypeToken(nullableTpInner);
        }

        // Issue #1298: `E?` over a user-declared enum tokenises as a TypeSpec
        // naming the generic instantiation `System.Nullable<E>`. This is the
        // token consumed by `box Nullable<E>` in the lifted enum-equality emit
        // (and by `initobj` when zero-initialising such a slot).
        if (element is NullableTypeSymbol nullableEnumElement
            && nullableEnumElement.UnderlyingType is EnumSymbol)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), nullableEnumElement);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element == TypeSymbol.Int32)
        {
            return this.GetTypeReference(this.emitCtx.CoreInt32Type);
        }

        if (element == TypeSymbol.Bool)
        {
            return this.GetTypeReference(this.emitCtx.CoreBooleanType);
        }

        if (element == TypeSymbol.String)
        {
            return this.GetTypeReference(this.emitCtx.CoreStringType);
        }

        if (element is ArrayTypeSymbol nestedArr)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeTypeSymbol(encoder, nestedArr);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is SliceTypeSymbol nestedSlice)
        {
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeTypeSymbol(encoder, nestedSlice);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is ImportedTypeSymbol symbolicImported
            && !symbolicImported.TypeArguments.IsDefaultOrEmpty
            && !symbolicImported.HasTypeParameterArgument
            && symbolicImported.TypeArguments.Any(ArgIsSymbolicUserDefined))
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), symbolicImported);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        // Issue #813: a tuple whose element types include an open generic
        // (TupleTypeSymbol.ClrType == null) needs a symbolic TypeSpec
        // built via the shared helper; the encoder threads each element
        // through EncodeTypeSymbol so the active iterator-state-machine
        // remap (issue #810) translates outer-method TPs to the SM
        // class's own type parameters. Without this branch, boxing a
        // `(int32, T)` to `object` from inside a state-machine method
        // body throws GS9998 from the EnumSymbol/throw tail below.
        if (element is TupleTypeSymbol symbolicTuple
            && symbolicTuple.ClrType == null
            && symbolicTuple.Arity >= 2
            && symbolicTuple.Arity <= 7)
        {
            return this.GetTupleTypeSpec(symbolicTuple);
        }

        // ADR-0087 §3 R3: an ImportedTypeSymbol whose generic args mention a
        // type parameter (e.g. `Dictionary<string, T>` where T is MVAR(0))
        // must tokenise as a TypeSpec carrying VAR/MVAR, not the erased
        // closed `ClrType` (which encodes T as `object`). Otherwise tokens
        // like `unbox.any Dictionary<string,T>` widen to the wrong shape.
        if (element is ImportedTypeSymbol tpImported && tpImported.HasTypeParameterArgument)
        {
            var sigBlob = new BlobBuilder();
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), tpImported);
            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is FunctionTypeSymbol fnElement && fnElement.ClrType == null)
        {
            // ADR-0087 §3 R6: an open-bearing function type
            // (e.g. `(T) -> U`) tokenises as a TypeSpec for the
            // reified `Func<...>` / `Action<...>` shape, with VAR/MVAR
            // slots that the runtime substitutes against the
            // surrounding generic instantiation.
            return this.GetFunctionDelegateTypeSpec(fnElement);
        }

        if (element.ClrType != null)
        {
            if (element.ClrType.IsConstructedGenericType)
            {
                return this.GetTypeHandleForMember(element.ClrType);
            }

            return this.GetTypeReference(element.ClrType);
        }

        if (element is StructSymbol structSym)
        {
            // ADR-0087 §3 R3: a constructed user-generic struct must
            // tokenise as a TypeSpec, not the bare TypeDef row.
            if (IsUserGenericTypeReference(structSym))
            {
                return this.GetUserStructTypeSpec(structSym);
            }

            if (this.cache.StructTypeDefs.TryGetValue(structSym, out var td))
            {
                return td;
            }
        }

        if (element is TypeParameterSymbol tpSym)
        {
            // ADR-0087 §3 R3: a type-parameter element token (e.g. for
            // `stobj T` against a `&T` parameter, or `initobj T` for a
            // default value) encodes as a TypeSpec naming VAR(idx) /
            // MVAR(idx).
            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();

            // Issue #810: inside an iterator state-machine method body,
            // outer-method TPs are remapped to the SM class's own TPs.
            if (this.activeIteratorStateMachineRemap != null
                && tpSym.IsMethodTypeParameter
                && this.activeIteratorStateMachineRemap.TryGetValue(tpSym, out var smClassOrd))
            {
                encoder.GenericTypeParameter(smClassOrd);
            }
            else if (tpSym.IsMethodTypeParameter)
            {
                encoder.GenericMethodTypeParameter(tpSym.Ordinal);
            }
            else
            {
                encoder.GenericTypeParameter(tpSym.Ordinal);
            }

            return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        }

        if (element is EnumSymbol enumSym && this.cache.EnumTypeDefs.TryGetValue(enumSym, out var etd))
        {
            return etd;
        }

        // Issue #1052: a user-declared interface used as a generic-parameter
        // constraint tokenises to its emitted TypeDef (non-generic) or a
        // TypeSpec naming the constructed instantiation (generic, e.g. the
        // self-referential `[T IFace[T]]`). This feeds the
        // GenericParamConstraint metadata row so the assembly verifies.
        if (element is InterfaceSymbol ifaceSym)
        {
            if (IsUserGenericInterfaceReference(ifaceSym))
            {
                var sigBlob = new BlobBuilder();
                this.EncodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), ifaceSym);
                return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            }

            var ifaceDef = ifaceSym.Definition ?? ifaceSym;
            if (this.cache.InterfaceTypeDefs.TryGetValue(ifaceDef, out var itd))
            {
                return itd;
            }
        }

        throw new NotSupportedException($"Cannot resolve element type token for '{element.Name}'.");
    }

    private Type ResolveCoreType(string fullName, Type fallback)
    {
        if (this.emitCtx.References.TryResolveType(fullName, out var t))
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

    internal EntityHandle GetTypeOfToken(TypeSymbol type)
    {
        // Issue #143: `typeof(T)` token resolution. `NullableTypeSymbol` over a
        // value type must surface as `System.Nullable<T>` to match C# semantics
        // (binder/evaluator collapse the wrapper to its underlying type for
        // every other purpose — ADR-0001).
        if (type is NullableTypeSymbol nullable
            && nullable.UnderlyingType.ClrType is { IsValueType: true } valueClr)
        {
            // Issue #571: see GetElementTypeToken for rationale.
            if (!NullableLifting.TryConstructNullable(this.emitCtx.References, valueClr, out var nullableType))
            {
                throw new InvalidOperationException(
                    $"Cannot construct Nullable<{valueClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
            }

            return this.GetTypeHandleForMember(nullableType);
        }

        return this.GetElementTypeToken(type);
    }

    private AssemblyReferenceHandle GetAssemblyReference(Assembly assembly)
    {
        if (this.cache.AssemblyRefs.TryGetValue(assembly, out var existing))
        {
            return existing;
        }

        var name = assembly.GetName();
        var publicKeyToken = name.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        var handle = this.emitCtx.Metadata.AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(name.Name ?? string.Empty),
            version: name.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        this.cache.AssemblyRefs[assembly] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #242: Returns an AssemblyReferenceHandle for <c>System.Runtime</c>,
    /// the public facade assembly that external consumers (C#/F# projects)
    /// reference. Used as the resolution scope for base-type TypeRefs
    /// (System.Object, System.ValueType, System.Enum) so that compiled
    /// libraries are consumable without requiring a direct reference to
    /// <c>System.Private.CoreLib</c>.
    /// </summary>
    private AssemblyReferenceHandle GetSystemRuntimeAssemblyReference()
    {
        if (!this.cache.SystemRuntimeAssemblyRef.IsNil)
        {
            return this.cache.SystemRuntimeAssemblyRef;
        }

        AssemblyName sysRuntimeName;
        try
        {
            sysRuntimeName = Assembly.Load("System.Runtime").GetName();
        }
        catch
        {
            // Fallback: construct the identity using the well-known .NET
            // public key token (b03f5f7f11d50a3a) and the host CoreLib version.
            sysRuntimeName = new AssemblyName("System.Runtime")
            {
                Version = typeof(object).Assembly.GetName().Version ?? new Version(0, 0, 0, 0),
            };
            sysRuntimeName.SetPublicKeyToken(new byte[] { 0xb0, 0x3f, 0x5f, 0x7f, 0x11, 0xd5, 0x0a, 0x3a });
        }

        var publicKeyToken = sysRuntimeName.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        this.cache.SystemRuntimeAssemblyRef = this.emitCtx.Metadata.AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(sysRuntimeName.Name ?? "System.Runtime"),
            version: sysRuntimeName.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        return this.cache.SystemRuntimeAssemblyRef;
    }

    /// <summary>
    /// Returns <c>true</c> if <paramref name="type"/> is a core base type from
    /// <c>System.Private.CoreLib</c> that is publicly exposed through
    /// <c>System.Runtime</c>. These types are used as base types in TypeDef
    /// rows and must reference the public facade so external consumers can
    /// resolve them.
    /// </summary>
    private static bool IsCoreLibBaseType(Type type)
    {
        if (!string.Equals(type.Assembly.GetName().Name, "System.Private.CoreLib", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var fullName = type.FullName;
        return fullName == "System.Object"
            || fullName == "System.ValueType"
            || fullName == "System.Enum"
            || fullName == "System.Attribute"
            || fullName == "System.MulticastDelegate"
            || fullName == "System.Delegate"
            // Issue #806: `Nullable<T>` and the `ValueTuple<…>` family
            // are public type-forwarded types. The host-process typeof
            // calls for these are scoped to System.Private.CoreLib; if
            // we emit the TypeRef directly to the implementation
            // assembly, C# consumers (which only reference the contract
            // assemblies under Microsoft.NETCore.App.Ref/.../net10.0)
            // fail with CS0012 "The type '…' is defined in an assembly
            // that is not referenced". Route through System.Runtime,
            // which carries the type forwarders, so external consumers
            // resolve `T?` parameters and `(T, U, …)` tuple types in
            // our public surface.
            || fullName == "System.Nullable`1"
            || fullName == "System.ValueTuple`1"
            || fullName == "System.ValueTuple`2"
            || fullName == "System.ValueTuple`3"
            || fullName == "System.ValueTuple`4"
            || fullName == "System.ValueTuple`5"
            || fullName == "System.ValueTuple`6"
            || fullName == "System.ValueTuple`7"
            || fullName == "System.ValueTuple`8"
            // Issue #806: iterator state-machine classes implement
            // IEnumerable / IEnumerator / IDisposable. The host-process
            // typeof() of these returns the implementation-assembly
            // (System.Private.CoreLib) instance, but the public
            // contract lives in System.Runtime (via type forwarders).
            // Routing through System.Runtime keeps the runtime's
            // interface-lookup happy and avoids EntryPointNotFoundException
            // on iterator `GetEnumerator` dispatch from C# consumers.
            || fullName == "System.IDisposable"
            || fullName == "System.Collections.IEnumerable"
            || fullName == "System.Collections.IEnumerator"
            || fullName == "System.Collections.Generic.IEnumerable`1"
            || fullName == "System.Collections.Generic.IEnumerator`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    internal TypeReferenceHandle GetTypeReference(Type type)
    {
        if (this.cache.TypeRefs.TryGetValue(type, out var existing))
        {
            return existing;
        }

        // Nested types: resolution scope is the TypeRef of the declaring type,
        // namespace is empty, name is the short name only. Works for the
        // open generic definition of a nested generic type as well (Reflection
        // treats Dictionary`2+Enumerator as nested under Dictionary`2).
        EntityHandle resolutionScope;
        StringHandle @namespace;
        if (type.IsNested && type.DeclaringType is Type declaring)
        {
            resolutionScope = this.GetTypeReference(declaring);
            @namespace = default;
        }
        else if (IsCoreLibBaseType(type))
        {
            // Issue #242: base types (Object, ValueType, Enum, Attribute)
            // must reference System.Runtime — the public facade — so that
            // consuming C#/F# projects can resolve them. Other types in
            // System.Private.CoreLib (e.g. Dictionary<,>) keep pointing at
            // CoreLib because the runtime resolves them directly and they
            // may not have type-forwarders in System.Runtime.
            resolutionScope = this.GetSystemRuntimeAssemblyReference();
            @namespace = this.emitCtx.Metadata.GetOrAddString(type.Namespace ?? string.Empty);
        }
        else
        {
            resolutionScope = this.GetAssemblyReference(type.Assembly);
            @namespace = this.emitCtx.Metadata.GetOrAddString(type.Namespace ?? string.Empty);
        }

        var handle = this.emitCtx.Metadata.AddTypeReference(
            resolutionScope: resolutionScope,
            @namespace: @namespace,
            name: this.emitCtx.Metadata.GetOrAddString(type.Name));
        this.cache.TypeRefs[type] = handle;
        return handle;
    }

    /// <summary>
    /// Returns a metadata handle suitable for use as the parent of a MemberRef.
    /// Returns a TypeRef for non-generic types and a TypeSpec encoding a
    /// <c>GenericInstantiation</c> for constructed generic types
    /// (e.g. <c>List&lt;int&gt;</c>, <c>Dictionary&lt;string, int&gt;</c>).
    /// </summary>
    internal EntityHandle GetTypeHandleForMember(Type type)
    {
        if (type.IsConstructedGenericType)
        {
            if (this.cache.TypeSpecs.TryGetValue(type, out var existingSpec))
            {
                return existingSpec;
            }

            var sigBlob = new BlobBuilder();
            var encoder = new BlobEncoder(sigBlob).TypeSpecificationSignature();
            this.EncodeClrType(encoder, type);
            var spec = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            this.cache.TypeSpecs[type] = spec;
            return spec;
        }

        return this.GetTypeReference(type);
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
    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// function call. Derives the type arguments from the call's
    /// arguments and substituted return type. Required because the
    /// post-R2 MethodDef carries MVAR slots; the call site must
    /// reference a MethodSpec naming the substituted instantiation.
    /// </summary>
    internal EntityHandle BuildMethodSpecForGenericCall(EntityHandle openMethod, BoundCallExpression call)
    {
        var tps = call.Function.TypeParameters;
        var args = new TypeSymbol[tps.Length];
        for (int i = 0; i < tps.Length; i++)
        {
            args[i] = InferMethodTypeArgument(call.Function, call.Arguments, call.ReturnType, tps[i]);
        }

        return this.BuildMethodSpec(openMethod, args);
    }

    /// <summary>
    /// ADR-0087 §3 R3+R4: builds a MethodSpec for a generic G# user
    /// instance method call (`h.Box[int32](42)`). Same inference rules
    /// as <see cref="BuildMethodSpecForGenericCall"/>.
    /// </summary>
    internal EntityHandle BuildMethodSpecForGenericInstanceCall(EntityHandle openMethod, BoundUserInstanceCallExpression call)
    {
        var tps = call.Method.TypeParameters;
        var args = new TypeSymbol[tps.Length];
        var calleeParameterOffset = call.Method.ExplicitReceiverParameter == null ? 0 : 1;

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
            args[i] = InferMethodTypeArgument(userParams, call.Arguments, call.Type, call.Method.Type, tps[i]);
        }

        return this.BuildMethodSpec(openMethod, args);
    }

    private EntityHandle BuildMethodSpec(EntityHandle openMethod, TypeSymbol[] args)
    {
        var sigBlob = new BlobBuilder();
        var argsEnc = new BlobEncoder(sigBlob).MethodSpecificationSignature(args.Length);
        for (int i = 0; i < args.Length; i++)
        {
            this.EncodeTypeSymbol(argsEnc.AddArgument(), args[i]);
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
        if (ReferenceEquals(formal, tp))
        {
            inferred = actual;
            return true;
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

    private readonly Dictionary<StructSymbol, EntityHandle> userStructTypeSpecCache = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<(StructSymbol Containing, FieldSymbol DefField), EntityHandle> userStructFieldRefCache = new();
    private readonly Dictionary<(StructSymbol Containing, EntityHandle OpenMember), EntityHandle> userStructMethodRefCache = new();
    private readonly Dictionary<InterfaceSymbol, EntityHandle> userInterfaceTypeSpecCache = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<(InterfaceSymbol Containing, EntityHandle OpenMember), EntityHandle> userInterfaceMethodRefCache = new();
    private readonly Dictionary<(InterfaceSymbol Containing, FieldSymbol DefField), EntityHandle> userInterfaceFieldRefCache = new();

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
        if (this.userStructTypeSpecCache.TryGetValue(structSym, out var cached))
        {
            return cached;
        }

        var def = structSym.Definition ?? structSym;
        if (!this.cache.StructTypeDefs.TryGetValue(def, out var defHandle))
        {
            throw new InvalidOperationException(
                $"User generic type '{def.Name}' has no emitted TypeDef when constructing TypeSpec.");
        }

        ImmutableArray<TypeSymbol> typeArgs;
        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            typeArgs = structSym.TypeArguments;
        }
        else
        {
            // Open definition → encode self-instantiation using the
            // definition's own type parameters as arguments. Each will
            // encode as `VAR(idx)` via EncodeTypeSymbol after R2.
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
        var gi = encoder.GenericInstantiation(defHandle, typeArgs.Length, isValueType: !def.IsClass);
        foreach (var arg in typeArgs)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userStructTypeSpecCache[structSym] = spec;
        return spec;
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

        var key = (containingType, defField);
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
        using (this.PushSmRemap(containingType.Definition ?? containingType))
        {
            this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), defField.Type);
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
        if (IsUserGenericTypeReference(containingType))
        {
            return this.GetUserStructFieldRef(containingType, field);
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
        if (IsUserGenericInterfaceReference(containingInterface))
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

        var key = (containingInterface, defField);
        if (this.userInterfaceFieldRefCache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var parent = this.GetUserInterfaceTypeSpec(containingInterface);
        var sigBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), defField.Type);

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
        var key = (containingType, openMethodDef);
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
                r => EncodeReturnSymbol(r, openMethod.Type, openMethod.ReturnRefKind),
                ps =>
                {
                    foreach (var p in openMethod.Parameters)
                    {
                        if (ReferenceEquals(p, openMethod.ThisParameter))
                        {
                            continue;
                        }

                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
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

    internal EntityHandle ResolveUserInstanceMethodToken(StructSymbol containingType, FunctionSymbol method)
    {
        if (!this.cache.MethodHandles.TryGetValue(method, out var openDef))
        {
            throw new InvalidOperationException(
                $"Instance method '{method.Name}' has no emitted handle.");
        }

        if (!IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
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
            throw new InvalidOperationException(
                $"Static method '{method.Name}' has no emitted handle.");
        }

        if (!IsUserGenericTypeReference(containingType))
        {
            return openDef;
        }

        return this.GetUserStructMethodRef(containingType, openDef, method.Name, this.EncodeOpenMethodSignature(method));
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
            throw new InvalidOperationException(
                $"Property '{property.Name}' has no emitted accessor handles.");
        }

        var accessor = wantSetter ? handles.Setter : handles.Getter;
        if (!accessor.HasValue)
        {
            throw new InvalidOperationException(
                $"Property '{property.Name}' has no emitted {(wantSetter ? "setter" : "getter")} MethodDef.");
        }

        if (!IsUserGenericTypeReference(containingType))
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
    /// <c>VAR(idx)</c>.
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
                    r => r.Void(),
                    ps =>
                    {
                        foreach (var p in indexParams)
                        {
                            EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }

                        EncodeTypeSymbol(ps.AddParameter().Type(), property.Type);
                    });
        }
        else
        {
            new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: isInstanceAccessor)
                .Parameters(
                    indexParams.Length,
                    r => EncodeTypeSymbol(r.Type(), property.Type),
                    ps =>
                    {
                        foreach (var p in indexParams)
                        {
                            EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                        }
                    });
        }

        return sigBlob;
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

    /// <summary>
    /// ADR-0091: returns a <c>TypeSpec</c> EntityHandle for a
    /// user-declared generic interface — analogue of
    /// <see cref="GetUserStructTypeSpec"/> for <see cref="InterfaceSymbol"/>.
    /// </summary>
    internal EntityHandle GetUserInterfaceTypeSpec(InterfaceSymbol ifaceSym)
    {
        if (this.userInterfaceTypeSpecCache.TryGetValue(ifaceSym, out var cached))
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
            this.EncodeTypeSymbol(gi.AddArgument(), arg);
        }

        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.userInterfaceTypeSpecCache[ifaceSym] = spec;
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

        if (!IsUserGenericInterfaceReference(containingInterface))
        {
            return openDef;
        }

        var key = (containingInterface, openDef);
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
        if (!this.cache.ClassPrimaryCtorHandles.TryGetValue(structType, out var primaryDef))
        {
            throw new InvalidOperationException($"Type '{structType.Name}' has no emitted primary ctor.");
        }

        if (!IsUserGenericTypeReference(structType))
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
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
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

                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
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
                            EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
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

        return this.wellKnown.ObjectCtorRef;
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

        if (!IsUserGenericTypeReference(structType))
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

        if (!IsUserGenericTypeReference(structType))
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
                        EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
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
        if (IsUserGenericTypeReference(structType))
        {
            return this.GetUserStructTypeSpec(structType);
        }

        return this.cache.StructTypeDefs[structType];
    }

    /// <summary>
    /// For a method on a constructed generic type, return the corresponding
    /// method on the open generic definition; for non-generic declaring types,
    /// returns the input. The open method's parameter / return types reference
    /// the declaring type's generic parameters as <c>GenericTypeParameter</c>,
    /// which <see cref="EncodeClrType"/> emits as <c>!N</c>.
    /// </summary>
    private static MethodInfo GetOpenMethod(MethodInfo method)
    {
        var declaring = method.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return method;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                return candidate;
            }
        }

        return method;
    }

    private static ConstructorInfo GetOpenCtor(ConstructorInfo ctor)
    {
        var declaring = ctor.DeclaringType;
        if (declaring is null || !declaring.IsConstructedGenericType)
        {
            return ctor;
        }

        var open = declaring.GetGenericTypeDefinition();
        foreach (var candidate in open.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == ctor.MetadataToken && candidate.Module == ctor.Module)
            {
                return candidate;
            }
        }

        return ctor;
    }

    internal MemberReferenceHandle GetMethodReference(MethodInfo method)
    {
        if (this.cache.MethodRefs.TryGetValue(method, out var existing))
        {
            return existing;
        }

        var declaring = method.DeclaringType
            ?? throw new InvalidOperationException("Imported method has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // For instance methods on constructed generic types, encode the signature
        // from the OPEN definition so parameters/returns reference declaring-type
        // generic params by position (!0, !1, ...). For non-generic declarings,
        // open == closed and parameter types are concrete.
        var openMethod = GetOpenMethod(method);

        // When the method itself is generic (e.g. Channel.CreateUnbounded<T>),
        // encode the MemberRef against its generic definition so `!!N` placeholders
        // referenced in the signature resolve correctly. The caller wraps the
        // resulting handle in a MethodSpecification.
        var openForMethodGenerics = openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod;

        var sigBlob = new BlobBuilder();
        var sigEncoder = new BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: openForMethodGenerics.IsGenericMethodDefinition ? openForMethodGenerics.GetGenericArguments().Length : 0);
        sigEncoder.Parameters(
                openForMethodGenerics.GetParameters().Length,
                returnType: r => this.EncodeReturnClr(r, openForMethodGenerics.ReturnParameter, openForMethodGenerics.ReturnType),
                parameters: ps =>
                {
                    foreach (var p in openForMethodGenerics.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out / ref parameters: encode as managed pointer to the element type.
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.MethodRefs[method] = handle;
        return handle;
    }

    // Phase E: returns a callable EntityHandle for any MethodInfo, wrapping
    // constructed generic methods in a MethodSpecification per ECMA-335 II.23.2.15.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method)
    {
        return this.GetMethodEntityHandle(method, default(ImmutableArray<TypeSymbol>));
    }

    internal EntityHandle GetMethodEntityHandle(MethodInfo method, TypeSymbol containingTypeSymbol)
    {
        return this.GetMethodEntityHandle(method, default(ImmutableArray<TypeSymbol>), containingTypeSymbol);
    }

    // Issue #320: callable EntityHandle for a constructed generic method whose
    // explicit type arguments may include user-defined types. User-defined type
    // arguments have no reference-context CLR type, so the method was closed with
    // a System.Object placeholder; the real type-argument symbols are encoded into
    // the method specification here (as their own TypeDef tokens) instead of the
    // placeholder. When typeArgSymbols is default the placeholder CLR arguments are
    // encoded, preserving the BCL-only behavior.
    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        return this.GetMethodEntityHandle(method, typeArgSymbols, null);
    }

    internal EntityHandle GetMethodEntityHandle(MethodInfo method, ImmutableArray<TypeSymbol> typeArgSymbols, TypeSymbol containingTypeSymbol)
    {
        if (TryCreateMemberReferenceForConstructedSymbolicContainer(method, containingTypeSymbol, out var symbolicRef))
        {
            if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
            {
                return symbolicRef;
            }

            var symbolicClosedArgs = method.GetGenericArguments();
            var symbolicSigBlob = new BlobBuilder();
            var symbolicArgsEncoder = new BlobEncoder(symbolicSigBlob).MethodSpecificationSignature(symbolicClosedArgs.Length);
            for (var i = 0; i < symbolicClosedArgs.Length; i++)
            {
                if (!typeArgSymbols.IsDefaultOrEmpty
                    && i < typeArgSymbols.Length
                    && ArgIsSymbolicUserDefined(typeArgSymbols[i]))
                {
                    this.EncodeTypeSymbol(symbolicArgsEncoder.AddArgument(), typeArgSymbols[i]);
                }
                else
                {
                    this.EncodeClrType(symbolicArgsEncoder.AddArgument(), symbolicClosedArgs[i]);
                }
            }

            return this.emitCtx.Metadata.AddMethodSpecification(symbolicRef, this.emitCtx.Metadata.GetOrAddBlob(symbolicSigBlob));
        }

        if (!method.IsGenericMethod || method.IsGenericMethodDefinition)
        {
            return this.GetMethodReference(method);
        }

        // The placeholder-closed MethodInfo is identical across distinct
        // user-type arguments (all close to <object>), so the cache must be keyed
        // by the symbol arguments too. Issue #420 (P3-7): previously this case
        // bypassed the cache entirely, producing duplicate MethodSpec rows when
        // the same generic method was referenced multiple times with the same
        // user-type generic args.
        var hasSymbolArgs = !typeArgSymbols.IsDefaultOrEmpty
            && typeArgSymbols.Any(ArgIsSymbolicUserDefined);
        if (!hasSymbolArgs)
        {
            if (this.cache.MethodSpecs.TryGetValue(method, out var existing))
            {
                return existing;
            }
        }
        else
        {
            var symbolKey = new MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols);
            if (this.cache.MethodSpecsWithSymbolArgs.TryGetValue(symbolKey, out var existingSym))
            {
                return existingSym;
            }
        }

        var openDef = method.GetGenericMethodDefinition();
        var openRef = this.GetMethodReference(openDef);

        var closedArgs = method.GetGenericArguments();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(closedArgs.Length);
        for (var i = 0; i < closedArgs.Length; i++)
        {
            // Issue #320: encode a user-defined type argument via its symbol so it
            // resolves to the emitted TypeDef; BCL arguments use the closed CLR type.
            // Issue #671: also recurse through nested constructed generics so a
            // `MyGeneric<List<MyGs>>` argument is encoded symbolically rather than
            // collapsing to System.Object at the placeholder.
            if (!typeArgSymbols.IsDefaultOrEmpty
                && i < typeArgSymbols.Length
                && ArgIsSymbolicUserDefined(typeArgSymbols[i]))
            {
                this.EncodeTypeSymbol(argsEncoder.AddArgument(), typeArgSymbols[i]);
            }
            else
            {
                this.EncodeClrType(argsEncoder.AddArgument(), closedArgs[i]);
            }
        }

        var spec = this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        if (!hasSymbolArgs)
        {
            this.cache.MethodSpecs[method] = spec;
        }
        else
        {
            this.cache.MethodSpecsWithSymbolArgs[new MetadataTokenCache.MethodSpecSymbolKey(method, typeArgSymbols)] = spec;
        }

        return spec;
    }

    private bool TryCreateMemberReferenceForConstructedSymbolicContainer(
        MethodInfo method,
        TypeSymbol containingTypeSymbol,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (method == null
            || !TryNormalizeToSymbolicContainer(containingTypeSymbol, out var openDefinition, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !(typeArguments.Any(TypeSymbol.ContainsTypeParameter) || typeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        // Issue #774: when the method is declared on a non-generic base
        // (e.g. `IEnumerator.MoveNext()` inherited via `IEnumerator<T>`, or
        // `IDisposable.Dispose()` on the same enumerator), encoding a
        // symbolic generic parent TypeSpec produces a verifier-rejected
        // MemberRef (`MoveNext` is not declared on `IEnumerator<>`). Let the
        // plain MemberRef path encode the parent as the actual non-generic
        // declaring type by short-circuiting here.
        var methodDecl = method.DeclaringType;
        if (methodDecl != null && !methodDecl.IsGenericType && methodDecl != openDefinition)
        {
            return false;
        }

        // Issue #774: when the method is declared on a generic interface or
        // base type that the receiver's openDefinition implements (e.g.
        // `IEnumerable<object>.GetEnumerator()` called on a
        // `Dictionary[K, V]`), the parent TypeSpec must be the substituted
        // interface — not the receiver's own openDefinition. Otherwise
        // ResolveMethodOnOpenDefinition would pick the receiver's hiding
        // method (e.g. Dictionary's struct-returning GetEnumerator) and the
        // verifier would see a struct value where an interface reference is
        // expected.
        if (methodDecl != null
            && methodDecl.IsGenericType
            && openDefinition != null)
        {
            var methodDeclOpen = methodDecl.IsGenericTypeDefinition ? methodDecl : methodDecl.GetGenericTypeDefinition();
            if (methodDeclOpen != openDefinition)
            {
                if (TryFindImplementedInterfaceInstantiation(openDefinition, methodDeclOpen, out var ifaceInstantiation))
                {
                    var ifaceArgs = ifaceInstantiation.GetGenericArguments();
                    var symbolicIfaceArgs = ImmutableArray.CreateBuilder<TypeSymbol>(ifaceArgs.Length);
                    foreach (var ifa in ifaceArgs)
                    {
                        symbolicIfaceArgs.Add(MemberLookup.MapOpenClrTypeToSymbolic(ifa, openDefinition, typeArguments));
                    }

                    openDefinition = methodDeclOpen;
                    typeArguments = symbolicIfaceArgs.MoveToImmutable();
                }
            }
        }

        // Synthesize an ImportedTypeSymbol view of the receiver so the
        // parent TypeSpec encoder reaches the existing
        // `ImportedTypeSymbol with HasTypeParameterArgument` branch in
        // EncodeTypeSymbol uniformly — regardless of whether the actual
        // receiver was an ImportedTypeSymbol, a SequenceTypeSymbol with
        // null ClrType (issue #774), or an AsyncSequenceTypeSymbol with
        // null ClrType.
        var symbolicView = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(this.GetErasedObjectArgs(openDefinition)),
            openDefinition,
            typeArguments);

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicView);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var openMethod = ResolveMethodOnOpenDefinition(openDefinition, method);
        var openForMethodGenerics = openMethod.IsGenericMethod
            ? openMethod.GetGenericMethodDefinition()
            : openMethod;

        var sigBlob = new BlobBuilder();
        var sigEncoder = new BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: !method.IsStatic,
            genericParameterCount: openForMethodGenerics.IsGenericMethodDefinition ? openForMethodGenerics.GetGenericArguments().Length : 0);
        sigEncoder.Parameters(
            openForMethodGenerics.GetParameters().Length,
            returnType: r => this.EncodeReturnClr(r, openForMethodGenerics.ReturnParameter, openForMethodGenerics.ReturnType),
            parameters: ps =>
            {
                foreach (var p in openForMethodGenerics.GetParameters())
                {
                    var paramType = p.ParameterType;
                    if (paramType.IsByRef)
                    {
                        this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                    }
                    else
                    {
                        this.EncodeClrType(ps.AddParameter().Type(), paramType);
                    }
                }
            });

        handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return true;
    }

    /// <summary>
    /// Walks <paramref name="openDefinition"/>'s implemented interfaces and
    /// returns the constructed instance that uses
    /// <paramref name="targetOpenInterface"/> as its open definition. The
    /// returned <see cref="Type"/>'s generic arguments are still in terms of
    /// <paramref name="openDefinition"/>'s generic parameters so they can be
    /// substituted via <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol})"/>.
    /// </summary>
    private static bool TryFindImplementedInterfaceInstantiation(Type openDefinition, Type targetOpenInterface, out Type instantiation)
    {
        foreach (var iface in openDefinition.GetInterfaces())
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition() == targetOpenInterface)
            {
                instantiation = iface;
                return true;
            }

            if (!iface.IsGenericType && iface == targetOpenInterface)
            {
                instantiation = iface;
                return true;
            }
        }

        instantiation = null;
        return false;
    }

    /// <summary>
    /// Issue #774: normalises any receiver type that carries open generic
    /// arguments (an <see cref="ImportedTypeSymbol"/> with
    /// <see cref="ImportedTypeSymbol.OpenDefinition"/>, a
    /// <see cref="SequenceTypeSymbol"/> with no <see cref="TypeSymbol.ClrType"/>,
    /// or its async counterpart) into the open CLR definition plus the
    /// symbolic argument list. Lets the symbolic-container MemberRef path
    /// fire uniformly for all three shapes.
    /// </summary>
    private static bool TryNormalizeToSymbolicContainer(
        TypeSymbol containingTypeSymbol,
        out Type openDefinition,
        out ImmutableArray<TypeSymbol> typeArguments)
    {
        switch (containingTypeSymbol)
        {
            case ImportedTypeSymbol imp when imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty:
                openDefinition = imp.OpenDefinition;
                typeArguments = imp.TypeArguments;
                return true;
            case SequenceTypeSymbol seq when seq.ClrType == null:
                openDefinition = typeof(System.Collections.Generic.IEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(seq.ElementType);
                return true;
            case AsyncSequenceTypeSymbol aseq when aseq.ClrType == null:
                openDefinition = typeof(System.Collections.Generic.IAsyncEnumerable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(aseq.ElementType);
                return true;
            case NullableTypeSymbol nul when nul.UnderlyingType is TypeParameterSymbol nullableTp && nullableTp.HasValueTypeConstraint:
                // Issue #806: a `T?` receiver where T is an open value-type
                // type parameter has no constructed CLR `Nullable<T>` here —
                // route member-ref encoding through the symbolic container
                // path so the MemberRef parent is `Nullable<!!T>` against
                // System.Runtime, not against the current assembly.
                openDefinition = typeof(System.Nullable<>);
                typeArguments = ImmutableArray.Create<TypeSymbol>(nullableTp);
                return true;
            default:
                openDefinition = null;
                typeArguments = default;
                return false;
        }
    }

    // Issue #821: choose the right erased `object` for an open generic
    // definition's MakeGenericType call. The open def may live in a
    // MetadataLoadContext (reference-pack assemblies); passing a live
    // `typeof(object)` to its MakeGenericType raises ArgumentException with
    // "type was not loaded by the MetadataLoadContext that loaded the
    // generic type or method." Use `emitCtx.CoreObjectType`, which is the
    // System.Object resolved through the active reference context, when the
    // open def lives outside the host runtime.
    private Type[] GetErasedObjectArgs(Type openDefinition)
    {
        var parameters = openDefinition.GetGenericArguments();
        var result = new Type[parameters.Length];
        var coreObject = ChooseErasedObjectType(openDefinition);
        for (var i = 0; i < parameters.Length; i++)
        {
            // Issue #806: a generic parameter with the `struct`
            // constraint cannot be closed with `System.Object`
            // (MakeGenericType throws ArgumentException). Use a
            // BCL value-type placeholder (`int32`) so the
            // symbolic-container path can construct the closed
            // type purely for parent-TypeSpec encoding. The
            // closed type's identity is irrelevant beyond the
            // open definition's reflection metadata.
            var p = parameters[i];
            if ((p.GenericParameterAttributes & System.Reflection.GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
            {
                result[i] = ChooseErasedValueTypeType(openDefinition);
            }
            else
            {
                result[i] = coreObject;
            }
        }

        return result;
    }

    private Type ChooseErasedValueTypeType(Type openDefinition)
    {
        var hostInt = typeof(int);
        if (openDefinition?.Assembly == hostInt.Assembly)
        {
            return hostInt;
        }

        return this.emitCtx.CoreInt32Type ?? hostInt;
    }

    private Type ChooseErasedObjectType(Type openDefinition)
    {
        // Same context as the open def → cheap path.
        var hostObject = typeof(object);
        if (openDefinition?.Assembly == hostObject.Assembly)
        {
            return hostObject;
        }

        return this.emitCtx.CoreObjectType ?? hostObject;
    }

    private static MethodInfo ResolveMethodOnOpenDefinition(Type openDefinition, MethodInfo method)
    {
        if (openDefinition == null)
        {
            return method;
        }

        if (method.DeclaringType == openDefinition)
        {
            return method;
        }

        foreach (var candidate in openDefinition.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
            {
                return candidate;
            }
        }

        var fallback = openDefinition.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate =>
                candidate.Name == method.Name
                && candidate.IsStatic == method.IsStatic
                && candidate.IsGenericMethod == method.IsGenericMethod
                && candidate.GetParameters().Length == method.GetParameters().Length);
        return fallback ?? method;
    }

    private static PropertyInfo ResolvePropertyOnOpenDefinition(Type openDefinition, PropertyInfo property)
    {
        if (openDefinition == null)
        {
            return property;
        }

        if (property.DeclaringType == openDefinition)
        {
            return property;
        }

        foreach (var candidate in openDefinition.GetProperties(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == property.MetadataToken && candidate.Module == property.Module)
            {
                return candidate;
            }
        }

        return openDefinition.GetProperty(
            property.Name,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
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
            || !TryNormalizeToSymbolicContainer(receiverType, out var openDef, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !(typeArguments.Any(TypeSymbol.ContainsTypeParameter) || typeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var openProp = ResolvePropertyOnOpenDefinition(openDef, property);
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
            || !TryNormalizeToSymbolicContainer(receiverType, out var openDef, out var typeArguments)
            || typeArguments.IsDefaultOrEmpty
            || !(typeArguments.Any(TypeSymbol.ContainsTypeParameter) || typeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var openMethod = ResolveMethodOnOpenDefinition(openDef, method);
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
    /// compiled), <see cref="GetMethodEntityHandle(MethodInfo, ImmutableArray{TypeSymbol})"/>
    /// encodes a MethodSpec whose type argument is the symbolic <c>Check</c>
    /// (via <see cref="ArgIsSymbolicUserDefined"/>). The emitted call therefore
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
    /// reproject the open return type to a same-compilation user type, so the
    /// erasure-widening must be skipped.</returns>
    internal bool TryGetSymbolicSubstitutedImportedCallReturn(
        MethodInfo method,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        out TypeSymbol substitutedReturn)
    {
        substitutedReturn = null;
        if (method == null
            || !method.IsGenericMethod
            || typeArgSymbols.IsDefaultOrEmpty
            || !typeArgSymbols.Any(ArgIsSymbolicUserDefined))
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
        // instantiation. Either way, only a projection that actually surfaces
        // a same-compilation user type means the MethodSpec deviates from the
        // erased `object` placeholder and the widening must be suppressed.
        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, null, default, openMethod, typeArgSymbols);
        if (mapped == null || mapped == TypeSymbol.Error)
        {
            return false;
        }

        if (!TypeSymbol.ContainsSameCompilationUserType(mapped))
        {
            return false;
        }

        substitutedReturn = mapped;
        return true;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor.
    /// Handles both non-generic types (<c>StringBuilder()</c>) and constructed
    /// generic types (<c>List&lt;int&gt;()</c>, <c>Dictionary&lt;string, int&gt;()</c>).
    /// </summary>
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor)
        => this.GetCtorReference(ctor, containingTypeSymbol: null);

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR instance constructor on a
    /// possibly type-erased generic declaring type. When
    /// <paramref name="containingTypeSymbol"/> is an
    /// <see cref="ImportedTypeSymbol"/> whose <see cref="ImportedTypeSymbol.TypeArguments"/>
    /// contain one or more G# user-defined types (issue #671), the parent
    /// TypeSpec is encoded against those symbolic arguments (resolving to the
    /// real user-defined TypeDef tokens) instead of the type-erased
    /// <c>Open&lt;object,…&gt;</c> shape carried by <paramref name="ctor"/>.
    /// </summary>
    /// <param name="ctor">The (possibly type-erased) constructor selected by overload resolution.</param>
    /// <param name="containingTypeSymbol">The bound result type of the construction expression. May be <see langword="null"/>.</param>
    /// <returns>A MemberRef handle for the constructor on the correctly-typed parent.</returns>
    internal MemberReferenceHandle GetCtorReference(ConstructorInfo ctor, TypeSymbol containingTypeSymbol)
    {
        // Issue #671: when the containing type carries symbolic user-type
        // arguments, the cache key needs to discriminate per symbol set
        // (multiple distinct user-type closures share a single type-erased
        // ConstructorInfo).
        if (TryCreateCtorMemberReferenceForConstructedSymbolicContainer(ctor, containingTypeSymbol, out var symbolicHandle))
        {
            return symbolicHandle;
        }

        if (this.cache.CtorRefs.TryGetValue(ctor, out var existing))
        {
            return existing;
        }

        var declaring = ctor.DeclaringType
            ?? throw new InvalidOperationException("Imported constructor has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);
        var openCtor = GetOpenCtor(ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            // out/ref parameter (e.g. an interpolated-string
                            // handler ctor's `out bool shouldAppend`): emit the
                            // BYREF prefix, then encode the element type.
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.CtorRefs[ctor] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #671: builds a constructor MemberRef whose parent TypeSpec is
    /// encoded from the original symbolic type arguments (resolving to G#
    /// user-defined TypeDef tokens) rather than the type-erased
    /// <c>Open&lt;object,…&gt;</c> shape baked into the constructor's
    /// <see cref="MemberInfo.DeclaringType"/>. Mirrors the method
    /// counterpart in <see cref="TryCreateMemberReferenceForConstructedSymbolicContainer"/>.
    /// </summary>
    /// <param name="ctor">The (type-erased) constructor.</param>
    /// <param name="containingTypeSymbol">The bound type of the call's result; expected to be an <see cref="ImportedTypeSymbol"/> carrying user-defined type args.</param>
    /// <param name="handle">On success, the new MemberRef handle.</param>
    /// <returns>Whether a symbolic-container MemberRef was produced.</returns>
    private bool TryCreateCtorMemberReferenceForConstructedSymbolicContainer(
        ConstructorInfo ctor,
        TypeSymbol containingTypeSymbol,
        out MemberReferenceHandle handle)
    {
        handle = default;
        if (ctor == null
            || containingTypeSymbol is not ImportedTypeSymbol imported
            || imported.OpenDefinition == null
            || imported.TypeArguments.IsDefaultOrEmpty
            || !(imported.HasTypeParameterArgument || imported.TypeArguments.Any(ArgIsSymbolicUserDefined)))
        {
            return false;
        }

        var cacheKey = new MetadataTokenCache.CtorRefSymbolKey(ctor, imported.TypeArguments);
        if (this.cache.CtorRefsWithSymbolArgs.TryGetValue(cacheKey, out var cached))
        {
            handle = cached;
            return true;
        }

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), imported);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));
        var openCtor = ResolveCtorOnOpenDefinition(imported.OpenDefinition, ctor);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.CtorRefsWithSymbolArgs[cacheKey] = handle;
        return true;
    }

    private static ConstructorInfo ResolveCtorOnOpenDefinition(Type openDefinition, ConstructorInfo ctor)
    {
        if (openDefinition == null)
        {
            return ctor;
        }

        if (ctor.DeclaringType == openDefinition)
        {
            return ctor;
        }

        foreach (var candidate in openDefinition.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (candidate.MetadataToken == ctor.MetadataToken && candidate.Module == ctor.Module)
            {
                return candidate;
            }
        }

        var fallback = openDefinition.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .FirstOrDefault(candidate => candidate.GetParameters().Length == ctor.GetParameters().Length);
        return fallback ?? ctor;
    }

    /// <summary>
    /// Issue #814 / ADR-0084 §L5: builds a <c>MemberRef</c> parented at the
    /// <c>TypeSpec</c> for <c>System.Nullable`1&lt;!!T&gt;</c> with signature
    /// <c>instance void .ctor(!0)</c>. The CLR substitutes <c>!0</c> against
    /// the parent's first generic argument at call time, so a single
    /// MemberRef serves every instantiation. Used by the
    /// <c>T → Nullable&lt;T&gt;</c> value-type lift when <c>T</c> is an open
    /// type parameter constrained to <c>struct</c> — the closed
    /// <see cref="ConstructorInfo"/> we normally route through
    /// <see cref="GetCtorReference(ConstructorInfo)"/> is unavailable because
    /// <see cref="TypeParameterSymbol"/> has no <see cref="Type"/>.
    /// </summary>
    /// <param name="nullableOfTp">A <see cref="NullableTypeSymbol"/> whose underlying type is an open <see cref="TypeParameterSymbol"/>.</param>
    /// <returns>The MemberRef handle for <c>Nullable&lt;!!T&gt;::.ctor(!0)</c>.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForOpenTypeParameter(NullableTypeSymbol nullableOfTp)
    {
        if (nullableOfTp?.UnderlyingType is not TypeParameterSymbol tp)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForOpenTypeParameter requires Nullable<TypeParameter>.");
        }

        if (this.cache.NullableOpenCtorMemberRefs.TryGetValue(tp, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfTp);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    // `!0`: the parent TypeSpec's first generic parameter
                    // (i.e. the inner type that Nullable<> is closed over).
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableOpenCtorMemberRefs[tp] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #1298: gets a MemberRef for <c>System.Nullable`1&lt;E&gt;::.ctor(!0)</c>
    /// where <c>E</c> is a user-declared enum emitted in this assembly. The
    /// enum has no runtime CLR type, so the BCL-backed
    /// <see cref="WellKnownReferences"/> ctor path cannot construct it; instead
    /// the parent TypeSpec closes <c>Nullable&lt;&gt;</c> over the enum's TypeDef
    /// and the ctor signature refers to that argument as <c>!0</c>. Mirrors
    /// <see cref="GetNullableCtorMemberRefForOpenTypeParameter"/>.
    /// </summary>
    /// <param name="nullableOfEnum">A <c>Nullable&lt;E&gt;</c> over a user enum.</param>
    /// <returns>The constructor MemberRef.</returns>
    internal MemberReferenceHandle GetNullableCtorMemberRefForUserEnum(NullableTypeSymbol nullableOfEnum)
    {
        if (nullableOfEnum?.UnderlyingType is not EnumSymbol enumSym)
        {
            throw new InvalidOperationException(
                "GetNullableCtorMemberRefForUserEnum requires Nullable<EnumSymbol>.");
        }

        if (this.cache.NullableUserEnumCtorMemberRefs.TryGetValue(enumSym, out var cached))
        {
            return cached;
        }

        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), nullableOfEnum);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameterCount: 1,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().GenericTypeParameter(0);
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.NullableUserEnumCtorMemberRefs[enumSym] = handle;
        return handle;
    }

    /// <summary>
    /// Phase 4 emit parity: get a MemberRef for a CLR field on a possibly
    /// generic declaring type (e.g. <c>KeyValuePair&lt;K, V&gt;.Key</c>).
    /// </summary>
    internal MemberReferenceHandle GetFieldReference(FieldInfo field)
    {
        if (this.cache.FieldRefs.TryGetValue(field, out var existing))
        {
            return existing;
        }

        var declaring = field.DeclaringType
            ?? throw new InvalidOperationException("Imported field has no declaring type.");
        var parent = this.GetTypeHandleForMember(declaring);

        // Use the open field's FieldType so it encodes as !N when applicable.
        var openField = declaring.IsConstructedGenericType
            ? declaring.GetGenericTypeDefinition().GetField(
                field.Name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                ?? field
            : field;

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(field.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.cache.FieldRefs[field] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a field on a constructed generic type without
    /// calling <c>.GetField()</c> on the closed generic (which throws
    /// <see cref="NotSupportedException"/> when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the field from the open generic type definition.
    /// </summary>
    internal MemberReferenceHandle GetFieldReferenceOnConstructedGeneric(Type closedGenericType, string fieldName)
    {
        var openType = closedGenericType.GetGenericTypeDefinition();
        var openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException(
                $"Open generic type '{openType.FullName}' has no field '{fieldName}'.");

        var parent = this.GetTypeHandleForMember(closedGenericType);

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a constructor on a constructed generic type without
    /// calling <c>.GetConstructors()</c> on the closed generic (which throws
    /// <see cref="NotSupportedException"/> when type arguments are MLC-loaded or
    /// TypeBuilder-backed). Resolves the constructor from the open generic type definition.
    /// </summary>
    internal MemberReferenceHandle GetCtorReferenceOnConstructedGeneric(Type closedGenericType, int paramCount)
    {
        var openType = closedGenericType.GetGenericTypeDefinition();
        ConstructorInfo openCtor = null;
        foreach (var c in openType.GetConstructors())
        {
            if (c.GetParameters().Length == paramCount)
            {
                openCtor = c;
                break;
            }
        }

        if (openCtor == null)
        {
            throw new InvalidOperationException(
                $"Open generic type '{openType.FullName}' has no constructor of arity {paramCount}.");
        }

        var parent = this.GetTypeHandleForMember(closedGenericType);

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        var paramType = p.ParameterType;
                        if (paramType.IsByRef)
                        {
                            this.EncodeClrType(ps.AddParameter().Type(isByRef: true), paramType.GetElementType()!);
                        }
                        else
                        {
                            this.EncodeClrType(ps.AddParameter().Type(), paramType);
                        }
                    }
                });

        var handle = this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return handle;
    }

    /// <summary>
    /// Issue #649: Gets the TypeSpec handle for a <c>ValueTuple&lt;...&gt;</c> whose element
    /// types include G#-defined types (StructSymbol) that lack a CLR backing type.
    /// Encodes each element type via <see cref="EncodeTypeSymbol"/> so user-defined types
    /// are correctly referenced by their TypeDef handles.
    /// </summary>
    private EntityHandle GetTupleTypeSpec(TupleTypeSymbol tupleType)
    {
        var arity = tupleType.Arity;
        var openType = arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple TypeSpec not supported for arity {arity}."),
        };

        var sigBlob = new BlobBuilder();
        var genInst = new BlobEncoder(sigBlob).TypeSpecificationSignature()
            .GenericInstantiation(
                this.GetTypeReference(openType),
                arity,
                isValueType: true);
        foreach (var elemType in tupleType.ElementTypes)
        {
            this.EncodeTypeSymbol(genInst.AddArgument(), elemType);
        }

        return this.emitCtx.Metadata.AddTypeSpecification(
            this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a tuple field (<c>Item1</c>...<c>Item7</c>) when
    /// the tuple's <see cref="TypeSymbol.ClrType"/> is null (element types include
    /// G#-defined types). Builds the field MemberRef against the symbolically-constructed
    /// <c>ValueTuple</c> TypeSpec.
    /// </summary>
    internal MemberReferenceHandle GetTupleFieldReference(TupleTypeSymbol tupleType, string fieldName)
    {
        var parent = this.GetTupleTypeSpec(tupleType);

        // Get the open field from the BCL ValueTuple generic definition for signature encoding.
        var openType = tupleType.Arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple field ref not supported for arity {tupleType.Arity}."),
        };

        var openField = openType.GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Public)
            ?? throw new InvalidOperationException(
                $"Open ValueTuple type has no field '{fieldName}'.");

        var sigBlob = new BlobBuilder();
        this.EncodeClrType(new BlobEncoder(sigBlob).FieldSignature(), openField.FieldType);

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(fieldName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #649: Gets a MemberRef for a tuple constructor when the tuple's
    /// <see cref="TypeSymbol.ClrType"/> is null (element types include G#-defined
    /// types). Builds the ctor MemberRef against the symbolically-constructed
    /// <c>ValueTuple</c> TypeSpec.
    /// </summary>
    internal MemberReferenceHandle GetTupleCtorReference(TupleTypeSymbol tupleType)
    {
        var parent = this.GetTupleTypeSpec(tupleType);
        var arity = tupleType.Arity;

        var openType = arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => throw new NotSupportedException(
                $"Symbolic tuple ctor ref not supported for arity {arity}."),
        };

        ConstructorInfo openCtor = null;
        foreach (var c in openType.GetConstructors())
        {
            if (c.GetParameters().Length == arity)
            {
                openCtor = c;
                break;
            }
        }

        if (openCtor == null)
        {
            throw new InvalidOperationException(
                $"Open ValueTuple type of arity {arity} has no matching constructor.");
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                openCtor.GetParameters().Length,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    foreach (var p in openCtor.GetParameters())
                    {
                        this.EncodeClrType(ps.AddParameter().Type(), p.ParameterType);
                    }
                });

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): encodes a single local-variable signature slot.
    /// A <see cref="ByRefTypeSymbol"/> entry signals a ref-aliasing local (<c>let ref</c> /
    /// <c>var ref</c>) whose slot must carry <c>ELEMENT_TYPE_BYREF</c> wrapping the pointee
    /// type. Non-byref entries forward to <see cref="EncodeTypeSymbol"/> unchanged.
    /// </summary>
    private void EncodeLocalVariableType(LocalVariableTypeEncoder enc, TypeSymbol t)
    {
        // ADR-0125 / issue #1026: a `fixed` statement's pinned local carries the
        // CLR `pinned` flag so the GC cannot relocate the pinned buffer. The
        // underlying storage is either a managed by-ref (`T& pinned`, string
        // form) or an ordinary managed type such as the array (`T[] pinned`,
        // array form).
        if (t is PinnedTypeSymbol pinned)
        {
            if (pinned.UnderlyingType is ByRefTypeSymbol pinnedByRef)
            {
                EncodeTypeSymbol(enc.Type(isByRef: true, isPinned: true), pinnedByRef.PointeeType);
            }
            else
            {
                EncodeTypeSymbol(enc.Type(isByRef: false, isPinned: true), pinned.UnderlyingType);
            }

            return;
        }

        if (t is ByRefTypeSymbol byRef)
        {
            EncodeTypeSymbol(enc.Type(isByRef: true), byRef.PointeeType);
        }
        else
        {
            EncodeTypeSymbol(enc.Type(), t);
        }
    }

    private void EncodeTypeSymbol(SignatureTypeEncoder encoder, TypeSymbol type)
    {
        // ADR-0122 / issue #1014: an *unmanaged* pointer type (PointerTypeSymbol
        // → CLR ELEMENT_TYPE_PTR) is encoded by emitting the `*` element-type
        // prefix and recursing on the pointee. Unlike ELEMENT_TYPE_BYREF this is
        // a valid SignatureTypeEncoder element, so fields, parameters, returns,
        // and locals all flow through this branch uniformly.
        if (type is PointerTypeSymbol ptr)
        {
            var pointerEncoder = encoder.Pointer();

            // ADR-0122 §3 / issue #1033: `*void` (C# `void*`) encodes as
            // ELEMENT_TYPE_PTR over ELEMENT_TYPE_VOID. SignatureTypeEncoder has
            // no `Void()` helper (void is only valid as a return or pointee), so
            // write the raw ELEMENT_TYPE_VOID type-code byte after the pointer
            // prefix that `encoder.Pointer()` already emitted.
            if (ptr.PointeeType == TypeSymbol.Void)
            {
                pointerEncoder.Builder.WriteByte((byte)System.Reflection.Metadata.SignatureTypeCode.Void);
                return;
            }

            EncodeTypeSymbol(pointerEncoder, ptr.PointeeType);
            return;
        }

        // ADR-0060 §13 / migration: a managed-pointer type (ByRefTypeSymbol → T&) cannot
        // be encoded into a SignatureTypeEncoder slot because ELEMENT_TYPE_BYREF is a
        // parent-encoder concern. Callers in parameter / return / local positions must
        // request the byref form via the parent encoder (e.g. `ParameterTypeEncoder.Type(isByRef:true)`)
        // and then call EncodeTypeSymbol with the pointee type. The bug being fixed here
        // is that the previous code silently encoded `T&` as `T`, producing wrong CLR
        // signatures for `&T`-typed locals/fields/returns. Detect and fail loudly.
        if (type is ByRefTypeSymbol byRef)
        {
            throw new InvalidOperationException(
                $"Cannot encode '*{byRef.PointeeType.Name}' as a non-byref signature slot; "
                + "use the parent encoder's Type(isByRef: true) overload (parameter/return/local) "
                + "and pass the pointee type to EncodeTypeSymbol.");
        }

        // Phase 3 exit: `T?` for reference types is metadata-only (same CLR
        // signature as `T`). For value types it lowers to `Nullable<T>`.
        if (type is NullableTypeSymbol nullable)
        {
            var inner = nullable.UnderlyingType;

            // P2-7 / Issue #421: nullable over a value type encodes as
            // System.Nullable<T> (generic instantiation). We support inner
            // types backed by a CLR value type (primitives, BCL value types).
            if (inner?.ClrType is { IsValueType: true } innerClrVt)
            {
                // Issue #571: build Nullable<T> from the open `System.Nullable`1`
                // discovered through the ReferenceResolver so it shares the load
                // context of the inner value type. See GetElementTypeToken.
                if (!NullableLifting.TryConstructNullable(this.emitCtx.References, innerClrVt, out var nullableClr))
                {
                    throw new InvalidOperationException(
                        $"Cannot construct Nullable<{innerClrVt.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
                }

                this.EncodeClrType(encoder, nullableClr);
                return;
            }

            // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter
            // constrained to `struct` must encode as `GENERICINST System.Nullable`1<MVAR/VAR>`,
            // not as the bare `T` slot. Without this branch the struct-constrained
            // overload of `FirstOrNil`/`LastOrNil`/`SingleOrNil` emits a return
            // signature of `!!T` that, after instantiation with a value type,
            // becomes plain `int32` (etc.) — but the body assigns/returns a
            // `Nullable<T>` value, so the verifier rejects the mismatch and the
            // runtime mis-shapes the slot.  When the constraint is `class` the
            // CLR representation of `T?` coincides with `T` (a reference slot
            // that can hold `null`), so we keep the existing fall-through
            // to encode the bare type parameter.
            if (inner is TypeParameterSymbol nullableTp && nullableTp.HasValueTypeConstraint)
            {
                var nullableOpen = typeof(System.Nullable<>);
                var giNullable = encoder.GenericInstantiation(
                    this.GetTypeReference(nullableOpen),
                    genericArgumentCount: 1,
                    isValueType: true);
                this.EncodeTypeSymbol(giNullable.AddArgument(), nullableTp);
                return;
            }

            if (inner is StructSymbol nestedStruct && !nestedStruct.IsClass)
            {
                throw new NotSupportedException(
                    $"Nullable user-defined struct '{inner.Name}?' is not yet supported by the emitter.");
            }

            if (inner is EnumSymbol nestedEnum)
            {
                // Issue #1298: `E?` over a user-declared enum lowers to
                // `System.Nullable<E>` — a generic instantiation whose single
                // argument is the enum's own emitted TypeDef. Mirrors the
                // struct-constrained type-parameter branch above.
                if (!this.cache.EnumTypeDefs.ContainsKey(nestedEnum))
                {
                    throw new InvalidOperationException(
                        $"Enum '{nestedEnum.Name}' has no emitted TypeDef.");
                }

                var nullableOpenForEnum = typeof(System.Nullable<>);
                var giNullableEnum = encoder.GenericInstantiation(
                    this.GetTypeReference(nullableOpenForEnum),
                    genericArgumentCount: 1,
                    isValueType: true);
                this.EncodeTypeSymbol(giNullableEnum.AddArgument(), nestedEnum);
                return;
            }

            EncodeTypeSymbol(encoder, inner);
            return;
        }

        if (type == TypeSymbol.Bool)
        {
            encoder.Boolean();
        }
        else if (type == TypeSymbol.Int32)
        {
            encoder.Int32();
        }
        else if (type == TypeSymbol.String)
        {
            encoder.String();
        }
        else if (type == TypeSymbol.Void)
        {
            throw new InvalidOperationException("Use ReturnTypeEncoder.Void() for void returns.");
        }
        else if (type is TypeParameterSymbol tp)
        {
            // Issue #810: when emitting a state-machine method (or the
            // state-machine class itself), references to the OUTER
            // method's type parameters are encoded as the SM class's
            // own type parameters (Var(i)). This mirrors how Roslyn
            // emits `<Empty>d__0<T>` where the body's `!!0` becomes
            // `!0` on the SM class. The remap is pushed by
            // EmitIteratorStateMachineMember and is keyed by the
            // method TP's instance identity.
            if (this.activeIteratorStateMachineRemap != null
                && tp.IsMethodTypeParameter
                && this.activeIteratorStateMachineRemap.TryGetValue(tp, out var classOrdinal))
            {
                encoder.GenericTypeParameter(classOrdinal);
            }

            // ADR-0087 §3 R2: a user-declared open type parameter encodes as
            // GenericTypeParameter(idx) (`Var(idx)`) when it belongs to a
            // generic type, or as GenericMethodTypeParameter(idx) (`MVar(idx)`)
            // when it belongs to a generic method. The
            // TypeParameterSymbol.IsMethodTypeParameter flag, set by the
            // FunctionSymbol.TypeParameters setter, discriminates the owner
            // kind without a back-reference cycle.
            else if (tp.IsMethodTypeParameter)
            {
                encoder.GenericMethodTypeParameter(tp.Ordinal);
            }
            else
            {
                encoder.GenericTypeParameter(tp.Ordinal);
            }
        }
        else if (type is ImportedTypeSymbol symbolicImported
            && !symbolicImported.TypeArguments.IsDefaultOrEmpty
            && !symbolicImported.HasTypeParameterArgument
            && symbolicImported.OpenDefinition != null
            && symbolicImported.TypeArguments.Any(ArgIsSymbolicUserDefined))
        {
            var genericInst = encoder.GenericInstantiation(
                this.GetTypeReference(symbolicImported.OpenDefinition),
                symbolicImported.TypeArguments.Length,
                isValueType: symbolicImported.OpenDefinition.IsValueType);
            foreach (var arg in symbolicImported.TypeArguments)
            {
                this.EncodeTypeSymbol(genericInst.AddArgument(), arg);
            }
        }
        else if (type is ImportedTypeSymbol erasedGeneric && erasedGeneric.HasTypeParameterArgument)
        {
            // ADR-0087 §3 R2: a generic CLR type constructed over an in-scope
            // type parameter (e.g. `List[T]`) is no longer erased to
            // `System.Object`. Emit a real `GENERICINST<def><args>` so the
            // signature carries `Var`/`MVar` slots that match the actual
            // runtime type. Boxing/unboxing at boundaries is now handled by
            // explicit `box T`/`unbox.any T` in the body emitter when the
            // value bridges across an `object` slot.
            var openDef = erasedGeneric.OpenDefinition
                ?? throw new InvalidOperationException(
                    $"Imported generic '{erasedGeneric.Name}' has no OpenDefinition for GENERICINST encoding.");
            var giOpen = encoder.GenericInstantiation(
                this.GetTypeReference(openDef),
                erasedGeneric.TypeArguments.Length,
                isValueType: openDef.IsValueType);
            foreach (var arg in erasedGeneric.TypeArguments)
            {
                this.EncodeTypeSymbol(giOpen.AddArgument(), arg);
            }
        }
        else if (type is ArrayTypeSymbol arr)
        {
            EncodeTypeSymbol(encoder.SZArray(), arr.ElementType);
        }
        else if (type is SliceTypeSymbol slice)
        {
            EncodeTypeSymbol(encoder.SZArray(), slice.ElementType);
        }
        else if (type is SequenceTypeSymbol openSeq && openSeq.ClrType == null)
        {
            // Issue #773: an open `sequence[T]` (where T is an in-scope
            // type parameter) has no closed CLR type yet. Encode it as
            // `GENERICINST<IEnumerable`1><T>` so the resulting method
            // signature carries an honest `IEnumerable<MVar/Var>` slot
            // — same pattern as ADR-0087 §3 R2 for `ImportedTypeSymbol`
            // with `HasTypeParameterArgument`.
            var enumerableOpen = typeof(System.Collections.Generic.IEnumerable<>);
            var giSeq = encoder.GenericInstantiation(
                this.GetTypeReference(enumerableOpen),
                1,
                isValueType: false);
            this.EncodeTypeSymbol(giSeq.AddArgument(), openSeq.ElementType);
        }
        else if (type is AsyncSequenceTypeSymbol openAseq && openAseq.ClrType == null)
        {
            // Mirror of the synchronous-sequence open-T encoding for
            // `async sequence[T]` (== IAsyncEnumerable<T>).
            var asyncEnumerableOpen = typeof(System.Collections.Generic.IAsyncEnumerable<>);
            var giAseq = encoder.GenericInstantiation(
                this.GetTypeReference(asyncEnumerableOpen),
                1,
                isValueType: false);
            this.EncodeTypeSymbol(giAseq.AddArgument(), openAseq.ElementType);
        }
        else if (type is StructSymbol structSym)
        {
            // ADR-0087 §3 R2: a user-declared generic struct encodes as
            // GENERICINST<def><args>. For a constructed instance the args
            // come from TypeArguments; for the open definition itself we
            // emit the self-instantiation `Box`1<!0,!1,…>` so signatures
            // of synthesized members (Equals(typed), op_Equality, …)
            // round-trip correctly under verification.
            var defSym = structSym.Definition ?? structSym;
            if (!this.cache.StructTypeDefs.TryGetValue(defSym, out var typeDef))
            {
                throw new InvalidOperationException($"Struct '{defSym.Name}' has no emitted TypeDef.");
            }

            if (IsUserGenericTypeReference(structSym))
            {
                ImmutableArray<TypeSymbol> typeArgs;
                if (!structSym.TypeArguments.IsDefaultOrEmpty)
                {
                    typeArgs = structSym.TypeArguments;
                }
                else
                {
                    var defTps = defSym.TypeParameters;
                    var bld = ImmutableArray.CreateBuilder<TypeSymbol>(defTps.Length);
                    foreach (var defTp in defTps)
                    {
                        bld.Add(defTp);
                    }

                    typeArgs = bld.MoveToImmutable();
                }

                var gi = encoder.GenericInstantiation(typeDef, typeArgs.Length, isValueType: !defSym.IsClass);
                foreach (var arg in typeArgs)
                {
                    this.EncodeTypeSymbol(gi.AddArgument(), arg);
                }
            }
            else
            {
                encoder.Type(typeDef, isValueType: !structSym.IsClass);
            }
        }
        else if (type is EnumSymbol enumSym)
        {
            // Issue #193: a user-defined enum's signature surface is its
            // own TypeDef (a sealed value type derived from System.Enum).
            if (!this.cache.EnumTypeDefs.TryGetValue(enumSym, out var enumTypeDef))
            {
                throw new InvalidOperationException($"Enum '{enumSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(enumTypeDef, isValueType: true);
        }
        else if (type is InterfaceSymbol ifaceSym)
        {
            // Phase D: user-defined interface as a signature type. The
            // CLR encodes interfaces with the same CLASS bit as a reference
            // type (isValueType: false).
            //
            // ADR-0087 R5 / issue #765: when this is a constructed instance
            // of a user-declared generic interface (`IBox[int32]`), or the
            // open generic definition referenced as a signature type, emit
            // a GENERICINST against the definition's TypeDef. Mirrors the
            // StructSymbol branch above so member dispatch through
            // `let b IBox[int32] = …` (TypeSpec-parented MemberRef) and
            // signature encoding of an open `IBox[T]` parameter both
            // round-trip under IL verification.
            var ifaceDefSym = ifaceSym.Definition ?? ifaceSym;
            if (!this.cache.InterfaceTypeDefs.TryGetValue(ifaceDefSym, out var ifaceDef))
            {
                throw new InvalidOperationException($"Interface '{ifaceDefSym.Name}' has no emitted TypeDef.");
            }

            if (IsUserGenericInterfaceReference(ifaceSym))
            {
                ImmutableArray<TypeSymbol> ifaceTypeArgs;
                if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
                {
                    ifaceTypeArgs = ifaceSym.TypeArguments;
                }
                else
                {
                    var ifaceDefTps = ifaceDefSym.TypeParameters;
                    var ifaceBld = ImmutableArray.CreateBuilder<TypeSymbol>(ifaceDefTps.Length);
                    foreach (var defTp in ifaceDefTps)
                    {
                        ifaceBld.Add(defTp);
                    }

                    ifaceTypeArgs = ifaceBld.MoveToImmutable();
                }

                var ifaceGi = encoder.GenericInstantiation(ifaceDef, ifaceTypeArgs.Length, isValueType: false);
                foreach (var arg in ifaceTypeArgs)
                {
                    this.EncodeTypeSymbol(ifaceGi.AddArgument(), arg);
                }
            }
            else
            {
                encoder.Type(ifaceDef, isValueType: false);
            }
        }
        else if (type is DelegateTypeSymbol delegateSym)
        {
            // ADR-0059 / issue #255: a user-declared named delegate type
            // encodes as a reference type referring to its own TypeDef
            // (a sealed class deriving from System.MulticastDelegate).
            if (!this.cache.DelegateTypeDefs.TryGetValue(delegateSym, out var delegateDef))
            {
                throw new InvalidOperationException($"Delegate '{delegateSym.Name}' has no emitted TypeDef.");
            }

            encoder.Type(delegateDef, isValueType: false);
        }
        else if (type is ChannelTypeSymbol chType)
        {
            // Phase E: chan T -> System.Threading.Channels.Channel<T>.
            // For element types that lack a ClrType we erase to object,
            // matching the interpreter's `ElementType.ClrType ?? typeof(object)`
            // fallback (ADR-0022 §interpreter).
            var elementClr = chType.ElementType.ClrType ?? typeof(object);
            var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
            this.EncodeClrType(encoder, channelClr);
        }
        else if (type is TupleTypeSymbol tupleWithNullClr && tupleWithNullClr.ClrType == null
            && tupleWithNullClr.Arity >= 2 && tupleWithNullClr.Arity <= 7)
        {
            // Issue #649: Tuple containing G#-defined types whose ClrType is null.
            // Encode as ValueTuple<...> generic instantiation using EncodeTypeSymbol
            // for each element so user-defined types reference their TypeDef handles.
            var openType = tupleWithNullClr.Arity switch
            {
                2 => typeof(ValueTuple<,>),
                3 => typeof(ValueTuple<,,>),
                4 => typeof(ValueTuple<,,,>),
                5 => typeof(ValueTuple<,,,,>),
                6 => typeof(ValueTuple<,,,,,>),
                7 => typeof(ValueTuple<,,,,,,>),
                _ => throw new NotSupportedException("unreachable"),
            };

            var genericInst = encoder.GenericInstantiation(
                this.GetTypeReference(openType),
                tupleWithNullClr.Arity,
                isValueType: true);
            foreach (var elemType in tupleWithNullClr.ElementTypes)
            {
                this.EncodeTypeSymbol(genericInst.AddArgument(), elemType);
            }
        }
        else if (type is FunctionPointerTypeSymbol fnPtr)
        {
            // ADR-0095 / issue #761: a raw function-pointer type encodes
            // as an ELEMENT_TYPE_FNPTR followed by a nested method
            // signature (calling convention + return + parameters). The
            // GS-level type is an address-sized integer at runtime, but
            // the metadata blob is rendered as FNPTR for type fidelity
            // so disassemblers and the verifier see the precise shape.
            var fnPtrConvention = MapToSignatureCallingConvention(fnPtr.CallingConvention);
            var fnPtrSig = encoder.FunctionPointer(fnPtrConvention, FunctionPointerAttributes.None, 0);
            fnPtrSig.Parameters(fnPtr.ParameterTypes.Length, out var fnRetEnc, out var fnParamsEnc);
            this.EncodeReturnSymbol(fnRetEnc, fnPtr.ReturnType);
            for (var i = 0; i < fnPtr.ParameterTypes.Length; i++)
            {
                this.EncodeTypeSymbol(fnParamsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i]);
            }
        }
        else if (type?.ClrType != null)
        {
            this.EncodeClrType(encoder, type.ClrType);
        }
        else if (type is FunctionTypeSymbol openFn)
        {
            // ADR-0087 §3 R6: encode an open-bearing delegate type as a
            // reified `GENERICINST<Func`N or Action`N><args>` so the
            // signature carries `Var`/`MVar` slots that match the
            // runtime delegate. Previously the encoder fell back to
            // `Func<object, object>`, and the call site bridged the
            // value-type boundary through `Delegate.DynamicInvoke`.
            this.EncodeFunctionTypeSymbol(encoder, openFn);
        }
        else
        {
            throw new NotSupportedException($"Cannot encode signature for type '{type?.Name}' yet.");
        }
    }

    private static bool IsAsyncUserDefinedResultType(TypeSymbol type)
        => type is StructSymbol or InterfaceSymbol or EnumSymbol;

    /// <summary>
    /// ADR-0122 §9 / issue #1035: builds a standalone method signature for a
    /// function-pointer type, used as the operand of the CIL <c>calli</c>
    /// opcode. Managed function pointers use the default managed calling
    /// convention; unmanaged ones carry their declared ABI.
    /// </summary>
    /// <param name="fnPtr">The function-pointer type to sign.</param>
    /// <returns>A standalone signature handle for <c>calli</c>.</returns>
    internal StandaloneSignatureHandle GetFunctionPointerCallSiteSignature(FunctionPointerTypeSymbol fnPtr)
    {
        var convention = fnPtr.IsManaged
            ? System.Reflection.Metadata.SignatureCallingConvention.Default
            : MapToSignatureCallingConvention(fnPtr.CallingConvention);
        var sigBlob = new BlobBuilder();
        var sig = new BlobEncoder(sigBlob).MethodSignature(convention, 0, isInstanceMethod: false);
        sig.Parameters(fnPtr.ParameterTypes.Length, out var retEnc, out var paramsEnc);
        this.EncodeReturnSymbol(retEnc, fnPtr.ReturnType);
        for (var i = 0; i < fnPtr.ParameterTypes.Length; i++)
        {
            this.EncodeTypeSymbol(paramsEnc.AddParameter().Type(), fnPtr.ParameterTypes[i]);
        }

        return this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// ADR-0095 / issue #761: maps the
    /// <see cref="System.Runtime.InteropServices.CallingConvention"/>
    /// enum (used by <c>@DllImport</c> / <c>@UnmanagedFunctionPointer</c>
    /// declarations and by <see cref="FunctionPointerTypeSymbol"/>) to
    /// the metadata-level
    /// <see cref="System.Reflection.Metadata.SignatureCallingConvention"/>
    /// enum used when encoding an ELEMENT_TYPE_FNPTR signature blob.
    /// </summary>
    private static System.Reflection.Metadata.SignatureCallingConvention MapToSignatureCallingConvention(System.Runtime.InteropServices.CallingConvention convention)
    {
        return convention switch
        {
            System.Runtime.InteropServices.CallingConvention.Cdecl => System.Reflection.Metadata.SignatureCallingConvention.CDecl,
            System.Runtime.InteropServices.CallingConvention.StdCall => System.Reflection.Metadata.SignatureCallingConvention.StdCall,
            System.Runtime.InteropServices.CallingConvention.ThisCall => System.Reflection.Metadata.SignatureCallingConvention.ThisCall,
            System.Runtime.InteropServices.CallingConvention.FastCall => System.Reflection.Metadata.SignatureCallingConvention.FastCall,
            System.Runtime.InteropServices.CallingConvention.Winapi => System.Reflection.Metadata.SignatureCallingConvention.StdCall,
            _ => System.Reflection.Metadata.SignatureCallingConvention.CDecl,
        };
    }

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

    private void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type)
        => EncodeReturnSymbol(encoder, type, RefKind.None);

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a function whose <see cref="FunctionSymbol.ReturnRefKind"/>
    /// is <see cref="RefKind.Ref"/> returns a managed pointer (<c>T&amp;</c>) — encode it via
    /// the <c>ReturnTypeEncoder.Type(isByRef: true, ...)</c> overload.
    /// </summary>
    private void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type, RefKind returnRefKind)
    {
        if (type == TypeSymbol.Void)
        {
            encoder.Void();
        }
        else
        {
            this.EncodeTypeSymbol(encoder.Type(isByRef: returnRefKind == RefKind.Ref), type);
        }
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
        if (type is NullableTypeSymbol nullableEnum
            && nullableEnum.UnderlyingType is EnumSymbol)
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
    private static bool ArgIsSymbolicUserDefined(TypeSymbol arg)
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

    private void EncodeClrType(SignatureTypeEncoder encoder, Type type)
    {
        // ADR-0060 §13 / migration: same as EncodeTypeSymbol — a CLR `T&` (Type.IsByRef)
        // cannot be encoded into a SignatureTypeEncoder slot. Callers must arrange the
        // byref form via the parent encoder. Detect and fail loudly so the previously
        // silent miscoding shows up as an emit-time error.
        if (type != null && type.IsByRef)
        {
            throw new InvalidOperationException(
                $"Cannot encode CLR byref type '{type.FullName}' as a non-byref signature slot; "
                + "use the parent encoder's Type(isByRef: true) overload and pass the element type to EncodeClrType.");
        }

        // ADR-0122 / issue #1014: a CLR unmanaged pointer (`T*`, Type.IsPointer)
        // encodes with the `*` element-type prefix followed by the element type.
        if (type != null && type.IsPointer)
        {
            EncodeClrType(encoder.Pointer(), type.GetElementType()!);
            return;
        }

        // Compare by FullName so types from a MetadataLoadContext (carrying the target
        // framework's identity) still encode to the same well-known primitive opcodes.
        var fullName = type?.FullName;
        switch (fullName)
        {
            case "System.Boolean":
                encoder.Boolean();
                break;
            case "System.Byte":
                encoder.Byte();
                break;
            case "System.SByte":
                encoder.SByte();
                break;
            case "System.Int16":
                encoder.Int16();
                break;
            case "System.UInt16":
                encoder.UInt16();
                break;
            case "System.Int32":
                encoder.Int32();
                break;
            case "System.UInt32":
                encoder.UInt32();
                break;
            case "System.Int64":
                encoder.Int64();
                break;
            case "System.UInt64":
                encoder.UInt64();
                break;
            case "System.Single":
                encoder.Single();
                break;
            case "System.Double":
                encoder.Double();
                break;
            case "System.Char":
                encoder.Char();
                break;
            case "System.String":
                encoder.String();
                break;
            case "System.Object":
                encoder.Object();
                break;
            case "System.IntPtr":
                encoder.IntPtr();
                break;
            case "System.UIntPtr":
                encoder.UIntPtr();
                break;
            case "System.Void":
                // ADR-0124 / issue #1024: `void*` (the first parameter of
                // `Span<T>(void* pointer, int length)`) encodes as PTR VOID.
                // The pointer prefix is written by the parent `encoder.Pointer()`
                // call (see the IsPointer branch above); here we emit the raw
                // ELEMENT_TYPE_VOID for the pointee. SignatureTypeEncoder has no
                // Void() helper (void is only valid as a return or pointee), so
                // write the type-code byte directly.
                encoder.Builder.WriteByte((byte)System.Reflection.Metadata.SignatureTypeCode.Void);
                break;
            default:
                if (type == null)
                {
                    throw new NotSupportedException("Cannot encode signature for a null CLR type.");
                }

                if (type.IsGenericParameter)
                {
                    // Method signatures reference declaring-type generic params as `!N`
                    // and declaring-method generic params as `!!N` (Phase E adds method
                    // generic support for calls like `Channel.CreateUnbounded<T>()`).
                    if (type.DeclaringMethod != null)
                    {
                        encoder.GenericMethodTypeParameter(type.GenericParameterPosition);
                    }
                    else
                    {
                        encoder.GenericTypeParameter(type.GenericParameterPosition);
                    }

                    break;
                }

                if (type.IsArray && type.GetArrayRank() == 1)
                {
                    EncodeClrType(encoder.SZArray(), type.GetElementType()!);
                    break;
                }

                if (type.IsConstructedGenericType)
                {
                    var openDef = type.GetGenericTypeDefinition();
                    var typeArgs = type.GetGenericArguments();
                    var genericInst = encoder.GenericInstantiation(
                        this.GetTypeReference(openDef),
                        typeArgs.Length,
                        isValueType: openDef.IsValueType);
                    foreach (var arg in typeArgs)
                    {
                        EncodeClrType(genericInst.AddArgument(), arg);
                    }

                    break;
                }

                // A generic type definition used as a return/parameter type in an
                // open method signature (e.g. AsyncTaskMethodBuilder<TResult>.Create()
                // returning AsyncTaskMethodBuilder<TResult>). The reflection type is
                // the generic type definition itself, but it must encode as a
                // GenericInstantiation with its own type parameters as arguments.
                if (type.IsGenericTypeDefinition)
                {
                    var typeParams = type.GetGenericArguments();
                    var genericInst = encoder.GenericInstantiation(
                        this.GetTypeReference(type),
                        typeParams.Length,
                        isValueType: type.IsValueType);
                    foreach (var tp in typeParams)
                    {
                        EncodeClrType(genericInst.AddArgument(), tp);
                    }

                    break;
                }

                encoder.Type(this.GetTypeReference(type), isValueType: type.IsValueType);
                break;
        }
    }

    private void EncodeReturnClr(ReturnTypeEncoder encoder, ParameterInfo returnParameter, Type type)
    {
        if (type?.FullName == "System.Void")
        {
            // Issue #522: a void return may still carry required custom
            // modifiers — most notably C# 9 init-only property setters emit
            // `modreq(System.Runtime.CompilerServices.IsExternalInit)` on the
            // setter's void return. The modreq is part of the method
            // signature; if we omit it the MemberRef fails to resolve at
            // runtime (System.MissingMethodException). Mirrors the byref
            // branch below — encode modreqs first, then the void slot.
            var voidRequiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (voidRequiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in voidRequiredModifiers)
                {
                    modifiers.AddModifier(this.GetTypeReference(modifier), isOptional: false);
                }
            }

            encoder.Void();
        }
        else if (type != null && type.IsByRef)
        {
            // ADR-0056 §1/§2: a `ref`/`ref readonly T` return (e.g. the span
            // indexer's `get_Item`) must encode as a managed pointer to the
            // pointee. A `ref readonly T` return additionally carries a required
            // custom modifier (`modreq(InAttribute)` on `ReadOnlySpan[T]`); it
            // must be encoded or the methodref signature fails to resolve at
            // runtime (MissingMethodException). Without `isByRef: true` the
            // return was malformed for every ref-returning member.
            var requiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (requiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in requiredModifiers)
                {
                    modifiers.AddModifier(this.GetTypeReference(modifier), isOptional: false);
                }
            }

            this.EncodeClrType(encoder.Type(isByRef: true), type.GetElementType()!);
        }
        else
        {
            this.EncodeClrType(encoder.Type(), type);
        }
    }

    /// <summary>
    /// Issue #295: map an arbitrary CLR delegate type (named or generic, e.g.
    /// <c>System.Predicate&lt;int&gt;</c>, <c>RequestDelegate</c>,
    /// <c>System.EventHandler</c>) from the host runtime onto the emitter's
    /// reference (MetadataLoadContext) types, reconstructing constructed
    /// generics from a reference open definition so the produced TypeSpec /
    /// MemberRef binds to the target framework assemblies. Falls back to the
    /// host type when no reference mapping is available.
    /// </summary>
    internal Type ResolveTargetDelegateClrType(Type hostDelegate)
    {
        if (hostDelegate == null)
        {
            return null;
        }

        if (hostDelegate.IsConstructedGenericType)
        {
            var openName = hostDelegate.GetGenericTypeDefinition().FullName;
            if (openName != null && this.emitCtx.References.TryResolveType(openName, out var openRef))
            {
                var hostArgs = hostDelegate.GetGenericArguments();
                var refArgs = new Type[hostArgs.Length];
                for (var i = 0; i < hostArgs.Length; i++)
                {
                    refArgs[i] = this.MapToReferenceClrType(hostArgs[i]) ?? hostArgs[i];
                }

                return openRef.MakeGenericType(refArgs);
            }

            return hostDelegate;
        }

        return this.MapToReferenceClrType(hostDelegate) ?? hostDelegate;
    }

    // Phase 4 emit parity (E1): resolve the BCL delegate type backing a
    // GSharp function type. The default ClrType on FunctionTypeSymbol uses
    // host-runtime `typeof(Func<,>)` (which lives in System.Private.CoreLib);
    // the emitter must instead reference the *target* framework's
    // System.Func / System.Action so the produced TypeRef binds to the right
    // assembly. Type arguments are resolved through references too so
    // signature encoding stays consistent end-to-end.
    internal Type ResolveDelegateClrType(FunctionTypeSymbol fnType)
    {
        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        if (isVoid && arity == 0)
        {
            return this.emitCtx.References.GetCoreType("System.Action");
        }

        var typeName = isVoid
            ? "System.Action`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);

        var args = new Type[arity + (isVoid ? 0 : 1)];
        for (int i = 0; i < arity; i++)
        {
            args[i] = this.ResolveDelegateArgClrType(fnType.ParameterTypes[i]);
        }

        if (!isVoid)
        {
            args[arity] = this.ResolveDelegateArgClrType(fnType.ReturnType);
        }

        return openDef.MakeGenericType(args);
    }

    // Resolve the CLR type used as a System.Func/System.Action type argument
    // for one delegate parameter or return TypeSymbol. ADR-0087 §3 R6: under
    // the reified model, a type-parameter slot must not appear here — the
    // signature encoder takes the symbolic path
    // (<see cref="EncodeFunctionTypeSymbol"/>) and the body emitter routes
    // delegate ctor / Invoke through MemberRefs parented at the reified
    // TypeSpec. Any caller that still passes a type-parameter-bearing type
    // is a missed conversion site and worth surfacing.
    private Type ResolveDelegateArgClrType(TypeSymbol type)
    {
        return this.MapToReferenceClrType(type.ClrType) ?? this.emitCtx.CoreObjectType;
    }

    // ADR-0087 §3 R6: cache for reified delegate (Func/Action) TypeSpecs
    // keyed by a stable function-type symbol identity. A FunctionTypeSymbol
    // is cached by its parameter/return symbol identities (see
    // FunctionTypeSymbol.Get) so reference-equality is sufficient.
    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateTypeSpecCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateCtorRefCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    private readonly Dictionary<FunctionTypeSymbol, EntityHandle> functionDelegateInvokeRefCache =
        new Dictionary<FunctionTypeSymbol, EntityHandle>(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// ADR-0087 §3 R6: encodes a <see cref="FunctionTypeSymbol"/> whose
    /// shape carries type-parameter slots (e.g. <c>func(T) U</c>) as a
    /// reified <c>GENERICINST&lt;Func`N or Action`N&gt;&lt;args&gt;</c>
    /// blob. Each argument is encoded recursively through
    /// <see cref="EncodeTypeSymbol"/>, so type parameters resolve to the
    /// proper <c>Var(idx)</c> / <c>MVar(idx)</c> slots.
    /// </summary>
    internal void EncodeFunctionTypeSymbol(SignatureTypeEncoder encoder, FunctionTypeSymbol fnType)
    {
        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        if (isVoid && arity == 0)
        {
            var actionType = this.emitCtx.References.GetCoreType("System.Action");
            this.EncodeClrType(encoder, actionType);
            return;
        }

        var typeName = isVoid
            ? "System.Action`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);
        var openHandle = this.GetTypeReference(openDef);
        int typeArgCount = arity + (isVoid ? 0 : 1);
        var gi = encoder.GenericInstantiation(openHandle, typeArgCount, isValueType: openDef.IsValueType);
        for (int i = 0; i < arity; i++)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ParameterTypes[i]);
        }

        if (!isVoid)
        {
            this.EncodeTypeSymbol(gi.AddArgument(), fnType.ReturnType);
        }
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns a <c>TypeSpec</c> EntityHandle for the
    /// reified <c>Func&lt;...&gt;</c> / <c>Action&lt;...&gt;</c> shape
    /// backing <paramref name="fnType"/>. Type-parameter arguments encode
    /// as <c>Var(idx)</c> / <c>MVar(idx)</c>.
    /// </summary>
    internal EntityHandle GetFunctionDelegateTypeSpec(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateTypeSpecCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var sigBlob = new BlobBuilder();
        this.EncodeFunctionTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), fnType);
        var spec = (EntityHandle)this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateTypeSpecCache[fnType] = spec;
        return spec;
    }

    /// <summary>
    /// Issue #1330: returns the MemberRef handle for the canonical delegate
    /// <c>.ctor(object, IntPtr)</c> parented at the constructed-generic TypeSpec
    /// of <paramref name="symbolicDelegate"/> — a delegate type closed over an
    /// in-scope generic type parameter (e.g. <c>Comparison&lt;!TResult&gt;</c>).
    /// Lets a function literal passed to a static generic factory
    /// (<c>Comparer[TResult].Create(...)</c>) materialise the exact delegate the
    /// callee expects rather than the natural <c>Func</c>/<c>Action</c> shape or
    /// the type-erased <c>Comparison&lt;object&gt;</c>.
    /// </summary>
    internal EntityHandle GetConstructedDelegateCtorRef(ImportedTypeSymbol symbolicDelegate)
    {
        var parentBlob = new BlobBuilder();
        this.EncodeTypeSymbol(new BlobEncoder(parentBlob).TypeSpecificationSignature(), symbolicDelegate);
        var parent = this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(parentBlob));

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                2,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().IntPtr();
                });

        return this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's <c>.ctor(object, IntPtr)</c>, parented at the
    /// <c>TypeSpec</c> for <paramref name="fnType"/>. Used by
    /// <c>EmitFunctionLiteral</c> / <c>EmitMethodGroup</c> when the
    /// function type contains type-parameter slots.
    /// </summary>
    internal EntityHandle GetFunctionDelegateCtorRef(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateCtorRefCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var parent = this.GetFunctionDelegateTypeSpec(fnType);

        // Every Func/Action delegate exposes the canonical
        // .ctor(object target, IntPtr methodPtr) signature; identical
        // for every arity so no Var/MVar slots are needed.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                2,
                returnType: r => r.Void(),
                parameters: ps =>
                {
                    ps.AddParameter().Type().Object();
                    ps.AddParameter().Type().IntPtr();
                });

        var handle = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateCtorRefCache[fnType] = handle;
        return handle;
    }

    /// <summary>
    /// ADR-0087 §3 R6: returns the MemberRef handle for the reified
    /// delegate's <c>Invoke</c> method, parented at the <c>TypeSpec</c>
    /// for <paramref name="fnType"/>. The signature uses <c>VAR(i)</c>
    /// slots referencing the delegate type's own class-generic
    /// parameters (e.g. <c>Func`2::Invoke</c> is encoded as
    /// <c>!0 Invoke(!0)</c> wait — actually
    /// <c>!1 Invoke(!0)</c>). When the runtime resolves this MemberRef
    /// through the constructed parent <c>TypeSpec</c> (e.g.
    /// <c>Func&lt;int32, int32&gt;</c>), the VAR slots get substituted
    /// to the concrete arguments. No <see cref="System.Delegate.DynamicInvoke"/>
    /// is required.
    /// </summary>
    internal EntityHandle GetFunctionDelegateInvokeRef(FunctionTypeSymbol fnType)
    {
        if (this.functionDelegateInvokeRefCache.TryGetValue(fnType, out var cached))
        {
            return cached;
        }

        var parent = this.GetFunctionDelegateTypeSpec(fnType);

        bool isVoid = FunctionTypeSymbol.IsVoidReturn(fnType.ReturnType);
        int arity = fnType.ParameterTypes.Length;

        // The MemberRef signature for a method on a generic TypeSpec
        // parent must reference the parent type's *class-generic*
        // type parameters via VAR slots (`!0`..`!N-1`). The runtime
        // substitutes them against the parent's instantiation when
        // dispatching the call. For Func`N the slots are
        // `(!0,...,!N-1) -> !N`; for Action`N they are
        // `(!0,...,!N-1) -> void`.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                arity,
                returnType: r =>
                {
                    if (isVoid)
                    {
                        r.Void();
                    }
                    else
                    {
                        r.Type().GenericTypeParameter(arity);
                    }
                },
                parameters: ps =>
                {
                    for (int i = 0; i < arity; i++)
                    {
                        ps.AddParameter().Type().GenericTypeParameter(i);
                    }
                });

        var handle = (EntityHandle)this.emitCtx.Metadata.AddMemberReference(
            parent: parent,
            name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        this.functionDelegateInvokeRefCache[fnType] = handle;
        return handle;
    }

    /// <summary>
    /// For an async lambda, resolves the delegate CLR type with the return type
    /// wrapped in Task/Task&lt;T&gt; (matching the actual kickoff method signature).
    /// </summary>
    internal Type ResolveAsyncDelegateClrType(FunctionTypeSymbol fnType, FunctionSymbol function)
    {
        // Find the async plan for this function.
        AsyncStateMachinePlan plan = null;
        foreach (var p in this.stateMachines.AsyncStateMachinePlans)
        {
            if (p.KickoffMethod == function)
            {
                plan = p;
                break;
            }
        }

        if (plan == null)
        {
            return this.ResolveDelegateClrType(fnType);
        }

        var builderInfo = plan.StateMachine.BuilderInfo;
        Type taskClrType;
        if (builderInfo.Kind == AsyncMethodBuilderKind.Void)
        {
            taskClrType = typeof(System.Threading.Tasks.Task);
        }
        else if (builderInfo.TaskProperty != null)
        {
            taskClrType = builderInfo.TaskProperty.PropertyType;
        }
        else
        {
            taskClrType = typeof(System.Threading.Tasks.Task);
        }

        int arity = fnType.ParameterTypes.Length;
        var typeName = "System.Func`" + (arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var openDef = this.emitCtx.References.GetCoreType(typeName);

        var args = new Type[arity + 1];
        for (int i = 0; i < arity; i++)
        {
            args[i] = this.MapToReferenceClrType(fnType.ParameterTypes[i].ClrType);
        }

        args[arity] = this.MapToReferenceClrType(taskClrType);
        return openDef.MakeGenericType(args);
    }

    // Map a host-runtime Type onto the MetadataLoadContext type from the
    // emitter's references when an equivalent exists. Returns the input
    // unchanged when no mapping is found — non-primitive host types whose
    // FullName isn't resolvable will keep their original identity (and may
    // still encode fine via EncodeClrType's primitive matching).
    internal Type MapToReferenceClrType(Type hostType)
    {
        if (hostType == null)
        {
            return null;
        }

        if (this.emitCtx.References.TryResolveType(hostType.FullName ?? hostType.Name, out var mapped))
        {
            return mapped;
        }

        return hostType;
    }

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

    /// <summary>
    /// Issue #985: emit MethodImpl rows for covariant-return interface bridges.
    /// A method whose <see cref="FunctionSymbol.ExplicitInterfaceSlot"/> is set
    /// explicitly implements a specific (typically inherited, non-generic) CLR
    /// interface slot — e.g. the private non-generic
    /// <c>IEnumerable.GetEnumerator()</c> alongside the public generic
    /// <c>IEnumerable&lt;T&gt;.GetEnumerator()</c>. A private bridge method
    /// cannot implicitly implement an interface slot, so the explicit row is
    /// required for the resulting type to load.
    /// </summary>
    /// <param name="structSymbol">The implementing class or struct.</param>
    private void EmitExplicitInterfaceMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Methods.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var method in structSymbol.Methods)
        {
            var slot = method.ExplicitInterfaceSlot;
            if (slot == null)
            {
                continue;
            }

            if (!this.cache.MethodHandles.TryGetValue(method, out var implHandle))
            {
                continue;
            }

            var slotRef = this.GetMethodReference(slot);
            this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotRef);
        }
    }

    /// <summary>
    /// ADR-0089 / issue #755: emit MethodImpl rows binding each declared
    /// static-virtual interface slot to the implementer's matching static
    /// method on <paramref name="structSymbol"/>. Best-effort match — if
    /// the implementer is missing the slot, the binder has already issued
    /// GS0331/GS0332 and we skip silently here.
    /// </summary>
    private void EmitStaticVirtualMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Interfaces.IsDefaultOrEmpty || structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            // Issue #1268: when the implemented interface is a constructed
            // generic (e.g. `TrackNumber : IData[TrackNumber]`), its
            // `StaticMethods` are substituted instances that are NOT keyed in
            // `MethodHandles`; only the open definition's slots are. Resolve
            // each substituted slot back to its open counterpart for the
            // MethodDef lookup, and parent the MethodImpl's declaration at the
            // constructed interface's TypeSpec (a MemberRef) so the runtime can
            // pair the override against `IData`1<TrackNumber>::Method`.
            var isGenericIface = IsUserGenericInterfaceReference(iface);
            foreach (var slot in iface.StaticMethods)
            {
                var openSlot = ResolveOpenInterfaceStaticMethod(iface, slot);
                if (!this.cache.MethodHandles.TryGetValue(openSlot, out var slotDefHandle))
                {
                    continue;
                }

                EntityHandle slotHandle = isGenericIface
                    ? this.ResolveUserInterfaceInstanceMethodToken(iface, openSlot)
                    : slotDefHandle;

                FunctionSymbol implMatch = null;
                foreach (var candidate in structSymbol.GetStaticMethods(slot.Name))
                {
                    if (StaticVirtualSignatureEquals(slot, candidate))
                    {
                        implMatch = candidate;
                        break;
                    }
                }

                if (implMatch == null)
                {
                    continue;
                }

                if (!this.cache.MethodHandles.TryGetValue(implMatch, out var implHandle))
                {
                    continue;
                }

                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotHandle);
            }
        }
    }

    /// <summary>
    /// Issue #1268: maps a (possibly substituted) static-virtual method slot
    /// on a constructed generic interface back to its open declaration on the
    /// interface definition. Returns <paramref name="slot"/> unchanged when the
    /// interface is not a constructed instance, or when no open counterpart is
    /// found.
    /// </summary>
    private static FunctionSymbol ResolveOpenInterfaceStaticMethod(InterfaceSymbol iface, FunctionSymbol slot)
    {
        var def = iface.Definition ?? iface;
        if (ReferenceEquals(def, iface))
        {
            return slot;
        }

        var constructedStatics = iface.StaticMethods;
        var defStatics = def.StaticMethods;
        for (var i = 0; i < constructedStatics.Length; i++)
        {
            if (ReferenceEquals(constructedStatics[i], slot) && i < defStatics.Length)
            {
                return defStatics[i];
            }
        }

        foreach (var m in defStatics)
        {
            if (m.Name == slot.Name && m.Parameters.Length == slot.Parameters.Length)
            {
                return m;
            }
        }

        return slot;
    }

    /// <summary>
    /// ADR-0089 / issue #1019: emit <c>MethodImpl</c> rows pairing the
    /// implementer's static property accessor methods (<c>get_Name</c> /
    /// <c>set_Name</c>) to the matching static-virtual interface property
    /// accessor slots. Mirrors <see cref="EmitStaticVirtualMethodImpls"/> but
    /// resolves accessor MethodDef handles through
    /// <c>PropertyAccessorHandles</c> (static properties are tracked on
    /// <see cref="StructSymbol.StaticProperties"/>, not <c>StaticMethods</c>).
    /// </summary>
    /// <param name="structSymbol">The implementer struct/class.</param>
    private void EmitStaticVirtualPropertyMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Interfaces.IsDefaultOrEmpty || structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var iface in structSymbol.Interfaces)
        {
            // Issue #1268: a constructed generic interface does not surface its
            // declared properties on the constructed instance (only methods are
            // substituted) — walk the open definition's property table so the
            // static-virtual property slots are found, and parent the
            // MethodImpl declaration at the constructed TypeSpec for generic
            // interfaces.
            var defIface = iface.Definition ?? iface;
            if (defIface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            var isGenericIface = IsUserGenericInterfaceReference(iface);
            foreach (var slotProp in defIface.Properties)
            {
                if (!slotProp.IsStatic)
                {
                    continue;
                }

                if (!this.cache.PropertyAccessorHandles.TryGetValue(slotProp, out var slotAccessors))
                {
                    continue;
                }

                PropertySymbol implProp = null;
                foreach (var candidate in structSymbol.StaticProperties)
                {
                    if (candidate.Name == slotProp.Name
                        && (ReferenceEquals(candidate.Type, slotProp.Type) || candidate.Type?.Name == slotProp.Type?.Name))
                    {
                        implProp = candidate;
                        break;
                    }
                }

                if (implProp == null
                    || !this.cache.PropertyAccessorHandles.TryGetValue(implProp, out var implAccessors))
                {
                    continue;
                }

                if (slotProp.HasGetter && slotAccessors.Getter.HasValue && implAccessors.Getter.HasValue)
                {
                    EntityHandle getterDecl = isGenericIface && slotProp.GetterSymbol != null
                        ? this.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.GetterSymbol)
                        : slotAccessors.Getter.Value;
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Getter.Value, getterDecl);
                }

                if (slotProp.HasSetter && slotAccessors.Setter.HasValue && implAccessors.Setter.HasValue)
                {
                    EntityHandle setterDecl = isGenericIface && slotProp.SetterSymbol != null
                        ? this.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.SetterSymbol)
                        : slotAccessors.Setter.Value;
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Setter.Value, setterDecl);
                }
            }
        }
    }

    private static bool StaticVirtualSignatureEquals(FunctionSymbol a, FunctionSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (a.Parameters.Length != b.Parameters.Length)
        {
            return false;
        }

        if (!ReferenceEquals(a.Type, b.Type) && a.Type?.Name != b.Type?.Name)
        {
            return false;
        }

        for (var i = 0; i < a.Parameters.Length; i++)
        {
            var pa = a.Parameters[i].Type;
            var pb = b.Parameters[i].Type;
            if (!ReferenceEquals(pa, pb) && pa?.Name != pb?.Name)
            {
                return false;
            }
        }

        return true;
    }
}
