// <copyright file="MethodBodyEmitter.Closures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
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

/// PR-E-11 partial of (cref:MethodBodyEmitter):
/// closure / method-group / event-subscription emission (absorbed from PR-E-9 Option B).
/// See `MethodBodyEmitter.cs` for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
internal partial class MethodBodyEmitter {
    // Issue #295: emit a GSharp function value materialized as a CLR
    // delegate of the (possibly named / generic) target delegate type.
    //
    //  * For a `func` literal we reuse EmitFunctionLiteral with the target
    //    delegate as the override type, so it emits the exact same
    //    `ldnull / ldftn / newobj <Delegate>::.ctor` sequence the
    //    argument-position path uses, but bound to the requested delegate.
    //  * For any other function-typed value (a func-typed variable, call
    //    result, etc.) the runtime value is already a delegate; adapt it
    //    to the target delegate type via `dup / ldvirtftn Invoke / newobj`.
    private func EmitFunctionToDelegateConversion(
        source BoundExpression,
        sourceFn FunctionTypeSymbol,
        targetDelegateHostType Type,
        symbolicTargetCtorRef EntityHandle? = nil
    ) {
        // Issue #1502: when the SOURCE function type carries a source-defined
        // user type (Struct/Class/Interface/Enum/Delegate) or a type parameter
        // in any parameter/return position, the reflection-resolved target
        // delegate type erases that argument to System.Object (`Func<object>`
        // instead of `Func<UserType>`) because MapToReferenceClrType has no
        // MetadataLoadContext Type for a type emitted in the current
        // compilation. Route the literal / method-group materialisation through
        // the symbolic TypeSpec path (passing overrideDelegateType == null lets
        // EmitFunctionLiteral / EmitMethodGroup select GetFunctionDelegateCtorRef)
        // so the on-stack delegate value and the newobj ctor parent are the
        // reified `Func<UserType>` / `Action<UserType>` matching the target.
        let sourceNeedsSymbolic = this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(sourceFn)
        // Issue #323: when the target is the abstract System.Delegate /
        // System.MulticastDelegate base type, there is no concrete delegate
        // to instantiate. Materialize the function value as its natural
        // delegate type (Func/Action) instead; the resulting reference is
        // already a System.Delegate, so the widening is a no-op upcast.
        let targetIsDelegateBase = IsSystemDelegateHostType(targetDelegateHostType)
        let targetDelegateType = if targetIsDelegateBase {
            this.outer.signatures.ResolveDelegateClrType(sourceFn)
        } else {
            this.outer.signatures.ResolveTargetDelegateClrType(targetDelegateHostType)
        }
        // Issue #4358: `sourceNeedsSymbolic` says the SOURCE shape cannot be
        // reflected faithfully, which decides how the source `Invoke` is
        // referenced. It says nothing about the TARGET. The natural symbolic
        // `Func`/`Action` shape is a valid thing to construct only when the
        // target already IS that shape (whose reflected type arguments may be
        // erased, which is what #1502 guards against) or the `System.Delegate`
        // base (materialised as the natural shape above). Any other target is
        // a NAMED delegate — generic or not, imported or constructed
        // (`Splitter`, `GSplitter[string]`, `Predicate[T]`) — and only its
        // own ctor is correct: substituting the natural shape pushed a
        // `Func<…>` where the named delegate was expected (ilverify
        // StackUnexpected). A named target that genuinely needs a symbolic
        // ctor already arrives with `symbolicTargetCtorRef`.
        let targetIsNaturalShape = targetIsDelegateBase || this.IsNaturalDelegateShapeOf(targetDelegateType, sourceFn)
        let constructSymbolicNaturalShape = sourceNeedsSymbolic && targetIsNaturalShape
        if source is BoundFunctionLiteralExpression literal {
            if (symbolicTargetCtorRef != nil) {
                this.EmitFunctionLiteral(
                    literal,
                    overrideDelegateType: nil,
                    symbolicDelegateCtorRef: symbolicTargetCtorRef
                )
                return
            }
            // Issue #1502: an async lambda whose delegate shape needs symbolic
            // encoding is emitted through the reified TypeSpec ctor ref.
            if literal.Function.IsAsync {
                var planKey = literal.Function
                if this.outer.closures.ClosureInfos.TryGetValue(literal, out var closureForAsync) {
                    planKey = closureForAsync.InvokeMethod
                }
                // Issue #4358: the symbolic async ctor is the NATURAL
                // `Func<…, Task<…>>` shape, so it is only correct for a natural
                // target; a named target keeps its own ctor (see above).
                let asyncSymbolicCtor = if planKey.StateMachineType != nil && targetIsNaturalShape {
                    this.outer.memberRefs.TryGetSymbolicAsyncDelegateCtorRef(literal.FunctionType, planKey)
                } else {
                    nil
                }
                if (asyncSymbolicCtor != nil) {
                    this.EmitFunctionLiteral(
                        literal,
                        overrideDelegateType: nil,
                        symbolicDelegateCtorRef: asyncSymbolicCtor
                    )
                    return
                }
                this.EmitFunctionLiteral(literal, overrideDelegateType: targetDelegateType)
                return
            }
            this.EmitFunctionLiteral(
                literal,
                overrideDelegateType: if constructSymbolicNaturalShape {
                    default(Type?)
                } else {
                    targetDelegateType
                }
            )
            return
        }
        // Issue #324: a method group materializes the same `ldnull / ldftn /
        // newobj <Delegate>` sequence as a no-capture lambda, but over the
        // existing named function's MethodDef and bound to the requested
        // target delegate type.
        if source is BoundMethodGroupExpression methodGroup {
            if (symbolicTargetCtorRef != nil) {
                this.EmitMethodGroupToNamedDelegate(methodGroup, symbolicTargetCtorRef)
                return
            }
            this.EmitMethodGroup(
                methodGroup,
                overrideDelegateType: if constructSymbolicNaturalShape {
                    default(Type?)
                } else {
                    targetDelegateType
                }
            )
            return
        }
        // Issue #3931: the "conversion" is an IDENTITY when the source
        // function type's natural CLR delegate already IS the target delegate
        // type — `(int32) -> void` and `Action[int32]` are two spellings of
        // `System.Action<int>`, and `async (CancellationToken) -> void` and
        // `Func[CancellationToken, Task]` are two spellings of
        // `System.Func<CancellationToken, Task>`. Re-wrapping the value in a
        // fresh delegate over its own `Invoke` was observably wrong three
        // ways: it allocated for nothing, it broke reference identity (so
        // `-=` / `ReferenceEquals` against the original stopped matching),
        // and — the reason this surfaced — `newobj Delegate::.ctor` throws
        // `ArgumentException("Delegate to an instance method cannot have
        // null 'this'")` when the source delegate is null, turning a
        // perfectly legal null delegate field into a runtime crash. Emit the
        // value unchanged. The symbolic paths are excluded because their
        // reflection types are erased and cannot be compared.
        if !sourceNeedsSymbolic &&
            !(symbolicTargetCtorRef != nil) &&
            this
            .outer
            .signatures
            .ResolveDelegateClrType(sourceFn)
            .Equals(targetDelegateType) {
            this.EmitExpression(source)
            return
        }
        // Delegate-to-delegate adaptation: wrap the existing delegate's
        // Invoke method in a new delegate of the target type. Issue #1502:
        // when the source shape needs symbolic encoding, take the reified
        // Invoke / .ctor MemberRefs parented at the `Func<UserType>` TypeSpec
        // rather than reflecting over the type-erased `Func<object>`.
        var invokeRef EntityHandle
        if sourceNeedsSymbolic {
            invokeRef = this.outer.memberRefs.GetFunctionDelegateInvokeRef(sourceFn)
        } else {
            let sourceDelegateType = this.outer.signatures.ResolveDelegateClrType(sourceFn)
            let sourceInvoke = sourceDelegateType.GetMethod("Invoke") ??
                throw InvalidOperationException("Delegate type '${sourceDelegateType.FullName}' has no Invoke method.")
            invokeRef = this.outer.memberRefs.GetMethodReference(sourceInvoke)
        }
        let ctorRef = symbolicTargetCtorRef ??
            (
            if constructSymbolicNaturalShape {
                this.outer.memberRefs.GetFunctionDelegateCtorRef(sourceFn)
            } else {
                EntityHandle(this.outer.memberRefs.GetDelegateCtorReference(targetDelegateType))
            }
        )
        this.EmitNullGuardedDelegateToDelegateAdaptation(source, invokeRef, ctorRef)
    }

