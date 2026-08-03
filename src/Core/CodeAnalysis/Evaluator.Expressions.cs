// <copyright file="Evaluator.Expressions.cs" company="GSharp">
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
/// Issue #1361 partial of <see cref="Evaluator"/>: expression evaluation — literals, interpolated strings, variables, assignments, arrays, maps, indexing, len/cap/append, struct/tuple/function literals, constructor calls, and CLR member access.
/// See <c>Evaluator.cs</c> for the root partial (fields, constructor,
/// execution-state accessors, frame management, and the nested state types).
/// </summary>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Type, Func<Func<object[], object>, Delegate>> InterpreterDelegateFactories = new();
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<FunctionSymbol, ConcurrentDictionary<Type, Func<Func<object[], object>, Delegate>>> InterpreterDelegateFactoriesBySite = new();
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Delegate, ClosureValue> InterpreterClosures = new();
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<StructSymbol, Type> ClrBackingTypes = new();
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<TypeSymbol, Type> ClrReifiedTypes = new();
    private static int clrBackingAssemblyOrdinal;

    private object EvaluateExpression(BoundExpression node)
    {
        try
        {
            return node.Kind switch
            {
                BoundNodeKind.LiteralExpression => EvaluateLiteralExpression((BoundLiteralExpression)node),
                BoundNodeKind.VariableExpression => EvaluateVariableExpression((BoundVariableExpression)node),
                BoundNodeKind.AssignmentExpression => EvaluateAssignmentExpression((BoundAssignmentExpression)node),
                BoundNodeKind.UnaryExpression => EvaluateUnaryExpression((BoundUnaryExpression)node),
                BoundNodeKind.BinaryExpression => EvaluateBinaryExpression((BoundBinaryExpression)node),
                BoundNodeKind.CallExpression => EvaluateCallExpression((BoundCallExpression)node),
                BoundNodeKind.ConversionExpression => EvaluateConversionExpression((BoundConversionExpression)node),
                BoundNodeKind.ImportedCallExpression => EvaluateImportedCallExpression((BoundImportedCallExpression)node),
                BoundNodeKind.ImportedInstanceCallExpression => EvaluateImportedInstanceCallExpression((BoundImportedInstanceCallExpression)node),
                BoundNodeKind.ConstrainedStaticCallExpression => EvaluateConstrainedStaticCallExpression((BoundConstrainedStaticCallExpression)node),
                BoundNodeKind.ArrayCreationExpression => EvaluateArrayCreationExpression((BoundArrayCreationExpression)node),
                BoundNodeKind.StackAllocExpression => throw new EvaluatorException("stackalloc is not supported in the interpreter; it requires the CIL localloc emit path.", node),
                BoundNodeKind.MapLiteralExpression => EvaluateMapLiteralExpression((BoundMapLiteralExpression)node),
                BoundNodeKind.MapDeleteExpression => EvaluateMapDeleteExpression((BoundMapDeleteExpression)node),
                BoundNodeKind.IndexExpression => EvaluateIndexExpression((BoundIndexExpression)node),
                BoundNodeKind.IndexAssignmentExpression => EvaluateIndexAssignmentExpression((BoundIndexAssignmentExpression)node),
                BoundNodeKind.LenExpression => EvaluateLenExpression((BoundLenExpression)node),
                BoundNodeKind.TypeOfExpression => EvaluateTypeOfExpression((BoundTypeOfExpression)node),
                BoundNodeKind.SizeOfExpression => throw new EvaluatorException("sizeof on an unmanaged-pointer struct pointee is not supported in the interpreter; it requires the CIL sizeof emit path.", node),
                BoundNodeKind.FunctionPointerFromMethodExpression => throw new EvaluatorException("'&Method' function pointers are not supported in the interpreter; they require the CIL ldftn/calli emit path (ADR-0122 §9).", node),
                BoundNodeKind.FunctionPointerInvocationExpression => throw new EvaluatorException("function-pointer invocation ('fp(args)') is not supported in the interpreter; it requires the CIL calli emit path (ADR-0122 §9).", node),
                BoundNodeKind.CapExpression => EvaluateCapExpression((BoundCapExpression)node),
                BoundNodeKind.AppendExpression => EvaluateAppendExpression((BoundAppendExpression)node),
                BoundNodeKind.StructLiteralExpression => EvaluateStructLiteralExpression((BoundStructLiteralExpression)node),
                BoundNodeKind.BlockExpression => EvaluateBlockExpression((BoundBlockExpression)node),
                BoundNodeKind.ConstructorCallExpression => EvaluateConstructorCallExpression((BoundConstructorCallExpression)node),
                BoundNodeKind.UserInstanceCallExpression => EvaluateUserInstanceCallExpression((BoundUserInstanceCallExpression)node),
                BoundNodeKind.BaseInterfaceCallExpression => EvaluateBaseInterfaceCallExpression((BoundBaseInterfaceCallExpression)node),
                BoundNodeKind.BaseClassCallExpression => EvaluateBaseClassCallExpression((BoundBaseClassCallExpression)node),
                BoundNodeKind.FieldAccessExpression => EvaluateFieldAccessExpression((BoundFieldAccessExpression)node),
                BoundNodeKind.FieldAssignmentExpression => EvaluateFieldAssignmentExpression((BoundFieldAssignmentExpression)node),
                BoundNodeKind.PropertyAccessExpression => EvaluatePropertyAccessExpression((BoundPropertyAccessExpression)node),
                BoundNodeKind.PropertyAssignmentExpression => EvaluatePropertyAssignmentExpression((BoundPropertyAssignmentExpression)node),
                BoundNodeKind.NullConditionalAccessExpression => EvaluateNullConditionalAccessExpression((BoundNullConditionalAccessExpression)node),
                BoundNodeKind.TupleLiteralExpression => EvaluateTupleLiteralExpression((BoundTupleLiteralExpression)node),
                BoundNodeKind.TupleElementAccessExpression => EvaluateTupleElementAccessExpression((BoundTupleElementAccessExpression)node),
                BoundNodeKind.FunctionLiteralExpression => EvaluateFunctionLiteralExpression((BoundFunctionLiteralExpression)node),
                BoundNodeKind.MethodGroupExpression => EvaluateMethodGroupExpression((BoundMethodGroupExpression)node),
                BoundNodeKind.ClrMethodGroupExpression => EvaluateClrMethodGroupExpression((BoundClrMethodGroupExpression)node),
                BoundNodeKind.IndirectCallExpression => EvaluateIndirectCallExpression((BoundIndirectCallExpression)node),
                BoundNodeKind.ClrConstructorCallExpression => EvaluateClrConstructorCallExpression((BoundClrConstructorCallExpression)node),
                BoundNodeKind.ClrStaticCallExpression => EvaluateClrStaticCallExpression((BoundClrStaticCallExpression)node),
                BoundNodeKind.ClrPropertyAccessExpression => EvaluateClrPropertyAccessExpression((BoundClrPropertyAccessExpression)node),
                BoundNodeKind.ClrPropertyAssignmentExpression => EvaluateClrPropertyAssignmentExpression((BoundClrPropertyAssignmentExpression)node),
                BoundNodeKind.ClrEventSubscriptionExpression => EvaluateClrEventSubscriptionExpression((BoundClrEventSubscriptionExpression)node),
                BoundNodeKind.EventSubscriptionExpression => EvaluateEventSubscriptionExpression((BoundEventSubscriptionExpression)node),
                BoundNodeKind.ClrBinaryOperatorExpression => EvaluateClrBinaryOperatorExpression((BoundClrBinaryOperatorExpression)node),
                BoundNodeKind.ClrUnaryOperatorExpression => EvaluateClrUnaryOperatorExpression((BoundClrUnaryOperatorExpression)node),
                BoundNodeKind.ClrConversionCallExpression => EvaluateClrConversionCallExpression((BoundClrConversionCallExpression)node),
                BoundNodeKind.ClrIndexExpression => EvaluateClrIndexExpression((BoundClrIndexExpression)node),
                BoundNodeKind.ClrIndexAssignmentExpression => EvaluateClrIndexAssignmentExpression((BoundClrIndexAssignmentExpression)node),
                BoundNodeKind.AwaitExpression => EvaluateAwaitExpression((BoundAwaitExpression)node),
                BoundNodeKind.SwitchExpression => EvaluateSwitchExpression((BoundSwitchExpression)node),
                BoundNodeKind.ConditionalExpression => EvaluateConditionalExpression((BoundConditionalExpression)node),
                BoundNodeKind.ThrowExpression => EvaluateThrowExpression((BoundThrowExpression)node),
                BoundNodeKind.MakeChannelExpression => EvaluateMakeChannelExpression((BoundMakeChannelExpression)node),
                BoundNodeKind.ChannelReceiveExpression => EvaluateChannelReceiveExpression((BoundChannelReceiveExpression)node),
                BoundNodeKind.ChannelCloseExpression => EvaluateChannelCloseExpression((BoundChannelCloseExpression)node),
                BoundNodeKind.AddressOfExpression => EvaluateAddressOfExpression((BoundAddressOfExpression)node),
                BoundNodeKind.DereferenceExpression => EvaluateDereferenceExpression((BoundDereferenceExpression)node),
                BoundNodeKind.DefaultExpression => EvaluateDefaultExpression((BoundDefaultExpression)node),
                BoundNodeKind.TypeParameterConstructionExpression => EvaluateTypeParameterConstructionExpression((BoundTypeParameterConstructionExpression)node),
                BoundNodeKind.InterpolatedStringExpression => EvaluateInterpolatedStringExpression((BoundInterpolatedStringExpression)node),
                BoundNodeKind.IsExpression => EvaluateIsExpression((BoundIsExpression)node),
                BoundNodeKind.AsExpression => EvaluateAsExpression((BoundAsExpression)node),
                BoundNodeKind.ConstructorChainingExpression => EvaluateConstructorChainingExpression((BoundConstructorChainingExpression)node),
                _ => throw new EvaluatorException($"Unexpected node {node.Kind}", node),
            };
        }
        catch (Exception ex) when (ex is not EvaluatorException)
        {
            throw new EvaluatorException(ex.Message, ex, node);
        }
    }

    private object EvaluateLiteralExpression(BoundLiteralExpression n)
    {
        return n.Value;
    }

    // ADR-0055 (issue #368): render an interpolated string directly via
    // composite formatting. Each hole is formatted with its format specifier
    // (when the runtime value is IFormattable) under the current culture, then
    // padded to the requested alignment. This mirrors the IL emitter's
    // DefaultInterpolatedStringHandler lowering so interpreter and compiled
    // output agree.
    private object EvaluateInterpolatedStringExpression(BoundInterpolatedStringExpression node)
    {
        if (node.Handler != null)
        {
            return EvaluateInterpolatedStringHandler(node);
        }

        var builder = new System.Text.StringBuilder();
        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                builder.Append(part.Literal);
                continue;
            }

            var value = EvaluateExpression(part.Value);
            string text;
            if (part.Format != null && value is IFormattable formattable)
            {
                text = formattable.ToString(part.Format, System.Globalization.CultureInfo.CurrentCulture);
            }
            else
            {
                text = value?.ToString() ?? string.Empty;
            }

            if (part.Alignment.HasValue && part.Alignment.Value != 0)
            {
                var width = part.Alignment.Value;
                text = width > 0 ? text.PadLeft(width) : text.PadRight(-width);
            }

            builder.Append(text);
        }

        return builder.ToString();
    }

    // Issue #368: render an interpolated string targeting a user-defined
    // [InterpolatedStringHandler] by constructing the handler via reflection
    // (forwarding the referenced surrounding arguments / receiver), invoking
    // its AppendLiteral / AppendFormatted methods in order, and returning the
    // constructed handler instance so the receiving API consumes it directly.
    // This keeps the tree-walk interpreter in parity with the IL emit path.
    private object EvaluateInterpolatedStringHandler(BoundInterpolatedStringExpression node)
    {
        var info = node.Handler;
        var literalLength = 0;
        var formattedCount = 0;
        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                literalLength += part.Literal.Length;
            }
            else
            {
                formattedCount++;
            }
        }

        var ctorParams = info.Constructor.GetParameters();
        var ctorArgs = new object[ctorParams.Length];
        ctorArgs[0] = literalLength;
        ctorArgs[1] = formattedCount;
        for (var i = 0; i < info.ForwardedArguments.Length; i++)
        {
            ctorArgs[2 + i] = EvaluateExpression(info.ForwardedArguments[i]);
        }

        var shouldAppend = true;
        if (info.HasTrailingOutBool)
        {
            ctorArgs[ctorArgs.Length - 1] = false;
        }

        var handler = InvokeReflective(info.Constructor, null, ctorArgs, node);
        if (info.HasTrailingOutBool)
        {
            shouldAppend = (bool)ctorArgs[ctorArgs.Length - 1];
        }

        var handlerType = info.HandlerClrType;
        var appendLiteral = handlerType.GetMethod("AppendLiteral", new[] { typeof(string) });
        foreach (var part in node.Parts)
        {
            if (!shouldAppend)
            {
                break;
            }

            if (part.IsLiteral)
            {
                if (part.Literal.Length == 0)
                {
                    continue;
                }

                var literalResult = InvokeReflective(appendLiteral, handler, [part.Literal], node);
                if (literalResult is bool lb)
                {
                    shouldAppend = lb;
                }

                continue;
            }

            var value = EvaluateExpression(part.Value);
            var formattedResult = InvokeUserAppendFormatted(handlerType, handler, part, value, node);
            if (formattedResult is bool fb)
            {
                shouldAppend = fb;
            }
        }

        return handler;
    }

    private object InvokeUserAppendFormatted(
        System.Type handlerType,
        object handler,
        BoundInterpolatedStringPart part,
        object value,
        BoundNode node)
    {
        var wantAlign = part.Alignment.HasValue;
        var wantFormat = part.Format != null;
        var extra = (wantAlign ? 1 : 0) + (wantFormat ? 1 : 0);

        System.Reflection.MethodInfo best = null;
        System.Reflection.MethodInfo valueOnly = null;
        foreach (var method in handlerType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            if (method.Name != "AppendFormatted")
            {
                continue;
            }

            var ps = method.GetParameters();
            if (ps.Length == 0)
            {
                continue;
            }

            if (ps.Length == 1 && valueOnly == null)
            {
                valueOnly = method;
            }

            if (ps.Length != 1 + extra)
            {
                continue;
            }

            var ok = true;
            var idx = 1;
            if (wantAlign)
            {
                ok = ps[idx].ParameterType.IsSameAs(typeof(int));
                idx++;
            }

            if (ok && wantFormat)
            {
                ok = ps[idx].ParameterType.IsSameAs(typeof(string));
            }

            if (ok)
            {
                best = method;
                break;
            }
        }

        best ??= valueOnly ?? handlerType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .First(m => m.Name == "AppendFormatted");

        if (best.IsGenericMethodDefinition)
        {
            var typeArg = value?.GetType() ?? typeof(object);
            best = best.MakeGenericMethod(typeArg);
        }

        var args = new System.Collections.Generic.List<object> { value };
        if (wantAlign)
        {
            args.Add(part.Alignment.Value);
        }

        if (wantFormat)
        {
            args.Add(part.Format);
        }

        return InvokeReflective(best, handler, args.ToArray(), node);
    }

    private object EvaluateVariableExpression(BoundVariableExpression v)
    {
        if (v.Variable.Kind == SymbolKind.GlobalVariable)
        {
            return GetGlobal(v.Variable);
        }
        else
        {
            var locals = this.Locals.Peek();
            var stored = locals[v.Variable];

            // Issue #491 (ADR-0060 follow-up): a ref-aliasing local stores a
            // RefAlias sentinel; reads re-evaluate the aliased operand so the
            // local observes the current value of the underlying storage.
            if (stored is RefAlias alias)
            {
                return EvaluateExpression(alias.Operand);
            }

            return stored;
        }
    }

    private object EvaluateAssignmentExpression(BoundAssignmentExpression a)
    {
        var value = EvaluateExpression(a.Expression);
        Assign(a.Variable, value);
        return value;
    }

    private object EvaluateArrayCreationExpression(BoundArrayCreationExpression node)
    {
        var clrType = node.ElementType.ClrType ?? typeof(object);

        // Issue #1016: runtime-length form yields a zero-initialised array.
        if (node.LengthExpression != null)
        {
            var length = System.Convert.ToInt32(EvaluateExpression(node.LengthExpression));
            return System.Array.CreateInstance(clrType, length);
        }

        var array = System.Array.CreateInstance(clrType, node.Elements.Length);
        for (var i = 0; i < node.Elements.Length; i++)
        {
            array.SetValue(EvaluateExpression(node.Elements[i]), i);
        }

        return array;
    }

    // concurrency: ALL interpreter-owned Dictionary access must go through
    // GetMapLock — see MapLocks.
    private object EvaluateMapLiteralExpression(BoundMapLiteralExpression node)
    {
        var keyClr = node.MapType.KeyType.ClrType ?? typeof(object);
        var valClr = node.MapType.ValueType.ClrType ?? typeof(object);

        // Issue #1799 (follow-up to #1718): map literals must stay backed
        // by a real System.Collections.Generic.Dictionary<,> — MapTypeSymbol
        // .ClrType (used both by the binder for CLR-reflection member access
        // like `self.Count`/`.ContainsKey(...)` and by the compiled-emit
        // backend's real IL for `m[k]`/`delete(m, k)`, see
        // MethodBodyEmitter.EmitMapIndexRead/EmitMapDelete) is fixed at
        // Dictionary<,>, and ConcurrentDictionary<,> doesn't even expose the
        // same public surface (e.g. no public Remove(TKey), only
        // TryRemove) — swapping the runtime type here would desync
        // reflection-bound member access from the actual instance and break
        // the compiled backend's method lookups. Thread-safety for the
        // interpreter's own map read/write/delete paths below is instead
        // provided by a lock keyed off the dictionary instance (see
        // <see cref="GetMapLock"/>); insertion behavior, key equality, and
        // iteration order (unspecified by G#, same as real Go maps) are
        // unaffected.
        var dictType = typeof(System.Collections.Generic.Dictionary<,>).MakeGenericType(keyClr, valClr);
        var dict = (System.Collections.IDictionary)System.Activator.CreateInstance(dictType);
        foreach (var entry in node.Entries)
        {
            var k = EvaluateExpression(entry.Key);
            var v = EvaluateExpression(entry.Value);
            dict[k] = v;
        }

        return dict;
    }

    // Returns the shared lock guarding all interpreter-owned access to
    // `dict` (see the <see cref="MapLocks"/> field doc for why maps need
    // this instead of a ConcurrentDictionary swap).
    private static object GetMapLock(object dict) => MapLocks.GetValue(dict, static _ => new object());

    // concurrency: ALL interpreter-owned Dictionary access must go through
    // GetMapLock — see MapLocks. Issue #1799 follow-up: index get/set,
    // delete, and len (above) aren't the only paths into a map's backing
    // Dictionary<,> — `range m`, `m.Count`, `m.ContainsKey(k)`, `m.Keys`,
    // `m.Values`, and any other dot-member access on a map value dispatch
    // through the interpreter's generic CLR-reflection call/property paths
    // (EvaluateImportedInstanceCallExpression / EvaluateClrPropertyAccessExpression),
    // which never touched this lock. Both of those central dispatch points
    // now call this single helper so every reflection-based access to an
    // interpreter-owned map is serialized the same way, instead of scattering
    // per-member special cases.
    private static bool TryGetInterpreterMapLock(object receiver, out object lockObj)
    {
        if (receiver is System.Collections.IDictionary)
        {
            lockObj = GetMapLock(receiver);
            return true;
        }

        lockObj = null;
        return false;
    }

    // Issue #1799 follow-up: `GetEnumerator()`/`Keys`/`Values` normally
    // return a live view over the dictionary's own storage — an enumerator
    // that throws "Collection was modified" on a concurrent write, or a
    // KeyCollection/ValueCollection backed by the same buckets. Neither can
    // be made safe by locking just the call that *produces* them, since the
    // caller keeps using the result (MoveNext/Current, further iteration)
    // long after the lock is released. Instead, clone the dictionary while
    // holding <see cref="GetMapLock"/> and hand back a view over the CLONE:
    // the clone is only ever reachable by the calling goroutine, so no
    // further locking is needed, no concurrent writer can invalidate it, and
    // no deadlock is possible even if the loop body itself writes back to
    // the original map.
    private static System.Collections.IDictionary CloneMapSnapshot(System.Collections.IDictionary dict)
    {
        var clone = (System.Collections.IDictionary)System.Activator.CreateInstance(dict.GetType());
        foreach (System.Collections.DictionaryEntry entry in dict)
        {
            clone[entry.Key] = entry.Value;
        }

        return clone;
    }

    // Member names whose result is a live view over the dictionary rather
    // than a plain value snapshot — these need <see cref="CloneMapSnapshot"/>
    // instead of a direct invoke/get against the real map.
    private static bool IsMapViewMember(string name) =>
        name is "GetEnumerator" or "Keys" or "Values";

    private object EvaluateMapDeleteExpression(BoundMapDeleteExpression node)
    {
        var dict = (System.Collections.IDictionary)EvaluateExpression(node.Map);
        var key = EvaluateExpression(node.Key);
        lock (GetMapLock(dict))
        {
            if (dict.Contains(key))
            {
                dict.Remove(key);
            }
        }

        return null;
    }

    private object EvaluateIndexExpression(BoundIndexExpression node)
    {
        var target = EvaluateExpression(node.Target);

        // Phase 3.A.4: map indexing — return the value, or the Go-style
        // zero value when the key is missing (V?-shaped semantics are
        // deferred to a follow-up that pairs with the two-result form).
        if (node.Target.Type is MapTypeSymbol mapType && target is System.Collections.IDictionary dict)
        {
            var key = EvaluateExpression(node.Index);
            lock (GetMapLock(dict))
            {
                if (dict.Contains(key))
                {
                    return dict[key];
                }
            }

            return DefaultValue(mapType.ValueType);
        }

        // Issue #1129: `s[i]` on a string reads the char at position `i` via
        // the .NET String indexer (`get_Chars`), matching the emit lowering.
        if (node.Target.Type == TypeSymbol.String && target is string str)
        {
            var charIndex = (int)EvaluateExpression(node.Index);
            return str[charIndex];
        }

        var arr = (System.Array)target;
        var index = (int)EvaluateExpression(node.Index);
        return arr.GetValue(index);
    }

    private object EvaluateIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        var targetValue = ResolveReceiverValue(node.TargetExpression, node.Target);
        var targetType = node.TargetExpression?.Type ?? node.Target.Type;

        // Phase 3.A.4: map indexed assignment `m[k] = v`.
        if (targetType is MapTypeSymbol && targetValue is System.Collections.IDictionary dict)
        {
            var key = EvaluateExpression(node.Index);
            var value = EvaluateExpression(node.Value);
            lock (GetMapLock(dict))
            {
                dict[key] = value;
            }

            return value;
        }

        var arr = (System.Array)targetValue;
        var idx = (int)EvaluateExpression(node.Index);
        var v = EvaluateExpression(node.Value);
        arr.SetValue(v, idx);
        return v;
    }

    private object EvaluateLenExpression(BoundLenExpression node)
    {
        var v = EvaluateExpression(node.Operand);
        return v switch
        {
            string s => s.Length,
            System.Array a => a.Length,

            // Issue #1799: `.Count` on a Dictionary<,> is a plain field read
            // with no internal synchronization; take the same per-instance
            // lock as every other interpreter-owned map access so `len(m)`
            // can't observe (or crash on) a torn read during a concurrent
            // `m[k] = v` write from another goroutine.
            System.Collections.IDictionary d => EvaluateMapLen(d),
            _ => throw new EvaluatorException($"len: unsupported operand of CLR type '{v?.GetType()}'.", node),
        };
    }

    private static int EvaluateMapLen(System.Collections.IDictionary dict)
    {
        lock (GetMapLock(dict))
        {
            return dict.Count;
        }
    }

    private static object EvaluateTypeOfExpression(BoundTypeOfExpression node)
    {
        // Issue #143: nullable value types resolve to `System.Nullable<T>`;
        // nullable reference types and every other shape resolve to the
        // operand's ClrType directly.
        if (node.OperandType is NullableTypeSymbol nullable
            && nullable.UnderlyingType.ClrType is { IsValueType: true } valueClr)
        {
            return typeof(System.Nullable<>).MakeGenericType(valueClr);
        }

        return node.OperandType.ClrType ?? typeof(object);
    }

    private object EvaluateCapExpression(BoundCapExpression node)
    {
        var v = EvaluateExpression(node.Operand);
        return v switch
        {
            System.Array a => a.Length,
            _ => throw new EvaluatorException($"cap: unsupported operand of CLR type '{v?.GetType()}'.", node),
        };
    }

    private object EvaluateAppendExpression(BoundAppendExpression node)
    {
        var src = (System.Array)EvaluateExpression(node.Slice);
        var element = EvaluateExpression(node.Element);
        var clrType = node.SliceType.ElementType.ClrType ?? typeof(object);
        var dst = System.Array.CreateInstance(clrType, src.Length + 1);
        System.Array.Copy(src, dst, src.Length);
        dst.SetValue(element, src.Length);
        return dst;
    }

    private object EvaluateBlockExpression(BoundBlockExpression node)
    {
        EvaluateBlockExpressionStatements(node);
        return EvaluateExpression(node.Expression);
    }

    private void EvaluateBlockExpressionStatements(BoundBlockExpression node)
    {
        foreach (var statement in node.Statements)
        {
            if (statement is BoundBlockStatement block)
            {
                EvaluateStatement(block);
                continue;
            }

            if (statement is BoundVariableDeclaration declaration)
            {
                EvaluateVariableDeclaration(declaration);
                continue;
            }

            // Issue #522: object initializer lowering may produce expression
            // statements (`$tmp.Prop = value`) in addition to the synthetic
            // local declaration.
            if (statement is BoundExpressionStatement exprStmt)
            {
                EvaluateExpression(exprStmt.Expression);
                continue;
            }

            // Issue #711 / ADR-0064: when a multi-statement block is used as
            // the branch of an if-expression, the prefix may include any
            // legal statement form — most usefully `throw` and `try`. We
            // delegate to the matching evaluator helpers and let the runtime
            // exception propagate up through the surrounding expression.
            if (statement is BoundThrowStatement throwStmt)
            {
                EvaluateThrowStatement(throwStmt);
                continue;
            }

            if (statement is BoundTryStatement tryStmt)
            {
                EvaluateTryStatement(tryStmt);
                continue;
            }

            throw new EvaluatorException($"Unexpected block-expression statement {statement.Kind}", statement);
        }
    }

    /// <summary>
    /// ADR-0062 / ADR-0064: evaluate a two-arm conditional. Only the chosen
    /// arm is evaluated, matching the emit-side branch semantics. Reused by
    /// both the ternary <c>cond ? a : b</c> and the if-expression form.
    /// </summary>
    /// <param name="node">The bound conditional expression.</param>
    /// <returns>The value of the selected arm.</returns>
    private object EvaluateConditionalExpression(BoundConditionalExpression node)
    {
        var condition = EvaluateExpression(node.Condition);
        return (bool)condition
            ? EvaluateExpression(node.WhenTrue)
            : EvaluateExpression(node.WhenFalse);
    }

    private object EvaluateStructLiteralExpression(BoundStructLiteralExpression node)
    {
        var constructor = node.StructType.EffectiveExplicitConstructors
            .FirstOrDefault(c => c.Function.Parameters.IsDefaultOrEmpty);
        var invokesConstructor = node.StructType.IsClass
            && node.StructType.PrimaryConstructorParameters.IsDefaultOrEmpty
            && (constructor != null || node.StructType.EffectiveExplicitConstructors.IsDefaultOrEmpty);
        var sv = invokesConstructor
            ? (StructValue)EvaluateConstructorCallExpression(
                new BoundConstructorCallExpression(
                    node.Syntax,
                    node.StructType,
                    ImmutableArray<BoundExpression>.Empty,
                    constructor))
            : CreateStructValue(node.StructType);

        // Primary-constructor literals use default construction before applying
        // named initializers, matching the emitter's newobj/stfld sequence.
        if (!invokesConstructor)
        {
            for (var t = node.StructType; t != null; t = t.BaseClass)
            {
                foreach (var f in t.Fields)
                {
                    if (!sv.Fields.ContainsKey(f.Name))
                    {
                        sv.Fields[f.Name] = ClrDefaultValue(f.Type);
                    }
                }
            }

            ApplyClassFieldInitializers(sv, node.StructType);
            if (node.StructType.IsClass)
            {
                AllocateClrBacking(sv, node.StructType, activeInit: null, node: node);
            }
        }

        foreach (var init in node.Initializers)
        {
            // Issue #1211: a composite-literal entry may target a settable
            // property. For an auto-property store into its backing field; for
            // a computed property run the setter body with `this` = sv.
            if (init.Property != null)
            {
                if (init.Property.IsAutoProperty && init.Property.BackingField != null)
                {
                    sv.Fields[init.Property.BackingField.Name] = EvaluateExpression(init.Value);
                }
                else if (init.Property.SetterSymbol != null && program.Functions.TryGetValue(init.Property.SetterSymbol, out var setterBody))
                {
                    var value = EvaluateExpression(init.Value);
                    var frame = new ConcurrentDictionary<Symbols.VariableSymbol, object>
                    {
                        [init.Property.SetterSymbol.ThisParameter] = sv,
                        [init.Property.SetterSymbol.Parameters[0]] = value,
                    };
                    using (PushFrame(frame))
                    {
                        EvaluateFunctionBody(setterBody);
                    }
                }

                continue;
            }

            sv.Fields[init.Field.Name] = EvaluateExpression(init.Value);
        }

        return sv;
    }

    private object EvaluateTupleLiteralExpression(BoundTupleLiteralExpression node)
    {
        // Phase 4.5: build a CLR ValueTuple instance when an arity is supported,
        // else materialise as an object[] (interpreter-only fallback).
        var values = new object[node.Elements.Length];
        for (var i = 0; i < node.Elements.Length; i++)
        {
            values[i] = EvaluateExpression(node.Elements[i]);
        }

        var clrType = node.TupleType.ClrType;
        if (clrType != null)
        {
            return System.Activator.CreateInstance(clrType, values);
        }

        return values;
    }

    private object EvaluateTupleElementAccessExpression(BoundTupleElementAccessExpression node)
    {
        var receiver = EvaluateExpression(node.Receiver);
        if (receiver == null)
        {
            throw new EvaluatorException("Attempted to access an element of a null tuple.", node);
        }

        if (receiver is object[] arr)
        {
            return arr[node.Index];
        }

        var fieldName = $"Item{node.Index + 1}";
        var field = receiver.GetType().GetField(fieldName);
        return field.GetValue(receiver);
    }

    // Issue #1887: reads a tuple's Item1..ItemN element by field name for
    // property-pattern matching over a positional pattern lowering.
    private static object GetTupleFieldValue(object tuple, string fieldName)
    {
        if (tuple is object[] arr)
        {
            var index = int.Parse(fieldName.AsSpan(4), System.Globalization.CultureInfo.InvariantCulture) - 1;
            return arr[index];
        }

        return tuple.GetType().GetField(fieldName)?.GetValue(tuple);
    }

    private object EvaluateFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var captured = new Dictionary<VariableSymbol, object>();
        foreach (var v in node.CapturedVariables)
        {
            captured[v] = LookupVariable(v);
        }

        var body = node.LoweredBody ??= (BoundBlockStatement)Lowering.Lowerer.Lower(node.Body);
        return MaterializeClosure(
            new ClosureValue(
                node.Function,
                body,
                node.FunctionType,
                captured,
                CaptureRuntimeTypeArguments()),
            GetLambdaMethodName(node));
    }

    private object EvaluateMethodGroupExpression(BoundMethodGroupExpression node)
    {
        // Issue #324: a named-function method group behaves like a no-capture
        // closure over the function's own body, so indirect invocation reuses
        // the ClosureValue path.
        //
        // ADR-0112: a user-type instance method group also captures the bound
        // receiver as the implicit `this`, so invoking the delegate dispatches
        // against that instance. Static (shared) groups have no receiver.
        var body = program.Functions[node.Function];
        var captured = new Dictionary<VariableSymbol, object>();
        if (node.Receiver != null && node.Function.ThisParameter != null)
        {
            captured[node.Function.ThisParameter] = EvaluateExpression(node.Receiver);
        }

        return MaterializeClosure(
            new ClosureValue(
                node.Function,
                body,
                node.FunctionType,
                captured,
                CaptureRuntimeTypeArguments(node.Receiver?.Type)),
            node.Function.Name);
    }

    private object EvaluateClrMethodGroupExpression(BoundClrMethodGroupExpression node)
    {
        // Issue #337: materialize the selected CLR overload as a real delegate
        // of the target type. Static groups bind no receiver; instance groups
        // capture the evaluated receiver as the delegate target.
        var delegateType = node.DelegateType?.ClrType
            ?? throw new InvalidOperationException(
                $"CLR method group '{node.MethodName}' was not resolved to a target delegate type.");

        if (node.ResolvedMethod.IsStatic)
        {
            return Delegate.CreateDelegate(delegateType, node.ResolvedMethod);
        }

        var receiver = EvaluateExpression(node.Receiver);
        return Delegate.CreateDelegate(delegateType, receiver, node.ResolvedMethod);
    }

    private object EvaluateIndirectCallExpression(BoundIndirectCallExpression node)
    {
        var targetValue = EvaluateExpression(node.Target);
        if (targetValue == null)
        {
            throw new EvaluatorException("Attempted to invoke a nil function.", node);
        }

        var arguments = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            arguments[i] = EvaluateExpression(node.Arguments[i]);
        }

        if (targetValue is Delegate target)
        {
            if (InterpreterClosures.TryGetValue(target, out var closure))
            {
                return InvokeMaterializedClosure(closure, arguments);
            }

            return InvokeDelegate(target, arguments);
        }

        return InvokeClosure((ClosureValue)targetValue, arguments);
    }

    private object MaterializeClosure(ClosureValue closure, string methodName)
    {
        if (closure.FunctionType.ClrType is not Type delegateType)
        {
            return closure;
        }

        var result = CreateInterpreterDelegate(
            delegateType,
            closure.Function,
            methodName,
            args => InvokeMaterializedClosure(closure, args));
        InterpreterClosures.Add(result, closure);
        return result;
    }

    private static string GetLambdaMethodName(BoundFunctionLiteralExpression node)
    {
        if (node.CapturedVariables.Length != 0
            || (node.Function.LexicalEnclosingType is StructSymbol enclosingType
                && enclosingType.TypeParameters.IsDefaultOrEmpty))
        {
            return "Invoke";
        }

        return node.Function.Name;
    }

    private static Delegate CreateInterpreterDelegate(
        Type delegateType,
        FunctionSymbol function,
        string methodName,
        Func<object[], object> invoke)
        => InterpreterDelegateFactoriesBySite
            .GetValue(function, _ => new ConcurrentDictionary<Type, Func<Func<object[], object>, Delegate>>())
            .GetOrAdd(delegateType, type => BuildInterpreterDelegateFactory(type, methodName))(invoke);

    private static Delegate CreateInterpreterDelegate(Type delegateType, Func<object[], object> invoke)
        => InterpreterDelegateFactories.GetValue(delegateType, BuildInterpreterDelegateFactory)(invoke);

    private static Func<Func<object[], object>, Delegate> BuildInterpreterDelegateFactory(Type delegateType)
        => BuildInterpreterDelegateFactory(delegateType, null);

    private static Func<Func<object[], object>, Delegate> BuildInterpreterDelegateFactory(Type delegateType, string methodName)
    {
        var invokeMethod = delegateType.GetMethod(nameof(Action.Invoke));
        var invokeParameter = System.Linq.Expressions.Expression.Parameter(typeof(Func<object[], object>), "invoke");
        var parameters = invokeMethod.GetParameters()
            .Select(parameter => System.Linq.Expressions.Expression.Parameter(parameter.ParameterType, parameter.Name))
            .ToArray();
        var arguments = System.Linq.Expressions.Expression.NewArrayInit(
            typeof(object),
            parameters.Select(parameter => System.Linq.Expressions.Expression.Convert(parameter, typeof(object))));
        var invocation = System.Linq.Expressions.Expression.Invoke(
            invokeParameter,
            arguments);
        System.Linq.Expressions.Expression body = invokeMethod.ReturnType.IsSameAs(typeof(void))
            ? System.Linq.Expressions.Expression.Block(invocation, System.Linq.Expressions.Expression.Empty())
            : System.Linq.Expressions.Expression.Convert(invocation, invokeMethod.ReturnType);
        var inner = methodName == null
            ? System.Linq.Expressions.Expression.Lambda(delegateType, body, parameters)
            : System.Linq.Expressions.Expression.Lambda(delegateType, body, methodName, parameters);
        return System.Linq.Expressions.Expression.Lambda<Func<Func<object[], object>, Delegate>>(
            inner,
            invokeParameter).Compile();
    }

    private static object InvokeDelegate(Delegate target, object[] arguments)
    {
        try
        {
            return target.DynamicInvoke(arguments);
        }
        catch (TargetInvocationException ex) when (ex.InnerException != null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
    }

    private object InvokeMaterializedClosure(ClosureValue closure, object[] arguments)
        => InvokeClosure(closure, arguments);

    private object InvokeClosure(ClosureValue closure, object[] arguments)
    {
        var frame = new ConcurrentDictionary<VariableSymbol, object>();
        foreach (var kv in closure.CapturedLocals)
        {
            frame[kv.Key] = kv.Value;
        }

        for (var i = 0; i < arguments.Length; i++)
        {
            frame[closure.Function.Parameters[i]] = arguments[i];
        }

        RegisterRuntimeTypeArguments(frame, closure.CapturedTypeArguments);
        using (PushFrame(frame))
        {
            return EvaluateUserMethodBody(closure.Function, closure.Body);
        }
    }

    private object LookupVariable(VariableSymbol v)
    {
        if (v is GlobalVariableSymbol)
        {
            return TryGetGlobal(v, out var g) ? g : null;
        }

        foreach (var frame in this.Locals)
        {
            if (frame.TryGetValue(v, out var value))
            {
                return value;
            }
        }

        return TryGetGlobal(v, out var gv) ? gv : null;
    }

    // Rubber-duck follow-up to issue #2224: an anonymous-class literal's
    // primary-ctor parameter matches a get-only auto-property, not a plain
    // field (see AnonymousTypeCache), so its runtime storage in StructValue
    // lives under the property's backing-field name, not the property name
    // itself. Ordinary classes/data-structs keep Fields non-empty and this
    // resolves to the same name unchanged.
    private static string PrimaryCtorStorageFieldName(StructSymbol type, string paramName)
    {
        return Emit.ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(type, paramName, out var field)
            ? field.Name
            : paramName;
    }

    private object EvaluateConstructorCallExpression(BoundConstructorCallExpression node)
    {
        var argumentValues = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            argumentValues[i] = EvaluateExpression(node.Arguments[i]);
        }

        EnsureStaticTypeInitialized(node.StructType);
        var sv = CreateStructValue(node.StructType);

        // Default-initialize all fields first (including inherited), then bind primary-ctor args.
        for (var t = node.StructType; t != null; t = t.BaseClass)
        {
            foreach (var f in t.Fields)
            {
                if (!sv.Fields.ContainsKey(f.Name))
                {
                    sv.Fields[f.Name] = ClrDefaultValue(f.Type);
                }
            }
        }

        ApplyClassFieldInitializers(sv, node.StructType);

        // Issue #306: a class declaring an explicit `init(...)` constructor runs
        // its bound body with `this`, the constructor parameters, and the class
        // fields in scope. The base initializer (when GSharp) is forwarded first,
        // mirroring `ldarg.0; <base args>; call base..ctor` in the emitter.
        // ADR-0063 §9: when call-site overload resolution selected a specific
        // ctor overload, use it; otherwise fall back to the legacy single-ctor.
        var explicitCtor = node.SelectedConstructor ?? node.StructType.ExplicitConstructor;
        if (explicitCtor != null)
        {
            // ADR-0065 §5: a synthesized primary-ctor designated init has no
            // user-authored body in `program.Functions`. Materialize it on
            // the fly: assign each primary-ctor parameter to its same-named
            // field, then fall through to base-init / CLR-allocation handling
            // by reusing the primary-ctor path below.
            if (explicitCtor.IsSynthesizedFromPrimaryConstructor)
            {
                var primaryParams = node.StructType.PrimaryConstructorParameters;
                for (var i = 0; i < primaryParams.Length; i++)
                {
                    sv.Fields[PrimaryCtorStorageFieldName(node.StructType, primaryParams[i].Name)] = argumentValues[i];
                }

                // Forward an explicit class-level base initializer if present
                // (the synthesized primary mirrors the original primary-ctor shape).
                var baseInitOnStruct = node.StructType.BaseConstructorInitializer;
                if (baseInitOnStruct != null
                    && baseInitOnStruct.GSharpBaseType is StructSymbol gsBase)
                {
                    var frame = new ConcurrentDictionary<VariableSymbol, object>();
                    for (var i = 0; i < primaryParams.Length; i++)
                    {
                        frame[primaryParams[i]] = sv.Fields[PrimaryCtorStorageFieldName(node.StructType, primaryParams[i].Name)];
                    }

                    using (PushFrame(frame))
                    {
                        var baseParams = gsBase.PrimaryConstructorParameters;
                        for (var i = 0; i < baseParams.Length && i < baseInitOnStruct.Arguments.Length; i++)
                        {
                            sv.Fields[PrimaryCtorStorageFieldName(gsBase, baseParams[i].Name)] = EvaluateExpression(baseInitOnStruct.Arguments[i]);
                        }
                    }
                }

                AllocateClrBacking(sv, node.StructType, baseInitOnStruct, node);
                return sv;
            }

            var ctorFunction = explicitCtor.Function;
            var frame2 = new ConcurrentDictionary<VariableSymbol, object>
            {
                [ctorFunction.ThisParameter] = sv,
            };

            for (var i = 0; i < ctorFunction.Parameters.Length; i++)
            {
                frame2[ctorFunction.Parameters[i]] = argumentValues[i];
            }

            using (PushFrame(frame2))
            {
                // Forward the GSharp base initializer. CLR base initializers are
                // routed through reflection by AllocateClrBacking (issue #319) so
                // inherited CLR instance state is observable under interpretation.
                if (explicitCtor.BaseInitializer is BaseConstructorInitializer ctorBaseInit
                    && ctorBaseInit.GSharpBaseType is StructSymbol ctorGsharpBase)
                {
                    var baseParams = ctorGsharpBase.PrimaryConstructorParameters;
                    for (var i = 0; i < baseParams.Length && i < ctorBaseInit.Arguments.Length; i++)
                    {
                        sv.Fields[PrimaryCtorStorageFieldName(ctorGsharpBase, baseParams[i].Name)] = EvaluateExpression(ctorBaseInit.Arguments[i]);
                    }
                }

                AllocateClrBacking(sv, node.StructType, explicitCtor.BaseInitializer, node);

                var body = program.Functions[ctorFunction];
                EvaluateFunctionBody(body);
            }

            return sv;
        }

        var parameters = node.StructType.PrimaryConstructorParameters;
        for (var i = 0; i < parameters.Length; i++)
        {
            sv.Fields[PrimaryCtorStorageFieldName(node.StructType, parameters[i].Name)] = argumentValues[i];
        }

        // Issue #306: forward an explicit base-constructor initializer to a GSharp
        // base class's primary constructor. The base-ctor arguments may reference
        // this class's primary-constructor parameters, so evaluate them in a frame
        // where those parameters are bound to the just-assigned values.
        var baseInit = node.StructType.BaseConstructorInitializer;
        if (baseInit != null || node.StructType.ImportedBaseType != null
            || HasClrAncestor(node.StructType))
        {
            var frame = new ConcurrentDictionary<VariableSymbol, object>();
            for (var i = 0; i < parameters.Length; i++)
            {
                frame[parameters[i]] = sv.Fields[PrimaryCtorStorageFieldName(node.StructType, parameters[i].Name)];
            }

            using (PushFrame(frame))
            {
                if (baseInit != null && baseInit.GSharpBaseType is StructSymbol gsharpBase)
                {
                    var baseParams = gsharpBase.PrimaryConstructorParameters;
                    for (var i = 0; i < baseParams.Length && i < baseInit.Arguments.Length; i++)
                    {
                        sv.Fields[PrimaryCtorStorageFieldName(gsharpBase, baseParams[i].Name)] = EvaluateExpression(baseInit.Arguments[i]);
                    }
                }

                // Issue #319: instantiate the CLR base instance (when the class
                // ultimately derives from a CLR type) so inherited CLR instance
                // state — such as Exception.Message — is set per the emit path.
                AllocateClrBacking(sv, node.StructType, baseInit, node);
            }
        }

        return sv;
    }

    private void ApplyClassFieldInitializers(StructValue value, StructSymbol type)
    {
        if (!type.IsClass)
        {
            return;
        }

        var hierarchy = new Stack<StructSymbol>();
        for (var current = type; current != null; current = current.BaseClass)
        {
            hierarchy.Push(current);
        }

        while (hierarchy.Count > 0)
        {
            var current = hierarchy.Pop();
            var initializerOwner = current.Definition ?? current;
            foreach (var initializer in initializerOwner.InstanceFieldInitializers)
            {
                value.Fields[initializer.Key.Name] = EvaluateExpression(initializer.Value);
            }
        }
    }

    /// <summary>
    /// Issue #319: instantiate the imported CLR base for a GSharp class instance
    /// when the class ultimately derives from a CLR type, so inherited CLR
    /// instance state (e.g. <see cref="System.Exception.Message"/>) is observable
    /// under the interpreter. Issue #3015: instantiate a runtime-derived proxy
    /// rather than the imported base itself so inherited virtual dispatch also
    /// observes the GSharp class's emitted type identity. The chosen base
    /// constructor mirrors the emit path: the resolved
    /// <see cref="BaseConstructorInitializer.ClrConstructor"/> when the class
    /// declared <c>: Base(args)</c>, otherwise the imported base's accessible
    /// parameterless constructor. The base-ctor argument expressions must be
    /// evaluated within whatever frame the caller has just pushed.
    /// </summary>
    private void AllocateClrBacking(
        StructValue sv,
        StructSymbol structType,
        BaseConstructorInitializer activeInit,
        BoundNode node)
    {
        // If an explicit `: base(args)` targets a CLR constructor, prefer that.
        if (activeInit is { IsClrBase: true } clrInit && clrInit.ClrConstructor != null)
        {
            sv.ClrBacking = InvokeClrCtor(
                structType,
                clrInit.ClrConstructor,
                clrInit.Arguments,
                clrInit.ArgumentRefKinds,
                node);
            return;
        }

        // Otherwise walk the (G#) inheritance chain looking for an ancestor whose
        // immediate base is an imported CLR type, and chain to that type's
        // accessible parameterless constructor. Ancestor base-init args cannot be
        // re-evaluated here (we are not running the ancestor's ctor body), so we
        // intentionally restrict the parameterless path. If a deeper ancestor's
        // : base(args) is required, the explicit/primary-ctor branches above
        // handle it via activeInit.
        for (var t = structType; t != null; t = t.BaseClass)
        {
            if (t.BaseConstructorInitializer is { IsClrBase: true } ancestorInit
                && ancestorInit.ClrConstructor != null
                && t != structType)
            {
                // Deeper ancestor : Base(args) where args reference *its* primary
                // parameters. We cannot evaluate them here without spinning up the
                // ancestor's primary-ctor frame, so leave the CLR backing null.
                return;
            }

            if (t.ImportedBaseType?.ClrType is Type clrBase)
            {
                var parameterless = ResolveParameterlessCtor(clrBase);
                if (parameterless != null)
                {
                    sv.ClrBacking = InvokeClrBackingCtor(structType, parameterless, Array.Empty<object>(), node);
                }

                return;
            }
        }
    }

    /// <summary>Issue #319: invoke a CLR base constructor with the bound G# argument expressions.</summary>
    private object InvokeClrCtor(
        StructSymbol structType,
        ConstructorInfo ctor,
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> argumentRefKinds,
        BoundNode node)
    {
        var args = new object[arguments.Length];
        var refSlots = BuildRefSlots(arguments, argumentRefKinds, args, ctor);
        var instance = InvokeClrBackingCtor(structType, ctor, args, node);
        WriteBackRefSlots(refSlots, args);
        return instance;
    }

    private object InvokeClrBackingCtor(StructSymbol structType, ConstructorInfo baseCtor, object[] args, BoundNode node)
    {
        var clrBase = baseCtor.DeclaringType
            ?? throw new InvalidOperationException("Imported base constructor has no declaring type.");
        var backingType = ClrBackingTypes.GetValue(
            structType,
            _ => CreateClrBackingType(structType, clrBase));
        var parameterTypes = Array.ConvertAll(baseCtor.GetParameters(), static parameter => parameter.ParameterType);
        var proxyCtor = backingType.GetConstructor(parameterTypes)
            ?? throw new InvalidOperationException($"Generated CLR backing type '{backingType.FullName}' has no matching constructor.");
        return InvokeReflective(proxyCtor, null, args, node);
    }

    private static Type CreateClrBackingType(StructSymbol structType, Type clrBase)
    {
        return CreateClrType(
            structType,
            clrBase,
            TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.Sealed,
            emitBaseConstructors: true);
    }

    private static Type CreateClrType(
        StructSymbol structType,
        Type clrBase,
        TypeAttributes attributes,
        bool emitBaseConstructors)
    {
        var module = CreateClrBackingModule();
        var definition = structType.Definition ?? structType;
        var arity = definition.TypeParameters.Length;
        var enclosingTypes = new Stack<StructSymbol>();
        for (var containing = definition.ContainingType as StructSymbol;
             containing != null;
             containing = containing.ContainingType as StructSymbol)
        {
            enclosingTypes.Push(containing.Definition ?? containing);
        }

        var enclosingBuilders = new List<System.Reflection.Emit.TypeBuilder>();
        System.Reflection.Emit.TypeBuilder parentBuilder = null;
        while (enclosingTypes.Count > 0)
        {
            var enclosing = enclosingTypes.Pop();
            var enclosingName = GetClrMetadataTypeName(enclosing);
            var enclosingBuilder = parentBuilder == null
                ? module.DefineType(
                    string.IsNullOrEmpty(structType.PackageName)
                        ? enclosingName
                        : $"{structType.PackageName}.{enclosingName}",
                    TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.Sealed,
                    typeof(object))
                : parentBuilder.DefineNestedType(
                    enclosingName,
                    TypeAttributes.NestedPublic | TypeAttributes.Class | TypeAttributes.Sealed,
                    typeof(object));
            if (enclosing.TypeParameters.Length > 0)
            {
                enclosingBuilder.DefineGenericParameters(enclosing.TypeParameters.Select(static parameter => parameter.Name).ToArray());
            }

            enclosingBuilders.Add(enclosingBuilder);
            parentBuilder = enclosingBuilder;
        }

        var metadataName = GetClrMetadataTypeName(definition);
        var typeBuilder = parentBuilder == null
            ? module.DefineType(
                string.IsNullOrEmpty(structType.PackageName)
                    ? metadataName
                    : $"{structType.PackageName}.{metadataName}",
                attributes,
                clrBase)
            : parentBuilder.DefineNestedType(
                metadataName,
                (attributes & ~TypeAttributes.VisibilityMask) | TypeAttributes.NestedPublic,
                clrBase);
        if (arity > 0)
        {
            typeBuilder.DefineGenericParameters(definition.TypeParameters.Select(static parameter => parameter.Name).ToArray());
        }

        if (emitBaseConstructors)
        {
            foreach (var baseCtor in clrBase.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (!baseCtor.IsPublic && !baseCtor.IsFamily && !baseCtor.IsFamilyOrAssembly)
                {
                    continue;
                }

                var parameterTypes = Array.ConvertAll(baseCtor.GetParameters(), static parameter => parameter.ParameterType);
                var ctorBuilder = typeBuilder.DefineConstructor(
                    MethodAttributes.Public,
                    CallingConventions.Standard,
                    parameterTypes);
                var il = ctorBuilder.GetILGenerator();
                il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
                for (var i = 0; i < parameterTypes.Length; i++)
                {
                    il.Emit(System.Reflection.Emit.OpCodes.Ldarg, i + 1);
                }

                il.Emit(System.Reflection.Emit.OpCodes.Call, baseCtor);
                il.Emit(System.Reflection.Emit.OpCodes.Ret);
            }
        }

        var backingType = typeBuilder.CreateType();
        for (var i = enclosingBuilders.Count - 1; i >= 0; i--)
        {
            enclosingBuilders[i].CreateType();
        }

        if (arity == 0)
        {
            return backingType;
        }

        var typeArguments = new Type[structType.TypeArguments.Length];
        for (var i = 0; i < typeArguments.Length; i++)
        {
            typeArguments[i] = ResolveClrBackingTypeArgument(structType.TypeArguments[i]);
        }

        return backingType.MakeGenericType(typeArguments);
    }

    private static Type ResolveClrBackingTypeArgument(TypeSymbol argument)
    {
        if (argument is NullableTypeSymbol nullable)
        {
            var underlying = ResolveClrBackingTypeArgument(nullable.UnderlyingType);
            return underlying.IsValueType
                ? typeof(Nullable<>).MakeGenericType(underlying)
                : underlying;
        }

        if (argument is ImportedTypeSymbol imported
            && imported.OpenDefinition is Type openDefinition
            && !imported.TypeArguments.IsDefaultOrEmpty)
        {
            try
            {
                return openDefinition.MakeGenericType(
                    imported.TypeArguments.Select(ResolveClrBackingTypeArgument).ToArray());
            }
            catch (ArgumentException)
            {
                return imported.ClrType ?? typeof(object);
            }
        }

        if (argument is SliceTypeSymbol slice)
        {
            return ResolveClrBackingTypeArgument(slice.ElementType).MakeArrayType();
        }

        if (argument is ArrayTypeSymbol array)
        {
            return ResolveClrBackingTypeArgument(array.ElementType).MakeArrayType();
        }

        if (argument.ClrType is Type clrType)
        {
            return clrType;
        }

        if (argument is StructSymbol { IsClass: true } gsharpClass)
        {
            return ClrBackingTypes.GetValue(
                gsharpClass,
                _ => CreateClrBackingType(gsharpClass, FindImportedClrBase(gsharpClass)));
        }

        if (argument is StructSymbol or EnumSymbol)
        {
            return ClrReifiedTypes.GetValue(argument, CreateClrReifiedType);
        }

        return typeof(object);
    }

    private static Type CreateClrReifiedType(TypeSymbol type)
    {
        if (type is EnumSymbol enumType)
        {
            return CreateClrEnumType(enumType);
        }

        var structType = (StructSymbol)type;
        return CreateClrType(
            structType,
            typeof(ValueType),
            TypeAttributes.Public | TypeAttributes.SequentialLayout | TypeAttributes.Sealed,
            emitBaseConstructors: false);
    }

    private static Type FindImportedClrBase(StructSymbol structType)
    {
        for (var type = structType; type != null; type = type.BaseClass)
        {
            if (type.ImportedBaseType?.ClrType is Type importedBase)
            {
                return importedBase;
            }
        }

        return typeof(object);
    }

    private static Type CreateClrEnumType(EnumSymbol enumType)
    {
        var module = CreateClrBackingModule();
        var enumBuilder = module.DefineEnum(
            string.IsNullOrEmpty(enumType.PackageName)
                ? enumType.Name
                : $"{enumType.PackageName}.{enumType.Name}",
            TypeAttributes.Public,
            typeof(int));
        foreach (var member in enumType.Members)
        {
            enumBuilder.DefineLiteral(member.Name, member.Value);
        }

        return enumBuilder.CreateTypeInfo().AsType();
    }

    private static System.Reflection.Emit.ModuleBuilder CreateClrBackingModule()
    {
        var assemblyOrdinal = Interlocked.Increment(ref clrBackingAssemblyOrdinal);
        var assemblyName = new AssemblyName(string.Format(
            System.Globalization.CultureInfo.InvariantCulture,
            "GSharp.Interpreter.ClrBacking.{0}",
            assemblyOrdinal));
        var assembly = System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(
            assemblyName,
            System.Reflection.Emit.AssemblyBuilderAccess.RunAndCollect);
        return assembly.DefineDynamicModule(assemblyName.Name);
    }

    private static string GetClrMetadataTypeName(StructSymbol type)
    {
        return type.TypeParameters.Length == 0
            ? type.Name
            : string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{0}`{1}",
                type.Name,
                type.TypeParameters.Length);
    }

    /// <summary>Issue #319: resolves the imported CLR base's accessible parameterless constructor (matches the emit path's <c>GetImportedBaseDefaultCtorReference</c>).</summary>
    private static ConstructorInfo ResolveParameterlessCtor(Type clrBase)
    {
        foreach (var ctor in clrBase.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (ctor.GetParameters().Length == 0
                && (ctor.IsPublic || ctor.IsFamily || ctor.IsFamilyOrAssembly))
            {
                return ctor;
            }
        }

        return null;
    }

    /// <summary>Issue #319: returns true when any ancestor of <paramref name="structType"/> directly inherits an imported CLR type.</summary>
    private static bool HasClrAncestor(StructSymbol structType)
    {
        for (var t = structType; t != null; t = t.BaseClass)
        {
            if (t.ImportedBaseType?.ClrType != null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #319: unwraps a GSharp class value to its CLR backing instance when
    /// the value carries one. Reflection-based reads/writes/calls against members
    /// declared on an imported CLR base must target the real CLR object, not the
    /// interpreter's <see cref="StructValue"/> field dictionary.
    /// </summary>
    private static object UnwrapClrReceiver(object value)
    {
        return value is StructValue sv && sv.ClrBacking != null ? sv.ClrBacking : value;
    }

    private object EvaluateClrConstructorCallExpression(BoundClrConstructorCallExpression node)
    {
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args, node.Constructor);

        var constructor = ResolveMemberForRuntimeType(node.Constructor, ResolveRuntimeClrType(node.Type));
        var result = InvokeReflective(constructor, null, args, node);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    private object EvaluateClrStaticCallExpression(BoundClrStaticCallExpression node)
    {
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args, node.Method);

        var result = InvokeReflective(node.Method, null, args, node);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    private object EvaluateClrPropertyAccessExpression(BoundClrPropertyAccessExpression node)
    {
        var receiver = node.Receiver == null ? null : EvaluateExpression(node.Receiver);

        // Issue #517: the interpreter represents `T?` as the underlying boxed
        // `T` (or `null`) — boxing a `Nullable<T>` is CLR-special-cased to the
        // same shape, so a reflection `PropertyInfo.GetValue` on
        // `Nullable<T>::Value` cannot recover the slot. Synthesize the
        // semantics directly: `Value` requires `HasValue` and throws the
        // BCL's `InvalidOperationException` otherwise; `HasValue` is a null
        // check on the boxed payload.
        if (TryEvaluateNullableInstanceProperty(node, receiver, out var nullableResult))
        {
            return nullableResult;
        }

        return EvaluateClrMemberAccess(
            node.Member,
            receiver,
            node.Receiver?.Type ?? node.StaticContainerType,
            node);
    }

    private object EvaluateClrMemberAccess(
        System.Reflection.MemberInfo sourceMember,
        object receiver,
        TypeSymbol symbolicReceiverType,
        BoundNode node)
    {
        receiver = UnwrapClrReceiver(receiver);

        // Issue #608: when the receiver is a StructValue (a G# class instance)
        // and the member is from a CLR interface that the class satisfies via a
        // field (the #573/#606 field-satisfies-property contract), reflection
        // cannot invoke the interface property on the StructValue. Route the
        // read through the struct's field dictionary instead.
        if (receiver is StructValue sv && TryReadStructFieldForClrMember(sv, sourceMember, out var fieldValue))
        {
            return fieldValue;
        }

        // Issue #814 / ADR-0084 §L5: mirror ResolveMethodForReceiver for
        // PropertyInfo. `IEnumerator<object>::Current` access against a
        // value-type-element enumerator (e.g. `SZGenericArrayEnumerator<int>`
        // from `int[].GetEnumerator()`) fails because the receiver doesn't
        // implement `IEnumerator<object>`. Route through the matching
        // closed-generic interface on the receiver's runtime type.
        var runtimeType = ResolveRuntimeClrType(symbolicReceiverType);
        var member = ResolvePropertyOrFieldForReceiver(sourceMember, receiver, runtimeType);

        // concurrency: see TryGetInterpreterMapLock — routes `m.Count`,
        // `m.Keys`, `m.Values`, etc. through the same per-map lock as
        // index/delete/len.
        if (TryGetInterpreterMapLock(receiver, out var mapLock))
        {
            lock (mapLock)
            {
                var propReceiver = IsMapViewMember(member.Name)
                    ? CloneMapSnapshot((System.Collections.IDictionary)receiver)
                    : receiver;
                return GetReflective(member, propReceiver, index: null, node: node);
            }
        }

        return GetReflective(member, receiver, index: null, node: node);
    }

    private System.Reflection.MemberInfo ResolvePropertyOrFieldForReceiver(System.Reflection.MemberInfo member, object receiver, Type symbolicReceiverType)
    {
        if (receiver == null || member == null)
        {
            return ResolveMemberForRuntimeType(member, symbolicReceiverType);
        }

        member = ResolveMemberForRuntimeType(member, symbolicReceiverType);
        var declaring = member.DeclaringType;
        if (declaring == null || declaring.IsAssignableFrom(receiver.GetType()))
        {
            return member;
        }

        var receiverType = receiver.GetType();

        if (declaring.IsGenericType)
        {
            var openDecl = declaring.GetGenericTypeDefinition();
            foreach (var iface in receiverType.GetInterfaces())
            {
                if (!iface.IsGenericType || iface.GetGenericTypeDefinition() != openDecl)
                {
                    continue;
                }

                System.Reflection.MemberInfo candidate = member.MemberType switch
                {
                    System.Reflection.MemberTypes.Property => iface.GetProperty(member.Name),
                    System.Reflection.MemberTypes.Field => iface.GetField(member.Name),
                    _ => null,
                };
                if (candidate != null)
                {
                    return candidate;
                }
            }
        }

        return member;
    }

    // Issue #517: matches `Nullable<T>::get_Value` / `get_HasValue` against
    // the interpreter's underlying-or-null representation of a nullable.
    // Returns `false` for any non-Nullable receiver (including fields, which
    // the binder never routes through Nullable<T>'s member surface).
    private static bool TryEvaluateNullableInstanceProperty(
        BoundClrPropertyAccessExpression node,
        object receiver,
        out object result)
    {
        result = null;
        if (node.Member is not System.Reflection.PropertyInfo prop)
        {
            return false;
        }

        var declaring = prop.DeclaringType;
        if (declaring == null || !declaring.IsGenericType
            || declaring.GetGenericTypeDefinition().FullName != "System.Nullable`1")
        {
            return false;
        }

        switch (prop.Name)
        {
            case "Value":
                if (receiver == null)
                {
                    throw new System.InvalidOperationException("Nullable object must have a value.");
                }

                result = receiver;
                return true;
            case "HasValue":
                result = receiver != null;
                return true;
            default:
                return false;
        }
    }

    // Issue #608: when the receiver is a G# StructValue (a class that satisfies a
    // CLR interface property contract via a field — the #573/#606 shape), reflection
    // cannot invoke the interface PropertyInfo.GetValue on the StructValue. Detect
    // this case by matching the CLR member name against the struct's field dictionary.
    private static bool TryReadStructFieldForClrMember(StructValue sv, System.Reflection.MemberInfo member, out object value)
    {
        value = null;
        var fieldName = member.Name;
        if (sv.Fields.TryGetValue(fieldName, out var stored))
        {
            value = stored;
            return true;
        }

        return false;
    }

    // Issue #608: write counterpart to TryReadStructFieldForClrMember.
    private static bool TryWriteStructFieldForClrMember(StructValue sv, System.Reflection.MemberInfo member, object value)
    {
        var fieldName = member.Name;
        if (sv.Fields.ContainsKey(fieldName))
        {
            sv.Fields[fieldName] = value;
            return true;
        }

        return false;
    }

    private object EvaluateClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
    {
        var receiver = node.Receiver == null ? null : EvaluateExpression(node.Receiver);
        receiver = UnwrapClrReceiver(receiver);
        var value = EvaluateExpression(node.Value);
        var member = ResolveMemberForRuntimeType(
            node.Member,
            ResolveRuntimeClrType(node.Receiver?.Type ?? node.StaticContainerType));

        // Issue #608: when the receiver is a StructValue (G# class instance)
        // and the member is from a CLR interface satisfied by a field, route the
        // write through the struct's field dictionary.
        if (receiver is StructValue sv && TryWriteStructFieldForClrMember(sv, member, value))
        {
            return value;
        }

        SetReflective(member, receiver, value, index: null, node: node);

        return value;
    }

    private object EvaluateClrEventSubscriptionExpression(BoundClrEventSubscriptionExpression node)
    {
        var receiver = node.Receiver == null ? null : EvaluateExpression(node.Receiver);
        receiver = UnwrapClrReceiver(receiver);
        var handlerValue = EvaluateExpression(node.Handler);
        var handler = handlerValue as Delegate;
        if (handler != null
            && node.Event.EventHandlerType != null
            && !node.Event.EventHandlerType.IsAssignableFrom(handler.GetType()))
        {
            handler = Delegate.CreateDelegate(node.Event.EventHandlerType, handler.Target, handler.Method);
        }

        if (node.IsAdd)
        {
            node.Event.AddEventHandler(receiver, handler);
        }
        else
        {
            node.Event.RemoveEventHandler(receiver, handler);
        }

        return null;
    }

    private object EvaluateEventSubscriptionExpression(BoundEventSubscriptionExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);
        var handlerValue = EvaluateExpression(node.Handler) as Delegate;

        // Explicit accessor bodies: execute the bound add/remove body.
        if (!node.Event.IsFieldLike)
        {
            var methodSymbol = node.IsAdd ? node.Event.AddMethodSymbol : node.Event.RemoveMethodSymbol;
            if (methodSymbol != null && program.Functions.TryGetValue(methodSymbol, out var body))
            {
                var frame = new ConcurrentDictionary<Symbols.VariableSymbol, object>();
                if (methodSymbol.ThisParameter != null)
                {
                    frame[methodSymbol.ThisParameter] = receiverValue;
                }

                if (methodSymbol.Parameters.Length > 0)
                {
                    frame[methodSymbol.Parameters[0]] = handlerValue;
                }

                using (PushFrame(frame))
                {
                    EvaluateFunctionBody(body);
                }
            }

            return null;
        }

        // Field-like event: use Delegate.Combine/Remove on the backing field.
        if (receiverValue is StructValue sv && node.Event.BackingField != null)
        {
            var fieldName = node.Event.BackingField.Name;
            var existing = sv.Fields.TryGetValue(fieldName, out var current) ? current as Delegate : null;

            if (node.IsAdd)
            {
                sv.Fields[fieldName] = existing == null ? handlerValue : Delegate.Combine(existing, handlerValue);
            }
            else
            {
                sv.Fields[fieldName] = existing == null ? null : Delegate.Remove(existing, handlerValue);
            }
        }

        return null;
    }

    private object EvaluateClrBinaryOperatorExpression(BoundClrBinaryOperatorExpression node)
    {
        if (node.Function != null)
        {
            var leftValue = EvaluateExpression(node.Left);
            var rightValue = EvaluateExpression(node.Right);
            var leftPresent = leftValue != null;
            var rightPresent = rightValue != null;

            if (node.OperatorKind == SyntaxKind.EqualsEqualsToken)
            {
                if (leftPresent != rightPresent)
                {
                    return false;
                }

                if (!leftPresent)
                {
                    return true;
                }
            }
            else if (node.OperatorKind == SyntaxKind.BangEqualsToken)
            {
                if (leftPresent != rightPresent)
                {
                    return true;
                }

                if (!leftPresent)
                {
                    return false;
                }
            }
            else if (!leftPresent || !rightPresent)
            {
                if (node.OperatorKind is SyntaxKind.LessToken
                    or SyntaxKind.LessOrEqualsToken
                    or SyntaxKind.GreaterToken
                    or SyntaxKind.GreaterOrEqualsToken)
                {
                    return false;
                }

                return null;
            }

            var locals = new ConcurrentDictionary<VariableSymbol, object>();
            locals[node.Function.Parameters[0]] = leftValue;
            locals[node.Function.Parameters[1]] = rightValue;
            using (PushFrame(locals))
            {
                return EvaluateFunctionBody(
                    program.Functions[node.Function],
                    node.Function.Type,
                    node.Function.Declaration?.Identifier.Location);
            }
        }

        var left = EvaluateExpression(node.Left);
        var right = EvaluateExpression(node.Right);
        return InvokeReflective(node.Method, null, new[] { left, right }, node);
    }

    private object EvaluateClrUnaryOperatorExpression(BoundClrUnaryOperatorExpression node)
    {
        var operand = EvaluateExpression(node.Operand);
        return InvokeReflective(node.Method, null, new[] { operand }, node);
    }

    private object EvaluateClrConversionCallExpression(BoundClrConversionCallExpression node)
    {
        var source = EvaluateExpression(node.Source);
        return InvokeReflective(node.Method, null, new[] { source }, node);
    }

    private object EvaluateClrIndexExpression(BoundClrIndexExpression node)
    {
        var target = EvaluateExpression(node.Target);
        var args = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            args[i] = EvaluateExpression(node.Arguments[i]);
        }

        var indexer = ResolveMemberForRuntimeType(node.Indexer, ResolveRuntimeClrType(node.Target.Type));
        return GetReflective(indexer, target, args, node);
    }

    private object EvaluateClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
    {
        var target = ResolveReceiverValue(node.TargetExpression, node.Target);

        var args = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            args[i] = EvaluateExpression(node.Arguments[i]);
        }

        var value = EvaluateExpression(node.Value);
        var targetType = node.TargetExpression?.Type ?? node.Target?.Type;
        var indexer = ResolveMemberForRuntimeType(node.Indexer, ResolveRuntimeClrType(targetType));
        SetReflective(indexer, target, value, args, node);
        return value;
    }

    private object EvaluateFieldAccessExpression(BoundFieldAccessExpression node)
    {
        // Issue #948 / issue #1030: a const field has no runtime storage — its
        // read returns the compile-time constant value (matches the emitter's
        // inlining and covers interface const fields, whose StructType is null).
        if (node.Field.IsConst)
        {
            return node.Field.ConstantValue;
        }

        // ADR-0053: static field access — receiver is null; look up in the
        // static-field storage keyed by (StructType, Field).
        if (node.Receiver == null)
        {
            // Issue #1030: interface static field — keyed per owning interface
            // (per closed construction for a generic interface).
            if (node.InterfaceType != null)
            {
                EnsureStaticTypeInitialized(node.InterfaceType);
                if (TryGetInterfaceStaticField(node.InterfaceType, node.Field, out var ifaceValue))
                {
                    return ifaceValue;
                }

                return ClrDefaultValue(node.Field.Type);
            }

            EnsureStaticTypeInitialized(node.StructType);
            if (TryGetStaticField(node.StructType, node.Field, out var staticValue))
            {
                return staticValue;
            }

            return ClrDefaultValue(node.Field.Type);
        }

        var receiverValue = EvaluateExpression(node.Receiver);
        if (receiverValue is StructValue sv && sv.Fields.TryGetValue(node.Field.Name, out var value))
        {
            return value;
        }

        return ClrDefaultValue(node.Field.Type);
    }

    private object EvaluateFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        // ADR-0053: static field assignment — receiver is null; store in the
        // static-field storage keyed by (StructType, Field).
        if (node.Receiver == null && node.ReceiverExpression == null)
        {
            var value = EvaluateExpression(node.Value);
            if (node.InterfaceType != null)
            {
                EnsureStaticTypeInitialized(node.InterfaceType);
            }
            else
            {
                EnsureStaticTypeInitialized(node.StructType);
            }

            // Issue #1030: interface static field — keyed per owning interface
            // (per closed construction for a generic interface).
            if (node.InterfaceType != null)
            {
                SetInterfaceStaticField(node.InterfaceType, node.Field, value);
                return value;
            }

            SetStaticField(node.StructType, node.Field, value);
            return value;
        }

        var current = ResolveReceiverValue(node.ReceiverExpression, node.Receiver);

        var sv = current as StructValue ?? CreateStructValue(node.StructType);

        // Class types are reference types: mutate the existing instance in
        // place so other references observe the write. Structs preserve
        // Go-style value semantics by writing to a copy.
        if (node.StructType.IsClass)
        {
            if (current == null)
            {
                throw new NullReferenceException();
            }

            var value = EvaluateExpression(node.Value);
            sv.Fields[node.Field.Name] = value;
            return value;
        }
        else
        {
            var copy = sv.Copy();
            var value = EvaluateExpression(node.Value);
            copy.Fields[node.Field.Name] = value;
            if (node.ReceiverExpression != null)
            {
                WriteBackToOperand(node.ReceiverExpression, copy);
            }
            else
            {
                Assign(node.Receiver, copy);
            }

            return value;
        }
    }

    private object ResolveReceiverValue(BoundExpression expression, VariableSymbol receiver)
    {
        if (expression != null)
        {
            return EvaluateExpression(expression);
        }

        return receiver.Kind == Symbols.SymbolKind.GlobalVariable
            ? GetGlobal(receiver)
            : Locals.Peek()[receiver];
    }

    private object EvaluatePropertyAccessExpression(BoundPropertyAccessExpression node)
    {
        // ADR-0053: static property access — receiver is null.
        if (node.Receiver == null)
        {
            EnsureStaticTypeInitialized(node.StructType);
            if (node.Property.IsAutoProperty && node.Property.BackingField != null)
            {
                if (TryGetStaticField(node.StructType, node.Property.BackingField, out var staticValue))
                {
                    return staticValue;
                }
            }
            else if (node.Property.GetterSymbol != null && program.Functions.TryGetValue(node.Property.GetterSymbol, out var staticGetterBody))
            {
                // Issue #263: computed static property getter — no 'this' parameter.
                var frame = new ConcurrentDictionary<Symbols.VariableSymbol, object>();
                using (PushFrame(frame))
                {
                    return EvaluateFunctionBody(
                        staticGetterBody,
                        node.Property.GetterSymbol.Type,
                        node.Property.Declaration?.Identifier.Location);
                }
            }

            return ClrDefaultValue(node.Property.Type);
        }

        var receiverValue = EvaluateExpression(node.Receiver);
        return EvaluateUserPropertyValue(node.Property, receiverValue);
    }

    private object EvaluateUserPropertyValue(PropertySymbol sourceProperty, object receiverValue)
    {
        // Issue #1235 / issue #1068: when the statically-bound property is
        // declared on an interface (or, for a constrained type parameter, on the
        // constraint type), resolve the concrete property implementation from
        // the receiver's runtime type so the read dispatches virtually — the
        // interpreter analogue of `callvirt get_X`. Walking the base chain also
        // honours property overrides.
        var property = sourceProperty;
        if (receiverValue is StructValue concreteSv && concreteSv.StructType != null)
        {
            for (var t = concreteSv.StructType; t != null; t = t.BaseClass)
            {
                Symbols.PropertySymbol concrete = null;
                foreach (var p in t.Properties)
                {
                    if (!p.IsIndexer && p.Name == property.Name)
                    {
                        concrete = p;
                        break;
                    }
                }

                if (concrete != null)
                {
                    property = concrete;
                    break;
                }
            }
        }

        // Auto-property fallback: access backing field directly.
        if (property.IsAutoProperty && property.BackingField != null)
        {
            if (receiverValue is StructValue sv && sv.Fields.TryGetValue(property.BackingField.Name, out var value))
            {
                return value;
            }

            return ClrDefaultValue(property.Type);
        }

        // Computed property: execute the bound getter body.
        if (property.GetterSymbol != null && program.Functions.TryGetValue(property.GetterSymbol, out var getterBody))
        {
            var frame = new ConcurrentDictionary<Symbols.VariableSymbol, object>
            {
                [property.GetterSymbol.ThisParameter] = receiverValue,
            };
            using (PushFrame(frame))
            {
                return EvaluateFunctionBody(
                    getterBody,
                    property.GetterSymbol.Type,
                    property.Declaration?.Identifier.Location);
            }
        }

        return ClrDefaultValue(property.Type);
    }

    private object EvaluatePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        var value = EvaluateExpression(node.Value);
        if (node.Receiver == null)
        {
            EnsureStaticTypeInitialized(node.StructType);
        }

        // Issue #263: static property assignment (receiver is null).
        if (node.Receiver == null)
        {
            if (node.Property.IsAutoProperty && node.Property.BackingField != null)
            {
                SetStaticField(node.StructType, node.Property.BackingField, value);
            }
            else if (node.Property.SetterSymbol != null && program.Functions.TryGetValue(node.Property.SetterSymbol, out var staticSetterBody))
            {
                var frame = new ConcurrentDictionary<Symbols.VariableSymbol, object>
                {
                    [node.Property.SetterSymbol.Parameters[0]] = value,
                };
                using (PushFrame(frame))
                {
                    EvaluateFunctionBody(staticSetterBody);
                }
            }

            return value;
        }

        // Auto-property fallback: store to backing field.
        if (node.Property.IsAutoProperty && node.Property.BackingField != null)
        {
            if (node.Receiver is BoundVariableExpression bve)
            {
                var receiverVar = bve.Variable;
                var current = receiverVar.Kind == Symbols.SymbolKind.GlobalVariable
                    ? GetGlobal(receiverVar)
                    : Locals.Peek()[receiverVar];

                var sv = current as StructValue ?? CreateStructValue(node.StructType);

                if (node.StructType.IsClass)
                {
                    sv.Fields[node.Property.BackingField.Name] = value;
                    if (!ReferenceEquals(sv, current))
                    {
                        Assign(receiverVar, sv);
                    }
                }
                else
                {
                    var copy = sv.Copy();
                    copy.Fields[node.Property.BackingField.Name] = value;
                    Assign(receiverVar, copy);
                }
            }

            return value;
        }

        // Computed property: execute the bound setter body.
        if (node.Property.SetterSymbol != null && program.Functions.TryGetValue(node.Property.SetterSymbol, out var setterBody))
        {
            var receiverValue = EvaluateExpression(node.Receiver);
            var frame = new ConcurrentDictionary<Symbols.VariableSymbol, object>
            {
                [node.Property.SetterSymbol.ThisParameter] = receiverValue,
                [node.Property.SetterSymbol.Parameters[0]] = value,
            };
            using (PushFrame(frame))
            {
                EvaluateFunctionBody(setterBody);
            }

            return value;
        }

        return value;
    }

    private object DefaultValue(Symbols.TypeSymbol type)
        => GetDefaultValue(type, useLanguageStringZero: true);

    private object ClrDefaultValue(Symbols.TypeSymbol type)
        => GetDefaultValue(type, useLanguageStringZero: false);

    private object GetDefaultValue(Symbols.TypeSymbol type, bool useLanguageStringZero)
    {
        // Issue #504/#1652: NullableTypeSymbol.ClrType aliases the underlying
        // type's ClrType (e.g. `int?` reports `typeof(int)`), so it must be
        // special-cased ahead of the value-type fallback below — otherwise
        // `default(int?)` would wrongly become boxed `0` instead of `nil`.
        if (type is Symbols.NullableTypeSymbol)
        {
            return null;
        }

        if (type == Symbols.TypeSymbol.String)
        {
            return useLanguageStringZero ? string.Empty : null;
        }

        // Issue #1652: user-defined enums have no ClrType (they're not emitted
        // to real CLR System.Enum types at interpret time) and their members
        // are bound to raw `int` literals (see EnumMemberSymbol.Value / the
        // BoundLiteralExpression produced in ExpressionBinder.Access.cs) — so
        // a plain boxed `int 0` here already equals `Color.Zero`'s boxed int.
        // Imported enums (real CLR System.Enum types) DO have a ClrType and
        // are handled by the general value-type fallback below via
        // Enum.ToObject (Activator.CreateInstance produces the real enum
        // zero), matching the idiom already used for enum arithmetic results
        // elsewhere in this file (see UnwrapEnumToUnderlying/NumericCoerce).
        if (type is Symbols.EnumSymbol enumType)
        {
            return enumType.ClrType != null ? Enum.ToObject(enumType.ClrType, 0) : 0;
        }

        if (type is Symbols.StructSymbol s)
        {
            if (s.IsClass)
            {
                return null;
            }

            var sv = CreateStructValue(s);
            foreach (var f in s.Fields)
            {
                sv.Fields[f.Name] = GetDefaultValue(f.Type, useLanguageStringZero);
            }

            return sv;
        }

        // Issue #1652: every other value type (bool, all sized/unsigned ints,
        // float32/float64, decimal, char, nint/nuint, and user value structs
        // that slipped through as plain ClrType) gets its real CLR default via
        // Activator.CreateInstance, so the boxed runtime type always matches
        // what the emitter would produce for a V-typed scratch local. Reference
        // types (string handled above, classes, interfaces) and nullable T?
        // correctly fall through to null.
        if (type?.ClrType != null && type.ClrType.IsValueType)
        {
            return Activator.CreateInstance(type.ClrType);
        }

        return null;
    }
}
