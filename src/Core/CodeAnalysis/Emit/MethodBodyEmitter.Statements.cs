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

    // ADR-0125 / issue #1026: emits a `fixed` (pinning) statement. Pins the
    // managed buffer into a CLR pinned local, derives the unmanaged `*T`
    // pointer to element 0, then emits the body inside a try/finally that
    // releases the pin (nulls the pinned local) on every exit — mirroring
    // C#'s codegen. Pointer /
    // pinned-local IL is unverifiable by design (see ADR-0125 / ADR-0122);
    // the emit tests assert runtime behaviour and ignore the specific ilverify
    // codes the pattern triggers.
    private void EmitFixedStatement(BoundFixedStatement node)
    {
        var pinnedSlot = this.locals[node.PinnedVariable];
        var pointerSlot = this.locals[node.PointerVariable];

        if (node.PinKind == FixedPinKind.Array)
        {
            this.EmitFixedArrayPin(node, pinnedSlot, pointerSlot);
        }
        else if (node.PinKind == FixedPinKind.PinnableReference)
        {
            this.EmitFixedPinnableReferencePin(node, pinnedSlot, pointerSlot);
        }
        else
        {
            this.EmitFixedStringPin(node, pinnedSlot, pointerSlot);
        }

        var tryStart = this.il.DefineLabel();
        var finallyStart = this.il.DefineLabel();
        var finallyEnd = this.il.DefineLabel();

        this.il.MarkLabel(tryStart);
        this.EmitProtectedRegion((BoundBlockStatement)node.Body);
        this.il.Branch(ILOpCode.Leave, finallyEnd);

        this.il.MarkLabel(finallyStart);

        // Release the pin on normal, branch, return, and exceptional exits.
        if (node.PinKind == FixedPinKind.PinnableReference)
        {
            // The pinned local is a managed by-ref (`T& pinned`); release it by
            // storing a null managed pointer (`ldc.i4.0; conv.u`), exactly as the
            // C# compiler does for `fixed (T* p = span)`.
            this.il.LoadConstantI4(0);
            this.il.OpCode(ILOpCode.Conv_u);
            this.il.StoreLocal(pinnedSlot);
        }
        else
        {
            // Array (`T[] pinned`) / string (`string pinned`) release with `ldnull`.
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.StoreLocal(pinnedSlot);
        }

        this.il.OpCode(ILOpCode.Endfinally);
        this.il.MarkLabel(finallyEnd);
        this.ControlFlow.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
    }

    // Array-pin form: pin the array reference (`T[] pinned`) and derive
    // `&a[0]` via `ldelema`, guarding the null / zero-length array (→ null
    // pointer).
    private void EmitFixedArrayPin(BoundFixedStatement node, int pinnedSlot, int pointerSlot)
    {
        var elementType = ((Symbols.PointerTypeSymbol)node.PointerVariable.Type).PointeeType;
        var nullLabel = this.il.DefineLabel();
        var notEmptyLabel = this.il.DefineLabel();
        var afterLabel = this.il.DefineLabel();

        this.EmitExpression(node.PinnedSource); // array reference
        this.il.OpCode(ILOpCode.Dup);
        this.il.StoreLocal(pinnedSlot);          // pinned = arr
        this.il.Branch(ILOpCode.Brfalse, nullLabel);

        this.il.LoadLocal(pinnedSlot);
        this.il.OpCode(ILOpCode.Ldlen);
        this.il.OpCode(ILOpCode.Conv_i4);
        this.il.Branch(ILOpCode.Brtrue, notEmptyLabel);

        // Null or zero-length: pointer = null.
        this.il.MarkLabel(nullLabel);
        this.il.LoadConstantI4(0);
        this.il.OpCode(ILOpCode.Conv_u);
        this.il.StoreLocal(pointerSlot);
        this.il.Branch(ILOpCode.Br, afterLabel);

        // Non-empty: pointer = &arr[0].
        this.il.MarkLabel(notEmptyLabel);
        this.il.LoadLocal(pinnedSlot);
        this.il.LoadConstantI4(0);
        this.il.OpCode(ILOpCode.Ldelema);
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(elementType));
        this.EmitManagedPointerAsUnmanagedPointer(elementType);
        this.il.StoreLocal(pointerSlot);

        this.il.MarkLabel(afterLabel);
    }

    // String-pin form: pin the `string` reference (`string pinned`) and derive
    // the char-data pointer through `GetPinnableReference`, guarding null
    // (→ null pointer).
    private void EmitFixedStringPin(BoundFixedStatement node, int pinnedSlot, int pointerSlot)
    {
        var nullLabel = this.il.DefineLabel();
        var afterLabel = this.il.DefineLabel();

        this.EmitExpression(node.PinnedSource); // string reference
        this.il.OpCode(ILOpCode.Dup);
        this.il.StoreLocal(pinnedSlot);          // pinned = s
        this.il.Branch(ILOpCode.Brfalse, nullLabel);

        this.il.LoadLocal(pinnedSlot);
        var getPinnableReference = Invariant.Required(
            typeof(string).GetMethod(
                "GetPinnableReference",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null),
            "System.String declares the public instance GetPinnableReference()");
        this.il.Call(this.outer.memberRefs.GetMethodReference(getPinnableReference));
        this.EmitManagedPointerAsUnmanagedPointer(TypeSymbol.Char);
        this.il.StoreLocal(pointerSlot);
        this.il.Branch(ILOpCode.Br, afterLabel);

        this.il.MarkLabel(nullLabel);
        this.il.LoadConstantI4(0);
        this.il.OpCode(ILOpCode.Conv_u);
        this.il.StoreLocal(pointerSlot);
        this.il.MarkLabel(afterLabel);
    }

    // Span-like pin form (ADR-0125 / issue #1043): pin the `T&` returned by a
    // public instance `ref T GetPinnableReference()` (e.g. `System.Span[T]` /
    // `System.ReadOnlySpan[T]`) into a `T& pinned` local, then derive `*T` via
    // `Unsafe.AsPointer<T>`. `GetPinnableReference()` already returns the data
    // pointer for an empty span (a ref to where element 0 would be), so no
    // null/empty guard is required.
    private void EmitFixedPinnableReferencePin(BoundFixedStatement node, int pinnedSlot, int pointerSlot)
    {
        var sourceVariable = Invariant.Required(
            node.SourceVariable,
            "the binder gives every PinnableReference-form fixed statement a source local; the caller dispatched on that PinKind to reach here");
        var sourceSlot = this.locals[sourceVariable];

        var sourceClr = node.PinnedSource.Type?.ClrType
            ?? throw new InvalidOperationException(
                $"Span-like fixed source '{node.PinnedSource.Type?.Name}' has no CLR type.");
        var getPinnableReference = sourceClr.GetMethod(
            "GetPinnableReference",
            BindingFlags.Public | BindingFlags.Instance,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null)
            ?? throw new InvalidOperationException(
                $"Type '{sourceClr.FullName}' has no public instance GetPinnableReference() method.");

        // Spill the source value to a local so its address can feed the
        // instance call (`this` of a value-type method is a managed pointer).
        this.EmitExpression(node.PinnedSource);
        this.il.StoreLocal(sourceSlot);
        this.il.LoadLocalAddress(sourceSlot);
        this.il.OpCode(ILOpCode.Call);

        // Issue #2838: encode the parent through the SYMBOLIC source type, not
        // the `MethodInfo` alone. For `fixed p *T = span` inside a generic
        // method, `sourceClr` is the erased `Span<object>` (an open type
        // argument has no reference-context CLR type), so the plain MemberRef
        // path emitted `Span<object>::GetPinnableReference()` against a
        // `Span<!!T>` receiver — verifier-rejected `StackUnexpected`.
        // `GetMethodEntityHandle` re-encodes the parent TypeSpec from the
        // symbol's real type arguments, and falls through to the plain
        // MemberRef when the container is non-generic or fully closed.
        this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(getPinnableReference, node.PinnedSource.Type)); // -> T&
        this.il.StoreLocal(pinnedSlot);          // T& pinned = ref
        this.il.LoadLocal(pinnedSlot);
        this.EmitManagedPointerAsUnmanagedPointer(
            ((Symbols.PointerTypeSymbol)node.PointerVariable.Type).PointeeType);
        this.il.StoreLocal(pointerSlot);         // p = (T*)ref
    }

    private void EmitManagedPointerAsUnmanagedPointer(TypeSymbol pointeeType)
    {
        MethodInfo? openAsPointer = null;
        foreach (var method in typeof(System.Runtime.CompilerServices.Unsafe).GetMethods(BindingFlags.Public | BindingFlags.Static))
        {
            if (method.Name == "AsPointer"
                && method.IsGenericMethodDefinition
                && method.GetParameters().Length == 1)
            {
                openAsPointer = method;
                break;
            }
        }

        openAsPointer = Invariant.Required(openAsPointer, "Unsafe.AsPointer<T>(ref T) is available");
        var closedAsPointer = openAsPointer.MakeGenericMethod(pointeeType.ClrType ?? typeof(object));
        var symbolicTypeArguments = ImmutableArray.Create<TypeSymbol?>(pointeeType);
        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(
            closedAsPointer,
            typeArgSymbols: symbolicTypeArguments));
    }

    private void EmitTryStatement(BoundTryStatement node)
    {
        var endLabel = this.il.DefineLabel();
        var hasCatches = node.CatchClauses.Length > 0;
        var finallyBlock = node.FinallyBlock;

        if (hasCatches && finallyBlock != null)
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
            this.EmitProtectedRegion((BoundBlockStatement)finallyBlock);
            this.il.OpCode(ILOpCode.Endfinally);
            this.il.MarkLabel(finallyEnd);

            this.ControlFlow.AddFinallyRegion(outerTryStart, finallyStart, finallyStart, finallyEnd);
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
            this.EmitProtectedRegion((BoundBlockStatement)Invariant.Required(
                finallyBlock,
                "this is the no-catch branch, and the binder does not produce a try with neither catch nor finally"));
            this.il.OpCode(ILOpCode.Endfinally);
            this.il.MarkLabel(finallyEnd);

            this.ControlFlow.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
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
            var catchTypeHandle = this.outer.memberRefs.GetElementTypeToken(clause.ExceptionType);
            this.ControlFlow.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle);
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
        // Hold the scope rather than a `hasScope` bool: the slot lookup below
        // needs the key, and a separate flag would not carry its presence.
        this.goEnclosingScopes.TryGetValue(node, out var enclosingScope);
        if (enclosingScope != null)
        {
            this.il.LoadLocal(this.scopeFrameSlots[enclosingScope].Tasks);
        }

        this.EmitGoAction(node);

        var closure = this.outer.closures.GoClosureInfos[node];
        var isAsync = ClosureEmitter.IsTaskClrType(closure.InvokeMethod.Type?.ClrType);

        MethodInfo run;
        if (isAsync)
        {
            run = BclMember.Method(
                typeof(System.Threading.Tasks.Task),
                nameof(System.Threading.Tasks.Task.Run),
                typeof(Func<System.Threading.Tasks.Task>));
        }
        else
        {
            run = BclMember.Method(
                typeof(System.Threading.Tasks.Task),
                nameof(System.Threading.Tasks.Task.Run),
                typeof(Action));
        }

        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(run));

        if (enclosingScope != null)
        {
            var listType = typeof(List<System.Threading.Tasks.Task>);
            var add = BclMember.Method(listType, nameof(List<System.Threading.Tasks.Task>.Add), typeof(System.Threading.Tasks.Task));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodReference(add));
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

        var constructedClosure = closure.ConstructedClassSym;
        var closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure);

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(closureIsGeneric
            ? this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
            : ctorHandle);

        foreach (var captured in closure.CaptureFields.Keys)
        {
            var field = closure.CaptureFields[captured];
            EntityHandle fieldToken;
            if (closureIsGeneric)
            {
                fieldToken = this.outer.userTokens.ResolveFieldToken(constructedClosure, field);
            }
            else if (this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle))
            {
                fieldToken = fieldHandle;
            }
            else
            {
                throw new InvalidOperationException(
                    $"Go display field '{field.Name}' has no emitted FieldDef.");
            }

            this.il.OpCode(ILOpCode.Dup);
            this.EmitExpression(new BoundVariableExpression(null, captured));
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(fieldToken);
        }

        var isAsync = ClosureEmitter.IsTaskClrType(closure.InvokeMethod.Type?.ClrType);
        var invokeToken = closureIsGeneric
            ? this.outer.userTokens.ResolveClosureInvokeFtnToken(constructedClosure, closure.ClassSym, closure.InvokeMethod)
            : invokeHandle;

        if (isAsync)
        {
            var funcTaskCtor = BclMember.Ctor(typeof(Func<System.Threading.Tasks.Task>), typeof(object), typeof(nint));
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(invokeToken);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.memberRefs.GetCtorReference(funcTaskCtor));
        }
        else
        {
            var actionCtor = BclMember.Ctor(typeof(Action), typeof(object), typeof(nint));
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(invokeToken);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(this.outer.memberRefs.GetCtorReference(actionCtor));
        }
    }

    private void EmitScopeStatement(BoundScopeStatement node)
    {
        var slots = this.scopeFrameSlots[node];
        var listType = typeof(List<System.Threading.Tasks.Task>);
        var listCtor = BclMember.Ctor(listType);
        var ctsCtor = BclMember.Ctor(typeof(System.Threading.CancellationTokenSource));

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.memberRefs.GetCtorReference(listCtor));
        this.il.StoreLocal(slots.Tasks);

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctsCtor));
        this.il.StoreLocal(slots.Cts);

        var tryStart = this.il.DefineLabel();
        var finallyStart = this.il.DefineLabel();
        var finallyEnd = this.il.DefineLabel();
        var endLabel = this.il.DefineLabel();

        this.il.MarkLabel(tryStart);

        // Issue #1615: the scope body is a protected region just like a
        // try block — `return`/`break`/`goto` out of it must emit `leave`,
        // not a bare `ret`/`br`. EmitProtectedRegion pushes the body's label
        // set so region-crossing gotos are translated to `leave`.
        this.EmitProtectedRegion((BoundBlockStatement)node.Body);
        this.il.Branch(ILOpCode.Leave, endLabel);

        this.il.MarkLabel(finallyStart);
        this.EmitScopeWaitAndDispose(slots);
        this.il.OpCode(ILOpCode.Endfinally);
        this.il.MarkLabel(finallyEnd);
        this.il.MarkLabel(endLabel);

        this.ControlFlow.AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd);
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
        var cancel = BclMember.Method(
            typeof(System.Threading.CancellationTokenSource),
            nameof(System.Threading.CancellationTokenSource.Cancel),
            Type.EmptyTypes);
        this.il.LoadLocal(slots.Cts);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(cancel));
        this.il.OpCode(ILOpCode.Rethrow);
        this.il.MarkLabel(catchEnd);

        this.il.MarkLabel(disposeStart);
        var dispose = BclMember.Method(
            typeof(System.Threading.CancellationTokenSource),
            nameof(System.Threading.CancellationTokenSource.Dispose),
            Type.EmptyTypes);
        this.il.LoadLocal(slots.Cts);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(dispose));
        this.il.OpCode(ILOpCode.Endfinally);
        this.il.MarkLabel(disposeEnd);
        this.il.MarkLabel(afterNested);

        this.ControlFlow.AddCatchRegion(
            innerTryStart,
            innerTryEnd,
            catchStart,
            catchEnd,
            (EntityHandle)this.outer.memberRefs.GetTypeReference(typeof(Exception)));
        this.ControlFlow.AddFinallyRegion(outerTryStart, disposeStart, disposeStart, disposeEnd);
    }

    private void EmitScopeWait((int Tasks, int Cts, int Awaiter) slots)
    {
        var listType = typeof(List<System.Threading.Tasks.Task>);
        var toArray = BclMember.Method(listType, nameof(List<System.Threading.Tasks.Task>.ToArray), Type.EmptyTypes);
        var whenAll = BclMember.Method(
            typeof(System.Threading.Tasks.Task),
            nameof(System.Threading.Tasks.Task.WhenAll),
            typeof(System.Threading.Tasks.Task[]));
        var getAwaiter = BclMember.Method(
            typeof(System.Threading.Tasks.Task),
            nameof(System.Threading.Tasks.Task.GetAwaiter),
            Type.EmptyTypes);
        var getResult = BclMember.Method(
            typeof(System.Runtime.CompilerServices.TaskAwaiter),
            nameof(System.Runtime.CompilerServices.TaskAwaiter.GetResult),
            Type.EmptyTypes);

        this.il.LoadLocal(slots.Tasks);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(toArray));
        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(whenAll));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(getAwaiter));
        this.il.StoreLocal(slots.Awaiter);
        this.il.LoadLocalAddress(slots.Awaiter);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.memberRefs.GetMethodReference(getResult));
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

            this.EmitExpression(Invariant.Required(arm.Channel, "a send or receive select arm binds a channel expression; only the default arm has none"));
            this.il.StoreLocal(slots.ChannelSlots[i]);
            if (arm.CaseKind == SelectCaseKind.Send)
            {
                this.EmitExpression(Invariant.Required(arm.Value, "a send arm binds the value being sent; the one shape that does not -- the binder's recovery arm for an unbindable channel -- reported a diagnostic, so emit never runs"));
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
        var chType = (ChannelTypeSymbol)Invariant.Required(arm.Channel, "a send or receive select arm binds a channel expression; only the default arm has none").Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
        var getReader = BclMember.Getter(channelClr, "Reader");
        var tryRead = BclMember.Method(readerClr, "TryRead", elementClr.MakeByRefType());
        var completion = BclMember.Getter(readerClr, "Completion");
        var isCompleted = BclMember.Getter(typeof(System.Threading.Tasks.Task), "IsCompleted");

        this.il.LoadLocal(slots.ChannelSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(getReader, chType.ElementType));
        this.il.LoadLocalAddress(slots.OutSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(tryRead, chType.ElementType));
        this.il.Branch(ILOpCode.Brfalse, closedLabel);
        this.EmitSelectReceiveArmBody(arm, slots.OutSlots[index]);
        this.il.Branch(ILOpCode.Br, endLabel);

        this.il.MarkLabel(closedLabel);
        this.il.LoadLocal(slots.ChannelSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(getReader, chType.ElementType));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(completion, chType.ElementType));
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(isCompleted));
        this.il.Branch(ILOpCode.Brfalse, nextLabel);
        this.EmitZeroInit(slots.OutSlots[index], chType.ElementType, elementClr);
        this.EmitSelectReceiveArmBody(arm, slots.OutSlots[index]);
        this.il.Branch(ILOpCode.Br, endLabel);
        this.il.MarkLabel(nextLabel);
    }

    private void EmitSelectReceiveArmBody(BoundSelectCase arm, int outSlot)
    {
        FieldSymbol? hoistedField = null;
        if (arm.Variable != null
            && ((this.asyncFieldMap != null && this.asyncFieldMap.TryGetHoistedField(arm.Variable, out hoistedField))
                || (this.iteratorEmitCtx != null && this.iteratorEmitCtx.FieldMap.TryGetValue(arm.Variable, out hoistedField))))
        {
            // TryRead writes through the local out slot; the rewritten
            // MoveNext arm body reads the hoisted state-machine field.
            this.il.OpCode(ILOpCode.Ldarg_0);
            this.il.LoadLocal(outSlot);
            this.il.OpCode(ILOpCode.Stfld);
            this.il.Token(this.ResolveCurrentStateMachineFieldToken(hoistedField));
        }

        this.EmitStatement(arm.Body);
    }

    private void EmitSelectSendProbe(
        BoundSelectCase arm,
        SelectSlots slots,
        int index,
        LabelHandle endLabel)
    {
        var nextLabel = this.il.DefineLabel();
        var chType = (ChannelTypeSymbol)Invariant.Required(arm.Channel, "a send or receive select arm binds a channel expression; only the default arm has none").Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
        var getWriter = BclMember.Getter(channelClr, "Writer");
        var tryWrite = BclMember.Method(writerClr, "TryWrite", elementClr);

        this.il.LoadLocal(slots.ChannelSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(getWriter, chType.ElementType));
        this.il.LoadLocal(slots.ValueSlots[index]);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(tryWrite, chType.ElementType));
        this.il.Branch(ILOpCode.Brfalse, nextLabel);
        this.EmitStatement(arm.Body);
        this.il.Branch(ILOpCode.Br, endLabel);
        this.il.MarkLabel(nextLabel);
    }

    private void EmitSelectWait(BoundSelectStatement node, SelectSlots slots)
    {
        var taskType = TypeSymbol.FromClrType(typeof(System.Threading.Tasks.Task));
        var whenAny = BclMember.Method(
            typeof(System.Threading.Tasks.Task),
            nameof(System.Threading.Tasks.Task.WhenAny),
            typeof(System.Threading.Tasks.Task[]));
        var taskOfTask = typeof(System.Threading.Tasks.Task<System.Threading.Tasks.Task>);
        var getAwaiter = BclMember.Method(taskOfTask, "GetAwaiter", Type.EmptyTypes);
        var awaiter = typeof(System.Runtime.CompilerServices.TaskAwaiter<System.Threading.Tasks.Task>);
        var getResult = BclMember.Method(awaiter, "GetResult", Type.EmptyTypes);

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
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(taskType));
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
        this.il.Call(this.outer.memberRefs.GetMethodEntityHandle(whenAny));
        this.il.StoreLocal(slots.WhenAnyTaskSlot);
        this.il.LoadLocal(slots.WhenAnyTaskSlot);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(getAwaiter));
        this.il.StoreLocal(slots.WhenAnyAwaiterSlot);
        this.il.LoadLocalAddress(slots.WhenAnyAwaiterSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.memberRefs.GetMethodReference(getResult));
        this.il.StoreLocal(slots.CompletedTaskSlot);
    }

    private void EmitSelectWaitTask(BoundSelectCase arm, SelectSlots slots, int index)
    {
        var chType = (ChannelTypeSymbol)Invariant.Required(arm.Channel, "a send or receive select arm binds a channel expression; only the default arm has none").Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var valueTaskBool = typeof(System.Threading.Tasks.ValueTask<bool>);
        var asTask = BclMember.Method(valueTaskBool, "AsTask", Type.EmptyTypes);

        if (arm.CaseKind == SelectCaseKind.Send)
        {
            var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
            var getWriter = BclMember.Getter(channelClr, "Writer");
            var waitToWrite = BclMember.Method(writerClr, "WaitToWriteAsync", typeof(System.Threading.CancellationToken));
            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.GetChannelMethodEntityHandle(getWriter, chType.ElementType));
            this.EmitCancellationTokenNone();
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.GetChannelMethodEntityHandle(waitToWrite, chType.ElementType));
        }
        else
        {
            var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
            var getReader = BclMember.Getter(channelClr, "Reader");
            var waitToRead = BclMember.Method(readerClr, "WaitToReadAsync", typeof(System.Threading.CancellationToken));
            this.il.LoadLocal(slots.ChannelSlots[index]);
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.GetChannelMethodEntityHandle(getReader, chType.ElementType));
            this.EmitCancellationTokenNone();
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.GetChannelMethodEntityHandle(waitToRead, chType.ElementType));
        }

        this.il.StoreLocal(slots.WaitValueTaskSlot);
        this.il.LoadLocalAddress(slots.WaitValueTaskSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.memberRefs.GetMethodReference(asTask));
    }

    private void EmitChannelSendStatement(BoundChannelSendStatement node)
    {
        var chType = (ChannelTypeSymbol)node.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
        var getWriter = BclMember.Getter(channelClr, "Writer");
        var writeAsync = BclMember.Method(writerClr, "WriteAsync", elementClr, typeof(System.Threading.CancellationToken));
        var asTaskNonGeneric = BclMember.Method(typeof(System.Threading.Tasks.ValueTask), "AsTask", Type.EmptyTypes);
        var getAwaiter = BclMember.Method(typeof(System.Threading.Tasks.Task), "GetAwaiter", Type.EmptyTypes);
        var getResult = BclMember.Method(typeof(System.Runtime.CompilerServices.TaskAwaiter), "GetResult", Type.EmptyTypes);

        var (vtSlot, taSlot, _, _) = this.channelOpSlots[node];

        this.EmitExpression(node.Channel);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(getWriter, chType.ElementType));

        this.EmitExpression(node.Value);
        this.EmitCancellationTokenNone();

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.GetChannelMethodEntityHandle(writeAsync, chType.ElementType));

        this.il.StoreLocal(vtSlot);
        this.il.LoadLocalAddress(vtSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.memberRefs.GetMethodReference(asTaskNonGeneric));

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(getAwaiter));
        this.il.StoreLocal(taSlot);
        this.il.LoadLocalAddress(taSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.memberRefs.GetMethodReference(getResult));
    }
}
