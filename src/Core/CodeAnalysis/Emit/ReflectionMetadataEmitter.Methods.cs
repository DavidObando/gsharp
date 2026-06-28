// <copyright file="ReflectionMetadataEmitter.Methods.cs" company="GSharp">
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
}
