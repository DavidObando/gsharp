// <copyright file="ArmDescriptor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// One arm of a <c>select</c> as recorded by <see cref="SelectWaiter.AddReceive{T}(Channel{T}, int)"/>
/// and friends: how to probe it under the gates, how to register it, and how
/// to tear the registration down when it loses.
/// </summary>
internal abstract class ArmDescriptor : IDisposable
{
    /// <summary>Initializes a new instance of the <see cref="ArmDescriptor"/> class.</summary>
    /// <param name="arm">The arm index.</param>
    protected ArmDescriptor(int arm)
    {
        Arm = arm;
    }

    /// <summary>Gets the arm index.</summary>
    internal int Arm { get; }

    /// <summary>Gets a value indicating whether the arm probes and registers under a shared gate (G# channels) rather than privately (timers) or lock-free (foreign channels, tasks).</summary>
    internal abstract bool RequiresGate { get; }

    /// <summary>Gets the gate, or null.</summary>
    internal abstract object? Gate { get; }

    /// <summary>Gets the gate's total-order key.</summary>
    internal abstract long Order { get; }

    /// <summary>Removes the registration; same as <see cref="Deregister"/>.</summary>
    public void Dispose() => Deregister();

    /// <summary>Probes with the gate held; on success the outcome has been deposited (a fault counts as success).</summary>
    /// <param name="waiter">The waiter to deposit into.</param>
    /// <param name="completions">Nodes claimed as a side effect.</param>
    /// <returns>True when the arm completed.</returns>
    internal abstract bool TryProbe(SelectWaiter waiter, ref Completions completions);

    /// <summary>Registers the arm (with the gate held when <see cref="RequiresGate"/>).</summary>
    /// <param name="waiter">The shared waiter.</param>
    /// <param name="generation">The waiter generation.</param>
    internal abstract void Register(SelectWaiter waiter, long generation);

    /// <summary>Removes the registration. Idempotent; takes whatever lock it needs.</summary>
    internal abstract void Deregister();
}

/// <summary>A receive arm over a runtime-owned selectable (a <see cref="Chan{T}"/> or a timer).</summary>
/// <typeparam name="T">The element type.</typeparam>
internal sealed class CoreReceiveArm<T> : ArmDescriptor
{
    private readonly ISelectableCore<T> selectable;
    private SelectNode<T>? node;

    /// <summary>Initializes a new instance of the <see cref="CoreReceiveArm{T}"/> class.</summary>
    /// <param name="selectable">The selectable.</param>
    /// <param name="arm">The arm index.</param>
    internal CoreReceiveArm(ISelectableCore<T> selectable, int arm)
        : base(arm)
    {
        this.selectable = selectable;
    }

    /// <inheritdoc/>
    internal override bool RequiresGate => selectable.SelectGate is not null;

    /// <inheritdoc/>
    internal override object? Gate => selectable.SelectGate;

    /// <inheritdoc/>
    internal override long Order => selectable.SelectOrder;

    /// <inheritdoc/>
    internal override bool TryProbe(SelectWaiter waiter, ref Completions completions)
    {
        if (!selectable.TryReceiveLocked(out var value, out var ok, ref completions))
        {
            return false;
        }

        waiter.Deposit(value, ok, needsReprobe: false);
        return true;
    }

    /// <inheritdoc/>
    internal override void Register(SelectWaiter waiter, long generation)
    {
        node = new SelectNode<T>(waiter, generation, Arm, selectable, isSend: false, default);
        selectable.RegisterReceiveLocked(node);
    }

    /// <inheritdoc/>
    internal override void Deregister()
    {
        if (node is { } registered)
        {
            node = null;
            selectable.Deregister(registered);
        }
    }
}

/// <summary>A send arm over a <see cref="Chan{T}"/>.</summary>
/// <typeparam name="T">The element type.</typeparam>
internal sealed class CoreSendArm<T> : ArmDescriptor
{
    private readonly ISendSelectableCore<T> selectable;
    private readonly T value;
    private SelectNode<T>? node;

    /// <summary>Initializes a new instance of the <see cref="CoreSendArm{T}"/> class.</summary>
    /// <param name="selectable">The selectable.</param>
    /// <param name="value">The value the arm offers.</param>
    /// <param name="arm">The arm index.</param>
    internal CoreSendArm(ISendSelectableCore<T> selectable, T value, int arm)
        : base(arm)
    {
        this.selectable = selectable;
        this.value = value;
    }

    /// <inheritdoc/>
    internal override bool RequiresGate => true;

    /// <inheritdoc/>
    internal override object? Gate => selectable.SelectGate;

    /// <inheritdoc/>
    internal override long Order => selectable.SelectOrder;

