// <copyright file="Evaluator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Threading.Channels;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Program evaluator.
/// </summary>
public sealed class Evaluator
{
    private readonly BoundProgram program;
    private readonly Dictionary<VariableSymbol, object> globals;
    private readonly Stack<Dictionary<VariableSymbol, object>> locals = new Stack<Dictionary<VariableSymbol, object>>();
    private readonly object goLock = new object();
    private readonly Stack<ScopeFrame> scopeFrames = new Stack<ScopeFrame>();
    private readonly Stack<System.Collections.IList> iteratorSinks = new Stack<System.Collections.IList>();
    private readonly Dictionary<Symbols.FunctionSymbol, bool> iteratorFunctionCache = new Dictionary<Symbols.FunctionSymbol, bool>();
    private Random random;

    private object lastValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="Evaluator"/> class.
    /// </summary>
    /// <param name="program">The program.</param>
    /// <param name="variables">The variables.</param>
    public Evaluator(BoundProgram program, Dictionary<VariableSymbol, object> variables)
    {
        this.program = program;
        globals = variables;
        locals.Push(new Dictionary<VariableSymbol, object>());
    }

    /// <summary>
    /// Evaluates the program and returns the evaluated result.
    /// </summary>
    /// <returns>The evaluation result.</returns>
    public object Evaluate()
    {
        return EvaluateStatement(program.Statement);
    }

    private object EvaluateStatement(BoundBlockStatement body)
    {
        var labelToIndex = new Dictionary<BoundLabel, int>();

        for (var i = 0; i < body.Statements.Length; i++)
        {
            if (body.Statements[i] is BoundLabelStatement l)
            {
                labelToIndex.Add(l.Label, i + 1);
            }
        }

        var index = 0;

        while (index < body.Statements.Length)
        {
            var s = body.Statements[index];

            switch (s.Kind)
            {
                case BoundNodeKind.VariableDeclaration:
                    EvaluateVariableDeclaration((BoundVariableDeclaration)s);
                    index++;
                    break;
                case BoundNodeKind.ExpressionStatement:
                    EvaluateExpressionStatement((BoundExpressionStatement)s);
                    index++;
                    break;
                case BoundNodeKind.GotoStatement:
                    var gs = (BoundGotoStatement)s;
                    index = labelToIndex[gs.Label];
                    break;
                case BoundNodeKind.ConditionalGotoStatement:
                    var cgs = (BoundConditionalGotoStatement)s;
                    var condition = (bool)EvaluateExpression(cgs.Condition);
                    if (condition == cgs.JumpIfTrue)
                    {
                        index = labelToIndex[cgs.Label];
                    }
                    else
                    {
                        index++;
                    }

                    break;
                case BoundNodeKind.LabelStatement:
                    index++;
                    break;
                case BoundNodeKind.ReturnStatement:
                    var rs = (BoundReturnStatement)s;
                    lastValue = rs.Expression == null ? null : EvaluateExpression(rs.Expression);
                    return lastValue;
                case BoundNodeKind.TryStatement:
                    EvaluateTryStatement((BoundTryStatement)s);
                    index++;
                    break;
                case BoundNodeKind.ThrowStatement:
                    EvaluateThrowStatement((BoundThrowStatement)s);
                    break;
                case BoundNodeKind.PatternSwitchStatement:
                    EvaluatePatternSwitchStatement((BoundPatternSwitchStatement)s);
                    index++;
                    break;
                case BoundNodeKind.GoStatement:
                    EvaluateGoStatement((BoundGoStatement)s);
                    index++;
                    break;
                case BoundNodeKind.ChannelSendStatement:
                    EvaluateChannelSendStatement((BoundChannelSendStatement)s);
                    index++;
                    break;
                case BoundNodeKind.SelectStatement:
                    EvaluateSelectStatement((BoundSelectStatement)s);
                    index++;
                    break;
                case BoundNodeKind.ScopeStatement:
                    EvaluateScopeStatement((BoundScopeStatement)s);
                    index++;
                    break;
                case BoundNodeKind.AwaitForRangeStatement:
                    EvaluateAwaitForRangeStatement((BoundAwaitForRangeStatement)s);
                    index++;
                    break;
                case BoundNodeKind.YieldStatement:
                    EvaluateYieldStatement((BoundYieldStatement)s);
                    index++;
                    break;
                default:
                    throw new EvaluatorException($"Unexpected node {s.Kind}", s);
            }
        }

        return lastValue;
    }

    private void EvaluateVariableDeclaration(BoundVariableDeclaration node)
    {
        var value = EvaluateExpression(node.Initializer);
        lastValue = value;
        Assign(node.Variable, value);
    }

