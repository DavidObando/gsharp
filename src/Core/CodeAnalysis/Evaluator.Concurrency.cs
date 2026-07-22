// <copyright file="Evaluator.Concurrency.cs" company="GSharp">
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
/// Issue #1361 partial of <see cref="Evaluator"/>: patterns and channels — switch expressions, pattern switch/matching, await, default/type-parameter construction, make-channel, channel send/receive/close, and select.
/// See <c>Evaluator.cs</c> for the root partial (fields, constructor,
/// execution-state accessors, frame management, and the nested state types).
/// </summary>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private object EvaluateSwitchExpression(BoundSwitchExpression node)
    {
        var discriminant = EvaluateExpression(node.Discriminant);
        BoundSwitchExpressionArm defaultArm = null;

        foreach (var arm in node.Arms)
        {
            if (arm.IsDefault)
            {
                defaultArm = arm;
                continue;
            }

            var bindings = new Dictionary<VariableSymbol, object>();
            if (TryMatchPattern(arm.Pattern, discriminant, bindings))
            {
                if (arm.Guard != null
                    && !(bool)EvaluateWithPatternBindings(bindings, () => EvaluateExpression(arm.Guard)))
                {
                    continue;
                }

                return EvaluateWithPatternBindings(bindings, () => EvaluateExpression(arm.Result));
            }
        }

        return EvaluateExpression(defaultArm.Result);
    }

    private void EvaluatePatternSwitchStatement(BoundPatternSwitchStatement node)
    {
        var discriminant = EvaluateExpression(node.Discriminant);
        BoundPatternSwitchArm defaultArm = null;

        foreach (var arm in node.Arms)
        {
            if (arm.IsDefault)
            {
                defaultArm = arm;
                continue;
            }

            var bindings = new Dictionary<VariableSymbol, object>();
            if (TryMatchPattern(arm.Pattern, discriminant, bindings))
            {
                if (arm.Guard != null
                    && !(bool)EvaluateWithPatternBindings(bindings, () => EvaluateExpression(arm.Guard)))
                {
                    continue;
                }

                EvaluateWithPatternBindings(bindings, () => EvaluateStatement((BoundBlockStatement)arm.Body));
                return;
            }
        }

        if (defaultArm != null)
        {
            EvaluateStatement((BoundBlockStatement)defaultArm.Body);
        }
    }

    private object EvaluateWithPatternBindings(Dictionary<VariableSymbol, object> bindings, Func<object> evaluate)
    {
        var frame = Locals.Peek();
        foreach (var binding in bindings)
        {
            frame[binding.Key] = binding.Value;
        }

        try
        {
            return evaluate();
        }
        finally
        {
            foreach (var binding in bindings)
            {
                frame.TryRemove(binding.Key, out _);
            }
        }
    }

    private bool TryMatchPattern(BoundPattern pattern, object value, Dictionary<VariableSymbol, object> outBindings)
    {
        switch (pattern.Kind)
        {
            case BoundNodeKind.ConstantPattern:
                return object.Equals(value, EvaluateExpression(((BoundConstantPattern)pattern).Value));
            case BoundNodeKind.DiscardPattern:
                return true;
            case BoundNodeKind.TypePattern:
                var typePattern = (BoundTypePattern)pattern;
                if (!MatchesType(typePattern.TargetType, value))
                {
                    return false;
                }

                outBindings[typePattern.Variable] = value;
                return true;
            case BoundNodeKind.PropertyPattern:
                var property = (BoundPropertyPattern)pattern;
                if (value is not StructValue sv)
                {
                    // Issue #1887: a positional pattern over a raw tuple lowers
                    // to a property pattern keyed on Item1..ItemN. Tuple values
                    // are CLR ValueTuple instances (arity 2-7) or object[].
                    if (value != null && property.Type is TupleTypeSymbol)
                    {
                        foreach (var tupleField in property.Fields)
                        {
                            var tupleFieldValue = GetTupleFieldValue(value, tupleField.Field.Name);
                            if (!TryMatchPattern(tupleField.Pattern, tupleFieldValue, outBindings))
                            {
                                return false;
                            }
                        }

                        return true;
                    }

                    return false;
                }

                foreach (var field in property.Fields)
                {
                    sv.Fields.TryGetValue(field.Property?.Name ?? field.Field.Name, out var fieldValue);
                    if (!TryMatchPattern(field.Pattern, fieldValue, outBindings))
                    {
                        return false;
                    }
                }

                return true;
            case BoundNodeKind.RelationalPattern:
                var relational = (BoundRelationalPattern)pattern;
                var rhs = EvaluateExpression(relational.Value);
                return EvaluateRelationalPattern(relational.Op.Kind, value, rhs);
            case BoundNodeKind.BinaryPattern:
                var binaryPattern = (BoundBinaryPattern)pattern;
                if (binaryPattern.IsConjunction)
                {
                    // `and`: both must match; right evaluated only if left matched.
                    return TryMatchPattern(binaryPattern.Left, value, outBindings)
                        && TryMatchPattern(binaryPattern.Right, value, outBindings);
                }

                // `or`: short-circuit; right evaluated only if left failed.
                return TryMatchPattern(binaryPattern.Left, value, outBindings)
                    || TryMatchPattern(binaryPattern.Right, value, outBindings);
            case BoundNodeKind.NotPattern:
                // `not P` matches when P does not. Sub-pattern bindings under
                // `not` are forbidden by the binder, so a throwaway bindings
                // dictionary is sufficient and never observed on a match.
                return !TryMatchPattern(((BoundNotPattern)pattern).Pattern, value, new Dictionary<VariableSymbol, object>());
            case BoundNodeKind.ListPattern:
                if (value is not System.Array array)
                {
                    return false;
                }

                var list = (BoundListPattern)pattern;
                var sliceIndex = -1;
                for (var i = 0; i < list.Elements.Length; i++)
                {
                    if (list.Elements[i] is BoundSlicePattern)
                    {
                        sliceIndex = i;
                        break;
                    }
                }

                if (sliceIndex < 0)
                {
                    if (array.Length != list.Elements.Length)
                    {
                        return false;
                    }

                    for (var i = 0; i < list.Elements.Length; i++)
                    {
                        if (!TryMatchPattern(list.Elements[i], array.GetValue(i), outBindings))
                        {
                            return false;
                        }
                    }

                    return true;
                }

                // Issue #1505: slice ("rest") subpattern. Match the fixed prefix
                // from the start and the fixed suffix from the end; bind / match
                // the variable-length middle slice.
                var prefix = sliceIndex;
                var suffix = list.Elements.Length - sliceIndex - 1;
                if (array.Length < prefix + suffix)
                {
                    return false;
                }

                for (var i = 0; i < prefix; i++)
                {
                    if (!TryMatchPattern(list.Elements[i], array.GetValue(i), outBindings))
                    {
                        return false;
                    }
                }

                for (var k = 0; k < suffix; k++)
                {
                    if (!TryMatchPattern(list.Elements[sliceIndex + 1 + k], array.GetValue(array.Length - suffix + k), outBindings))
                    {
                        return false;
                    }
                }

                var slice = (BoundSlicePattern)list.Elements[sliceIndex];
                if (slice.Variable != null || slice.Pattern != null)
                {
                    var count = array.Length - prefix - suffix;
                    var elementClrType = list.ElementType.ClrType ?? typeof(object);
                    var middle = System.Array.CreateInstance(elementClrType, count);
                    System.Array.Copy(array, prefix, middle, 0, count);

                    if (slice.Variable != null)
                    {
                        outBindings[slice.Variable] = middle;
                    }

                    if (slice.Pattern != null && !TryMatchPattern(slice.Pattern, middle, outBindings))
                    {
                        return false;
                    }
                }

                return true;
            default:
                throw new EvaluatorException($"Unexpected pattern node {pattern.Kind}.", pattern);
        }
    }

    private static bool MatchesType(TypeSymbol targetType, object value)
    {
        if (targetType == TypeSymbol.Error || value == null)
        {
            return false;
        }

        // Issue #1923: every GSharp struct/class value is implicitly
        // convertible (boxable) to `object` — an `is object` / `object o`
        // type-test against a struct/class-typed subject always succeeds,
        // exactly like the emitter's `isinst object` (which never fails for
        // a non-null reference). The base-class walk below only chases
        // `StructType`/`BaseClass` links, which never reach the universal
        // `object` top type, so this must be checked first.
        if (targetType == TypeSymbol.Object)
        {
            return true;
        }

        if (value is StructValue sv)
        {
            for (var t = sv.StructType; t != null; t = t.BaseClass)
            {
                if (t == targetType)
                {
                    return true;
                }
            }

            // Issue #319: when a GSharp class carries a CLR backing (because it
            // inherits an imported CLR base), the value's effective runtime type
            // also includes the CLR base hierarchy — `is`/type patterns against
            // those CLR types must succeed.
            if (sv.ClrBacking != null && targetType.ClrType != null
                && targetType.ClrType.IsInstanceOfType(sv.ClrBacking))
            {
                return true;
            }

            return false;
        }

        return targetType.ClrType != null && targetType.ClrType.IsInstanceOfType(value);
    }

    private static bool EvaluateRelationalPattern(BoundBinaryOperatorKind op, object left, object right)
    {
        switch (op)
        {
            case BoundBinaryOperatorKind.Equals:
                return NumericEquals(left, right);
            case BoundBinaryOperatorKind.NotEquals:
                return !NumericEquals(left, right);
            case BoundBinaryOperatorKind.Less:
            case BoundBinaryOperatorKind.LessOrEquals:
            case BoundBinaryOperatorKind.Greater:
            case BoundBinaryOperatorKind.GreaterOrEquals:
                // Issue #1653: this used to hard-cast both operands to `int`,
                // throwing InvalidCastException for any other discriminant
                // width (double, long, uint, char, enum, ...). Route through
                // the same width-aware NumericCompare the binary relational
                // operators use (after unwrapping enum discriminants to their
                // underlying numeric type, mirroring line ~2380) so a pattern
                // comparison matches `<`/`<=`/`>`/`>=` operator semantics and
                // the emitter's unsigned/NaN-aware opcodes (#421).
                var relLeft = UnwrapEnumToUnderlying(left);
                var relRight = UnwrapEnumToUnderlying(right);

                // IEEE 754: every relational comparison against NaN is false.
                // double/float.CompareTo instead sorts NaN as less than any
                // other value, so NaN must be special-cased here to match the
                // emitter's unordered handling rather than NumericCompare.
                if (IsNaN(relLeft) || IsNaN(relRight))
                {
                    return false;
                }

                var cmp = NumericCompare(relLeft, relRight);
                return op switch
                {
                    BoundBinaryOperatorKind.Less => cmp < 0,
                    BoundBinaryOperatorKind.LessOrEquals => cmp <= 0,
                    BoundBinaryOperatorKind.Greater => cmp > 0,
                    _ => cmp >= 0,
                };
            default:
                throw new InvalidOperationException($"Unexpected relational pattern operator {op}.");
        }
    }

    // Issue #1712: object.Equals(double, double) treats NaN as equal to
    // itself (a documented .NET oddity so NaN can be used as a dictionary
    // key / sort key), but IEEE-754 and the emitter's `ceq` opcode say
    // NaN == NaN is false (and != is true). Route float/double equality
    // through the native operators so NaN stays unordered/unequal
    // everywhere; every other type keeps its normal Equals semantics.
    //
    // Issue #2226: the binder's zero-literal enum adaptation boxes the
    // literal `0` as the enum's raw underlying primitive (an `int32`, say),
    // NOT an actual CLR enum instance — the emitter's `EmitLiteral` only
    // knows how to load primitive constants (`ldc.i4` etc.), never a boxed
    // `System.Enum`. That representation matches how a SOURCE-declared G#
    // enum value already evaluates in this tree-walking interpreter (as its
    // raw underlying primitive, see EvaluateNameExpression / enum-member
    // access), but an IMPORTED CLR enum member (e.g. `ConsoleModifiers.None`)
    // evaluates to a real boxed `System.Enum` instance. `object.Equals`
    // between a boxed `System.Enum` and a boxed primitive of the SAME
    // underlying value is `false` (CLR type mismatch), even though C#
    // (and the emitter's `ceq`, which compares by underlying bit pattern)
    // says they are equal. Unwrap either side's `Enum` to its underlying
    // primitive before falling back to `Equals` so an enum value compares
    // correctly against ITS OWN underlying-typed zero (or any other
    // same-typed underlying primitive reaching this path).
    private static bool NumericEquals(object l, object r) => (l, r) switch
    {
        (float lf, float rf) => lf == rf,
        (double ld, double rd) => ld == rd,
        (Enum le, not Enum) => Equals(Convert.ChangeType(le, Enum.GetUnderlyingType(le.GetType()), System.Globalization.CultureInfo.InvariantCulture), r),
        (not Enum, Enum re) => Equals(l, Convert.ChangeType(re, Enum.GetUnderlyingType(re.GetType()), System.Globalization.CultureInfo.InvariantCulture)),
        _ => Equals(l, r),
    };

    private static bool IsNaN(object value) => value switch
    {
        float f => float.IsNaN(f),
        double d => double.IsNaN(d),
        _ => false,
    };

    private object EvaluateAwaitExpression(BoundAwaitExpression node)
    {
        var operand = EvaluateExpression(node.Expression);
        if (operand is Task task)
        {
            task.GetAwaiter().GetResult();

            var taskType = task.GetType();
            if (taskType.IsGenericType)
            {
                var resultProperty = taskType.GetProperty("Result");
                if (resultProperty != null)
                {
                    return resultProperty.GetValue(task);
                }
            }

            return null;
        }

        if (operand == null)
        {
            throw new EvaluatorException("'await' operand did not evaluate to an awaitable.", node);
        }

        // Issue #2280 (parallel to the emitter's generic `AwaitableShape`,
        // which already resolves ANY duck-typed awaitable structurally):
        // this interpreter path previously only recognized `ValueTask`/
        // `ValueTask<T>` by name after the Task fast path above — a shared
        // gap that broke `await` on `ConfiguredTaskAwaitable(<T>)`/
        // `ConfiguredValueTaskAwaitable(<T>)` (returned by
        // `.ConfigureAwait(...)`, including the `MoveNextAsync`/
        // `DisposeAsync` results of a pattern-based `await for` enumerator,
        // see #148's desugaring), and any other fully custom duck-typed
        // awaitable. Resolve via the C# spec's
        // `GetAwaiter()`/`IsCompleted`/`GetResult()` pattern instead of a
        // type-name allowlist; `BlockOnValueTask` already implements that
        // resolution reflectively.
        var operandType = operand.GetType();
        var getAwaiterMethod = operandType.GetMethod("GetAwaiter", Type.EmptyTypes);
        if (getAwaiterMethod == null)
        {
            throw new EvaluatorException("'await' operand did not evaluate to a Task.", node);
        }

        return BlockOnValueTask(operand);
    }

    private static object EvaluateDefaultExpression(BoundDefaultExpression node)
    {
        // Issue #148: the `await for` lowering uses `default(CancellationToken)`
        // for the `GetAsyncEnumerator` token; more generally, BoundDefaultExpression
        // should produce the type's default value when interpreted.
        //
        // ADR-0100 / issue #795: align with the IL emit path. `EmitDefault`
        // produces `ldnull` for reference types (e.g. `string`), zero for
        // primitive value types, and `initobj` for arbitrary value types.
        // The interpreter mirrors this:
        //   - reference types and nullable types → nil
        //   - value types → zero / zeroed struct
        // Prior to ADR-0100 the interpreter returned `""` for
        // `default(string)` (the Go-style zero), which diverged from the
        // compiled behaviour. Both shapes now produce `nil`.

        // Issue #504: a NullableTypeSymbol's default is `nil`, not the
        // underlying type's zero. The binder lowers `nil → Nullable<T>`
        // (value-type) to a BoundDefaultExpression so the emitter can
        // materialise `default(Nullable<T>)` via ldloca/initobj/ldloc; the
        // interpreter must mirror that by producing the absent-value sentinel
        // (null) so `??`, `!!`, and equality checks see a missing value.
        if (node.Type is Symbols.NullableTypeSymbol)
        {
            return null;
        }

        // ADR-0100 / issue #795: reference types (including string) default
        // to nil. This matches `EmitDefault` (which emits `ldnull` for any
        // non-value-type that isn't a generic type parameter) and the C#
        // `default(T)` semantics requested by the issue.
        var clrForRefCheck = node.Type?.ClrType;
        if (clrForRefCheck != null && !clrForRefCheck.IsValueType)
        {
            return null;
        }

        var known = DefaultValue(node.Type);
        if (known != null)
        {
            return known;
        }

        var clr = node.Type?.ClrType;
        if (clr == null || !clr.IsValueType)
        {
            return null;
        }

        return System.Activator.CreateInstance(clr);
    }

    private object EvaluateTypeParameterConstructionExpression(BoundTypeParameterConstructionExpression node)
    {
        // Issue #988: `T()` under a `new()` constraint. The compiled backend
        // lowers this to a reified Activator.CreateInstance<T>(); the tree-walking
        // interpreter has no reified type-parameter binding, so the best it can do
        // is construct a concrete CLR type when the type parameter has already been
        // resolved to one (e.g. a BCL value type). Otherwise the construction is
        // not supported in interpreted mode.
        var clr = node.TypeParameter.ClrType;
        if (clr != null)
        {
            return System.Activator.CreateInstance(clr);
        }

        throw new EvaluatorException(
            $"Construction of type parameter '{node.TypeParameter.Name}()' is only supported by the compiled backend (issue #988).",
            node);
    }

    private object EvaluateMakeChannelExpression(BoundMakeChannelExpression node)
    {
        // Phase 5.4 / ADR-0022: `make(chan T)` → Channel.CreateUnbounded<T>();
        // `make(chan T, capacity)` → Channel.CreateBounded<T>(new BoundedChannelOptions(capacity)).
        var elementClr = node.ChannelType.ElementType.ClrType ?? typeof(object);
        if (node.Capacity == null)
        {
            var unbounded = typeof(Channel)
                .GetMethod(nameof(Channel.CreateUnbounded), BindingFlags.Public | BindingFlags.Static, Type.EmptyTypes);
            return unbounded.MakeGenericMethod(elementClr).Invoke(null, null);
        }

        var capacity = (int)EvaluateExpression(node.Capacity);
        var options = new BoundedChannelOptions(capacity);
        var bounded = typeof(Channel)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == nameof(Channel.CreateBounded)
                && m.IsGenericMethodDefinition
                && m.GetParameters().Length == 1
                && m.GetParameters()[0].ParameterType.IsSameAs(typeof(BoundedChannelOptions)));
        return bounded.MakeGenericMethod(elementClr).Invoke(null, [options]);
    }

    private void EvaluateChannelSendStatement(BoundChannelSendStatement node)
    {
        // Phase 5.5 / ADR-0022: synchronous send. Writes a value into the
        // channel's Writer, blocking the current thread until the write
        // completes. Inside an `async` context we still block here in the
        // interpreter; the async-aware lowering is documented in ADR-0022
        // and lands with the emit pass.
        var channel = EvaluateExpression(node.Channel);
        if (channel == null)
        {
            throw new EvaluatorException("'<-' send on a nil channel.", node);
        }

        var value = EvaluateExpression(node.Value);
        var writer = channel.GetType().GetProperty("Writer").GetValue(channel);
        var writeAsync = writer.GetType().GetMethod("WriteAsync", new[] { writer.GetType().GenericTypeArguments[0], typeof(System.Threading.CancellationToken) });
        var task = (System.Threading.Tasks.ValueTask)writeAsync.Invoke(writer, new[] { value, System.Threading.CancellationToken.None });
        task.AsTask().GetAwaiter().GetResult();
    }

    private object EvaluateChannelReceiveExpression(BoundChannelReceiveExpression node)
    {
        // Phase 5.5 / ADR-0022: synchronous receive. Reads a value from the
        // channel's Reader, blocking until one arrives. If the channel is
        // closed and drained, return the element type's default value
        // (matches Go's `v := <-closedCh` behaviour at the surface).
        var channel = EvaluateExpression(node.Channel);
        if (channel == null)
        {
            throw new EvaluatorException("'<-' receive on a nil channel.", node);
        }

        var reader = channel.GetType().GetProperty("Reader").GetValue(channel);
        var elementType = reader.GetType().GenericTypeArguments[0];
        var readAsync = reader.GetType().GetMethod("ReadAsync", new[] { typeof(System.Threading.CancellationToken) });
        var valueTask = readAsync.Invoke(reader, [System.Threading.CancellationToken.None]);
        var asTask = valueTask.GetType().GetMethod("AsTask").Invoke(valueTask, null);
        try
        {
            ((Task)asTask).GetAwaiter().GetResult();
        }
        catch (ChannelClosedException)
        {
            return elementType.IsValueType ? Activator.CreateInstance(elementType) : null;
        }

        return ((Task)asTask).GetType().GetProperty("Result").GetValue(asTask);
    }

    private object EvaluateChannelCloseExpression(BoundChannelCloseExpression node)
    {
        var channel = EvaluateExpression(node.Channel);
        if (channel == null)
        {
            return null;
        }

        var writer = channel.GetType().GetProperty("Writer").GetValue(channel);
        writer.GetType().GetMethod("Complete", new[] { typeof(Exception) }).Invoke(writer, [null]);
        return null;
    }

    private void EvaluateSelectStatement(BoundSelectStatement node)
    {
        // Phase 5.6 / ADR-0022: orchestrate a set of channel sends/receives,
        // optionally with a default arm.
        //
        // Strategy:
        // - Snapshot each non-default arm's channel value once (so a stateful
        //   channel expression like `make(chan int)` isn't re-evaluated each
        //   wakeup).
        // - Loop: for each arm in source order, try a non-blocking
        //   TryRead / TryWrite. If any succeeds, run that arm and return.
        //   Else, if a default arm exists, run it and return.
        //   Otherwise, build a WaitToReadAsync / WaitToWriteAsync task per
        //   arm and block on Task.WhenAny, then re-loop.
        var channels = new object[node.Cases.Length];
        for (var i = 0; i < node.Cases.Length; i++)
        {
            if (node.Cases[i].Channel != null)
            {
                channels[i] = EvaluateExpression(node.Cases[i].Channel);
            }
        }

        var defaultIndex = -1;
        for (var i = 0; i < node.Cases.Length; i++)
        {
            if (node.Cases[i].IsDefault)
            {
                defaultIndex = i;
                break;
            }
        }

        while (true)
        {
            for (var i = 0; i < node.Cases.Length; i++)
            {
                var arm = node.Cases[i];
                if (arm.IsDefault)
                {
                    continue;
                }

                if (TryRunSelectArm(arm, channels[i]))
                {
                    return;
                }
            }

            if (defaultIndex >= 0)
            {
                EvaluateStatement((BoundBlockStatement)node.Cases[defaultIndex].Body);
                return;
            }

            // Build per-arm wait tasks and block on the first to become ready.
            var waits = new List<Task>();
            for (var i = 0; i < node.Cases.Length; i++)
            {
                var arm = node.Cases[i];
                if (arm.IsDefault)
                {
                    continue;
                }

                waits.Add(BuildSelectWaitTask(arm, channels[i]));
            }

            Task.WhenAny(waits).GetAwaiter().GetResult();

            // Loop and re-try in source order. If we lose every race we
            // simply wait again — this preserves fairness without livelocking
            // because progress on any channel surfaces through WaitToRead/Write.
        }
    }

    private bool TryRunSelectArm(BoundSelectCase arm, object channel)
    {
        var elementType = channel.GetType().GenericTypeArguments[0];

        if (arm.CaseKind == SelectCaseKind.Send)
        {
            var writer = channel.GetType().GetProperty("Writer").GetValue(channel);
            var tryWrite = writer.GetType().GetMethod("TryWrite", new[] { elementType });
            if (tryWrite == null)
            {
                return false;
            }

            var value = EvaluateExpression(arm.Value);
            var ok = (bool)tryWrite.Invoke(writer, new[] { value });
            if (!ok)
            {
                return false;
            }

            EvaluateStatement((BoundBlockStatement)arm.Body);
            return true;
        }

        // Receive (discard or bind).
        var reader = channel.GetType().GetProperty("Reader").GetValue(channel);
        var tryRead = reader.GetType().GetMethod("TryRead");
        var args = new object[] { null };
        var got = (bool)tryRead.Invoke(reader, args);
        if (!got)
        {
            // Drained-closed channels also surface receive-readiness through
            // WaitToReadAsync returning false. Detect "closed and empty" by
            // peeking at Completion; if completed, the receive should produce
            // the element's zero value (matches Go's `v := <-closedCh`).
            var completionTask = (Task)reader.GetType().GetProperty("Completion").GetValue(reader);
            if (!completionTask.IsCompleted)
            {
                return false;
            }

            args[0] = elementType.IsValueType ? Activator.CreateInstance(elementType) : null;
        }

        if (arm.CaseKind == SelectCaseKind.ReceiveBind)
        {
            Assign(arm.Variable, args[0]);
        }

        EvaluateStatement((BoundBlockStatement)arm.Body);
        return true;
    }

    private static Task BuildSelectWaitTask(BoundSelectCase arm, object channel)
    {
        if (arm.CaseKind == SelectCaseKind.Send)
        {
            var writer = channel.GetType().GetProperty("Writer").GetValue(channel);
            var waitToWrite = writer.GetType().GetMethod("WaitToWriteAsync", new[] { typeof(System.Threading.CancellationToken) });
            var vt = waitToWrite.Invoke(writer, [System.Threading.CancellationToken.None]);
            return (Task)vt.GetType().GetMethod("AsTask").Invoke(vt, null);
        }

        var reader = channel.GetType().GetProperty("Reader").GetValue(channel);
        var waitToRead = reader.GetType().GetMethod("WaitToReadAsync", new[] { typeof(System.Threading.CancellationToken) });
        var vt2 = waitToRead.Invoke(reader, [System.Threading.CancellationToken.None]);
        return (Task)vt2.GetType().GetMethod("AsTask").Invoke(vt2, null);
    }
}
