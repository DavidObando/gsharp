// <copyright file="AwaitableShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Resolution of <see cref="AwaitableShape"/> for the BCL awaitable types.
/// </summary>
public class AwaitableShapeTests
{
    [Fact]
    public void Resolve_Task_BindsTaskAwaiter()
    {
        var shape = AwaitableShape.Resolve(typeof(Task));
        Assert.NotNull(shape);
        Assert.Equal("System.Runtime.CompilerServices.TaskAwaiter", shape.AwaiterType.FullName);
        Assert.Equal(typeof(void), shape.ResultType);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_TaskOfT_BindsTypedAwaiter()
    {
        var shape = AwaitableShape.Resolve(typeof(Task<int>));
        Assert.NotNull(shape);
        Assert.Equal(typeof(int), shape.ResultType);
        Assert.True(shape.AwaiterType.IsGenericType);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_ValueTaskOfT_BindsValueTaskAwaiter()
    {
        var shape = AwaitableShape.Resolve(typeof(ValueTask<string>));
        Assert.NotNull(shape);
        Assert.Equal(typeof(string), shape.ResultType);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_PlainObject_ReturnsNull()
    {
        Assert.Null(AwaitableShape.Resolve(typeof(object)));
    }
}