    /// <inheritdoc/>
    internal override bool TryProbe(SelectWaiter waiter, ref Completions completions)
    {
        try
        {
            return selectable.TrySendLocked(value, ref completions);
        }
        catch (ChannelClosedException closed)
        {
            // Go: a select that sends on a closed channel panics.
            waiter.DepositFault(closed);
            return true;
        }
    }

    /// <inheritdoc/>
    internal override void Register(SelectWaiter waiter, long generation)
    {
        node = new SelectNode<T>(waiter, generation, Arm, selectable, isSend: true, value);
        selectable.RegisterSendLocked(node);
    }

    /// <inheritdoc/>
    internal override void Deregister()
    {
        if (node is { } registered)
        {
            node = null;
            selectable.Deregister(registered);
        }
    }
}

/// <summary>
/// A receive arm over a foreign <see cref="ChannelReader{T}"/>. A public
/// reader exposes no reservation primitive, so the arm can only report
/// readiness: the select re-probes and may find the item taken (ADR-0174 D8).
/// </summary>
/// <typeparam name="T">The element type.</typeparam>
internal sealed class ForeignReceiveArm<T> : ArmDescriptor
{
    private readonly ChannelReader<T> reader;
    private CancellationTokenSource? cancellation;

    /// <summary>Initializes a new instance of the <see cref="ForeignReceiveArm{T}"/> class.</summary>
    /// <param name="reader">The foreign reader.</param>
    /// <param name="arm">The arm index.</param>
    internal ForeignReceiveArm(ChannelReader<T> reader, int arm)
        : base(arm)
    {
        this.reader = reader;
    }

    /// <inheritdoc/>
    internal override bool RequiresGate => false;

    /// <inheritdoc/>
    internal override object? Gate => null;

    /// <inheritdoc/>
    internal override long Order => 0;

    /// <inheritdoc/>
    internal override bool TryProbe(SelectWaiter waiter, ref Completions completions)
    {
        if (reader.TryRead(out var item))
        {
            waiter.Deposit(item, ok: true, needsReprobe: false);
            return true;
        }

        if (reader.Completion.IsCompleted)
        {
            waiter.Deposit(default(T), ok: false, needsReprobe: false);
            return true;
        }

        return false;
    }

    /// <inheritdoc/>
    internal override void Register(SelectWaiter waiter, long generation)
    {
        var completions = default(Completions);
        if (TryProbe(waiter, ref completions))
        {
            if (waiter.TryClaim(generation, Arm))
            {
                waiter.PublishOutcome();
            }

            return;
        }

        cancellation = new CancellationTokenSource();
        var readiness = reader.WaitToReadAsync(cancellation.Token);
        var arm = Arm;
        readiness.ConfigureAwait(false).GetAwaiter().UnsafeOnCompleted(() =>
        {
            if (!waiter.TryClaim(generation, arm))
            {
                return;
            }

            try
            {
                if (readiness.Result)
                {
                    waiter.Deposit(null, ok: true, needsReprobe: true);
                }
                else
                {
                    waiter.Deposit(default(T), ok: false, needsReprobe: false);
                }
            }
            catch (Exception exception)
            {
                waiter.DepositFault(exception);
            }

            waiter.PublishOutcome();
        });
    }

    /// <inheritdoc/>
    internal override void Deregister()
    {
        if (cancellation is { } pending)
        {
            cancellation = null;
            pending.Cancel();
            pending.Dispose();
        }
    }
}

/// <summary>A send arm over a foreign <see cref="ChannelWriter{T}"/>; readiness only, like <see cref="ForeignReceiveArm{T}"/>.</summary>
/// <typeparam name="T">The element type.</typeparam>
internal sealed class ForeignSendArm<T> : ArmDescriptor
{
    private readonly ChannelWriter<T> writer;
    private readonly T value;
    private CancellationTokenSource? cancellation;

    /// <summary>Initializes a new instance of the <see cref="ForeignSendArm{T}"/> class.</summary>
    /// <param name="writer">The foreign writer.</param>
    /// <param name="value">The value the arm offers.</param>
    /// <param name="arm">The arm index.</param>
    internal ForeignSendArm(ChannelWriter<T> writer, T value, int arm)
        : base(arm)
    {
        this.writer = writer;
        this.value = value;
    }

    /// <inheritdoc/>
    internal override bool RequiresGate => false;

    /// <inheritdoc/>
    internal override object? Gate => null;

    /// <inheritdoc/>
    internal override long Order => 0;

    /// <inheritdoc/>
    internal override bool TryProbe(SelectWaiter waiter, ref Completions completions)
    {
        if (writer.TryWrite(value))
        {
            waiter.Deposit(null, ok: true, needsReprobe: false);
            return true;
        }

        return false;
    }

