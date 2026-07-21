// <copyright file="MethodBodyEmitter.Closures.cs" company="GSharp">
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
/// closure / method-group / event-subscription emission (absorbed from PR-E-9 Option B).
/// See <c>MethodBodyEmitter.cs</c> for the root partial (fields, constructor,
/// statement/expression dispatch, and small shared helpers).
/// </summary>
internal sealed partial class MethodBodyEmitter
{

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
    private void EmitFunctionToDelegateConversion(
        BoundExpression source,
        FunctionTypeSymbol sourceFn,
        Type targetDelegateHostType,
        EntityHandle? symbolicTargetCtorRef = null)
    {
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
        bool sourceNeedsSymbolic = this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(sourceFn);

        // Issue #323: when the target is the abstract System.Delegate /
        // System.MulticastDelegate base type, there is no concrete delegate
        // to instantiate. Materialize the function value as its natural
        // delegate type (Func/Action) instead; the resulting reference is
        // already a System.Delegate, so the widening is a no-op upcast.
        var targetDelegateType = IsSystemDelegateHostType(targetDelegateHostType)
            ? this.outer.signatures.ResolveDelegateClrType(sourceFn)
            : this.outer.signatures.ResolveTargetDelegateClrType(targetDelegateHostType);

        if (source is BoundFunctionLiteralExpression literal)
        {
            if (symbolicTargetCtorRef.HasValue)
            {
                this.EmitFunctionLiteral(literal, overrideDelegateType: null, symbolicDelegateCtorRef: symbolicTargetCtorRef.Value);
                return;
            }

            // Issue #1502: an async lambda whose Task-wrapped delegate shape
            // needs symbolic encoding (`Func<...,Task<TOutput>>`) is emitted
            // through the reified TypeSpec ctor ref.
            if (literal.Function.IsAsync)
            {
                FunctionSymbol planKey = literal.Function;
                if (this.outer.closures.ClosureInfos.TryGetValue(literal, out var closureForAsync))
                {
                    planKey = closureForAsync.InvokeMethod;
                }

                var asyncSymbolicCtor = planKey.StateMachineType != null
                    ? this.outer.memberRefs.TryGetSymbolicAsyncDelegateCtorRef(literal.FunctionType, planKey)
                    : null;
                if (asyncSymbolicCtor.HasValue)
                {
                    this.EmitFunctionLiteral(literal, overrideDelegateType: null, symbolicDelegateCtorRef: asyncSymbolicCtor.Value);
                    return;
                }

                this.EmitFunctionLiteral(literal, overrideDelegateType: targetDelegateType);
                return;
            }

            this.EmitFunctionLiteral(literal, overrideDelegateType: sourceNeedsSymbolic ? null : targetDelegateType);
            return;
        }

        // Issue #324: a method group materializes the same `ldnull / ldftn /
        // newobj <Delegate>` sequence as a no-capture lambda, but over the
        // existing named function's MethodDef and bound to the requested
        // target delegate type.
        if (source is BoundMethodGroupExpression methodGroup)
        {
            if (symbolicTargetCtorRef.HasValue)
            {
                this.EmitMethodGroupToNamedDelegate(methodGroup, symbolicTargetCtorRef.Value);
                return;
            }

            this.EmitMethodGroup(methodGroup, overrideDelegateType: sourceNeedsSymbolic ? null : targetDelegateType);
            return;
        }

        // Delegate-to-delegate adaptation: wrap the existing delegate's
        // Invoke method in a new delegate of the target type. Issue #1502:
        // when the source shape needs symbolic encoding, take the reified
        // Invoke / .ctor MemberRefs parented at the `Func<UserType>` TypeSpec
        // rather than reflecting over the type-erased `Func<object>`.
        EntityHandle invokeRef;
        if (sourceNeedsSymbolic)
        {
            invokeRef = this.outer.memberRefs.GetFunctionDelegateInvokeRef(sourceFn);
        }
        else
        {
            var sourceDelegateType = this.outer.signatures.ResolveDelegateClrType(sourceFn);
            var sourceInvoke = sourceDelegateType.GetMethod("Invoke")
                ?? throw new InvalidOperationException(
                    $"Delegate type '{sourceDelegateType.FullName}' has no Invoke method.");
            invokeRef = this.outer.memberRefs.GetMethodReference(sourceInvoke);
        }

        var ctorRef = symbolicTargetCtorRef
            ?? (sourceNeedsSymbolic
            ? this.outer.memberRefs.GetFunctionDelegateCtorRef(sourceFn)
            : (EntityHandle)this.outer.memberRefs.GetDelegateCtorReference(targetDelegateType));

        this.EmitNullGuardedDelegateToDelegateAdaptation(source, invokeRef, ctorRef);
    }

