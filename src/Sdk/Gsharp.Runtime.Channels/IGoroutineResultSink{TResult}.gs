// <copyright file="IGoroutineResultSink{TResult}.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// A completion sink that also receives the goroutine's value — the cell behind
/// an `async let` (ADR-0174 D15).
/// @typeparam TResult The body's result type.
interface IGoroutineResultSink[in TResult] : IGoroutineSink {
    /// Records that a registered goroutine produced [`result`](paramref).
    /// @param result The body's value.
    func Complete(result TResult);
}
