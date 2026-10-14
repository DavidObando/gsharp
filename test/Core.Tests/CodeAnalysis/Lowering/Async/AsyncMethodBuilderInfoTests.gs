// <copyright file="AsyncMethodBuilderInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Lowering.Async
import System
import System.Collections.Generic
import System.Threading.Tasks
import Xunit

/// Resolution of (cref:AsyncMethodBuilderInfo) for the four BCL
/// builder shapes plus a custom `[AsyncMethodBuilder]` task-like
/// (`ValueTask<T>`).
open class AsyncMethodBuilderInfoTests {
    @Fact
    func Resolve_Void_BindsAsyncVoidMethodBuilder() {
        let info AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(typeof(Void), resolver: nil)
        Assert.NotNull(info)
        Assert.Equal(AsyncMethodBuilderKind.Void, info!!.Kind)
        Assert.Equal("System.Runtime.CompilerServices.AsyncVoidMethodBuilder", info!!.BuilderType.FullName)
        Assert.NotNull(info!!.CreateMethod)
        Assert.NotNull(info!!.StartMethod)
        Assert.Null(info!!.TaskProperty)
        Assert.True(info!!.IsValid)
    }

    @Fact
    func Resolve_Task_BindsAsyncTaskMethodBuilder() {
        let info AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(typeof(Task), resolver: nil)
        Assert.NotNull(info)
        Assert.Equal(AsyncMethodBuilderKind.Task, info!!.Kind)
        Assert.Equal("System.Runtime.CompilerServices.AsyncTaskMethodBuilder", info!!.BuilderType.FullName)
        Assert.NotNull(info!!.TaskProperty)
        Assert.True(info!!.IsValid)
    }

    @Fact
    func Resolve_GenericTask_BindsAsyncTaskMethodBuilderOfT() {
        let info AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(typeof(Task[int32]), resolver: nil)
        Assert.NotNull(info)
        Assert.Equal(AsyncMethodBuilderKind.GenericTask, info!!.Kind)
        Assert.True(info!!.BuilderType.IsGenericType)
        Assert.Equal(typeof(int32), info!!.ResultType)
        Assert.NotNull(info!!.TaskProperty)
        Assert.True(info!!.IsValid)
    }

    @Fact
    func Resolve_ValueTaskOfT_BindsCustomBuilderViaAttribute() {
        let info AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(typeof(ValueTask[string]), resolver: nil)
        Assert.NotNull(info)
        Assert.Equal(AsyncMethodBuilderKind.Custom, info!!.Kind)
        Assert.Equal(typeof(string), info!!.ResultType)
        Assert.True(info!!.BuilderType.IsGenericType)
        Assert.Contains("AsyncValueTaskMethodBuilder", info!!.BuilderType.FullName)
        Assert.True(info!!.IsValid)
    }

    @Fact
    func Resolve_AsyncIteratorElement_BindsAsyncIteratorMethodBuilder() {
        let info AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(
            typeof(IAsyncEnumerable[int32]),
            resolver: nil
        )
        Assert.NotNull(info)
        Assert.Equal(AsyncMethodBuilderKind.AsyncIterator, info!!.Kind)
        Assert.Equal("System.Runtime.CompilerServices.AsyncIteratorMethodBuilder", info!!.BuilderType.FullName)
        Assert.Equal(typeof(int32), info!!.ResultType)
        Assert.True(info!!.IsValid)
    }

    @Fact
    func Resolve_UnknownType_ReturnsNullForBuilder() {
        let info AsyncMethodBuilderInfo? = AsyncMethodBuilderInfo.Resolve(typeof(object), resolver: nil)
        Assert.Null(info)
    }
}
