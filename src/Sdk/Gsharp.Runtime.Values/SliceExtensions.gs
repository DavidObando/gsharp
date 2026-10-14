// <copyright file="SliceExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Values

/// Allocation-free endpoint-based facades for native slice views.
shared class SliceExtensions { }

/// Returns a shared view using an exclusive upper endpoint, not a length.
/// @typeparam T The element type.
/// @param lo The inclusive lower endpoint.
/// @param hi The exclusive upper endpoint.
/// @returns The shared view.
@ExtensionOwner(typeof(SliceExtensions))
func (slice Slice[T]) Slice[T](lo int32, hi int32) Slice[T] -> slice.Subslice(lo, hi)

/// Returns a capacity-limited shared view using exclusive endpoints.
/// @typeparam T The element type.
/// @param lo The inclusive lower endpoint.
/// @param hi The exclusive upper endpoint.
/// @param max The exclusive capacity endpoint.
/// @returns The shared view.
@ExtensionOwner(typeof(SliceExtensions))
func (slice Slice[T]) Slice[T](lo int32, hi int32, max int32) Slice[T] -> slice.Subslice(lo, hi, max)

/// Returns a readonly view using an exclusive upper endpoint, not a length.
/// @typeparam T The element type.
/// @param lo The inclusive lower endpoint.
/// @param hi The exclusive upper endpoint.
/// @returns The shared view.
@ExtensionOwner(typeof(SliceExtensions))
func (slice ReadOnlySlice[T]) Slice[T](lo int32, hi int32) ReadOnlySlice[T] -> slice.Subslice(lo, hi)

/// Returns a capacity-limited readonly view using exclusive endpoints.
/// @typeparam T The element type.
/// @param lo The inclusive lower endpoint.
/// @param hi The exclusive upper endpoint.
/// @param max The exclusive capacity endpoint.
/// @returns The shared view.
@ExtensionOwner(typeof(SliceExtensions))
func (slice ReadOnlySlice[T]) Slice[T](lo int32, hi int32, max int32) ReadOnlySlice[T] -> slice.Subslice(lo, hi, max)
