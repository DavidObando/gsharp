// <copyright file="FunctionEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'internal' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private helpers they orchestrate)
#pragma warning disable SA1204 // static members should come before non-static (the nullable-context / P/Invoke-import helpers sit next to the emitters that consume them, preserving band order)
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
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-20 (#1361): the function-emission band. Owns every method that renders a
/// <see cref="FunctionSymbol"/> into an ECMA-335 <c>MethodDef</c> (plus its
/// Param / Constant / CustomAttribute / GenericParam / PDB rows): the ordinary
/// managed-body emitter <c>EmitFunction</c> and its method-level
/// <c>NullableContextAttribute</c> compaction (<c>ChooseMethodNullableContext</c>,
/// issue #834); the two interop shapes — the classic <c>@DllImport</c>
/// PinvokeImpl (<c>EmitPInvokeFunction</c>, ADR-0086 / issue #727) and the
/// <c>@LibraryImport</c> managed-stub-plus-blittable-inner pair
/// (<c>EmitLibraryImportFunction</c> / <c>EmitLibraryImportOuterBody</c>,
/// ADR-0092 / issue #758) with their <c>FieldMarshal</c> and import-attribute
/// helpers; the top-level global <c>FieldDef</c> emitter (<c>EmitGlobalFieldDefs</c>,
/// issue #191); and the async state-machine <c>MoveNext</c> body-bytes callback
/// (<c>BuildMoveNextBodyBytes</c>) that <see cref="StateMachineEmitter"/> drives.
/// </summary>
/// <remarks>
/// <para>
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// ConstructorBodyEmitter idiom) because the band drives
/// <see cref="ReflectionMetadataEmitter"/>.<c>MethodBodyEmitSession</c> scaffolds
/// and reaches the extracted collaborators plus a handful of root-owned surfaces
/// that stay put. Direct convenience fields hold the shared
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>,
/// <see cref="GenericRemapState"/>, <see cref="SignatureEncoder"/>,
/// and <see cref="ImportedMemberRefFactory"/> read off the back-reference; the
/// <see cref="WellKnownReferences"/> / <see cref="ClosureEmitter"/> /
/// <see cref="StateMachineEmitter"/> / <see cref="CustomAttributeEncoder"/>
/// peers (constructed later in the EmitCore driver, after this collaborator) are
/// reached through <c>outer</c>. Two helpers
/// stay on the root and are reached through <c>outer</c> because they are shared
/// with the EmitCore driver, not owned by this band:
/// <see cref="ReflectionMetadataEmitter.EncodeAsyncReturnType"/> (also part of
/// the async return-type band, consumed by <see cref="UserTokenResolver"/>) and
/// <see cref="ReflectionMetadataEmitter.EmitExtensionAttribute"/> (also stamped
/// on the <c>&lt;Program&gt;</c> host TypeDef by <c>EmitProgramExtensionMarker</c>).
/// Method bodies are verbatim moves; emitted PEs are byte-identical with the
/// pre-E-20 baseline.
/// </para>
/// </remarks>
internal sealed class FunctionEmitter
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly GenericRemapState remaps;
    private readonly SignatureEncoder signatures;
    private readonly ImportedMemberRefFactory memberRefs;

    public FunctionEmitter(ReflectionMetadataEmitter outer)
    {
        this.outer = outer ?? throw new ArgumentNullException(nameof(outer));
        this.emitCtx = outer.emitCtx;
        this.cache = outer.cache;
        this.remaps = outer.remaps;
        this.signatures = outer.signatures ?? throw new ArgumentNullException(nameof(outer));
        this.memberRefs = outer.memberRefs ?? throw new ArgumentNullException(nameof(outer));
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
    internal void EmitGlobalFieldDefs(ImmutableArray<GlobalVariableSymbol> globals)
    {
        foreach (var g in globals)
        {
            var sigBlob = new BlobBuilder();
            this.signatures.EncodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), g.Type);

            var attrs = AccessibilityMap.MapFieldAccessibility(g.Accessibility) | FieldAttributes.Static;

            var handle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(g.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));

            this.cache.GlobalFieldDefs[g] = handle;

            // Route any @-annotations bound by #187 onto the FieldDef row so
            // attributes like @Obsolete round-trip into CustomAttribute rows.
            this.outer.customAttrEncoder.EmitUserAttributes(handle, g, AttributeTargetKind.Field);
            this.outer.customAttrEncoder.EmitNullableAttributeOnField(handle, g.Type);
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
    internal StateMachineEmitter.MoveNextBodyResult BuildMoveNextBodyBytes(AsyncStateMachinePlan plan)
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
            var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);

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

    internal MethodDefinitionHandle EmitFunction(FunctionSymbol function, BoundBlockStatement body, bool isEntryPoint)
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

        var bodySelection = this.SelectFunctionBody(function, body);
        var bodyEmission = this.EmitFunctionBody(function, bodySelection.Body, bodySelection.AsyncPlan, isEntryPoint);
        var signature = this.EncodeFunctionSignature(function, bodySelection.AsyncPlan, isEntryPoint);
        var methodName = GetMethodMetadataName(function, isEntryPoint);
        var methodAttributes = GetMethodAttributes(function, isEntryPoint);
        var parameterMetadata = this.EmitParameterMetadata(function, bodySelection.AsyncPlan);
        var handle = this.EmitMethodDefinition(
            function,
            methodAttributes,
            methodName,
            signature,
            bodyEmission.BodyOffset,
            parameterMetadata.FirstParameterHandle);

        this.EmitGenericParametersAndConstraints(function, handle);
        this.RecordMethodDebugInfo(function, handle, bodyEmission);
        this.EmitFunctionAttributes(function, handle, parameterMetadata);

        return handle;
    }

    private (BoundBlockStatement Body, AsyncStateMachinePlan AsyncPlan) SelectFunctionBody(
        FunctionSymbol function,
        BoundBlockStatement body)
    {
        if (this.outer.stateMachines.IteratorKickoffBodies.TryGetValue(function, out var iteratorKickoffBody))
        {
            body = iteratorKickoffBody;
        }

        // Async kickoff body: replace the user body with the kickoff stub
        // that creates the state machine, initializes it, and calls Start.
        AsyncStateMachinePlan asyncPlan = null;
        if (function.IsAsync && function.StateMachineType != null)
        {
            foreach (var plan in this.outer.stateMachines.AsyncStateMachinePlans)
            {
                if (plan.KickoffMethod == function)
                {
                    asyncPlan = plan;
                    break;
                }
            }
        }

        return (body, asyncPlan);
    }

    private FunctionBodyEmissionResult EmitFunctionBody(
        FunctionSymbol function,
        BoundBlockStatement body,
        AsyncStateMachinePlan asyncPlan,
        bool isEntryPoint)
    {
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
                bodyOffset = this.outer.stateMachines.EmitAsyncKickoffBody(function, asyncPlan, driveSynchronously);
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var session = new ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il);

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
                    this.outer.stateMachines.AsyncIteratorEmitContexts.TryGetValue(owningSmClass, out aiEmitCtx);
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

                var enclosingClosureInfo = this.outer.closures.ClosureInvokeToInfo.TryGetValue(function, out var ec) ? ec : null;
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

        return new FunctionBodyEmissionResult(
            bodyOffset,
            capturedSequencePoints,
            capturedLocals,
            capturedConstants,
            capturedCodeSize,
            capturedLocalsSignature);
    }

    private BlobBuilder EncodeFunctionSignature(
        FunctionSymbol function,
        AsyncStateMachinePlan asyncPlan,
        bool isEntryPoint)
    {
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
                        this.outer.EncodeAsyncReturnType(r, asyncPlan);
                    }
                    else
                    {
                        if (function.IsInitOnlySetter)
                        {
                            var isExternalInit = this.outer.wellKnown.GetIsExternalInitTypeRef();
                            if (!isExternalInit.IsNil)
                            {
                                r.CustomModifiers().AddModifier(isExternalInit, isOptional: false);
                            }
                        }

                        this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind);
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
                        TypeDefEmitter.EncodeParameterSignature(ps, p, this.signatures.EncodeTypeSymbol, this.outer.wellKnown);
                    }
                });

        return sigBlob;
    }

    private static string GetMethodMetadataName(FunctionSymbol function, bool isEntryPoint)
    {
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

        return methodName;
    }

    private static MethodAttributes GetMethodAttributes(FunctionSymbol function, bool isEntryPoint)
    {
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

        return methodAttrs;
    }

    private FunctionParameterMetadata EmitParameterMetadata(
        FunctionSymbol function,
        AsyncStateMachinePlan asyncPlan)
    {
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
        var firstParamHandle = this.outer.customAttrEncoder.NextParameterHandle();
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
                this.outer.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(paramHandle);
            }

            // ADR-0101 / issue #799: emit [ParamArrayAttribute] on the
            // trailing variadic parameter so C#/F# consumers expand the
            // argument list at the call site exactly as they would for a
            // C# `params T[]` method. The variadic flag is propagated
            // through the ParameterSymbol by DeclarationBinder.
            if (p.IsVariadic)
            {
                this.outer.customAttrEncoder.EmitParamArrayAttributeOnParameter(paramHandle);
            }

            // ADR-0063 §10: emit the Constant row carrying the default value.
            if (p.HasExplicitDefaultValue)
            {
                this.emitCtx.Metadata.AddConstant(paramHandle, p.ExplicitDefaultValue);
            }

            paramHandles.Add((p, paramHandle, paramFlagsList[flagsIndex++]));
        }

        return new FunctionParameterMetadata(
            firstParamHandle,
            returnParamHandle,
            paramHandles,
            returnFlags,
            effectiveDefault,
            contextByteToEmit,
            returnNeedsNullableAttribute);
    }

    private MethodDefinitionHandle EmitMethodDefinition(
        FunctionSymbol function,
        MethodAttributes methodAttributes,
        string methodName,
        BlobBuilder signature,
        int bodyOffset,
        ParameterHandle firstParameterHandle)
    {
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
            attributes: methodAttributes,
            implAttributes: implAttributes,
            name: this.emitCtx.Metadata.GetOrAddString(methodName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset: bodyOffset,
            parameterList: firstParameterHandle);

        return handle;
    }

    private void EmitGenericParametersAndConstraints(
        FunctionSymbol function,
        MethodDefinitionHandle handle)
    {
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
                        PreResolvedConstraintHandle = this.memberRefs.GetElementTypeToken(gpRow.InterfaceConstraintType),
                    };
                }
            }
        }
    }

    private void RecordMethodDebugInfo(
        FunctionSymbol function,
        MethodDefinitionHandle handle,
        FunctionBodyEmissionResult bodyEmission)
    {
        // Phase 4/5 (ADR-0027 §7.7a): hand the body's sequence points and
        // locals to the PDB emitter, keyed by the freshly minted MethodDef row
        // number. Skipped when PDB emit is off (pdb == null) or for the
        // async-kickoff path (the kickoff stub is fully synthesised — visible
        // PDB rows for the user's async body land via EmitStateMachineMoveNext
        // below).
        this.emitCtx.Pdb?.RecordMethod(handle, bodyEmission.SequencePoints, bodyEmission.Locals, bodyEmission.Constants, bodyEmission.CodeSize, bodyEmission.LocalsSignature, function.Declaration?.SyntaxTree);
    }

    private void EmitFunctionAttributes(
        FunctionSymbol function,
        MethodDefinitionHandle handle,
        FunctionParameterMetadata parameterMetadata)
    {
        // Phase 3 of #141: attach user annotations (method target) to the
        // MethodDef. Issue #170: per-parameter annotations attach to each
        // emitted Parameter row. Issue #172: return-target annotations attach
        // to the synthesised sequence-0 Parameter row.
        this.outer.customAttrEncoder.EmitUserAttributes(handle, function, AttributeTargetKind.Method);
        if (parameterMetadata.ReturnParameterHandle is { } retHandle)
        {
            this.outer.customAttrEncoder.EmitUserAttributes(retHandle, function, AttributeTargetKind.Return);
        }

        foreach (var (paramSym, paramHandle, _) in parameterMetadata.ParameterHandles)
        {
            this.outer.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
        }

        // Issue #834: emit [NullableContextAttribute] on the MethodDef when
        // the chosen method-level default differs from the assembly default
        // (1 = NotAnnotated). Then stamp [NullableAttribute] on every Param
        // row whose nullability bytes deviate from that effective default.
        // C# consumers then see `T?` reference parameters / returns as
        // annotated (CS8602 silenced) and non-nullable positions stay
        // implicit. The byte-array form is used only for nested generic
        // inner-position bytes (e.g. `IEnumerable<string?>?`).
        if (parameterMetadata.NullableContextByteToEmit is byte ctxByte)
        {
            this.outer.customAttrEncoder.EmitNullableContextAttributeOnMethod(handle, ctxByte);
        }

        if (parameterMetadata.ReturnParameterHandle is { } returnHandleForNullable && parameterMetadata.ReturnNeedsNullableAttribute)
        {
            this.outer.customAttrEncoder.EmitNullableAttributeOnParameter(returnHandleForNullable, parameterMetadata.ReturnFlags);
        }

        foreach (var (_, paramHandle, paramFlags) in parameterMetadata.ParameterHandles)
        {
            if (paramFlags.IsDefaultOrEmpty)
            {
                continue;
            }

            if (paramFlags.Length == 1 && paramFlags[0] == parameterMetadata.EffectiveNullableDefault)
            {
                continue;
            }

            this.outer.customAttrEncoder.EmitNullableAttributeOnParameter(paramHandle, paramFlags);
        }

        // Issue #792 / ADR-0084. Stamp [ExtensionAttribute] on every G#-
        // authored extension MethodDef so C#/F# call-site lookup picks them
        // up via the standard ECMA-334 §13.6.9 extension-method discovery
        // (which scans for [Extension] static methods on [Extension] static
        // classes). The host TypeDef is stamped in EmitProgramExtensionMarker.
        if (function.IsExtension && !function.IsInstanceMethod)
        {
            this.outer.EmitExtensionAttribute(handle);
        }
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
                r => this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
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
        var firstParamHandle = this.outer.customAttrEncoder.NextParameterHandle();
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
        this.outer.customAttrEncoder.EmitUserAttributesExcept(methodHandle, function, AttributeTargetKind.Method, KnownAttributes.IsDllImport);

        foreach (var (paramSym, paramHandle) in paramHandles)
        {
            this.outer.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
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
                r => this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        var outerVisibility = AccessibilityMap.ToMethodVisibility(function.Accessibility, AccessibilityMap.IsTopLevelProgramMember(function));
        var outerMethodAttrs = outerVisibility | MethodAttributes.HideBySig | MethodAttributes.Static;
        var outerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed;

        // Allocate outer Parameter rows BEFORE the inner ones so they
        // line up with the outer MethodDef row.
        var outerFirstParam = this.outer.customAttrEncoder.NextParameterHandle();
        var outerParamHandles = new List<(ParameterSymbol Symbol, ParameterHandle Handle)>();
        var outerSeq = 1;
        foreach (var p in function.Parameters)
        {
            // ADR-0096 / issue #762: stamp HasFieldMarshal on the outer
            // Param row when the parameter carries an `@MarshalAs(...)`
            // override. The outer stub uses the user-visible managed
            // type (e.g. `int32`) so reflection preserves the source
            // contract. The inner P/Invoke also receives the descriptor
            // below because that is the actual unmanaged transition.
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
        this.outer.customAttrEncoder.EmitUserAttributesExcept(outerMethodHandle, function, AttributeTargetKind.Method, KnownAttributes.IsLibraryImport);

        foreach (var (paramSym, paramHandle) in outerParamHandles)
        {
            this.outer.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param);
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
                        this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind);
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
                            this.signatures.EncodeTypeSymbol(slot, p.Type);
                        }
                    }
                });

        // The inner method is private static, PinvokeImpl, PreserveSig.
        // No body. PinvokeImpl with no managed IL: bodyOffset = -1, IL +
        // Managed + PreserveSig (matching the @DllImport emit shape).
        var innerMethodAttrs = MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.PinvokeImpl;
        var innerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed | MethodImplAttributes.PreserveSig;

        var innerFirstParam = this.outer.customAttrEncoder.NextParameterHandle();
        var innerSeq = 1;
        foreach (var p in function.Parameters)
        {
            var innerParamAttrs = p.MarshalAsMetadata == null
                ? ParameterAttributes.None
                : ParameterAttributes.HasFieldMarshal;
            var innerParamHandle = this.emitCtx.Metadata.AddParameter(
                attributes: innerParamAttrs,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: innerSeq++);
            if (p.MarshalAsMetadata != null)
            {
                EmitFieldMarshalRow(innerParamHandle, p.MarshalAsMetadata);
            }
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
            convertRef = this.memberRefs.GetMethodReference(convertMethod);
            freeRef = this.memberRefs.GetMethodReference(freeMethod);
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
            ptrToStringRef = this.memberRefs.GetMethodReference(ptrToStringMethod);
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
                this.signatures.EncodeLocalVariableType(encoder.AddVariable(), t);
            }

            localsSig = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));
        }

        var offset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSig);
        return (offset, localsSig);
    }

    private readonly record struct FunctionBodyEmissionResult(
        int BodyOffset,
        IReadOnlyList<SequencePoint> SequencePoints,
        IReadOnlyList<LocalInfo> Locals,
        IReadOnlyList<LocalConstantInfo> Constants,
        int CodeSize,
        StandaloneSignatureHandle LocalsSignature);

    private readonly record struct FunctionParameterMetadata(
        ParameterHandle FirstParameterHandle,
        ParameterHandle? ReturnParameterHandle,
        List<(ParameterSymbol Symbol, ParameterHandle Handle, ImmutableArray<byte> NullableFlags)> ParameterHandles,
        ImmutableArray<byte> ReturnFlags,
        byte EffectiveNullableDefault,
        byte? NullableContextByteToEmit,
        bool ReturnNeedsNullableAttribute);
}
