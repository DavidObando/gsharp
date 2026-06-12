// <copyright file="SequenceExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Gsharp.Extensions.Sequences;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Coverage for transformers, terminals, and collectors in
/// <see cref="SequenceExtensions"/>.
/// </summary>
public class SequenceExtensionsTests
{
    // ---- Windowed ----------------------------------------------------------

    [Fact]
    public void Windowed_SlidesByOne()
    {
        var w = new[] { 1, 2, 3, 4 }.Windowed(2).Select(a => string.Join(",", a)).ToArray();
        Assert.Equal(new[] { "1,2", "2,3", "3,4" }, w);
    }

    [Fact]
    public void Windowed_TooShort_IsEmpty()
    {
        Assert.Empty(new[] { 1, 2 }.Windowed(3));
    }

    [Fact]
    public void Windowed_Empty_IsEmpty()
    {
        Assert.Empty(Sequences.Empty<int>().Windowed(2));
    }

    [Fact]
    public void Windowed_NonPositiveSize_Throws()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new[] { 1 }.Windowed(0).ToArray());
        Assert.Throws<ArgumentOutOfRangeException>(() => new[] { 1 }.Windowed(-1).ToArray());
    }

    [Fact]
    public void Windowed_OnInfinite_TakeBounds()
    {
        var w = Sequences.Iterate(1, n => n + 1).Windowed(3).Take(3)
            .Select(a => string.Join(",", a)).ToArray();
        Assert.Equal(new[] { "1,2,3", "2,3,4", "3,4,5" }, w);
    }

    // ---- Chunked -----------------------------------------------------------

    [Fact]
    public void Chunked_GroupsByFixedSize()
    {
        var c = new[] { 1, 2, 3, 4, 5 }.Chunked(2).Select(a => string.Join(",", a)).ToArray();
        Assert.Equal(new[] { "1,2", "3,4", "5" }, c);
    }

    [Fact]
    public void Chunked_Empty_IsEmpty()
    {
        Assert.Empty(Sequences.Empty<int>().Chunked(2));
    }

    [Fact]
    public void Chunked_NonPositiveSize_Throws()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new[] { 1 }.Chunked(0).ToArray());
    }

    // ---- Indexed -----------------------------------------------------------

    [Fact]
    public void Indexed_AssignsZeroBasedIndices()
    {
        var i = new[] { "a", "b", "c" }.Indexed().ToArray();
        Assert.Equal(new[] { (0, "a"), (1, "b"), (2, "c") }, i);
    }

    [Fact]
    public void Indexed_Empty_IsEmpty()
    {
        Assert.Empty(Sequences.Empty<int>().Indexed());
    }

    // ---- Pairwise ----------------------------------------------------------

    [Fact]
    public void Pairwise_AdjacentPairs()
    {
        var p = new[] { 1, 2, 3 }.Pairwise().ToArray();
        Assert.Equal(new[] { (1, 2), (2, 3) }, p);
    }

    [Fact]
    public void Pairwise_LessThanTwo_IsEmpty()
    {
        Assert.Empty(new[] { 1 }.Pairwise());
        Assert.Empty(Sequences.Empty<int>().Pairwise());
    }

    // ---- Interleave --------------------------------------------------------

    [Fact]
    public void Interleave_AlternatesFromBothSources()
    {
        var seq = new[] { 1, 2, 3 }.Interleave(new[] { 10, 20, 30 }).ToArray();
        Assert.Equal(new[] { 1, 10, 2, 20, 3, 30 }, seq);
    }

    [Fact]
    public void Interleave_StopsAtShorter()
    {
        var seq = new[] { 1, 2, 3, 4 }.Interleave(new[] { 10, 20 }).ToArray();
        Assert.Equal(new[] { 1, 10, 2, 20, 3, 4 }, seq);
    }

    [Fact]
    public void Interleave_EmptyOther_YieldsSourceUnchanged()
    {
        var seq = new[] { 1, 2 }.Interleave(Sequences.Empty<int>()).ToArray();
        Assert.Equal(new[] { 1, 2 }, seq);
    }

    // ---- FirstOrNil / FirstValueOrNil --------------------------------------

    [Fact]
    public void FirstOrNil_NonEmpty_ReturnsHead()
    {
        Assert.Equal("a", new[] { "a", "b" }.FirstOrNil());
    }

    [Fact]
    public void FirstOrNil_Empty_ReturnsNull()
    {
        Assert.Null(Sequences.Empty<string>().FirstOrNil());
    }

    [Fact]
    public void FirstValueOrNil_NonEmpty_ReturnsHead()
    {
        Assert.Equal((int?)11, new[] { 11, 22 }.FirstValueOrNil());
    }

    [Fact]
    public void FirstValueOrNil_Empty_ReturnsNull()
    {
        Assert.Null(Sequences.Empty<int>().FirstValueOrNil());
    }

    [Fact]
    public void FirstValueOrNil_OnInfinite_DoesNotEnumerateAll()
    {
        Assert.Equal((int?)1, Sequences.Iterate(1, n => n + 1).FirstValueOrNil());
    }

    // ---- LastOrNil / LastValueOrNil ----------------------------------------

    [Fact]
    public void LastOrNil_NonEmpty_ReturnsTail()
    {
        Assert.Equal("b", new[] { "a", "b" }.LastOrNil());
    }

    [Fact]
    public void LastOrNil_Empty_ReturnsNull()
    {
        Assert.Null(Sequences.Empty<string>().LastOrNil());
    }

    [Fact]
    public void LastValueOrNil_NonEmpty_ReturnsTail()
    {
        Assert.Equal((int?)33, new[] { 11, 22, 33 }.LastValueOrNil());
    }

    [Fact]
    public void LastValueOrNil_Empty_ReturnsNull()
    {
        Assert.Null(Sequences.Empty<int>().LastValueOrNil());
    }

    // ---- SingleOrNil / SingleValueOrNil ------------------------------------

    [Fact]
    public void SingleOrNil_OneElement_Returns()
    {
        Assert.Equal("solo", new[] { "solo" }.SingleOrNil());
    }

    [Fact]
    public void SingleOrNil_EmptyOrMany_ReturnsNull()
    {
        Assert.Null(Sequences.Empty<string>().SingleOrNil());
        Assert.Null(new[] { "a", "b" }.SingleOrNil());
    }

    [Fact]
    public void SingleValueOrNil_OneElement_Returns()
    {
        Assert.Equal((int?)42, new[] { 42 }.SingleValueOrNil());
    }

    [Fact]
    public void SingleValueOrNil_EmptyOrMany_ReturnsNull()
    {
        Assert.Null(Sequences.Empty<int>().SingleValueOrNil());
        Assert.Null(new[] { 1, 2 }.SingleValueOrNil());
    }

    // ---- ToSlice / ToMap ---------------------------------------------------

    [Fact]
    public void ToSlice_MaterializesArray()
    {
        var arr = Sequences.Range(1, 3).ToSlice();
        Assert.Equal(new[] { 1, 2, 3 }, arr);
        Assert.IsType<int[]>(arr);
    }

    [Fact]
    public void ToMap_FromTupleSequence_ProducesDictionary()
    {
        var d = new[] { ("a", 1), ("b", 2) }.ToMap();
        Assert.Equal(1, d["a"]);
        Assert.Equal(2, d["b"]);
    }

    [Fact]
    public void ToMap_DuplicateKeys_Throws()
    {
        Assert.Throws<ArgumentException>(() => new[] { ("a", 1), ("a", 2) }.ToMap());
    }

    [Fact]
    public void ToMap_WithKeyAndValueSelectors_ProducesDictionary()
    {
        var words = new[] { "alpha", "beta" };
        var d = words.ToMap(s => s[0..1], s => s.Length);
        Assert.Equal(5, d["a"]);
        Assert.Equal(4, d["b"]);
    }
}
