// <copyright file="ResumableStateAllocatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Lowering.Async
import Xunit

open class ResumableStateAllocatorTests {
    @Fact
    func AllocateAwaitState_StartsAtFirstResumableAsyncState() {
        let allocator = ResumableStateAllocator()
        let state = allocator.AllocateAwaitState()
        Assert.Equal(StateMachineStates.FirstResumableAsyncState, state)
    }

    @Fact
    func AllocateAwaitState_IncrementsMonotonically() {
        let allocator = ResumableStateAllocator()
        let first = allocator.AllocateAwaitState()
        let second = allocator.AllocateAwaitState()
        let third = allocator.AllocateAwaitState()
        Assert.Equal(0, first)
        Assert.Equal(1, second)
        Assert.Equal(2, third)
        Assert.Equal(3, allocator.AwaitStateCount)
    }

    @Fact
    func AllocateYieldState_StartsBelowInitialAsyncIteratorState() {
        let allocator = ResumableStateAllocator()
        let state = allocator.AllocateYieldState()
        Assert.Equal(StateMachineStates.InitialAsyncIteratorState - 1, state)
        Assert.Equal(StateMachineStates.FirstResumableAsyncIteratorState, state)
    }

    @Fact
    func AllocateYieldState_DecrementsMonotonically() {
        let allocator = ResumableStateAllocator()
        let first = allocator.AllocateYieldState()
        let second = allocator.AllocateYieldState()
        let third = allocator.AllocateYieldState()
        Assert.Equal(-4, first)
        Assert.Equal(-5, second)
        Assert.Equal(-6, third)
        Assert.Equal(3, allocator.YieldStateCount)
    }

    @Fact
    func AwaitAndYieldRanges_AreIndependent() {
        let allocator = ResumableStateAllocator()
        let await0 = allocator.AllocateAwaitState()
        let yield0 = allocator.AllocateYieldState()
        let await1 = allocator.AllocateAwaitState()
        let yield1 = allocator.AllocateYieldState()
        Assert.Equal(0, await0)
        Assert.Equal(1, await1)
        Assert.Equal(-4, yield0)
        Assert.Equal(-5, yield1)
        Assert.Equal(2, allocator.AwaitStateCount)
        Assert.Equal(2, allocator.YieldStateCount)
    }

    @Fact
    func ReservedStates_DoNotOverlapResumableRanges() {
        let allocator = ResumableStateAllocator()
        let awaitState = allocator.AllocateAwaitState()
        let yieldState = allocator.AllocateYieldState()
        Assert.NotEqual(StateMachineStates.NotStartedOrRunningState, awaitState)
        Assert.NotEqual(StateMachineStates.FinishedState, awaitState)
        Assert.NotEqual(StateMachineStates.InitialAsyncIteratorState, awaitState)
        Assert.NotEqual(StateMachineStates.NotStartedOrRunningState, yieldState)
        Assert.NotEqual(StateMachineStates.FinishedState, yieldState)
        Assert.NotEqual(StateMachineStates.InitialAsyncIteratorState, yieldState)
    }
}
