// <copyright file="MethodBodyEmitter.Calls.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Threading

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// constructor / instance / indirect / channel call emission.
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    private func EmitConstructorCall(call BoundConstructorCallExpression) {
        let ctorHandle = this.outer.userTokens.ResolveUserCtorToken(call)
        for var i = 0; i < call.Arguments.Length; i++ {
            let arg = call.Arguments[i]
            this.EmitExpression(arg)
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(ctorHandle)
    }

    /// ADR-0065 §2: emits the CIL for a `init(args)` self-delegation
    /// statement that appears inside a `convenience init(...)` body.
    /// Lowered to `ldarg.0; <args>; call <ctor>` chaining to a
    /// sibling constructor on the same aggregate.
    /// @param call The bound chaining expression to emit.
    private func EmitConstructorChaining(call BoundConstructorChainingExpression) {
        if call.SelectedConstructor == nil ||
            !this
            .outer
            .cache
            .ExplicitCtorHandles
            .TryGetValue(call.SelectedConstructor, out var ctorDefHandle) {
            throw InvalidOperationException(
                "Constructor chaining target on '${call.SelectedConstructor?.DeclaringType?.Name}' has no emitted handle."
            )
        }
        var ctorHandle EntityHandle = ctorDefHandle
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
        let chainOwner StructSymbol? = call.SelectedConstructor.DeclaringType
        if chainOwner != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(chainOwner) {
            ctorHandle = this.outer.userTokens.ResolveUserCtorTokenForExplicit(chainOwner, call.SelectedConstructor)
        }
        // Load `this` then evaluate each argument in order. Parameters of a
        // user-authored init can never be type parameters today, so the
        // value-type-to-System.Object boxing dance that EmitConstructorCall
        // performs is unnecessary here.
        this.il.LoadArgument(0)
        for arg in call.Arguments {
            this.EmitExpression(arg)
        }
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(ctorHandle)
    }

    private func EmitUserInstanceCall(call BoundUserInstanceCallExpression) {
        // Issue #1052: a call dispatched through a type parameter's
        // user-declared interface constraint (e.g. `x.Area()` with
        // `T : IShape`) emits a verifiable
        // `constrained. !!T  callvirt IShape::Area()` — mirroring the imported
        // CLR-interface path (issue #943). Without the `constrained.` prefix a
        // bare `callvirt` on the unboxed type parameter corrupts the stack and
        // crashes at runtime.
        if call.IsConstrainedTypeParameterCall {
            this.EmitConstrainedTypeParameterReceiver(call.Receiver)
            for var i = 0; i < call.Arguments.Length; i++ {
                this.EmitExpression(call.Arguments[i])
            }
            let constraintInterface InterfaceSymbol? = (call.ConstrainedInterfaceType as InterfaceSymbol) ??
                (call.Method.ReceiverType as InterfaceSymbol)
            let constraintClass StructSymbol? = call.ConstrainedReceiverTypeParameter!!.ClassConstraint as StructSymbol
            let openMethod = if constraintInterface != nil {
                ResolveOpenInterfaceMethod(constraintInterface, call.Method)
            } else {
                call.Method
            }
            let constraintOwner StructSymbol? = if constraintClass != nil {
                ResolveUserInstanceMethodOwner(constraintClass, call.Method)
            } else {
                default(StructSymbol?)
            }
            var constrainedMethodToken = if constraintInterface != nil {
                this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(constraintInterface, openMethod)
            } else {
                (
                    if constraintOwner != nil {
                        this.outer.userTokens.ResolveUserInstanceMethodToken(constraintOwner, call.Method)
                    } else {
                        this.outer.cache.MethodHandles[call.Method]
                    }
                )
            }
            if call.Method.IsGeneric && !call.Method.TypeParameters.IsDefaultOrEmpty {
                constrainedMethodToken = this
                    .outer
                    .userTokens
                    .BuildMethodSpecForGenericInstanceCall(constrainedMethodToken, call)
            }
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(call.ConstrainedReceiverTypeParameter!!))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(constrainedMethodToken)
            return
        }
        // ADR-0087 §3 R3+R4: when the receiver is a constructed
        // generic user type, the method must be referenced via a
        // MemberRef parented at the constructed TypeSpec (e.g.
        // `Container`1<int32>`, not the open `Container`1<!0>`).
        // Resolve the declaring class as instantiated by the receiver,
        // including inherited methods on constructed generic bases. The R0/R1 box at
        // TypeParameterSymbol parameter slots is dropped: the method
        // signature is `!0`/`!!0` and resolves through the parent
        // TypeSpec.
        let receiverType StructSymbol? = (call.Receiver.Type as StructSymbol) ??
            (call.Method.ReceiverType as StructSymbol)
        let methodOwner StructSymbol? = if receiverType != nil {
            ResolveUserInstanceMethodOwner(receiverType, call.Method)
        } else {
            default(StructSymbol?)
        }
        let genericOwner StructSymbol? = if methodOwner != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(
            methodOwner
        ) {
            methodOwner
        } else {
            default(StructSymbol?)
        }
        // ADR-0087 R5 / issue #765: same TypeSpec-parenting requirement
        // for a call dispatched through a user-declared generic interface
        // receiver (e.g. `b: IBox[int32]; b.Get()`). The call's
        // <c>Method</c> on a constructed interface is the substituted
        // <c>FunctionSymbol</c>, which is NOT keyed in
        // <c>cache.MethodHandles</c>; we therefore resolve back to the
        // open method on the definition and produce a MemberRef parented
        // at the constructed TypeSpec via <see cref="ResolveUserInterfaceInstanceMethodToken"/>.
        let receiverIface InterfaceSymbol? = call.Receiver.Type as InterfaceSymbol
        var methodHandle EntityHandle
        if genericOwner != nil {
            methodHandle = this.outer.userTokens.ResolveUserInstanceMethodToken(genericOwner, call.Method)
        } else if receiverIface != nil && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(receiverIface) {
            let (slotIface, openMethod) = ResolveInterfaceSlotOwner(receiverIface, call.Method)
            methodHandle = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(slotIface, openMethod)
        } else if call.Method.ReceiverType is StructSymbol importedReceiver && importedReceiver.ClrType != nil {
            methodHandle = this.outer.userTokens.ResolveUserInstanceMethodToken(importedReceiver, call.Method)
        } else if this.outer.cache.MethodHandles.TryGetValue(call.Method, out var defHandle) {
            methodHandle = defHandle
        } else {
            throw InvalidOperationException(
                "Instance method '${call.Method.Name}' on '${call.Method.ReceiverType?.Name}' has no emitted handle."
            )
        }
        // ADR-0087 §3 R3+R4: when the method itself is generic, wrap
        // the open method token in a MethodSpec carrying the
        // substituted type arguments inferred from the call.
        if call.Method.IsGeneric && !call.Method.TypeParameters.IsDefaultOrEmpty {
            methodHandle = this.outer.userTokens.BuildMethodSpecForGenericInstanceCall(methodHandle, call)
        }
        this.EmitInstanceReceiver(call.Receiver)
        let calleeParameterOffset = if call.Method.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        for var i = 0; i < call.Arguments.Length; i++ {
            let arg = call.Arguments[i]
            this.EmitExpression(arg)
        }
        let receiverIsValueType = call.Method.ReceiverType is StructSymbol receiverStruct && !receiverStruct.IsClass
        this.il.OpCode(
            if receiverIsValueType {
                ILOpCode.Call
            } else {
                ILOpCode.Callvirt
            }
        )
        this.il.Token(methodHandle)
        // ADR-0087 §3 R3+R4: after R2, a user-instance call returns the
        // method's reified signature (substituted at the TypeSpec / MethodSpec
        // level). No erasure-widening is required at the call boundary.

    }

    private func EmitClrConstructorCall(ctorCall BoundClrConstructorCallExpression) {
        // Phase 4 emit parity: `newobj` against a CLR ctor. Handles both
        // non-generic types and constructed generic types — the parent of
        // the MemberRef becomes a TypeSpec for the latter, encoded in
        // `GetCtorReference` / `GetTypeHandleForMember`.
        // Issue #368: honour by-ref/out argument ref-kinds (e.g. an
        // interpolated-string handler whose constructor takes `out bool
        // shouldAppend`) by emitting the argument address.
        if !ctorCall.ArgumentRefKinds.IsDefaultOrEmpty {
            this.EmitImportedCallArguments(ctorCall.Arguments, ctorCall.ArgumentRefKinds)
        } else {
            for arg in ctorCall.Arguments {
                this.EmitExpression(arg)
            }
        }
        // Issue #671: when the ctor target's containing type carries G#
        // user-defined symbolic type arguments (closed with System.Object at
        // the CLR layer because the user type's TypeDef is only produced
        // during emit), build the MemberRef against a parent TypeSpec encoded
        // with the symbolic args. Without this the `newobj` would target the
        // type-erased `Open<object,…>::.ctor`, which fails IL verification
        // against the locally-typed `Open<MyGs,…>` slot.
        let ctorRef = this.outer.memberRefs.GetCtorReference(ctorCall.Constructor, ctorCall.Type)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(ctorRef)
    }

    // Phase 4 emit parity (E1): indirect call through a func-typed value.
    // Evaluates the target (pushes the delegate on the stack), evaluates
    // each argument, then calls the delegate's `Invoke` method via
    // `callvirt`.
    private func EmitIndirectCall(call BoundIndirectCallExpression) {
        // ADR-0059 / issue #255: a call through a value typed as a
        // user-declared named delegate dispatches through that delegate's
        // emitted Invoke MethodDef directly (no DynamicInvoke marshalling
        // needed — the signature is concrete, not type-erased).
        if call.Target.Type is DelegateTypeSymbol namedDelegate {
            // Issue #1503: a generic named delegate (constructed or open)
            // dispatches through a MemberRef parented at the delegate TypeSpec;
            // a non-generic delegate uses the bare Invoke MethodDef handle.
            let namedInvokeHandle = this.outer.userTokens.ResolveDelegateInvokeToken(namedDelegate)
            this.EmitExpression(call.Target)
            this.EmitImportedCallArguments(call.Arguments, call.ArgumentRefKinds)
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(namedInvokeHandle)
            return
        }
        // ADR-0087 §3 R6: a delegate whose parameter or return types carry
        // symbolic types (e.g. `func(T) U` or `async () -> T`) is
        // encoded as a reified `GENERICINST<Func`N><…>` shape. Dispatch
        // through a MemberRef parented at that TypeSpec — the runtime
        // delegate (e.g. `Func<int, int>`) resolves the MemberRef to
        // its concrete `Invoke` slot, so no `Delegate.DynamicInvoke`
        // marshalling is needed.
        if this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(call.FunctionType) {
            this.EmitExpression(call.Target)
            this.EmitImportedCallArguments(call.Arguments, call.ArgumentRefKinds)
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.memberRefs.GetFunctionDelegateInvokeRef(call.FunctionType))
            return
        }
        this.EmitExpression(call.Target)
        this.EmitImportedCallArguments(call.Arguments, call.ArgumentRefKinds)
        let delegateType = this.outer.signatures.ResolveDelegateClrType(call.FunctionType)
        let invoke = delegateType.GetMethod("Invoke") ??
            throw InvalidOperationException("Delegate type '${delegateType.FullName}' has no Invoke method.")
        this.il.OpCode(ILOpCode.Callvirt)
        this.il.Token(this.outer.memberRefs.GetMethodReference(invoke))
    }

    // ADR-0087 §3 R6: `EmitOpenDelegateDynamicInvoke` retired. Every
    // call site over an open-bearing `FunctionTypeSymbol` now dispatches
    // through a `callvirt` to a MemberRef parented at the reified
    // `Func<...>` / `Action<...>` TypeSpec (see EmitIndirectCall and
    // ReflectionMetadataEmitter.GetFunctionDelegateInvokeRef). The
    // runtime delegate's concrete `Invoke` slot is resolved by the CLR
    // when the substituted Var/MVar slots become concrete, so the
    // historical `Delegate.DynamicInvoke` adapter is no longer required.
    /// ADR-0039: Emits arguments for an imported call, respecting (cref:RefKind).
    private func EmitImportedCallArguments(
        arguments ImmutableArray[BoundExpression],
        refKinds ImmutableArray[RefKind]
    ) {
        for var i = 0; i < arguments.Length; i++ {
            let rk = if refKinds.IsDefault || i >= refKinds.Length {
                RefKind.None
            } else {
                refKinds[i]
            }
            let arg = arguments[i]
            if rk == RefKind.Ref || rk == RefKind.Out || rk == RefKind.In {
                // Argument must be BoundAddressOfExpression or (ADR-0061)
                // BoundConditionalAddressExpression; emit the address.
                if arg is BoundAddressOfExpression addrOf {
                    this.EmitAddressOf(addrOf)
                } else if arg is BoundConditionalAddressExpression condAddr {
                    this.EmitConditionalAddress(condAddr)
                } else if (arg.Type is ByRefTypeSymbol or PointerTypeSymbol) {
                    // An expression that already yields an address — e.g. the
                    // #377 by-ref interpolated-handler block whose tail is the
                    // handler local's address, or a `*T` value.
                    this.EmitExpression(arg)
                } else {
                    // Issue #4400: a by-value operand here would be pushed where
                    // the callee expects an address (StackUnexpected /
                    // InvalidProgramException). The binder lowers every plain
                    // `in` argument to an address; fail loudly rather than
                    // emit unverifiable IL if some path ever misses it.
                    throw EmitDiagnosticException(
                        "Argument ${i + 1} is passed to a '${rk.ToString().ToLowerInvariant()}' parameter but was bound as a value, not an address.",
                        arg.Syntax
                    )
                }
            } else {
                this.EmitExpression(arg)
            }
        }
    }

    private func EmitCancellationTokenNone() {
        // ldc.i4.0; newobj CancellationToken(bool) — the canonical
        // "default" CancellationToken IL pattern. Avoids needing a
        // dedicated local for `default(CancellationToken)`.
        let ctCtor = BclMember.Ctor(typeof(CancellationToken), typeof(bool))
        this.il.LoadConstantI4(0)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctCtor))
    }

    /// ADR-0089 / issue #755: emit a constrained static-virtual call —
    /// `constrained. !!T call !iface::Method(args)`. The receiver
    /// type-parameter is encoded as a TypeSpec (VAR or MVAR); the interface
    /// method is encoded as a MemberRef whose parent is the (constructed)
    /// interface TypeRef/TypeSpec. ECMA-335 §III.2.1 specifies that
    /// `constrained.` may prefix `call` (not just `callvirt`) when the
    /// target is a static-virtual interface method.
    /// @param call The bound call to emit.
    private func EmitConstrainedStaticCall(call BoundConstrainedStaticCallExpression) {
        // Emit arguments left-to-right.
        for var i = 0; i < call.Arguments.Length; i++ {
            this.EmitExpression(call.Arguments[i])
        }
        // Resolve the constraint type-parameter element token (TypeSpec
        // naming VAR(n) for type-type parameters, MVAR(n) for
        // method-type parameters). GetElementTypeToken already handles
        // both shapes via TypeParameterSymbol.IsMethodTypeParameter.
        let typeParamToken = this.outer.memberRefs.GetElementTypeToken(call.TypeParameter)
        // Issue #3525: the constraint is an imported CLR interface (e.g.
        // `T : IParsable[T]`) rather than a source G# interface — the slot
        // is a reflected MethodInfo, referenced via a MemberRef parented at
        // the (possibly constructed generic) interface TypeSpec, mirroring
        // the imported-instance CLR constrained-call path (issue #943).
        if call.ClrMethod is {} clrMethod {
            let clrSlotHandle = this
                .outer
                .memberRefs
                .GetMethodEntityHandle(clrMethod, call.TypeArgumentSymbols, call.ConstrainedInterfaceType)
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(typeParamToken)
            this.il.OpCode(ILOpCode.Call)
            this.il.Token(clrSlotHandle)
            return
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
        let interfaceMethod = call.InterfaceMethod!!
        let constraintIface InterfaceSymbol? = call.TypeParameter.InterfaceConstraint
        var slotHandle EntityHandle
        if constraintIface != nil && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(constraintIface) {
            let openSlot = ResolveOpenInterfaceMethod(constraintIface, interfaceMethod)
            slotHandle = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(constraintIface, openSlot)
        } else if this.outer.cache.MethodHandles.TryGetValue(interfaceMethod, out var slotDef) {
            slotHandle = slotDef
        } else {
            throw InvalidOperationException(
                "Static-virtual interface method '${interfaceMethod.Name}' has no emitted handle."
            )
        }
        this.il.OpCode(ILOpCode.Constrained)
        this.il.Token(typeParamToken)
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(slotHandle)
    }

    /// ADR-0091: emits an explicit-base interface call
    /// `base[IFoo].M(args)`. The receiver is the implicit
    /// `this` (the implementing class); the call uses
    /// `call instance` (non-virtual) so the inherited
    /// default body on `IFoo` is invoked directly rather
    /// than re-dispatched through the v-table (which would re-enter
    /// the override and cause infinite recursion).
    /// @param call The bound base-interface call to emit.
    private func EmitBaseInterfaceCall(call BoundBaseInterfaceCallExpression) {
        // Load `this` (the implementing class instance).
        this.EmitInstanceReceiver(call.Receiver)
        // Evaluate each argument left-to-right.
        for arg in call.Arguments {
            this.EmitExpression(arg)
        }
        // Resolve the right token for the interface's default-body MethodDef.
        // Non-generic interfaces: bare MethodDef. Generic interfaces:
        // MemberRef parented at the constructed TypeSpec.
        let methodToken = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(call.Interface, call.Method)
        // ADR-0091: non-virtual `call`, NOT `callvirt`. Using callvirt would
        // re-dispatch through the v-table and re-enter the same override
        // that issued the base-call.
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(methodToken)
    }

    // Issue #986: emits `base.M(args)` (and `base[BaseClass].M(args)`) as a
    // non-virtual `call instance R BaseClass::M(...)`. The receiver is `this`
    // (the derived instance); because the opcode is `call` (not `callvirt`)
    // the CLR resolves statically to the base implementation, bypassing the
    // v-table. This is exactly the IL shape `csc` produces for C# `base.M()`.
    private func EmitBaseClassCall(call BoundBaseClassCallExpression) {
        // Load `this` (the derived instance).
        this.EmitInstanceReceiver(call.Receiver)
        // Evaluate each argument left-to-right.
        for var i = 0; i < call.Arguments.Length; i++ {
            this.EmitExpression(call.Arguments[i])
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
        var baseClass = call.BaseClass
        if baseClass
            .TypeArguments
            .IsDefaultOrEmpty &&
            !baseClass
            .TypeParameters
            .IsDefaultOrEmpty &&
            call
            .Receiver
            .Type is StructSymbol baseReceiver {
            let baseDef = baseClass.Definition ?? baseClass
            let IsBaseDefinition = func (definition StructSymbol) bool {
                return object.ReferenceEquals(definition, baseDef)
            }
            let constructedBase StructSymbol? = baseReceiver.FindConstructedGenericBase(IsBaseDefinition)
            if constructedBase != nil {
                baseClass = constructedBase
            }
        }
        var methodToken = if call.IsPropertyAccessor {
            this.outer.userTokens.ResolveUserPropertyAccessorToken(baseClass, call.Property!!, call.IsSetterAccessor)
        } else {
            this.outer.userTokens.ResolveUserInstanceMethodToken(baseClass, call.Method!!)
        }
        // A generic base method is called through a MethodSpec carrying the
        // call's type arguments, exactly like an ordinary generic instance
        // call. Without it the call named the open method and pushed an
        // argument where `!!0` was expected (ILVerify StackUnexpected,
        // InvalidProgramException at run time).
        if !call.IsPropertyAccessor && call.Method!!.IsGeneric {
            let asInstanceCall = BoundUserInstanceCallExpression(
                call.Syntax,
                call.Receiver,
                call.Method!!,
                call.Arguments,
                call.Type
            ){MethodTypeArguments = call.MethodTypeArguments}
            methodToken = this.outer.userTokens.BuildMethodSpecForGenericInstanceCall(methodToken, asInstanceCall)
        }
        // Issue #986: non-virtual `call`, NOT `callvirt`. callvirt would
        // re-dispatch through the v-table and re-enter the derived override.
        this.il.OpCode(ILOpCode.Call)
        this.il.Token(methodToken)
    }

    /// Issue #3226: the per-call plan for lifting an unconstrained generic
    /// instantiation to `Nullable<X>`. A user generic function with
    /// an UNCONSTRAINED type parameter `T` and a parameter declared
    /// `T?` (e.g. the receiver of `func (self T?) MyOrElse[T](fb T) T`)
    /// encodes every `T`/`T?` slot as the bare MVAR `!!T`
    /// ((cref:SignatureEncoder) models unconstrained `T?` as a
    /// metadata-only reference annotation). That erasure is only sound for
    /// reference instantiations: a value-type call site would push a live
    /// `Nullable<X>` into an `X`-typed slot (invalid IL for
    /// primitives, silent nil-loss for user structs). The lift instead
    /// instantiates the MethodSpec at `Nullable<X>` — so the
    /// `T?` slot really holds a nullable, and the body's box-probe
    /// `nil` checks work because boxing a `Nullable<X>` yields
    /// a null reference for the empty value — wrapping bare-`X` arguments
    /// (`newobj Nullable<X>::.ctor`) and unwrapping a bare-`T`
    /// return (`box` + `unbox.any`, loud on the impossible nil).
    private class UnconstrainedNullableLiftPlan {
        /// Gets or sets the full (lifted) MethodSpec type-argument vector.
        prop TypeArguments[]TypeSymbol

        /// Gets or sets, per argument index, the Nullable<X> to wrap the emitted argument into (null = pass
        /// through).
        private var _argumentWraps[]NullableTypeSymbol? = System.Array.Empty[NullableTypeSymbol?]()

        prop ArgumentWraps[]NullableTypeSymbol? {
            get {
                return _argumentWraps
            }
            set {
                _argumentWraps = value
            }
        }

        /// Gets or sets the Nullable<X> the call leaves on the stack when the declared return is the bare
        /// lifted T (null = no unwrap).
        prop ReturnUnwrap NullableTypeSymbol?
    }

    // Issue #3226: decide whether (and how) the generic call must be
    // instantiated at Nullable<X> instead of X. Returns null when the call
    // needs no lift (no unconstrained T? slot, reference instantiation, or a
    // shape the lift cannot represent — see the occurrence scan below).
    private func TryPlanUnconstrainedNullableLift(call BoundCallExpression) UnconstrainedNullableLiftPlan? {
        let fn = call.Function
        let tps = fn.TypeParameters
        if tps.IsDefaultOrEmpty ||
            call
            .MethodTypeArguments
            .IsDefaultOrEmpty ||
            call
            .MethodTypeArguments
            .Length != tps.Length ||
            fn
            .Parameters
            .Length != call
            .Arguments
            .Length ||
            fn.IsAsyncOrSuspending ||
            call.StaticGenericOwnerType != nil ||
            call.StaticGenericInterfaceOwnerType != nil {
            // Async bodies return through the Task<T> state-machine wrapper —
            // a nested T occurrence the lift cannot represent — and statics on
            // constructed generic owners resolve through TypeSpec-parented
            // MemberRefs, not the MethodSpec path the lift rewrites.
            return nil
        }
        var liftedArgs[]?TypeSymbol = nil
        let liftedTps = [tps.Length]bool
        for var k = 0; k < tps.Length; k++ {
            let tp = tps[k]
            let x = call.MethodTypeArguments[k]
            // A struct-constrained T? already emits as Nullable<!!T>
            // (Issue #814); only the unconstrained erasure needs the lift.
            // The instantiation must be a closed value type: an open X (the
            // caller is itself generic) keeps the erased contract, and an
            // already-nullable X has no valid Nullable<Nullable<..>> form.
            if tp.HasValueTypeConstraint ||
                x is NullableTypeSymbol ||
                x is TypeParameterSymbol ||
                !ReflectionMetadataEmitter.IsValueTypeSymbol(x) {
                continue
            }
            var hasNullableSlot = false
            var representable = true
            for var i = 0; i < fn.Parameters.Length && representable; i++ {
                let pt = fn.Parameters[i].Type
                if pt is NullableTypeSymbol pn && object.ReferenceEquals(pn.UnderlyingType, tp) {
                    // A byref T?/T slot would need write-back through the
                    // lifted representation; keep the status quo there.
                    hasNullableSlot |= fn.Parameters[i].RefKind == RefKind.None
                    representable &= fn.Parameters[i].RefKind == RefKind.None
                } else if object.ReferenceEquals(pt, tp) {
                    representable &= fn.Parameters[i].RefKind == RefKind.None
                } else if TypeSymbol.AnyTypeParameter(
                    pt,
                    (cand TypeParameterSymbol) -> {
                        return object.ReferenceEquals(cand, tp)
                    }
                ) {
                    // T occurs NESTED (e.g. []T, Box[T]): the instantiated
                    // slot shape ([]X) diverges from the lifted vector
                    // (Nullable<X>) — the lift cannot represent this call.
                    representable = false
                }
            }
            if !hasNullableSlot || !representable {
                continue
            }
            let rt = fn.Type
            if object.ReferenceEquals(rt, tp) ||
                (rt is NullableTypeSymbol rn && object.ReferenceEquals(rn.UnderlyingType, tp)) {
                // Bare-T return unwraps after the call; T? return already
                // matches the lifted Nullable<X>.

            } else if TypeSymbol.AnyTypeParameter(
                rt,
                (cand TypeParameterSymbol) -> {
                    return object.ReferenceEquals(cand, tp)
                }
            ) {
                // Nested occurrence in the return (Task[T], []T, ...): not
                // representable by the lift.
                continue
            }
            liftedArgs ??= call.MethodTypeArguments.ToArray()
            liftedArgs!![k] = NullableTypeSymbol.Get(x)
            liftedTps[k] = true
        }
        if liftedArgs == nil {
            return nil
        }
        let plan = UnconstrainedNullableLiftPlan{TypeArguments: liftedArgs}
        let wraps = [call.Arguments.Length]NullableTypeSymbol?
        for var i = 0; i < fn.Parameters.Length; i++ {
            let pt = fn.Parameters[i].Type
            let tpIndex = IndexOfLiftedTypeParameter(tps, liftedTps, pt)
            if tpIndex < 0 {
                continue
            }
            // The slot's instantiated shape is Nullable<X>. Wrap any argument
            // the binder materialized as bare X (a `fb T` argument, or a
            // receiver that bound without the X → X? lift); an argument
            // already typed X? matches the slot as-is.
            if !(call.Arguments[i].Type is NullableTypeSymbol) {
                wraps[i] = cast[NullableTypeSymbol](plan.TypeArguments[tpIndex])
            }
        }
        plan.ArgumentWraps = wraps
        let retIndex = IndexOfLiftedTypeParameter(tps, liftedTps, fn.Type)
        if retIndex >= 0 && fn.Type is TypeParameterSymbol {
            plan.ReturnUnwrap = cast[NullableTypeSymbol](plan.TypeArguments[retIndex])
        }
        return plan
    }

    // Issue #3226: X → Nullable<X> wrap for a lifted argument slot. Mirrors
    // the Issue #504/#1298 lifts in EmitConversion: a symbolic underlying
    // (user struct/enum/tuple) routes through the TypeSpec-parented ctor
    // MemberRef; a CLR-backed underlying closes System.Nullable`1 through the
    // ReferenceResolver (Issue #571) and refs its single-arg ctor.
    private func EmitUnconstrainedNullableLiftWrap(lifted NullableTypeSymbol) {
        this.il.OpCode(ILOpCode.Newobj)
        if NullableLifting.RequiresSymbolicNullableGetValue(lifted) {
            this.il.Token(this.outer.memberRefs.GetNullableCtorMemberRefForUserValueType(lifted))
            return
        }
        let innerClr = lifted
            .UnderlyingType
            .ClrType ??
            throw InvalidOperationException("Nullable<${lifted.UnderlyingType.Name}> lift has no CLR underlying type.")
        if !NullableLifting.TryConstructNullable(this.outer.emitCtx.References, innerClr, out var nullableClr) {
            throw InvalidOperationException(
                "Cannot construct Nullable<${innerClr.FullName}>: System.Nullable`1 is not resolvable in the reference set."
            )
        }
        let nullableInnerArg = nullableClr.GetGenericArguments()[0]
        let ctor = nullableClr.GetConstructor([]Type{nullableInnerArg}) ??
            throw InvalidOperationException("Nullable<${nullableInnerArg.FullName}> has no single-arg constructor.")
        this.il.Token(this.outer.memberRefs.GetCtorReference(ctor))
    }

    // Issue #3226: Nullable<X> → X unwrap for a lifted bare-T return.
    // `box Nullable<X>` collapses to a boxed X (never null here — a T-typed
    // value cannot be nil in the source type system), and `unbox.any X`
    // reloads the value; an impossible nil would surface loudly as an NRE
    // rather than a silent default(X).
    private func EmitUnconstrainedNullableLiftUnwrap(lifted NullableTypeSymbol) {
        this.il.OpCode(ILOpCode.Box)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(lifted))
        this.il.OpCode(ILOpCode.Unbox_any)
        this.il.Token(this.outer.memberRefs.GetElementTypeToken(lifted.UnderlyingType))
    }

    shared {
        /// Resolves the declaring class as the receiver's hierarchy instantiates it,
        /// for both calls and method groups, without requiring an open MethodDef cache entry.
        private func ResolveUserInstanceMethodOwner(receiver StructSymbol, function FunctionSymbol) StructSymbol {
            if function.ReceiverType is not StructSymbol declaring {
                return receiver
            }
            let declaringDefinition = declaring.Definition ?? declaring
            if object.ReferenceEquals(receiver.Definition ?? receiver, declaringDefinition) {
                return receiver
            }
            return receiver.FindConstructedGenericBase(
                (definition StructSymbol) -> object.ReferenceEquals(definition, declaringDefinition)
            ) ??
                declaring
        }

        // ADR-0087 R5 / issue #765: bridges from a substituted FunctionSymbol on
        // a constructed user interface (e.g. <c>IBox[int32].Get</c>) back to the
        // open <c>FunctionSymbol</c> on the definition so the emitter can look
        // up its <c>MethodHandle</c> and parent the resulting MemberRef at the
        // constructed TypeSpec.
        /// Issue #3907: resolves the interface that actually DECLARES the slot a
        /// call reaches through [`receiverIface`](paramref), together with
        /// that interface's open method.
        /// @remarks (cref:ResolveOpenInterfaceMethod) only ever searched the
        /// receiver interface's own definition, so a slot INHERITED from a base
        /// interface found nothing and the call fell through to the bare-MethodDef
        /// lookup, which threw "has no emitted handle". Parenting the MemberRef at
        /// the receiver interface would have been just as wrong — the derived
        /// interface's TypeSpec does not declare the method — so both halves have
        /// to move together.
        ///
        /// `SelfAndAllBaseInterfaces` yields `this` first, so a
        /// slot the receiver declares itself still wins, and each base arrives
        /// ALREADY SUBSTITUTED with the receiver's type arguments (see
        /// `InterfaceSymbol.BaseInterfaces`), which is what makes the
        /// resulting MemberRef parent the constructed `IBase<T>` rather
        /// than the open definition. `Methods` is per-interface and excludes
        /// inherited members, so a candidate matching by identity is genuinely the
        /// declarer.
        ///
        /// This is the shape ADR-0174's channels runtime is built on:
        /// `ISendSelectableCore[T] : ISelectableCore[T]`, with
        /// `Deregister` declared on the base and called through the derived
        /// interface.
        /// @param receiverIface The receiver expression's interface type.
        /// @param substitutedMethod The call's (substituted) method symbol.
        /// @returns The declaring interface and its open method.
        private func ResolveInterfaceSlotOwner(receiverIface InterfaceSymbol, substitutedMethod FunctionSymbol)(
            Interface InterfaceSymbol,
            Method FunctionSymbol
        ) {
            for candidate in receiverIface.SelfAndAllBaseInterfaces() {
                let open_ = ResolveOpenInterfaceMethod(candidate, substitutedMethod)
                if !object.ReferenceEquals(open_, substitutedMethod) {
                    return (candidate, open_)
                }
            }
            return (receiverIface, substitutedMethod)
        }

        private func ResolveOpenInterfaceMethod(
            receiverIface InterfaceSymbol,
            substitutedMethod FunctionSymbol
        ) FunctionSymbol {
            let def = receiverIface.Definition ?? receiverIface
            if object.ReferenceEquals(def, receiverIface) {
                return substitutedMethod
            }
            let instanceMethods = receiverIface.Methods
            for var i = 0; i < instanceMethods.Length; i++ {
                if object.ReferenceEquals(instanceMethods[i], substitutedMethod) && i < def.Methods.Length {
                    return def.Methods[i]
                }
            }
            let staticMethods = receiverIface.StaticMethods
            for var i = 0; i < staticMethods.Length; i++ {
                if object.ReferenceEquals(staticMethods[i], substitutedMethod) && i < def.StaticMethods.Length {
                    return def.StaticMethods[i]
                }
            }
            let privateMethods = receiverIface.PrivateMethods
            for var i = 0; i < privateMethods.Length; i++ {
                if object.ReferenceEquals(privateMethods[i], substitutedMethod) && i < def.PrivateMethods.Length {
                    return def.PrivateMethods[i]
                }
            }
            let staticPrivateMethods = receiverIface.StaticPrivateMethods
            for var i = 0; i < staticPrivateMethods.Length; i++ {
                if object.ReferenceEquals(staticPrivateMethods[i], substitutedMethod) &&
                    i < def
                    .StaticPrivateMethods
                    .Length {
                    return def.StaticPrivateMethods[i]
                }
            }
            // Fall back to name-and-arity matching (substitution path may have
            // produced new param symbols whose identity differs from the open
            // declarations).
            for m in def.Methods {
                if m.Name == substitutedMethod.Name && m.Parameters.Length == substitutedMethod.Parameters.Length {
                    return m
                }
            }
            return substitutedMethod
        }

        // Issue #3226: maps a declared T or T? slot type onto the index of the
        // LIFTED type parameter it names; -1 for every other shape.
        private func IndexOfLiftedTypeParameter(
            tps ImmutableArray[TypeParameterSymbol],
            liftedTps[]bool,
            declaredType TypeSymbol
        ) int32 {
            let tp TypeParameterSymbol? = declaredType as TypeParameterSymbol ??
                (
                if declaredType is NullableTypeSymbol n {
                    n.UnderlyingType as TypeParameterSymbol
                } else {
                    default(TypeParameterSymbol?)
                }
            )
            if tp == nil {
                return -1
            }
            for var k = 0; k < tps.Length; k++ {
                if liftedTps[k] && object.ReferenceEquals(tps[k], tp) {
                    return k
                }
            }
            return -1
        }
    }
}
