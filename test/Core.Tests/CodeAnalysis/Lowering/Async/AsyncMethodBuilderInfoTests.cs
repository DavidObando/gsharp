// <copyright file="AsyncMethodBuilderInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Resolution of <see cref="AsyncMethodBuilderInfo"/> for the four BCL
/// builder shapes plus a custom <c>[AsyncMethodBuilder]</c> task-like
/// (<c>ValueTask&lt;T&gt;</c>).
/// </summary>
public class AsyncMethodBuilderInfoTests
{
    [Fact]
    public void Resolve_Void_BindsAsyncVoidMethodBuilder()
    {
        var info = AsyncMethodBuilderInfo.Resolve(typeof(void), resolver: null);
        Assert.NotNull(info);
        Assert.Equal(AsyncMethodBuilderKind.Void, info.Kind);
        Assert.Equal("System.Runtime.CompilerServices.AsyncVoidMethodBuilder", info.BuilderType.FullName);
        Assert.NotNull(info.CreateMethod);
        Assert.NotNull(info.StartMethod);
        Assert.Null(info.TaskProperty);
        Assert.True(info.IsValid);
    }

    [Fact]
    public void Resolve_Task_BindsAsyncTaskMethodBuilder()
    {
        var info = AsyncMethodBuilderInfo.Resolve(typeof(Task), resolver: null);
        Assert.NotNull(info);
        Assert.Equal(AsyncMethodBuilderKind.Task, info.Kind);
        Assert.Equal("System.Runtime.CompilerServices.AsyncTaskMethodBuilder", info.BuilderType.FullName);
        Assert.NotNull(info.TaskProperty);
        Assert.True(info.IsValid);
    }

    [Fact]
    public void Resolve_GenericTask_BindsAsyncTaskMethodBuilderOfT()
    {
        var info = AsyncMethodBuilderInfo.Resolve(typeof(Task<int>), resolver: null);
        Assert.NotNull(info);
        Assert.Equal(AsyncMethodBuilderKind.GenericTask, info.Kind);
        Assert.True(info.BuilderType.IsGenericType);
        Assert.Equal(typeof(int), info.ResultType);
        Assert.NotNull(info.TaskProperty);
        Assert.True(info.IsValid);
    }

    [Fact]
    public void Resolve_ValueTaskOfT_BindsCustomBuilderViaAttribute()
    {
        var info = AsyncMethodBuilderInfo.Resolve(typeof(ValueTask<string>), resolver: null);
        Assert.NotNull(info);
        Assert.Equal(AsyncMethodBuilderKind.Custom, info.Kind);
        Assert.Equal(typeof(string), info.ResultType);
        Assert.True(info.BuilderType.IsGenericType);
        Assert.Contains("AsyncValueTaskMethodBuilder", info.BuilderType.FullName);
        Assert.True(info.IsValid);
    }

    [Fact]
    public void Resolve_AsyncIteratorElement_BindsAsyncIteratorMethodBuilder()
    {
        var info = AsyncMethodBuilderInfo.Resolve(
            typeof(System.Collections.Generic.IAsyncEnumerable<int>),
            resolver: null);
        Assert.NotNull(info);
        Assert.Equal(AsyncMethodBuilderKind.AsyncIterator, info.Kind);
        Assert.Equal("System.Runtime.CompilerServices.AsyncIteratorMethodBuilder", info.BuilderType.FullName);
        Assert.Equal(typeof(int), info.ResultType);
        Assert.True(info.IsValid);
    }

    [Fact]
    public void Resolve_UnknownType_ReturnsNullForBuilder()
    {
        var info = AsyncMethodBuilderInfo.Resolve(typeof(object), resolver: null);
        Assert.Null(info);
    }
}
