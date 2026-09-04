// <copyright file="IGoroutineResultSink{TResult}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// A completion sink that also receives the goroutine's value — the cell behind
/// an <c>async let</c> (ADR-0174 D15).
/// </summary>
/// <typeparam name="TResult">The body's result type.</typeparam>
public interface IGoroutineResultSink<in TResult> : IGoroutineSink
{
    /// <summary>Records that a registered goroutine produced <paramref name="result"/>.</summary>
    /// <param name="result">The body's value.</param>
    void Complete(TResult result);
}
