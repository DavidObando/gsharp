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
    private void EmitFunctionToDelegateConversion(BoundExpression source, FunctionTypeSymbol sourceFn, Type targetDelegateHostType)
    {
        // Issue #323: when the target is the abstract System.Delegate /
        // System.MulticastDelegate base type, there is no concrete delegate
        // to instantiate. Materialize the function value as its natural
        // delegate type (Func/Action) instead; the resulting reference is
        // already a System.Delegate, so the widening is a no-op upcast.
        var targetDelegateType = IsSystemDelegateHostType(targetDelegateHostType)
            ? this.outer.ResolveDelegateClrType(sourceFn)
            : this.outer.ResolveTargetDelegateClrType(targetDelegateHostType);

        if (source is BoundFunctionLiteralExpression literal)
        {
            this.EmitFunctionLiteral(literal, overrideDelegateType: targetDelegateType);
            return;
        }

        // Issue #324: a method group materializes the same `ldnull / ldftn /
        // newobj <Delegate>` sequence as a no-capture lambda, but over the
        // existing named function's MethodDef and bound to the requested
        // target delegate type.
        if (source is BoundMethodGroupExpression methodGroup)
        {
            this.EmitMethodGroup(methodGroup, overrideDelegateType: targetDelegateType);
            return;
        }

        // Delegate-to-delegate adaptation: wrap the existing delegate's
        // Invoke method in a new delegate of the target type.
        var sourceDelegateType = this.outer.ResolveDelegateClrType(sourceFn);
        var sourceInvoke = sourceDelegateType.GetMethod("Invoke")
            ?? throw new InvalidOperationException(
                $"Delegate type '{sourceDelegateType.FullName}' has no Invoke method.");
        var targetCtor = targetDelegateType.GetConstructors()[0];

        this.EmitExpression(source);
        this.il.OpCode(ILOpCode.Dup);
        this.il.OpCode(ILOpCode.Ldvirtftn);
        this.il.Token(this.outer.GetMethodReference(sourceInvoke));
        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(this.outer.GetCtorReference(targetCtor));
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
        if (!this.outer.cache.DelegateCtorHandles.TryGetValue(targetDelegate, out var ctorHandle))
        {
            throw new InvalidOperationException(
                $"Named delegate '{targetDelegate.Name}' has no emitted .ctor MethodDef.");
        }

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
        // delegate instance using `dup; ldvirtftn; newobj`.
        if (sourceFn?.ClrType != null && ClrTypeUtilities.IsDelegateType(sourceFn.ClrType))
        {
            var sourceDelegateType = this.outer.ResolveDelegateClrType(sourceFn);
            var sourceInvoke = sourceDelegateType.GetMethod("Invoke")
                ?? throw new InvalidOperationException(
                    $"Delegate type '{sourceDelegateType.FullName}' has no Invoke method.");

            this.EmitExpression(source);
            this.il.OpCode(ILOpCode.Dup);
            this.il.OpCode(ILOpCode.Ldvirtftn);
            this.il.Token(this.outer.GetMethodReference(sourceInvoke));
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorHandle);
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
    /// </summary>
    private void EmitFunctionLiteralToNamedDelegate(BoundFunctionLiteralExpression literal, MethodDefinitionHandle delegateCtorHandle)
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

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(closureCtor);

            foreach (var captured in literal.CapturedVariables)
            {
                if (!closure.CaptureFields.TryGetValue(captured, out var field))
                {
                    throw new InvalidOperationException(
                        $"Closure for '{literal.Function.Name}' has no field for captured '{captured.Name}'.");
                }

                if (!this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Closure field '{field.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Dup);
                this.EmitCapturedVariableLoad(captured);
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);
            }

            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(closureInvoke);
            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(delegateCtorHandle);
            return;
        }

        if (literal.CapturedVariables.Length > 0)
        {
            throw new NotSupportedException(
                $"Function literal '{literal.Function.Name}' captures outer variables; closure emit fell through synthesis.");
        }

        if (!this.outer.cache.FunctionHandles.TryGetValue(literal.Function, out var methodHandle))
        {
            throw new InvalidOperationException(
                $"Function literal '{literal.Function.Name}' has no emitted MethodDef.");
        }

        this.il.OpCode(ILOpCode.Ldnull);
        this.il.OpCode(ILOpCode.Ldftn);
        this.il.Token(methodHandle);
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
    private void EmitMethodGroupToNamedDelegate(BoundMethodGroupExpression methodGroup, MethodDefinitionHandle delegateCtorHandle)
    {
        if (!this.outer.cache.FunctionHandles.TryGetValue(methodGroup.Function, out var staticHandle)
            && !this.outer.cache.MethodHandles.TryGetValue(methodGroup.Function, out staticHandle))
        {
            throw new InvalidOperationException(
                $"Method group '{methodGroup.Function.Name}' has no emitted MethodDef.");
        }

        if (methodGroup.Receiver == null)
        {
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(staticHandle);
        }
        else
        {
            this.EmitExpression(methodGroup.Receiver);

            if (ReflectionMetadataEmitter.IsValueTypeSymbol(methodGroup.Receiver.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(methodGroup.Receiver.Type));
            }

            if (methodGroup.Function.IsOpen || methodGroup.Function.IsOverride)
            {
                this.il.OpCode(ILOpCode.Dup);
                this.il.OpCode(ILOpCode.Ldvirtftn);
                this.il.Token(staticHandle);
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(staticHandle);
            }
        }

        this.il.OpCode(ILOpCode.Newobj);
        this.il.Token(delegateCtorHandle);
    }

    private void EmitClrEventSubscription(BoundClrEventSubscriptionExpression subscription)
    {
        // Stream B′ emit parity: `+=` / `-=` calls the event's add_X /
        // remove_X accessor. Both accessors are void-returning.
        var isStatic = subscription.Receiver == null;
        var receiverIsValueType = !isStatic && ReflectionMetadataEmitter.IsValueTypeSymbol(subscription.Receiver.Type);

        if (!isStatic)
        {
            this.EmitInstanceReceiver(subscription.Receiver);
        }

        // Function-literal handlers default to Action/Func; redirect them
        // to the event's actual delegate type so the AddEventHandler call
        // is type-correct.
        if (subscription.Handler is BoundFunctionLiteralExpression literalHandler
            && subscription.Event.EventHandlerType != null)
        {
            var mappedDelegateType = this.outer.MapToReferenceClrType(subscription.Event.EventHandlerType);
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

        this.il.OpCode(isStatic || receiverIsValueType ? ILOpCode.Call : ILOpCode.Callvirt);
        this.il.Token(this.outer.GetMethodReference(accessor));
    }

    private void EmitUserEventSubscription(BoundEventSubscriptionExpression node)
    {
        // ADR-0052: user-defined event subscription — call add_X or remove_X accessor.
        if (node.Receiver != null)
        {
            this.EmitInstanceReceiver(node.Receiver);
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
            && node.Event.Type?.ClrType != null)
        {
            var mappedDelegateType = this.outer.MapToReferenceClrType(node.Event.Type.ClrType);
            this.EmitFunctionLiteral(literalHandler, mappedDelegateType);
        }
        else
        {
            this.EmitExpression(node.Handler);
        }

        if (this.outer.cache.EventAccessorHandles.TryGetValue(node.Event, out var accessorHandles))
        {
            var accessorHandle = node.IsAdd ? accessorHandles.Add : accessorHandles.Remove;
            bool isStatic = node.Receiver == null;
            bool isVirtual = !isStatic && (node.Event.IsVirtual || node.Event.IsOverride);
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
                asyncDelegateOverride = this.outer.ResolveAsyncDelegateClrType(literal.FunctionType, planKey);
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

            this.il.OpCode(ILOpCode.Newobj);
            this.il.Token(ctorHandle);

            foreach (var captured in literal.CapturedVariables)
            {
                if (!closure.CaptureFields.TryGetValue(captured, out var field))
                {
                    throw new InvalidOperationException(
                        $"Closure for '{literal.Function.Name}' has no field for captured '{captured.Name}'.");
                }

                if (!this.outer.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle))
                {
                    throw new InvalidOperationException(
                        $"Closure field '{field.Name}' has no emitted FieldDef.");
                }

                this.il.OpCode(ILOpCode.Dup);
                this.EmitCapturedVariableLoad(captured);
                this.il.OpCode(ILOpCode.Stfld);
                this.il.Token(fieldHandle);
            }

            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(invokeHandle);
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
            else if (overrideDelegateType == null && literal.FunctionType.ClrType == null)
            {
                this.il.Token(this.outer.GetFunctionDelegateCtorRef(literal.FunctionType));
            }
            else
            {
                var delegateTypeC = overrideDelegateType ?? this.outer.ResolveDelegateClrType(literal.FunctionType);
                var delegateCtorC = delegateTypeC.GetConstructors()[0];
                this.il.Token(this.outer.GetCtorReference(delegateCtorC));
            }

            return;
        }

        if (literal.CapturedVariables.Length > 0)
        {
            throw new NotSupportedException(
                $"Function literal '{literal.Function.Name}' captures outer variables; closure emit fell through synthesis.");
        }

        if (!this.outer.cache.FunctionHandles.TryGetValue(literal.Function, out var methodHandle))
        {
            throw new InvalidOperationException(
                $"Function literal '{literal.Function.Name}' has no emitted MethodDef.");
        }

        this.il.OpCode(ILOpCode.Ldnull);
        this.il.OpCode(ILOpCode.Ldftn);
        this.il.Token(methodHandle);
        this.il.OpCode(ILOpCode.Newobj);

        // ADR-0087 §3 R6: see capture-bearing branch above — reified
        // ctor MemberRef when the function shape is type-parameter-bearing.
        if (symbolicDelegateCtorRef.HasValue)
        {
            this.il.Token(symbolicDelegateCtorRef.Value);
        }
        else if (overrideDelegateType == null && literal.FunctionType.ClrType == null)
        {
            this.il.Token(this.outer.GetFunctionDelegateCtorRef(literal.FunctionType));
        }
        else
        {
            var delegateType = overrideDelegateType ?? this.outer.ResolveDelegateClrType(literal.FunctionType);
            var delegateCtor = delegateType.GetConstructors()[0];
            this.il.Token(this.outer.GetCtorReference(delegateCtor));
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
        if (!this.outer.cache.FunctionHandles.TryGetValue(methodGroup.Function, out var methodHandle)
            && !this.outer.cache.MethodHandles.TryGetValue(methodGroup.Function, out methodHandle))
        {
            throw new InvalidOperationException(
                $"Method group '{methodGroup.Function.Name}' has no emitted MethodDef.");
        }

        Type delegateType = null;
        if (overrideDelegateType != null || methodGroup.FunctionType.ClrType != null)
        {
            delegateType = overrideDelegateType ?? this.outer.ResolveDelegateClrType(methodGroup.FunctionType);
        }

        if (methodGroup.Receiver == null)
        {
            this.il.OpCode(ILOpCode.Ldnull);
            this.il.OpCode(ILOpCode.Ldftn);
            this.il.Token(methodHandle);
        }
        else
        {
            this.EmitExpression(methodGroup.Receiver);

            // Box value-type receivers so the resulting delegate's Target
            // slot (typed `object`) holds a reference. Mirrors the
            // defensive box in EmitClrMethodGroup.
            if (ReflectionMetadataEmitter.IsValueTypeSymbol(methodGroup.Receiver.Type))
            {
                this.il.OpCode(ILOpCode.Box);
                this.il.Token(this.outer.GetElementTypeToken(methodGroup.Receiver.Type));
            }

            // For an `open` (virtual) instance method, honor virtual
            // dispatch via `ldvirtftn` so an override on a derived
            // receiver is invoked. Non-virtual / sealed methods use
            // `ldftn` directly.
            if (methodGroup.Function.IsOpen || methodGroup.Function.IsOverride)
            {
                this.il.OpCode(ILOpCode.Dup);
                this.il.OpCode(ILOpCode.Ldvirtftn);
                this.il.Token(methodHandle);
            }
            else
            {
                this.il.OpCode(ILOpCode.Ldftn);
                this.il.Token(methodHandle);
            }
        }

        this.il.OpCode(ILOpCode.Newobj);

        // ADR-0087 §3 R6: reified MemberRef when the method-group's
        // delegate shape carries type-parameter slots.
        if (delegateType == null)
        {
            this.il.Token(this.outer.GetFunctionDelegateCtorRef(methodGroup.FunctionType));
        }
        else
        {
            var delegateCtor = delegateType.GetConstructors()[0];
            this.il.Token(this.outer.GetCtorReference(delegateCtor));
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

        var delegateType = this.outer.ResolveTargetDelegateClrType(hostDelegate);
        var delegateCtor = delegateType.GetConstructors()[0];
        var methodRef = this.outer.GetMethodReference(method);

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
                this.il.Token(this.outer.GetElementTypeToken(methodGroup.Receiver.Type));
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
        this.il.Token(this.outer.GetCtorReference(delegateCtor));
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