    /// Issue #2066 / #2083: emits the shared `dup / ldvirtftn / newobj`
    /// delegate-to-delegate adaptation sequence.
    ///
    /// When (cref:IsKnownLegitimateNullDelegateSource) recognizes a
    /// source that can legitimately be `null`, the sequence is guarded
    /// so a `null` source flows through as `null` instead of
    /// unconditionally rebuilding a delegate — without the guard,
    /// `ldvirtftn` resolves the (non-null) Invoke method pointer even over a
    /// `null` instance reference, and the subsequent `newobj` then throws
    /// (cref:ArgumentException) at runtime ("Delegate to an instance
    /// method cannot have null 'this'") because the CLR delegate ctor
    /// requires a non-null target for an instance-method pointer.
    ///
    /// For every other source, that same throw is the desired fail-fast
    /// behavior: a non-nullable local/parameter/field that is unexpectedly
    /// null at runtime indicates a null-safety bug. Every non-nullable case
    /// therefore keeps the plain branch-free sequence.
    ///
    /// The null path (guarded case only) must not leave the un-adapted
    /// source value (statically typed as the *source* delegate type, e.g.
    /// `Func<string>`) on the stack: when the target is a
    /// covariant-adapted delegate type (e.g. `Func<object>`),
    /// merging that source-typed value with the non-null path's newly-
    /// constructed *target*-typed value at the shared label widens the
    /// verifier-computed stack type down to their common ancestor
    /// ((cref:MulticastDelegate)), which then fails to verify against
    /// the target's expected type. Instead, the null path pops the leftover
    /// copy and pushes an explicit `ldnull`, whose null-reference type
    /// merges cleanly with any reference type, including the adapted target
    /// delegate type.
    private func EmitNullGuardedDelegateToDelegateAdaptation(
        source BoundExpression,
        invokeRef EntityHandle,
        ctorRef EntityHandle
    ) {
        this.EmitExpression(source)
        if !IsKnownLegitimateNullDelegateSource(source) {
            // Plain fail-fast sequence: no null check. If the source is
            // unexpectedly null at runtime, `newobj` throws
            // ArgumentException here rather than silently producing null.
            this.il.OpCode(ILOpCode.Dup)
            this.il.OpCode(ILOpCode.Ldvirtftn)
            this.il.Token(invokeRef)
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(ctorRef)
            return
        }
        this.il.OpCode(ILOpCode.Dup)
        let notNullLabel = this.il.DefineLabel()
        let doneLabel = this.il.DefineLabel()
        this.il.Branch(ILOpCode.Brtrue, notNullLabel)
        // Null path: discard the leftover source-typed null and push an
        // explicit `ldnull` so its stack type merges with the target
        // delegate type produced by the non-null path below.
        this.il.OpCode(ILOpCode.Pop)
        this.il.OpCode(ILOpCode.Ldnull)
        this.il.Branch(ILOpCode.Br, doneLabel)
        this.il.MarkLabel(notNullLabel)
        this.il.OpCode(ILOpCode.Dup)
        this.il.OpCode(ILOpCode.Ldvirtftn)
        this.il.Token(invokeRef)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(ctorRef)
        this.il.MarkLabel(doneLabel)
    }

