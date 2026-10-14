// <copyright file="SequenceExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import Gsharp.Extensions.Sequences
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Coverage for transformers, terminals, and collectors in
/// (cref:SequenceExtensions).
open class SequenceExtensionsTests {
    // ---- Windowed ----------------------------------------------------------
    @Fact
    func Windowed_SlidesByOne() {
        let w = []int32{1, 2, 3, 4}.Windowed(2).Select((a IList[int32]) -> string.Join(",", a)).ToArray()
        Assert.Equal([]string{"1,2", "2,3", "3,4"}, w)
    }

    @Fact
    func Windowed_TooShort_IsEmpty() {
        Assert.Empty([]int32{1, 2}.Windowed(3))
    }

    @Fact
    func Windowed_Empty_IsEmpty() {
        Assert.Empty(Sequences.Empty[int32]().Windowed(2))
    }

    @Fact
    func Windowed_NonPositiveSize_Throws() {
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return []int32{1}.Windowed(0).ToArray()
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return []int32{1}.Windowed(-1).ToArray()
            }
        )
    }

    @Fact
    func Windowed_OnInfinite_TakeBounds() {
        let w = Sequences
            .Iterate(1, (n int32) -> n + 1)
            .Windowed(3)
            .Take(3)
            .Select((a IList[int32]) -> string.Join(",", a))
            .ToArray()
        Assert.Equal([]string{"1,2,3", "2,3,4", "3,4,5"}, w)
    }

    // ---- Chunked -----------------------------------------------------------
    @Fact
    func Chunked_GroupsByFixedSize() {
        let c = []int32{1, 2, 3, 4, 5}.Chunked(2).Select((a IList[int32]) -> string.Join(",", a)).ToArray()
        Assert.Equal([]string{"1,2", "3,4", "5"}, c)
    }

    @Fact
    func Chunked_Empty_IsEmpty() {
        Assert.Empty(Sequences.Empty[int32]().Chunked(2))
    }

    @Fact
    func Chunked_NonPositiveSize_Throws() {
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return []int32{1}.Chunked(0).ToArray()
            }
        )
    }

    // ---- Indexed -----------------------------------------------------------
    @Fact
    func Indexed_AssignsZeroBasedIndices() {
        let i = []string{"a", "b", "c"}.Indexed().ToArray()
        Assert.Equal([](int32, string){(0, "a"), (1, "b"), (2, "c")}, i)
    }

    @Fact
    func Indexed_Empty_IsEmpty() {
        Assert.Empty(Sequences.Empty[int32]().Indexed())
    }

    // ---- Pairwise ----------------------------------------------------------
    @Fact
    func Pairwise_AdjacentPairs() {
        let p = []int32{1, 2, 3}.Pairwise().ToArray()
        Assert.Equal([](int32, int32){(1, 2), (2, 3)}, p)
    }

    @Fact
    func Pairwise_LessThanTwo_IsEmpty() {
        Assert.Empty([]int32{1}.Pairwise())
        Assert.Empty(Sequences.Empty[int32]().Pairwise())
    }

    // ---- Interleave --------------------------------------------------------
    @Fact
    func Interleave_AlternatesFromBothSources() {
        let seq = []int32{1, 2, 3}.Interleave([]int32{10, 20, 30}).ToArray()
        Assert.Equal([]int32{1, 10, 2, 20, 3, 30}, seq)
    }

    @Fact
    func Interleave_StopsAtShorter() {
        let seq = []int32{1, 2, 3, 4}.Interleave([]int32{10, 20}).ToArray()
        Assert.Equal([]int32{1, 10, 2, 20, 3, 4}, seq)
    }

    @Fact
    func Interleave_EmptyOther_YieldsSourceUnchanged() {
        let seq = []int32{1, 2}.Interleave(Sequences.Empty[int32]()).ToArray()
        Assert.Equal([]int32{1, 2}, seq)
    }

    // ---- FirstOrNil (class and struct receiver overloads) ------------------
    @Fact
    func FirstOrNil_RefReceiver_NonEmpty_ReturnsHead() {
        Assert.Equal("a", []string{"a", "b"}.FirstOrNil())
    }

    @Fact
    func FirstOrNil_RefReceiver_Empty_ReturnsNull() {
        Assert.Null(Sequences.Empty[string]().FirstOrNil())
    }

    @Fact
    func FirstOrNil_ValueReceiver_NonEmpty_ReturnsHead() {
        // ADR-0088 / issue #750: constraint-aware overload resolution lets
        // both the `where T : class` and `where T : struct` overloads share
        // the `FirstOrNil` name; the binder picks the struct overload here.
        Assert.Equal(int32?(11), []int32{11, 22}.FirstOrNil())
    }

    @Fact
    func FirstOrNil_ValueReceiver_Empty_ReturnsNull() {
        Assert.Null(Sequences.Empty[int32]().FirstOrNil())
    }

    @Fact
    func FirstOrNil_ValueReceiver_OnInfinite_DoesNotEnumerateAll() {
        Assert.Equal(int32?(1), Sequences.Iterate(1, (n int32) -> n + 1).FirstOrNil())
    }

    // ---- LastOrNil (class and struct receiver overloads) -------------------
    @Fact
    func LastOrNil_RefReceiver_NonEmpty_ReturnsTail() {
        Assert.Equal("b", []string{"a", "b"}.LastOrNil())
    }

    @Fact
    func LastOrNil_RefReceiver_Empty_ReturnsNull() {
        Assert.Null(Sequences.Empty[string]().LastOrNil())
    }

    @Fact
    func LastOrNil_ValueReceiver_NonEmpty_ReturnsTail() {
        Assert.Equal(int32?(33), []int32{11, 22, 33}.LastOrNil())
    }

    @Fact
    func LastOrNil_ValueReceiver_Empty_ReturnsNull() {
        Assert.Null(Sequences.Empty[int32]().LastOrNil())
    }

    // ---- SingleOrNil (class and struct receiver overloads) -----------------
    @Fact
    func SingleOrNil_RefReceiver_OneElement_Returns() {
        Assert.Equal("solo", []string{"solo"}.SingleOrNil())
    }

    @Fact
    func SingleOrNil_RefReceiver_EmptyOrMany_ReturnsNull() {
        Assert.Null(Sequences.Empty[string]().SingleOrNil())
        Assert.Null([]string{"a", "b"}.SingleOrNil())
    }

    @Fact
    func SingleOrNil_ValueReceiver_OneElement_Returns() {
        Assert.Equal(int32?(42), []int32{42}.SingleOrNil())
    }

    @Fact
    func SingleOrNil_ValueReceiver_EmptyOrMany_ReturnsNull() {
        Assert.Null(Sequences.Empty[int32]().SingleOrNil())
        Assert.Null([]int32{1, 2}.SingleOrNil())
    }

    // ---- ToSlice / ToMap ---------------------------------------------------
    @Fact
    func ToSlice_MaterializesArray() {
        let arr = Sequences.Range(1, 3).ToSlice()
        Assert.Equal([]int32{1, 2, 3}, arr)
        Assert.IsType[[]int32](arr)
    }

    @Fact
    func ToMap_FromTupleSequence_ProducesDictionary() {
        let d = [](string, int32){("a", 1), ("b", 2)}.ToMap()
        Assert.Equal(1, d["a"])
        Assert.Equal(2, d["b"])
    }

    @Fact
    func ToMap_DuplicateKeys_Throws() {
        Assert.Throws[ArgumentException](
            func () object? {
                return [](string, int32){("a", 1), ("a", 2)}.ToMap()
            }
        )
    }

    @Fact
    func ToMap_WithKeyAndValueSelectors_ProducesDictionary() {
        let words = []string{"alpha", "beta"}
        let d = words.ToMap(
            func (s string) string {
                return s[0 .. 1]
            },
            (s string) -> s.Length
        )
        Assert.Equal(5, d["a"])
        Assert.Equal(4, d["b"])
    }
}
