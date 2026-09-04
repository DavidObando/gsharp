// <copyright file="Issue3902SelectAllocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using Gsharp.Concurrency;
using Xunit;

namespace GSharp.Runtime.Channels.Tests;

/// <summary>
/// Issue #3902 (S4): a <c>select</c> over G# channels allocates nothing in
/// steady state. Two costs were measured and both are removed here — an arm
/// descriptor per arm per select, and a box for every value-typed element the
/// winning arm delivered.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154). The mutants are, respectively,
/// restoring <c>arms.Add(new CoreReceiveArm&lt;T&gt;(…))</c> in place of the
/// slot reuse, and restoring <c>waiter.Deposit(value, …)</c> in place of
/// <c>DepositFrom</c> — each caught by
/// <see cref="ReadySelect_InSteadyState_AllocatesNothing"/>.
/// <para>
/// <see cref="ReusedSlot_OfADifferentShape_IsReplacedNotReinterpreted"/> is the
/// one that matters for correctness rather than cost: the waiter is
/// thread-cached and shared by every select on the thread, so a slot holding a
/// <c>CoreReceiveArm&lt;int&gt;</c> must not be handed to a select whose arm is
/// a different element type. The type test in <c>PlaceReceive</c> is what
/// prevents it; without it this reads a value at the wrong type.
/// </para>
/// <para>
/// Not covered here because it is covered better elsewhere: descriptor reuse is
/// exactly where a generation/ABA defect would hide, and
/// <c>SelectWaiterStressTests</c> is the suite that finds those.
/// </para>
/// </remarks>
public class Issue3902SelectAllocationTests
{
    [Fact]
    public void ReadySelect_InSteadyState_AllocatesNothing()
    {
        var a = new Chan<int>(1);
        var b = new Chan<int>(1);

        // Warm the thread-cached waiter, its arm slots and the JIT before
        // measuring; the first select on a thread legitimately allocates.
        var warm = Drain(a, b, 500);
        Assert.True(warm > 0, "the warm-up loop should have taken values");

        const int Selects = 20_000;
        var before = GC.GetTotalAllocatedBytes(precise: true);
        var taken = Drain(a, b, Selects);
        var perSelect = (GC.GetTotalAllocatedBytes(precise: true) - before) / (double)Selects;

        Assert.True(taken > 0, "the measured loop should have taken values");
#if DEBUG
        Assert.True(perSelect >= 0, "Debug builds do not carry a meaningful allocation number.");
#else
        Assert.True(
            perSelect < 12,
            $"expected a ready select to allocate ~nothing, measured {perSelect:F1} B/select. "
            + "Roughly 104 B means the arm descriptors are being allocated per select again; "
            + "a smaller excess means the winning value is boxing through SelectWaiter.Deposit "
            + "instead of DepositFrom (issue #3902 S4).");
#endif

        // No xunit assertions inside the measured loop: Assert.Equal allocates,
        // and an earlier version of this test measured 448 B/select of its own
        // making. Correctness of the same path is asserted by the other tests
        // in this class; here the loop only has to exercise it.
        static long Drain(Chan<int> a, Chan<int> b, int selects)
        {
            long observed = 0;
            for (var i = 0; i < selects; i++)
            {
                a.TrySend(i);
                b.TrySend(i);
                var w = SelectWaiter.Rent(2, CancellationToken.None);
                w.AddReceive(a, 0);
                w.AddReceive(b, 1);
                var won = w.TryNow();
                observed += w.TakeValue<int>() + won;
                w.Return();

                // The arm the select did not take keeps its buffered value, so
                // drain it to keep both channels at the same depth.
                var other = won == 0 ? b : a;
                other.TryReceive(out _, out _);
            }

            return observed;
        }
    }

    [Fact]
    public void ReusedSlot_OfADifferentShape_IsReplacedNotReinterpreted()
    {
        // Same thread, same waiter cache, different element types in slot 0.
        var ints = new Chan<int>(1);
        var strings = new Chan<string>(1);

        ints.TrySend(11);
        var first = SelectWaiter.Rent(1, CancellationToken.None);
        first.AddReceive(ints, 0);
        Assert.Equal(0, first.TryNow());
        Assert.Equal(11, first.TakeValue<int>());
        first.Return();

        strings.TrySend("eleven");
        var second = SelectWaiter.Rent(1, CancellationToken.None);
        second.AddReceive(strings, 0);
        Assert.Equal(0, second.TryNow());
        Assert.Equal("eleven", second.TakeValue<string>());
        second.Return();
    }

    [Fact]
    public async Task ParkedSelect_DeliversTheValueThroughTheTypedHandoff()
    {
        // The parked path deposits from SelectNode<T> rather than from the arm
        // descriptor, so it needs its own coverage.
        var a = new Chan<int>(0);
        var b = new Chan<int>(0);
        var w = SelectWaiter.Rent(2, CancellationToken.None);
        w.AddReceive(a, 0);
        w.AddReceive(b, 1);
        var wait = w.WaitAsync().AsTask();
        Assert.False(wait.IsCompleted);

        await b.SendAsync(77).AsTask().WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(1, await wait.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(w.Ok);
        Assert.Equal(77, w.TakeValue<int>());
        w.Return();
    }

    [Fact]
    public async Task ParkedSelect_OnClose_TakesTheZeroValueWithOkFalse()
    {
        var a = new Chan<int>(0);
        var w = SelectWaiter.Rent(1, CancellationToken.None);
        w.AddReceive(a, 0);
        var wait = w.WaitAsync().AsTask();

        a.Close();

        Assert.Equal(0, await wait.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.False(w.Ok);
        Assert.Equal(0, w.TakeValue<int>());
        w.Return();
    }
}
