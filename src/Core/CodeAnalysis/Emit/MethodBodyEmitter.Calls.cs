// <copyright file="MethodBodyEmitter.Calls.cs" company="GSharp">
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
/// constructor / instance / indirect / channel call emission.
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

    private void EmitConstructorCall(BoundConstructorCallExpression call)
    {
        MethodDefinitionHandle ctorHandle;
        if (call.SelectedConstructor != null
            && this.outer.cache.ExplicitCtorHandles.TryGetValue(call.SelectedConstructor, out var selectedHandle))
        {
            // ADR-0063 §9: bind-time overload resolution picked this exact
            // ctor; emit a newobj against its specific MethodDef.
            ctorHandle = selectedHandle;
        }
        else if (!this.outer.cache.ClassPrimaryCtorHandles.TryGetValue(call.StructType, out ctorHandle))
        {
            // Issue #523: synthesized classes (e.g. capture boxes) declare
            // no primary constructor; for a zero-argument newobj we fall
            // back to the parameterless default ctor that PHASE B emitted
            // into classCtorHandles.
            if (call.Arguments.IsDefaultOrEmpty
                && this.outer.cache.ClassCtorHandles.TryGetValue(call.StructType, out var defaultCtorHandle))
            {
                ctorHandle = defaultCtorHandle;
            }
            else
            {
                throw new InvalidOperationException(
                    $"Type '{call.StructType.Name}' has no emitted primary ctor.");
            }
        }

        // Phase 4 emit parity (F2, type-erased generic user types): the
        // primary ctor is emitted on the definition with each T-typed
        // parameter encoded as System.Object. When the call site uses
        // a constructed instance, value-type arguments crossing into
        // those parameters must be boxed at the boundary.
        var def = call.StructType.Definition ?? call.StructType;
        var defParams = def.PrimaryConstructorParameters;
        for (int i = 0; i < call.Arguments.Length; i++)
        {
            var arg = call.Arguments[i];
            this.EmitExpression(arg);

            if (i < defParams.Length
                && defParams[i].Type is TypeParameterSymbol
                && arg.Type is not TypeParameterSymbol
                && ReflectionMetadataEmitter.IsValueTypeSymbol(arg.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(arg.Type));
            }
        }

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(ctorHandle);
    }

    /// <summary>
    /// ADR-0065 §2: emits the CIL for a <c>init(args)</c> self-delegation
    /// statement that appears inside a <c>convenience init(...)</c> body.
    /// Lowered to <c>ldarg.0; &lt;args&gt;; call &lt;ctor&gt;</c> chaining to a
    /// sibling constructor on the same class.
    /// </summary>
    /// <param name="call">The bound chaining expression to emit.</param>
    private void EmitConstructorChaining(BoundConstructorChainingExpression call)
    {
        if (call.SelectedConstructor == null
            || !this.outer.cache.ExplicitCtorHandles.TryGetValue(call.SelectedConstructor, out var ctorHandle))
        {
            throw new InvalidOperationException(
                $"Constructor chaining target on '{call.SelectedConstructor?.DeclaringType?.Name}' has no emitted handle.");
        }

        // Load `this` then evaluate each argument in order. Parameters of a
        // user-authored init can never be type parameters today, so the
        // value-type-to-System.Object boxing dance that EmitConstructorCall
        // performs is unnecessary here.
        this.il.LoadArgument(0);
        foreach (var arg in call.Arguments)
        {
            this.EmitExpression(arg);
        }

        this.il.OpCode(ILOpCode.Call);
        this.il.Token(ctorHandle);
    }

    private void EmitUserInstanceCall(BoundUserInstanceCallExpression call)
    {
        if (!this.outer.cache.MethodHandles.TryGetValue(call.Method, out var methodHandle))
        {
            throw new InvalidOperationException(
                $"Instance method '{call.Method.Name}' on '{call.Method.ReceiverType?.Name}' has no emitted handle.");
        }

        this.EmitInstanceReceiver(call.Receiver);
        var calleeParameterOffset = call.Method.ExplicitReceiverParameter == null ? 0 : 1;
        for (var i = 0; i < call.Arguments.Length; i++)
        {
            var arg = call.Arguments[i];
            this.EmitExpression(arg);

            // Issue #312 (emit parity, type-erased generics): a parameter
            // typed as an open type parameter is encoded as System.Object,
            // so value-type arguments must be boxed at the call boundary to
            // match the emitted signature.
            var paramType = call.Method.Parameters[i + calleeParameterOffset].Type;
            if (paramType is TypeParameterSymbol
                && arg.Type is not TypeParameterSymbol
                && ReflectionMetadataEmitter.IsValueTypeSymbol(arg.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(arg.Type));
            }
        }

        var receiverIsValueType = call.Method.ReceiverType is StructSymbol receiverStruct && !receiverStruct.IsClass;
        this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
        this.il.Token(methodHandle);

        this.EmitErasedObjectReturnWidening(call.Method.Type, call.Type);
    }

    private void EmitClrConstructorCall(BoundClrConstructorCallExpression ctorCall)
    {
        // Phase 4 emit parity: `newobj` against a CLR ctor. Handles both
        // non-generic types and constructed generic types — the parent of
        // the MemberRef becomes a TypeSpec for the latter, encoded in
        // `GetCtorReference` / `GetTypeHandleForMember`.
        // Issue #368: honour by-ref/out argument ref-kinds (e.g. an
        // interpolated-string handler whose constructor takes `out bool
        // shouldAppend`) by emitting the argument address.
        if (!ctorCall.ArgumentRefKinds.IsDefaultOrEmpty)
        {
            this.EmitImportedCallArguments(ctorCall.Arguments, ctorCall.ArgumentRefKinds);
        }
        else
        {
            foreach (var arg in ctorCall.Arguments)
            {
                this.EmitExpression(arg);
            }
        }

        // Issue #671: when the ctor target's containing type carries G#
        // user-defined symbolic type arguments (closed with System.Object at
        // the CLR layer because the user type's TypeDef is only produced
        // during emit), build the MemberRef against a parent TypeSpec encoded
        // with the symbolic args. Without this the `newobj` would target the
        // type-erased `Open<object,…>::.ctor`, which fails IL verification
        // against the locally-typed `Open<MyGs,…>` slot.
        var ctorRef = this.outer.GetCtorReference(ctorCall.Constructor, ctorCall.Type);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(ctorRef);
    }

    // Phase 4 emit parity (E1): indirect call through a func-typed value.
    // Evaluates the target (pushes the delegate on the stack), evaluates
    // each argument, then calls the delegate's `Invoke` method via
    // `callvirt`.
    private void EmitIndirectCall(BoundIndirectCallExpression call)
    {
        // ADR-0059 / issue #255: a call through a value typed as a
        // user-declared named delegate dispatches through that delegate's
        // emitted Invoke MethodDef directly (no DynamicInvoke marshalling
        // needed — the signature is concrete, not type-erased).
        if (call.Target.Type is DelegateTypeSymbol namedDelegate)
        {
            if (!this.outer.cache.DelegateInvokeHandles.TryGetValue(namedDelegate, out var namedInvokeHandle))
            {
                throw new InvalidOperationException(
                    $"Delegate '{namedDelegate.Name}' has no emitted Invoke MethodDef.");
            }

            this.EmitExpression(call.Target);
            foreach (var arg in call.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(namedInvokeHandle);
            return;
        }

        // Phase 4 emit parity (F1, type-erased generics): a delegate whose
        // parameter or return types reference open type parameters (e.g.
        // `func(T) U`) is encoded as `System.Func<object, object>`, but the
        // runtime instance is a concrete delegate (e.g. `Func<int, int>`).
        // Invoking it through `Func<object, object>.Invoke` would feed the
        // concrete target boxed objects it cannot unbox, corrupting memory.
        // Route the call through `System.Delegate.DynamicInvoke`, which
        // marshals boxing / unboxing of value-type arguments and the return
        // value correctly across the erased boundary.
        if (call.FunctionType.ClrType == null)
        {
            this.EmitOpenDelegateDynamicInvoke(call);
            return;
        }

        this.EmitExpression(call.Target);
        foreach (var arg in call.Arguments)
        {
            this.EmitExpression(arg);
        }

        var delegateType = this.outer.ResolveDelegateClrType(call.FunctionType);

        var invoke = delegateType.GetMethod("Invoke")
            ?? throw new InvalidOperationException(
                $"Delegate type '{delegateType.FullName}' has no Invoke method.");

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(invoke));
    }

    // Invoke a type-erased open delegate (func(T) U over open type
    // parameters) via System.Delegate.DynamicInvoke(object[]). Builds a
    // boxed-argument array, calls DynamicInvoke, and leaves the boxed
    // result (System.Object) on the stack; the caller's existing erased
    // return handling unboxes when the substituted return is a value type.
    private void EmitOpenDelegateDynamicInvoke(BoundIndirectCallExpression call)
    {
        this.EmitExpression(call.Target);

        this.il.LoadConstantI4(call.Arguments.Length);
        this.il.OpCode(ILOpCode.Newarr);
        this.il.Token(this.outer.wellKnown.ObjectTypeRef);

        for (int i = 0; i < call.Arguments.Length; i++)
        {
            var arg = call.Arguments[i];
            this.il.OpCode(ILOpCode.Dup);
            this.il.LoadConstantI4(i);
            this.EmitExpression(arg);

            // Value-type arguments must be boxed into the object[] slot.
            // Open type-parameter arguments already flow as System.Object.
            if (arg.Type is not TypeParameterSymbol && ReflectionMetadataEmitter.IsValueTypeSymbol(arg.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(arg.Type));
            }

            this.il.OpCode(ILOpCode.Stelem_ref);
        }

        var delegateClrType = this.outer.emitCtx.References.GetCoreType("System.Delegate");
        var dynamicInvoke = delegateClrType.GetMethod("DynamicInvoke")
            ?? throw new InvalidOperationException(
                "System.Delegate has no DynamicInvoke method.");

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(dynamicInvoke));

        // Issue #418 (P1-6): Delegate.DynamicInvoke always returns object.
        // For an erased void-returning delegate (`func(T)` with no return),
        // the BoundIndirectCallExpression.Type is Void, so the surrounding
        // BoundExpressionStatement skips its usual Pop and the boxed result
        // would linger on the stack, producing invalid IL at the next
        // ret/leave. Absorb the unused object here.
        if (call.FunctionType.ReturnType == TypeSymbol.Void)
        {
            this.il.OpCode(ILOpCode.Pop);
        }
    }

    /// <summary>ADR-0039: Emits arguments for an imported call, respecting <see cref="RefKind"/>.</summary>
    private void EmitImportedCallArguments(ImmutableArray<BoundExpression> arguments, ImmutableArray<RefKind> refKinds)
    {
        for (int i = 0; i < arguments.Length; i++)
        {
            var rk = refKinds.IsDefault || i >= refKinds.Length ? RefKind.None : refKinds[i];
            var arg = arguments[i];

            if (rk == RefKind.Ref || rk == RefKind.Out || rk == RefKind.In)
            {
                // Argument must be BoundAddressOfExpression or (ADR-0061)
                // BoundConditionalAddressExpression; emit the address.
                if (arg is BoundAddressOfExpression addrOf)
                {
                    this.EmitAddressOf(addrOf);
                }
                else if (arg is BoundConditionalAddressExpression condAddr)
                {
                    this.EmitConditionalAddress(condAddr);
                }
                else
                {
                    // Fallback for in: emit value, but this shouldn't happen
                    // since binder requires & for all ref-kind arguments in V1.
                    this.EmitExpression(arg);
                }
            }
            else
            {
                this.EmitExpression(arg);
            }
        }
    }

    private void EmitMakeChannelExpression(BoundMakeChannelExpression node)
    {
        var elementClr = ResolveChannelElementClrType(node.ChannelType.ElementType);
        if (node.Capacity == null)
        {
            var openCreate = typeof(System.Threading.Channels.Channel)
                .GetMethods(BindingFlags.Public | BindingFlags.Static)
                .First(m => m.Name == nameof(System.Threading.Channels.Channel.CreateUnbounded)
                    && m.IsGenericMethodDefinition
                    && m.GetParameters().Length == 0);
            var create = openCreate.MakeGenericMethod(elementClr);
            this.il.Call(this.outer.GetMethodEntityHandle(create));
            return;
        }

        var optionsCtor = typeof(System.Threading.Channels.BoundedChannelOptions)
            .GetConstructor(new[] { typeof(int) });
        this.EmitExpression(node.Capacity);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(optionsCtor));

        var openBounded = typeof(System.Threading.Channels.Channel)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == nameof(System.Threading.Channels.Channel.CreateBounded)
                && m.IsGenericMethodDefinition
                && m.GetParameters().Length == 1
                && m.GetParameters()[0].ParameterType == typeof(System.Threading.Channels.BoundedChannelOptions));
        var bounded = openBounded.MakeGenericMethod(elementClr);
        this.il.Call(this.outer.GetMethodEntityHandle(bounded));
    }

    private void EmitChannelReceiveExpression(BoundChannelReceiveExpression node)
    {
        // try { result = ch.Reader.ReadAsync(default).AsTask().GetAwaiter().GetResult(); }
        // catch (ChannelClosedException) { result = default(T); }
        // ldloc result
        var chType = (ChannelTypeSymbol)node.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var readerClr = typeof(System.Threading.Channels.ChannelReader<>).MakeGenericType(elementClr);
        var getReader = channelClr.GetProperty("Reader").GetGetMethod();
        var readAsync = readerClr.GetMethod(
            "ReadAsync",
            new[] { typeof(System.Threading.CancellationToken) });

        var valueTaskGeneric = typeof(System.Threading.Tasks.ValueTask<>).MakeGenericType(elementClr);
        var asTaskGeneric = valueTaskGeneric.GetMethod("AsTask", Type.EmptyTypes);
        var taskGeneric = typeof(System.Threading.Tasks.Task<>).MakeGenericType(elementClr);
        var taskGetAwaiter = taskGeneric.GetMethod("GetAwaiter", Type.EmptyTypes);
        var taskAwaiterGeneric = typeof(System.Runtime.CompilerServices.TaskAwaiter<>).MakeGenericType(elementClr);
        var taskGetResult = taskAwaiterGeneric.GetMethod("GetResult", Type.EmptyTypes);
        var ccExceptionClr = typeof(System.Threading.Channels.ChannelClosedException);

        var (vtSlot, taSlot, resultSlot, _) = this.channelOpSlots[node];
        var tryStart = this.il.DefineLabel();
        var tryEnd = this.il.DefineLabel();
        var handlerStart = this.il.DefineLabel();
        var handlerEnd = this.il.DefineLabel();
        var endLabel = this.il.DefineLabel();

        this.il.MarkLabel(tryStart);

        this.EmitExpression(node.Channel);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getReader));

        this.EmitCancellationTokenNone();
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(readAsync));

        this.il.StoreLocal(vtSlot);
        this.il.LoadLocalAddress(vtSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(asTaskGeneric));

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(taskGetAwaiter));
        this.il.StoreLocal(taSlot);
        this.il.LoadLocalAddress(taSlot);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(this.outer.GetMethodReference(taskGetResult));
        this.il.StoreLocal(resultSlot);
        this.il.Branch(ILOpCode.Leave, endLabel);
        this.il.MarkLabel(tryEnd);

        this.il.MarkLabel(handlerStart);
        this.il.OpCode(ILOpCode.Pop);
        this.EmitZeroInit(resultSlot, chType.ElementType, elementClr);
        this.il.Branch(ILOpCode.Leave, endLabel);
        this.il.MarkLabel(handlerEnd);

        this.il.MarkLabel(endLabel);

        var catchTypeHandle = (EntityHandle)this.outer.GetTypeReference(ccExceptionClr);
        this.il.ControlFlowBuilder.AddCatchRegion(tryStart, tryEnd, handlerStart, handlerEnd, catchTypeHandle);

        this.il.LoadLocal(resultSlot);
    }

    private void EmitChannelCloseExpression(BoundChannelCloseExpression node)
    {
        var chType = (ChannelTypeSymbol)node.Channel.Type;
        var elementClr = ResolveChannelElementClrType(chType.ElementType);
        var channelClr = typeof(System.Threading.Channels.Channel<>).MakeGenericType(elementClr);
        var writerClr = typeof(System.Threading.Channels.ChannelWriter<>).MakeGenericType(elementClr);
        var getWriter = channelClr.GetProperty("Writer").GetGetMethod();
        var complete = writerClr.GetMethod("Complete", new[] { typeof(Exception) });

        this.EmitExpression(node.Channel);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(getWriter));
        this.il.OpCode(ILOpCode.Ldnull);
        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(complete));
    }

    private void EmitCancellationTokenNone()
    {
        // ldc.i4.0; newobj CancellationToken(bool) — the canonical
        // "default" CancellationToken IL pattern. Avoids needing a
        // dedicated local for `default(CancellationToken)`.
        var ctCtor = typeof(System.Threading.CancellationToken).GetConstructor(new[] { typeof(bool) });
        this.il.LoadConstantI4(0);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(ctCtor));
    }
}
