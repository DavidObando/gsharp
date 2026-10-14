// <copyright file="AwaitableShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Lowering.Async
import System
import System.Runtime.CompilerServices
import System.Threading.Tasks
import Xunit

/// Resolution of (cref:AwaitableShape) for the BCL awaitable types.
open class AwaitableShapeTests {
    @Fact
    func Resolve_Task_BindsTaskAwaiter() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(Task))
        Assert.NotNull(shape)
        Assert.Equal("System.Runtime.CompilerServices.TaskAwaiter", shape!!.AwaiterType.FullName)
        Assert.Equal(typeof(Void), shape!!.ResultType)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_TaskOfT_BindsTypedAwaiter() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(Task[int32]))
        Assert.NotNull(shape)
        Assert.Equal(typeof(int32), shape!!.ResultType)
        Assert.True(shape!!.AwaiterType.IsGenericType)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_ValueTaskOfT_BindsValueTaskAwaiter() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(ValueTask[string]))
        Assert.NotNull(shape)
        Assert.Equal(typeof(string), shape!!.ResultType)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_YieldAwaitable_Binds() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(YieldAwaitable))
        Assert.NotNull(shape)
        Assert.Equal(typeof(Void), shape!!.ResultType)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_ValueTask_Binds() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(ValueTask))
        Assert.NotNull(shape)
        Assert.Equal(typeof(Void), shape!!.ResultType)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_ConfiguredTaskAwaitable_Binds() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(ConfiguredTaskAwaitable))
        Assert.NotNull(shape)
        Assert.Equal(typeof(Void), shape!!.ResultType)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_TypeWithoutGetAwaiter_DoesNotBind() {
        Assert.Null(AwaitableShape.Resolve(typeof(object)))
    }

    @Fact
    func Resolve_AwaiterMissingIsCompleted_DoesNotBind() {
        Assert.Null(AwaitableShape.Resolve(typeof(FakeNoIsCompleted)))
    }

    @Fact
    func Resolve_AwaiterMissingGetResult_DoesNotBind() {
        Assert.Null(AwaitableShape.Resolve(typeof(FakeNoGetResult)))
    }

    @Fact
    func Resolve_AwaiterImplementingICriticalNotifyCompletion_FlagSetTrue() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(Task))
        Assert.NotNull(shape)
        Assert.True(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_AwaiterImplementingOnlyINotifyCompletion_FlagSetFalse() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(FakeOnlyINotify))
        Assert.NotNull(shape)
        Assert.False(shape!!.ImplementsCriticalNotifyCompletion)
    }

    @Fact
    func Resolve_PlainObject_ReturnsNull() {
        Assert.Null(AwaitableShape.Resolve(typeof(object)))
    }

    // --- Test helper types ---
    open class FakeNoIsCompleted {
        func GetAwaiter() FakeNoIsCompletedAwaiter -> FakeNoIsCompletedAwaiter()

        open class FakeNoIsCompletedAwaiter : INotifyCompletion {
            func GetResult() { }

            func OnCompleted(continuation() -> void) { }
        }
    }

    open class FakeNoGetResult {
        func GetAwaiter() FakeNoGetResultAwaiter -> FakeNoGetResultAwaiter()

        open class FakeNoGetResultAwaiter : INotifyCompletion {
            prop IsCompleted bool -> true

            func OnCompleted(continuation() -> void) { }
        }
    }

    open class FakeOnlyINotify {
        func GetAwaiter() FakeOnlyINotifyAwaiter -> FakeOnlyINotifyAwaiter()

        open class FakeOnlyINotifyAwaiter : INotifyCompletion {
            prop IsCompleted bool -> true

            func GetResult() { }

            func OnCompleted(continuation() -> void) { }
        }
    }

    // --- Issue #607: transitive interface walk regression tests ---
    /// Proves that GetAwaiter inherited from a base interface is discovered
    /// after the migration to MemberLookup.SafeGetMethodIncludingSelfAndInterfaces.
    @Fact
    func Resolve_GetAwaiterInheritedFromBaseInterface_Resolves() {
        // IChildAwaitable inherits GetAwaiter from IBaseAwaitable but does
        // not redeclare it. Before the migration, a direct Type.GetMethod on
        // the interface would miss it.
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(IChildAwaitable))
        Assert.NotNull(shape)
        Assert.Equal(typeof(int32), shape!!.ResultType)
    }

    /// Proves that GetResult / IsCompleted inherited from a base interface
    /// on the awaiter type is discovered.
    @Fact
    func Resolve_AwaiterMembersInheritedFromBaseInterface_Resolves() {
        let shape AwaitableShape? = AwaitableShape.Resolve(typeof(InheritedAwaiterAwaitable))
        Assert.NotNull(shape)
        Assert.Equal(typeof(string), shape!!.ResultType)
    }

    // Helper types for transitive interface walk tests
    interface IBaseAwaitable {
        func GetAwaiter() InheritedAwaiter;
    }

    interface IChildAwaitable : IBaseAwaitable { }

    open class InheritedAwaiter : INotifyCompletion {
        prop IsCompleted bool -> true
        func GetResult() int32 -> 42

        func OnCompleted(continuation() -> void) { }
    }

    interface IBaseAwaiterContract {
        prop IsCompleted bool {
            get;
        }

        func GetResult() string;
    }

    interface IChildAwaiterContract : IBaseAwaiterContract, INotifyCompletion { }

    open class InheritedAwaiterAwaitable {
        func GetAwaiter() ChildAwaiterImpl -> ChildAwaiterImpl()
    }

    open class ChildAwaiterImpl : IChildAwaiterContract {
        prop IsCompleted bool -> true
        func GetResult() string -> "hello"

        func OnCompleted(continuation() -> void) { }
    }
}
