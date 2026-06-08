// <copyright file="MethodBodyEmitter.Statements.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class
#pragma warning disable SA1505 // opening brace should not be followed by a blank line — partial classes ship with a leading blank for readability
#pragma warning disable SA1202 // 'internal' members should come before 'private' members

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-11 partial of <see cref="MethodBodyEmitter"/>:
/// statement-level emission — try/catch, scope, select, channel-send, go.
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    private void EmitTryStatement(BoundTryStatement node)
    {
        var endLabel = this.il.DefineLabel();
        var hasCatches = node.CatchClauses.Length > 0;
        var hasFinally = node.FinallyBlock != null;

        if (hasCatches && hasFinally)
        {
            // Nested: outer try-finally wrapping inner try-catch.
            var outerTryStart = this.il.DefineLabel();
            var innerTryStart = this.il.DefineLabel();
            var finallyStart = this.il.DefineLabel();
            var finallyEnd = this.il.DefineLabel();

            this.il.MarkLabel(outerTryStart);
            this.il.MarkLabel(innerTryStart);
            this.EmitProtectedRegion((BoundBlockStatement)node.TryBlock);
            var innerTryEnd = this.il.DefineLabel();
            this.il.Branch(ILOpCode.Leave, endLabel);
            this.il.MarkLabel(innerTryEnd);

            this.EmitCatchClauses(node.CatchClauses, innerTryStart, innerTryEnd, leaveTarget: endLabel);

            this.il.MarkLabel(finallyStart);
            this.EmitProtectedRegion((BoundBlockStatement)node.FinallyBlock);
            this.il.OpCode(ILOpCode.Endfinally);
            this.il.MarkLabel(finallyEnd);

            this.il.ControlFlowBuilder.AddFinallyRegion(outerTryStart, finallyStart, finallyStart, finallyEnd);
        }
        else if (hasCatches)
        {
            var tryStart = this.il.DefineLabel();
            this.il.MarkLabel(tryStart);
            this.EmitProtectedRegion((BoundBlockStatement)node.TryBlock);
            var tryEnd = this.il.DefineLabel();
            this.il.Branch(ILOpCode.Leave, endLabel);
            this.il.MarkLabel(tryEnd);

            this.EmitCatchClauses(node.CatchClauses, tryStart, tryEnd, leaveTarget: endLabel);
        }
        else
        {
            // finally only
            var tryStart = this.il.DefineLabel();
            var finallyStart = this.il.DefineLabel();
            var finallyEnd = this.il.DefineLabel();

            this.il.MarkLabel(tryStart);
            this.EmitProtectedRegion((BoundBlockStatement)node.TryBlock);
            this.il.Branch(ILOpCode.Leave, finallyEnd);

            this.il.MarkLabel(finallyStart);
            this.EmitProtectedRegion((BoundBlockStatement)node.FinallyBlock);
            this.il.OpCode(ILOpCode.Endfinally);
            this.il.MarkLabel(finallyEnd);

            this.il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
        }

        this.il.MarkLabel(endLabel);
    }

    private void EmitCatchClauses(
        ImmutableArray<BoundCatchClause> clauses,
        LabelHandle tryStart,
        LabelHandle tryEnd,
        LabelHandle leaveTarget)
    {
        foreach (var clause in clauses)
        {
            var handlerStart = this.il.DefineLabel();
            var handlerEnd = this.il.DefineLabel();

            this.il.MarkLabel(handlerStart);

            // Stack contains the caught exception; store into the catch variable.
            // Issue #420 (P3-6): the binder is currently expected to always
            // provide a catch variable with an allocated slot, but if a future
            // binder pass elides an unused catch variable (or leaves it without
            // a slot) we still need to consume the exception object the CLR
            // pushed onto the evaluation stack on entry to the handler --
            // otherwise the handler starts with an unbalanced stack and the
            // generated IL becomes unverifiable. Defensively emit `pop` in
            // that case instead of dereferencing a null variable.
            if (clause.Variable is null || !this.HasStorageSlot(clause.Variable))
            {
                this.il.OpCode(ILOpCode.Pop);
            }
            else
            {
                this.EmitStoreVariable(clause.Variable);
            }

            this.EmitProtectedRegion((BoundBlockStatement)clause.Body);
            this.il.Branch(ILOpCode.Leave, leaveTarget);
            this.il.MarkLabel(handlerEnd);

            // Issue #421 (P2-6): user-defined exception classes have ClrType == null
            // at emit time, so fall back to the emitter's user-defined type registry
            // via GetElementTypeToken (which handles both CLR-backed and source-defined
            // types) instead of dereferencing ClrType directly.
            var catchTypeHandle = this.outer.GetElementTypeToken(clause.ExceptionType);
            this.il.ControlFlowBuilder.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle);
        }
    }

    // Emits a block as a protected region: pushes the lexical label set so
    // gotos targeting labels outside the region are translated to `leave`.
    private void EmitProtectedRegion(BoundBlockStatement block)
    {
        var labelSet = new HashSet<BoundLabel>();
        this.CollectLabels(block, labelSet);
        this.protectedRegionStack.Push(labelSet);
        try
        {
            this.EmitBlock(block);
        }
        finally
        {
            this.protectedRegionStack.Pop();
        }
    }

    private void EmitGoStatement(BoundGoStatement node)
    {
        var hasScope = this.goEnclosingScopes.TryGetValue(node, out var scope);
        if (hasScope)
        {
            this.il.LoadLocal(this.scopeFrameSlots[scope].Tasks);
        }

        this.EmitGoAction(node);

        var closure = this.outer.closures.GoClosureInfos[node];
        var isAsync = ClosureEmitter.IsTaskClrType(closure.InvokeMethod.Type?.ClrType);

        MethodInfo run;
        if (isAsync)
        {
            run = typeof(System.Threading.Tasks.Task).GetMethod(
                nameof(System.Threading.Tasks.Task.Run),
                new[] { typeof(Func<System.Threading.Tasks.Task>) });
        }
        else
        {
            run = typeof(System.Threading.Tasks.Task).GetMethod(
                nameof(System.Threading.Tasks.Task.Run),
                new[] { typeof(Action) });
        }

        this.il.Call(this.outer.GetMethodEntityHandle(run));

        if (hasScope)
        {
            var listType = typeof(List<System.Threading.Tasks.Task>);
            var add = listType.GetMethod(nameof(List<System.Threading.Tasks.Task>.Add), new[] { typeof(System.Threading.Tasks.Task) });
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(add));
        }
        else
        {
            this.il.OpCode(ILOpCode.Pop);
        }
    }

    private void EmitGoAction(BoundGoStatement node)
    {
        if (!this.outer.closures.GoClosureInfos.TryGetValue(node, out var closure))
        {
            throw new InvalidOperationException("Go statement has no synthesized display class.");
        }

        if (!this.outer.cache.ClassCtorHandles.TryGetValue(closure.ClassSym, out var ctorHandle))
        {
            throw new InvalidOperationException(
                $"Go display class '{closure.ClassSym.Name}' has no emitted constructor.");
        }

        if (!this.outer.cache.MethodHandles.TryGetValue(closure.InvokeMethod, out var invokeHandle))
        {
            throw new InvalidOperationException(
                $"Go display invoke method '{closure.InvokeMethod.Name}' has no emitted MethodDef.");
        }

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(ctorHandle);

        foreach (var captured in closure.CaptureFields.Keys)
        {
            var field = closure.CaptureFields[captured];
            if (!this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle))
            {
                throw new InvalidOperationException(
                    $"Go display field '{field.Name}' has no emitted FieldDef.");
            }

            this.il.OpCode(ILOpCode.Dup);
            this.EmitExpression(new BoundVariableExpression(null, captured));
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldHandle);
        }

        var isAsync = ClosureEmitter.IsTaskClrType(closure.InvokeMethod.Type?.ClrType);

        if (isAsync)
        {
            var funcTaskCtor = typeof(Func<System.Threading.Tasks.Task>).GetConstructor(new[] { typeof(object), typeof(IntPtr) });
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(invokeHandle);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(funcTaskCtor));
        }
        else
        {
            var actionCtor = typeof(Action).GetConstructor(new[] { typeof(object), typeof(IntPtr) });
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(invokeHandle);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.GetCtorReference(actionCtor));
        }
    }

    private void EmitScopeStatement(BoundScopeStatement node)
    {
        var slots = this.scopeFrameSlots[node];
        var listType = typeof(List<System.Threading.Tasks.Task>);
        var listCtor = listType.GetConstructor(Type.EmptyTypes);
        var ctsCtor = typeof(System.Threading.CancellationTokenSource).GetConstructor(Type.EmptyTypes);

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(listCtor));
        this.il.StoreLocal(slots.Tasks);

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(ctsCtor));
        this.il.StoreLocal(slots.Cts);

        var tryStart = this.il.DefineLabel();
        var finallyStart = this.il.DefineLabel();
        var finallyEnd = this.il.DefineLabel();
        var endLabel = this.il.DefineLabel();

        this.il.MarkLabel(tryStart);
        this.EmitStatement(node.Body);
        this.il.Branch(ILOpCode.Leave, endLabel);

        this.il.MarkLabel(finallyStart);
        this.EmitScopeWaitAndDispose(slots);
        this.il.OpCode(ILOpCode.Endfinally);
        this.il.MarkLabel(finallyEnd);
        this.il.MarkLabel(endLabel);

        this.il.ControlFlowBuilder.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
    }

    private void EmitScopeWaitAndDispose((int Tasks, int Cts, int Awaiter) slots)
    {
        var outerTryStart = this.il.DefineLabel();
        var innerTryStart = this.il.DefineLabel();
        var innerTryEnd = this.il.DefineLabel();
        var catchStart = this.il.DefineLabel();
        var catchEnd = this.il.DefineLabel();
        var disposeStart = this.il.DefineLabel();
        var disposeEnd = this.il.DefineLabel();
        var afterNested = this.il.DefineLabel();

        this.il.MarkLabel(outerTryStart);
        this.il.MarkLabel(innerTryStart);
        this.EmitScopeWait(slots);
        this.il.Branch(ILOpCode.Leave, afterNested);
        this.il.MarkLabel(innerTryEnd);

        this.il.MarkLabel(catchStart);
        this.il.OpCode(ILOpCode.Pop);
        var cancel = typeof(System.Threading.CancellationTokenSource).GetMethod(
            nameof(System.Threading.CancellationTokenSource.Cancel),
            Type.EmptyTypes);
        this.il.LoadLocal(slots.Cts);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(cancel));
        this.il.OpCode(ILOpCode.Rethrow);
        this.il.MarkLabel(catchEnd);

        this.il.MarkLabel(disposeStart);
        var dispose = typeof(System.Threading.CancellationTokenSource).GetMethod(
            nameof(System.Threading.CancellationTokenSource.Dispose),
            Type.EmptyTypes);
        this.il.LoadLocal(slots.Cts);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(dispose));
        this.il.OpCode(ILOpCode.Endfinally);
        this.il.MarkLabel(disposeEnd);
        this.il.MarkLabel(afterNested);

        this.il.ControlFlowBuilder.AddCatchRegion(
            innerTryStart,
            innerTryEnd,
            catchStart,
            catchEnd,
            (EntityHandle)this.outer.GetTypeReference(typeof(Exception)));
        this.il.ControlFlowBuilder.AddFinallyRegion(outerTryStart, disposeStart, disposeStart, disposeEnd);
    }

    private void EmitScopeWait((int Tasks, int Cts, int Awaiter) slots)
    {
        var listType = typeof(List<System.Threading.Tasks.Task>);
        var toArray = listType.GetMethod(nameof(List<System.Threading.Tasks.Task>.ToArray), Type.EmptyTypes);
        var whenAll = typeof(System.Threading.Tasks.Task).GetMethod(
            nameof(System.Threading.Tasks.Task.WhenAll),
            new[] { typeof(System.Threading.Tasks.Task[]) });
        var getAwaiter = typeof(System.Threading.Tasks.Task).GetMethod(
            nameof(System.Threading.Tasks.Task.GetAwaiter),
            Type.EmptyTypes);
        var getResult = typeof(System.Runtime.CompilerServices.TaskAwaiter).GetMethod(
            nameof(System.Runtime.CompilerServices.TaskAwaiter.GetResult),
            Type.EmptyTypes);

        this.il.LoadLocal(slots.Tasks);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(toArray));
        this.il.Call(this.outer.GetMethodEntityHandle(whenAll));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getAwaiter));
        this.il.StoreLocal(slots.Awaiter);
        this.il.LoadLocalAddress(slots.Awaiter);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(getResult));
    }

    private void EmitSelectStatement(BoundSelectStatement node)
    {
        var slots = this.selectStatementSlots[node];
        for (var i = 0; i < node.Cases.Length; i++)
        {
            var arm = node.Cases[i];
            if (arm.IsDefault)
            {
                continue;
            }

            this.EmitExpression(arm.Channel);
            this.il.StoreLocal(slots.ChannelSlots[i]);
            if (arm.CaseKind == SelectCaseKind.Send)
            {
                this.EmitExpression(arm.Value);
                this.il.StoreLocal(slots.ValueSlots[i]);
            }
        }

        var loopLabel = this.il.DefineLabel();
        var endLabel = this.il.DefineLabel();
        this.il.MarkLabel(loopLabel);

        for (var i = 0; i < node.Cases.Length; i++)
        {
            if (node.Cases[i].CaseKind == SelectCaseKind.ReceiveDiscard
                || node.Cases[i].CaseKind == SelectCaseKind.ReceiveBind)
            {
                this.EmitSelectReceiveProbe(node.Cases[i], slots, i, endLabel);
            }
        }

        for (var i = 0; i < node.Cases.Length; i++)
        {
            if (node.Cases[i].CaseKind == SelectCaseKind.Send)
            {
                this.EmitSelectSendProbe(node.Cases[i], slots, i, endLabel);
            }
        }

        foreach (var arm in node.Cases)
        {
            if (arm.IsDefault)
            {
                this.EmitStatement(arm.Body);
                this.il.Branch(ILOpCode.Br, endLabel);
                this.il.MarkLabel(endLabel);
                return;
            }
        }

        this.EmitSelectWait(node, slots);
        this.il.Branch(ILOpCode.Br, loopLabel);
        this.il.MarkLabel(endLabel);
    }

    private void EmitSelectReceiveProbe(
        BoundSelectCase arm,
        SelectSlots slots,
        int index,
        LabelHandle endLabel)
    {
        var nextLabel = this.il.DefineLabel();
        var closedLabel = this.il.DefineLabel();
        var chType = (ChannelTypeSymbol)arm.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
        var getReader = channelClr.GetProperty("Reader").GetGetMethod();
        var tryRead = readerClr.GetMethod("TryRead", new[] { elementClr.MakeByRefType() });
        var completion = readerClr.GetProperty("Completion").GetGetMethod();
        var isCompleted = typeof(System.Threading.Tasks.Task).GetProperty("IsCompleted").GetGetMethod();

        this.il.LoadLocal(slots.ChannelSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getReader));
        this.il.LoadLocalAddress(slots.OutSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(tryRead));
        this.il.Branch(ILOpCode.Brfalse, closedLabel);
        this.EmitStatement(arm.Body);
        this.il.Branch(ILOpCode.Br, endLabel);

        this.il.MarkLabel(closedLabel);
        this.il.LoadLocal(slots.ChannelSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getReader));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(completion));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(isCompleted));
        this.il.Branch(ILOpCode.Brfalse, nextLabel);
        this.EmitZeroInit(slots.OutSlots[index], chType.ElementType, elementClr);
        this.EmitStatement(arm.Body);
        this.il.Branch(ILOpCode.Br, endLabel);
        this.il.MarkLabel(nextLabel);
    }

    private void EmitSelectSendProbe(
        BoundSelectCase arm,
        SelectSlots slots,
        int index,
        LabelHandle endLabel)
    {
        var nextLabel = this.il.DefineLabel();
        var chType = (ChannelTypeSymbol)arm.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
        var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
        var tryWrite = writerClr.GetMethod("TryWrite", new[] { elementClr });

        this.il.LoadLocal(slots.ChannelSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getWriter));
        this.il.LoadLocal(slots.ValueSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(tryWrite));
        this.il.Branch(ILOpCode.Brfalse, nextLabel);
        this.EmitStatement(arm.Body);
        this.il.Branch(ILOpCode.Br, endLabel);
        this.il.MarkLabel(nextLabel);
    }

    private void EmitSelectWait(BoundSelectStatement node, SelectSlots slots)
    {
        var taskType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task));
        var whenAny = typeof(System.Threading.Tasks.Task).GetMethod(
            nameof(System.Threading.Tasks.Task.WhenAny),
            new[] { typeof(System.Threading.Tasks.Task[]) });
        var taskOfTask = typeof(System.Threading.Tasks.Task<System.Threading.Tasks.Task>);
        var getAwaiter = taskOfTask.GetMethod("GetAwaiter", Type.EmptyTypes);
        var awaiter = typeof(System.Runtime.CompilerServices.TaskAwaiter<System.Threading.Tasks.Task>);
        var getResult = awaiter.GetMethod("GetResult", Type.EmptyTypes);

        var waitCount = 0;
        foreach (var arm in node.Cases)
        {
            if (!arm.IsDefault)
            {
                waitCount++;
            }
        }

        this.il.LoadConstantI4(waitCount);
        this.il.OpCode(ILOpCode.Newarr);
        this.il.Token(this.outer.GetElementTypeToken(taskType));
        this.il.StoreLocal(slots.TasksSlot);

        var taskIndex = 0;
        for (var i = 0; i < node.Cases.Length; i++)
        {
            var arm = node.Cases[i];
            if (arm.IsDefault)
            {
                continue;
            }

            this.il.LoadLocal(slots.TasksSlot);
            this.il.LoadConstantI4(taskIndex);
            this.EmitSelectWaitTask(arm, slots, i);
            this.il.OpCode(ILOpCode.Stelem_ref);
            taskIndex++;
        }

        this.il.LoadLocal(slots.TasksSlot);
        this.il.Call(this.outer.GetMethodEntityHandle(whenAny));
        this.il.StoreLocal(slots.WhenAnyTaskSlot);
        this.il.LoadLocal(slots.WhenAnyTaskSlot);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getAwaiter));
        this.il.StoreLocal(slots.WhenAnyAwaiterSlot);
        this.il.LoadLocalAddress(slots.WhenAnyAwaiterSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(getResult));
        this.il.StoreLocal(slots.CompletedTaskSlot);
    }

    private void EmitSelectWaitTask(BoundSelectCase arm, SelectSlots slots, int index)
    {
        var chType = (ChannelTypeSymbol)arm.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var valueTaskBool = typeof(System.Threading.Tasks.ValueTask<bool>);
        var asTask = valueTaskBool.GetMethod("AsTask", Type.EmptyTypes);

        if (arm.CaseKind == SelectCaseKind.Send)
        {
            var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
            var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
            var waitToWrite = writerClr.GetMethod(
                "WaitToWriteAsync",
                new[] { typeof(System.Threading.CancellationToken) });
            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getWriter));
            this.EmitCancellationTokenNone();
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(waitToWrite));
        }
        else
        {
            var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
            var getReader = channelClr.GetProperty("Reader").GetGetMethod();
            var waitToRead = readerClr.GetMethod(
                "WaitToReadAsync",
                new[] { typeof(System.Threading.CancellationToken) });
            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(getReader));
            this.EmitCancellationTokenNone();
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetMethodReference(waitToRead));
        }

        this.il.StoreLocal(slots.WaitValueTaskSlot);
        this.il.LoadLocalAddress(slots.WaitValueTaskSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(asTask));
    }

    private void EmitChannelSendStatement(BoundChannelSendStatement node)
    {
        var chType = (ChannelTypeSymbol)node.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
        var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
        var writeAsync = writerClr.GetMethod(
            "WriteAsync",
            new[] { elementClr, typeof(System.Threading.CancellationToken) });
        var asTaskNonGeneric = typeof(System.Threading.Tasks.ValueTask).GetMethod("AsTask", Type.EmptyTypes);
        var getAwaiter = typeof(System.Threading.Tasks.Task).GetMethod("GetAwaiter", Type.EmptyTypes);
        var getResult = typeof(System.Runtime.CompilerServices.TaskAwaiter).GetMethod("GetResult", Type.EmptyTypes);

        var (vtSlot, taSlot, _, _) = this.channelOpSlots[node];

        this.EmitExpression(node.Channel);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getWriter));

        this.EmitExpression(node.Value);
        this.EmitCancellationTokenNone();

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(writeAsync));

        this.il.StoreLocal(vtSlot);
        this.il.LoadLocalAddress(vtSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(asTaskNonGeneric));

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getAwaiter));
        this.il.StoreLocal(taSlot);
        this.il.LoadLocalAddress(taSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(getResult));
    }
}
