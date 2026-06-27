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
        // ADR-0087 §3 R3+R4: when the constructed type is a user-declared
        // generic type, every newobj must reference the ctor via a
        // MemberRef parented at the TypeSpec for the construction. The
        // R0/R1 erasure-era box at TypeParameterSymbol parameter slots
        // is dropped — the parameter's signature is `!0` and resolves
        // through the parent TypeSpec to the concrete arg type.
        bool isGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(call.StructType);

        EntityHandle ctorHandle;
        if (call.SelectedConstructor != null
            && this.outer.cache.ExplicitCtorHandles.ContainsKey(call.SelectedConstructor))
        {
            // ADR-0063 §9: bind-time overload resolution picked this exact
            // ctor; emit a newobj against its specific MethodDef (or a
            // MemberRef on the constructed TypeSpec for a generic type).
            ctorHandle = isGeneric
                ? this.outer.ResolveUserCtorTokenForExplicit(call.StructType, call.SelectedConstructor)
                : this.outer.cache.ExplicitCtorHandles[call.SelectedConstructor];
        }
        else if (this.outer.cache.ClassPrimaryCtorHandles.ContainsKey(call.StructType.Definition ?? call.StructType))
        {
            ctorHandle = isGeneric
                ? this.outer.ResolveUserCtorTokenForPrimary(call.StructType)
                : this.outer.cache.ClassPrimaryCtorHandles[call.StructType];
        }
        else if (call.Arguments.IsDefaultOrEmpty
            && this.outer.cache.ClassCtorHandles.ContainsKey(call.StructType.Definition ?? call.StructType))
        {
            // Issue #523: synthesized classes (e.g. capture boxes) declare
            // no primary constructor; for a zero-argument newobj we fall
            // back to the parameterless default ctor that PHASE B emitted
            // into classCtorHandles.
            ctorHandle = isGeneric
                ? this.outer.ResolveUserCtorTokenForDefault(call.StructType)
                : this.outer.cache.ClassCtorHandles[call.StructType];
        }
        else
        {
            throw new InvalidOperationException(
                $"Type '{call.StructType.Name}' has no emitted primary ctor.");
        }

        for (int i = 0; i < call.Arguments.Length; i++)
        {
            var arg = call.Arguments[i];
            this.EmitExpression(arg);
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
        // Issue #1052: a call dispatched through a type parameter's
        // user-declared interface constraint (e.g. `x.Area()` with
        // `T : IShape`) emits a verifiable
        // `constrained. !!T  callvirt IShape::Area()` — mirroring the imported
        // CLR-interface path (issue #943). Without the `constrained.` prefix a
        // bare `callvirt` on the unboxed type parameter corrupts the stack and
        // crashes at runtime.
        if (call.IsConstrainedTypeParameterCall)
        {
            this.EmitConstrainedTypeParameterReceiver(call.Receiver);
            for (var i = 0; i < call.Arguments.Length; i++)
            {
                this.EmitExpression(call.Arguments[i]);
            }

            var constraintInterface = (call.ConstrainedInterfaceType as InterfaceSymbol)
                ?? (call.Method.ReceiverType as InterfaceSymbol);
            var openMethod = constraintInterface != null
                ? ResolveOpenInterfaceMethod(constraintInterface, call.Method)
                : call.Method;
            var constrainedMethodToken = constraintInterface != null
                ? this.outer.ResolveUserInterfaceInstanceMethodToken(constraintInterface, openMethod)
                : this.outer.cache.MethodHandles[call.Method];

            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.GetElementTypeToken(call.ConstrainedReceiverTypeParameter));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(constrainedMethodToken);
            return;
        }

        // ADR-0087 §3 R3+R4: when the receiver is a constructed
        // generic user type, the method must be referenced via a
        // MemberRef parented at the constructed TypeSpec (e.g.
        // `Container`1<int32>`, not the open `Container`1<!0>`).
        // Use the receiver expression's type — `Method.ReceiverType`
        // is the OPEN class symbol from declaration, which yields the
        // wrong (open) TypeSpec for the parent. The R0/R1 box at
        // TypeParameterSymbol parameter slots is dropped: the method
        // signature is `!0`/`!!0` and resolves through the parent
        // TypeSpec.
        var receiverType = (call.Receiver.Type as StructSymbol) ?? (call.Method.ReceiverType as StructSymbol);
        bool isGenericReceiver = receiverType != null
            && ReflectionMetadataEmitter.IsUserGenericTypeReference(receiverType);

        // ADR-0087 R5 / issue #765: same TypeSpec-parenting requirement
        // for a call dispatched through a user-declared generic interface
        // receiver (e.g. `b: IBox[int32]; b.Get()`). The call's
        // <c>Method</c> on a constructed interface is the substituted
        // <c>FunctionSymbol</c>, which is NOT keyed in
        // <c>cache.MethodHandles</c>; we therefore resolve back to the
        // open method on the definition and produce a MemberRef parented
        // at the constructed TypeSpec via <see cref="ResolveUserInterfaceInstanceMethodToken"/>.
        var receiverIface = call.Receiver.Type as InterfaceSymbol;

        // Issue #1254: an inherited instance method declared on a generic base
        // type, invoked through a (non-generic) derived receiver, must be
        // referenced via a MemberRef parented at the CONSTRUCTED base TypeSpec
        // (e.g. `Base`1<int32>`) — never the bare MethodDef on the open generic
        // definition, which the runtime rejects with "the containing type is
        // not fully instantiated". The `isGenericReceiver` branch already covers
        // the case where the receiver itself is the generic type.
        var inheritedGenericBase = !isGenericReceiver
            ? this.ResolveInheritedGenericBase(call.Receiver.Type as StructSymbol, call.Method)
            : null;

        EntityHandle methodHandle;
        if (isGenericReceiver)
        {
            methodHandle = this.outer.ResolveUserInstanceMethodToken(receiverType, call.Method);
        }
        else if (inheritedGenericBase != null)
        {
            methodHandle = this.outer.ResolveUserInstanceMethodToken(inheritedGenericBase, call.Method);
        }
        else if (receiverIface != null
            && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(receiverIface))
        {
            var openMethod = ResolveOpenInterfaceMethod(receiverIface, call.Method);
            methodHandle = this.outer.ResolveUserInterfaceInstanceMethodToken(receiverIface, openMethod);
        }
        else if (this.outer.cache.MethodHandles.TryGetValue(call.Method, out var defHandle))
        {
            methodHandle = defHandle;
        }
        else
        {
            throw new InvalidOperationException(
                $"Instance method '{call.Method.Name}' on '{call.Method.ReceiverType?.Name}' has no emitted handle.");
        }

        // ADR-0087 §3 R3+R4: when the method itself is generic, wrap
        // the open method token in a MethodSpec carrying the
        // substituted type arguments inferred from the call.
        if (call.Method.IsGeneric && !call.Method.TypeParameters.IsDefaultOrEmpty)
        {
            methodHandle = this.outer.BuildMethodSpecForGenericInstanceCall(methodHandle, call);
        }

        this.EmitInstanceReceiver(call.Receiver);
        var calleeParameterOffset = call.Method.ExplicitReceiverParameter == null ? 0 : 1;
        for (var i = 0; i < call.Arguments.Length; i++)
        {
            var arg = call.Arguments[i];
            this.EmitExpression(arg);
        }

        var receiverIsValueType = call.Method.ReceiverType is StructSymbol receiverStruct && !receiverStruct.IsClass;
        this.il.OpCode(receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
        this.il.Token(methodHandle);

        // ADR-0087 §3 R3+R4: after R2, a user-instance call returns the
        // method's reified signature (substituted at the TypeSpec / MethodSpec
        // level). No erasure-widening is required at the call boundary.
    }

    // Issue #1254: returns the constructed generic base instantiation that
    // declares an inherited <paramref name="method"/>, when the call's receiver
    // inherits it from a generic base (e.g. `Derived : Base[int32]` calling an
    // inherited `Base.Hello()`). Returns null when the method is not inherited
    // from a generic base — including when the receiver itself is the declaring
    // type or the declaring type is non-generic.
    private StructSymbol ResolveInheritedGenericBase(StructSymbol receiver, FunctionSymbol method)
    {
        if (receiver == null || method == null)
        {
            return null;
        }

        if (!this.outer.cache.MethodHandles.ContainsKey(method))
        {
            return null;
        }

        var declaring = method.ReceiverType as StructSymbol;
        if (declaring == null)
        {
            return null;
        }

        var declaringDef = declaring.Definition ?? declaring;
        if (declaringDef.TypeParameters.IsDefaultOrEmpty)
        {
            return null;
        }

        // Not inherited — the receiver itself declares the method.
        if (ReferenceEquals(receiver.Definition ?? receiver, declaringDef))
        {
            return null;
        }

        return receiver.FindConstructedGenericBase(def => ReferenceEquals(def, declaringDef));
    }

    // ADR-0087 R5 / issue #765: bridges from a substituted FunctionSymbol on
    // a constructed user interface (e.g. <c>IBox[int32].Get</c>) back to the
    // open <c>FunctionSymbol</c> on the definition so the emitter can look
    // up its <c>MethodHandle</c> and parent the resulting MemberRef at the
    // constructed TypeSpec.
    private static FunctionSymbol ResolveOpenInterfaceMethod(InterfaceSymbol receiverIface, FunctionSymbol substitutedMethod)
    {
        var def = receiverIface.Definition ?? receiverIface;
        if (ReferenceEquals(def, receiverIface))
        {
            return substitutedMethod;
        }

        var instanceMethods = receiverIface.Methods;
        for (var i = 0; i < instanceMethods.Length; i++)
        {
            if (ReferenceEquals(instanceMethods[i], substitutedMethod) && i < def.Methods.Length)
            {
                return def.Methods[i];
            }
        }

        var staticMethods = receiverIface.StaticMethods;
        for (var i = 0; i < staticMethods.Length; i++)
        {
            if (ReferenceEquals(staticMethods[i], substitutedMethod) && i < def.StaticMethods.Length)
            {
                return def.StaticMethods[i];
            }
        }

        var privateMethods = receiverIface.PrivateMethods;
        for (var i = 0; i < privateMethods.Length; i++)
        {
            if (ReferenceEquals(privateMethods[i], substitutedMethod) && i < def.PrivateMethods.Length)
            {
                return def.PrivateMethods[i];
            }
        }

        var staticPrivateMethods = receiverIface.StaticPrivateMethods;
        for (var i = 0; i < staticPrivateMethods.Length; i++)
        {
            if (ReferenceEquals(staticPrivateMethods[i], substitutedMethod) && i < def.StaticPrivateMethods.Length)
            {
                return def.StaticPrivateMethods[i];
            }
        }

        // Fall back to name-and-arity matching (substitution path may have
        // produced new param symbols whose identity differs from the open
        // declarations).
        foreach (var m in def.Methods)
        {
            if (m.Name == substitutedMethod.Name && m.Parameters.Length == substitutedMethod.Parameters.Length)
            {
                return m;
            }
        }

        return substitutedMethod;
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

        // ADR-0087 §3 R6: a delegate whose parameter or return types
        // reference open type parameters (e.g. `func(T) U`) is now
        // encoded as a reified `GENERICINST<Func`N><…>` shape. Dispatch
        // through a MemberRef parented at that TypeSpec — the runtime
        // delegate (e.g. `Func<int, int>`) resolves the MemberRef to
        // its concrete `Invoke` slot, so no `Delegate.DynamicInvoke`
        // marshalling is needed.
        if (call.FunctionType.ClrType == null)
        {
            this.EmitExpression(call.Target);
            foreach (var arg in call.Arguments)
            {
                this.EmitExpression(arg);
            }

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.GetFunctionDelegateInvokeRef(call.FunctionType));
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

    // ADR-0087 §3 R6: `EmitOpenDelegateDynamicInvoke` retired. Every
    // call site over an open-bearing `FunctionTypeSymbol` now dispatches
    // through a `callvirt` to a MemberRef parented at the reified
    // `Func<...>` / `Action<...>` TypeSpec (see EmitIndirectCall and
    // ReflectionMetadataEmitter.GetFunctionDelegateInvokeRef). The
    // runtime delegate's concrete `Invoke` slot is resolved by the CLR
    // when the substituted Var/MVar slots become concrete, so the
    // historical `Delegate.DynamicInvoke` adapter is no longer required.

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
                && m.GetParameters()[0].ParameterType.IsSameAs(typeof(System.Threading.Channels.BoundedChannelOptions)));
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

    /// <summary>
    /// ADR-0089 / issue #755: emit a constrained static-virtual call —
    /// <c>constrained. !!T  call !iface::Method(args)</c>. The receiver
    /// type-parameter is encoded as a TypeSpec (VAR or MVAR); the interface
    /// method is encoded as a MemberRef whose parent is the (constructed)
    /// interface TypeRef/TypeSpec. ECMA-335 §III.2.1 specifies that
    /// `constrained.` may prefix `call` (not just `callvirt`) when the
    /// target is a static-virtual interface method.
    /// </summary>
    /// <param name="call">The bound call to emit.</param>
    private void EmitConstrainedStaticCall(BoundConstrainedStaticCallExpression call)
    {
        // Emit arguments left-to-right.
        for (int i = 0; i < call.Arguments.Length; i++)
        {
            this.EmitExpression(call.Arguments[i]);
        }

        // Resolve the constraint type-parameter element token (TypeSpec
        // naming VAR(n) for type-type parameters, MVAR(n) for
        // method-type parameters). GetElementTypeToken already handles
        // both shapes via TypeParameterSymbol.IsMethodTypeParameter.
        var typeParamToken = this.outer.GetElementTypeToken(call.TypeParameter);

        // Resolve the interface static-virtual member handle. The
        // BoundConstrainedStaticCallExpression carries the *interface
        // slot* FunctionSymbol; MethodHandles maps interface slots to
        // their planned MethodDef rows.
        //
        // Issue #1268: when the constraint is a constructed generic
        // interface (e.g. `T : IData[int32]` or the self-referential
        // `T : IData[T]`), the bound slot is either the substituted
        // static method on the constructed instance (methods) or the open
        // definition's static-virtual property getter (properties).
        // Neither is keyed in `cache.MethodHandles` against the
        // *constructed* interface, so the target must be encoded as a
        // MemberRef parented at the constructed interface's TypeSpec — the
        // same way constructed-generic instance interface calls are emitted
        // (ADR-0087 R5 / issue #765). Resolve back to the open definition
        // slot and parent the MemberRef at the constructed TypeSpec.
        var constraintIface = call.TypeParameter.InterfaceConstraint;
        EntityHandle slotHandle;
        if (constraintIface != null
            && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(constraintIface))
        {
            var openSlot = ResolveOpenInterfaceMethod(constraintIface, call.InterfaceMethod);
            slotHandle = this.outer.ResolveUserInterfaceInstanceMethodToken(constraintIface, openSlot);
        }
        else if (this.outer.cache.MethodHandles.TryGetValue(call.InterfaceMethod, out var slotDef))
        {
            slotHandle = slotDef;
        }
        else
        {
            throw new InvalidOperationException(
                $"Static-virtual interface method '{call.InterfaceMethod.Name}' has no emitted handle.");
        }

        this.il.OpCode(ILOpCode.Constrained);
        this.il.Token(typeParamToken);
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(slotHandle);
    }

    /// <summary>
    /// ADR-0091: emits an explicit-base interface call
    /// <c>base[IFoo].M(args)</c>. The receiver is the implicit
    /// <c>this</c> (the implementing class); the call uses
    /// <c>call instance</c> (non-virtual) so the inherited
    /// default body on <c>IFoo</c> is invoked directly rather
    /// than re-dispatched through the v-table (which would re-enter
    /// the override and cause infinite recursion).
    /// </summary>
    /// <param name="call">The bound base-interface call to emit.</param>
    private void EmitBaseInterfaceCall(BoundBaseInterfaceCallExpression call)
    {
        // Load `this` (the implementing class instance).
        this.EmitInstanceReceiver(call.Receiver);

        // Evaluate each argument left-to-right.
        foreach (var arg in call.Arguments)
        {
            this.EmitExpression(arg);
        }

        // Resolve the right token for the interface's default-body MethodDef.
        // Non-generic interfaces: bare MethodDef. Generic interfaces:
        // MemberRef parented at the constructed TypeSpec.
        var methodToken = this.outer.ResolveUserInterfaceInstanceMethodToken(call.Interface, call.Method);

        // ADR-0091: non-virtual `call`, NOT `callvirt`. Using callvirt would
        // re-dispatch through the v-table and re-enter the same override
        // that issued the base-call.
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(methodToken);
    }

    // Issue #986: emits `base.M(args)` (and `base[BaseClass].M(args)`) as a
    // non-virtual `call instance R BaseClass::M(...)`. The receiver is `this`
    // (the derived instance); because the opcode is `call` (not `callvirt`)
    // the CLR resolves statically to the base implementation, bypassing the
    // v-table. This is exactly the IL shape `csc` produces for C# `base.M()`.
    private void EmitBaseClassCall(BoundBaseClassCallExpression call)
    {
        // Load `this` (the derived instance).
        this.EmitInstanceReceiver(call.Receiver);

        // Evaluate each argument left-to-right.
        for (var i = 0; i < call.Arguments.Length; i++)
        {
            this.EmitExpression(call.Arguments[i]);
        }

        // Resolve the MethodDef of the base implementation. For a non-generic
        // base this is the bare MethodDef row; for a constructed generic base
        // it is a MemberRef parented at the base TypeSpec.
        // Issue #1254: when the base is named by its OPEN generic definition
        // (no type arguments) — as it is for an inherited method whose
        // declaring type is generic — resolve the CONSTRUCTED base
        // instantiation from the receiver's hierarchy so the MemberRef is
        // parented at e.g. `Base`1<int32>` rather than the open `Base`1<!0>`
        // (which the runtime rejects with BadImageFormat / "not fully
        // instantiated").
        var baseClass = call.BaseClass;
        if (baseClass != null
            && baseClass.TypeArguments.IsDefaultOrEmpty
            && !baseClass.TypeParameters.IsDefaultOrEmpty
            && call.Receiver.Type is StructSymbol baseReceiver)
        {
            var baseDef = baseClass.Definition ?? baseClass;
            var constructedBase = baseReceiver.FindConstructedGenericBase(d => ReferenceEquals(d, baseDef));
            if (constructedBase != null)
            {
                baseClass = constructedBase;
            }
        }

        var methodToken = this.outer.ResolveUserInstanceMethodToken(baseClass, call.Method);

        // Issue #986: non-virtual `call`, NOT `callvirt`. callvirt would
        // re-dispatch through the v-table and re-enter the derived override.
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(methodToken);
    }
}
