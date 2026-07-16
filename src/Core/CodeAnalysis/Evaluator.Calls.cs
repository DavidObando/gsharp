// <copyright file="Evaluator.Calls.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Emit = GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Issue #1361 partial of <see cref="Evaluator"/>: call evaluation — call dispatch and iterator machinery, user instance/base/constrained calls, conversions, imported CLR calls, ref-slot write-backs, is/as, and constructor chaining.
/// See <c>Evaluator.cs</c> for the root partial (fields, constructor,
/// execution-state accessors, frame management, and the nested state types).
/// </summary>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private object EvaluateCallExpression(BoundCallExpression node)
    {
        // ADR-0047 §6 / issue #176: a [Conditional("SYMBOL")] call whose
        // symbol is undefined is elided — neither the arguments nor the
        // target function body are evaluated.
        if (node.IsConditionalElided)
        {
            return null;
        }

        if (node.Function == BuiltinFunctions.Input)
        {
            return Console.ReadLine();
        }
        else if (node.Function == BuiltinFunctions.Print)
        {
            var message = (string)EvaluateExpression(node.Arguments[0]);
            Console.WriteLine(message);
            return null;
        }
        else if (node.Function == BuiltinFunctions.Rnd)
        {
            var max = (int)EvaluateExpression(node.Arguments[0]);
            return NextRandom(max);
        }
        else
        {
            var locals = new ConcurrentDictionary<VariableSymbol, object>();

            // ADR-0060 item #7: identify ref-kind parameters so we can
            // write the post-body value back into the caller's lvalue.
            List<(ParameterSymbol Parameter, BoundExpression Operand)> userRefSlots = null;

            for (int i = 0; i < node.Arguments.Length; i++)
            {
                var parameter = node.Function.Parameters[i];
                var arg = node.Arguments[i];

                if (parameter.RefKind != RefKind.None && arg is BoundAddressOfExpression addrOf)
                {
                    // Seed the parameter slot with the caller's current value
                    // (for `out` this is a placeholder the callee is expected
                    // to overwrite). Capture the operand for write-back unless
                    // the kind is `in` (read-only).
                    locals[parameter] = EvaluateExpression(addrOf.Operand);
                    if (parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out)
                    {
                        userRefSlots ??= [];
                        userRefSlots.Add((parameter, addrOf.Operand));
                    }
                }
                else
                {
                    var value = EvaluateExpression(arg);
                    locals[parameter] = value;
                }
            }

            using (PushFrame(locals))
            {
                var statement = program.Functions[node.Function];

                if (IsIteratorFunction(node.Function, statement))
                {
                    return EvaluateIteratorFunction(node.Function, statement);
                }

                var result = EvaluateFunctionBody(statement);

                // ADR-0060 item #7: write the final parameter slot value back to
                // the caller's lvalue for every 'ref'/'out' parameter.
                if (userRefSlots != null)
                {
                    foreach (var (parameter, operand) in userRefSlots)
                    {
                        var finalValue = locals.TryGetValue(parameter, out var v) ? v : null;
                        switch (operand)
                        {
                            case BoundVariableExpression bve:
                                Assign(bve.Variable, finalValue);
                                break;
                            case BoundFieldAccessExpression fa:
                                WriteBackField(fa, finalValue);
                                break;
                            case BoundPropertyAccessExpression pa:
                                WriteBackProperty(pa, finalValue);
                                break;
                            case BoundIndexExpression idx:
                                WriteBackIndex(idx, finalValue);
                                break;
                        }
                    }
                }

                if (node.Function.IsAsync)
                {
                    return WrapAsyncResult(node.Function.Type, result);
                }

                return result;
            }
        }
    }

    private bool IsIteratorFunction(Symbols.FunctionSymbol function, BoundBlockStatement body)
    {
        if (TryGetCachedIsIteratorFunction(function, out var cached))
        {
            return cached;
        }

        var walker = new YieldFinder();
        walker.RewriteStatement(body);
        cached = walker.Found;
        CacheIsIteratorFunction(function, cached);
        return cached;
    }

    private object EvaluateIteratorFunction(Symbols.FunctionSymbol function, BoundBlockStatement body)
    {
        // ADR-0040: iterator functions (sync `sequence[T]` / `IEnumerable[T]` and
        // async `IAsyncEnumerable[T]`) are realized eagerly under the interpreter.
        // We push a yield sink, run the body to completion synchronously (with
        // `await` modeled by `GetAwaiter().GetResult()` per the existing
        // single-threaded interp model), then wrap the collected items in a
        // typed list or an IAsyncEnumerable adapter for `await for` consumers.
        var elementType = GetIteratorElementClrType(function.Type);
        var listType = typeof(List<>).MakeGenericType(elementType);
        var list = (System.Collections.IList)Activator.CreateInstance(listType);

        IteratorSinks.Push(list);
        try
        {
            EvaluateFunctionBody(body);
        }
        finally
        {
            IteratorSinks.Pop();
        }

        if (IsAsyncEnumerableReturn(function.Type))
        {
            var wrapperType = typeof(InterpAsyncEnumerableBuffer<>).MakeGenericType(elementType);
            return Activator.CreateInstance(wrapperType, list);
        }

        return list;
    }

    private void EvaluateYieldStatement(BoundYieldStatement node)
    {
        if (IteratorSinks.Count == 0)
        {
            throw new EvaluatorException("'yield' encountered outside of an iterator function.", node);
        }

        var value = EvaluateExpression(node.Expression);
        IteratorSinks.Peek().Add(value);
        LastValue = value;
    }

    private static Type GetIteratorElementClrType(TypeSymbol type)
    {
        if (type is Symbols.SequenceTypeSymbol seq)
        {
            return seq.ElementType.ClrType ?? typeof(object);
        }

        var clr = type?.ClrType;
        if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            return clr.GetGenericArguments()[0];
        }

        return typeof(object);
    }

    private static bool IsAsyncEnumerableReturn(TypeSymbol type)
    {
        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var fullName = clr.GetGenericTypeDefinition().FullName;
        return fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    private static object WrapAsyncResult(TypeSymbol declaredReturn, object value)
    {
        if (declaredReturn == TypeSymbol.Void || declaredReturn == null)
        {
            return Task.CompletedTask;
        }

        var clr = declaredReturn.ClrType ?? typeof(object);
        var method = typeof(Task).GetMethod(nameof(Task.FromResult)).MakeGenericMethod(clr);
        return method.Invoke(null, new[] { value });
    }

    private object EvaluateUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);

        // Phase 3.B.3 sub-step 3: virtual dispatch. If the receiver's runtime
        // type overrides the statically-bound method, route to the override.
        var method = node.Method;

        // ADR-0085 / issue #726 (default-interface methods): when the
        // statically-bound method's receiver is an InterfaceSymbol, walk the
        // runtime class's hierarchy looking for a same-name method that
        // matches the interface signature. Fall back to the interface
        // method itself (which now carries a default body in program.Functions
        // when one was declared) if no implementer overrides it. This is the
        // interpreter analogue of CLR DIM dispatch.
        //
        // ADR-0090 / issue #756: private interface helpers are not part of
        // the v-table — never look on the runtime class. The helper's body
        // is registered in program.Functions and dispatched directly.
        if (method.ReceiverType is Symbols.InterfaceSymbol && receiverValue is StructValue ifaceSv && ifaceSv.StructType != null
            && method.Accessibility != Accessibility.Private)
        {
            FunctionSymbol implMethod = null;
            for (var t = ifaceSv.StructType; t != null; t = t.BaseClass)
            {
                if (t.TryGetMethod(method.Name, out var candidate))
                {
                    implMethod = candidate;
                    break;
                }
            }

            if (implMethod != null)
            {
                method = implMethod;
            }

            // else: leave `method` pointing at the interface method symbol;
            // its default body is registered in program.Functions (per the
            // ADR-0085 binder pipeline) and dispatched below.
        }
        else if (method.ThisParameter == null && receiverValue is StructValue tpSv && tpSv.StructType != null)
        {
            // Phase 4.2b: generic type-parameter dispatch (interface-constrained T).
            for (var t = tpSv.StructType; t != null; t = t.BaseClass)
            {
                if (t.TryGetMethod(method.Name, out var implMethod))
                {
                    method = implMethod;
                    break;
                }
            }
        }
        else if (receiverValue is StructValue sv && sv.StructType != null)
        {
            for (var t = sv.StructType; t != null; t = t.BaseClass)
            {
                if (t == method.ReceiverType)
                {
                    break;
                }

                if (t.TryGetMethod(method.Name, out var overrideMethod) && overrideMethod.IsOverride)
                {
                    method = overrideMethod;
                    break;
                }
            }
        }

        var frame = new ConcurrentDictionary<VariableSymbol, object>
        {
            [method.ThisParameter] = receiverValue,
        };

        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        for (int i = 0; i < node.Arguments.Length; i++)
        {
            var parameter = method.Parameters[i + parameterOffset];
            var value = EvaluateExpression(node.Arguments[i]);
            frame[parameter] = value;
        }

        using (PushFrame(frame))
        {
            var statement = program.Functions[method];
            return EvaluateFunctionBody(statement);
        }
    }

    /// <summary>
    /// ADR-0091: interprets <c>base[IFoo].M(args)</c>. Unlike
    /// <see cref="EvaluateUserInstanceCallExpression"/> this does NOT walk
    /// the runtime class's v-table — it dispatches directly to the
    /// interface's default body (the interpreter analogue of <c>call
    /// instance</c> rather than <c>callvirt</c>). Re-dispatching virtually
    /// would re-enter the override that issued the base-call and recurse
    /// infinitely.
    /// </summary>
    /// <param name="node">The bound base-interface call.</param>
    /// <returns>The default body's return value.</returns>
    private object EvaluateBaseInterfaceCallExpression(BoundBaseInterfaceCallExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);
        var method = node.Method;

        var frame = new ConcurrentDictionary<VariableSymbol, object>
        {
            [method.ThisParameter] = receiverValue,
        };

        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        for (int i = 0; i < node.Arguments.Length; i++)
        {
            var parameter = method.Parameters[i + parameterOffset];
            var value = EvaluateExpression(node.Arguments[i]);
            frame[parameter] = value;
        }

        using (PushFrame(frame))
        {
            var statement = program.Functions[method];
            return EvaluateFunctionBody(statement);
        }
    }

    /// <summary>
    /// Issue #986: interprets <c>base.M(args)</c> (and
    /// <c>base[BaseClass].M(args)</c>). Like
    /// <see cref="EvaluateBaseInterfaceCallExpression"/>, this dispatches
    /// directly to the base method body without walking the runtime class's
    /// v-table (the interpreter analogue of <c>call instance</c> rather than
    /// <c>callvirt</c>). Re-dispatching virtually would re-enter the derived
    /// override that issued the base-call and recurse infinitely.
    /// </summary>
    /// <param name="node">The bound base-class call.</param>
    /// <returns>The base method body's return value.</returns>
    private object EvaluateBaseClassCallExpression(BoundBaseClassCallExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);

        // Issue #1347: a base auto-property access has no accessor
        // FunctionSymbol — read/write its synthesized backing field directly on
        // the receiver, mirroring the ordinary auto-property fallback paths.
        if (node.Method == null && node.Property != null)
        {
            var backingField = node.Property.BackingField;
            if (node.IsSetterAccessor)
            {
                var value = EvaluateExpression(node.Arguments[0]);
                if (receiverValue is StructValue target && backingField != null)
                {
                    target.Fields[backingField.Name] = value;
                }

                return value;
            }

            if (receiverValue is StructValue sv && backingField != null
                && sv.Fields.TryGetValue(backingField.Name, out var fieldValue))
            {
                return fieldValue;
            }

            return DefaultValue(node.Property.Type);
        }

        var method = node.Method;

        var frame = new ConcurrentDictionary<VariableSymbol, object>
        {
            [method.ThisParameter] = receiverValue,
        };

        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        for (int i = 0; i < node.Arguments.Length; i++)
        {
            var parameter = method.Parameters[i + parameterOffset];
            var value = EvaluateExpression(node.Arguments[i]);
            frame[parameter] = value;
        }

        using (PushFrame(frame))
        {
            var statement = program.Functions[method];
            return EvaluateFunctionBody(statement);
        }
    }

    /// <summary>
    /// ADR-0089 / issue #755: interpret a constrained static-virtual call
    /// site of the form <c>T.M(args)</c>. The interpreter resolves the
    /// runtime <see cref="StructSymbol"/> bound to <c>T</c> at the current
    /// call frame using one of three strategies, in order:
    /// 1) Inspect the first <c>T</c>-typed argument's runtime
    ///    <see cref="StructValue.StructType"/> (the common generic-math
    ///    pattern: arguments are themselves of type <c>T</c>),
    /// 2) Walk the locals stack looking for any <see cref="StructValue"/>
    ///    whose declared interfaces include
    ///    <see cref="BoundConstrainedStaticCallExpression.InterfaceMethod"/>'s
    ///    declaring interface, or
    /// 3) Fall back to the interface's default body if the slot has one.
    /// </summary>
    private object EvaluateConstrainedStaticCallExpression(BoundConstrainedStaticCallExpression node)
    {
        // Evaluate arguments left-to-right (matches IL evaluation order).
        var evaluatedArgs = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            evaluatedArgs[i] = EvaluateExpression(node.Arguments[i]);
        }

        var slotIface = node.InterfaceMethod.StaticOwnerType as InterfaceSymbol;
        StructSymbol resolvedImpl = null;

        // Strategy 1: argument-runtime-type sniffing — works for the
        // canonical generic-math pattern (Add(a, b) where a, b are T).
        for (var i = 0; i < node.Arguments.Length && resolvedImpl == null; i++)
        {
            if (node.Arguments[i].Type is TypeParameterSymbol tp
                && tp == node.TypeParameter
                && evaluatedArgs[i] is StructValue sv
                && sv.StructType != null)
            {
                resolvedImpl = sv.StructType;
            }
        }

        // Strategy 2: walk locals for any in-scope StructValue
        // implementing the slot's interface.
        //
        // Issue #1799: frames became ConcurrentDictionary in #1718 (needed
        // for goroutine-shared writes), so `foreach (var kv in frame)`
        // enumerates in internal bucket-hash order instead of Dictionary's
        // de-facto insertion order — when two in-scope locals both
        // implement the slot's interface, first-match-wins could pick
        // either one from run to run. Sort each frame's entries by variable
        // name before scanning: names are unique within a single frame (a
        // frame's keys are one call's parameters/captures, and a valid
        // program cannot declare two same-named bindings in one scope), so
        // ordinal-name order is a total, stable order that is the same on
        // every run regardless of ConcurrentDictionary's bucket layout.
        if (resolvedImpl == null && slotIface != null)
        {
            foreach (var frame in Locals)
            {
                foreach (var kv in frame.OrderBy(static kv => kv.Key.Name, StringComparer.Ordinal))
                {
                    if (kv.Value is StructValue sv && sv.StructType != null)
                    {
                        foreach (var implIface in sv.StructType.Interfaces)
                        {
                            if (ReferenceEquals(implIface, slotIface)
                                || (implIface.Definition != null && ReferenceEquals(implIface.Definition, slotIface.Definition)))
                            {
                                resolvedImpl = sv.StructType;
                                break;
                            }
                        }
                    }

                    if (resolvedImpl != null)
                    {
                        break;
                    }
                }

                if (resolvedImpl != null)
                {
                    break;
                }
            }
        }

        // Resolve the matching static method on the implementer.
        FunctionSymbol target = null;
        if (resolvedImpl != null)
        {
            foreach (var candidate in resolvedImpl.GetStaticMethods(node.InterfaceMethod.Name))
            {
                if (candidate.Parameters.Length == node.InterfaceMethod.Parameters.Length)
                {
                    target = candidate;
                    break;
                }
            }

            // ADR-0089 / issue #1019: the slot may be a static-virtual
            // interface *property* accessor (get_Name / set_Name). The
            // implementer satisfies it via a static property in its shared
            // block, whose accessor FunctionSymbols live on
            // StaticProperties, not StaticMethods.
            if (target == null && !resolvedImpl.StaticProperties.IsDefaultOrEmpty)
            {
                foreach (var p in resolvedImpl.StaticProperties)
                {
                    if (p.GetterSymbol != null && p.GetterSymbol.Name == node.InterfaceMethod.Name)
                    {
                        target = p.GetterSymbol;
                        break;
                    }

                    if (p.SetterSymbol != null && p.SetterSymbol.Name == node.InterfaceMethod.Name)
                    {
                        target = p.SetterSymbol;
                        break;
                    }
                }
            }
        }

        // Strategy 3: fall back to the interface's default body.
        if (target == null)
        {
            target = node.InterfaceMethod;
        }

        if (!program.Functions.TryGetValue(target, out var statement))
        {
            throw new InvalidOperationException(
                $"Static-virtual interface call '{node.InterfaceMethod.Name}' has no runtime body (no implementer found and no default).");
        }

        var frame2 = new ConcurrentDictionary<VariableSymbol, object>();
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            frame2[target.Parameters[i]] = evaluatedArgs[i];
        }

        using (PushFrame(frame2))
        {
            return EvaluateFunctionBody(statement);
        }
    }

    private object EvaluateConversionExpression(BoundConversionExpression node)
    {
        var value = EvaluateExpression(node.Expression);
        if (node.Type == TypeSymbol.Bool)
        {
            return Convert.ToBoolean(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type == TypeSymbol.String)
        {
            return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type is NullableTypeSymbol nullableTarget)
        {
            // Phase 3.C.1: nullability is a bind-time annotation; the runtime
            // representation is identical to the underlying type. Issue #1236:
            // a lifted numeric widening (`T1? → T2?`, e.g. `uint8? → int32?`)
            // must still convert a present underlying value to the target
            // underlying type so a lifted binary operator sees a homogeneous
            // pair; a null source stays null (the lifted operator preserves it).
            if (value != null
                && nullableTarget.UnderlyingType?.ClrType is { } targetUnderlyingClr
                && IsSupportedNumericClrType(targetUnderlyingClr)
                && value.GetType() != targetUnderlyingClr)
            {
                return UncheckedNumericConvert(value, targetUnderlyingClr);
            }

            return value;
        }
        else if (node.Type == TypeSymbol.Object
            || node.Type is InterfaceSymbol
            || (node.Type is StructSymbol upcastTarget && upcastTarget.IsClass)
            || (node.Type?.ClrType != null && !node.Type.ClrType.IsValueType))
        {
            // Reference upcast (class → implemented interface, derived class
            // → base class, or any → object). Also covers issue #521: a CLR
            // class or interface widening. The interpreter stores instances
            // as boxed objects, so the upcast is a no-op at runtime — only
            // the bind-time static type changes.
            return value;
        }
        else if (node.Type?.ClrType != null && IsSupportedNumericClrType(node.Type.ClrType))
        {
            // ADR-0044: numeric conversions across the primitive lattice.
            // Cast unchecked to match the IL `conv.*` opcodes' truncation
            // semantics (Convert.ChangeType throws on overflow instead).
            // Issue #1881: inside a `checked` context (node.IsChecked), route
            // through the overflow-trapping conversion instead, matching the
            // emitter's `conv.ovf.*` opcodes.
            return node.IsChecked
                ? CheckedNumericConvert(value, node.Type.ClrType)
                : UncheckedNumericConvert(value, node.Type.ClrType);
        }
        else
        {
            throw new EvaluatorException($"Unexpected type {node.Type}", node);
        }
    }

    private static bool IsSupportedNumericClrType(Type t)
    {
        return t.IsSameAs(typeof(sbyte)) || t.IsSameAs(typeof(byte))
            || t.IsSameAs(typeof(short)) || t.IsSameAs(typeof(ushort))
            || t.IsSameAs(typeof(int)) || t.IsSameAs(typeof(uint))
            || t.IsSameAs(typeof(long)) || t.IsSameAs(typeof(ulong))
            || t.IsSameAs(typeof(nint)) || t.IsSameAs(typeof(nuint))
            || t.IsSameAs(typeof(float)) || t.IsSameAs(typeof(double))
            || t.IsSameAs(typeof(decimal)) || t.IsSameAs(typeof(char));
    }

    private static object UncheckedNumericConvert(object value, Type to)
    {
        // Mirror IL `conv.*` truncation: e.g. (int)9999999999L == 1410065407.
        // Convert.ChangeType is checked and throws OverflowException instead.
        if (value is decimal dv)
        {
            // decimal → primitive is checked at the BCL level even for
            // unchecked casts; route through (long) first when applicable.
            if (to.IsSameAs(typeof(float)))
            {
                return (float)dv;
            }

            if (to.IsSameAs(typeof(double)))
            {
                return (double)dv;
            }

            return UncheckedNumericConvert((long)dv, to);
        }

        if (to.IsSameAs(typeof(decimal)))
        {
            return Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture);
        }

        // For everything else, go through long / double, then unchecked cast.
        if (value is float fv)
        {
            return UncheckedNumericConvert((double)fv, to);
        }

        if (value is double dbv)
        {
            if (to.IsSameAs(typeof(float)))
            {
                return (float)dbv;
            }

            if (to.IsSameAs(typeof(double)))
            {
                return dbv;
            }

            return UncheckedNumericConvert((long)dbv, to);
        }

        // All integral / char sources fit into a long for round-tripping.
        long asLong = value switch
        {
            sbyte x => x,
            byte x => x,
            short x => x,
            ushort x => x,
            int x => x,
            uint x => x,
            long x => x,
            ulong x => unchecked((long)x),
            nint x => x,
            nuint x => unchecked((long)(ulong)x),
            char x => x,
            bool x => x ? 1 : 0,
            _ => Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture),
        };

        return to switch
        {
            Type t when t.IsSameAs(typeof(sbyte)) => unchecked((sbyte)asLong),
            Type t when t.IsSameAs(typeof(byte)) => unchecked((byte)asLong),
            Type t when t.IsSameAs(typeof(short)) => unchecked((short)asLong),
            Type t when t.IsSameAs(typeof(ushort)) => unchecked((ushort)asLong),
            Type t when t.IsSameAs(typeof(int)) => unchecked((int)asLong),
            Type t when t.IsSameAs(typeof(uint)) => unchecked((uint)asLong),
            Type t when t.IsSameAs(typeof(long)) => asLong,
            Type t when t.IsSameAs(typeof(ulong)) => unchecked((ulong)asLong),
            Type t when t.IsSameAs(typeof(nint)) => (nint)asLong,
            Type t when t.IsSameAs(typeof(nuint)) => unchecked((nuint)(ulong)asLong),
            Type t when t.IsSameAs(typeof(float)) => (float)asLong,
            Type t when t.IsSameAs(typeof(double)) => (double)asLong,
            Type t when t.IsSameAs(typeof(char)) => unchecked((char)asLong),
            _ => Convert.ChangeType(value, to, System.Globalization.CultureInfo.InvariantCulture),
        };
    }

    // Issue #1881: checked counterpart of <see cref="UncheckedNumericConvert"/>.
    // Float/double sources use a direct `checked` cast per target (matching
    // C#'s own checked-conversion truncation/range-check semantics, including
    // trapping on NaN/Infinity). Every integral/char source first widens
    // losslessly to <see cref="Int128"/> — which exactly preserves both sign
    // and full magnitude for every supported width, including `ulong`/`nuint`,
    // unlike a `long` intermediate which would misread the top bit of an
    // unsigned 64-bit value — then a single checked narrowing switch below
    // range-checks against the true value regardless of the source's
    // signedness. decimal is unaffected by checked/unchecked in C# (decimal
    // arithmetic/conversions always overflow-check), so it reuses the
    // unchecked path's decimal handling.
    private static object CheckedNumericConvert(object value, Type to)
    {
        if (value is decimal || to.IsSameAs(typeof(decimal)))
        {
            return UncheckedNumericConvert(value, to);
        }

        if (value is float fv)
        {
            return CheckedFloatingConvert(fv, to);
        }

        if (value is double dv)
        {
            return CheckedFloatingConvert(dv, to);
        }

        Int128 asInt128 = value switch
        {
            sbyte x => x,
            byte x => x,
            short x => x,
            ushort x => x,
            int x => x,
            uint x => x,
            long x => x,
            ulong x => x,
            nint x => x,
            nuint x => (ulong)x,
            char x => x,
            bool x => x ? 1 : 0,
            _ => throw new InvalidOperationException($"Unsupported checked conversion source {value?.GetType()}"),
        };

        return CheckedNarrowFromInt128(asInt128, to);
    }

    private static object CheckedNarrowFromInt128(Int128 v, Type to) => checked(to switch
    {
        Type t when t.IsSameAs(typeof(sbyte)) => (object)(sbyte)v,
        Type t when t.IsSameAs(typeof(byte)) => (object)(byte)v,
        Type t when t.IsSameAs(typeof(short)) => (object)(short)v,
        Type t when t.IsSameAs(typeof(ushort)) => (object)(ushort)v,
        Type t when t.IsSameAs(typeof(int)) => (object)(int)v,
        Type t when t.IsSameAs(typeof(uint)) => (object)(uint)v,
        Type t when t.IsSameAs(typeof(long)) => (object)(long)v,
        Type t when t.IsSameAs(typeof(ulong)) => (object)(ulong)v,
        Type t when t.IsSameAs(typeof(nint)) => (object)(nint)(long)v,
        Type t when t.IsSameAs(typeof(nuint)) => (object)(nuint)(ulong)v,
        Type t when t.IsSameAs(typeof(char)) => (object)(char)(ushort)v,
        Type t when t.IsSameAs(typeof(float)) => (object)(float)v,
        Type t when t.IsSameAs(typeof(double)) => (object)(double)v,
        _ => throw new InvalidOperationException($"Unsupported checked conversion target {to}"),
    });

    private static object CheckedFloatingConvert(double d, Type to) => checked(to switch
    {
        Type t when t.IsSameAs(typeof(sbyte)) => (object)(sbyte)d,
        Type t when t.IsSameAs(typeof(byte)) => (object)(byte)d,
        Type t when t.IsSameAs(typeof(short)) => (object)(short)d,
        Type t when t.IsSameAs(typeof(ushort)) => (object)(ushort)d,
        Type t when t.IsSameAs(typeof(int)) => (object)(int)d,
        Type t when t.IsSameAs(typeof(uint)) => (object)(uint)d,
        Type t when t.IsSameAs(typeof(long)) => (object)(long)d,
        Type t when t.IsSameAs(typeof(ulong)) => (object)(ulong)d,
        Type t when t.IsSameAs(typeof(nint)) => (object)(nint)(long)d,
        Type t when t.IsSameAs(typeof(nuint)) => (object)(nuint)(ulong)d,
        Type t when t.IsSameAs(typeof(char)) => (object)(char)(ushort)d,
        Type t when t.IsSameAs(typeof(float)) => (object)(float)d,
        Type t when t.IsSameAs(typeof(double)) => d,
        _ => throw new InvalidOperationException($"Unsupported checked conversion target {to}"),
    });

    private object EvaluateImportedCallExpression(BoundImportedCallExpression node)
    {
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        // Issue #1599: a generic BCL method closed over a same-compilation user
        // value type (e.g. `Enum.TryParse[Color]`) was closed over a value-type
        // placeholder during overload resolution because the user type has no
        // reference-context CLR type. Such a method cannot be reflection-invoked
        // (the placeholder parameter rejects the interpreter's boxed value), so
        // emulate the ones the interpreter can service directly. `Enum.TryParse`
        // maps a member name (or a numeric string) to the enum's underlying
        // integer value — exactly the interpreter's representation of a user enum.
        if (TryEmulateSameCompilationEnumTryParse(node, args, out var emulatedResult))
        {
            WriteBackRefSlots(refSlots, args);
            return emulatedResult;
        }

        var result = node.Function.Method.Invoke(null, args);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    /// <summary>
    /// Issue #1599: emulates <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c> and its
    /// <c>(string, bool ignoreCase, out TEnum)</c> overload when <c>TEnum</c> is a
    /// same-compilation user enum. The closed BCL method carries a value-type
    /// placeholder for the erased user enum and therefore cannot be reflection-invoked;
    /// the interpreter represents user-enum values as their underlying <see cref="int"/>,
    /// so the parse can be serviced against the enum symbol's members. Writes the parsed
    /// value into the <c>out</c> argument slot and reports success via
    /// <paramref name="parseResult"/>.
    /// </summary>
    /// <param name="node">The imported call being evaluated.</param>
    /// <param name="args">The evaluated argument slots (mutated for the out parameter).</param>
    /// <param name="parseResult">The boolean parse outcome, when emulated.</param>
    /// <returns><see langword="true"/> when the call was emulated; otherwise <see langword="false"/>.</returns>
    private static bool TryEmulateSameCompilationEnumTryParse(BoundImportedCallExpression node, object[] args, out object parseResult)
    {
        parseResult = null;
        var method = node.Function?.Method;
        if (method == null
            || !method.IsGenericMethod
            || !string.Equals(method.Name, "TryParse", System.StringComparison.Ordinal)
            || method.DeclaringType?.IsSameAs(typeof(System.Enum)) != true
            || node.TypeArgumentSymbols.IsDefaultOrEmpty
            || node.TypeArgumentSymbols[0] is not Symbols.EnumSymbol enumSymbol
            || enumSymbol.ClrType != null)
        {
            return false;
        }

        // The out parameter is the final by-ref slot.
        var outIndex = -1;
        for (var i = 0; i < node.ArgumentRefKinds.Length; i++)
        {
            if (node.ArgumentRefKinds[i] == RefKind.Out)
            {
                outIndex = i;
            }
        }

        if (outIndex < 0 || args.Length == 0)
        {
            return false;
        }

        var value = args[0] as string;
        var ignoreCase = outIndex >= 2 && args[1] is bool ic && ic;
        var comparison = ignoreCase ? System.StringComparison.OrdinalIgnoreCase : System.StringComparison.Ordinal;

        var success = false;
        var parsed = 0;
        if (!string.IsNullOrEmpty(value))
        {
            foreach (var member in enumSymbol.Members)
            {
                if (string.Equals(member.Name, value, comparison))
                {
                    parsed = member.Value;
                    success = true;
                    break;
                }
            }

            // .NET also accepts a numeric string for any underlying value.
            if (!success && int.TryParse(value, out var numeric))
            {
                parsed = numeric;
                success = true;
            }
        }

        args[outIndex] = parsed;
        parseResult = success;
        return true;
    }

    private object EvaluateImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        var receiver = EvaluateExpression(node.Receiver);

        // Issue #517: Nullable<T> instance methods (e.g. `GetValueOrDefault`,
        // `Equals`, `ToString`) cannot dispatch through `MethodInfo.Invoke`
        // because the interpreter stores nullables as the underlying boxed T
        // (or `null`), not as `Nullable<T>` instances — the CLR special-cases
        // boxing of `Nullable<T>` to the same payload. Synthesize the
        // observable semantics for the mandated members; everything else
        // falls back to a synthesized `Nullable<T>` re-dispatch where the
        // BCL provides natural answers.
        if (TryEvaluateNullableInstanceCall(node, receiver, out var nullableResult))
        {
            return nullableResult;
        }

        receiver = UnwrapClrReceiver(receiver);
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        var method = ResolveMethodForReceiver(node.Method, receiver);

        // concurrency: see TryGetInterpreterMapLock — routes `range m`'s
        // `GetEnumerator()`/`MoveNext()`, `m.ContainsKey(k)`, `m.Remove(k)`,
        // and any other reflection-dispatched method call whose receiver is
        // an interpreter-owned map through the same per-map lock as
        // index/delete/len.
        if (TryGetInterpreterMapLock(receiver, out var mapLock))
        {
            lock (mapLock)
            {
                var invokeReceiver = IsMapViewMember(method.Name)
                    ? CloneMapSnapshot((System.Collections.IDictionary)receiver)
                    : receiver;
                var lockedResult = method.Invoke(invokeReceiver, args);
                WriteBackRefSlots(refSlots, args);
                return lockedResult;
            }
        }

        var result = method.Invoke(receiver, args);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    // Issue #814 / ADR-0084 §L5: when an open generic extension method is
    // invoked through the interpreter (e.g. `arr.FirstOrNil()` against an
    // `int[]`), the lowered `for v in self` loop carries a
    // `System.Collections.Generic.IEnumerable<object>::GetEnumerator`
    // MethodInfo because the binder/lowerer routes through the symbolic
    // open shape. `MethodInfo.Invoke` against an `int[]` receiver then fails
    // because `int[]` does not implement `IEnumerable<object>` (CLR array
    // covariance is reference-only). Re-route through the matching closed
    // generic interface on the receiver's runtime type when the literal
    // declaring type is unassignable but a sibling closed instantiation is.
    // The lookup also walks inherited interfaces (e.g. `MoveNext` lives on
    // the non-generic `IEnumerator` even when the receiver is reached via
    // `IEnumerator<T>`).
    private static System.Reflection.MethodInfo ResolveMethodForReceiver(System.Reflection.MethodInfo method, object receiver)
    {
        if (receiver == null || method == null)
        {
            return method;
        }

        var declaring = method.DeclaringType;
        if (declaring == null || declaring.IsAssignableFrom(receiver.GetType()))
        {
            return method;
        }

        var receiverType = receiver.GetType();
        var paramTypes = System.Array.ConvertAll(method.GetParameters(), p => p.ParameterType);

        if (declaring.IsGenericType)
        {
            var openDecl = declaring.GetGenericTypeDefinition();
            foreach (var iface in receiverType.GetInterfaces())
            {
                if (!iface.IsGenericType || iface.GetGenericTypeDefinition() != openDecl)
                {
                    continue;
                }

                var candidate = iface.GetMethod(
                    method.Name,
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                    binder: null,
                    types: paramTypes,
                    modifiers: null);
                if (candidate != null)
                {
                    return candidate;
                }
            }
        }

        // Fall-back search: the method (e.g. `MoveNext`) may live on a
        // parent non-generic interface that the receiver also implements.
        // Find it by name+arity across every interface and the receiver
        // type itself; this works for `IEnumerator::MoveNext` reached via
        // `IEnumerator<int>` and similar inheritance.
        foreach (var iface in receiverType.GetInterfaces())
        {
            var candidate = iface.GetMethod(
                method.Name,
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
                binder: null,
                types: paramTypes,
                modifiers: null);
            if (candidate != null)
            {
                return candidate;
            }
        }

        var direct = receiverType.GetMethod(
            method.Name,
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public,
            binder: null,
            types: paramTypes,
            modifiers: null);
        return direct ?? method;
    }

    // Issue #517: `GetValueOrDefault()` and `GetValueOrDefault(T)` against the
    // interpreter's underlying-or-null nullable representation.
    private bool TryEvaluateNullableInstanceCall(
        BoundImportedInstanceCallExpression node,
        object receiver,
        out object result)
    {
        result = null;
        var declaring = node.Method.DeclaringType;
        if (declaring == null || !declaring.IsGenericType
            || declaring.GetGenericTypeDefinition().FullName != "System.Nullable`1")
        {
            return false;
        }

        switch (node.Method.Name)
        {
            case "GetValueOrDefault":
                if (node.Arguments.Length == 0)
                {
                    var underlying = declaring.GetGenericArguments()[0];
                    result = receiver ?? (underlying.IsValueType ? System.Activator.CreateInstance(underlying) : null);
                    return true;
                }

                if (node.Arguments.Length == 1)
                {
                    var fallback = EvaluateExpression(node.Arguments[0]);
                    result = receiver ?? fallback;
                    return true;
                }

                return false;
            default:
                return false;
        }
    }

    /// <summary>ADR-0039: Evaluates &amp;expr — in the interpreter, returns the current value (the write-back is handled at call sites).</summary>
    private object EvaluateAddressOfExpression(BoundAddressOfExpression node)
    {
        // In the interpreter, &x just evaluates to the value of x.
        // Write-back is handled by the ref-slot mechanism at call sites.
        return EvaluateExpression(node.Operand);
    }

    /// <summary>ADR-0039: Evaluates *p — in the interpreter, this is identity since we don't have real pointers.</summary>
    private object EvaluateDereferenceExpression(BoundDereferenceExpression node)
    {
        return EvaluateExpression(node.Operand);
    }

    /// <summary>ADR-0039: Builds the argument array and identifies ref/out slot write-back targets.</summary>
    private List<(int Index, BoundExpression Operand)> BuildRefSlots(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> refKinds,
        object[] args)
    {
        List<(int Index, BoundExpression Operand)> refSlots = null;

        for (int i = 0; i < arguments.Length; i++)
        {
            var arg = arguments[i];
            var rk = refKinds.IsDefault || i >= refKinds.Length ? RefKind.None : refKinds[i];

            if (rk != RefKind.None && arg is BoundAddressOfExpression addrOf)
            {
                // ADR-0039 / issue #1599: `out` never reads the incoming value,
                // and for an inline `out var n` declaration the synthesized local
                // is not yet present in the interpreter's locals map (it is only
                // created by the write-back below). Evaluating the operand here
                // would throw a KeyNotFoundException, so pass the pointee type's
                // default for `out` and only read the current value for `ref`.
                args[i] = rk == RefKind.Out
                    ? DefaultValue(addrOf.Operand.Type)
                    : EvaluateExpression(addrOf.Operand);
                if (rk == RefKind.Ref || rk == RefKind.Out)
                {
                    refSlots ??= [];
                    refSlots.Add((i, addrOf.Operand));
                }
            }
            else
            {
                args[i] = EvaluateExpression(arg);
            }
        }

        return refSlots;
    }

    /// <summary>ADR-0039: Writes back modified ref/out argument values after a CLR method invocation.</summary>
    private void WriteBackRefSlots(List<(int Index, BoundExpression Operand)> refSlots, object[] args)
    {
        if (refSlots == null)
        {
            return;
        }

        foreach (var (index, operand) in refSlots)
        {
            var value = args[index];
            switch (operand)
            {
                case BoundVariableExpression bve:
                    Assign(bve.Variable, value);
                    break;
                case BoundFieldAccessExpression fa:
                    WriteBackField(fa, value);
                    break;
                case BoundPropertyAccessExpression pa:
                    WriteBackProperty(pa, value);
                    break;
                case BoundIndexExpression idx:
                    WriteBackIndex(idx, value);
                    break;
            }
        }
    }

    /// <summary>ADR-0039: Writes back a value into a field after ref/out return.</summary>
    private void WriteBackField(BoundFieldAccessExpression fa, object value)
    {
        if (fa.Receiver == null)
        {
            // ADR-0053: static field write-back.
            if (fa.InterfaceType != null)
            {
                // Issue #1030: interface static field write-back.
                SetInterfaceStaticField(fa.InterfaceType, fa.Field, value);
                return;
            }

            SetStaticField(fa.StructType, fa.Field, value);
            return;
        }

        var receiver = EvaluateExpression(fa.Receiver);
        if (receiver is StructValue sv)
        {
            sv.Fields[fa.Field.Name] = value;
        }
    }

    /// <summary>ADR-0051: Writes back a value into a property backing field after ref/out return.</summary>
    private void WriteBackProperty(BoundPropertyAccessExpression pa, object value)
    {
        if (pa.Property.IsAutoProperty && pa.Property.BackingField != null)
        {
            if (pa.Receiver == null)
            {
                // ADR-0053: static property write-back.
                SetStaticField(pa.StructType, pa.Property.BackingField, value);
                return;
            }

            var receiver = EvaluateExpression(pa.Receiver);
            if (receiver is StructValue sv)
            {
                sv.Fields[pa.Property.BackingField.Name] = value;
            }
        }
    }

    /// <summary>ADR-0039: Writes back a value into an array element after ref/out return.</summary>
    private void WriteBackIndex(BoundIndexExpression idx, object value)
    {
        var target = EvaluateExpression(idx.Target);
        var index = EvaluateExpression(idx.Index);
        if (target is Array arr && index is int i)
        {
            arr.SetValue(value, i);
        }
    }

    private object EvaluateNullConditionalAccessExpression(BoundNullConditionalAccessExpression node)
    {
        // Phase 3.C.3b: evaluate the receiver exactly once; nil short-circuits
        // the whole subtree to nil. Otherwise, bind the value to the synthetic
        // capture local so the access subtree resolves to the receiver value
        // without re-evaluating it.
        var receiver = EvaluateExpression(node.Receiver);
        if (receiver == null)
        {
            return null;
        }

        var locals = this.Locals.Peek();
        locals[node.Capture] = receiver;
        try
        {
            return EvaluateExpression(node.WhenNotNull);
        }
        finally
        {
            locals.TryRemove(node.Capture, out _);
        }
    }

    private void Assign(VariableSymbol variable, object value)
    {
        // Value-typed structs are copied on assignment (Go semantics).
        // Class types (Phase 3.B.3) are reference types — share the instance.
        if (value is StructValue sv && !sv.StructType.IsClass)
        {
            value = sv.Copy();
        }

        if (variable.Kind == SymbolKind.GlobalVariable)
        {
            SetGlobal(variable, value);
        }
        else
        {
            var locals = this.Locals.Peek();

            // Issue #491 (ADR-0060 follow-up): writing to a ref-aliasing local
            // routes the new value to the aliased storage (not replacing the
            // alias itself).
            if (locals.TryGetValue(variable, out var existing) && existing is RefAlias alias)
            {
                WriteBackToOperand(alias.Operand, value);
                return;
            }

            locals[variable] = value;
        }
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): writes <paramref name="value"/> through a
    /// bound lvalue expression (variable, field, property, or indexer access).
    /// Shared between ref-aliasing local writes and the existing ref/out parameter
    /// write-back path.
    /// </summary>
    private void WriteBackToOperand(Binding.BoundExpression operand, object value)
    {
        switch (operand)
        {
            case BoundVariableExpression bve:
                Assign(bve.Variable, value);
                break;
            case BoundFieldAccessExpression fa:
                WriteBackField(fa, value);
                break;
            case BoundPropertyAccessExpression pa:
                WriteBackProperty(pa, value);
                break;
            case BoundIndexExpression idx:
                WriteBackIndex(idx, value);
                break;
            case BoundDereferenceExpression deref:
                // *p = v under interpreter: re-route through the inner operand.
                WriteBackToOperand(deref.Operand, value);
                break;
        }
    }

    private object EvaluateIsExpression(BoundIsExpression node)
    {
        var value = EvaluateExpression(node.Expression);
        if (value == null)
        {
            return false;
        }

        var targetType = node.TargetType is NullableTypeSymbol nts
            ? nts.UnderlyingType
            : node.TargetType;
        if (targetType == null || targetType == TypeSymbol.Error)
        {
            return false;
        }

        // ADR-0069 (and addendum / issue #712): use the same matching helper
        // pattern-matching uses, so user-declared G# classes (whose runtime
        // representation is a <see cref="StructValue"/>) correctly satisfy
        // an `is` test against a declared base/derived type even when no
        // CLR-side type identity exists.
        return MatchesType(targetType, value);
    }

    private object EvaluateAsExpression(BoundAsExpression node)
    {
        var value = EvaluateExpression(node.Expression);
        if (value == null)
        {
            return null;
        }

        var targetType = node.TargetType is NullableTypeSymbol nts
            ? nts.UnderlyingType
            : node.TargetType;
        if (targetType == null || targetType == TypeSymbol.Error)
        {
            return null;
        }

        // ADR-0069 (and addendum / issue #712): mirror EvaluateIsExpression
        // so an `as` cast on a user-declared G# class succeeds when the
        // value is a matching <see cref="StructValue"/>.
        if (MatchesType(targetType, value))
        {
            return value;
        }

        return null;
    }

    /// <summary>
    /// ADR-0065 §2: evaluates a <c>init(args)</c> self-delegation call inside
    /// a <c>convenience init</c> body. Looks up the current <c>this</c> in the
    /// active locals frame and invokes the chained-to sibling constructor's
    /// body against it. Returns <see langword="null"/> (the statement has no
    /// value-position result).
    /// </summary>
    private object EvaluateConstructorChainingExpression(BoundConstructorChainingExpression node)
    {
        var targetCtor = node.SelectedConstructor;
        if (targetCtor == null)
        {
            throw new EvaluatorException("Constructor chaining target was not resolved.", node);
        }

        var thisParam = targetCtor.Function.ThisParameter;
        StructValue receiver = null;

        // Walk the local frames stack from innermost outward looking for the
        // current `this` binding. The convenience init body is bound with its
        // own `this`, which matches the chained-to ctor's `this` since both
        // belong to the same class.
        foreach (var frame in Locals)
        {
            foreach (var kv in frame)
            {
                if (kv.Value is StructValue sv && kv.Key is ParameterSymbol param && param.Name == "this")
                {
                    receiver = sv;
                    break;
                }
            }

            if (receiver != null)
            {
                break;
            }
        }

        if (receiver == null)
        {
            throw new EvaluatorException("Convenience initializer self-delegation could not locate the current 'this'.", node);
        }

        // Evaluate the chained-to ctor's arguments first (in the current frame
        // so that the convenience init's own parameters are in scope).
        var argValues = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            argValues[i] = EvaluateExpression(node.Arguments[i]);
        }

        // Build the chained-to ctor's frame and run its body. ADR-0065 §5: a
        // synthesized primary-ctor delegate has no bound body — materialize
        // the same field-assignment shape as the primary-ctor path.
        if (targetCtor.IsSynthesizedFromPrimaryConstructor)
        {
            var primaryParams = targetCtor.DeclaringType?.PrimaryConstructorParameters ?? ImmutableArray<ParameterSymbol>.Empty;
            for (var i = 0; i < primaryParams.Length; i++)
            {
                receiver.Fields[primaryParams[i].Name] = argValues[i];
            }

            return null;
        }

        var chainFrame = new ConcurrentDictionary<VariableSymbol, object>
        {
            [thisParam] = receiver,
        };

        for (var i = 0; i < targetCtor.Function.Parameters.Length; i++)
        {
            chainFrame[targetCtor.Function.Parameters[i]] = argValues[i];
        }

        using (PushFrame(chainFrame))
        {
            if (targetCtor.BaseInitializer is BaseConstructorInitializer chainBaseInit
                && chainBaseInit.GSharpBaseType is StructSymbol chainGsBase)
            {
                var baseParams = chainGsBase.PrimaryConstructorParameters;
                for (var i = 0; i < baseParams.Length && i < chainBaseInit.Arguments.Length; i++)
                {
                    receiver.Fields[baseParams[i].Name] = EvaluateExpression(chainBaseInit.Arguments[i]);
                }
            }

            var body = program.Functions[targetCtor.Function];
            EvaluateFunctionBody(body);
        }

        return null;
    }
}
