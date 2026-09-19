// <copyright file="SliceExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Values;

/// <summary>Allocation-free endpoint-based facades for native slice views.</summary>
public static class SliceExtensions
{
    /// <summary>Returns a shared view using an exclusive upper endpoint, not a length.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="slice">The saved descriptor.</param>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <returns>The shared view.</returns>
    public static Slice<T> Slice<T>(this Slice<T> slice, int lo, int hi) => slice.Subslice(lo, hi);

    /// <summary>Returns a capacity-limited shared view using exclusive endpoints.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="slice">The saved descriptor.</param>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <param name="max">The exclusive capacity endpoint.</param>
    /// <returns>The shared view.</returns>
    public static Slice<T> Slice<T>(this Slice<T> slice, int lo, int hi, int max) => slice.Subslice(lo, hi, max);

    /// <summary>Returns a readonly view using an exclusive upper endpoint, not a length.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="slice">The saved descriptor.</param>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <returns>The shared view.</returns>
    public static ReadOnlySlice<T> Slice<T>(this ReadOnlySlice<T> slice, int lo, int hi) => slice.Subslice(lo, hi);

    /// <summary>Returns a capacity-limited readonly view using exclusive endpoints.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="slice">The saved descriptor.</param>
    /// <param name="lo">The inclusive lower endpoint.</param>
    /// <param name="hi">The exclusive upper endpoint.</param>
    /// <param name="max">The exclusive capacity endpoint.</param>
    /// <returns>The shared view.</returns>
    public static ReadOnlySlice<T> Slice<T>(this ReadOnlySlice<T> slice, int lo, int hi, int max) => slice.Subslice(lo, hi, max);
}
