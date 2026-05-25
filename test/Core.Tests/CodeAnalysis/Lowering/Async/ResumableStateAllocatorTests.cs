// <copyright file="ResumableStateAllocatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Lowering.Async;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class ResumableStateAllocatorTests
{
    [Fact]
    public void AllocateAwaitState_StartsAtFirstResumableAsyncState()
    {
        var allocator = new ResumableStateAllocator();

        var state = allocator.AllocateAwaitState();

        Assert.Equal(StateMachineStates.FirstResumableAsyncState, state);
    }

    [Fact]
    public void AllocateAwaitState_IncrementsMonotonically()
    {
        var allocator = new ResumableStateAllocator();

        var first = allocator.AllocateAwaitState();
        var second = allocator.AllocateAwaitState();
        var third = allocator.AllocateAwaitState();

        Assert.Equal(0, first);
        Assert.Equal(1, second);
        Assert.Equal(2, third);
        Assert.Equal(3, allocator.AwaitStateCount);
    }

    [Fact]
    public void AllocateYieldState_StartsBelowInitialAsyncIteratorState()
    {
        var allocator = new ResumableStateAllocator();

        var state = allocator.AllocateYieldState();

        Assert.Equal(StateMachineStates.InitialAsyncIteratorState - 1, state);
        Assert.Equal(StateMachineStates.FirstResumableAsyncIteratorState, state);
    }

    [Fact]
    public void AllocateYieldState_DecrementsMonotonically()
    {
        var allocator = new ResumableStateAllocator();

        var first = allocator.AllocateYieldState();
        var second = allocator.AllocateYieldState();
        var third = allocator.AllocateYieldState();

        Assert.Equal(-4, first);
        Assert.Equal(-5, second);
        Assert.Equal(-6, third);
        Assert.Equal(3, allocator.YieldStateCount);
    }

    [Fact]
    public void AwaitAndYieldRanges_AreIndependent()
    {
        var allocator = new ResumableStateAllocator();

        var await0 = allocator.AllocateAwaitState();
        var yield0 = allocator.AllocateYieldState();
        var await1 = allocator.AllocateAwaitState();
        var yield1 = allocator.AllocateYieldState();

        Assert.Equal(0, await0);
        Assert.Equal(1, await1);
        Assert.Equal(-4, yield0);
        Assert.Equal(-5, yield1);
        Assert.Equal(2, allocator.AwaitStateCount);
        Assert.Equal(2, allocator.YieldStateCount);
    }

    [Fact]
    public void ReservedStates_DoNotOverlapResumableRanges()
    {
        var allocator = new ResumableStateAllocator();

        var awaitState = allocator.AllocateAwaitState();
        var yieldState = allocator.AllocateYieldState();

        Assert.NotEqual(StateMachineStates.NotStartedOrRunningState, awaitState);
        Assert.NotEqual(StateMachineStates.FinishedState, awaitState);
        Assert.NotEqual(StateMachineStates.InitialAsyncIteratorState, awaitState);
        Assert.NotEqual(StateMachineStates.NotStartedOrRunningState, yieldState);
        Assert.NotEqual(StateMachineStates.FinishedState, yieldState);
        Assert.NotEqual(StateMachineStates.InitialAsyncIteratorState, yieldState);
    }
}
