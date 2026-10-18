// <copyright file="FunctionEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.InteropServices

/// PR-E-20 (#1361): the function-emission band. Owns every method that renders a
/// (cref:FunctionSymbol) into an ECMA-335 `MethodDef` (plus its
/// Param / Constant / CustomAttribute / GenericParam / PDB rows): the ordinary
/// managed-body emitter `EmitFunction` and its method-level
/// `NullableContextAttribute` compaction (`MethodNullabilityPlan`,
/// issue #834); the two interop shapes — the classic `@DllImport`
/// PinvokeImpl (`EmitPInvokeFunction`, ADR-0086 / issue #727) and the
/// `@LibraryImport` managed-stub-plus-blittable-inner pair
/// (`EmitLibraryImportFunction` / `EmitLibraryImportOuterBody`,
/// ADR-0092 / issue #758) with their `FieldMarshal` and import-attribute
/// helpers; the top-level global `FieldDef` emitter (`EmitGlobalFieldDefs`,
/// issue #191); and the async state-machine `MoveNext` body-bytes callback
/// (`BuildMoveNextBodyBytes`) that (cref:StateMachineEmitter) drives.
/// @remarks Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// ConstructorBodyEmitter idiom) because the band drives
/// (cref:ReflectionMetadataEmitter).`MethodBodyEmitSession` scaffolds
/// and reaches the extracted collaborators plus a handful of root-owned surfaces
/// that stay put. Direct convenience fields hold the shared
/// (cref:EmitContext), (cref:MetadataTokenCache),
/// (cref:GenericRemapState), (cref:SignatureEncoder),
/// and (cref:ImportedMemberRefFactory) read off the back-reference; the
/// (cref:WellKnownReferences) / (cref:ClosureEmitter) /
/// (cref:StateMachineEmitter) / (cref:CustomAttributeEncoder)
/// peers (constructed later in the EmitCore driver, after this collaborator) are
/// reached through `outer`. Two helpers
/// stay on the root and are reached through `outer` because they are shared
/// with the EmitCore driver, not owned by this band:
/// (cref:ReflectionMetadataEmitter.EncodeAsyncReturnType) (also part of
/// the async return-type band, consumed by (cref:UserTokenResolver)) and
/// (cref:ReflectionMetadataEmitter.EmitExtensionAttribute) (also stamped
/// on the `<Program>` host TypeDef by `EmitProgramExtensionMarker`).
/// Method bodies are verbatim moves; emitted PEs are byte-identical with the
/// pre-E-20 baseline.
internal class FunctionEmitter {
    private let outer ReflectionMetadataEmitter
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let remaps GenericRemapState
    private let signatures SignatureEncoder
    private let memberRefs ImportedMemberRefFactory

    init(outer ReflectionMetadataEmitter) {
        this.outer = outer ?? throw ArgumentNullException("outer")
        this.emitCtx = outer.emitCtx
        this.cache = outer.cache
        this.remaps = outer.remaps
        this.signatures = outer.signatures ?? throw ArgumentNullException("outer")
        this.memberRefs = outer.memberRefs ?? throw ArgumentNullException("outer")
    }