    /// <inheritdoc/>
    internal override void Register(SelectWaiter waiter, long generation)
    {
        var completions = default(Completions);
        if (TryProbe(waiter, ref completions))
        {
            if (waiter.TryClaim(generation, Arm))
            {
                waiter.PublishOutcome();
            }

            return;
        }

        cancellation = new CancellationTokenSource();
        var readiness = writer.WaitToWriteAsync(cancellation.Token);
        var arm = Arm;
        readiness.ConfigureAwait(false).GetAwaiter().UnsafeOnCompleted(() =>
        {
            if (!waiter.TryClaim(generation, arm))
            {
                return;
            }

            try
            {
                if (readiness.Result)
                {
                    waiter.Deposit(null, ok: true, needsReprobe: true);
                }
                else
                {
                    waiter.DepositFault(new ChannelClosedException("send on closed channel"));
                }
            }
            catch (Exception exception)
            {
                waiter.DepositFault(exception);
            }

            waiter.PublishOutcome();
        });
    }

    /// <inheritdoc/>
    internal override void Deregister()
    {
        if (cancellation is { } pending)
        {
            cancellation = null;
            pending.Cancel();
            pending.Dispose();
        }
    }
}

/// <summary>A <c>case await task</c> arm.</summary>
internal class TaskArm : ArmDescriptor
{
    private readonly Task task;
    private CancellationTokenSource? cancellation;

    /// <summary>Initializes a new instance of the <see cref="TaskArm"/> class.</summary>
    /// <param name="task">The task.</param>
    /// <param name="arm">The arm index.</param>
    internal TaskArm(Task task, int arm)
        : base(arm)
    {
        this.task = task;
    }

    /// <inheritdoc/>
    internal override bool RequiresGate => false;

    /// <inheritdoc/>
    internal override object? Gate => null;

    /// <inheritdoc/>
    internal override long Order => 0;

    /// <inheritdoc/>
    internal override bool TryProbe(SelectWaiter waiter, ref Completions completions)
    {
        if (!task.IsCompleted)
        {
            return false;
        }

        DepositCompleted(waiter, task);
        return true;
    }

    /// <inheritdoc/>
    internal override void Register(SelectWaiter waiter, long generation)
    {
        var completions = default(Completions);
        if (TryProbe(waiter, ref completions))
        {
            if (waiter.TryClaim(generation, Arm))
            {
                waiter.PublishOutcome();
            }

            return;
        }

        cancellation = new CancellationTokenSource();
        var arm = Arm;
        task.ContinueWith(
            (completed, state) =>
            {
                // The state is the tuple this method passed to ContinueWith.
                var (self, w) = ((TaskArm, SelectWaiter))state!;
                if (!w.TryClaim(generation, arm))
                {
                    return;
                }

                self.DepositCompleted(w, completed);
                w.PublishOutcome();
            },
            (this, waiter),
            cancellation.Token,
            TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.DenyChildAttach,
            TaskScheduler.Default);
    }

    /// <inheritdoc/>
    internal override void Deregister()
    {
        // Removing the continuation is what keeps a long-running losing task
        // from retaining the waiter.
        if (cancellation is { } pending)
        {
            cancellation = null;
            pending.Cancel();
            pending.Dispose();
        }
    }

    /// <summary>Deposits a completed task's outcome.</summary>
    /// <param name="waiter">The waiter.</param>
    /// <param name="completed">The completed task.</param>
    protected virtual void DepositCompleted(SelectWaiter waiter, Task completed)
    {
        if (completed.IsCompletedSuccessfully)
        {
            waiter.Deposit(null, ok: true, needsReprobe: false);
        }
        else
        {
            waiter.DepositFault(Unwrap(completed));
        }
    }

    /// <summary>Extracts the exception a faulted or cancelled task carries.</summary>
    /// <param name="completed">The task.</param>
    /// <returns>The exception to surface.</returns>
    protected static Exception Unwrap(Task completed)
        => (Exception?)completed.Exception?.InnerException ?? (Exception?)completed.Exception ?? new TaskCanceledException(completed);
}

/// <summary>A <c>case let v = await task</c> arm.</summary>
/// <typeparam name="T">The task result type.</typeparam>
internal sealed class TaskArm<T> : TaskArm
{
    /// <summary>Initializes a new instance of the <see cref="TaskArm{T}"/> class.</summary>
    /// <param name="task">The task.</param>
    /// <param name="arm">The arm index.</param>
    internal TaskArm(Task<T> task, int arm)
        : base(task, arm)
    {
    }

    /// <inheritdoc/>
    protected override void DepositCompleted(SelectWaiter waiter, Task completed)
    {
        if (completed.IsCompletedSuccessfully)
        {
            waiter.Deposit(((Task<T>)completed).Result, ok: true, needsReprobe: false);
        }
        else
        {
            waiter.DepositFault(Unwrap(completed));
        }
    }
}
