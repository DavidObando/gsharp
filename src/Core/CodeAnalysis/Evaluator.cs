#nullable disable

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
    private readonly Dictionary<(Symbols.StructSymbol, Symbols.FieldSymbol), object> staticFields = new Dictionary<(Symbols.StructSymbol, Symbols.FieldSymbol), object>();

    // ADR-0089 / issue #1030: interface static-field storage. Keyed by the
    // owning interface symbol so each closed construction of a generic interface
    // (`IBox[int32]` vs `IBox[string]`) owns independent storage, matching CLR
    // static-field semantics. The non-generic case keys by the single interface.
    private readonly Dictionary<(Symbols.InterfaceSymbol, Symbols.FieldSymbol), object> interfaceStaticFields = new Dictionary<(Symbols.InterfaceSymbol, Symbols.FieldSymbol), object>();
    private Random random;

    private object lastValue;

    // Issue #738: control-transfer state for nested blocks (switch arms,
    // try/catch/finally bodies, scope bodies, select cases, await-for-range
    // bodies). Those constructs are kept as nested BoundBlockStatements after
    // lowering, so a `return` or a `break`/`continue` (lowered to a labeled
    // `goto` whose target lives in the enclosing function block) inside one
    // of them used to be swallowed by the inner EvaluateStatement loop. The
    // fields below let an inner loop signal an in-flight control transfer to
    // outer loops, which propagate it until it either resolves at the right
    // label or unwinds to a function boundary (where `EvaluateFunctionBody`
    // consumes it).
    private bool isReturning;
    private BoundLabel pendingGotoLabel;

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
        return EvaluateFunctionBody(program.Statement);
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
            // Issue #738: a pending return or an in-flight goto (set by a
            // nested EvaluateStatement on behalf of a switch arm / scope /
            // try / select / await-for body) must either resolve in this
            // block or be propagated to the enclosing one. We check before
            // every statement so that returns/gotos triggered by the
            // *previous* iteration's nested call are honored before any new
            // statement runs.
            if (isReturning)
            {
                return lastValue;
            }

            if (pendingGotoLabel != null)
            {
                if (labelToIndex.TryGetValue(pendingGotoLabel, out var pendIdx))
                {
                    pendingGotoLabel = null;
                    index = pendIdx;
                    continue;
                }

                return lastValue;
            }

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
                    if (labelToIndex.TryGetValue(gs.Label, out var gsIdx))
                    {
                        index = gsIdx;
                    }
                    else
                    {
                        // Issue #738: target label lives in an enclosing
                        // block (e.g. a `break`/`continue` lowered to
                        // `goto loop_break`/`goto loop_continue` emitted
                        // inside a switch arm body). Park the label and
                        // bail; the outer EvaluateStatement will pick it
                        // up via the top-of-loop check above.
                        pendingGotoLabel = gs.Label;
                        return lastValue;
                    }

                    break;
                case BoundNodeKind.ConditionalGotoStatement:
                    var cgs = (BoundConditionalGotoStatement)s;
                    var condition = (bool)EvaluateExpression(cgs.Condition);
                    if (condition == cgs.JumpIfTrue)
                    {
                        if (labelToIndex.TryGetValue(cgs.Label, out var cgsIdx))
                        {
                            index = cgsIdx;
                        }
                        else
                        {
                            pendingGotoLabel = cgs.Label;
                            return lastValue;
                        }
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
                    isReturning = true;
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
                case BoundNodeKind.FixedStatement:
                    // ADR-0125 / issue #1026: `fixed` pins a managed buffer and
                    // yields a raw unmanaged pointer — it requires the CIL
                    // pinned-local / pointer emit path and is not modelled by
                    // the tree-walking interpreter.
                    throw new EvaluatorException("'fixed' (pinning) statements are not supported in the interpreter; they require the CIL pinned-local emit path.", s);
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

    /// <summary>
    /// Issue #738: function-call boundary. Runs <paramref name="body"/> and
    /// then drains any in-flight control-transfer state (a pending return
    /// or a parked goto) so it cannot leak across the call boundary. A
    /// parked goto reaching the boundary would mean a `break`/`continue`
    /// escaped a function body, which the binder rejects — but we clear
    /// defensively so a stale flag from a partially-evaluated previous
    /// call cannot corrupt the next invocation on this evaluator.
    /// </summary>
    private object EvaluateFunctionBody(BoundBlockStatement body)
    {
        var result = EvaluateStatement(body);
        isReturning = false;
        pendingGotoLabel = null;
        return result;
    }

    private void EvaluateVariableDeclaration(BoundVariableDeclaration node)
    {
        // Issue #491 (ADR-0060 follow-up): a ref-aliasing local binds the symbol
        // to an existing lvalue rather than copying its value. The initializer
        // is a BoundAddressOfExpression whose operand is the aliased lvalue;
        // store a RefAlias sentinel in the locals dictionary so subsequent
        // reads re-evaluate the operand and writes route back to it.
        if (node.Variable is LocalVariableSymbol refLocal
            && refLocal.RefKind != RefKind.None
            && node.Initializer is BoundAddressOfExpression refAddr)
        {
            var alias = new RefAlias(refAddr.Operand);
            var locals = this.locals.Peek();
            locals[node.Variable] = alias;

            // Mirror the read-through semantics for `lastValue` (used by REPL).
            lastValue = EvaluateExpression(refAddr.Operand);
            return;
        }

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

                // Issue #937: honor `break`/`continue` (lowered to gotos that
                // target this loop's break/continue labels) and labeled
                // gotos / returns that escape the body. A pending goto to
                // this loop's continue label advances to the next element;
                // a goto to this loop's break label (or a plain return)
                // exits the loop; any other pending goto belongs to an
                // enclosing loop and is left parked so it propagates.
                if (pendingGotoLabel != null && pendingGotoLabel == node.ContinueLabel)
                {
                    pendingGotoLabel = null;
                    continue;
                }

                if (isReturning || pendingGotoLabel != null)
                {
                    if (pendingGotoLabel == node.BreakLabel)
                    {
                        pendingGotoLabel = null;
                    }

                    break;
                }
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
                // Issue #738: CIL semantics — finally always executes,
                // even if try/catch left a pending return or goto. Stash
                // the in-flight control transfer, run finally with a
                // cleared state, then either keep the finally's own new
                // transfer (it supersedes per ECMA-335 III.1.7.5) or
                // restore the original.
                var savedReturning = isReturning;
                var savedGoto = pendingGotoLabel;
                isReturning = false;
                pendingGotoLabel = null;

                EvaluateStatement((BoundBlockStatement)node.FinallyBlock);

                if (!isReturning && pendingGotoLabel == null)
                {
                    isReturning = savedReturning;
                    pendingGotoLabel = savedGoto;
                }
            }
        }
    }

    private void EvaluateThrowStatement(BoundThrowStatement node)
    {
        var value = EvaluateExpression(node.Expression);

        // Issue #319: a GSharp class that inherits a CLR Exception type carries a
        // real CLR backing instance (allocated via AllocateClrBacking). Throw that
        // backing so the runtime catch path observes the correct type and inherited
        // members (e.g. Exception.Message). Otherwise fall back to legacy behavior.
        if (value is StructValue sv && sv.ClrBacking is Exception backingEx)
        {
            throw backingEx;
        }

        if (value is Exception ex)
        {
            throw ex;
        }

        throw new Exception(value?.ToString());
    }

    /// <summary>
    /// Issue #1018: evaluates a throw-expression in value position. Like the
    /// throw statement it never returns — it always raises the exception — so
    /// the declared return type (<c>object</c>) is never observed.
    /// </summary>
    private object EvaluateThrowExpression(BoundThrowExpression node)
    {
        var value = EvaluateExpression(node.Expression);

        if (value is StructValue sv && sv.ClrBacking is Exception backingEx)
        {
            throw backingEx;
        }

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

        var handler = info.Constructor.Invoke(ctorArgs);
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

                var literalResult = appendLiteral.Invoke(handler, new object[] { part.Literal });
                if (literalResult is bool lb)
                {
                    shouldAppend = lb;
                }

                continue;
            }

            var value = EvaluateExpression(part.Value);
            var formattedResult = InvokeUserAppendFormatted(handlerType, handler, part, value);
            if (formattedResult is bool fb)
            {
                shouldAppend = fb;
            }
        }

        return handler;
    }

    private static object InvokeUserAppendFormatted(System.Type handlerType, object handler, BoundInterpolatedStringPart part, object value)
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

        return best.Invoke(handler, args.ToArray());
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

        return EvaluateExpression(node.Expression);
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
                    var frame = new Dictionary<Symbols.VariableSymbol, object>
                    {
                        [init.Property.SetterSymbol.ThisParameter] = sv,
                        [init.Property.SetterSymbol.Parameters[0]] = value,
                    };
                    locals.Push(frame);
                    EvaluateFunctionBody(setterBody);
                    locals.Pop();
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

    private object EvaluateFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var captured = new Dictionary<VariableSymbol, object>();
        foreach (var v in node.CapturedVariables)
        {
            captured[v] = LookupVariable(v);
        }

        return new ClosureValue(node.Function, node.Body, node.FunctionType, captured);
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

        return new ClosureValue(node.Function, body, node.FunctionType, captured);
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
        var result = EvaluateFunctionBody(closure.Body);
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
                    sv.Fields[primaryParams[i].Name] = EvaluateExpression(node.Arguments[i]);
                }

                // Forward an explicit class-level base initializer if present
                // (the synthesized primary mirrors the original primary-ctor shape).
                var baseInitOnStruct = node.StructType.BaseConstructorInitializer;
                if (baseInitOnStruct != null
                    && baseInitOnStruct.GSharpBaseType is StructSymbol gsBase)
                {
                    var frame = new Dictionary<VariableSymbol, object>();
                    for (var i = 0; i < primaryParams.Length; i++)
                    {
                        frame[primaryParams[i]] = sv.Fields[primaryParams[i].Name];
                    }

                    locals.Push(frame);
                    try
                    {
                        var baseParams = gsBase.PrimaryConstructorParameters;
                        for (var i = 0; i < baseParams.Length && i < baseInitOnStruct.Arguments.Length; i++)
                        {
                            sv.Fields[baseParams[i].Name] = EvaluateExpression(baseInitOnStruct.Arguments[i]);
                        }
                    }
                    finally
                    {
                        locals.Pop();
                    }
                }

                AllocateClrBacking(sv, node.StructType, baseInitOnStruct);
                return sv;
            }

            var ctorFunction = explicitCtor.Function;
            var frame2 = new Dictionary<VariableSymbol, object>
            {
                [ctorFunction.ThisParameter] = sv,
            };

            for (var i = 0; i < ctorFunction.Parameters.Length; i++)
            {
                frame2[ctorFunction.Parameters[i]] = EvaluateExpression(node.Arguments[i]);
            }

            locals.Push(frame2);
            try
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
                        sv.Fields[baseParams[i].Name] = EvaluateExpression(ctorBaseInit.Arguments[i]);
                    }
                }

                AllocateClrBacking(sv, node.StructType, explicitCtor.BaseInitializer);

                var body = program.Functions[ctorFunction];
                EvaluateFunctionBody(body);
            }
            finally
            {
                locals.Pop();
            }

            return sv;
        }

        var parameters = node.StructType.PrimaryConstructorParameters;
        for (var i = 0; i < parameters.Length; i++)
        {
            sv.Fields[parameters[i].Name] = EvaluateExpression(node.Arguments[i]);
        }

        // Issue #306: forward an explicit base-constructor initializer to a GSharp
        // base class's primary constructor. The base-ctor arguments may reference
        // this class's primary-constructor parameters, so evaluate them in a frame
        // where those parameters are bound to the just-assigned values.
        var baseInit = node.StructType.BaseConstructorInitializer;
        if (baseInit != null || node.StructType.ImportedBaseType != null
            || HasClrAncestor(node.StructType))
        {
            var frame = new Dictionary<VariableSymbol, object>();
            for (var i = 0; i < parameters.Length; i++)
            {
                frame[parameters[i]] = sv.Fields[parameters[i].Name];
            }

            locals.Push(frame);
            try
            {
                if (baseInit != null && baseInit.GSharpBaseType is StructSymbol gsharpBase)
                {
                    var baseParams = gsharpBase.PrimaryConstructorParameters;
                    for (var i = 0; i < baseParams.Length && i < baseInit.Arguments.Length; i++)
                    {
                        sv.Fields[baseParams[i].Name] = EvaluateExpression(baseInit.Arguments[i]);
                    }
                }

                // Issue #319: instantiate the CLR base instance (when the class
                // ultimately derives from a CLR type) so inherited CLR instance
                // state — such as Exception.Message — is set per the emit path.
                AllocateClrBacking(sv, node.StructType, baseInit);
            }
            finally
            {
                locals.Pop();
            }
        }

        return sv;
    }

    /// <summary>
    /// Issue #319: instantiate the imported CLR base for a GSharp class instance
    /// when the class ultimately derives from a CLR type, so inherited CLR
    /// instance state (e.g. <see cref="System.Exception.Message"/>) is observable
    /// under the interpreter. The chosen base constructor mirrors the emit path:
    /// the resolved <see cref="BaseConstructorInitializer.ClrConstructor"/> when
    /// the class declared <c>: Base(args)</c>, otherwise the imported base's
    /// accessible parameterless constructor. The base-ctor argument expressions
    /// must be evaluated within whatever frame the caller has just pushed.
    /// </summary>
    private void AllocateClrBacking(StructValue sv, StructSymbol structType, BaseConstructorInitializer activeInit)
    {
        // If an explicit `: base(args)` targets a CLR constructor, prefer that.
        if (activeInit is { IsClrBase: true } clrInit && clrInit.ClrConstructor != null)
        {
            sv.ClrBacking = InvokeClrCtor(clrInit.ClrConstructor, clrInit.Arguments, clrInit.ArgumentRefKinds);
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
                    sv.ClrBacking = parameterless.Invoke(Array.Empty<object>());
                }

                return;
            }
        }
    }

    /// <summary>Issue #319: invoke a CLR base constructor with the bound G# argument expressions.</summary>
    private object InvokeClrCtor(ConstructorInfo ctor, ImmutableArray<BoundExpression> arguments, ImmutableArray<RefKind> argumentRefKinds)
    {
        var args = new object[arguments.Length];
        var refSlots = BuildRefSlots(arguments, argumentRefKinds, args);
        var instance = ctor.Invoke(args);
        WriteBackRefSlots(refSlots, args);
        return instance;
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
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        var result = node.Constructor.Invoke(args);
        WriteBackRefSlots(refSlots, args);
        return result;
    }

    private object EvaluateClrStaticCallExpression(BoundClrStaticCallExpression node)
    {
        var args = new object[node.Arguments.Length];
        var refSlots = BuildRefSlots(node.Arguments, node.ArgumentRefKinds, args);

        var result = node.Method.Invoke(null, args);
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

        receiver = UnwrapClrReceiver(receiver);

        // Issue #608: when the receiver is a StructValue (a G# class instance)
        // and the member is from a CLR interface that the class satisfies via a
        // field (the #573/#606 field-satisfies-property contract), reflection
        // cannot invoke the interface property on the StructValue. Route the
        // read through the struct's field dictionary instead.
        if (receiver is StructValue sv && TryReadStructFieldForClrMember(sv, node.Member, out var fieldValue))
        {
            return fieldValue;
        }

        // Issue #814 / ADR-0084 §L5: mirror ResolveMethodForReceiver for
        // PropertyInfo. `IEnumerator<object>::Current` access against a
        // value-type-element enumerator (e.g. `SZGenericArrayEnumerator<int>`
        // from `int[].GetEnumerator()`) fails because the receiver doesn't
        // implement `IEnumerator<object>`. Route through the matching
        // closed-generic interface on the receiver's runtime type.
        var member = ResolvePropertyOrFieldForReceiver(node.Member, receiver);

        return member switch
        {
            System.Reflection.PropertyInfo p => p.GetValue(receiver),
            System.Reflection.FieldInfo f => f.GetValue(receiver),
            _ => throw new EvaluatorException($"Unsupported CLR member kind '{node.Member.MemberType}'.", node),
        };
    }

    private static System.Reflection.MemberInfo ResolvePropertyOrFieldForReceiver(System.Reflection.MemberInfo member, object receiver)
    {
        if (receiver == null || member == null)
        {
            return member;
        }

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

        // Issue #608: when the receiver is a StructValue (G# class instance)
        // and the member is from a CLR interface satisfied by a field, route the
        // write through the struct's field dictionary.
        if (receiver is StructValue sv && TryWriteStructFieldForClrMember(sv, node.Member, value))
        {
            return value;
        }

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
                var frame = new Dictionary<Symbols.VariableSymbol, object>();
                if (methodSymbol.ThisParameter != null)
                {
                    frame[methodSymbol.ThisParameter] = receiverValue;
                }

                if (methodSymbol.Parameters.Length > 0)
                {
                    frame[methodSymbol.Parameters[0]] = handlerValue;
                }

                locals.Push(frame);
                EvaluateFunctionBody(body);
                locals.Pop();
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
                if (interfaceStaticFields.TryGetValue((node.InterfaceType, node.Field), out var ifaceValue))
                {
                    return ifaceValue;
                }

                return DefaultValue(node.Field.Type);
            }

            if (staticFields.TryGetValue((node.StructType, node.Field), out var staticValue))
            {
                return staticValue;
            }

            return DefaultValue(node.Field.Type);
        }

        var receiverValue = EvaluateExpression(node.Receiver);
        if (receiverValue is StructValue sv && sv.Fields.TryGetValue(node.Field.Name, out var value))
        {
            return value;
        }

        return DefaultValue(node.Field.Type);
    }

    private object EvaluateFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        // ADR-0053: static field assignment — receiver is null; store in the
        // static-field storage keyed by (StructType, Field).
        if (node.Receiver == null)
        {
            var value = EvaluateExpression(node.Value);

            // Issue #1030: interface static field — keyed per owning interface
            // (per closed construction for a generic interface).
            if (node.InterfaceType != null)
            {
                interfaceStaticFields[(node.InterfaceType, node.Field)] = value;
                return value;
            }

            staticFields[(node.StructType, node.Field)] = value;
            return value;
        }

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

    private object EvaluatePropertyAccessExpression(BoundPropertyAccessExpression node)
    {
        // ADR-0053: static property access — receiver is null.
        if (node.Receiver == null)
        {
            if (node.Property.IsAutoProperty && node.Property.BackingField != null)
            {
                if (staticFields.TryGetValue((node.StructType, node.Property.BackingField), out var staticValue))
                {
                    return staticValue;
                }
            }
            else if (node.Property.GetterSymbol != null && program.Functions.TryGetValue(node.Property.GetterSymbol, out var staticGetterBody))
            {
                // Issue #263: computed static property getter — no 'this' parameter.
                var frame = new Dictionary<Symbols.VariableSymbol, object>();
                locals.Push(frame);
                var result = EvaluateFunctionBody(staticGetterBody);
                locals.Pop();
                return result;
            }

            return DefaultValue(node.Property.Type);
        }

        var receiverValue = EvaluateExpression(node.Receiver);

        // Issue #1235 / issue #1068: when the statically-bound property is
        // declared on an interface (or, for a constrained type parameter, on the
        // constraint type), resolve the concrete property implementation from
        // the receiver's runtime type so the read dispatches virtually — the
        // interpreter analogue of `callvirt get_X`. Walking the base chain also
        // honours property overrides.
        var property = node.Property;
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

            return DefaultValue(property.Type);
        }

        // Computed property: execute the bound getter body.
        if (property.GetterSymbol != null && program.Functions.TryGetValue(property.GetterSymbol, out var getterBody))
        {
            var frame = new Dictionary<Symbols.VariableSymbol, object>
            {
                [property.GetterSymbol.ThisParameter] = receiverValue,
            };
            locals.Push(frame);
            var result = EvaluateFunctionBody(getterBody);
            locals.Pop();
            return result;
        }

        return DefaultValue(property.Type);
    }

    private object EvaluatePropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        var value = EvaluateExpression(node.Value);

        // Issue #263: static property assignment (receiver is null).
        if (node.Receiver == null)
        {
            if (node.Property.IsAutoProperty && node.Property.BackingField != null)
            {
                staticFields[(node.StructType, node.Property.BackingField)] = value;
            }
            else if (node.Property.SetterSymbol != null && program.Functions.TryGetValue(node.Property.SetterSymbol, out var staticSetterBody))
            {
                var frame = new Dictionary<Symbols.VariableSymbol, object>
                {
                    [node.Property.SetterSymbol.Parameters[0]] = value,
                };
                locals.Push(frame);
                EvaluateFunctionBody(staticSetterBody);
                locals.Pop();
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
                    ? globals[receiverVar]
                    : locals.Peek()[receiverVar];

                var sv = current as StructValue ?? new StructValue(node.StructType);

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
            var frame = new Dictionary<Symbols.VariableSymbol, object>
            {
                [node.Property.SetterSymbol.ThisParameter] = receiverValue,
                [node.Property.SetterSymbol.Parameters[0]] = value,
            };
            locals.Push(frame);
            EvaluateFunctionBody(setterBody);
            locals.Pop();
            return value;
        }

        return value;
    }

    private static object DefaultValue(Symbols.TypeSymbol type)
    {
        if (type == Symbols.TypeSymbol.Bool)
        {
            return false;
        }

        if (type == Symbols.TypeSymbol.Int32)
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

        // Issue #615: unwrap enum operands to underlying before arithmetic/bitwise.
        var rawOperand = UnwrapEnumToUnderlying(operand);

        object result;
        switch (u.Op.Kind)
        {
            case BoundUnaryOperatorKind.Identity:
                result = rawOperand;
                break;
            case BoundUnaryOperatorKind.Negation:
                result = Negate(rawOperand);
                break;
            case BoundUnaryOperatorKind.LogicalNegation:
                return !(bool)operand;
            case BoundUnaryOperatorKind.OnesComplement:
                result = OnesComplement(rawOperand);
                break;
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

        // Issue #615: wrap result back to enum type if the operator's result is enum.
        if (u.Type?.ClrType != null && u.Type.ClrType.IsEnum)
        {
            return Enum.ToObject(u.Type.ClrType, result);
        }

        return result;
    }

    private static object Negate(object v) => v switch
    {
        int i => -i,
        long l => -l,
        sbyte sb => (sbyte)-sb,
        short sh => (short)-sh,
        nint ni => -ni,
        float f => -f,
        double d => -d,
        decimal dec => -dec,
        _ => throw new InvalidOperationException($"Unsupported negation operand type {v?.GetType()}"),
    };

    private static object OnesComplement(object v) => v switch
    {
        int i => ~i,
        long l => ~l,
        sbyte sb => (sbyte)~sb,
        byte b => (byte)~b,
        short sh => (short)~sh,
        ushort us => (ushort)~us,
        uint ui => ~ui,
        ulong ul => ~ul,
        nint ni => ~ni,
        nuint nu => ~nu,
        _ => throw new InvalidOperationException($"Unsupported ~ operand type {v?.GetType()}"),
    };

    private object EvaluateBinaryExpression(BoundBinaryExpression b)
    {
        // Phase 3.C.3 / ADR-0001: null-coalescing must short-circuit so the
        // right-hand side is only evaluated when the left is nil.
        if (b.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
        {
            var leftValue = EvaluateExpression(b.Left);
            if (leftValue != null)
            {
                // Issue #1239: when the best common type widened the left's
                // underlying numeric type (e.g. `int32? ?? int64` → `int64`),
                // convert the non-null left value to the result type. Reference
                // results are representation-preserving and need no conversion.
                var leftUnderlying = b.Left.Type is NullableTypeSymbol ln ? ln.UnderlyingType : b.Left.Type;
                if (b.Type != leftUnderlying
                    && b.Type?.ClrType is { IsValueType: true } resultClr
                    && IsSupportedNumericClrType(resultClr))
                {
                    return UncheckedNumericConvert(leftValue, resultClr);
                }

                return leftValue;
            }

            return EvaluateExpression(b.Right);
        }

        var left = EvaluateExpression(b.Left);
        var right = EvaluateExpression(b.Right);

        switch (b.Op.Kind)
        {
            case BoundBinaryOperatorKind.Equals:
                return Equals(left, right);
            case BoundBinaryOperatorKind.NotEquals:
                return !Equals(left, right);
            case BoundBinaryOperatorKind.LogicalAnd:
                return (bool)left && (bool)right;
            case BoundBinaryOperatorKind.LogicalOr:
                return (bool)left || (bool)right;
        }

        // String concat / bool short-circuiting flow through the existing
        // typed paths; everything else routes through the primitive-aware
        // helpers below so each numeric type uses its own arithmetic.
        if (b.Op.Kind == BoundBinaryOperatorKind.Sum && b.Type == TypeSymbol.String)
        {
            return (string)left + (string)right;
        }

        if (left is bool lb && right is bool rb)
        {
            return b.Op.Kind switch
            {
                BoundBinaryOperatorKind.BitwiseAnd => lb & rb,
                BoundBinaryOperatorKind.BitwiseOr => lb | rb,
                BoundBinaryOperatorKind.BitwiseXor => lb ^ rb,
                _ => throw new EvaluatorException($"Unexpected binary operator {b.Op}", b),
            };
        }

        return EvaluateNumericBinary(b, left, right);
    }

    private static object EvaluateNumericBinary(BoundBinaryExpression b, object left, object right)
    {
        // Issue #615: enum operands arrive as boxed enum values (e.g. DayOfWeek)
        // which do not match the primitive pattern arms in NumericAdd/Sub/etc.
        // Unwrap to the underlying integral type before arithmetic/comparison.
        left = UnwrapEnumToUnderlying(left);
        right = UnwrapEnumToUnderlying(right);

        // §6.1 lifted nullable: if either operand is null, arithmetic/bitwise
        // yields null and ordering yields false.
        if (left == null || right == null)
        {
            switch (b.Op.Kind)
            {
                case BoundBinaryOperatorKind.Less:
                case BoundBinaryOperatorKind.LessOrEquals:
                case BoundBinaryOperatorKind.Greater:
                case BoundBinaryOperatorKind.GreaterOrEquals:
                    return false;
                default:
                    return null;
            }
        }

        var resultType = b.Type;
        switch (b.Op.Kind)
        {
            case BoundBinaryOperatorKind.Sum:
                return NarrowToResultType(NumericAdd(left, right), resultType);
            case BoundBinaryOperatorKind.Difference:
                return NarrowToResultType(NumericSub(left, right), resultType);
            case BoundBinaryOperatorKind.Product:
                return NarrowToResultType(NumericMul(left, right), resultType);
            case BoundBinaryOperatorKind.Quotient:
                return NarrowToResultType(NumericDiv(left, right), resultType);
            case BoundBinaryOperatorKind.Remainder:
                return NarrowToResultType(NumericMod(left, right), resultType);
            case BoundBinaryOperatorKind.BitwiseAnd:
                return NarrowToResultType(NumericAnd(left, right), resultType);
            case BoundBinaryOperatorKind.BitwiseOr:
                return NarrowToResultType(NumericOr(left, right), resultType);
            case BoundBinaryOperatorKind.BitwiseXor:
                return NarrowToResultType(NumericXor(left, right), resultType);
            case BoundBinaryOperatorKind.BitClear:
                return NarrowToResultType(NumericAnd(left, OnesComplement(right)), resultType);
            case BoundBinaryOperatorKind.ShiftLeft:
                return NarrowToResultType(NumericShl(left, (int)right), resultType);
            case BoundBinaryOperatorKind.ShiftRight:
                return NarrowToResultType(NumericShr(left, (int)right), resultType);
            case BoundBinaryOperatorKind.Less:
                return NumericCompare(left, right) < 0;
            case BoundBinaryOperatorKind.LessOrEquals:
                return NumericCompare(left, right) <= 0;
            case BoundBinaryOperatorKind.Greater:
                return NumericCompare(left, right) > 0;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                return NumericCompare(left, right) >= 0;
            default:
                throw new EvaluatorException($"Unexpected binary operator {b.Op}", b);
        }
    }

    private static object NumericAdd(object l, object r) => l switch
    {
        int li when r is int ri => li + ri,
        long li when r is long ri => li + ri,
        uint li when r is uint ri => li + ri,
        ulong li when r is ulong ri => li + ri,
        sbyte li when r is sbyte ri => li + ri,
        byte li when r is byte ri => li + ri,
        short li when r is short ri => li + ri,
        ushort li when r is ushort ri => li + ri,
        nint li when r is nint ri => li + ri,
        nuint li when r is nuint ri => li + ri,
        float li when r is float ri => li + ri,
        double li when r is double ri => li + ri,
        decimal li when r is decimal ri => li + ri,
        char li when r is char ri => li + ri,
        _ => throw new InvalidOperationException($"Unsupported + on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericSub(object l, object r) => l switch
    {
        int li when r is int ri => li - ri,
        long li when r is long ri => li - ri,
        uint li when r is uint ri => li - ri,
        ulong li when r is ulong ri => li - ri,
        sbyte li when r is sbyte ri => li - ri,
        byte li when r is byte ri => li - ri,
        short li when r is short ri => li - ri,
        ushort li when r is ushort ri => li - ri,
        nint li when r is nint ri => li - ri,
        nuint li when r is nuint ri => li - ri,
        float li when r is float ri => li - ri,
        double li when r is double ri => li - ri,
        decimal li when r is decimal ri => li - ri,
        _ => throw new InvalidOperationException($"Unsupported - on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericMul(object l, object r) => l switch
    {
        int li when r is int ri => li * ri,
        long li when r is long ri => li * ri,
        uint li when r is uint ri => li * ri,
        ulong li when r is ulong ri => li * ri,
        sbyte li when r is sbyte ri => li * ri,
        byte li when r is byte ri => li * ri,
        short li when r is short ri => li * ri,
        ushort li when r is ushort ri => li * ri,
        nint li when r is nint ri => li * ri,
        nuint li when r is nuint ri => li * ri,
        float li when r is float ri => li * ri,
        double li when r is double ri => li * ri,
        decimal li when r is decimal ri => li * ri,
        _ => throw new InvalidOperationException($"Unsupported * on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericDiv(object l, object r) => l switch
    {
        int li when r is int ri => li / ri,
        long li when r is long ri => li / ri,
        uint li when r is uint ri => li / ri,
        ulong li when r is ulong ri => li / ri,
        sbyte li when r is sbyte ri => li / ri,
        byte li when r is byte ri => li / ri,
        short li when r is short ri => li / ri,
        ushort li when r is ushort ri => li / ri,
        nint li when r is nint ri => li / ri,
        nuint li when r is nuint ri => li / ri,
        float li when r is float ri => li / ri,
        double li when r is double ri => li / ri,
        decimal li when r is decimal ri => li / ri,
        _ => throw new InvalidOperationException($"Unsupported / on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericMod(object l, object r) => l switch
    {
        int li when r is int ri => li % ri,
        long li when r is long ri => li % ri,
        uint li when r is uint ri => li % ri,
        ulong li when r is ulong ri => li % ri,
        sbyte li when r is sbyte ri => li % ri,
        byte li when r is byte ri => li % ri,
        short li when r is short ri => li % ri,
        ushort li when r is ushort ri => li % ri,
        nint li when r is nint ri => li % ri,
        nuint li when r is nuint ri => li % ri,
        float li when r is float ri => li % ri,
        double li when r is double ri => li % ri,
        decimal li when r is decimal ri => li % ri,
        _ => throw new InvalidOperationException($"Unsupported % on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericAnd(object l, object r) => l switch
    {
        int li when r is int ri => li & ri,
        long li when r is long ri => li & ri,
        uint li when r is uint ri => li & ri,
        ulong li when r is ulong ri => li & ri,
        sbyte li when r is sbyte ri => li & ri,
        byte li when r is byte ri => li & ri,
        short li when r is short ri => li & ri,
        ushort li when r is ushort ri => li & ri,
        nint li when r is nint ri => li & ri,
        nuint li when r is nuint ri => li & ri,
        _ => throw new InvalidOperationException($"Unsupported & on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericOr(object l, object r) => l switch
    {
        int li when r is int ri => li | ri,
        long li when r is long ri => li | ri,
        uint li when r is uint ri => li | ri,
        ulong li when r is ulong ri => li | ri,
        sbyte li when r is sbyte ri => li | ri,
        byte li when r is byte ri => li | ri,
        short li when r is short ri => li | ri,
        ushort li when r is ushort ri => li | ri,
        nint li when r is nint ri => li | ri,
        nuint li when r is nuint ri => li | ri,
        _ => throw new InvalidOperationException($"Unsupported | on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NumericXor(object l, object r) => l switch
    {
        int li when r is int ri => li ^ ri,
        long li when r is long ri => li ^ ri,
        uint li when r is uint ri => li ^ ri,
        ulong li when r is ulong ri => li ^ ri,
        sbyte li when r is sbyte ri => li ^ ri,
        byte li when r is byte ri => li ^ ri,
        short li when r is short ri => li ^ ri,
        ushort li when r is ushort ri => li ^ ri,
        nint li when r is nint ri => li ^ ri,
        nuint li when r is nuint ri => li ^ ri,
        _ => throw new InvalidOperationException($"Unsupported ^ on {l?.GetType()} and {r?.GetType()}"),
    };

    // Issue #421 (P2-2): Go semantics for shift operations. The C# `<<` and
    // Issue #1232: G# shift semantics match C#/CLR. C#'s `<<`/`>>` operators
    // mask the shift count by the operand's stack width (`& 0x1F` for 32-bit
    // operands — including the sub-i4 types, which C# evaluates as int — and
    // `& 0x3F` for 64-bit operands); native-int operands mask to the runtime
    // pointer width. C#'s own `<<`/`>>` (used below) applies exactly this
    // masking, so the count is shifted directly with no range guard, matching
    // the emitter's bare `shl`/`shr` opcodes. (G# previously followed Go,
    // substituting zero when the count was >= the operand width.)
    private static object NumericShl(object l, int r) => l switch
    {
        int li => li << r,
        long li => li << r,
        uint li => li << r,
        ulong li => li << r,
        sbyte li => li << r,
        byte li => li << r,
        short li => li << r,
        ushort li => li << r,
        nint li => li << r,
        nuint li => li << r,
        _ => throw new InvalidOperationException($"Unsupported << on {l?.GetType()}"),
    };

    private static object NumericShr(object l, int r) => l switch
    {
        int li => li >> r,
        long li => li >> r,
        uint li => li >> r,
        ulong li => li >> r,
        sbyte li => li >> r,
        byte li => li >> r,
        short li => li >> r,
        ushort li => li >> r,
        nint li => li >> r,
        nuint li => li >> r,
        _ => throw new InvalidOperationException($"Unsupported >> on {l?.GetType()}"),
    };

    private static int NumericCompare(object l, object r) => l switch
    {
        int li when r is int ri => li.CompareTo(ri),
        long li when r is long ri => li.CompareTo(ri),
        uint li when r is uint ri => li.CompareTo(ri),
        ulong li when r is ulong ri => li.CompareTo(ri),
        sbyte li when r is sbyte ri => li.CompareTo(ri),
        byte li when r is byte ri => li.CompareTo(ri),
        short li when r is short ri => li.CompareTo(ri),
        ushort li when r is ushort ri => li.CompareTo(ri),
        nint li when r is nint ri => li.CompareTo(ri),
        nuint li when r is nuint ri => li.CompareTo(ri),
        float li when r is float ri => li.CompareTo(ri),
        double li when r is double ri => li.CompareTo(ri),
        decimal li when r is decimal ri => li.CompareTo(ri),
        char li when r is char ri => li.CompareTo(ri),
        _ => throw new InvalidOperationException($"Unsupported comparison on {l?.GetType()} and {r?.GetType()}"),
    };

    private static object NarrowToResultType(object value, TypeSymbol resultType)
    {
        // C# arithmetic on sub-int types promotes to int. To preserve the
        // operator's declared result type (e.g. byte + byte → byte) we
        // narrow back here. Other widths already match their CLR type.
        if (resultType == TypeSymbol.Int8)
        {
            return unchecked((sbyte)Convert.ToInt32(value));
        }

        if (resultType == TypeSymbol.UInt8)
        {
            return unchecked((byte)Convert.ToInt32(value));
        }

        if (resultType == TypeSymbol.Int16)
        {
            return unchecked((short)Convert.ToInt32(value));
        }

        if (resultType == TypeSymbol.UInt16)
        {
            return unchecked((ushort)Convert.ToInt32(value));
        }

        if (resultType == TypeSymbol.Char)
        {
            return unchecked((char)Convert.ToInt32(value));
        }

        // Issue #615: when the result type is an enum, produce a properly-typed
        // boxed enum value via Enum.ToObject. The arithmetic helpers return a
        // raw underlying integer; this converts it back to the declared enum type.
        if (resultType?.ClrType != null && resultType.ClrType.IsEnum)
        {
            return Enum.ToObject(resultType.ClrType, value);
        }

        return value;
    }

    /// <summary>
    /// Issue #615: converts a boxed CLR enum value to its underlying primitive
    /// (e.g. DayOfWeek.Monday → int 1) so that the pattern-matching arms in
    /// NumericAdd/Sub/Compare/OnesComplement etc. can match the value. Non-enum
    /// values pass through unchanged.
    /// </summary>
    private static object UnwrapEnumToUnderlying(object value)
    {
        if (value != null && value.GetType().IsEnum)
        {
            return Convert.ChangeType(value, Enum.GetUnderlyingType(value.GetType()));
        }

        return value;
    }

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
            if (random == null)
            {
                random = new Random();
            }

            return random.Next(max);
        }
        else
        {
            var locals = new Dictionary<VariableSymbol, object>();

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
                        userRefSlots ??= new List<(ParameterSymbol, BoundExpression)>();
                        userRefSlots.Add((parameter, addrOf.Operand));
                    }
                }
                else
                {
                    var value = EvaluateExpression(arg);
                    locals.Add(parameter, value);
                }
            }

            this.locals.Push(locals);

            var statement = program.Functions[node.Function];

            if (IsIteratorFunction(node.Function, statement))
            {
                var iteratorResult = EvaluateIteratorFunction(node.Function, statement);
                this.locals.Pop();
                return iteratorResult;
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
            EvaluateFunctionBody(body);
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
        var result = EvaluateFunctionBody(statement);
        locals.Pop();

        return result;
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
        var result = EvaluateFunctionBody(statement);
        locals.Pop();

        return result;
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
        var method = node.Method;

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
        var result = EvaluateFunctionBody(statement);
        locals.Pop();

        return result;
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
        if (resolvedImpl == null && slotIface != null)
        {
            foreach (var frame in locals)
            {
                foreach (var kv in frame)
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

        var frame2 = new Dictionary<VariableSymbol, object>();
        for (var i = 0; i < node.Arguments.Length; i++)
        {
            frame2[target.Parameters[i]] = evaluatedArgs[i];
        }

        locals.Push(frame2);
        var result = EvaluateFunctionBody(statement);
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
            return UncheckedNumericConvert(value, node.Type.ClrType);
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
                interfaceStaticFields[(fa.InterfaceType, fa.Field)] = value;
                return;
            }

            staticFields[(fa.StructType, fa.Field)] = value;
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
                staticFields[(pa.StructType, pa.Property.BackingField)] = value;
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
        foreach (var frame in locals)
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

        var chainFrame = new Dictionary<VariableSymbol, object>
        {
            [thisParam] = receiver,
        };

        for (var i = 0; i < targetCtor.Function.Parameters.Length; i++)
        {
            chainFrame[targetCtor.Function.Parameters[i]] = argValues[i];
        }

        locals.Push(chainFrame);
        try
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
        finally
        {
            locals.Pop();
        }

        return null;
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

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): sentinel stored in the locals dictionary
    /// for a ref-aliasing local. Reads of the local re-evaluate <see cref="Operand"/>;
    /// writes are routed back to <see cref="Operand"/> via <see cref="WriteBackToOperand"/>.
    /// </summary>
    private sealed class RefAlias
    {
        public RefAlias(Binding.BoundExpression operand)
        {
            Operand = operand;
        }

        public Binding.BoundExpression Operand { get; }
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
