// <copyright file="Evaluator.Statements.cs" company="GSharp">
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
/// Issue #1361 partial of <see cref="Evaluator"/>: statement evaluation — blocks/labels, variable declarations, go/scope, await-for-range, expression statements, try/catch/throw.
/// See <c>Evaluator.cs</c> for the root partial (fields, constructor,
/// execution-state accessors, frame management, and the nested state types).
/// </summary>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private object EvaluateStatement(BoundBlockStatement body)
    {
        var labelToIndex = GetLabelToIndex(body);

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
            if (IsReturning)
            {
                return LastValue;
            }

            if (PendingGotoLabel != null)
            {
                if (labelToIndex.TryGetValue(PendingGotoLabel, out var pendIdx))
                {
                    PendingGotoLabel = null;
                    index = pendIdx;
                    continue;
                }

                return LastValue;
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
                        PendingGotoLabel = gs.Label;
                        return LastValue;
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
                            PendingGotoLabel = cgs.Label;
                            return LastValue;
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
                    LastValue = rs.Expression == null ? null : EvaluateExpression(rs.Expression);
                    IsReturning = true;
                    return LastValue;
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

        return LastValue;
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
        IsReturning = false;
        PendingGotoLabel = null;
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
            var locals = this.Locals.Peek();
            locals[node.Variable] = alias;

            // Mirror the read-through semantics for `lastValue` (used by REPL).
            LastValue = EvaluateExpression(refAddr.Operand);
            return;
        }

        var value = EvaluateExpression(node.Initializer);
        LastValue = value;
        Assign(node.Variable, value);
    }

    private void EvaluateGoStatement(BoundGoStatement node)
    {
        // Phase 5.3 / ADR-0022: fire-and-forget Task.Run by default.
        //
        // Issue #1651: the goroutine body used to run under a single
        // `goLock` shared with the spawning thread's own locals stack and
        // control-transfer flags (isReturning/pendingGotoLabel/lastValue).
        // That only serialized goroutines against EACH OTHER — the
        // spawning thread never took the lock and kept mutating the same
        // locals stack concurrently, so interleaved Push/Pop corrupted
        // frame resolution and a `return` inside the goroutine could flip
        // the spawner's isReturning/lastValue and make an unrelated
        // function return early with the goroutine's value.
        //
        // The fix gives the goroutine its own <see cref="ExecutionState"/>:
        // a clone of the CURRENT locals stack (same frame dictionaries, new
        // Stack container) so the goroutine still sees every variable its
        // closure captured, but its own calls push/pop frames without
        // touching the spawner's stack; and fresh control-transfer fields
        // so a `return`/`goto` inside it cannot leak out. Only genuine
        // interpreter globals (globals/static fields/iterator cache/random)
        // stay shared, guarded by <see cref="globalsLock"/>.
        //
        // Phase 5.7 / ADR-0022: when this `go` is lexically inside a `scope`,
        // register the resulting Task with the innermost scope frame so it can
        // be awaited at scope exit. Exceptions are not swallowed in that case;
        // the scope propagates them.
        //
        // Issue #1651 (follow-up): Task.Run's body is not guaranteed to run on
        // a brand-new thread. When the spawning thread later blocks on
        // Task.WhenAll(...).GetAwaiter().GetResult() waiting for this very
        // goroutine (or a sibling queued alongside it), the default
        // TaskScheduler is free to inline the queued goroutine body onto that
        // SAME blocked thread to avoid starving the pool. If the goroutine
        // lambda just assigns executionState.Value = goroutineState and never
        // restores it, an inlined run permanently clobbers the blocked
        // thread's own ExecutionState (its live ScopeFrames/Locals) with the
        // goroutine's fresh one, so control returns to code that still
        // believes it is running with its original frames pushed but is
        // actually looking at an empty ScopeFrames/Locals stack. Saving and
        // restoring the previous value — like a context switch — keeps the
        // blocked thread's state intact whether the goroutine runs on a new
        // thread or inline on this one.
        var expression = node.Expression;
        var goroutineState = CloneExecutionStateForGoroutine();
        var enclosingScope = ScopeFrames.Count > 0 ? ScopeFrames.Peek() : null;
        if (enclosingScope != null)
        {
            var task = Task.Run(() =>
            {
                var previousState = executionState.Value;
                executionState.Value = goroutineState;
                try
                {
                    EvaluateExpression(expression);
                }
                finally
                {
                    executionState.Value = previousState;
                }
            });
            enclosingScope.Tasks.Add(task);
            return;
        }

        Task.Run(() =>
        {
            var previousState = executionState.Value;
            executionState.Value = goroutineState;
            try
            {
                EvaluateExpression(expression);
            }
            catch
            {
                // Per ADR-0022 fire-and-forget: unhandled exceptions surface
                // through TaskScheduler.UnobservedTaskException; the interpreter
                // discards them rather than crashing the host.
            }
            finally
            {
                executionState.Value = previousState;
            }
        });
    }

    /// <summary>
    /// Issue #1651: builds the <see cref="ExecutionState"/> a spawned
    /// goroutine runs with. The locals stack is cloned (same frame
    /// dictionaries, new <see cref="Stack{T}"/> container) off the
    /// CALLING thread's current stack so the goroutine's closure still
    /// observes every captured variable — including later writes to it,
    /// matching Go's by-reference closure capture — while the goroutine's
    /// own Push/Pop for calls it makes cannot corrupt the caller's stack.
    /// Control-transfer flags and scope/iterator bookkeeping start fresh:
    /// they describe the dynamic extent of a single call chain and must
    /// not leak between the caller and the goroutine in either direction.
    /// </summary>
    private ExecutionState CloneExecutionStateForGoroutine()
    {
        // Stack<T>(IEnumerable<T>) pushes elements in enumeration order, and a
        // Stack<T> enumerates top-first — so cloning it directly would flip
        // top and bottom. Reversing the source enumeration before
        // reconstructing restores the original top-to-bottom order.
        var current = executionState.Value;
        return new ExecutionState
        {
            Locals = new Stack<ConcurrentDictionary<VariableSymbol, object>>(current.Locals.Reverse()),
        };
    }

    private void EvaluateScopeStatement(BoundScopeStatement node)
    {
        // Phase 5.7 / ADR-0022: structured concurrency. Spawned `go` tasks
        // inside the body register with the frame we just pushed; the
        // body runs to completion, then we await all registered tasks.
        // First failure wins (rethrown); the remaining failures, if any,
        // are attached as AggregateException.InnerExceptions[1..].
        var frame = new ScopeFrame();
        ScopeFrames.Push(frame);
        try
        {
            EvaluateStatement((BoundBlockStatement)node.Body);
        }
        finally
        {
            ScopeFrames.Pop();
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

        var cancellationToken = ScopeFrames.Count > 0
            ? ScopeFrames.Peek().Cts.Token
            : System.Threading.CancellationToken.None;

        MethodInfo getEnumerator;
        object[] getEnumeratorArgs;
        MethodInfo moveNextAsync;
        MemberInfo currentMember;
        if (asyncEnumerableInterface != null)
        {
            // Fast path: the type implements `IAsyncEnumerable[T]`.
            getEnumerator = asyncEnumerableInterface.GetMethod(
                "GetAsyncEnumerator",
                new[] { typeof(System.Threading.CancellationToken) });
            getEnumeratorArgs = new object[] { cancellationToken };

            var enumeratorInterface = typeof(System.Collections.Generic.IAsyncEnumerator<>)
                .MakeGenericType(asyncEnumerableInterface.GetGenericArguments()[0]);
            moveNextAsync = enumeratorInterface.GetMethod("MoveNextAsync", Type.EmptyTypes);
            currentMember = enumeratorInterface.GetProperty("Current");
        }
        else if (MemberLookup.TryResolveClrPatternAsyncEnumerator(streamType, out var patternGetEnumerator, out var patternMoveNextAsync, out var patternCurrentMember))
        {
            // Issue #2280: the duck-typed `await foreach` pattern — a
            // public instance `GetAsyncEnumerator(...)` independent of any
            // interface, e.g. `ConfiguredCancelableAsyncEnumerable[T]`
            // (returned by `IAsyncEnumerable[T].ConfigureAwait(false)`),
            // which implements no interfaces at all.
            getEnumerator = patternGetEnumerator;
            getEnumeratorArgs = getEnumerator.GetParameters().Length == 0
                ? Array.Empty<object>()
                : new object[] { cancellationToken };
            moveNextAsync = patternMoveNextAsync;
            currentMember = patternCurrentMember;
        }
        else
        {
            throw new EvaluatorException(
                $"'await for' operand of CLR type '{streamType}' does not implement IAsyncEnumerable<T> and exposes no pattern-based GetAsyncEnumerator.",
                node);
        }

        var enumerator = getEnumerator.Invoke(stream, getEnumeratorArgs);
        if (enumerator == null)
        {
            throw new EvaluatorException("'await for' GetAsyncEnumerator returned null.", node);
        }

        // Issue #2280: `DisposeAsync` may be reached through
        // `IAsyncDisposable` (the common case for compiler-generated
        // iterators), or — for a fully duck-typed enumerator — as a plain
        // public instance method found directly on the enumerator's runtime
        // type. Per the C# spec, when neither shape is present no
        // disposal is performed.
        var enumeratorClrType = enumerator.GetType();
        MethodInfo disposeAsync = typeof(System.IAsyncDisposable).IsAssignableFrom(enumeratorClrType)
            ? typeof(System.IAsyncDisposable).GetMethod("DisposeAsync", Type.EmptyTypes)
            : enumeratorClrType.GetMethod(
                "DisposeAsync",
                BindingFlags.Instance | BindingFlags.Public,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null);

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

                var current = currentMember switch
                {
                    PropertyInfo currentProperty => currentProperty.GetValue(enumerator),
                    FieldInfo currentField => currentField.GetValue(enumerator),
                    _ => throw new EvaluatorException("'await for' Current member has an unsupported shape.", node),
                };
                Assign(node.ValueVariable, current);
                EvaluateStatement((BoundBlockStatement)node.Body);

                // Issue #937: honor `break`/`continue` (lowered to gotos that
                // target this loop's break/continue labels) and labeled
                // gotos / returns that escape the body. A pending goto to
                // this loop's continue label advances to the next element;
                // a goto to this loop's break label (or a plain return)
                // exits the loop; any other pending goto belongs to an
                // enclosing loop and is left parked so it propagates.
                if (PendingGotoLabel != null && PendingGotoLabel == node.ContinueLabel)
                {
                    PendingGotoLabel = null;
                    continue;
                }

                if (IsReturning || PendingGotoLabel != null)
                {
                    if (PendingGotoLabel == node.BreakLabel)
                    {
                        PendingGotoLabel = null;
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
        // Works uniformly for `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`,
        // and any `ConfigureAwait(...)`-flavored awaitable
        // (`ConfiguredTaskAwaitable(<T>)` / `ConfiguredValueTaskAwaitable(<T>)`).
        //
        // Issue #2303: this previously converted `ValueTask`-shaped operands
        // to a real `Task` via `AsTask()` before blocking — but
        // `ConfiguredValueTaskAwaitable(<T>)` (the type returned by
        // `IAsyncEnumerable[T].ConfigureAwait(false)` and used pervasively by
        // the `await for` pattern-based path, #2280) has no `AsTask` method,
        // so its awaiter's `GetResult()` was invoked directly. Per the
        // `IValueTaskSource` contract, `GetResult()` on such an awaiter is
        // only valid once the operation has actually completed; calling it
        // eagerly is a race — `ConfigureAwait(false)` lets the antecedent's
        // continuation resume on any thread-pool thread, so `GetResult()`
        // could run before that continuation reached its `yield`/completion,
        // throwing `InvalidOperationException` intermittently. Instead,
        // check `IsCompleted` first and, if not yet done, block on a
        // completion signal registered via `OnCompleted`/`UnsafeOnCompleted`
        // — the spec-mandated awaiter pattern — before calling `GetResult()`.
        if (valueTask == null)
        {
            return null;
        }

        var awaiter = valueTask.GetType().GetMethod("GetAwaiter", Type.EmptyTypes)?.Invoke(valueTask, null);
        if (awaiter == null)
        {
            return null;
        }

        var awaiterType = awaiter.GetType();
        var isCompletedProperty = awaiterType.GetProperty("IsCompleted");
        var isCompleted = isCompletedProperty != null && (bool)isCompletedProperty.GetValue(awaiter);
        if (!isCompleted)
        {
            using var completed = new ManualResetEventSlim(false);
            var onCompletedMethod = awaiterType.GetMethod("UnsafeOnCompleted", new[] { typeof(Action) })
                ?? awaiterType.GetMethod("OnCompleted", new[] { typeof(Action) });
            Action continuation = () => completed.Set();
            onCompletedMethod?.Invoke(awaiter, new object[] { continuation });
            completed.Wait();
        }

        var getResult = awaiterType.GetMethod("GetResult", Type.EmptyTypes);
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
        LastValue = EvaluateExpression(node.Expression);
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

            // Issue #1649: bind the handler variable to the REAL exception object,
            // not the EvaluatorException wrapper that EvaluateExpression attaches
            // for node context. Without this, `e is T`, typeof(e), and rethrow all
            // observe the wrapper instead of the exception the user actually threw.
            Assign(handler.Variable, UnwrapRuntimeException(ex));
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
                var savedReturning = IsReturning;
                var savedGoto = PendingGotoLabel;
                IsReturning = false;
                PendingGotoLabel = null;

                EvaluateStatement((BoundBlockStatement)node.FinallyBlock);

                if (!IsReturning && PendingGotoLabel == null)
                {
                    IsReturning = savedReturning;
                    PendingGotoLabel = savedGoto;
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

    /// <summary>
    /// Issue #1649: EvaluateExpression wraps every non-EvaluatorException in an
    /// EvaluatorException to attach node context (for GS9999 reporting when
    /// nothing catches it). That wrapping must not leak into typed catch
    /// matching or handler-variable binding, so unwrap repeatedly down to the
    /// innermost real exception. TargetInvocationException (thrown by
    /// reflection-based CLR calls) gets the same treatment.
    /// </summary>
    private static Exception UnwrapRuntimeException(Exception ex)
    {
        while (true)
        {
            if (ex is EvaluatorException { InnerException: { } inner })
            {
                ex = inner;
                continue;
            }

            if (ex is TargetInvocationException { InnerException: { } tieInner })
            {
                ex = tieInner;
                continue;
            }

            return ex;
        }
    }

    private static bool TryFindCatchHandler(BoundTryStatement node, Exception ex, out BoundCatchClause matched)
    {
        var actualType = UnwrapRuntimeException(ex).GetType();
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
}
