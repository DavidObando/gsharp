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
                ? this.outer.userTokens.ResolveUserCtorTokenForExplicit(call.StructType, call.SelectedConstructor)
                : this.outer.cache.ExplicitCtorHandles[call.SelectedConstructor];
        }
        else if (this.outer.cache.ClassPrimaryCtorHandles.ContainsKey(call.StructType.Definition ?? call.StructType))
        {
            ctorHandle = isGeneric
                ? this.outer.userTokens.ResolveUserCtorTokenForPrimary(call.StructType)
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
                ? this.outer.userTokens.ResolveUserCtorTokenForDefault(call.StructType)
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
    /// sibling constructor on the same aggregate.
    /// </summary>
    /// <param name="call">The bound chaining expression to emit.</param>
    private void EmitConstructorChaining(BoundConstructorChainingExpression call)
    {
        if (call.SelectedConstructor == null
            || !this.outer.cache.ExplicitCtorHandles.TryGetValue(call.SelectedConstructor, out var ctorDefHandle))
        {
            throw new InvalidOperationException(
                $"Constructor chaining target on '{call.SelectedConstructor?.DeclaringType?.Name}' has no emitted handle.");
        }

        EntityHandle ctorHandle = ctorDefHandle;

        // ADR-0087 §3 R3+R4 / issue #3932: inside a GENERIC aggregate the
        // sibling `.ctor` must be referenced through a MemberRef parented at
        // the self TypeSpec (`Chan`1<!0>::.ctor`), exactly as
        // `EmitConstructorCall`'s `newobj` does. The bare MethodDef names the
        // OPEN definition, so the verifier sees `call Chan`1::.ctor` applied to
        // a `Chan`1<!0>` receiver: `this` is never marked initialized
        // (ILVerify `CallCtor` + `ThisUninitReturn`) and the argument slots
        // stay at their uninstantiated `!0` shape (`StackUnexpected`). Every
        // OTHER self-reference in a generic body — field access, instance
        // calls, `newobj` — already routes through this TypeSpec; only the
        // chained initializer did not.
        var chainOwner = call.SelectedConstructor.DeclaringType;
        if (chainOwner != null && ReflectionMetadataEmitter.IsUserGenericTypeReference(chainOwner))
        {
            ctorHandle = this.outer.userTokens.ResolveUserCtorTokenForExplicit(
                chainOwner,
                call.SelectedConstructor);
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
                ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(constraintInterface, openMethod)
                : this.outer.cache.MethodHandles[call.Method];

            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(call.ConstrainedReceiverTypeParameter));
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

        // Hold the receiver rather than a bare `isGenericReceiver` flag: the
        // token resolver below needs the symbol, and a separate bool would
        // leave the compiler unable to correlate the two.
        var genericReceiver = receiverType != null
            && ReflectionMetadataEmitter.IsUserGenericTypeReference(receiverType)
            ? receiverType
            : null;

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
        // not fully instantiated". The `genericReceiver` branch already covers
        // the case where the receiver itself is the generic type.
        var inheritedGenericBase = genericReceiver is null
            ? this.ResolveInheritedGenericBase(call.Receiver.Type as StructSymbol, call.Method)
            : null;

        EntityHandle methodHandle;
        if (genericReceiver != null)
        {
            methodHandle = this.outer.userTokens.ResolveUserInstanceMethodToken(genericReceiver, call.Method);
        }
        else if (inheritedGenericBase != null)
        {
            methodHandle = this.outer.userTokens.ResolveUserInstanceMethodToken(inheritedGenericBase, call.Method);
        }
        else if (receiverIface != null
            && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(receiverIface))
        {
            var (slotIface, openMethod) = ResolveInterfaceSlotOwner(receiverIface, call.Method);
            methodHandle = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(slotIface, openMethod);
        }
        else if (call.Method.ReceiverType is StructSymbol importedReceiver && importedReceiver.ClrType != null)
        {
            methodHandle = this.outer.userTokens.ResolveUserInstanceMethodToken(importedReceiver, call.Method);
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
            methodHandle = this.outer.userTokens.BuildMethodSpecForGenericInstanceCall(methodHandle, call);
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
    private StructSymbol? ResolveInheritedGenericBase(StructSymbol? receiver, FunctionSymbol method)
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

        bool IsDeclaringDefinition(StructSymbol definition) =>
            ReferenceEquals(definition, declaringDef);
        return receiver.FindConstructedGenericBase(IsDeclaringDefinition);
    }

    // ADR-0087 R5 / issue #765: bridges from a substituted FunctionSymbol on
    // a constructed user interface (e.g. <c>IBox[int32].Get</c>) back to the
    // open <c>FunctionSymbol</c> on the definition so the emitter can look
    // up its <c>MethodHandle</c> and parent the resulting MemberRef at the
    // constructed TypeSpec.

    /// <summary>
    /// Issue #3907: resolves the interface that actually DECLARES the slot a
    /// call reaches through <paramref name="receiverIface"/>, together with
    /// that interface's open method.
    /// </summary>
    /// <remarks>
    /// <para><see cref="ResolveOpenInterfaceMethod"/> only ever searched the
    /// receiver interface's own definition, so a slot INHERITED from a base
    /// interface found nothing and the call fell through to the bare-MethodDef
    /// lookup, which threw "has no emitted handle". Parenting the MemberRef at
    /// the receiver interface would have been just as wrong — the derived
    /// interface's TypeSpec does not declare the method — so both halves have
    /// to move together.</para>
    /// <para><c>SelfAndAllBaseInterfaces</c> yields <c>this</c> first, so a
    /// slot the receiver declares itself still wins, and each base arrives
    /// ALREADY SUBSTITUTED with the receiver's type arguments (see
    /// <c>InterfaceSymbol.BaseInterfaces</c>), which is what makes the
    /// resulting MemberRef parent the constructed <c>IBase&lt;T&gt;</c> rather
    /// than the open definition. <c>Methods</c> is per-interface and excludes
    /// inherited members, so a candidate matching by identity is genuinely the
    /// declarer.</para>
    /// <para>This is the shape ADR-0174's channels runtime is built on:
    /// <c>ISendSelectableCore[T] : ISelectableCore[T]</c>, with
    /// <c>Deregister</c> declared on the base and called through the derived
    /// interface.</para>
    /// </remarks>
    /// <param name="receiverIface">The receiver expression's interface type.</param>
    /// <param name="substitutedMethod">The call's (substituted) method symbol.</param>
    /// <returns>The declaring interface and its open method.</returns>
    private static (InterfaceSymbol Interface, FunctionSymbol Method) ResolveInterfaceSlotOwner(
        InterfaceSymbol receiverIface,
        FunctionSymbol substitutedMethod)
    {
        foreach (var candidate in receiverIface.SelfAndAllBaseInterfaces())
        {
            var open = ResolveOpenInterfaceMethod(candidate, substitutedMethod);
            if (!ReferenceEquals(open, substitutedMethod))
            {
                return (candidate, open);
            }
        }

        return (receiverIface, substitutedMethod);
    }

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
        var ctorRef = this.outer.memberRefs.GetCtorReference(ctorCall.Constructor, ctorCall.Type);
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
            // Issue #1503: a generic named delegate (constructed or open)
            // dispatches through a MemberRef parented at the delegate TypeSpec;
            // a non-generic delegate uses the bare Invoke MethodDef handle.
            var namedInvokeHandle = this.outer.userTokens.ResolveDelegateInvokeToken(namedDelegate);

            this.EmitExpression(call.Target);
            this.EmitImportedCallArguments(call.Arguments, call.ArgumentRefKinds);

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(namedInvokeHandle);
            return;
        }

        // ADR-0087 §3 R6: a delegate whose parameter or return types carry
        // symbolic types (e.g. `func(T) U` or `async () -> T`) is
        // encoded as a reified `GENERICINST<Func`N><…>` shape. Dispatch
        // through a MemberRef parented at that TypeSpec — the runtime
        // delegate (e.g. `Func<int, int>`) resolves the MemberRef to
        // its concrete `Invoke` slot, so no `Delegate.DynamicInvoke`
        // marshalling is needed.
        if (this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(call.FunctionType))
        {
            this.EmitExpression(call.Target);
            this.EmitImportedCallArguments(call.Arguments, call.ArgumentRefKinds);

            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetFunctionDelegateInvokeRef(call.FunctionType));
            return;
        }

        this.EmitExpression(call.Target);
        this.EmitImportedCallArguments(call.Arguments, call.ArgumentRefKinds);

        var delegateType = this.outer.signatures.ResolveDelegateClrType(call.FunctionType);

        var invoke = delegateType.GetMethod("Invoke")
            ?? throw new InvalidOperationException(
                $"Delegate type '{delegateType.FullName}' has no Invoke method.");

        this.il.OpCode(ILOpCode.Callvirt);
        this.il.Token(this.outer.memberRefs.GetMethodReference(invoke));
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

    private void EmitCancellationTokenNone()
    {
        // ldc.i4.0; newobj CancellationToken(bool) — the canonical
        // "default" CancellationToken IL pattern. Avoids needing a
        // dedicated local for `default(CancellationToken)`.
        var ctCtor = BclMember.Ctor(typeof(System.Threading.CancellationToken), typeof(bool));
        this.il.LoadConstantI4(0);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctCtor));
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
        var typeParamToken = this.outer.memberRefs.GetElementTypeToken(call.TypeParameter);

        // Issue #3525: the constraint is an imported CLR interface (e.g.
        // `T : IParsable[T]`) rather than a source G# interface — the slot
        // is a reflected MethodInfo, referenced via a MemberRef parented at
        // the (possibly constructed generic) interface TypeSpec, mirroring
        // the imported-instance CLR constrained-call path (issue #943).
        if (call.ClrMethod is { } clrMethod)
        {
            var clrSlotHandle = this.outer.memberRefs.GetMethodEntityHandle(clrMethod, call.ConstrainedInterfaceType);
            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(typeParamToken);
            this.il.OpCode(ILOpCode.Call);
            this.il.Token(clrSlotHandle);
            return;
        }

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
        // call.ClrMethod was ruled out above, so this is the source-interface
        // shape and InterfaceMethod is guaranteed non-null.
        var interfaceMethod = call.InterfaceMethod!;
        var constraintIface = call.TypeParameter.InterfaceConstraint;
        EntityHandle slotHandle;
        if (constraintIface != null
            && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(constraintIface))
        {
            var openSlot = ResolveOpenInterfaceMethod(constraintIface, interfaceMethod);
            slotHandle = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(constraintIface, openSlot);
        }
        else if (this.outer.cache.MethodHandles.TryGetValue(interfaceMethod, out var slotDef))
        {
            slotHandle = slotDef;
        }
        else
        {
            throw new InvalidOperationException(
                $"Static-virtual interface method '{interfaceMethod.Name}' has no emitted handle.");
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
        var methodToken = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(call.Interface, call.Method);

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
        if (baseClass.TypeArguments.IsDefaultOrEmpty
            && !baseClass.TypeParameters.IsDefaultOrEmpty
            && call.Receiver.Type is StructSymbol baseReceiver)
        {
            var baseDef = baseClass.Definition ?? baseClass;
            bool IsBaseDefinition(StructSymbol definition) =>
                ReferenceEquals(definition, baseDef);
            var constructedBase = baseReceiver.FindConstructedGenericBase(IsBaseDefinition);
            if (constructedBase != null)
            {
                baseClass = constructedBase;
            }
        }

        var methodToken = call.IsPropertyAccessor
            ? this.outer.userTokens.ResolveUserPropertyAccessorToken(baseClass, call.Property, call.IsSetterAccessor)
            : this.outer.userTokens.ResolveUserInstanceMethodToken(baseClass, call.Method);

        // Issue #986: non-virtual `call`, NOT `callvirt`. callvirt would
        // re-dispatch through the v-table and re-enter the derived override.
        this.il.OpCode(ILOpCode.Call);
        this.il.Token(methodToken);
    }

    /// <summary>
    /// Issue #3226: the per-call plan for lifting an unconstrained generic
    /// instantiation to <c>Nullable&lt;X&gt;</c>. A user generic function with
    /// an UNCONSTRAINED type parameter <c>T</c> and a parameter declared
    /// <c>T?</c> (e.g. the receiver of <c>func (self T?) MyOrElse[T](fb T) T</c>)
    /// encodes every <c>T</c>/<c>T?</c> slot as the bare MVAR <c>!!T</c>
    /// (<see cref="SignatureEncoder"/> models unconstrained <c>T?</c> as a
    /// metadata-only reference annotation). That erasure is only sound for
    /// reference instantiations: a value-type call site would push a live
    /// <c>Nullable&lt;X&gt;</c> into an <c>X</c>-typed slot (invalid IL for
    /// primitives, silent nil-loss for user structs). The lift instead
    /// instantiates the MethodSpec at <c>Nullable&lt;X&gt;</c> — so the
    /// <c>T?</c> slot really holds a nullable, and the body's box-probe
    /// <c>nil</c> checks work because boxing a <c>Nullable&lt;X&gt;</c> yields
    /// a null reference for the empty value — wrapping bare-<c>X</c> arguments
    /// (<c>newobj Nullable&lt;X&gt;::.ctor</c>) and unwrapping a bare-<c>T</c>
    /// return (<c>box</c> + <c>unbox.any</c>, loud on the impossible nil).
    /// </summary>
    private sealed class UnconstrainedNullableLiftPlan
    {
        /// <summary>Gets or sets the full (lifted) MethodSpec type-argument vector.</summary>
        public required TypeSymbol[] TypeArguments { get; set; }

        /// <summary>Gets or sets, per argument index, the Nullable&lt;X&gt; to wrap the emitted argument into (null = pass through).</summary>
        public NullableTypeSymbol?[] ArgumentWraps { get; set; } = [];

        /// <summary>Gets or sets the Nullable&lt;X&gt; the call leaves on the stack when the declared return is the bare lifted T (null = no unwrap).</summary>
        public NullableTypeSymbol? ReturnUnwrap { get; set; }
    }

    // Issue #3226: decide whether (and how) the generic call must be
    // instantiated at Nullable<X> instead of X. Returns null when the call
    // needs no lift (no unconstrained T? slot, reference instantiation, or a
    // shape the lift cannot represent — see the occurrence scan below).
    private UnconstrainedNullableLiftPlan? TryPlanUnconstrainedNullableLift(BoundCallExpression call)
    {
        var fn = call.Function;
        var tps = fn.TypeParameters;
        if (tps.IsDefaultOrEmpty
            || call.MethodTypeArguments.IsDefaultOrEmpty
            || call.MethodTypeArguments.Length != tps.Length
            || fn.Parameters.Length != call.Arguments.Length
            || fn.IsAsyncOrSuspending
            || call.StaticGenericOwnerType != null
            || call.StaticGenericInterfaceOwnerType != null)
        {
            // Async bodies return through the Task<T> state-machine wrapper —
            // a nested T occurrence the lift cannot represent — and statics on
            // constructed generic owners resolve through TypeSpec-parented
            // MemberRefs, not the MethodSpec path the lift rewrites.
            return null;
        }

        TypeSymbol[]? liftedArgs = null;
        var liftedTps = new bool[tps.Length];
        for (int k = 0; k < tps.Length; k++)
        {
            var tp = tps[k];
            var x = call.MethodTypeArguments[k];

            // A struct-constrained T? already emits as Nullable<!!T>
            // (Issue #814); only the unconstrained erasure needs the lift.
            // The instantiation must be a closed value type: an open X (the
            // caller is itself generic) keeps the erased contract, and an
            // already-nullable X has no valid Nullable<Nullable<..>> form.
            if (tp.HasValueTypeConstraint
                || x is NullableTypeSymbol
                || x is TypeParameterSymbol
                || !ReflectionMetadataEmitter.IsValueTypeSymbol(x))
            {
                continue;
            }

            bool hasNullableSlot = false;
            bool representable = true;
            for (int i = 0; i < fn.Parameters.Length && representable; i++)
            {
                var pt = fn.Parameters[i].Type;
                if (pt is NullableTypeSymbol pn && ReferenceEquals(pn.UnderlyingType, tp))
                {
                    // A byref T?/T slot would need write-back through the
                    // lifted representation; keep the status quo there.
                    hasNullableSlot |= fn.Parameters[i].RefKind == RefKind.None;
                    representable &= fn.Parameters[i].RefKind == RefKind.None;
                }
                else if (ReferenceEquals(pt, tp))
                {
                    representable &= fn.Parameters[i].RefKind == RefKind.None;
                }
                else if (TypeSymbol.AnyTypeParameter(pt, cand =>
                {
                    return ReferenceEquals(cand, tp);
                }))
                {
                    // T occurs NESTED (e.g. []T, Box[T]): the instantiated
                    // slot shape ([]X) diverges from the lifted vector
                    // (Nullable<X>) — the lift cannot represent this call.
                    representable = false;
                }
            }

            if (!hasNullableSlot || !representable)
            {
                continue;
            }

            var rt = fn.Type;
            if (ReferenceEquals(rt, tp)
                || (rt is NullableTypeSymbol rn && ReferenceEquals(rn.UnderlyingType, tp)))
            {
                // Bare-T return unwraps after the call; T? return already
                // matches the lifted Nullable<X>.
            }
            else if (TypeSymbol.AnyTypeParameter(rt, cand =>
            {
                return ReferenceEquals(cand, tp);
            }))
            {
                // Nested occurrence in the return (Task[T], []T, ...): not
                // representable by the lift.
                continue;
            }

            liftedArgs ??= call.MethodTypeArguments.ToArray();
            liftedArgs[k] = NullableTypeSymbol.Get(x);
            liftedTps[k] = true;
        }

        if (liftedArgs == null)
        {
            return null;
        }

        var plan = new UnconstrainedNullableLiftPlan { TypeArguments = liftedArgs };
        var wraps = new NullableTypeSymbol?[call.Arguments.Length];
        for (int i = 0; i < fn.Parameters.Length; i++)
        {
            var pt = fn.Parameters[i].Type;
            var tpIndex = IndexOfLiftedTypeParameter(tps, liftedTps, pt);
            if (tpIndex < 0)
            {
                continue;
            }

            // The slot's instantiated shape is Nullable<X>. Wrap any argument
            // the binder materialized as bare X (a `fb T` argument, or a
            // receiver that bound without the X → X? lift); an argument
            // already typed X? matches the slot as-is.
            if (call.Arguments[i].Type is not NullableTypeSymbol)
            {
                wraps[i] = (NullableTypeSymbol)plan.TypeArguments[tpIndex];
            }
        }

        plan.ArgumentWraps = wraps;
        var retIndex = IndexOfLiftedTypeParameter(tps, liftedTps, fn.Type);
        if (retIndex >= 0 && fn.Type is TypeParameterSymbol)
        {
            plan.ReturnUnwrap = (NullableTypeSymbol)plan.TypeArguments[retIndex];
        }

        return plan;
    }

    // Issue #3226: maps a declared T or T? slot type onto the index of the
    // LIFTED type parameter it names; -1 for every other shape.
    private static int IndexOfLiftedTypeParameter(
        ImmutableArray<TypeParameterSymbol> tps,
        bool[] liftedTps,
        TypeSymbol declaredType)
    {
        var tp = declaredType as TypeParameterSymbol
            ?? (declaredType is NullableTypeSymbol n ? n.UnderlyingType as TypeParameterSymbol : null);
        if (tp == null)
        {
            return -1;
        }

        for (int k = 0; k < tps.Length; k++)
        {
            if (liftedTps[k] && ReferenceEquals(tps[k], tp))
            {
                return k;
            }
        }

        return -1;
    }

    // Issue #3226: X → Nullable<X> wrap for a lifted argument slot. Mirrors
    // the Issue #504/#1298 lifts in EmitConversion: a symbolic underlying
    // (user struct/enum/tuple) routes through the TypeSpec-parented ctor
    // MemberRef; a CLR-backed underlying closes System.Nullable`1 through the
    // ReferenceResolver (Issue #571) and refs its single-arg ctor.
    private void EmitUnconstrainedNullableLiftWrap(NullableTypeSymbol lifted)
    {
        this.il.OpCode(ILOpCode.Newobj);
        if (NullableLifting.RequiresSymbolicNullableGetValue(lifted))
        {
            this.il.Token(this.outer.memberRefs.GetNullableCtorMemberRefForUserValueType(lifted));
            return;
        }

        var innerClr = lifted.UnderlyingType.ClrType
            ?? throw new InvalidOperationException(
                $"Nullable<{lifted.UnderlyingType.Name}> lift has no CLR underlying type.");
        if (!NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr))
        {
            throw new InvalidOperationException(
                $"Cannot construct Nullable<{innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set.");
        }

        var nullableInnerArg = nullableClr.GetGenericArguments()[0];
        var ctor = nullableClr.GetConstructor(new[] { nullableInnerArg })
            ?? throw new InvalidOperationException(
                $"Nullable<{nullableInnerArg.FullName}> has no single-arg constructor.");
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctor));
    }

    // Issue #3226: Nullable<X> → X unwrap for a lifted bare-T return.
    // `box Nullable<X>` collapses to a boxed X (never null here — a T-typed
    // value cannot be nil in the source type system), and `unbox.any X`
    // reloads the value; an impossible nil would surface loudly as an NRE
    // rather than a silent default(X).
    private void EmitUnconstrainedNullableLiftUnwrap(NullableTypeSymbol lifted)
    {
        this.il.OpCode(ILOpCode.Box);
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(lifted));
        this.il.OpCode(ILOpCode.Unbox_any);
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(lifted.UnderlyingType));
    }
}
