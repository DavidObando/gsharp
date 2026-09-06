// <copyright file="Chunks.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// A static-factory spelling of <see cref="ChunkReader{T}"/>'s constructor
/// (ADR-0174 D10), kept as published surface.
/// </summary>
/// <remarks>
/// It was introduced as a workaround: a G# caller with an OPEN element type
/// could not reach the constructor at all (issue #3876 — a <c>chan[T]</c>
/// argument projected to no CLR shape, so constructor applicability abandoned
/// resolution), and a static generic method was the shape that did bind.
/// <c>chunks</c> now calls the constructor directly; this entry point stays
/// because it is public API, not because anything needs it.
/// </remarks>
public static class Chunks
{
    /// <summary>Opens a chunked, receive-only view of <paramref name="source"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="source">The channel to chunk.</param>
    /// <param name="size">The maximum number of elements per batch.</param>
    /// <returns>A reader that hands over whole batches.</returns>
    public static ChunkReader<T> Of<T>(Channel<T> source, int size) => new(source, size);
}
