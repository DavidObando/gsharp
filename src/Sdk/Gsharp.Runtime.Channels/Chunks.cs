// <copyright file="Chunks.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Channels;

namespace Gsharp.Concurrency;

/// <summary>
/// The non-generic entry point behind the language's <c>chunks(ch, n)</c>
/// (ADR-0174 D10). A static generic method is what a G# caller with an open
/// element type can reach — the same shape <c>Chan.Unbounded[T]()</c> takes.
/// </summary>
public static class Chunks
{
    /// <summary>Opens a chunked, receive-only view of <paramref name="source"/>.</summary>
    /// <typeparam name="T">The element type.</typeparam>
    /// <param name="source">The channel to chunk.</param>
    /// <param name="size">The maximum number of elements per batch.</param>
    /// <returns>A reader that hands over whole batches.</returns>
    public static ChunkReader<T> Of<T>(Channel<T> source, int size) => new(source, size);
}
