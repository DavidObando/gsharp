// <copyright file="ReflectionMetadataEmitter.Helpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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

internal sealed partial class ReflectionMetadataEmitter
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
    /// Emits <c>System.Runtime.CompilerServices.NullableContextAttribute(1)</c>
    /// on the assembly so C# consumers see GSharp public surface as non-nullable
    /// (oblivious context = 0, annotated = 1, warnings-only = 2).
    /// </summary>
    private void EmitNullableContextAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        if (!this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.NullableContextAttribute", out var attrType))
        {
            // The attribute may not exist in older TFMs — skip silently.
            return;
        }

        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), p => p.AddParameter().Type().Byte());

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

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
            var freeMethod = marshalType.GetMethod("FreeCoTaskMem", new[] { typeof(IntPtr) })
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

    private static BoundExpression StripConversion(BoundExpression expr)
    {
        while (expr is BoundConversionExpression conv)
        {
            expr = conv.Expression;
        }

        return expr;
    }
}
