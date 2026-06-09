// <copyright file="AwaitableShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;
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
    public void Resolve_YieldAwaitable_Binds()
    {
        var shape = AwaitableShape.Resolve(typeof(YieldAwaitable));
        Assert.NotNull(shape);
        Assert.Equal(typeof(void), shape.ResultType);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_ValueTask_Binds()
    {
        var shape = AwaitableShape.Resolve(typeof(ValueTask));
        Assert.NotNull(shape);
        Assert.Equal(typeof(void), shape.ResultType);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_ConfiguredTaskAwaitable_Binds()
    {
        var shape = AwaitableShape.Resolve(typeof(ConfiguredTaskAwaitable));
        Assert.NotNull(shape);
        Assert.Equal(typeof(void), shape.ResultType);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_TypeWithoutGetAwaiter_DoesNotBind()
    {
        Assert.Null(AwaitableShape.Resolve(typeof(object)));
    }

    [Fact]
    public void Resolve_AwaiterMissingIsCompleted_DoesNotBind()
    {
        Assert.Null(AwaitableShape.Resolve(typeof(FakeNoIsCompleted)));
    }

    [Fact]
    public void Resolve_AwaiterMissingGetResult_DoesNotBind()
    {
        Assert.Null(AwaitableShape.Resolve(typeof(FakeNoGetResult)));
    }

    [Fact]
    public void Resolve_AwaiterImplementingICriticalNotifyCompletion_FlagSetTrue()
    {
        var shape = AwaitableShape.Resolve(typeof(Task));
        Assert.NotNull(shape);
        Assert.True(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_AwaiterImplementingOnlyINotifyCompletion_FlagSetFalse()
    {
        var shape = AwaitableShape.Resolve(typeof(FakeOnlyINotify));
        Assert.NotNull(shape);
        Assert.False(shape.ImplementsCriticalNotifyCompletion);
    }

    [Fact]
    public void Resolve_PlainObject_ReturnsNull()
    {
        Assert.Null(AwaitableShape.Resolve(typeof(object)));
    }

    // --- Test helper types ---

    public class FakeNoIsCompleted
    {
        public FakeNoIsCompletedAwaiter GetAwaiter() => new();

        public class FakeNoIsCompletedAwaiter : INotifyCompletion
        {
            public void GetResult() { }

            public void OnCompleted(System.Action continuation) { }
        }
    }

    public class FakeNoGetResult
    {
        public FakeNoGetResultAwaiter GetAwaiter() => new();

        public class FakeNoGetResultAwaiter : INotifyCompletion
        {
            public bool IsCompleted => true;

            public void OnCompleted(System.Action continuation) { }
        }
    }

    public class FakeOnlyINotify
    {
        public FakeOnlyINotifyAwaiter GetAwaiter() => new();

        public class FakeOnlyINotifyAwaiter : INotifyCompletion
        {
            public bool IsCompleted => true;

            public void GetResult() { }

            public void OnCompleted(System.Action continuation) { }
        }
    }

    // --- Issue #607: transitive interface walk regression tests ---

    /// <summary>
    /// Proves that GetAwaiter inherited from a base interface is discovered
    /// after the migration to MemberLookup.SafeGetMethodIncludingSelfAndInterfaces.
    /// </summary>
    [Fact]
    public void Resolve_GetAwaiterInheritedFromBaseInterface_Resolves()
    {
        // IChildAwaitable inherits GetAwaiter from IBaseAwaitable but does
        // not redeclare it. Before the migration, a direct Type.GetMethod on
        // the interface would miss it.
        var shape = AwaitableShape.Resolve(typeof(IChildAwaitable));
        Assert.NotNull(shape);
        Assert.Equal(typeof(int), shape.ResultType);
    }

    /// <summary>
    /// Proves that GetResult / IsCompleted inherited from a base interface
    /// on the awaiter type is discovered.
    /// </summary>
    [Fact]
    public void Resolve_AwaiterMembersInheritedFromBaseInterface_Resolves()
    {
        var shape = AwaitableShape.Resolve(typeof(InheritedAwaiterAwaitable));
        Assert.NotNull(shape);
        Assert.Equal(typeof(string), shape.ResultType);
    }

    // Helper types for transitive interface walk tests

    public interface IBaseAwaitable
    {
        InheritedAwaiter GetAwaiter();
    }

    public interface IChildAwaitable : IBaseAwaitable
    {
        // GetAwaiter is inherited — not redeclared here.
    }

    public class InheritedAwaiter : INotifyCompletion
    {
        public bool IsCompleted => true;

        public int GetResult() => 42;

        public void OnCompleted(System.Action continuation) { }
    }

    public interface IBaseAwaiterContract
    {
        bool IsCompleted { get; }

        string GetResult();
    }

    public interface IChildAwaiterContract : IBaseAwaiterContract, INotifyCompletion
    {
        // IsCompleted and GetResult are inherited from IBaseAwaiterContract.
    }

    public class InheritedAwaiterAwaitable
    {
        public ChildAwaiterImpl GetAwaiter() => new();
    }

    public class ChildAwaiterImpl : IChildAwaiterContract
    {
        public bool IsCompleted => true;

        public string GetResult() => "hello";

        public void OnCompleted(System.Action continuation) { }
    }
}
