// <copyright file="ReflectionMetadataEmitter.Methods.3.cs" company="GSharp">
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
}