    /// <summary>
    /// Issue #2083: returns true when <paramref name="source"/> is a read of
    /// a field-like event's compiler-synthesized backing field — the only
    /// case, so far, where the emitter *knows* a statically non-nullable
    /// delegate-typed source can genuinely be <c>null</c> at runtime (an
    /// unsubscribed event's backing field is null even though the event's
    /// declared type isn't nullable). Every other non-nullable source
    /// (a plain local, parameter, or ordinary field) is expected to hold a
    /// real delegate; if it doesn't, that is a null-safety bug the emitted
    /// code should surface loudly rather than mask. Reached either through a
    /// direct field access (<c>this.MyEvent</c>) or the implicit bare-name
    /// field variable synthesized for in-class event reads (issue #1213);
    /// both route through the same underlying <see cref="FieldSymbol"/>, and
    /// smart-cast narrowing (<see cref="BoundFieldAccessExpression.NarrowedType"/>)
    /// does not change which field is read.
    /// </summary>
    private static bool IsKnownLegitimateNullDelegateSource(BoundExpression source)
    {
        return source switch
        {
            BoundFieldAccessExpression fieldAccess => fieldAccess.Field?.IsEventBackingField == true,
            BoundVariableExpression { Variable: ImplicitFieldVariableSymbol implicitField } => implicitField.Field?.IsEventBackingField == true,
            _ => false,
        };
    }

    /// <summary>
    /// Issue #2066 / #2083: emits the shared <c>dup / ldvirtftn / newobj</c>
    /// delegate-to-delegate adaptation sequence.
    ///
    /// When <see cref="IsKnownLegitimateNullDelegateSource"/> recognizes
    /// <paramref name="source"/> as a case the emitter knows can legitimately
    /// be <c>null</c> despite its non-nullable static type (currently: a
    /// field-like event's backing field, e.g. an unsubscribed field-like
    /// event snapshotted into a delegate-typed local), the sequence is
    /// guarded so a <c>null</c> source flows through as <c>null</c> instead
    /// of unconditionally rebuilding a delegate — without the guard,
    /// `ldvirtftn` resolves the (non-null) Invoke method pointer even over a
    /// `null` instance reference, and the subsequent `newobj` then throws
    /// <see cref="ArgumentException"/> at runtime ("Delegate to an instance
    /// method cannot have null 'this'") because the CLR delegate ctor
    /// requires a non-null target for an instance-method pointer.
    ///
    /// For every other source, that same throw is the *desired* pre-#2079
    /// fail-fast behavior: a plain non-nullable local/parameter/field that is
    /// unexpectedly null at runtime indicates a null-safety bug (e.g. a
    /// nullability escape via interop), and silently producing a null
    /// delegate instead of throwing would mask it. So the guard is only
    /// emitted for the known-legitimate-null sources; every other case emits
    /// the plain (unguarded, branch-free) sequence, matching prior behavior
    /// and avoiding the extra branch/label on the common non-nullable path.
    ///
    /// The null path (guarded case only) must not leave the un-adapted
    /// source value (statically typed as the *source* delegate type, e.g.
    /// <c>Func&lt;string&gt;</c>) on the stack: when the target is a
    /// covariant-adapted delegate type (e.g. <c>Func&lt;object&gt;</c>),
    /// merging that source-typed value with the non-null path's newly-
    /// constructed *target*-typed value at the shared label widens the
    /// verifier-computed stack type down to their common ancestor
    /// (<see cref="MulticastDelegate"/>), which then fails to verify against
    /// the target's expected type. Instead, the null path pops the leftover
    /// copy and pushes an explicit <c>ldnull</c>, whose null-reference type
    /// merges cleanly with any reference type, including the adapted target
    /// delegate type.
    /// </summary>
    private void EmitNullGuardedDelegateToDelegateAdaptation(BoundExpression source, EntityHandle invokeRef, EntityHandle ctorRef)
    {
        this.EmitExpression(source);

        if (!IsKnownLegitimateNullDelegateSource(source))
        {
            // Plain fail-fast sequence: no null check. If the source is
            // unexpectedly null at runtime, `newobj` throws
            // ArgumentException here rather than silently producing null.
            this.il.OpCode(ILOpCode.Dup);
            this.il.OpCode(ILOpCode.Ldvirtftn);
            this.il.Token(invokeRef);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorRef);
            return;
        }

        this.il.OpCode(ILOpCode.Dup);
        var notNullLabel = this.il.DefineLabel();
        var doneLabel = this.il.DefineLabel();
        this.il.Branch(ILOpCode.Brtrue, notNullLabel);

        // Null path: discard the leftover source-typed null and push an
        // explicit `ldnull` so its stack type merges with the target
        // delegate type produced by the non-null path below.
        this.il.OpCode(ILOpCode.Pop);
        this.il.OpCode(ILOpCode.Ldnull);
        this.il.Branch(ILOpCode.Br, doneLabel);

