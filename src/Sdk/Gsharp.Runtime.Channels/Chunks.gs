// <copyright file="Chunks.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System.Threading.Channels

/// A static-factory spelling of (cref:ChunkReader{T})'s constructor
/// (ADR-0174 D10), kept as published surface.
/// @remarks It was introduced as a workaround: a G# caller with an OPEN element type
/// could not reach the constructor at all (issue #3876 — a `chan[T]`
/// argument projected to no CLR shape, so constructor applicability abandoned
/// resolution), and a static generic method was the shape that did bind.
/// `chunks` now calls the constructor directly; this entry point stays
/// because it is public API, not because anything needs it.
shared class Chunks {
    /// Opens a chunked, receive-only view of [`source`](paramref).
    /// @typeparam T The element type.
    /// @param source The channel to chunk.
    /// @param size The maximum number of elements per batch.
    /// @returns A reader that hands over whole batches.
    func Of[T](source Channel[T], size int32) ChunkReader[T] -> ChunkReader[T](source, size)
}
