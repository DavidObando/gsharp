// <copyright file="SequencesBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import Gsharp.Extensions.Sequences
import System
import System.Linq
import Xunit

/// Coverage for every static builder on (cref:Sequences).
open class SequencesBuilderTests {
    @Fact
    func Range_ProducesContiguousIntegers() {
        let result = Sequences.Range(10, 5).ToArray()
        Assert.Equal([]int32{10, 11, 12, 13, 14}, result)
    }

    @Fact
    func Range_ZeroCount_IsEmpty() {
        Assert.Empty(Sequences.Range(10, 0))
    }

    @Fact
    func Range_NegativeCount_Throws() {
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return Sequences.Range(0, -1).ToArray()
            }
        )
    }

    @Fact
    func RangeStep_PositiveStep_StopsBeforeEnd() {
        let result = Sequences.RangeStep(0, 10, 3).ToArray()
        Assert.Equal([]int32{0, 3, 6, 9}, result)
    }

    @Fact
    func RangeStep_NegativeStep_CountsDown() {
        let result = Sequences.RangeStep(10, 0, -3).ToArray()
        Assert.Equal([]int32{10, 7, 4, 1}, result)
    }

    @Fact
    func RangeStep_ZeroStep_Throws() {
        Assert.Throws[ArgumentException](
            func () object? {
                return Sequences.RangeStep(0, 10, 0).ToArray()
            }
        )
    }

    @Fact
    func RangeStep_EmptyWhenStartPastEnd() {
        Assert.Empty(Sequences.RangeStep(5, 5, 1))
        Assert.Empty(Sequences.RangeStep(5, 5, -1))
    }

    @Fact
    func Iterate_IsInfinite_TakeBounds() {
        let result = Sequences.Iterate(1, (n int32) -> n * 2).Take(5).ToArray()
        Assert.Equal([]int32{1, 2, 4, 8, 16}, result)
    }

    @Fact
    func Iterate_NullNext_Throws() {
        Assert.Throws[ArgumentNullException](
            func () object? {
                return Sequences.Iterate[int32](0, default((int32) -> int32)).Take(1).ToArray()
            }
        )
    }

    @Fact
    func Repeat_IsInfinite_TakeBounds() {
        let result = Sequences.Repeat("x").Take(3).ToArray()
        Assert.Equal([]string{"x", "x", "x"}, result)
    }

    @Fact
    func Of_PreservesOrder() {
        Assert.Equal([]int32{1, 2, 3}, Sequences.Of(1, 2, 3))
    }

    @Fact
    func Of_NoArguments_IsEmpty() {
        Assert.Empty(Sequences.Of[int32]())
    }

    @Fact
    func Empty_IsEmpty() {
        Assert.Empty(Sequences.Empty[int32]())
        Assert.Empty(Sequences.Empty[string]())
    }
}