    private void EvaluateGoStatement(BoundGoStatement node)
    {
        // Phase 5.3 / ADR-0022: fire-and-forget Task.Run by default. The
        // interpreter's evaluation state is single-threaded; serialize body
        // execution with a monitor on the evaluator so the shared
        // locals/globals stacks remain consistent. Concurrency in the
        // interpreter is observational (Task scheduling) rather than parallel.
        //
        // Phase 5.7 / ADR-0022: when this `go` is lexically inside a `scope`,
        // register the resulting Task with the innermost scope frame so it can
        // be awaited at scope exit. Exceptions are not swallowed in that case;
        // the scope propagates them.
        var expression = node.Expression;
        var enclosingScope = scopeFrames.Count > 0 ? scopeFrames.Peek() : null;
        if (enclosingScope != null)
        {
            var task = Task.Run(() =>
            {
                lock (this.goLock)
                {
                    EvaluateExpression(expression);
                }
            });
            enclosingScope.Tasks.Add(task);
            return;
        }

        Task.Run(() =>
        {
            try
            {
                lock (this.goLock)
                {
                    EvaluateExpression(expression);
                }
            }
            catch
            {
                // Per ADR-0022 fire-and-forget: unhandled exceptions surface
                // through TaskScheduler.UnobservedTaskException; the interpreter
                // discards them rather than crashing the host.
            }
        });
    }

    private void EvaluateScopeStatement(BoundScopeStatement node)
    {
        // Phase 5.7 / ADR-0022: structured concurrency. Spawned `go` tasks
        // inside the body register with the frame we just pushed; the
        // body runs to completion, then we await all registered tasks.
        // First failure wins (rethrown); the remaining failures, if any,
        // are attached as AggregateException.InnerExceptions[1..].
        var frame = new ScopeFrame();
        scopeFrames.Push(frame);
        try
        {
            EvaluateStatement((BoundBlockStatement)node.Body);
        }
        finally
        {
            scopeFrames.Pop();
        }

        if (frame.Tasks.Count == 0)
        {
            return;
        }

        try
        {
            Task.WhenAll(frame.Tasks).GetAwaiter().GetResult();
        }
        catch
        {
            // On any failure, signal the scope's cancellation token so
            // cooperating tasks can short-circuit. The `ctx` source binding
            // that exposes this CTS to user code is deferred.
            try
            {
                frame.Cts.Cancel();
            }
            catch
            {
                // Cancellation callbacks must not mask the original failure.
            }

            // Collect every failure for the AggregateException tail and
            // rethrow the first one in source-completion order.
            var failures = new List<Exception>();
            foreach (var t in frame.Tasks)
            {
                if (t.IsFaulted && t.Exception != null)
                {
                    foreach (var inner in t.Exception.InnerExceptions)
                    {
                        failures.Add(inner);
                    }
                }
            }

            if (failures.Count == 1)
            {
                throw failures[0];
            }

            if (failures.Count > 1)
            {
                throw new AggregateException(failures);
            }

            throw;
        }
    }