    /// ADR-0059 / issue #255: emits a GSharp function value → user-declared
    /// named delegate type conversion. The delegate has no CLR Type during
    /// emit; we reference its emitted `.ctor` MethodDef directly
    /// instead of looking up a (cref:ConstructorInfo) on a runtime
    /// (cref:Type).
    private func EmitFunctionToNamedDelegateConversion(
        source BoundExpression,
        sourceFn FunctionTypeSymbol?,
        targetDelegate DelegateTypeSymbol
    ) {
        // Issue #1503: a generic named delegate (constructed or open) resolves
        // its `.ctor` through a MemberRef parented at the delegate TypeSpec; a
        // non-generic delegate uses the bare `.ctor` MethodDef handle.
        let ctorHandle = this.outer.userTokens.ResolveDelegateCtorToken(targetDelegate)
        if source is BoundFunctionLiteralExpression literal {
            this.EmitFunctionLiteralToNamedDelegate(literal, ctorHandle)
            return
        }
        if source is BoundMethodGroupExpression methodGroup {
            this.EmitMethodGroupToNamedDelegate(methodGroup, ctorHandle)
            return
        }
        // Delegate-to-delegate adaptation (CLR delegate value → named
        // delegate): wrap the source delegate's Invoke in a new named
        // delegate instance using `dup; ldvirtftn; newobj`. Issue #2066:
        // null-guarded via EmitNullGuardedDelegateToDelegateAdaptation so an
        // unsubscribed (null) source flows through as null.
        if sourceFn?.ClrType != nil && ClrTypeUtilities.IsDelegateType(sourceFn!!.ClrType) {
            let sourceDelegateType = this.outer.signatures.ResolveDelegateClrType(sourceFn!!)
            let sourceInvoke = sourceDelegateType.GetMethod("Invoke") ??
                throw InvalidOperationException("Delegate type '${sourceDelegateType.FullName}' has no Invoke method.")
            this.EmitNullGuardedDelegateToDelegateAdaptation(
                source,
                this.outer.memberRefs.GetMethodReference(sourceInvoke),
                ctorHandle
            )
            return
        }
        // Issue #2840: the source function type has no `ClrType` whenever ANY
        // type in its signature is declared in the compilation being emitted
        // (e.g. `(Src) -> void` for a source class `Src`), because
        // MapToReferenceClrType has no MetadataLoadContext Type for it. The
        // value is still a delegate at runtime, so take its `Invoke` MemberRef
        // from the reified `Func<Src>`/`Action<Src>` TypeSpec instead —
        // precisely what the CLR-delegate sibling
        // (EmitFunctionToDelegateConversion) already does for this shape.
        if sourceFn != nil && this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(sourceFn) {
            this.EmitNullGuardedDelegateToDelegateAdaptation(
                source,
                this.outer.memberRefs.GetFunctionDelegateInvokeRef(sourceFn),
                ctorHandle
            )
            return
        }
        throw NotSupportedException(
            "Cannot convert function value of type '${sourceFn?.Name}' to named delegate '${targetDelegate.Name}'."
        )
    }

