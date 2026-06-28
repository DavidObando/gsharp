// <copyright file="ReflectionMetadataEmitter.Methods.2.cs" company="GSharp">
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
}