    /// Issue #191: emits one static `FieldDef` per user-declared top-level
    /// `var`/`let`/`const` on the entry-point package's
    /// `<Program>` TypeDef. Runtime initialization of
    /// `var`/`let` stays in the entry-point method body and runs via
    /// `stsfld` as each declaration is reached, preserving existing
    /// side-effect ordering. ECMA constants emit as literal fields carrying
    /// Constant rows; decimal uses initialized static read-only storage. All
    /// package-constant reads are inlined.
    /// @remarks The `InitOnly` flag remains intentionally omitted for
    /// non-constant `let` globals: enforcing it would require moving
    /// initialization into a `.cctor`, which would reorder execution
    /// relative to interleaved top-level statements.
    internal func EmitGlobalFieldDefs(globals ImmutableArray[GlobalVariableSymbol]) {
        for g in globals {
            let sigBlob = BlobBuilder()
            this.signatures.EncodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), g.Type)
            var attrs = AccessibilityMap.MapFieldAccessibility(g.Accessibility) | FieldAttributes.Static
            if g.IsConst {
                attrs |= ConstantFieldMetadataEmitter.GetAttributes(g.ConstantValue)
            }
            let handle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(g.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if g.IsConst {
                ConstantFieldMetadataEmitter.Emit(
                    this.emitCtx,
                    this.memberRefs.GetTypeReference,
                    handle,
                    g.ConstantValue
                )
            }
            this.cache.GlobalFieldDefs[g] = handle
            // Route any @-annotations bound by #187 onto the FieldDef row so
            // attributes like @Obsolete round-trip into CustomAttribute rows.
            this.outer.customAttrEncoder.EmitUserAttributes(handle, g, AttributeTargetKind.Field)
            this.outer.customAttrEncoder.EmitNullableAttributeOnField(handle, g.Type)
        }
    }

    /// raw method-body bytes for an async state-machine MoveNext using the
    /// rewritten bound-tree from (cref:MoveNextBodyRewriter). Returns
    /// `BodyOffset = -1` under (cref:EmitContext.MetadataOnly).
    /// This helper retains the BodyEmitter-driven IL emission so the
    /// still-private BodyEmitter nested class doesn't need a sibling-facing
    /// surface — StateMachineEmitter consumes it via an injected
    /// `Func<AsyncStateMachinePlan, MoveNextBodyResult>` callback.
    /// Scheduled to move with BodyEmitter in PR-E-11 MethodBodyEmitter.
    internal func BuildMoveNextBodyBytes(plan AsyncStateMachinePlan) StateMachineEmitter.MoveNextBodyResult {
        var bodyOffset = -1
        var capturedSequencePoints IReadOnlyList[SequencePoint]? = nil
        var capturedLocals IReadOnlyList[LocalInfo]? = nil
        var capturedConstants IReadOnlyList[LocalConstantInfo]? = nil
        var capturedCodeSize = 0
        var capturedLocalsSignature = default(StandaloneSignatureHandle)
        var capturedAsyncStepping AsyncMethodSteppingInfo? = nil
        if !this.emitCtx.MetadataOnly {
            let moveNextBody = MoveNextBodyRewriter.Build(plan)
            let body = moveNextBody.Body
            let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
            let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
            // Issue #216: collect compile-time const bindings before slot allocation.
            session.CollectConstValues(body)
            session.Plan(body)
            // MoveNext is instance on the SM struct: arg0 = this.
            let parameters = Dictionary[ParameterSymbol, int32]{
                [
                    Invariant.Required(
                        moveNextBody.ThisParameter,
                        "a state-machine method has an instance receiver",
                        expression: "moveNextBody.ThisParameter"
                    )
                ] = 0
            }
            let localsSignature = session.BuildLocalsSignature()
            // Issue #2727: async closure Invoke bodies still need their
            // capture map after they move into the state machine.
            let enclosingClosure = if this
                .outer
                .closures
                .ClosureInvokeToInfo
                .TryGetValue(plan.KickoffMethod, out var closure) {
                closure
            } else {
                default(ClosureEmitter.ClosureInfo?)
            }
            let emitter = session.CreateEmitter(
                parameters,
                structThisParameter: Invariant.Required(
                    moveNextBody.ThisParameter,
                    "a state-machine method has an instance receiver",
                    expression: "moveNextBody.ThisParameter"
                ),
                asyncFieldMap: plan.FieldMap,
                asyncPlan: plan,
                enclosingClosure: enclosingClosure
            )
            try {
                // MoveNextBodyRewriter owns this synthesized epilogue and
                // guarantees that the body already ends in ret.
                emitter.EmitBlock(body)
            } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
                !(ex is OutOfMemoryException) &&
                !(ex is StackOverflowException) {
                let anchor = emitter.CurrentAnchor ?? plan.KickoffMethod?.Declaration ?? body.Syntax
                EmitDiagnosticException.Wrap(anchor, ex)
            }
            bodyOffset = this
                .emitCtx
                .MethodBodyStream
                .AddMethodBody(
                il,
                maxStack: MaxStackTracker.ComputeMaxStack(il),
                localVariablesSignature: localsSignature
            )
            capturedSequencePoints = emitter.SequencePoints
            capturedLocals = MethodBodyPlanner.CollectLocalInfo(session.Locals)
            capturedConstants = MethodBodyPlanner.CollectLocalConstantInfo(session.ConstValues)
            capturedCodeSize = il.Offset
            capturedLocalsSignature = localsSignature
            capturedAsyncStepping = emitter.AsyncStepping
        }
        return StateMachineEmitter.MoveNextBodyResult(
            bodyOffset,
            capturedSequencePoints,
            capturedLocals,
            capturedConstants,
            capturedCodeSize,
            capturedLocalsSignature,
            capturedAsyncStepping
        )
    }

    internal func EmitFunction(
        function FunctionSymbol,
        body BoundBlockStatement,
        isEntryPoint bool,
        isSynthesizedEntryPointStub bool = false,
        isInterfaceImplementation bool = false
    ) MethodDefinitionHandle {
        // ADR-0086 / issue #727 + ADR-0092 / issue #758: P/Invoke functions
        // skip body emission. Classic @DllImport functions route through the
        // ImplMap / ModuleRef path; @LibraryImport functions route through
        // the explicit-stub path that emits a managed marshalling wrapper
        // plus a hidden blittable inner P/Invoke.
        if function.IsPInvoke {
            if Invariant.Required(
                function.PInvokeMetadata,
                "a P/Invoke function has P/Invoke metadata",
                expression: "function.PInvokeMetadata"
            )
                .IsLibraryImport {
                return this.EmitLibraryImportFunction(function)
            }
            return this.EmitPInvokeFunction(function)
        }
        let bodySelection = this.SelectFunctionBody(function, body)
        let bodyEmission = this.EmitFunctionBody(function, bodySelection.Body, bodySelection.AsyncPlan, isEntryPoint)
        let signature = this.EncodeFunctionSignature(function, bodySelection.AsyncPlan, isEntryPoint)
        let methodName = GetMethodMetadataName(function, isEntryPoint, isSynthesizedEntryPointStub)
        let methodAttributes = GetMethodAttributes(
            function,
            isEntryPoint,
            isSynthesizedEntryPointStub,
            isInterfaceImplementation || this.emitCtx.InheritedInterfaceMethods.Contains(function)
        )
        let parameterMetadata = this.EmitParameterMetadata(function, bodySelection.AsyncPlan, isEntryPoint)
        let handle = this.EmitMethodDefinition(
            function,
            methodAttributes,
            methodName,
            signature,
            bodyEmission.BodyOffset,
            parameterMetadata.FirstParameterHandle
        )
        this.EmitGenericParametersAndConstraints(function, handle)
        this.RecordMethodDebugInfo(function, handle, bodyEmission)
        this.EmitFunctionAttributes(function, handle, parameterMetadata)
        return handle
    }

    private func SelectFunctionBody(function FunctionSymbol, body BoundBlockStatement)(
        Body BoundBlockStatement,
        AsyncPlan AsyncStateMachinePlan?
    ) {
        var body = body
        if this.outer.stateMachines.IteratorKickoffBodies.TryGetValue(function, out var iteratorKickoffBody) {
            body = iteratorKickoffBody
        }
        // Async kickoff body: replace the user body with the kickoff stub
        // that creates the state machine, initializes it, and calls Start.
        var asyncPlan AsyncStateMachinePlan? = nil
        if function.IsAsyncOrSuspending && function.StateMachineType != nil {
            for plan in this.outer.stateMachines.AsyncStateMachinePlans {
                if plan.KickoffMethod == function {
                    asyncPlan = plan
                    break
                }
            }
        }
        return (body, asyncPlan)
    }

    private func EmitFunctionBody(
        function FunctionSymbol,
        body BoundBlockStatement,
        asyncPlan AsyncStateMachinePlan?,
        isEntryPoint bool
    ) FunctionBodyEmissionResult {
        // Phase 4 emit parity (F1): generic functions are emitted with a
        // type-erased signature — each open type parameter is encoded as
        // System.Object via EncodeTypeSymbol. Call sites insert the box /
        // unbox.any around the boundary. This matches the interpreter's
        // type-erased semantics. ADR-0004 still calls for CLR reified
        // generics as the long-term goal; F2 will widen to GenericParam +
        // MVAR/VAR encoding and add a MethodSpec at call sites.
        var bodyOffset = -1
        var capturedSequencePoints IReadOnlyList[SequencePoint]? = nil
        var capturedLocals IReadOnlyList[LocalInfo]? = nil
        var capturedConstants IReadOnlyList[LocalConstantInfo]? = nil
        var capturedCodeSize = 0
        var capturedLocalsSignature = default(StandaloneSignatureHandle)
        // Issue #987: an abstract method (a no-body `open func F() R;`) has no
        // IL body — leave bodyOffset at -1 so AddMethodDefinition writes an
        // abstract virtual slot. The MethodAttributes.Abstract bit is OR'd in
        // below alongside Virtual/NewSlot.
        if !this.emitCtx.MetadataOnly && !function.IsAbstract {
            if asyncPlan != nil {
                // Issue #1904: an async entry point (`async func Main()` /
                // top-level `await`) must expose a CLR-valid void/int32
                // signature — never Task/Task<T> (the runtime throws
                // MethodAccessException at process start otherwise). Drive
                // the task to completion synchronously right inside the
                // kickoff body instead of returning it.
                let driveSynchronously = isEntryPoint && asyncPlan.StateMachine.BuilderInfo.TaskProperty != nil
                bodyOffset = this.outer.stateMachines.EmitAsyncKickoffBody(function, asyncPlan, driveSynchronously)
            } else {
                let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
                let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
                // Issue #216: collect compile-time const bindings before slot allocation.
                session.CollectConstValues(body)
                session.Plan(body, function)
                // For instance methods, IL slot 0 is the implicit `this`, so user
                // parameters shift up by one. Both the synthesized `ThisParameter`
                // (slot 0) and the user parameters are registered so emit sites
                // can resolve either.
                let parameters = Dictionary[ParameterSymbol, int32]()
                let paramSlotShift = if function.IsInstanceMethod {
                    1
                } else {
                    0
                }
                if function.IsInstanceMethod {
                    parameters[
                        Invariant.Required(
                            function.ThisParameter,
                            "an instance function has an instance receiver",
                            expression: "function.ThisParameter"
                        )
                    ] = 0
                }
                var emittedParameterIndex = 0
                let emittedParameters = function.EmittedParameters
                for var i = 0; i < emittedParameters.Length; i++ {
                    if object.ReferenceEquals(emittedParameters[i], function.ThisParameter) {
                        continue
                    }
                    parameters[emittedParameters[i]] = emittedParameterIndex + paramSlotShift
                    emittedParameterIndex++
                }
                let localsSignature = session.BuildLocalsSignature()
                // Detect iterator MoveNext and thread emit context.
                var iteratorEmitCtx StateMachineEmitter.IteratorEmitContext? = nil
                if function.Name == "MoveNext" && function.ReceiverType is StructSymbol owningSmClass {
                    this.outer.stateMachines.IteratorEmitContexts.TryGetValue(owningSmClass, out iteratorEmitCtx)
                }
                // For struct instance methods, pass structThisParameter so the
                // BodyEmitter knows arg0 is already a managed pointer (ref T) and
                // emits ldarg.0 instead of ldarga.0 when accessing fields via this.
                var structThis ParameterSymbol? = nil
                if function.IsInstanceMethod &&
                    function.ReceiverType is StructSymbol recvStruct &&
                    !recvStruct
                    .IsClass {
                    structThis = Invariant.Required(
                        function.ThisParameter,
                        "a struct instance method has an instance receiver",
                        expression: "function.ThisParameter"
                    )
                }
                let enclosingClosureInfo = if this
                    .outer
                    .closures
                    .ClosureInvokeToInfo
                    .TryGetValue(function, out var ec) {
                    ec
                } else {
                    default(ClosureEmitter.ClosureInfo?)
                }
                let emitter = session.CreateEmitter(
                    parameters,
                    structThisParameter: structThis,
                    iteratorEmitCtx: iteratorEmitCtx,
                    enclosingClosure: enclosingClosureInfo
                )
                // 6.2 SilentEmitFailure invariant: wrap the per-function
                // EmitBlock in a try/catch so any exception that escapes the
                // body emitter is re-thrown as EmitDiagnosticException anchored
                // at the last-visited BoundNode (or the function's syntax).
                try {
                    emitter.EmitMethodBody(body, alwaysAppendRet: function.Type == TypeSymbol.Void)
                } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
                    !(ex is OutOfMemoryException) &&
                    !(ex is StackOverflowException) {
                    let anchor = emitter.CurrentAnchor ?? function.Declaration ?? body.Syntax
                    EmitDiagnosticException.Wrap(anchor, ex)
                }
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(
                    il,
                    maxStack: MaxStackTracker.ComputeMaxStack(il),
                    localVariablesSignature: localsSignature
                )
                capturedSequencePoints = emitter.SequencePoints
                capturedLocals = MethodBodyPlanner.CollectLocalInfo(session.Locals)
                capturedConstants = MethodBodyPlanner.CollectLocalConstantInfo(session.ConstValues)
                capturedCodeSize = il.Offset
                capturedLocalsSignature = localsSignature
            } // end else (non-async path)

        }
        return FunctionBodyEmissionResult(
            bodyOffset,
            capturedSequencePoints,
            capturedLocals,
            capturedConstants,
            capturedCodeSize,
            capturedLocalsSignature
        )
    }

    private func EncodeFunctionSignature(
        function FunctionSymbol,
        asyncPlan AsyncStateMachinePlan?,
        isEntryPoint bool
    ) BlobBuilder {
        let sigBlob = BlobBuilder()
        let emitsExplicitReceiver = function.IsExtension && !function.IsInstanceMethod
        let signatureParameterCount = function
            .EmittedParameters
            .Length - (
            if function.ExplicitReceiverParameter != nil && !emitsExplicitReceiver {
                1
            } else {
                0
            }
        )
        BlobEncoder(sigBlob).MethodSignature(
            isInstanceMethod: function.IsInstanceMethod,
            genericParameterCount: if function.TypeParameters.IsDefaultOrEmpty {
                0
            } else {
                function.TypeParameters.Length
            }
        )
            .Parameters(
            signatureParameterCount,
            (r ReturnTypeEncoder) -> {
                // Issue #1904: an async entry point signature must be
                // void/int32/uint32 (function.Type), not the async
                // builder's Task/Task<T> — the kickoff body above already
                // blocks on the task and unwraps the result to match.
                if asyncPlan != nil && !(isEntryPoint && asyncPlan.StateMachine.BuilderInfo.TaskProperty != nil) {
                    this.outer.EncodeAsyncReturnType(r, asyncPlan)
                } else {
                    if function.IsInitOnlySetter {
                        let isExternalInit = this.outer.wellKnown.GetIsExternalInitTypeRef()
                        if !isExternalInit.IsNil {
                            r.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
                        }
                    }
                    this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind)
                }
            },
            (ps ParametersEncoder) -> {
                for p in function.EmittedParameters {
                    if object.ReferenceEquals(p, function.ThisParameter) && !emitsExplicitReceiver {
                        continue
                    }
                    // ADR-0060: encode ref-kind parameters as `T&` (managed pointer).
                    // The pointee type is encoded via the inner Type() encoder. For `in`,
                    // emit a modreq(System.Runtime.CompilerServices.IsReadOnlyAttribute) on
                    // the parameter signature so consumers (e.g. C#) treat the call site as
                    // readonly. ParameterAttributes (Out / In) are stamped on the per-parameter
                    // metadata row below. Issue #1610: this encoding is shared with the
                    // interface abstract / static-virtual slot paths so the interface
                    // signature and its implementation can never drift apart.
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

    private func EmitParameterMetadata(
        function FunctionSymbol,
        asyncPlan AsyncStateMachinePlan?,
        isEntryPoint bool
    ) FunctionParameterMetadata {
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
        let firstParamHandle = this.outer.customAttrEncoder.NextParameterHandle()
        // Compute nullable flags for return + each non-`this` parameter. An
        // async kickoff's emitted return is the builder's task type, not
        // `function.Type`, so its flags describe that physical shape. They
        // used to be left EMPTY, on the
        // reasoning that a non-null `Task<T>` matches the assembly-level
        // NullableContextAttribute(1) default. That holds only while the
        // METHOD context stays 1: MethodNullabilityPlan picks the
        // majority byte across return and parameters, so a method with more
        // nilable parameters than non-null ones got [NullableContext(2)], and
        // the omitted return then re-imported as `Task[T]?` (issue #4287, found
        // when gsc started rejecting calls on a `T?` receiver:
        // `await service.RunAsync(opts, ct).ConfigureAwait(false)` across a
        // G# assembly boundary).
        //
        // An async ENTRY POINT is the exception: EncodeFunctionSignature emits
        // `function.Type` (void / int32 / uint32) for it, not the task (issue
        // #1904: the kickoff blocks on the task and unwraps the result), so its
        // flags are those of `function.Type`, exactly like a non-async method.
        let drivenSynchronously = isEntryPoint && asyncPlan?.StateMachine.BuilderInfo.TaskProperty != nil
        // Issue #4988: the parameters that get Param rows below — every
        // emitted parameter except the implicit receiver — are exactly the
        // positions the plan covers, so plan and rows cannot drift apart.
        let rowParameters = function
            .EmittedParameters
            .Where((p ParameterSymbol) -> !object.ReferenceEquals(p, function.ThisParameter))
            .ToImmutableArray()
        // Pick a method-level NullableContextAttribute the way Roslyn does
        // (see MethodNullabilityPlan): the most compact metadata shape C#
        // emits for the same source.
        let nullability = if asyncPlan == nil || drivenSynchronously {
            MethodNullabilityPlan.ForParameters(function.Type, rowParameters)
        } else {
            MethodNullabilityPlan.ForParameters(this.AsyncKickoffReturnFlags(asyncPlan), rowParameters)
        }
        // ADR-0172 Phase B: a tuple-typed return with declared element names
        // also needs the sequence-0 Param row to carry
        // [TupleElementNamesAttribute]. The flattened array for an async
        // kickoff's `Task<(a, b)>` equals the tuple's own array (only tuples
        // contribute entries; wrappers are traversed transparently), so
        // `function.Type` is the right input in both cases.
        var returnParamHandle ParameterHandle? = nil
        if ParameterMetadataEmitter.NeedsReturnParameter(nullability, function.Type, function.ReturnRefKind, function) {
            let returnRow = ParameterMetadataEmitter.AddReturnParameter(this.emitCtx)
            returnParamHandle = returnRow
            if function.ReturnRefKind == RefKind.RefReadOnly {
                this.outer.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(returnRow)
            }
        }
        let paramHandles = List[(Symbol ParameterSymbol, Handle ParameterHandle)]()
        var sequenceNumber = 1
        for p in rowParameters {
            // ADR-0060 §6: stamp the per-parameter row with ParameterAttributes.Out for
            // `out`, .In for `in`. `ref` carries neither (the CLR distinguishes ref from
            // out only via the .out flag); the `in` parameter also gets an
            // IsReadOnlyAttribute custom attribute below.
            let paramHandle = ParameterMetadataEmitter.AddParameter(this.emitCtx, p, sequenceNumber++)
            if p.RefKind == RefKind.In {
                this.outer.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(paramHandle)
            }
            // ADR-0101 / issue #799: emit [ParamArrayAttribute] on a
            // trailing array-carrier variadic parameter so C#/F# consumers
            // expand the argument list at the call site exactly as they
            // would for a C# `params T[]` method. ADR-0173 / issue #3627: a
            // non-array collection carrier (`...List[T]`,
            // `...ReadOnlySpan[T]`, …) instead stamps C#13's
            // [ParamCollectionAttribute], matching `params X<T>`.
            if p.IsVariadic {
                if VariadicCarriers.GetCarrierKind(p.Type) == VariadicCarriers.CarrierKind.Array {
                    this.outer.customAttrEncoder.EmitParamArrayAttributeOnParameter(paramHandle)
                } else {
                    this.outer.customAttrEncoder.EmitParamCollectionAttributeOnParameter(paramHandle)
                }
            }
            paramHandles.Add((p, paramHandle))
        }
        return FunctionParameterMetadata(firstParamHandle, returnParamHandle, paramHandles, nullability)
    }

    private func EmitMethodDefinition(
        function FunctionSymbol,
        methodAttributes MethodAttributes,
        methodName string,
        signature BlobBuilder,
        bodyOffset int32,
        firstParameterHandle ParameterHandle
    ) MethodDefinitionHandle {
        // ADR-0084 §L5 / issue #806: honour `@MethodImpl(MethodImplOptions.…)`
        // as a pseudo-custom attribute. The recognised
        // MethodImplOptions bits OR into the MethodImpl field of the
        // emitted MethodDef so reflection (GetMethodImplementationFlags)
        // sees AggressiveInlining / NoInlining / Synchronized / etc.
        // without a parallel CustomAttribute row. The attribute itself is
        // elided from EmitUserAttributes via KnownAttributes.IsPseudoCustomAttribute.
        var implAttributes = MethodImplAttributes.IL | MethodImplAttributes.Managed
        let methodImpl BoundAttribute? = KnownAttributes.FindMethodImpl(function.Attributes)
        if methodImpl != nil {
            let opts = KnownAttributes.GetMethodImplOptions(methodImpl)
            // MethodImplOptions bit positions match MethodImplAttributes
            // bit positions exactly (ECMA-335 II.23.1.11), so a direct
            // OR onto the IL|Managed default lands on the correct slot.
            implAttributes |= MethodImplAttributes(int32(opts))
        }
        let handle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttributes,
            implAttributes: implAttributes,
            name: this.emitCtx.Metadata.GetOrAddString(methodName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset: bodyOffset,
            parameterList: firstParameterHandle
        )
        return handle
    }

    private func EmitGenericParametersAndConstraints(function FunctionSymbol, handle MethodDefinitionHandle) {
        // ADR-0087 §3 R1: emit GenericParam rows for a user-declared generic
        // method immediately after AddMethodDefinition. The signature's
        // genericParameterCount above and these rows together make the method
        // a proper CLR generic method definition.
        let gpRowStart = this.emitCtx.PendingGenericParameters.Count
        TypeDefEmitter.EmitGenericParamRows(this.emitCtx, handle, function.TypeParameters)
        // Issue #2118: a generic-promoted non-capturing lambda's type-parameter
        // constraints textually reference the *enclosing* type parameters they
        // were cloned from (the interface-constraint symbol is cached and does
        // not carry the clone). Their deferred GenericParamConstraint rows would
        // otherwise be resolved at flush time — after this method's remap is
        // gone — encoding the enclosing Var/MVar slot instead of this method's
        // own MVar. Resolve them now, while the remap is active, so the
        // constraint encodes `!!idx` for both class- and method-parameter roots.
        if this.remaps.ActiveLambdaMethodTypeParamRemap != nil {
            let pendingRows = this.emitCtx.PendingGenericParameters
            for var gi = gpRowStart; gi < pendingRows.Count; gi++ {
                let gpRow = pendingRows[gi]
                if gpRow.InterfaceConstraintType != nil {
                    pendingRows[gi] = gpRow with{
                        PreResolvedConstraintHandle = this.memberRefs.GetElementTypeToken(gpRow.InterfaceConstraintType)
                    }
                }
            }
        }
    }

    private func RecordMethodDebugInfo(
        function FunctionSymbol,
        handle MethodDefinitionHandle,
        bodyEmission FunctionBodyEmissionResult
    ) {
        // Phase 4/5 (ADR-0027 §7.7a): hand the body's sequence points and
        // locals to the PDB emitter, keyed by the freshly minted MethodDef row
        // number. Skipped when PDB emit is off (pdb == null) or for the
        // async-kickoff path (the kickoff stub is fully synthesised — visible
        // PDB rows for the user's async body land via EmitStateMachineMoveNext
        // below).
        this
            .emitCtx
            .Pdb
            ?.RecordMethod(
            handle,
            bodyEmission.SequencePoints,
            bodyEmission.Locals,
            bodyEmission.Constants,
            bodyEmission.CodeSize,
            bodyEmission.LocalsSignature,
            function.Declaration?.SyntaxTree
        )
    }

    private func EmitFunctionAttributes(
        function FunctionSymbol,
        handle MethodDefinitionHandle,
        parameterMetadata FunctionParameterMetadata
    ) {
        // Phase 3 of #141: attach user annotations (method target) to the
        // MethodDef. Issue #170: per-parameter annotations attach to each
        // emitted Parameter row. Issue #172: return-target annotations attach
        // to the synthesised sequence-0 Parameter row.
        this.outer.customAttrEncoder.EmitUserAttributes(handle, function, AttributeTargetKind.Method)
        if parameterMetadata.ReturnParameterHandle is {} retHandle {
            this.outer.customAttrEncoder.EmitUserAttributes(retHandle, function, AttributeTargetKind.Return)
        }
        for (paramSym, paramHandle) in parameterMetadata.ParameterHandles {
            this.outer.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param)
        }
        // Issue #834 / #4988: [NullableContextAttribute] on the MethodDef when
        // the chosen method-level default differs from the type's, then
        // [NullableAttribute] on every Param row whose bytes deviate from it.
        let parameterRows = ImmutableArray.CreateBuilder[ParameterHandle](parameterMetadata.ParameterHandles.Count)
        for (_, paramHandle) in parameterMetadata.ParameterHandles {
            parameterRows.Add(paramHandle)
        }
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(
            handle,
            parameterMetadata.Nullability,
            parameterMetadata.ReturnParameterHandle,
            parameterRows.MoveToImmutable()
        )
        // ADR-0172 Phase B: stamp [TupleElementNamesAttribute] on the return
        // row and on every parameter whose declared type carries tuple
        // element names, so C# consumers (and re-imports) see `r.line`.
        if parameterMetadata.ReturnParameterHandle is {} returnHandleForTupleNames {
            this.outer.customAttrEncoder.EmitTupleElementNamesAttribute(returnHandleForTupleNames, function.Type)
        }
        for (paramSym, paramHandle) in parameterMetadata.ParameterHandles {
            this.outer.customAttrEncoder.EmitTupleElementNamesAttribute(paramHandle, paramSym.Type)
        }
        // Issue #792 / ADR-0084. Stamp [ExtensionAttribute] on every G#-
        // authored extension MethodDef so C#/F# call-site lookup picks them
        // up via the standard ECMA-334 §13.6.9 extension-method discovery
        // (which scans for [Extension] static methods on [Extension] static
        // classes). The host TypeDef is stamped in EmitProgramExtensionMarker.
        if function.IsExtension && !function.IsInstanceMethod {
            this.outer.EmitExtensionAttribute(handle)
        }
        // ADR-0174 D4: a suspending function is labelled so a G# caller in
        // another assembly reads the logical return type and awaits implicitly.
        if function.IsSuspending {
            this.outer.EmitSuspendingAttribute(handle)
        }
    }

    /// Issue #4465: builds nullable flags from the same physical return symbol
    /// used by signature emission, so Task/ValueTask envelopes and their
    /// logical results cannot drift.
    /// @param asyncPlan Its state-machine plan.
    /// @returns The return position's flags.
    private func AsyncKickoffReturnFlags(asyncPlan AsyncStateMachinePlan) ImmutableArray[uint8] -> this
        .outer
        .GetAsyncReturnNullableFlags(asyncPlan)

    /// Emits a P/Invoke (`@DllImport`) function as a PinvokeImpl MethodDef
    /// with an associated ImplMap row pointing at a ModuleRef
    /// (ADR-0086 / issue #727). The function carries no managed body —
    /// `bodyOffset` is -1 and (cref:MethodImplAttributes.PreserveSig)
    /// is set so the runtime knows to leave the return value untouched.
    /// @param function The P/Invoke function symbol.
    /// @returns The handle of the emitted MethodDef.
    private func EmitPInvokeFunction(function FunctionSymbol) MethodDefinitionHandle {
        let pInvoke = Invariant.Required(
            function.PInvokeMetadata,
            "a P/Invoke function has P/Invoke metadata",
            expression: "function.PInvokeMetadata"
        )
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            function.Parameters.Length,
            (r ReturnTypeEncoder) -> this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
            (ps ParametersEncoder) -> {
                for p in function.Parameters {
                    this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type)
                }
            }
        )
        // ADR-0086 §6: PinvokeImpl + Static + visibility. PreserveSig
        // mirrors the ImplMap; we set MethodImplAttributes.PreserveSig when
        // the metadata says so (default true) so the CLR does not synthesise
        // an HRESULT-to-exception translation.
        let visibility = AccessibilityMap.ToMethodVisibility(
            function.Accessibility,
            AccessibilityMap.IsTopLevelProgramMember(function)
        )
        let methodAttrs = visibility | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.PinvokeImpl
        var implAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed
        if pInvoke.PreserveSig {
            implAttrs |= MethodImplAttributes.PreserveSig
        }
        // Allocate Parameter rows so each source parameter shows up in
        // metadata. Matches the regular EmitFunction path, including the
        // nullability plan (issue #4988).
        let firstParamHandle = this.outer.customAttrEncoder.NextParameterHandle()
        let nullability = MethodNullabilityPlan.ForParameters(function.Type, function.Parameters)
        let returnRow ParameterHandle? = if nullability.ReturnNeedsAttribute {
            ParameterMetadataEmitter.AddReturnParameter(this.emitCtx)
        } else {
            nil
        }
        let paramHandles = List[(Symbol ParameterSymbol, Handle ParameterHandle)]()
        let parameterRows = ImmutableArray.CreateBuilder[ParameterHandle](function.Parameters.Length)
        var sequenceNumber = 1
        for p in function.Parameters {
            // ADR-0096 / issue #762: stamp HasFieldMarshal when the
            // parameter carries a resolved `@MarshalAs(...)` override.
            // The FieldMarshal table row is added immediately below
            // and is keyed off the Parameter handle.
            var paramAttrs = ParameterAttributes.None
            if p.MarshalAsMetadata != nil {
                paramAttrs |= ParameterAttributes.HasFieldMarshal
            }
            let paramHandle = ParameterMetadataEmitter.AddParameter(this.emitCtx, p, sequenceNumber++, paramAttrs)
            paramHandles.Add((p, paramHandle))
            parameterRows.Add(paramHandle)
            if p.MarshalAsMetadata != nil {
                EmitFieldMarshalRow(paramHandle, p.MarshalAsMetadata!!)
            }
        }
        let methodHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: implAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(function.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: -1,
            parameterList: firstParamHandle
        )
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(methodHandle, nullability, returnRow, parameterRows.MoveToImmutable())
        // ModuleRef (deduplicated by library name).
        if !this.cache.PInvokeModuleRefs.TryGetValue(pInvoke.LibraryName, out var moduleRef) {
            moduleRef = this
                .emitCtx
                .Metadata
                .AddModuleReference(this.emitCtx.Metadata.GetOrAddString(pInvoke.LibraryName))
            this.cache.PInvokeModuleRefs[pInvoke.LibraryName] = moduleRef
        }
        let importAttrs = MapPInvokeImportAttributes(pInvoke)
        this
            .emitCtx
            .Metadata
            .AddMethodImport(
            methodHandle,
            importAttrs,
            this.emitCtx.Metadata.GetOrAddString(pInvoke.EntryPoint ?? function.Name),
            moduleRef
        )
        // Attach user-written method-target attributes (other than the
        // @DllImport itself, which is fully consumed by the ImplMap row —
        // duplicating it as a CustomAttribute would create a misleading
        // reflection view; this mirrors C#'s behavior).
        this
            .outer
            .customAttrEncoder
            .EmitUserAttributesExcept(methodHandle, function, AttributeTargetKind.Method, KnownAttributes.IsDllImport)
        for (paramSym, paramHandle) in paramHandles {
            this.outer.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param)
        }
        return methodHandle
    }

    /// ADR-0096 / issue #762: writes a CLR `FieldMarshal` table
    /// row keyed off [`paramHandle`](paramref) carrying the
    /// per-parameter marshalling descriptor blob encoded per ECMA-335
    /// II.23.4. The corresponding (cref:ParameterAttributes.HasFieldMarshal)
    /// bit must be set on the Param row by the caller (the runtime uses
    /// the bit to decide whether to read this table).
    /// @param paramHandle The owning Parameter row handle.
    /// @param metadata The resolved per-parameter `@MarshalAs` metadata.
    private func EmitFieldMarshalRow(paramHandle ParameterHandle, metadata MarshalAsMetadata) {
        let blobBuilder = BlobBuilder()
        blobBuilder.WriteBytes(metadata.EncodeFieldMarshalBlob())
        this.emitCtx.Metadata.AddMarshallingDescriptor(paramHandle, this.emitCtx.Metadata.GetOrAddBlob(blobBuilder))
    }

    /// ADR-0092 / issue #758: emits an `@LibraryImport` function as a
    /// pair of MethodDef rows — the user-visible managed stub (planned at
    /// `cache.FunctionHandles[function]`) and a hidden blittable inner
    /// P/Invoke (planned at `cache.LibraryImportInnerHandles[function]`).
    /// The stub:
    /// - For each `string` parameter, marshals it explicitly into a CoTaskMem buffer (UTF-8 or UTF-16 per
    /// the resolved (cref:System.Runtime.InteropServices.StringMarshalling) mode) and stores the resulting
    /// `IntPtr` in a local.
    /// - Calls the inner P/Invoke inside a `try` block, passing the marshalled `IntPtr` in place of each
    /// `string` parameter.
    /// - Frees the marshalled buffers in a `finally` block via (cref:Marshal.FreeCoTaskMem(IntPtr)), which
    /// is a no-op on (cref:IntPtr.Zero).
    /// - When the function returns `string`, the inner P/Invoke returns the raw native pointer (encoded as
    /// `IntPtr`) and the outer stub materializes the managed string via
    /// (cref:Marshal.PtrToStringUTF8(IntPtr)) / (cref:Marshal.PtrToStringUni(IntPtr)). The returned native
    /// buffer is non-owning (the native side owns it, e.g. `getenv`) and is never freed — see the ADR-0092
    /// return-marshalling table.
    /// The result is verifiable IL that has no runtime marshalling stub —
    /// every transition is explicit and AOT-publishable.
    /// @param function The `@LibraryImport` function symbol.
    /// @returns The handle of the emitted outer managed stub.
    private func EmitLibraryImportFunction(function FunctionSymbol) MethodDefinitionHandle {
        let pInvoke = Invariant.Required(
            function.PInvokeMetadata,
            "a LibraryImport function has P/Invoke metadata",
            expression: "function.PInvokeMetadata"
        )
        // Plan which parameters need string marshalling. Indices are into
        // the function's parameter list.
        let stringParamIndices = List[int32]()
        for var i = 0; i < function.Parameters.Length; i++ {
            if function.Parameters[i].Type == TypeSymbol.String {
                stringParamIndices.Add(i)
            }
        }
        let innerMethodRef = this.cache.LibraryImportInnerHandles[function]
        // === Outer managed stub ===
        let outerSigBlob = BlobBuilder()
        BlobEncoder(outerSigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            function.Parameters.Length,
            (r ReturnTypeEncoder) -> this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind),
            (ps ParametersEncoder) -> {
                for p in function.Parameters {
                    this.signatures.EncodeTypeSymbol(ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None), p.Type)
                }
            }
        )
        let outerVisibility = AccessibilityMap.ToMethodVisibility(
            function.Accessibility,
            AccessibilityMap.IsTopLevelProgramMember(function)
        )
        let outerMethodAttrs = outerVisibility | MethodAttributes.HideBySig | MethodAttributes.Static
        let outerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed
        // Allocate outer Parameter rows BEFORE the inner ones so they
        // line up with the outer MethodDef row.
        let outerFirstParam = this.outer.customAttrEncoder.NextParameterHandle()
        // Issue #4988: the user-visible stub carries the declared signature's
        // nullability; the hidden blittable inner P/Invoke below is private.
        let outerNullability = MethodNullabilityPlan.ForParameters(function.Type, function.Parameters)
        let outerReturnRow ParameterHandle? = if outerNullability.ReturnNeedsAttribute {
            ParameterMetadataEmitter.AddReturnParameter(this.emitCtx)
        } else {
            nil
        }
        let outerParamHandles = List[(Symbol ParameterSymbol, Handle ParameterHandle)]()
        let outerParameterRows = ImmutableArray.CreateBuilder[ParameterHandle](function.Parameters.Length)
        var outerSeq = 1
        for p in function.Parameters {
            // ADR-0096 / issue #762: stamp HasFieldMarshal on the outer
            // Param row when the parameter carries an `@MarshalAs(...)`
            // override. The outer stub uses the user-visible managed
            // type (e.g. `int32`) so reflection preserves the source
            // contract. The inner P/Invoke also receives the descriptor
            // below because that is the actual unmanaged transition.
            var outerParamAttrs = ParameterAttributes.None
            if p.MarshalAsMetadata != nil {
                outerParamAttrs |= ParameterAttributes.HasFieldMarshal
            }
            let paramHandle = ParameterMetadataEmitter.AddParameter(this.emitCtx, p, outerSeq++, outerParamAttrs)
            outerParamHandles.Add((p, paramHandle))
            outerParameterRows.Add(paramHandle)
            if p.MarshalAsMetadata != nil {
                EmitFieldMarshalRow(paramHandle, p.MarshalAsMetadata!!)
            }
        }
        // Build the IL body of the outer stub.
        let (outerBodyOffset, outerLocalsSig) = EmitLibraryImportOuterBody(function, stringParamIndices, innerMethodRef)
        let outerMethodHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: outerMethodAttrs,
            implAttributes: outerImplAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(function.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(outerSigBlob),
            bodyOffset: outerBodyOffset,
            parameterList: outerFirstParam
        )
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(
            outerMethodHandle,
            outerNullability,
            outerReturnRow,
            outerParameterRows.MoveToImmutable()
        )
        // Surface unrelated user-written method attributes on the managed
        // wrapper. Attributes that control the native transition belong only
        // on the hidden P/Invoke below.
        this
            .outer
            .customAttrEncoder
            .EmitUserAttributesExcept(
            outerMethodHandle,
            function,
            AttributeTargetKind.Method,
            KnownAttributes.IsLibraryImportInnerMethodAttribute
        )
        for (paramSym, paramHandle) in outerParamHandles {
            this.outer.customAttrEncoder.EmitUserAttributes(paramHandle, paramSym, AttributeTargetKind.Param)
        }
        // === Inner blittable P/Invoke ===
        let innerSigBlob = BlobBuilder()
        BlobEncoder(innerSigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            function.Parameters.Length,
            (r ReturnTypeEncoder) -> {
                if function.Type == TypeSymbol.String {
                    // ADR-0092 §2 — a `string` return is marshalled by the
                    // outer stub. The PreserveSig/blittable inner returns the
                    // raw native pointer as IntPtr (symmetric to the IntPtr
                    // string-parameter form); the outer materializes the
                    // managed string via Marshal.PtrToString*.
                    r.Type(isByRef: false).IntPtr()
                } else {
                    this.signatures.EncodeReturnSymbol(r, function.Type, function.ReturnRefKind)
                }
            },
            (ps ParametersEncoder) -> {
                for p in function.Parameters {
                    let slot = ps.AddParameter().Type(isByRef: p.RefKind != RefKind.None)
                    if p.Type == TypeSymbol.String {
                        // Marshal-as-IntPtr — the blittable form the
                        // outer stub passes after explicit marshalling.
                        slot.IntPtr()
                    } else {
                        this.signatures.EncodeTypeSymbol(slot, p.Type)
                    }
                }
            }
        )
        // The inner method is private static, PinvokeImpl, PreserveSig.
        // No body. PinvokeImpl with no managed IL: bodyOffset = -1, IL +
        // Managed + PreserveSig (matching the @DllImport emit shape).
        let innerMethodAttrs = MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.PinvokeImpl
        let innerImplAttrs = MethodImplAttributes.IL | MethodImplAttributes.Managed | MethodImplAttributes.PreserveSig
        let innerFirstParam = this.outer.customAttrEncoder.NextParameterHandle()
        var innerSeq = 1
        for p in function.Parameters {
            let innerParamAttrs = if p.MarshalAsMetadata == nil {
                ParameterAttributes.None
            } else {
                ParameterAttributes.HasFieldMarshal
            }
            let innerParamHandle = this
                .emitCtx
                .Metadata
                .AddParameter(
                attributes: innerParamAttrs,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: innerSeq++
            )
            if p.MarshalAsMetadata != nil {
                EmitFieldMarshalRow(innerParamHandle, p.MarshalAsMetadata!!)
            }
        }
        let innerName = "<" + function.Name + ">g__PInvoke|0_0"
        let innerMethodHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: innerMethodAttrs,
            implAttributes: innerImplAttrs,
            name: this.emitCtx.Metadata.GetOrAddString(innerName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(innerSigBlob),
            bodyOffset: -1,
            parameterList: innerFirstParam
        )
        // Sanity check: the planned row must match the row we just emitted.
        if innerMethodHandle != innerMethodRef {
            throw InvalidOperationException(
                "LibraryImport inner-method row mismatch for '${function.Name}': planned ${MetadataTokens.GetRowNumber(innerMethodRef)}, emitted ${MetadataTokens.GetRowNumber(innerMethodHandle)}."
            )
        }
        this
            .outer
            .customAttrEncoder
            .EmitUserAttributesExcept(
            innerMethodHandle,
            function,
            AttributeTargetKind.Method,
            (attribute BoundAttribute) -> !KnownAttributes.IsLibraryImportInnerMethodAttribute(attribute)
        )
        // ModuleRef (deduplicated by library name, same cache as @DllImport).
        if !this.cache.PInvokeModuleRefs.TryGetValue(pInvoke.LibraryName, out var moduleRef) {
            moduleRef = this
                .emitCtx
                .Metadata
                .AddModuleReference(this.emitCtx.Metadata.GetOrAddString(pInvoke.LibraryName))
            this.cache.PInvokeModuleRefs[pInvoke.LibraryName] = moduleRef
        }
        let importAttrs = MapPInvokeImportAttributes(pInvoke)
        this
            .emitCtx
            .Metadata
            .AddMethodImport(
            innerMethodHandle,
            importAttrs,
            this.emitCtx.Metadata.GetOrAddString(pInvoke.EntryPoint ?? function.Name),
            moduleRef
        )
        return outerMethodHandle
    }

    /// Emits the IL body of an `@LibraryImport` outer managed stub
    /// and returns the body offset + the locals-signature handle.
    private func EmitLibraryImportOuterBody(
        function FunctionSymbol,
        stringParamIndices IReadOnlyList[int32],
        innerMethodHandle MethodDefinitionHandle
    )(BodyOffset int32, LocalsSignature StandaloneSignatureHandle) {
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        // Locals plan: one IntPtr per string parameter, in order; an
        // optional result local when the function returns a value (so we
        // can ret AFTER the finally that frees the marshalled buffers).
        let stringLocalIndex = Dictionary[int32, int32](stringParamIndices.Count)
        let localTypes = List[TypeSymbol]()
        for idx in stringParamIndices {
            stringLocalIndex[idx] = localTypes.Count
            localTypes.Add(TypeSymbol.NInt)
        }
        let hasResult = function.Type != TypeSymbol.Void
        var resultLocalIndex = -1
        if hasResult {
            resultLocalIndex = localTypes.Count
            localTypes.Add(function.Type)
        }
        // Resolve the Marshal-helper MemberRefs lazily based on the
        // configured StringMarshalling mode. Both helpers are no-ops on
        // null / IntPtr.Zero respectively, so the stub does not need null
        // guards.
        let marshalType = typeof(Marshal)
        let isUtf16 = Invariant.Required(
            function.PInvokeMetadata,
            "a LibraryImport function has P/Invoke metadata",
            expression: "function.PInvokeMetadata"
        )
            .StringMarshalling == StringMarshalling.Utf16
        var convertRef = default(MemberReferenceHandle)
        var freeRef = default(MemberReferenceHandle)
        if stringParamIndices.Count > 0 {
            let convertName = if isUtf16 {
                "StringToCoTaskMemUni"
            } else {
                "StringToCoTaskMemUTF8"
            }
            let convertMethod = marshalType.GetMethod(convertName, []Type{typeof(string)}) ??
                throw InvalidOperationException("Cannot resolve Marshal.$convertName(string).")
            let freeMethod = marshalType.GetMethod("FreeCoTaskMem", []Type{typeof(nint)}) ??
                throw InvalidOperationException("Cannot resolve Marshal.FreeCoTaskMem(IntPtr).")
            convertRef = this.memberRefs.GetMethodReference(convertMethod)
            freeRef = this.memberRefs.GetMethodReference(freeMethod)
        }
        // ADR-0092 §2 — for a `string` return the inner P/Invoke yields the
        // raw native pointer (encoded as IntPtr); the outer stub materializes
        // a managed string via Marshal.PtrToStringUTF8 / PtrToStringUni. The
        // returned native buffer is NON-OWNING (the native side owns it, e.g.
        // `getenv`), so the stub never frees it — see the ADR-0092
        // return-marshalling table.
        let returnIsString = function.Type == TypeSymbol.String
        var ptrToStringRef = default(MemberReferenceHandle)
        if returnIsString {
            let ptrToStringName = if isUtf16 {
                "PtrToStringUni"
            } else {
                "PtrToStringUTF8"
            }
            let ptrToStringMethod = marshalType.GetMethod(ptrToStringName, []Type{typeof(nint)}) ??
                throw InvalidOperationException("Cannot resolve Marshal.$ptrToStringName(IntPtr).")
            ptrToStringRef = this.memberRefs.GetMethodReference(ptrToStringMethod)
        }
        // 1) Marshal each string argument to a CoTaskMem IntPtr before the try.
        for idx in stringParamIndices {
            il.LoadArgument(idx)
            il.OpCode(ILOpCode.Call)
            il.Token(convertRef)
            il.StoreLocal(stringLocalIndex[idx])
        }
        let tryStart = il.DefineLabel()
        let finallyStart = il.DefineLabel()
        let finallyEnd = il.DefineLabel()
        il.MarkLabel(tryStart)
        // 2) Push each argument onto the eval stack — IntPtr for strings,
        //    plain arg for everything else — then call the inner P/Invoke.
        for var i = 0; i < function.Parameters.Length; i++ {
            if stringLocalIndex.TryGetValue(i, out var localIdx) {
                il.LoadLocal(localIdx)
            } else {
                il.LoadArgument(i)
            }
        }
        il.OpCode(ILOpCode.Call)
        il.Token(innerMethodHandle)
        if hasResult {
            if returnIsString {
                // Inner returned a raw native pointer (IntPtr) on the stack;
                // convert it to a managed string in place. PtrToString* is a
                // no-op (returns null) on IntPtr.Zero, so no null guard is
                // needed. The native buffer is non-owning and is NOT freed.
                il.OpCode(ILOpCode.Call)
                il.Token(ptrToStringRef)
            }
            il.StoreLocal(resultLocalIndex)
        }
        il.Branch(ILOpCode.Leave, finallyEnd)
        // 3) Finally: free every marshalled buffer.
        il.MarkLabel(finallyStart)
        for idx in stringParamIndices {
            il.LoadLocal(stringLocalIndex[idx])
            il.OpCode(ILOpCode.Call)
            il.Token(freeRef)
        }
        il.OpCode(ILOpCode.Endfinally)
        il.MarkLabel(finallyEnd)
        if stringParamIndices.Count > 0 {
            Invariant.Required(
                il.ControlFlowBuilder,
                "the encoder for a method body with a protected region is created with a control-flow builder",
                expression: "il.ControlFlowBuilder"
            )
                .AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd)
        }
        if hasResult {
            il.LoadLocal(resultLocalIndex)
        }
        il.OpCode(ILOpCode.Ret)
        // Encode locals signature.
        var localsSig = default(StandaloneSignatureHandle)
        if localTypes.Count > 0 {
            let localsSigBlob = BlobBuilder()
            let encoder = BlobEncoder(localsSigBlob).LocalVariableSignature(localTypes.Count)
            for t in localTypes {
                this.signatures.EncodeLocalVariableType(encoder.AddVariable(), t)
            }
            localsSig = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob))
        }
        let offset = this
            .emitCtx
            .MethodBodyStream
            .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSig)
        return (offset, localsSig)
    }

    private data struct FunctionBodyEmissionResult(
        BodyOffset int32,
        SequencePoints IReadOnlyList[SequencePoint]?,
        Locals IReadOnlyList[LocalInfo]?,
        Constants IReadOnlyList[LocalConstantInfo]?,
        CodeSize int32,
        LocalsSignature StandaloneSignatureHandle
    ) : IEquatable[FunctionBodyEmissionResult] { }

    private data struct FunctionParameterMetadata(
        FirstParameterHandle ParameterHandle,
        ReturnParameterHandle ParameterHandle?,
        ParameterHandles List[(Symbol ParameterSymbol, Handle ParameterHandle)],
        Nullability MethodNullabilityPlan
    ) : IEquatable[FunctionParameterMetadata] { }

    shared {
        private func GetMethodMetadataName(
            function FunctionSymbol,
            isEntryPoint bool,
            isSynthesizedEntryPointStub bool = false
        ) string {
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
            // Issue #3883: the synthesized stub that blocks on an authored async
            // `Main` also takes the `<Main>$` metadata name — it must not collide
            // with the authored `Main` (which is emitted alongside it, keeping its
            // Task-returning signature), and csc names its equivalent stub the
            // same way.
            let methodName = if isEntryPoint && (function.Declaration == nil || isSynthesizedEntryPointStub) {
                "<Main>$$"
            } else {
                (
                    if function.ExplicitInterfaceClauseTarget != nil {
                        ExplicitInterfaceMetadataNaming.GetMetadataName(
                            function.Name,
                            function.ExplicitInterfaceClauseTarget
                        )
                    } else {
                        function.Name
                    }
                )
            }
            return methodName
        }

        private func GetMethodAttributes(
            function FunctionSymbol,
            isEntryPoint bool,
            isSynthesizedEntryPointStub bool = false,
            isInterfaceImplementation bool = false
        ) MethodAttributes {
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
            let effectiveAccessibility = if function.ExplicitInterfaceClauseTarget != nil {
                Accessibility.Private
            } else {
                function.Accessibility
            }
            let visibility = if isEntryPoint && (function.Declaration == nil || isSynthesizedEntryPointStub) {
                MethodAttributes.Public
            } else {
                AccessibilityMap.ToMethodVisibility(
                    effectiveAccessibility,
                    AccessibilityMap.IsTopLevelProgramMember(function)
                )
            }
            // Instance methods omit MethodAttributes.Static. ADR-0017's class
            // methods are non-virtual unless declared `open`; overrides and
            // interface implementations need virtual slots for CLR dispatch:
            //   plain (neither):    no virtual flags
            //   open:               Virtual | NewSlot
            //   override (sealed):  Virtual | Final (reuses base slot)
            //   open override:      Virtual (reuses base slot)
            var methodAttrs = visibility | MethodAttributes.HideBySig
            // Stream D: extension functions whose name follows the CLR `op_*`
            // convention came from `func (a T) operator +(...)` and should round-
            // trip as SpecialName so consumers (e.g. C#) see them as operators.
            if function.IsExtension && function.Name != nil && function.Name.StartsWith("op_") {
                methodAttrs |= MethodAttributes.SpecialName
            }
            // Issue #257: event accessor methods (add_X, remove_X, raise_X) are marked SpecialName.
            if function.IsSpecialName {
                methodAttrs |= MethodAttributes.SpecialName
            }
            if function.IsInstanceMethod {
                let receiverStruct StructSymbol? = function.ReceiverType as StructSymbol
                let receiverIsInterface = function.ReceiverType is InterfaceSymbol
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
                let isDataToStringOverride = receiverStruct != nil &&
                    receiverStruct.IsData &&
                    function.Name == "ToString"
                // ADR-0199: a hand-written `PrintMembers(StringBuilder)` on a data
                // type replaces the synthesized one and must occupy the same CLR
                // slot (private for a sealed type that starts it; otherwise
                // protected virtual, newslot only when no base slot exists). The
                // binder only admits the compatible shape (GS0623).
                let isDataPrintMembers = receiverStruct != nil && receiverStruct.IsData && DataPrintMembersModel.IsSlot(
                    function
                )
                let isVirtualDataPrintMembers = isDataPrintMembers && DataStructSynthesizer.IsPrintMembersVirtual(
                    Invariant.Required(
                        receiverStruct,
                        "a data print-members slot has a receiver",
                        expression: "receiverStruct"
                    )
                )
                if receiverIsInterface && function.Accessibility != Accessibility.Private {
                    // ADR-0085 / issue #726: an instance method whose receiver is
                    // an interface is a default-interface method (DIM). Emit it
                    // as Public | HideBySig | Virtual | NewSlot — NOT Final
                    // (implementers may override) and NOT Abstract (the body is
                    // emitted below). `MethodImplAttributes.IL | Managed` is
                    // already the default for EmitFunction's AddMethodDefinition
                    // call, so no further tweak is needed.
                    methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
                } else if receiverIsInterface {
                    // ADR-0090 / issue #756: a `private` interface helper is NOT
                    // part of the v-table — it does not get Virtual / NewSlot /
                    // Final. It is emitted as Private | HideBySig (instance) with
                    // a body and is callable only from sibling members of the
                    // same interface. Visibility was set above via AccessibilityMap.
                    //
                    // Fall through — no further attribute stamping needed.

                } else if if isDataPrintMembers {
                    isVirtualDataPrintMembers
                } else {
                    isDataToStringOverride ||
                        function.IsOpen ||
                        function.IsOverride ||
                        isInterfaceImplementation ||
                        MethodInfoHelpers.RequiresVirtualOnValueType(function, receiverStruct)
                } {
                    methodAttrs |= MethodAttributes.Virtual
                    if if isVirtualDataPrintMembers {
                        DataStructSynthesizer.IsPrintMembersNewSlot(
                            Invariant.Required(
                                receiverStruct,
                                "a data print-members slot has a receiver",
                                expression: "receiverStruct"
                            )
                        )
                    } else {
                        (!function.IsOverride && !isDataToStringOverride) ||
                            MethodInfoHelpers.IsCovariantPropertyGetter(function)
                    } {
                        methodAttrs |= MethodAttributes.NewSlot
                    }
                    let redundantFinalOnSealedOverride = function.IsOverride &&
                        receiverStruct != nil &&
                        (!receiverStruct.IsClass || (!receiverStruct.IsOpen && !receiverStruct.IsSealedHierarchy))
                    if (
                        if isDataToStringOverride {
                            DataStructSynthesizer.IsDataObjectOverrideFinal(receiverStruct)
                        } else {
                            !isVirtualDataPrintMembers && !function.IsOpen
                        }
                    ) &&
                        !redundantFinalOnSealedOverride {
                        methodAttrs |= MethodAttributes.Final
                    }
                    // Issue #987: an abstract method declares a virtual slot with no
                    // implementation. It is always `open` (so never Final above) and
                    // carries the Abstract bit; the body-emission block was skipped
                    // and bodyOffset stays -1.
                    if function.IsAbstract {
                        methodAttrs |= MethodAttributes.Abstract
                    }
                }
            } else {
                methodAttrs |= MethodAttributes.Static
                // ADR-0089 / issue #755: a static-virtual interface method
                // *with* a default body still needs the virtual / newslot
                // flags so the slot remains overridable by implementers.
                // <c>FunctionSymbol.IsStatic</c> + <c>StaticOwnerType is
                // InterfaceSymbol</c> identifies this case.
                //
                // ADR-0090 / issue #756: a `private static` interface helper is
                // NOT virtual — it is private-by-default and the type-parameter
                // dispatch table does not include it. Suppress Virtual / NewSlot.
                if function.IsStatic &&
                    function.StaticOwnerType is InterfaceSymbol &&
                    function.Accessibility != Accessibility.Private {
                    methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
                }
            }
            return methodAttrs
        }

        private func MapPInvokeImportAttributes(pInvoke PInvokeMetadata) MethodImportAttributes {
            var attrs = MethodImportAttributes.None
            switch pInvoke.CallingConvention {
                case CallingConvention.Cdecl {
                    attrs |= MethodImportAttributes.CallingConventionCDecl
                }
                case CallingConvention.StdCall {
                    attrs |= MethodImportAttributes.CallingConventionStdCall
                }
                case CallingConvention.ThisCall {
                    attrs |= MethodImportAttributes.CallingConventionThisCall
                }
                case CallingConvention.FastCall {
                    attrs |= MethodImportAttributes.CallingConventionFastCall
                }
                case CallingConvention.Winapi {
                    attrs |= MethodImportAttributes.CallingConventionWinApi
                }
                default {
                    attrs |= MethodImportAttributes.CallingConventionWinApi
                }
            }
            switch pInvoke.CharSet {
                case CharSet.Ansi {
                    attrs |= MethodImportAttributes.CharSetAnsi
                }
                case CharSet.Unicode {
                    attrs |= MethodImportAttributes.CharSetUnicode
                }
                case CharSet.Auto {
                    attrs |= MethodImportAttributes.CharSetAuto
                }
                case CharSet.None { }
                default { }
            }
            if pInvoke.SetLastError {
                attrs |= MethodImportAttributes.SetLastError
            }
            if pInvoke.ExactSpelling {
                attrs |= MethodImportAttributes.ExactSpelling
            }
            if pInvoke.BestFitMapping is bool bfm {
                attrs |= if bfm {
                    MethodImportAttributes.BestFitMappingEnable
                } else {
                    MethodImportAttributes.BestFitMappingDisable
                }
            }
            if pInvoke.ThrowOnUnmappableChar is bool tum {
                attrs |= if tum {
                    MethodImportAttributes.ThrowOnUnmappableCharEnable
                } else {
                    MethodImportAttributes.ThrowOnUnmappableCharDisable
                }
            }
            return attrs
        }
    }
}