        this.il.MarkLabel(notNullLabel);
        this.il.OpCode(ILOpCode.Dup);
        this.il.OpCode(ILOpCode.Ldvirtftn);
        this.il.Token(invokeRef);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(ctorRef);
        this.il.MarkLabel(doneLabel);
    }

    /// <summary>
    /// ADR-0059 / issue #255: emits a GSharp function value → user-declared
    /// named delegate type conversion. The delegate has no CLR Type during
    /// emit; we reference its emitted <c>.ctor</c> MethodDef directly
    /// instead of looking up a <see cref="ConstructorInfo"/> on a runtime
    /// <see cref="Type"/>.
    /// </summary>
    private void EmitFunctionToNamedDelegateConversion(BoundExpression source, FunctionTypeSymbol sourceFn, DelegateTypeSymbol targetDelegate)
    {
        // Issue #1503: a generic named delegate (constructed or open) resolves
        // its `.ctor` through a MemberRef parented at the delegate TypeSpec; a
        // non-generic delegate uses the bare `.ctor` MethodDef handle.
        var ctorHandle = this.outer.userTokens.ResolveDelegateCtorToken(targetDelegate);

        if (source is BoundFunctionLiteralExpression literal)
        {
            this.EmitFunctionLiteralToNamedDelegate(literal, ctorHandle);
            return;
        }

        if (source is BoundMethodGroupExpression methodGroup)
        {
            this.EmitMethodGroupToNamedDelegate(methodGroup, ctorHandle);
            return;
        }

        // Delegate-to-delegate adaptation (CLR delegate value → named
        // delegate): wrap the source delegate's Invoke in a new named
        // delegate instance using `dup; ldvirtftn; newobj`. Issue #2066:
        // null-guarded via EmitNullGuardedDelegateToDelegateAdaptation so an
        // unsubscribed (null) source flows through as null.
        if (sourceFn?.ClrType != null && ClrTypeUtilities.IsDelegateType(sourceFn.ClrType))
        {
            var sourceDelegateType = this.outer.signatures.ResolveDelegateClrType(sourceFn);
            var sourceInvoke = sourceDelegateType.GetMethod("Invoke")
                ?? throw new InvalidOperationException(
                    $"Delegate type '{sourceDelegateType.FullName}' has no Invoke method.");

            this.EmitNullGuardedDelegateToDelegateAdaptation(source, this.outer.memberRefs.GetMethodReference(sourceInvoke), ctorHandle);
            return;
        }

        throw new NotSupportedException(
            $"Cannot convert function value of type '{sourceFn?.Name}' to named delegate '{targetDelegate.Name}'.");
    }

    /// <summary>
    /// ADR-0059 / issue #255: emits a <see cref="BoundFunctionLiteralExpression"/>
    /// bound to a user-declared named delegate type whose <c>.ctor</c>
    /// MethodDef handle is supplied directly. Mirrors
    /// <see cref="EmitFunctionLiteral(BoundFunctionLiteralExpression, Type)"/>
    /// but uses a metadata handle instead of a runtime <see cref="Type"/>.
    /// Issue #2338 follow-up (deferred from the primary-ctor field-token fix):
    /// when the display class was reified generic over its enclosing type
    /// parameters (issue #1477 — e.g. a lambda captures a `T`-typed value
    /// inside a generic containing type/method), the capture-site
    /// <c>newobj</c>/<c>stfld</c>/<c>ldftn</c> tokens must be MemberRefs
    /// parented at the CONSTRUCTED closure TypeSpec, exactly like the
    /// no-named-delegate sibling above already does — a bare
    /// MethodDef/FieldDef of a member on a generic type is an illegal
    /// capture-store/delegate-function token (TypeLoadException + ilverify
    /// StackUnexpected/DelegateCtor). This overload previously always used
    /// the bare (open) handles unconditionally, so a generic-reified closure
    /// bound to a named (rather than `Func`/`Action`) delegate type crashed
    /// the same way primary-ctor field stores did before the #2338 fix.
    /// </summary>
    private void EmitFunctionLiteralToNamedDelegate(BoundFunctionLiteralExpression literal, EntityHandle delegateCtorHandle)
    {
        if (this.outer.closures.ClosureInfos.TryGetValue(literal, out var closure))
        {
            if (!this.outer.cache.ClassCtorHandles.TryGetValue(closure.ClassSym, out var closureCtor))
            {
                throw new InvalidOperationException(
                    $"Closure class '{closure.ClassSym.Name}' has no emitted constructor.");
            }

            if (!this.outer.cache.MethodHandles.TryGetValue(closure.InvokeMethod, out var closureInvoke))
            {
                throw new InvalidOperationException(
                    $"Closure invoke method '{closure.InvokeMethod.Name}' has no emitted MethodDef.");
            }

            var constructedClosure = closure.ConstructedClassSym;
            var closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure);

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(closureIsGeneric
                ? this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
                : closureCtor);

            foreach (var captured in literal.CapturedVariables)
            {
                if (!closure.CaptureFields.TryGetValue(captured, out var field))
                {
                    throw new InvalidOperationException(
                        $"Closure for '{literal.Function.Name}' has no field for captured '{captured.Name}'.");
                }

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
                        $"Closure field '{field.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Dup);
                this.EmitCapturedVariableLoad(captured);
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldToken);
            }

            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(closureIsGeneric
                ? this.outer.userTokens.ResolveClosureInvokeFtnToken(constructedClosure, closure.ClassSym, closure.InvokeMethod)
                : closureInvoke);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(delegateCtorHandle);
            return;
        }

        if (literal.CapturedVariables.Length > 0)
        {
            throw new NotSupportedException(
                $"Function literal '{literal.Function.Name}' captures outer variables; closure emit fell through synthesis.");
        }

        if (!this.outer.cache.FunctionHandles.TryGetValue(literal.Function, out _))
        {
            throw new InvalidOperationException(
                $"Function literal '{literal.Function.Name}' has no emitted MethodDef.");
        }

        this.il.OpCode(ILOpCode.Ldnull);
        this.il.OpCode(ILOpCode.Ldftn);
        this.il.Token(this.outer.userTokens.ResolveLambdaFunctionFtnToken(literal.Function));
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(delegateCtorHandle);
    }

    /// <summary>
    /// ADR-0059 / issue #255: emits a static method group bound to a
    /// user-declared named delegate type using its emitted <c>.ctor</c>
    /// MethodDef handle. Mirrors
    /// <see cref="EmitMethodGroup(BoundMethodGroupExpression, Type)"/>.
    /// Issue #503 follow-up: instance method groups load the receiver
    /// first so the resulting delegate's <c>Target</c> binds to the
    /// captured instance.
    /// </summary>
    private void EmitMethodGroupToNamedDelegate(BoundMethodGroupExpression methodGroup, EntityHandle delegateCtorHandle)
    {
        this.EmitMethodGroupTarget(methodGroup);
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(delegateCtorHandle);
    }

    /// <summary>
    /// Emits the shared prologue of a user method-group-to-delegate
    /// conversion: it resolves the function pointer token and leaves the
    /// delegate-constructor operands on the stack — <c>ldnull; ldftn ftn</c>
    /// for a static group, or <c>&lt;receiver&gt;; [box]; dup; ldvirtftn ftn</c>
    /// / <c>&lt;receiver&gt;; [box]; ldftn ftn</c> for an instance group — ready
    /// for the caller's <c>newobj &lt;Delegate&gt;::.ctor(object, IntPtr)</c>.
    /// Both the named-delegate path (<see cref="EmitMethodGroupToNamedDelegate"/>)
    /// and the synthesized/CLR-delegate path
    /// (<see cref="EmitMethodGroup(BoundMethodGroupExpression, Type)"/>) share
    /// this single implementation so the #1397 interface-receiver ldvirtftn and
    /// #1467 generic-receiver token handling live in exactly one place.
    /// </summary>
    private void EmitMethodGroupTarget(BoundMethodGroupExpression methodGroup)
    {
        if (!this.outer.cache.FunctionHandles.TryGetValue(methodGroup.Function, out var staticHandle)
            && !this.outer.cache.MethodHandles.TryGetValue(methodGroup.Function, out staticHandle))
        {
            throw new InvalidOperationException(
                $"Method group '{methodGroup.Function.Name}' has no emitted MethodDef.");
        }

        // Issue #1467: when the method group targets an instance method of a
        // user-declared GENERIC type, the `ldftn`/`ldvirtftn` target must be a
        // MemberRef parented at the constructed receiver TypeSpec — a bare
        // MethodDef of a method on a generic type is not a valid delegate-ctor
        // function token (ilverify `DelegateCtor`). Re-resolve through the
        // receiver's type.
        EntityHandle ftnToken = staticHandle;
        if (methodGroup.Receiver == null
            && methodGroup.StaticOwnerType != null
            && ReflectionMetadataEmitter.IsUserGenericTypeReference(methodGroup.StaticOwnerType))
        {
            ftnToken = this.outer.userTokens.ResolveUserStaticMethodToken(methodGroup.StaticOwnerType, methodGroup.Function);
        }

        if (methodGroup.Receiver?.Type is StructSymbol receiverStruct
            && ReflectionMetadataEmitter.IsUserGenericTypeReference(receiverStruct)
            && this.outer.cache.MethodHandles.ContainsKey(methodGroup.Function))
        {
            ftnToken = this.outer.userTokens.ResolveUserInstanceMethodToken(receiverStruct, methodGroup.Function);
        }

        if (methodGroup.Function.IsGeneric)
        {
            if (methodGroup.MethodTypeArguments.Length != methodGroup.Function.TypeParameters.Length)
            {
                throw new InvalidOperationException(
                    $"Generic method group '{methodGroup.Function.Name}' has no inferred type arguments.");
            }

            ftnToken = this.outer.userTokens.BuildMethodSpecForGenericMethodGroup(ftnToken, methodGroup);
        }

        if (methodGroup.Receiver == null)
        {
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(ftnToken);
        }
        else
        {
            this.EmitExpression(methodGroup.Receiver);

            // Box value-type receivers so the resulting delegate's Target
            // slot (typed `object`) holds a reference.
            if (ReflectionMetadataEmitter.IsValueTypeSymbol(methodGroup.Receiver.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(methodGroup.Receiver.Type));
            }

            // For an `open` (virtual) / `override` instance method — and,
            // per issue #1397, an interface-typed receiver — dispatch via
            // `ldvirtftn` so the delegate invokes the concrete implementation.
            // Non-virtual / sealed methods use `ldftn` directly.
            if (methodGroup.Function.IsOpen || methodGroup.Function.IsOverride
                || methodGroup.Receiver.Type is InterfaceSymbol)
            {
                this.il.OpCode(ILOpCode.Dup);
                this.il.OpCode(ILOpCode.Ldvirtftn);
                this.il.Token(ftnToken);
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(ftnToken);
            }
        }
    }

    private void EmitClrEventSubscription(BoundClrEventSubscriptionExpression subscription)
    {
        // Stream B′ emit parity: `+=` / `-=` calls the event's add_X /
        // remove_X accessor. Both accessors are void-returning.
        var isStatic = subscription.Receiver == null;
        var receiverIsValueType = !isStatic && ReflectionMetadataEmitter.IsValueTypeSymbol(subscription.Receiver.Type);

        if (subscription.IsConstrainedTypeParameterAccess)
        {
            this.EmitConstrainedTypeParameterReceiver(subscription.Receiver);
        }
        else if (!isStatic)
        {
            this.EmitInstanceReceiver(subscription.Receiver);
        }

        // Function-literal handlers default to Action/Func; redirect them
        // to the event's actual delegate type so the AddEventHandler call
        // is type-correct.
        if (subscription.Handler is BoundFunctionLiteralExpression literalHandler
            && subscription.Event.EventHandlerType != null)
        {
            var mappedDelegateType = this.outer.signatures.MapToReferenceClrType(subscription.Event.EventHandlerType);
            this.EmitFunctionLiteral(literalHandler, mappedDelegateType);
        }
        else
        {
            this.EmitExpression(subscription.Handler);
        }

        var accessor = subscription.IsAdd
            ? subscription.Event.GetAddMethod(nonPublic: false)
            : subscription.Event.GetRemoveMethod(nonPublic: false);
        if (accessor == null)
        {
            throw new InvalidOperationException(
                $"Event '{subscription.Event.DeclaringType?.FullName}.{subscription.Event.Name}' has no public {(subscription.IsAdd ? "add" : "remove")} accessor.");
        }

        if (subscription.IsConstrainedTypeParameterAccess)
        {
            this.il.OpCode(ILOpCode.Constrained);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(subscription.ConstrainedReceiverTypeParameter));
            this.il.OpCode(ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(
                accessor,
                subscription.ConstrainedInterfaceType));
        }
        else
        {
            this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
            this.il.Token(this.outer.memberRefs.GetMethodEntityHandle(
                accessor,
                subscription.EventContainingType));
        }
    }

    private void EmitUserEventSubscription(BoundEventSubscriptionExpression node)
    {
        // ADR-0052: user-defined event subscription — call add_X or remove_X accessor.
        if (node.Receiver != null)
        {
            if (node.Receiver.Type is TypeParameterSymbol typeParameterReceiver)
            {
                // Issue #2519: mirror constrained field/property access. Boxing
                // a reference-shaped T is a runtime no-op and provides the
                // verifier with the class-constraint receiver shape expected by
                // the event accessor.
                this.EmitExpression(node.Receiver);
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(typeParameterReceiver));
            }
            else
            {
                this.EmitInstanceReceiver(node.Receiver);
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
        if (node.Handler is BoundFunctionLiteralExpression literalHandler
            && node.EventType?.ClrType != null)
        {
            var mappedDelegateType = this.outer.signatures.MapToReferenceClrType(node.EventType.ClrType);
            this.EmitFunctionLiteral(literalHandler, mappedDelegateType);
        }
        else
        {
            this.EmitExpression(node.Handler);
        }

        if (this.outer.cache.EventAccessorHandles.TryGetValue(node.Event, out var accessorHandles))
        {
            var accessorMethodSymbol = node.IsAdd ? node.Event.AddMethodSymbol : node.Event.RemoveMethodSymbol;
            var accessorHandle = node.IsAdd ? accessorHandles.Add : accessorHandles.Remove;

            if (node.Receiver == null
                && node.StructType is StructSymbol staticOwner
                && ReflectionMetadataEmitter.IsUserGenericTypeReference(staticOwner)
                && accessorMethodSymbol != null)
            {
                var accessorToken = this.outer.userTokens.ResolveUserStaticMethodToken(staticOwner, accessorMethodSymbol, accessorHandle);
                this.il.OpCode(ILOpCode.Call);
                this.il.Token(accessorToken);
                return;
            }

            // ADR-0149 follow-up (issue #2370): a generic-interface-typed
            // receiver (`b: IWatchable[int32]; b.Changed += h`) must reach
            // the add/remove accessor through a MemberRef parented at the
            // constructed TypeSpec, exactly like EmitUserInstanceCall's
            // generic-interface call path — the bare MethodDef planned
            // above is only valid for the OPEN interface definition.
            if (node.StructType is InterfaceSymbol ifaceOwner
                && ReflectionMetadataEmitter.IsUserGenericInterfaceReference(ifaceOwner)
                && accessorMethodSymbol != null)
            {
                var accessorToken = this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(ifaceOwner, accessorMethodSymbol);
                this.il.OpCode(ILOpCode.Callvirt);
                this.il.Token(accessorToken);
                return;
            }

            bool isStatic = node.Receiver == null;
            bool isVirtual = !isStatic && (node.StructType is InterfaceSymbol || node.Event.IsVirtual || node.Event.IsOverride);
            this.il.OpCode(isVirtual ? ILOpCode.Callvirt : ILOpCode.Call);
            this.il.Token(accessorHandle);
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
    private void EmitFunctionLiteral(BoundFunctionLiteralExpression literal)
    {
        // For async lambdas, resolve the delegate type with the Task-wrapped return.
        Type asyncDelegateOverride = null;
        if (literal.Function.IsAsync)
        {
            // For no-capture lambdas, the plan's kickoff is literal.Function.
            // For capture-bearing lambdas, the plan's kickoff is closure.InvokeMethod.
            FunctionSymbol planKey = literal.Function;
            if (this.outer.closures.ClosureInfos.TryGetValue(literal, out var closureForAsync))
            {
                planKey = closureForAsync.InvokeMethod;
            }

            if (planKey.StateMachineType != null)
            {
                // Issue #1502: when the Task-wrapped delegate shape carries a
                // source-defined user type or a type-parameter result/parameter
                // (`Func<...,Task<TOutput>>`), route through the symbolic
                // TypeSpec ctor ref instead of the type-erased reflection type.
                var asyncSymbolicCtor = this.outer.memberRefs.TryGetSymbolicAsyncDelegateCtorRef(literal.FunctionType, planKey);
                if (asyncSymbolicCtor.HasValue)
                {
                    this.EmitFunctionLiteral(literal, overrideDelegateType: null, symbolicDelegateCtorRef: asyncSymbolicCtor.Value);
                    return;
                }

                asyncDelegateOverride = this.outer.signatures.ResolveAsyncDelegateClrType(literal.FunctionType, planKey);
            }
        }

        EmitFunctionLiteral(literal, overrideDelegateType: asyncDelegateOverride);
    }

    private void EmitFunctionLiteral(BoundFunctionLiteralExpression literal, Type overrideDelegateType)
    {
        this.EmitFunctionLiteral(literal, overrideDelegateType, symbolicDelegateCtorRef: null);
    }

    private void EmitFunctionLiteral(BoundFunctionLiteralExpression literal, Type overrideDelegateType, EntityHandle? symbolicDelegateCtorRef)
    {
        if (this.outer.closures.ClosureInfos.TryGetValue(literal, out var closure))
        {
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
            if (!this.outer.cache.ClassCtorHandles.TryGetValue(closure.ClassSym, out var ctorHandle))
            {
                throw new InvalidOperationException(
                    $"Closure class '{closure.ClassSym.Name}' has no emitted constructor.");
            }

            if (!this.outer.cache.MethodHandles.TryGetValue(closure.InvokeMethod, out var invokeHandle))
            {
                throw new InvalidOperationException(
                    $"Closure invoke method '{closure.InvokeMethod.Name}' has no emitted MethodDef.");
            }

            // Issue #1477: when the display class was reified generic over its
            // enclosing type parameters, the capture-site newobj / stfld / ldftn
            // tokens must be MemberRefs parented at the CONSTRUCTED closure
            // TypeSpec (`Closure`1<…enclosing args…>`) — a bare MethodDef/FieldDef
            // of a member on a generic type is an illegal capture-store/delegate
            // function token (TypeLoadException + ilverify StackUnexpected/
            // DelegateCtor). Reuse the existing user-generic token machinery.
            var constructedClosure = closure.ConstructedClassSym;
            var closureIsGeneric = ReflectionMetadataEmitter.IsUserGenericTypeReference(constructedClosure);

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(closureIsGeneric
                ? this.outer.userTokens.ResolveUserCtorTokenForDefault(constructedClosure)
                : ctorHandle);

            foreach (var captured in literal.CapturedVariables)
            {
                if (!closure.CaptureFields.TryGetValue(captured, out var field))
                {
                    throw new InvalidOperationException(
                        $"Closure for '{literal.Function.Name}' has no field for captured '{captured.Name}'.");
                }

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
                        $"Closure field '{field.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Dup);
                this.EmitCapturedVariableLoad(captured);
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldToken);
            }

            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(closureIsGeneric
                ? this.outer.userTokens.ResolveClosureInvokeFtnToken(constructedClosure, closure.ClassSym, closure.InvokeMethod)
                : invokeHandle);
            this.il.OpCode(ILOpCode.Newobj);

            // ADR-0087 §3 R6: when the literal's effective delegate
            // shape carries type-parameter slots (e.g. `func(T) U`), no
            // host CLR type exists for `ResolveDelegateClrType` to
            // reflect over. Use a MemberRef parented at the reified
            // `Func<...>` / `Action<...>` TypeSpec instead — the .ctor
            // signature is the canonical `(object, IntPtr)`.
            if (symbolicDelegateCtorRef.HasValue)
            {
                this.il.Token(symbolicDelegateCtorRef.Value);
            }
            else if (overrideDelegateType == null && (literal.FunctionType.ClrType == null || this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(literal.FunctionType)))
            {
                this.il.Token(this.outer.memberRefs.GetFunctionDelegateCtorRef(literal.FunctionType));
            }
            else
            {
                var delegateTypeC = overrideDelegateType ?? this.outer.signatures.ResolveDelegateClrType(literal.FunctionType);
                this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateTypeC));
            }

            return;
        }

        if (literal.CapturedVariables.Length > 0)
        {
            throw new NotSupportedException(
                $"Function literal '{literal.Function.Name}' captures outer variables; closure emit fell through synthesis.");
        }

        if (!this.outer.cache.FunctionHandles.TryGetValue(literal.Function, out _))
        {
            throw new InvalidOperationException(
                $"Function literal '{literal.Function.Name}' has no emitted MethodDef.");
        }

        this.il.OpCode(ILOpCode.Ldnull);
        this.il.OpCode(ILOpCode.Ldftn);
        this.il.Token(this.outer.userTokens.ResolveLambdaFunctionFtnToken(literal.Function));
        this.il.OpCode(ILOpCode.Newobj);

        // ADR-0087 §3 R6: see capture-bearing branch above — reified
        // ctor MemberRef when the function shape is type-parameter-bearing.
        if (symbolicDelegateCtorRef.HasValue)
        {
            this.il.Token(symbolicDelegateCtorRef.Value);
        }
        else if (overrideDelegateType == null && (literal.FunctionType.ClrType == null || this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(literal.FunctionType)))
        {
            this.il.Token(this.outer.memberRefs.GetFunctionDelegateCtorRef(literal.FunctionType));
        }
        else
        {
            var delegateType = overrideDelegateType ?? this.outer.signatures.ResolveDelegateClrType(literal.FunctionType);
            this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateType));
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
    private void EmitMethodGroup(BoundMethodGroupExpression methodGroup, Type overrideDelegateType)
    {
        Type delegateType = null;
        if (overrideDelegateType != null
            || (methodGroup.FunctionType.ClrType != null
                && !this.outer.userTokens.FunctionTypeNeedsSymbolicDelegate(methodGroup.FunctionType)))
        {
            delegateType = overrideDelegateType ?? this.outer.signatures.ResolveDelegateClrType(methodGroup.FunctionType);
        }

        if (methodGroup.Function.IsExtension && methodGroup.Receiver != null)
        {
            if (!this.outer.cache.FunctionHandles.TryGetValue(methodGroup.Function, out var methodHandle)
                && !this.outer.cache.MethodHandles.TryGetValue(methodGroup.Function, out methodHandle))
            {
                throw new InvalidOperationException(
                    $"Extension method group '{methodGroup.Function.Name}' has no emitted MethodDef.");
            }

            EntityHandle delegateTypeHandle = delegateType == null
                ? this.outer.memberRefs.GetFunctionDelegateTypeSpec(methodGroup.FunctionType)
                : this.outer.memberRefs.GetTypeHandleForMember(delegateType);
            this.EmitClosedStaticMethodGroup(methodGroup.Receiver, methodHandle, delegateTypeHandle);
            return;
        }

        // Shared prologue: resolves the (interface/generic-aware) function
        // pointer token and leaves the delegate-ctor operands on the stack.
        this.EmitMethodGroupTarget(methodGroup);

        this.il.OpCode(ILOpCode.Newobj);

        // ADR-0087 §3 R6: reified MemberRef when the method-group's
        // delegate shape carries type-parameter slots.
        if (delegateType == null)
        {
            this.il.Token(this.outer.memberRefs.GetFunctionDelegateCtorRef(methodGroup.FunctionType));
        }
        else
        {
            this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateType));
        }
    }

    // Issue #337: emit a resolved CLR member method group as a delegate over
    // the selected overload. Static groups load a null target and the method
    // address (`ldnull; ldftn`); instance groups evaluate the receiver and
    // load its (virtual) address (`<recv>; [dup; ldvirtftn] / ldftn`),
    // capturing the receiver as the delegate target. The constructed
    // delegate is the resolved target type (`Func[...]`/`Action[...]` or a
    // named delegate), resolved onto the emitter's reference context.
    private void EmitClrMethodGroup(BoundClrMethodGroupExpression methodGroup)
    {
        var method = methodGroup.ResolvedMethod
            ?? throw new InvalidOperationException(
                $"CLR method group '{methodGroup.MethodName}' reached emit without overload resolution.");

        var hostDelegate = methodGroup.DelegateType?.ClrType
            ?? throw new InvalidOperationException(
                $"CLR method group '{methodGroup.MethodName}' has no resolved target delegate type.");

        var delegateType = this.outer.signatures.ResolveTargetDelegateClrType(hostDelegate);
        var methodRef = this.outer.memberRefs.GetMethodReference(method);

        if (method.IsStatic && methodGroup.Receiver != null)
        {
            this.EmitClosedStaticMethodGroup(
                methodGroup.Receiver,
                methodRef,
                this.outer.memberRefs.GetTypeHandleForMember(delegateType),
                method);
            return;
        }

        if (method.IsStatic)
        {
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(methodRef);
        }
        else
        {
            this.EmitExpression(methodGroup.Receiver);

            // Issue #420 (P3-1): the delegate ctor signature is
            // `(object target, IntPtr ptr)` and `ldvirtftn` requires an
            // object reference on the stack. The binder currently rejects
            // method-group conversions whose receiver is a value type, but
            // if that gate ever loosens (or a future codepath constructs
            // a `BoundClrMethodGroupExpression` with a struct receiver),
            // emitting the raw value would produce unverifiable IL that
            // silently corrupts the stack. Defensively box value-type
            // receivers so the emitted sequence stays verifiable.
            if (ReflectionMetadataEmitter.IsValueTypeSymbol(methodGroup.Receiver.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.memberRefs.GetElementTypeToken(methodGroup.Receiver.Type));
            }

            if (method.IsVirtual && !method.IsFinal)
            {
                this.il.OpCode(ILOpCode.Dup);
                this.il.OpCode(ILOpCode.Ldvirtftn);
                this.il.Token(methodRef);
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(methodRef);
            }
        }

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.memberRefs.GetDelegateCtorReference(delegateType));
    }

    private void EmitClosedStaticMethodGroup(
        BoundExpression receiver,
        EntityHandle methodHandle,
        EntityHandle delegateTypeHandle,
        MethodInfo importedMethod = null)
    {
        this.il.OpCode(ILOpCode.Ldtoken);
        this.il.Token(delegateTypeHandle);
        this.il.Call(this.outer.wellKnown.GetTypeFromHandleReference());

        this.EmitExpression(receiver);
        if (ReflectionMetadataEmitter.IsValueTypeSymbol(receiver.Type))
        {
            this.il.OpCode(ILOpCode.Box);
            this.il.Token(this.outer.memberRefs.GetElementTypeToken(receiver.Type));
        }

        if (importedMethod != null)
        {
            this.EmitMethodInfoLiteral(importedMethod);
        }
        else
        {
            this.il.OpCode(ILOpCode.Ldtoken);
            this.il.Token(methodHandle);
            this.il.Call(this.outer.wellKnown.GetMethodFromHandleReference());
            this.il.OpCode(ILOpCode.Castclass);
            this.il.Token(this.outer.memberRefs.GetTypeReference(typeof(MethodInfo)));
        }

        this.il.Call(this.outer.wellKnown.GetClosedStaticDelegateCreateReference());
        this.il.OpCode(ILOpCode.Castclass);
        this.il.Token(delegateTypeHandle);
    }

    // Phase 4 emit parity: load a captured variable. In a MoveNext body,
    // the variable may be hoisted to a state-machine field; emit the field
    // load instead of a local/parameter load in that case.
    private void EmitCapturedVariableLoad(VariableSymbol captured)
    {
        if (this.asyncFieldMap != null && this.asyncFieldMap.TryGetHoistedField(captured, out var hoistedField))
        {
            // Load from the state machine: ldarg.0; ldfld <smStruct>::<hoistedField>
            if (!this.outer.cache.StructFieldDefs.TryGetValue(hoistedField, out var hoistedHandle))
            {
                throw new InvalidOperationException(
                    $"Hoisted field '{hoistedField.Name}' has no emitted FieldDef.");
            }

            this.il.OpCode(ILOpCode.Ldarg_0);
            this.il.OpCode(ILOpCode.Ldfld);
            this.il.Token(hoistedHandle);
            return;
        }

        this.EmitExpression(new BoundVariableExpression(null, captured));
    }
}
