// <copyright file="Issue4909ThreadStaticStateTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Runtime.Channels.Tests

import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Reflection
import System.Threading
import Xunit

/// Issue #4909: the runtime's per-thread select state lives in `@ThreadStatic`
/// `shared` fields again (the bootstrap SDK that dropped the attribute, #4903,
/// forced a `ThreadLocal[T]` workaround until the pin carried the #4911 fix).
/// These tests pin both halves of that: the emitted metadata carries
/// `[ThreadStatic]` on every field, and each piece of state is really per-thread.
/// @remarks The metadata test also guards issue #4910: the SDK package's own copy of
/// `Gsharp.Runtime.Channels` (0.5.6, 0.5.7) still has the `ThreadLocal` fields, so if it
/// shadowed the in-tree build under test again the field lookups would fail.
///
/// Discrimination witnesses (ADR-0154, mutants applied by hand to
/// `src/Sdk/Gsharp.Runtime.Channels`): deleting `@ThreadStatic` from
/// `SelectWaiter.cache` breaks (cref:SelectWaiter_PooledWaiter_IsNotRentedByAnotherThread);
/// from `SelectRandom`'s generator fields breaks
/// (cref:SelectRandom_OtherThreadDraws_DoNotAdvanceThisThreadsGenerator); from
/// `InlineBudget.suppressions` breaks
/// (cref:InlineBudget_SuppressionOnOneThread_DoesNotSuppressAnother); each deletion
/// also breaks (cref:PerThreadFields_AreEmittedThreadStatic).
open class Issue4909ThreadStaticStateTests {
    @Fact
    func PerThreadFields_AreEmittedThreadStatic() {
        AssertThreadStatic(typeof(SelectWaiter), "cache", typeof(SelectWaiter))
        let random = typeof(SelectRandom)
        AssertThreadStatic(random, "s0", typeof(uint32))
        AssertThreadStatic(random, "s1", typeof(uint32))
        AssertThreadStatic(random, "s2", typeof(uint32))
        AssertThreadStatic(random, "s3", typeof(uint32))
        AssertThreadStatic(random, "seeded", typeof(bool))
        AssertThreadStatic(random, "buffer", typeof([]int32))
        let budget = typeof(InlineBudget)
        AssertThreadStatic(budget, "depth", typeof(int32))
        AssertThreadStatic(budget, "suppressions", typeof(int32))
    }

    @Fact
    func SelectWaiter_PooledWaiter_IsNotRentedByAnotherThread() {
        let first = SelectWaiter.Rent(0, CancellationToken.None)
        first.Return()
        // Control: the returned waiter really is pooled for this thread.
        let again = SelectWaiter.Rent(0, CancellationToken.None)
        Assert.Same(first, again)
        again.Return()

        var other SelectWaiter? = nil
        RunOnOtherThread(
            () -> {
                other = SelectWaiter.Rent(0, CancellationToken.None)
            }
        )
        Assert.NotNull(other)
        Assert.NotSame(first, other)
        // This thread's pool still holds its own waiter.
        let mine = SelectWaiter.Rent(0, CancellationToken.None)
        Assert.Same(first, mine)
        mine.Return()
    }

    @Fact
    func SelectRandom_OtherThreadDraws_DoNotAdvanceThisThreadsGenerator() {
        SelectRandom.Reseed(4909)
        let expected = List[int32]()
        for var i = 0; i < 16; i++ {
            expected.Add(SelectRandom.Next(1000000))
        }

        SelectRandom.Reseed(4909)
        let actual = List[int32]()
        for var i = 0; i < 8; i++ {
            actual.Add(SelectRandom.Next(1000000))
        }
        RunOnOtherThread(
            () -> {
                SelectRandom.Reseed(1)
                for var i = 0; i < 100; i++ {
                    SelectRandom.Next(1000000)
                }
            }
        )
        for var i = 0; i < 8; i++ {
            actual.Add(SelectRandom.Next(1000000))
        }
        Assert.Equal(expected, actual)
    }

    @Fact
    func InlineBudget_SuppressionOnOneThread_DoesNotSuppressAnother() {
        if InlineBudget.Limit == 0 {
            // GS_INLINE_DEPTH=0 disables inline publication everywhere.
            return
        }
        var otherEntered = false
        using let suppression = InlineBudget.Suppress()
        // Control: the suppression is in force on this thread.
        Assert.False(InlineBudget.TryEnter())
        RunOnOtherThread(
            () -> {
                if InlineBudget.TryEnter() {
                    otherEntered = true
                    InlineBudget.Exit()
                }
            }
        )
        Assert.True(otherEntered)
    }

    shared {
        private func AssertThreadStatic(owner Type, name string, fieldType Type) {
            let field = owner.GetField(name, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static)
            Assert.True(field != nil, "${owner.Name}.$name is not a static field of ${owner.Assembly.Location}")
            Assert.Equal(fieldType, field!!.FieldType)
            Assert.True(
                field!!.IsDefined(typeof(ThreadStaticAttribute), false),
                "${owner.Name}.$name carries no [ThreadStatic] in ${owner.Assembly.Location}"
            )
        }

        private func RunOnOtherThread(body Action) {
            var failure Exception? = nil
            let thread = Thread(
                () -> {
                    try {
                        body()
                    } catch (e Exception) {
                        failure = e
                    }
                }
            )
            thread.Start()
            thread.Join()
            if failure != nil {
                throw InvalidOperationException("The other thread failed.", failure)
            }
        }
    }
}
