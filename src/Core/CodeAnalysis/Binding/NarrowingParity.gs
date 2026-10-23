// <copyright file="NarrowingParity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Threading

/// The parity assertion of ADR-0208 section 19, PR 2 slice 1. When it is on, every
/// narrowed-type query compares the state that the frame stack threads with a fresh
/// projection of the frames, and with the answer of the frame walk, and throws when
/// they differ. A difference means that a write reached a frame without being seen.
/// @remarks The environment variable `GSHARP_NARROWING_PARITY` set to `1` turns it
/// on for a process. (cref:Begin) and (cref:End) turn it on in the calling context
/// for a test.
internal shared class NarrowingParity {
    private let environmentEnabled bool = ReadEnvironment()
    private let scoped AsyncLocal[bool] = AsyncLocal[bool]()

    /// Whether queries assert parity.
    prop Enabled bool -> environmentEnabled || scoped.Value

    /// Turns the assertion on in the calling context.
    func Begin() {
        scoped.Value = true
    }

    /// Turns the assertion off in the calling context.
    func End() {
        scoped.Value = false
    }

    /// Checks one query. [`frameAnswer`](paramref) is the answer of the frame walk.
    func Check(frames NarrowingFrameStack, path AccessPath, frameAnswer TypeSymbol?) {
        frames.AssertParity()
        let threadedAnswer = frames.State.NarrowedType(path)
        if !object.Equals(threadedAnswer, frameAnswer) {
            throw InvalidOperationException(
                "The threaded narrowing state answers ${threadedAnswer} for ${path}, the frame walk ${frameAnswer}."
            )
        }
    }

    private func ReadEnvironment() bool -> Environment.GetEnvironmentVariable("GSHARP_NARROWING_PARITY") == "1"
}
