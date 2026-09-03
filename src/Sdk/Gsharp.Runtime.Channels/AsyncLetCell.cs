// <copyright file="AsyncLetCell.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The runtime half of <c>async let name = expr</c> (ADR-0174 D15): the cell a
/// spawned child reports its value to, and the thing <c>await name</c> reads.
/// </summary>
/// <remarks>
/// <para>The cell is a child of the enclosing <see cref="ScopeFrame"/> and
/// participates in its pending count, cancellation and failure aggregation
/// exactly as a <c>go</c> child does. It is never a user-visible value: the
/// binding names a result of type <c>R</c>, not a handle, which is what keeps
/// the pooled <c>ValueTask</c> builder usable — the compiler owns the
/// completion object, so it is consumed exactly once.</para>
/// <para>The class is deliberately <em>not</em> generic in the result: a
/// same-compilation result type has no reference-context CLR type, so a
/// generic cell would close over <see cref="object"/> in metadata while the
/// call site believed it was closed over the user's type. The type parameter
/// lives on <see cref="Run{TResult}(ValueTask{TResult})"/> and
/// <see cref="AwaitAsync{TResult}"/> instead, where the compiler's symbolic
/// method-type-argument machinery already carries it — the same shape
/// <c>ChannelOps</c> uses for a channel element.</para>
/// <para>Failure surfaces at the <c>await</c>. A binding that is never read has
/// its child cancelled at scope exit and joined; a failure the reader never saw
/// is folded into the scope's <see cref="ScopeException"/> rather than
/// dropped.</para>
/// </remarks>
public sealed class AsyncLetCell : IGoroutineSink
{
    private readonly ScopeFrame frame;
    private readonly TaskCompletionSource<object?> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int read;
    private int retired;

    private AsyncLetCell(ScopeFrame frame)
    {
        this.frame = frame;

        // The child's own context: cancelling it at scope exit unwinds an
        // unread child without disturbing its siblings.
        Context = frame.Context.WithCancel();
    }

    /// <inheritdoc/>
    public Context Context { get; }

    /// <summary>Gets a value indicating whether the binding has been read at least once. A diagnostic snapshot.</summary>
    public bool WasRead => Volatile.Read(ref read) != 0;

    /// <summary>Opens a cell owned by <paramref name="frame"/>.</summary>
    /// <param name="frame">The enclosing scope's frame.</param>
    /// <returns>The cell; the compiler queues a work item whose sink is it.</returns>
    public static AsyncLetCell Start(ScopeFrame frame)
        => new(frame ?? throw new ArgumentNullException(nameof(frame)));

    /// <inheritdoc/>
    public void Register() => frame.Register();

    /// <summary>
    /// Records a child that finished without depositing a value. The work item
    /// calls this after the body's <c>ValueTask</c> is consumed, by which time
    /// <c>Run</c> has normally already deposited the result; both paths retire
    /// the frame's registration exactly once.
    /// </summary>
    public void Complete()
    {
        completion.TrySetResult(null);
        Retire();
    }

    /// <inheritdoc/>
    public void Fail(Exception exception)
    {
        // The failure belongs to whoever reads the binding. If nobody does,
        // CancelIfUnreadAsync hands it back to the scope at exit — so the
        // frame's count is retired here, but its failure list is not touched,
        // and siblings are not cancelled. Catching a failed `async let` must
        // not kill the ones running beside it.
        completion.TrySetException(exception);
        Retire();
    }

    /// <summary>Runs a child whose body yields its result directly.</summary>
    /// <typeparam name="TResult">The child's result type.</typeparam>
    /// <param name="body">The child's already-computed result.</param>
    /// <returns>A completed task.</returns>
    public ValueTask Run<TResult>(TResult body)
    {
        Deposit(body);
        return default;
    }

    /// <summary>Runs a child whose body yields a <see cref="ValueTask{TResult}"/> — a suspending call.</summary>
    /// <typeparam name="TResult">The child's result type.</typeparam>
    /// <param name="body">The child's completion.</param>
    /// <returns>The child's completion, with the result deposited.</returns>
    public async ValueTask Run<TResult>(ValueTask<TResult> body) => Deposit(await body.ConfigureAwait(false));

    /// <summary>Runs a child whose body yields a <see cref="Task{TResult}"/> — an <c>async func</c> call.</summary>
    /// <typeparam name="TResult">The child's result type.</typeparam>
    /// <param name="body">The child's task.</param>
    /// <returns>The child's completion, with the result deposited.</returns>
    public async ValueTask Run<TResult>(Task<TResult> body) => Deposit(await body.ConfigureAwait(false));

    /// <summary>Reads the binding. The second and later reads return the completed value without suspending.</summary>
    /// <typeparam name="TResult">The child's result type.</typeparam>
    /// <returns>The child's result.</returns>
    public async ValueTask<TResult> AwaitAsync<TResult>()
    {
        Volatile.Write(ref read, 1);
        var value = await completion.Task.ConfigureAwait(false);

        // TResult is unconstrained: `default!` is its zero value, which is
        // what a child that deposited nothing is defined to yield.
        return value is null ? default! : (TResult)value;
    }

    /// <summary>
    /// The blocking form of <see cref="CancelIfUnreadAsync"/>, for the
    /// synthesized root that may block (ADR-0174 D4). The compiler emits this
    /// and the async lowering rewrites it, exactly as it does a scope's exit.
    /// </summary>
    public void CancelIfUnread() => CancelIfUnreadAsync().AsTask().GetAwaiter().GetResult();

    /// <summary>
    /// Scope exit: an unread binding's child is cancelled and joined, and a
    /// failure nobody saw is folded into the scope. Called once per cell, in
    /// the enclosing scope's cleanup, before the frame's own exit.
    /// </summary>
    /// <returns>A task that completes when the child has.</returns>
    public async ValueTask CancelIfUnreadAsync()
    {
        if (WasRead)
        {
            Context.Dispose();
            return;
        }

        Context.TryCancel();
        try
        {
            await completion.Task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The cancellation this method asked for is not a failure.
        }
        catch (Exception exception)
        {
            frame.RecordChildFailure(exception);
        }
        finally
        {
            Context.Dispose();
        }
    }

    private void Deposit(object? value)
    {
        completion.TrySetResult(value);
        Retire();
    }

    // The frame learns of this child exactly once, whichever path gets here
    // first: the body's own deposit, or the work item's completion call after
    // the body's ValueTask has been consumed.
    private void Retire()
    {
        if (Interlocked.Exchange(ref retired, 1) == 0)
        {
            frame.Complete();
        }
    }
}