    private void EvaluateAwaitForRangeStatement(BoundAwaitForRangeStatement node)
    {
        // Phase 5.8 / ADR-0023: `await for v := range stream { … }`. The
        // interpreter realizes each underlying `MoveNextAsync` /
        // `DisposeAsync` synchronously via `GetAwaiter().GetResult()` —
        // the same pragma Phase 5.1 uses for `await`. Per ADR-0023, when
        // we are lexically inside a `scope { … }` we plumb the scope's
        // cancellation token into `GetAsyncEnumerator`; otherwise we
        // pass `CancellationToken.None`.
        var stream = EvaluateExpression(node.Stream);
        if (stream == null)
        {
            throw new EvaluatorException("'await for' stream evaluated to null.", node);
        }

        var streamType = stream.GetType();
        Type asyncEnumerableInterface = null;
        foreach (var iface in streamType.GetInterfaces())
        {
            if (iface.IsGenericType &&
                iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
            {
                asyncEnumerableInterface = iface;
                break;
            }
        }

        if (asyncEnumerableInterface == null && streamType.IsGenericType &&
            streamType.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
        {
            asyncEnumerableInterface = streamType;
        }

        if (asyncEnumerableInterface == null)
        {
            throw new EvaluatorException(
                $"'await for' operand of CLR type '{streamType}' does not implement IAsyncEnumerable<T>.",
                node);
        }

        var cancellationToken = scopeFrames.Count > 0
            ? scopeFrames.Peek().Cts.Token
            : System.Threading.CancellationToken.None;

        var getEnumerator = asyncEnumerableInterface.GetMethod(
            "GetAsyncEnumerator",
            new[] { typeof(System.Threading.CancellationToken) });
        var enumerator = getEnumerator.Invoke(stream, new object[] { cancellationToken });
        if (enumerator == null)
        {
            throw new EvaluatorException("'await for' GetAsyncEnumerator returned null.", node);
        }

        var enumeratorInterface = typeof(System.Collections.Generic.IAsyncEnumerator<>)
            .MakeGenericType(asyncEnumerableInterface.GetGenericArguments()[0]);
        var moveNextAsync = enumeratorInterface.GetMethod("MoveNextAsync", Type.EmptyTypes);
        var currentProperty = enumeratorInterface.GetProperty("Current");
        var disposeAsync = typeof(System.IAsyncDisposable).GetMethod("DisposeAsync", Type.EmptyTypes);

        try
        {
            while (true)
            {
                var moveNextTask = moveNextAsync.Invoke(enumerator, null);
                var hasMore = (bool)BlockOnValueTask(moveNextTask);
                if (!hasMore)
                {
                    break;
                }

                var current = currentProperty.GetValue(enumerator);
                Assign(node.ValueVariable, current);
                EvaluateStatement((BoundBlockStatement)node.Body);
            }
        }
        finally
        {
            if (disposeAsync != null)
            {
                var disposeTask = disposeAsync.Invoke(enumerator, null);
                BlockOnValueTask(disposeTask);
            }
        }
    }

    private static object BlockOnValueTask(object valueTask)
    {
        // Works uniformly for `Task`, `Task<T>`, `ValueTask`, and
        // `ValueTask<T>`. ValueTask awaiters cannot be polled
        // synchronously for an incomplete task — convert via `AsTask()`
        // when available so the underlying `Task` awaiter is the one we
        // call `GetResult()` on. Matches Phase 5.1's `await` pragma.
        if (valueTask == null)
        {
            return null;
        }

        var type = valueTask.GetType();
        var asTask = type.GetMethod("AsTask", Type.EmptyTypes);
        object awaitable = asTask != null ? asTask.Invoke(valueTask, null) : valueTask;
        if (awaitable == null)
        {
            return null;
        }

        var awaiter = awaitable.GetType().GetMethod("GetAwaiter", Type.EmptyTypes)?.Invoke(awaitable, null);
        if (awaiter == null)
        {
            return null;
        }

        var getResult = awaiter.GetType().GetMethod("GetResult", Type.EmptyTypes);
        try
        {
            return getResult?.Invoke(awaiter, null);
        }
        catch (TargetInvocationException tie) when (tie.InnerException != null)
        {
            throw tie.InnerException;
        }
    }

    private void EvaluateExpressionStatement(BoundExpressionStatement node)
    {
        lastValue = EvaluateExpression(node.Expression);
    }

    private void EvaluateTryStatement(BoundTryStatement node)
    {
        try
        {
            EvaluateStatement((BoundBlockStatement)node.TryBlock);
        }
        catch (Exception ex) when (TryFindCatchHandler(node, ex, out _))
        {
            TryFindCatchHandler(node, ex, out var handler);
            Assign(handler.Variable, ex);
            EvaluateStatement((BoundBlockStatement)handler.Body);
        }
        finally
        {
            if (node.FinallyBlock != null)
            {
                EvaluateStatement((BoundBlockStatement)node.FinallyBlock);
            }
        }
    }

    private void EvaluateThrowStatement(BoundThrowStatement node)
    {
        var value = EvaluateExpression(node.Expression);
        if (value is Exception ex)
        {
            throw ex;
        }

        throw new Exception(value?.ToString());
    }

    private static bool TryFindCatchHandler(BoundTryStatement node, Exception ex, out BoundCatchClause matched)
    {
        var actualType = ex.GetType();
        foreach (var clause in node.CatchClauses)
        {
            var clrName = clause.ExceptionType?.ClrType?.FullName;
            if (clrName == null)
            {
                continue;
            }

            for (var t = actualType; t != null; t = t.BaseType)
            {
                if (t.FullName == clrName)
                {
                    matched = clause;
                    return true;
                }
            }
        }

        matched = null;
        return false;
    }

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
                BoundNodeKind.ArrayCreationExpression => EvaluateArrayCreationExpression((BoundArrayCreationExpression)node),
                BoundNodeKind.MapLiteralExpression => EvaluateMapLiteralExpression((BoundMapLiteralExpression)node),
                BoundNodeKind.MapDeleteExpression => EvaluateMapDeleteExpression((BoundMapDeleteExpression)node),
                BoundNodeKind.IndexExpression => EvaluateIndexExpression((BoundIndexExpression)node),
                BoundNodeKind.IndexAssignmentExpression => EvaluateIndexAssignmentExpression((BoundIndexAssignmentExpression)node),
                BoundNodeKind.LenExpression => EvaluateLenExpression((BoundLenExpression)node),
                BoundNodeKind.TypeOfExpression => EvaluateTypeOfExpression((BoundTypeOfExpression)node),
                BoundNodeKind.CapExpression => EvaluateCapExpression((BoundCapExpression)node),
                BoundNodeKind.AppendExpression => EvaluateAppendExpression((BoundAppendExpression)node),
                BoundNodeKind.StructLiteralExpression => EvaluateStructLiteralExpression((BoundStructLiteralExpression)node),
                BoundNodeKind.BlockExpression => EvaluateBlockExpression((BoundBlockExpression)node),
                BoundNodeKind.ConstructorCallExpression => EvaluateConstructorCallExpression((BoundConstructorCallExpression)node),
                BoundNodeKind.UserInstanceCallExpression => EvaluateUserInstanceCallExpression((BoundUserInstanceCallExpression)node),
                BoundNodeKind.FieldAccessExpression => EvaluateFieldAccessExpression((BoundFieldAccessExpression)node),
                BoundNodeKind.FieldAssignmentExpression => EvaluateFieldAssignmentExpression((BoundFieldAssignmentExpression)node),
                BoundNodeKind.NullConditionalAccessExpression => EvaluateNullConditionalAccessExpression((BoundNullConditionalAccessExpression)node),
                BoundNodeKind.TupleLiteralExpression => EvaluateTupleLiteralExpression((BoundTupleLiteralExpression)node),
                BoundNodeKind.TupleElementAccessExpression => EvaluateTupleElementAccessExpression((BoundTupleElementAccessExpression)node),
                BoundNodeKind.FunctionLiteralExpression => EvaluateFunctionLiteralExpression((BoundFunctionLiteralExpression)node),
                BoundNodeKind.IndirectCallExpression => EvaluateIndirectCallExpression((BoundIndirectCallExpression)node),
                BoundNodeKind.ClrConstructorCallExpression => EvaluateClrConstructorCallExpression((BoundClrConstructorCallExpression)node),
                BoundNodeKind.ClrPropertyAccessExpression => EvaluateClrPropertyAccessExpression((BoundClrPropertyAccessExpression)node),
                BoundNodeKind.ClrPropertyAssignmentExpression => EvaluateClrPropertyAssignmentExpression((BoundClrPropertyAssignmentExpression)node),
                BoundNodeKind.ClrEventSubscriptionExpression => EvaluateClrEventSubscriptionExpression((BoundClrEventSubscriptionExpression)node),
                BoundNodeKind.ClrBinaryOperatorExpression => EvaluateClrBinaryOperatorExpression((BoundClrBinaryOperatorExpression)node),
                BoundNodeKind.ClrUnaryOperatorExpression => EvaluateClrUnaryOperatorExpression((BoundClrUnaryOperatorExpression)node),
                BoundNodeKind.ClrConversionCallExpression => EvaluateClrConversionCallExpression((BoundClrConversionCallExpression)node),
                BoundNodeKind.ClrIndexExpression => EvaluateClrIndexExpression((BoundClrIndexExpression)node),
                BoundNodeKind.ClrIndexAssignmentExpression => EvaluateClrIndexAssignmentExpression((BoundClrIndexAssignmentExpression)node),
                BoundNodeKind.AwaitExpression => EvaluateAwaitExpression((BoundAwaitExpression)node),
                BoundNodeKind.SwitchExpression => EvaluateSwitchExpression((BoundSwitchExpression)node),
                BoundNodeKind.MakeChannelExpression => EvaluateMakeChannelExpression((BoundMakeChannelExpression)node),
                BoundNodeKind.ChannelReceiveExpression => EvaluateChannelReceiveExpression((BoundChannelReceiveExpression)node),
                BoundNodeKind.ChannelCloseExpression => EvaluateChannelCloseExpression((BoundChannelCloseExpression)node),
                BoundNodeKind.AddressOfExpression => EvaluateAddressOfExpression((BoundAddressOfExpression)node),
                BoundNodeKind.DereferenceExpression => EvaluateDereferenceExpression((BoundDereferenceExpression)node),
                BoundNodeKind.DefaultExpression => EvaluateDefaultExpression((BoundDefaultExpression)node),
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

    private object EvaluateVariableExpression(BoundVariableExpression v)
    {
        if (v.Variable.Kind == SymbolKind.GlobalVariable)
        {
            return globals[v.Variable];
        }
        else
        {
            var locals = this.locals.Peek();
            return locals[v.Variable];
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
        var array = System.Array.CreateInstance(clrType, node.Elements.Length);
        for (var i = 0; i < node.Elements.Length; i++)
        {
            array.SetValue(EvaluateExpression(node.Elements[i]), i);
        }

        return array;
    }

    private object EvaluateMapLiteralExpression(BoundMapLiteralExpression node)
    {
        var keyClr = node.MapType.KeyType.ClrType ?? typeof(object);
        var valClr = node.MapType.ValueType.ClrType ?? typeof(object);
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

    private object EvaluateMapDeleteExpression(BoundMapDeleteExpression node)
    {
        var dict = (System.Collections.IDictionary)EvaluateExpression(node.Map);
        var key = EvaluateExpression(node.Key);
        if (dict.Contains(key))
        {
            dict.Remove(key);
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
            if (dict.Contains(key))
            {
                return dict[key];
            }

            return DefaultValue(mapType.ValueType);
        }

        var arr = (System.Array)target;
        var index = (int)EvaluateExpression(node.Index);
        return arr.GetValue(index);
    }

    private object EvaluateIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        var targetValue = node.Target.Kind == Symbols.SymbolKind.GlobalVariable
            ? globals[node.Target]
            : locals.Peek()[node.Target];

        // Phase 3.A.4: map indexed assignment `m[k] = v`.
        if (node.Target.Type is MapTypeSymbol && targetValue is System.Collections.IDictionary dict)
        {
            var key = EvaluateExpression(node.Index);
            var value = EvaluateExpression(node.Value);
            dict[key] = value;
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
            System.Collections.IDictionary d => d.Count,
            _ => throw new EvaluatorException($"len: unsupported operand of CLR type '{v?.GetType()}'.", node),
        };
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
        foreach (var statement in node.Statements)
        {
            if (statement is BoundVariableDeclaration declaration)
            {
                EvaluateVariableDeclaration(declaration);
                continue;
            }

            throw new EvaluatorException($"Unexpected block-expression statement {statement.Kind}", statement);
        }

        return EvaluateExpression(node.Expression);
    }

    private object EvaluateStructLiteralExpression(BoundStructLiteralExpression node)
    {
        var sv = new StructValue(node.StructType);

        // Default-initialize all fields (walking inheritance), then apply explicit initializers.
        for (var t = node.StructType; t != null; t = t.BaseClass)
        {
            foreach (var f in t.Fields)
            {
                if (!sv.Fields.ContainsKey(f.Name))
                {
                    sv.Fields[f.Name] = DefaultValue(f.Type);
                }
            }
        }

        foreach (var init in node.Initializers)
        {
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

    private object EvaluateFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var captured = new Dictionary<VariableSymbol, object>();
        foreach (var v in node.CapturedVariables)
        {
            captured[v] = LookupVariable(v);
        }

        return new ClosureValue(node.Function, node.Body, node.FunctionType, captured);
    }

    private object EvaluateIndirectCallExpression(BoundIndirectCallExpression node)
    {
        var targetValue = EvaluateExpression(node.Target);
        if (targetValue == null)
        {
            throw new EvaluatorException("Attempted to invoke a nil function.", node);
        }

        var closure = (ClosureValue)targetValue;
        var frame = new Dictionary<VariableSymbol, object>();
        foreach (var kv in closure.CapturedLocals)
        {
            frame[kv.Key] = kv.Value;
        }

        for (var i = 0; i < node.Arguments.Length; i++)
        {
            frame[closure.Function.Parameters[i]] = EvaluateExpression(node.Arguments[i]);
        }

        this.locals.Push(frame);
        var result = EvaluateStatement(closure.Body);
        this.locals.Pop();
        return result;
    }

    private object LookupVariable(VariableSymbol v)
    {
        if (v is GlobalVariableSymbol)
        {
            return globals.TryGetValue(v, out var g) ? g : null;
        }

        foreach (var frame in this.locals)
        {
            if (frame.TryGetValue(v, out var value))
            {
                return value;
            }
        }

        return globals.TryGetValue(v, out var gv) ? gv : null;
    }

    private object EvaluateConstructorCallExpression(BoundConstructorCallExpression node)
    {
        var sv = new StructValue(node.StructType);

        // Default-initialize all fields first (including inherited), then bind primary-ctor args.
        for (var t = node.StructType; t != null; t = t.BaseClass)
        {
            foreach (var f in t.Fields)
            {
                if (!sv.Fields.ContainsKey(f.Name))
                {
                    sv.Fields[f.Name] = DefaultValue(f.Type);
                }
            }
        }

        var parameters = node.StructType.PrimaryConstructorParameters;
        for (var i = 0; i < parameters.Length; i++)
        {
            sv.Fields[parameters[i].Name] = EvaluateExpression(node.Arguments[i]);
        }

        return sv;
    }

    private object EvaluateClrConstructorCallExpression(BoundClrConstructorCallExpression node)
    {
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        var result = node.Constructor.Invoke(args);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    private object EvaluateClrPropertyAccessExpression(BoundClrPropertyAccessExpression node)
    {
        var receiver = node.Receiver == null ? null : EvaluateExpression(node.Receiver);
        return node.Member switch
        {
            System.Reflection.PropertyInfo p => p.GetValue(receiver),
            System.Reflection.FieldInfo f => f.GetValue(receiver),
            _ => throw new EvaluatorException($"Unsupported CLR member kind '{node.Member.MemberType}'.", node),
        };
    }

    private object EvaluateClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
    {
        var receiver = node.Receiver == null ? null : EvaluateExpression(node.Receiver);
        var value = EvaluateExpression(node.Value);
        switch (node.Member)
        {
            case System.Reflection.PropertyInfo p:
                p.SetValue(receiver, value);
                break;
            case System.Reflection.FieldInfo f:
                f.SetValue(receiver, value);
                break;
            default:
                throw new EvaluatorException($"Unsupported CLR member kind '{node.Member.MemberType}'.", node);
        }

        return value;
    }

    private object EvaluateClrEventSubscriptionExpression(BoundClrEventSubscriptionExpression node)
    {
        var receiver = node.Receiver == null ? null : EvaluateExpression(node.Receiver);
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

    private object EvaluateClrBinaryOperatorExpression(BoundClrBinaryOperatorExpression node)
    {
        var left = EvaluateExpression(node.Left);
        var right = EvaluateExpression(node.Right);
        return node.Method.Invoke(null, new[] { left, right });
    }

    private object EvaluateClrUnaryOperatorExpression(BoundClrUnaryOperatorExpression node)
    {
        var operand = EvaluateExpression(node.Operand);
        return node.Method.Invoke(null, new[] { operand });
    }

    private object EvaluateClrConversionCallExpression(BoundClrConversionCallExpression node)
    {
        var source = EvaluateExpression(node.Source);
        return node.Method.Invoke(null, new[] { source });
    }

    private object EvaluateClrIndexExpression(BoundClrIndexExpression node)
    {
        var target = EvaluateExpression(node.Target);
        var args = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            args[i] = EvaluateExpression(node.Arguments[i]);
        }

        return node.Indexer.GetValue(target, args);
    }

    private object EvaluateClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
    {
        var target = node.Target.Kind == Symbols.SymbolKind.GlobalVariable
            ? globals[node.Target]
            : locals.Peek()[node.Target];

        var args = new object[node.Arguments.Length];
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            args[i] = EvaluateExpression(node.Arguments[i]);
        }

        var value = EvaluateExpression(node.Value);
        node.Indexer.SetValue(target, value, args);
        return value;
    }

    private object EvaluateFieldAccessExpression(BoundFieldAccessExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);
        if (receiverValue is StructValue sv && sv.Fields.TryGetValue(node.Field.Name, out var value))
        {
            return value;
        }

        return DefaultValue(node.Field.Type);
    }

    private object EvaluateFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        var current = node.Receiver.Kind == Symbols.SymbolKind.GlobalVariable
            ? globals[node.Receiver]
            : locals.Peek()[node.Receiver];

        var sv = current as StructValue ?? new StructValue(node.StructType);

        // Class types are reference types: mutate the existing instance in
        // place so other references observe the write. Structs preserve
        // Go-style value semantics by writing to a copy.
        if (node.StructType.IsClass)
        {
            var value = EvaluateExpression(node.Value);
            sv.Fields[node.Field.Name] = value;
            if (!ReferenceEquals(sv, current))
            {
                Assign(node.Receiver, sv);
            }

            return value;
        }
        else
        {
            var copy = sv.Copy();
            var value = EvaluateExpression(node.Value);
            copy.Fields[node.Field.Name] = value;
            Assign(node.Receiver, copy);
            return value;
        }
    }

    private static object DefaultValue(Symbols.TypeSymbol type)
    {
        if (type == Symbols.TypeSymbol.Bool)
        {
            return false;
        }

        if (type == Symbols.TypeSymbol.Int)
        {
            return 0;
        }

        if (type == Symbols.TypeSymbol.String)
        {
            return string.Empty;
        }

        if (type is Symbols.EnumSymbol)
        {
            return 0;
        }

        if (type is Symbols.StructSymbol s)
        {
            var sv = new StructValue(s);
            foreach (var f in s.Fields)
            {
                sv.Fields[f.Name] = DefaultValue(f.Type);
            }

            return sv;
        }

        return null;
    }

    private object EvaluateUnaryExpression(BoundUnaryExpression u)
    {
        var operand = EvaluateExpression(u.Operand);

        switch (u.Op.Kind)
        {
            case BoundUnaryOperatorKind.Identity:
                return (int)operand;
            case BoundUnaryOperatorKind.Negation:
                return -(int)operand;
            case BoundUnaryOperatorKind.LogicalNegation:
                return !(bool)operand;
            case BoundUnaryOperatorKind.OnesComplement:
                return ~(int)operand;
            case BoundUnaryOperatorKind.NullAssertion:
                if (operand == null)
                {
                    throw new EvaluatorException("nil value !!", u);
                }

                return operand;

            // For now we don't support DereferenceOf or ReferenceOf.
            default:
                throw new EvaluatorException($"Unexpected unary operator {u.Op}", u);
        }
    }

    private object EvaluateBinaryExpression(BoundBinaryExpression b)
    {
        // Phase 3.C.3 / ADR-0001: null-coalescing must short-circuit so the
        // right-hand side is only evaluated when the left is nil.
        if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
        {
            var leftValue = EvaluateExpression(b.Left);
            return leftValue ?? EvaluateExpression(b.Right);
        }

        var left = EvaluateExpression(b.Left);
        var right = EvaluateExpression(b.Right);

        switch (b.Op.Kind)
        {
            case BoundBinaryOperatorKind.Product:
                return (int)left * (int)right;
            case BoundBinaryOperatorKind.Quotient:
                return (int)left / (int)right;
            case BoundBinaryOperatorKind.Remainder:
                return (int)left % (int)right;
            case BoundBinaryOperatorKind.ShiftLeft:
                return (int)left << (int)right;
            case BoundBinaryOperatorKind.ShiftRight:
                return (int)left >> (int)right;
            case BoundBinaryOperatorKind.BitwiseAnd:
                if (b.Type == TypeSymbol.Int)
                {
                    return (int)left & (int)right;
                }
                else
                {
                    return (bool)left & (bool)right;
                }

            case BoundBinaryOperatorKind.BitClear:
                return (int)left & (~(int)right);
            case BoundBinaryOperatorKind.Sum:
                if (b.Type == TypeSymbol.Int)
                {
                    return (int)left + (int)right;
                }
                else
                {
                    return (string)left + (string)right;
                }

            case BoundBinaryOperatorKind.Difference:
                return (int)left - (int)right;
            case BoundBinaryOperatorKind.BitwiseOr:
                if (b.Type == TypeSymbol.Int)
                {
                    return (int)left | (int)right;
                }
                else
                {
                    return (bool)left | (bool)right;
                }

            case BoundBinaryOperatorKind.BitwiseXor:
                if (b.Type == TypeSymbol.Int)
                {
                    return (int)left ^ (int)right;
                }
                else
                {
                    return (bool)left ^ (bool)right;
                }

            case BoundBinaryOperatorKind.Equals:
                return Equals(left, right);
            case BoundBinaryOperatorKind.NotEquals:
                return !Equals(left, right);
            case BoundBinaryOperatorKind.Less:
                return (int)left < (int)right;
            case BoundBinaryOperatorKind.LessOrEquals:
                return (int)left <= (int)right;
            case BoundBinaryOperatorKind.Greater:
                return (int)left > (int)right;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                return (int)left >= (int)right;
            case BoundBinaryOperatorKind.LogicalAnd:
                return (bool)left && (bool)right;
            case BoundBinaryOperatorKind.LogicalOr:
                return (bool)left || (bool)right;
            default:
                throw new EvaluatorException($"Unexpected binary operator {b.Op}", b);
        }
    }

    private object EvaluateCallExpression(BoundCallExpression node)
    {
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
            if (random == null)
            {
                random = new Random();
            }

            return random.Next(max);
        }
        else
        {
            var locals = new Dictionary<VariableSymbol, object>();
            for (int i = 0; i < node.Arguments.Length; i++)
            {
                var parameter = node.Function.Parameters[i];
                var value = EvaluateExpression(node.Arguments[i]);
                locals.Add(parameter, value);
            }

            this.locals.Push(locals);

            var statement = program.Functions[node.Function];

            if (IsIteratorFunction(node.Function, statement))
            {
                var iteratorResult = EvaluateIteratorFunction(node.Function, statement);
                this.locals.Pop();
                return iteratorResult;
            }

            var result = EvaluateStatement(statement);

            this.locals.Pop();

            if (node.Function.IsAsync)
            {
                return WrapAsyncResult(node.Function.Type, result);
            }

            return result;
        }
    }

    private bool IsIteratorFunction(Symbols.FunctionSymbol function, BoundBlockStatement body)
    {
        if (iteratorFunctionCache.TryGetValue(function, out var cached))
        {
            return cached;
        }

        var walker = new YieldFinder();
        walker.RewriteStatement(body);
        cached = walker.Found;
        iteratorFunctionCache[function] = cached;
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

        iteratorSinks.Push(list);
        try
        {
            EvaluateStatement(body);
        }
        finally
        {
            iteratorSinks.Pop();
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
        if (iteratorSinks.Count == 0)
        {
            throw new EvaluatorException("'yield' encountered outside of an iterator function.", node);
        }

        var value = EvaluateExpression(node.Expression);
        iteratorSinks.Peek().Add(value);
        lastValue = value;
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
        var frame = locals.Peek();
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
                frame.Remove(binding.Key);
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
                if (value is not StructValue sv)
                {
                    return false;
                }

                var property = (BoundPropertyPattern)pattern;
                foreach (var field in property.Fields)
                {
                    sv.Fields.TryGetValue(field.Field.Name, out var fieldValue);
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
            case BoundNodeKind.ListPattern:
                if (value is not System.Array array)
                {
                    return false;
                }

                var list = (BoundListPattern)pattern;
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

        if (value is StructValue sv)
        {
            for (var t = sv.StructType; t != null; t = t.BaseClass)
            {
                if (t == targetType)
                {
                    return true;
                }
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
                return object.Equals(left, right);
            case BoundBinaryOperatorKind.NotEquals:
                return !object.Equals(left, right);
            case BoundBinaryOperatorKind.Less:
                return (int)left < (int)right;
            case BoundBinaryOperatorKind.LessOrEquals:
                return (int)left <= (int)right;
            case BoundBinaryOperatorKind.Greater:
                return (int)left > (int)right;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                return (int)left >= (int)right;
            default:
                throw new InvalidOperationException($"Unexpected relational pattern operator {op}.");
        }
    }

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

        // Issue #148: `await for` desugaring produces `await __enum.MoveNextAsync()`
        // and `await __enum.DisposeAsync()`, which return `ValueTask<bool>` /
        // `ValueTask`. Use the same synchronous-await pragma the await-for
        // path uses for the underlying enumerator calls.
        if (operand == null)
        {
            throw new EvaluatorException("'await' operand did not evaluate to an awaitable.", node);
        }

        var operandType = operand.GetType();
        if (operandType.FullName == "System.Threading.Tasks.ValueTask" ||
            (operandType.IsGenericType && operandType.GetGenericTypeDefinition().FullName == "System.Threading.Tasks.ValueTask`1"))
        {
            return BlockOnValueTask(operand);
        }

        throw new EvaluatorException("'await' operand did not evaluate to a Task.", node);
    }

    private static object EvaluateDefaultExpression(BoundDefaultExpression node)
    {
        // Issue #148: the `await for` lowering uses `default(CancellationToken)`
        // for the `GetAsyncEnumerator` token; more generally, BoundDefaultExpression
        // should produce the type's default value when interpreted.
        var clr = node.Type?.ClrType;
        if (clr == null || !clr.IsValueType)
        {
            return null;
        }

        return System.Activator.CreateInstance(clr);
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
                && m.GetParameters()[0].ParameterType == typeof(BoundedChannelOptions));
        return bounded.MakeGenericMethod(elementClr).Invoke(null, new object[] { options });
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
        var valueTask = readAsync.Invoke(reader, new object[] { System.Threading.CancellationToken.None });
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
        writer.GetType().GetMethod("Complete", new[] { typeof(Exception) }).Invoke(writer, new object[] { null });
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
            var vt = waitToWrite.Invoke(writer, new object[] { System.Threading.CancellationToken.None });
            return (Task)vt.GetType().GetMethod("AsTask").Invoke(vt, null);
        }

        var reader = channel.GetType().GetProperty("Reader").GetValue(channel);
        var waitToRead = reader.GetType().GetMethod("WaitToReadAsync", new[] { typeof(System.Threading.CancellationToken) });
        var vt2 = waitToRead.Invoke(reader, new object[] { System.Threading.CancellationToken.None });
        return (Task)vt2.GetType().GetMethod("AsTask").Invoke(vt2, null);
    }

    private object EvaluateUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        var receiverValue = EvaluateExpression(node.Receiver);

        // Phase 3.B.3 sub-step 3: virtual dispatch. If the receiver's runtime
        // type overrides the statically-bound method, route to the override.
        var method = node.Method;

        // Phase 3.B.4 + Phase 4.2b: an interface method (or a generic
        // type-parameter's interface-constrained method) has a null
        // ThisParameter / ReceiverType. Resolve the concrete implementation
        // by looking up the method by name on the runtime struct type.
        if (method.ThisParameter == null && receiverValue is StructValue ifaceSv && ifaceSv.StructType != null)
        {
            for (var t = ifaceSv.StructType; t != null; t = t.BaseClass)
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

        var frame = new Dictionary<VariableSymbol, object>
        {
            [method.ThisParameter] = receiverValue,
        };

        var parameterOffset = method.ExplicitReceiverParameter == null ? 0 : 1;
        for (int i = 0; i < node.Arguments.Length; i++)
        {
            var parameter = method.Parameters[i + parameterOffset];
            var value = EvaluateExpression(node.Arguments[i]);
            frame.Add(parameter, value);
        }

        locals.Push(frame);
        var statement = program.Functions[method];
        var result = EvaluateStatement(statement);
        locals.Pop();

        return result;
    }

    private object EvaluateConversionExpression(BoundConversionExpression node)
    {
        var value = EvaluateExpression(node.Expression);
        if (node.Type == TypeSymbol.Bool)
        {
            return Convert.ToBoolean(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type == TypeSymbol.Int)
        {
            return Convert.ToInt32(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type == TypeSymbol.String)
        {
            return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        }
        else if (node.Type is NullableTypeSymbol)
        {
            // Phase 3.C.1: nullability is a bind-time annotation; the runtime
            // representation is identical to the underlying type.
            return value;
        }
        else if (node.Type is InterfaceSymbol
            || (node.Type is StructSymbol upcastTarget && upcastTarget.IsClass))
        {
            // Reference upcast (class → implemented interface, or derived
            // class → base class). The interpreter stores instances as
            // boxed objects of the concrete class, so the upcast is a no-op
            // at runtime — only the bind-time static type changes.
            return value;
        }
        else
        {
            throw new EvaluatorException($"Unexpected type {node.Type}", node);
        }
    }

    private object EvaluateImportedCallExpression(BoundImportedCallExpression node)
    {
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        var result = node.Function.Method.Invoke(null, args);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    private object EvaluateImportedInstanceCallExpression(BoundImportedInstanceCallExpression node)
    {
        var receiver = EvaluateExpression(node.Receiver);
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        var result = node.Method.Invoke(receiver, args);
        WriteBackRefSlots(refSlots, args);
        return result;
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
                // Evaluate the operand to get current value.
                args[i] = EvaluateExpression(addrOf.Operand);
                if (rk == RefKind.Ref || rk == RefKind.Out)
                {
                    refSlots ??= new List<(int, BoundExpression)>();
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
                case BoundIndexExpression idx:
                    WriteBackIndex(idx, value);
                    break;
            }
        }
    }

    /// <summary>ADR-0039: Writes back a value into a field after ref/out return.</summary>
    private void WriteBackField(BoundFieldAccessExpression fa, object value)
    {
        var receiver = EvaluateExpression(fa.Receiver);
        if (receiver is StructValue sv)
        {
            sv.Fields[fa.Field.Name] = value;
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

        var locals = this.locals.Peek();
        locals[node.Capture] = receiver;
        try
        {
            return EvaluateExpression(node.WhenNotNull);
        }
        finally
        {
            locals.Remove(node.Capture);
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
            globals[variable] = value;
        }
        else
        {
            var locals = this.locals.Peek();
            locals[variable] = value;
        }
    }

    private sealed class YieldFinder : Binding.BoundTreeRewriter
    {
        public bool Found { get; private set; }

        protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
        {
            Found = true;
            return node;
        }
    }

    private sealed class InterpAsyncEnumerableBuffer<T> :
        System.Collections.Generic.IAsyncEnumerable<T>,
        System.Collections.Generic.IAsyncEnumerator<T>
    {
        private readonly System.Collections.Generic.IList<T> items;
        private int index = -1;

        public InterpAsyncEnumerableBuffer(System.Collections.Generic.IList<T> items)
        {
            this.items = items;
        }

        public T Current => items[index];

        public System.Collections.Generic.IAsyncEnumerator<T> GetAsyncEnumerator(
            System.Threading.CancellationToken cancellationToken = default)
        {
            return new InterpAsyncEnumerableBuffer<T>(items);
        }

        public System.Threading.Tasks.ValueTask<bool> MoveNextAsync()
        {
            index++;
            return new System.Threading.Tasks.ValueTask<bool>(index < items.Count);
        }

        public System.Threading.Tasks.ValueTask DisposeAsync()
        {
            return default;
        }
    }

    private sealed class ScopeFrame
    {
        public List<Task> Tasks { get; } = new List<Task>();

        public System.Threading.CancellationTokenSource Cts { get; } = new System.Threading.CancellationTokenSource();
    }
}