    /// ADR-0059 / issue #255: emits a (cref:BoundFunctionLiteralExpression)
    /// bound to a user-declared named delegate type whose `.ctor`
    /// MethodDef handle is supplied directly. Mirrors
    /// (cref:EmitFunctionLiteral(BoundFunctionLiteralExpression, Type))
    /// but uses a metadata handle instead of a runtime (cref:Type).
    /// Issue #2338 follow-up (deferred from the primary-ctor field-token fix):
    /// when the display class was reified generic over its enclosing type
    /// parameters (issue #1477 — e.g. a lambda captures a `T`-typed value
    /// inside a generic containing type/method), the capture-site
    /// `newobj`/`stfld`/`ldftn` tokens must be MemberRefs
    /// parented at the CONSTRUCTED closure TypeSpec, exactly like the
    /// no-named-delegate sibling above already does — a bare
    /// MethodDef/FieldDef of a member on a generic type is an illegal
    /// capture-store/delegate-function token (TypeLoadException + ilverify
    /// StackUnexpected/DelegateCtor). This overload previously always used
    /// the bare (open) handles unconditionally, so a generic-reified closure
    /// bound to a named (rather than `Func`/`Action`) delegate type crashed
    /// the same way primary-ctor field stores did before the #2338 fix.
    private func EmitFunctionLiteralToNamedDelegate(
        literal BoundFunctionLiteralExpression,
        delegateCtorHandle EntityHandle
    ) {
        if this.outer.closures.ClosureInfos.TryGetValue(literal, out var closure) {
            if !this.outer.cache.ClassCtorHandles.TryGetValue(closure.ClassSym, out var closureCtor) {
                throw InvalidOperationException("Closure class '${closure.ClassSym.Name}' has no emitted constructor.")
            }
            if !this.outer.cache.MethodHandles.TryGetValue(closure.InvokeMethod, out var closureInvoke) {
                throw InvalidOperationException(
                    "Closure invoke method '${closure.InvokeMethod.Name}' has no emitted MethodDef."
                )
            }
            let constructedClosure = closure.ConstructedClassSym
            let closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure)
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(
                if closureIsGeneric {
                    this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
                } else {
                    closureCtor
                }
            )
            for captured in literal.CapturedVariables {
                if !closure.CaptureFields.TryGetValue(captured, out var field) {
                    throw InvalidOperationException(
                        "Closure for '${literal.Function.Name}' has no field for captured '${captured.Name}'."
                    )
                }
                var fieldToken EntityHandle
                if closureIsGeneric {
                    fieldToken = this.outer.userTokens.ResolveFieldToken(constructedClosure, field)
                } else if this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle) {
                    fieldToken = fieldHandle
                } else {
                    throw InvalidOperationException("Closure field '${field.Name}' has no emitted FieldDef.")
                }
                this.il.OpCode(ILOpCode.Dup)
                this.EmitCapturedVariableLoad(captured)
                this.il.OpCode(ILOpCode.Stfld)
                this.il.Token(fieldToken)
            }
            this.il.OpCode(ILOpCode.Ldftn)
            this.il.Token(
                if closureIsGeneric {
                    this
                        .outer
                        .userTokens
                        .ResolveClosureInvokeFtnToken(constructedClosure, closure.ClassSym, closure.InvokeMethod)
                } else {
                    closureInvoke
                }
            )
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(delegateCtorHandle)
            return
        }
        if literal.CapturedVariables.Length > 0 {
            throw NotSupportedException(
                "Function literal '${literal.Function.Name}' captures outer variables; closure emit fell through synthesis."
            )
        }
        if !this.outer.cache.FunctionHandles.TryGetValue(literal.Function, out _) {
            throw InvalidOperationException("Function literal '${literal.Function.Name}' has no emitted MethodDef.")
        }
        this.il.OpCode(ILOpCode.Ldnull)
        this.il.OpCode(ILOpCode.Ldftn)
        this.il.Token(this.outer.userTokens.ResolveLambdaFunctionFtnToken(literal.Function))
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(delegateCtorHandle)
    }

    /// ADR-0059 / issue #255: emits a static method group bound to a
    /// user-declared named delegate type using its emitted `.ctor`
    /// MethodDef handle. Mirrors
    /// (cref:EmitMethodGroup(BoundMethodGroupExpression, Type)).
    /// Issue #503 follow-up: instance method groups load the receiver
    /// first so the resulting delegate's `Target` binds to the
    /// captured instance.
    private func EmitMethodGroupToNamedDelegate(
        methodGroup BoundMethodGroupExpression,
        delegateCtorHandle EntityHandle
    ) {
        this.EmitMethodGroupTarget(methodGroup)
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(delegateCtorHandle)
    }

    /// Emits the shared prologue of a user method-group-to-delegate
    /// conversion: it resolves the function pointer token and leaves the
    /// delegate-constructor operands on the stack — `ldnull; ldftn ftn`
    /// for a static group, or `<receiver>; [box]; dup; ldvirtftn ftn`
    /// / `<receiver>; [box]; ldftn ftn` for an instance group — ready
    /// for the caller's `newobj <Delegate>::.ctor(object, IntPtr)`.
    /// Both the named-delegate path ((cref:EmitMethodGroupToNamedDelegate))
    /// and the synthesized/CLR-delegate path
    /// ((cref:EmitMethodGroup(BoundMethodGroupExpression, Type))) share
    /// this single implementation so the #1397 interface-receiver ldvirtftn and
    /// #1467 generic-receiver token handling live in exactly one place.
    private func EmitMethodGroupTarget(methodGroup BoundMethodGroupExpression) {
        let function = Invariant.Required(
            methodGroup.Function,
            "a method group whose candidate set is empty is an unresolved-overload error node, which the binder reports rather than handing to emit",
            expression: "methodGroup.Function"
        )
        var ftnToken EntityHandle
        if methodGroup.Receiver?.Type is StructSymbol receiverStruct && function.ReceiverType is StructSymbol {
            let owner = ResolveUserInstanceMethodOwner(receiverStruct, function)
            ftnToken = this.outer.userTokens.ResolveUserInstanceMethodToken(owner, function)
        } else if this
            .outer
            .cache
            .FunctionHandles
            .TryGetValue(function, out var staticHandle) ||
            this
            .outer
            .cache
            .MethodHandles
            .TryGetValue(function, out staticHandle) {
            ftnToken = staticHandle
        } else {
            throw InvalidOperationException("Method group '${function.Name}' has no emitted MethodDef.")
        }
        // Issue #1467: when the method group targets an instance method of a
        // user-declared GENERIC type, the `ldftn`/`ldvirtftn` target must be a
        // MemberRef parented at the constructed receiver TypeSpec — a bare
        // MethodDef of a method on a generic type is not a valid delegate-ctor
        // function token (ilverify `DelegateCtor`). Re-resolve through the
        // receiver's type.
        if methodGroup.Receiver == nil &&
            methodGroup.StaticOwnerType != nil &&
            ReflectionMetadataEmitter
            .IsUserGenericTypeReference(methodGroup.StaticOwnerType) {
            ftnToken = this.outer.userTokens.ResolveUserStaticMethodToken(methodGroup.StaticOwnerType, function)
        }
        if function.IsGeneric {
            if methodGroup.MethodTypeArguments.Length != function.TypeParameters.Length {
                throw InvalidOperationException(
                    "Generic method group '${function.Name}' has no inferred type arguments."
                )
            }
            ftnToken = this.outer.userTokens.BuildMethodSpecForGenericMethodGroup(ftnToken, methodGroup)
        }
        if methodGroup.Receiver == nil {
            this.il.OpCode(ILOpCode.Ldnull)
            this.il.OpCode(ILOpCode.Ldftn)
            this.il.Token(ftnToken)
        } else {
            this.EmitExpression(methodGroup.Receiver)
            // Box value-type receivers so the resulting delegate's Target
            // slot (typed `object`) holds a reference.
            if ReflectionMetadataEmitter.IsValueTypeSymbol(methodGroup.Receiver!!.Type) {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(methodGroup.Receiver!!.Type))
            }
            // For an `open` (virtual) / `override` instance method — and,
            // per issue #1397, an interface-typed receiver — dispatch via
            // `ldvirtftn` so the delegate invokes the concrete implementation.
            // Non-virtual / sealed methods use `ldftn` directly.
            if !methodGroup.ForceNonVirtualDispatch &&
                (function.IsOpen || function.IsOverride || methodGroup.Receiver!!.Type is InterfaceSymbol) {
                this.il.OpCode(ILOpCode.Dup)
                this.il.OpCode(ILOpCode.Ldvirtftn)
                this.il.Token(ftnToken)
            } else {
                this.il.OpCode(ILOpCode.Ldftn)
                this.il.Token(ftnToken)
            }
        }
    }

    private func EmitClrEventSubscription(subscription BoundClrEventSubscriptionExpression) {
        // Stream B′ emit parity: `+=` / `-=` calls the event's add_X /
        // remove_X accessor. Both accessors are void-returning.
        let receiver BoundExpression? = subscription.Receiver
        let isStatic = receiver == nil
        let receiverIsValueType = receiver != nil && ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type)
        if subscription.IsConstrainedTypeParameterAccess {
            this.EmitConstrainedTypeParameterReceiver(
                Invariant.Required(
                    receiver,
                    "a constrained type-parameter event subscription dispatches on a receiver",
                    expression: "receiver"
                )
            )
        } else if receiver != nil {
            this.EmitInstanceReceiver(receiver)
        }
        // Function-literal handlers default to Action/Func; redirect them
        // to the event's actual delegate type so the AddEventHandler call
        // is type-correct.
        if subscription.Handler is BoundFunctionLiteralExpression literalHandler &&
            subscription
            .Event
            .EventHandlerType != nil {
            let mappedDelegateType = this.outer.signatures.MapToReferenceClrType(subscription.Event.EventHandlerType)
            this.EmitFunctionLiteral(literalHandler, mappedDelegateType)
        } else {
            this.EmitExpression(subscription.Handler)
        }
        // Issue #3705: the binder decides accessibility (including a friend
        // assembly's `internal` event); emit must not re-derive it with a
        // narrower probe, or a bound subscription would fail here.
        let accessor MethodInfo? = if subscription.IsAdd {
            subscription.Event.GetAddMethod(nonPublic: true)
        } else {
            subscription.Event.GetRemoveMethod(nonPublic: true)
        }
        if accessor == nil {
            throw InvalidOperationException(
                "Event '${subscription.Event.DeclaringType?.FullName}.${subscription.Event.Name}' has no ${(if subscription.IsAdd { "add" } else { "remove" })} accessor."
            )
        }
        if subscription.IsConstrainedTypeParameterAccess {
            this.il.OpCode(ILOpCode.Constrained)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(subscription.ConstrainedReceiverTypeParameter!!))
            this.il.OpCode(ILOpCode.Callvirt)
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(accessor, subscription.ConstrainedInterfaceType))
        } else {
            this.il.OpCode(
                if isStatic || receiverIsValueType || subscription.IsNonVirtualBaseCall {
                    ILOpCode.Call
                } else {
                    ILOpCode.Callvirt
                }
            )
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(accessor, subscription.EventContainingType))
        }
    }

    private func EmitUserEventSubscription(node BoundEventSubscriptionExpression) {
        // ADR-0052: user-defined event subscription — call add_X or remove_X accessor.
        if node.Receiver != nil {
            if node.Receiver.Type is TypeParameterSymbol typeParameterReceiver {
                // Issue #2519: mirror constrained field/property access. Boxing
                // a reference-shaped T is a runtime no-op and provides the
                // verifier with the class-constraint receiver shape expected by
                // the event accessor.
                this.EmitExpression(node.Receiver)
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(typeParameterReceiver))
            } else {
                this.EmitInstanceReceiver(node.Receiver!!)
            }
        }
        // Issue #503: function-literal handlers default to Action/Func
        // when emitted standalone, but the add_X / remove_X accessor takes
        // the event's declared delegate type (e.g. System.EventHandler, or
        // a CLR-delegate named in the event clause). Without this
        // redirection, an Action<object, EventArgs> is pushed and the IL
        // is unverifiable / crashes at runtime — the silent MSB4181 the
        // issue reports. Apply the same delegate-type override the CLR
        // event path (EmitClrEventSubscription) already uses, so capturing
        // and non-capturing lambdas both flow through the closure builder
        // with the correct target delegate ctor (object, IntPtr).
        if node.Handler is BoundFunctionLiteralExpression literalHandler &&
            node.EventType is ImportedTypeSymbol{OpenDefinition: not nil} symbolicDelegate {
            this.EmitFunctionLiteral(
                literalHandler,
                overrideDelegateType: nil,
                symbolicDelegateCtorRef: this.outer.memberRefs.GetConstructedDelegateCtorRef(symbolicDelegate)
            )
        } else if node.Handler is BoundFunctionLiteralExpression literalHandlerWithClrType &&
            node
            .EventType
            ?.ClrType != nil {
            let mappedDelegateType = this.outer.signatures.MapToReferenceClrType(node.EventType.ClrType)
            this.EmitFunctionLiteral(literalHandlerWithClrType, mappedDelegateType)
        } else {
            this.EmitExpression(node.Handler)
        }
        if this.outer.cache.EventAccessorHandles.TryGetValue(node.Event, out var accessorHandles) {
            let accessorMethodSymbol FunctionSymbol? = if node.IsAdd {
                node.Event.AddMethodSymbol
            } else {
                node.Event.RemoveMethodSymbol
            }
            let accessorHandle = if node.IsAdd {
                accessorHandles.Add
            } else {
                accessorHandles.Remove
            }
            if node.Receiver == nil &&
                node.StructType is StructSymbol staticOwner &&
                ReflectionMetadataEmitter.IsUserGenericTypeReference(staticOwner) && accessorMethodSymbol != nil {
                let accessorToken = this
                    .outer
                    .userTokens
                    .ResolveUserStaticMethodToken(staticOwner, accessorMethodSymbol, accessorHandle)
                this.il.OpCode(ILOpCode.Call)
                this.il.Token(accessorToken)
                return
            }
            if node.Receiver != nil &&
                node.StructType is StructSymbol instanceOwner &&
                ReflectionMetadataEmitter.IsUserGenericTypeReference(instanceOwner) && accessorMethodSymbol != nil {
                let accessorToken = this
                    .outer
                    .userTokens
                    .ResolveUserInstanceMethodToken(instanceOwner, accessorMethodSymbol, accessorHandle)
                this.il.OpCode(
                    if node.IsNonVirtualBaseCall {
                        ILOpCode.Call
                    } else {
                        InstanceAccessorOpCode(node.Receiver!!)
                    }
                )
                this.il.Token(accessorToken)
                return
            }
            // ADR-0149 follow-up (issue #2370): a generic-interface-typed
            // receiver (`b: IWatchable[int32]; b.Changed += h`) must reach
            // the add/remove accessor through a MemberRef parented at the
            // constructed TypeSpec, exactly like EmitUserInstanceCall's
            // generic-interface call path — the bare MethodDef planned
            // above is only valid for the OPEN interface definition.
            if node.StructType is InterfaceSymbol ifaceOwner &&
                ReflectionMetadataEmitter.IsUserGenericInterfaceReference(ifaceOwner) && accessorMethodSymbol != nil {
                let accessorToken = this
                    .outer
                    .userTokens
                    .ResolveUserInterfaceInstanceMethodToken(ifaceOwner, accessorMethodSymbol)
                this.il.OpCode(ILOpCode.Callvirt)
                this.il.Token(accessorToken)
                return
            }
            // Issue #4312: a static accessor is `call`; an instance accessor follows
            // the receiver, not the event's own `virtual`/`override` modifiers.
            this.il.OpCode(
                if node.Receiver == nil || node.IsNonVirtualBaseCall {
                    ILOpCode.Call
                } else {
                    InstanceAccessorOpCode(node.Receiver)
                }
            )
            this.il.Token(accessorHandle)
        }
    }

    // Phase 4 emit parity (E1): function literal `func(x int) int { return x+1 }`
    // with no captured variables lowers to:
    //
    //   ldnull                            ; the `this` argument of the delegate
    //   ldftn  <synthesizedStaticMethod>  ; pushes the IntPtr for the body
    //   newobj Func<int,int>::.ctor(object, IntPtr)
    //
    // The synthesized method was registered earlier by CollectFunctionLiterals
    // and assigned a MethodDef row via functionHandles. The delegate's
    // constructor is looked up off literal.FunctionType.ClrType — every
    // Func<>/Action<> shipped by the BCL exposes the single canonical
    // `(object, IntPtr)` ctor.
    private func EmitFunctionLiteral(literal BoundFunctionLiteralExpression) {
        // For async lambdas, resolve the delegate type from the selected
        // builder: Task-wrapped for ordinary async, void-shaped for async void.
        var asyncDelegateOverride Type? = nil
        if literal.Function.IsAsync {
            // For no-capture lambdas, the plan's kickoff is literal.Function.
            // For capture-bearing lambdas, the plan's kickoff is closure.InvokeMethod.
            var planKey = literal.Function
            if this.outer.closures.ClosureInfos.TryGetValue(literal, out var closureForAsync) {
                planKey = closureForAsync.InvokeMethod
            }
            if planKey.StateMachineType != nil {
                // Issue #1502: when the Task-wrapped delegate shape carries a
                // source-defined user type or a type-parameter result/parameter
                // (`Func<...,Task<TOutput>>`), route through the symbolic
                // TypeSpec ctor ref instead of the type-erased reflection type.
                let asyncSymbolicCtor = this
                    .outer
                    .memberRefs
                    .TryGetSymbolicAsyncDelegateCtorRef(literal.FunctionType, planKey)
                if (asyncSymbolicCtor != nil) {
                    this.EmitFunctionLiteral(
                        literal,
                        overrideDelegateType: nil,
                        symbolicDelegateCtorRef: asyncSymbolicCtor
                    )
                    return
                }
                asyncDelegateOverride = this.outer.signatures.ResolveAsyncDelegateClrType(literal.FunctionType, planKey)
            }
        }
        EmitFunctionLiteral(literal, overrideDelegateType: asyncDelegateOverride)
    }

    private func EmitFunctionLiteral(literal BoundFunctionLiteralExpression, overrideDelegateType Type?) {
        this.EmitFunctionLiteral(literal, overrideDelegateType, symbolicDelegateCtorRef: nil)
    }

    private func EmitGenericLocalClosureInstance(
        literal BoundFunctionLiteralExpression,
        closure ClosureEmitter.ClosureInfo
    ) {
        // Issue #4341 follow-up: a direct-call generic local function whose
        // closure class was nested inside a GENERIC lexical encloser (and so
        // reified over the encloser's own type parameters, see
        // ClosureEmitter.CollectOwnerTypeParameters) is itself a generic
        // type. A bare MethodDef/FieldDef of a member on a generic type is
        // an illegal ctor/field token (TypeLoadException at load), so route
        // through the constructed-TypeSpec token machinery — mirroring the
        // capture-bearing delegate path in EmitFunctionLiteral above.
        let constructedClosure = closure.ConstructedClassSym
        let closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure)
        if !this.outer.cache.ClassCtorHandles.TryGetValue(closure.ClassSym, out var ctorHandle) {
            throw InvalidOperationException("Closure class '${closure.ClassSym.Name}' has no emitted constructor.")
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(
            if closureIsGeneric {
                this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
            } else {
                ctorHandle
            }
        )
        for captured in literal.CapturedVariables {
            if !closure.CaptureFields.TryGetValue(captured, out var field) {
                throw InvalidOperationException(
                    "Closure for '${literal.Function.Name}' has no field mapping for captured '${captured.Name}'."
                )
            }
            var fieldHandle EntityHandle
            if closureIsGeneric {
                fieldHandle = this.outer.userTokens.ResolveFieldToken(constructedClosure, field)
            } else if !this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldDefHandle) {
                throw InvalidOperationException(
                    "Closure for '${literal.Function.Name}' has no emitted FieldDef for captured '${captured.Name}'."
                )
            } else {
                fieldHandle = fieldDefHandle
            }
            this.il.OpCode(ILOpCode.Dup)
            this.EmitCapturedVariableLoad(captured)
            this.il.OpCode(ILOpCode.Stfld)
            this.il.Token(fieldHandle)
        }
    }

    private func EmitFunctionLiteral(
        literal BoundFunctionLiteralExpression,
        overrideDelegateType Type?,
        symbolicDelegateCtorRef EntityHandle?
    ) {
        if this.outer.closures.ClosureInfos.TryGetValue(literal, out var closure) {
            // Capture-bearing literal: instantiate the closure class,
            // snapshot each captured variable into its field, then bind
            // the delegate to the instance method.
            //
            //   newobj <closureClass>::.ctor()
            //   foreach capture:
            //       dup
            //       <load captured value>
            //       stfld <closureClass>::<field>
            //   dup
            //   ldftn  <closureClass>::Invoke
            //   newobj Func/Action::.ctor(object, IntPtr)
            if !this.outer.cache.ClassCtorHandles.TryGetValue(closure.ClassSym, out var ctorHandle) {
                throw InvalidOperationException("Closure class '${closure.ClassSym.Name}' has no emitted constructor.")
            }
            if !this.outer.cache.MethodHandles.TryGetValue(closure.InvokeMethod, out var invokeHandle) {
                throw InvalidOperationException(
                    "Closure invoke method '${closure.InvokeMethod.Name}' has no emitted MethodDef."
                )
            }
            // Issue #1477: when the display class was reified generic over its
            // enclosing type parameters, the capture-site newobj / stfld / ldftn
            // tokens must be MemberRefs parented at the CONSTRUCTED closure
            // TypeSpec (`Closure`1<…enclosing args…>`) — a bare MethodDef/FieldDef
            // of a member on a generic type is an illegal capture-store/delegate
            // function token (TypeLoadException + ilverify StackUnexpected/
            // DelegateCtor). Reuse the existing user-generic token machinery.
            let constructedClosure = closure.ConstructedClassSym
            let closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure)
            this.il.OpCode(ILOpCode.Newobj)
            this.il.Token(
                if closureIsGeneric {
                    this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
                } else {
                    ctorHandle
                }
            )
            for captured in literal.CapturedVariables {
                if !closure.CaptureFields.TryGetValue(captured, out var field) {
                    throw InvalidOperationException(
                        "Closure for '${literal.Function.Name}' has no field for captured '${captured.Name}'."
                    )
                }
                var fieldToken EntityHandle
                if closureIsGeneric {
                    fieldToken = this.outer.userTokens.ResolveFieldToken(constructedClosure, field)
                } else if this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle) {
                    fieldToken = fieldHandle
                } else {
                    throw InvalidOperationException("Closure field '${field.Name}' has no emitted FieldDef.")
                }
                this.il.OpCode(ILOpCode.Dup)
                this.EmitCapturedVariableLoad(captured)
                this.il.OpCode(ILOpCode.Stfld)
                this.il.Token(fieldToken)
            }
            this.il.OpCode(ILOpCode.Ldftn)
            this.il.Token(
                if closureIsGeneric {
                    this
                        .outer
                        .userTokens
                        .ResolveClosureInvokeFtnToken(constructedClosure, closure.ClassSym, closure.InvokeMethod)
                } else {
                    invokeHandle
                }
            )
            this.il.OpCode(ILOpCode.Newobj)
            // ADR-0087 §3 R6: when the literal's effective delegate
            // shape carries type-parameter slots (e.g. `func(T) U`), no
            // host CLR type exists for `ResolveDelegateClrType` to
            // reflect over. Use a MemberRef parented at the reified
            // `Func<...>` / `Action<...>` TypeSpec instead — the .ctor
            // signature is the canonical `(object, IntPtr)`.
            if (symbolicDelegateCtorRef != nil) {
                this.il.Token(symbolicDelegateCtorRef)
            } else if overrideDelegateType == nil &&
                (
                literal
                    .FunctionType
                    .ClrType == nil ||
                    this
                    .outer
                    .userTokens
                    .FunctionTypeNeedsSymbolicDelegate(literal.FunctionType)
            ) {
                this.il.Token(this.outer.memberRefs.GetFunctionDelegateCtorRef(literal.FunctionType))
            } else {
                let delegateTypeC = overrideDelegateType ??
                    this
                    .outer
                    .signatures
                    .ResolveDelegateClrType(literal.FunctionType)
                this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateTypeC))
            }
            return
        }
        if literal.CapturedVariables.Length > 0 {
            throw NotSupportedException(
                "Function literal '${literal.Function.Name}' captures outer variables; closure emit fell through synthesis."
            )
        }
        if !this.outer.cache.FunctionHandles.TryGetValue(literal.Function, out _) {
            throw InvalidOperationException("Function literal '${literal.Function.Name}' has no emitted MethodDef.")
        }
        this.il.OpCode(ILOpCode.Ldnull)
        this.il.OpCode(ILOpCode.Ldftn)
        this.il.Token(this.outer.userTokens.ResolveLambdaFunctionFtnToken(literal.Function))
        this.il.OpCode(ILOpCode.Newobj)
        // ADR-0087 §3 R6: see capture-bearing branch above — reified
        // ctor MemberRef when the function shape is type-parameter-bearing.
        if (symbolicDelegateCtorRef != nil) {
            this.il.Token(symbolicDelegateCtorRef)
        } else if overrideDelegateType == nil &&
            (
            literal
                .FunctionType
                .ClrType == nil ||
                this
                .outer
                .userTokens
                .FunctionTypeNeedsSymbolicDelegate(literal.FunctionType)
        ) {
            this.il.Token(this.outer.memberRefs.GetFunctionDelegateCtorRef(literal.FunctionType))
        } else {
            let delegateType = overrideDelegateType ??
                this
                .outer
                .signatures
                .ResolveDelegateClrType(literal.FunctionType)
            this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateType))
        }
    }

    // Issue #324: emit a named-function method group as a delegate. The
    // function already has a static MethodDef row in functionHandles, so we
    // reuse the no-capture lambda sequence: `ldnull; ldftn <method>; newobj
    // <Delegate>::.ctor(object, IntPtr)`. The delegate type is the target
    // when one is supplied (a `Func[...]`/`Action[...]` conversion target),
    // otherwise the native delegate for the function's own signature.
    //
    // Issue #503 follow-up: when the method group binds an instance method
    // (e.g. `this.OnHit` or a bare `OnHit` inside the declaring class) the
    // emitter loads the receiver first and uses `ldftn`/`ldvirtftn` so the
    // resulting delegate's `Target` is the captured instance. This is the
    // user-event method-group subscription path; CLR-event method groups
    // already go through EmitClrMethodGroup.
    private func EmitMethodGroup(methodGroup BoundMethodGroupExpression, overrideDelegateType Type?) {
        // A method group reaches emit only after overload resolution has
        // picked one candidate; the multi-candidate constructor's form, where
        // Function and FunctionType are unset, is a bind-time shape only.
        let function = Invariant.Required(
            methodGroup.Function,
            "overload resolution resolves a method group to a single function before emit",
            expression: "methodGroup.Function"
        )
        let functionType = Invariant.Required(
            methodGroup.FunctionType,
            "a resolved method group carries the function type overload resolution selected",
            expression: "methodGroup.FunctionType"
        )
        var delegateType Type? = nil
        if overrideDelegateType != nil ||
            (functionType.ClrType != nil && !this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(functionType)) {
            delegateType = overrideDelegateType ?? this.outer.signatures.ResolveDelegateClrType(functionType)
        }
        if function.IsExtension && methodGroup.Receiver != nil {
            if !this
                .outer
                .cache
                .FunctionHandles
                .TryGetValue(function, out var methodHandle) &&
                !this
                .outer
                .cache
                .MethodHandles
                .TryGetValue(function, out methodHandle) {
                throw InvalidOperationException("Extension method group '${function.Name}' has no emitted MethodDef.")
            }
            let delegateTypeHandle = if delegateType == nil {
                this.outer.memberRefs.GetFunctionDelegateTypeSpec(functionType)
            } else {
                this.outer.memberRefs.GetTypeHandleForMember(delegateType)
            }
            this.EmitClosedStaticMethodGroup(methodGroup.Receiver!!, methodHandle, delegateTypeHandle)
            return
        }
        // Shared prologue: resolves the (interface/generic-aware) function
        // pointer token and leaves the delegate-ctor operands on the stack.
        this.EmitMethodGroupTarget(methodGroup)
        this.il.OpCode(ILOpCode.Newobj)
        // ADR-0087 §3 R6: reified MemberRef when the method-group's
        // delegate shape carries type-parameter slots.
        if delegateType == nil {
            this.il.Token(this.outer.memberRefs.GetFunctionDelegateCtorRef(functionType))
        } else {
            this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateType))
        }
    }

    // Issue #337: emit a resolved CLR member method group as a delegate over
    // the selected overload. Static groups load a null target and the method
    // address (`ldnull; ldftn`); instance groups evaluate the receiver and
    // load its (virtual) address (`<recv>; [dup; ldvirtftn] / ldftn`),
    // capturing the receiver as the delegate target. The constructed
    // delegate is the resolved target type (`Func[...]`/`Action[...]` or a
    // named delegate), resolved onto the emitter's reference context.
    private func EmitClrMethodGroup(methodGroup BoundClrMethodGroupExpression) {
        let method = methodGroup.ResolvedMethod ??
            throw InvalidOperationException(
            "CLR method group '${methodGroup.MethodName}' reached emit without overload resolution."
        )
        let hostDelegate = methodGroup
            .DelegateType
            ?.ClrType ??
            throw InvalidOperationException(
            "CLR method group '${methodGroup.MethodName}' has no resolved target delegate type."
        )
        let delegateType = this.outer.signatures.ResolveTargetDelegateClrType(hostDelegate)
        let methodRef = this.outer.memberRefs.GetMethodReference(method)
        if method.IsStatic && methodGroup.Receiver != nil {
            this.EmitClosedStaticMethodGroup(
                methodGroup.Receiver,
                methodRef,
                this.outer.memberRefs.GetTypeHandleForMember(delegateType),
                method
            )
            return
        }
        if method.IsStatic {
            this.il.OpCode(ILOpCode.Ldnull)
            this.il.OpCode(ILOpCode.Ldftn)
            this.il.Token(methodRef)
        } else {
            let instanceReceiver = Invariant.Required(
                methodGroup.Receiver,
                "an instance method group binds a receiver: the receiverless form is only constructed for a group qualified by a static type",
                expression: "methodGroup.Receiver"
            )
            this.EmitExpression(instanceReceiver)
            // Issue #420 (P3-1): the delegate ctor signature is
            // `(object target, IntPtr ptr)` and `ldvirtftn` requires an
            // object reference on the stack. The binder currently rejects
            // method-group conversions whose receiver is a value type, but
            // if that gate ever loosens (or a future codepath constructs
            // a `BoundClrMethodGroupExpression` with a struct receiver),
            // emitting the raw value would produce unverifiable IL that
            // silently corrupts the stack. Defensively box value-type
            // receivers so the emitted sequence stays verifiable.
            if ReflectionMetadataEmitter.IsValueTypeSymbol(instanceReceiver.Type) {
                this.il.OpCode(ILOpCode.Box)
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(instanceReceiver.Type))
            }
            if method.IsVirtual && !method.IsFinal {
                this.il.OpCode(ILOpCode.Dup)
                this.il.OpCode(ILOpCode.Ldvirtftn)
                this.il.Token(methodRef)
            } else {
                this.il.OpCode(ILOpCode.Ldftn)
                this.il.Token(methodRef)
            }
        }
        this.il.OpCode(ILOpCode.Newobj)
        this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateType))
    }

    private func EmitClosedStaticMethodGroup(
        receiver BoundExpression,
        methodHandle EntityHandle,
        delegateTypeHandle EntityHandle,
        importedMethod MethodInfo? = nil
    ) {
        this.il.OpCode(ILOpCode.Ldtoken)
        this.il.Token(delegateTypeHandle)
        this.il.Call(this.outer.wellKnown.GetTypeFromHandleReference())
        this.EmitExpression(receiver)
        if ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type) {
            this.il.OpCode(ILOpCode.Box)
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(receiver.Type))
        }
        if importedMethod != nil {
            this.EmitMethodInfoLiteral(importedMethod)
        } else {
            this.il.OpCode(ILOpCode.Ldtoken)
            this.il.Token(methodHandle)
            this.il.Call(this.outer.wellKnown.GetMethodFromHandleReference())
            this.il.OpCode(ILOpCode.Castclass)
            this.il.Token(this.outer.memberRefs.GetTypeReference(typeof(MethodInfo)))
        }
        this.il.Call(this.outer.wellKnown.GetClosedStaticDelegateCreateReference())
        this.il.OpCode(ILOpCode.Castclass)
        this.il.Token(delegateTypeHandle)
    }

    // Phase 4 emit parity: load a captured variable. In an async or async-
    // iterator MoveNext body, the variable may be hoisted to a state-machine
    // field; emit the field load instead of a local/parameter load.
    private func EmitCapturedVariableLoad(captured VariableSymbol) {
        // An enclosing capture lives in the display class, not in an
        // uninitialized local slot inferred by the nested async capture walk.
        if this.TryLoadFromEnclosingClosure(captured) {
            return
        }
        var hoistedField FieldSymbol? = nil
        if (this.asyncFieldMap != nil && this.asyncFieldMap.TryGetHoistedField(captured, out hoistedField)) ||
            (this.iteratorEmitCtx != nil && this.iteratorEmitCtx.FieldMap.TryGetValue(captured, out hoistedField)) {
            // Load from the state machine: ldarg.0; ldfld <smStruct>::<hoistedField>
            this.il.OpCode(ILOpCode.Ldarg_0)
            this.il.OpCode(ILOpCode.Ldfld)
            this.il.Token(this.ResolveCurrentStateMachineFieldToken(hoistedField!!))
            return
        }
        this.EmitExpression(BoundVariableExpression(nil, captured))
    }

    shared {
        /// Returns true when [`source`](paramref) can legitimately contain a
        /// null delegate: either its effective type is nullable, or it reads a
        /// field-like event's compiler-synthesized backing field (which is null
        /// before the first subscription despite its non-nullable declared type).
        /// Smart-cast narrowing changes the effective type, so a guarded nullable
        /// source remains on the branch-free non-null path.
        private func IsKnownLegitimateNullDelegateSource(source BoundExpression) bool {
            if source.Type is NullableTypeSymbol {
                return true
            }
            return switch source {
                case fieldAccess is BoundFieldAccessExpression: fieldAccess.Field?.IsEventBackingField == true
                case BoundVariableExpression{Variable: ImplicitFieldVariableSymbol implicitField}: implicitField
                    .Field
                    ?.IsEventBackingField == true
                default: false
            }
        }
    }
}
