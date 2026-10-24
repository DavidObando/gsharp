// <copyright file="NarrowingFrameStack.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// The stack of narrowing frames of one binder (ADR-0208 section 2), and the
/// (cref:NarrowingState) that it keeps in step with the frames.
/// @remarks The state holds, for each path, the type of the innermost frame
/// that has the path. Each push, pop and frame write updates the state for the
/// paths it touches, so the state is threaded beside the frames and is not
/// computed on demand. (cref:AssertParity) compares it with a fresh projection.
internal sealed class NarrowingFrameStack : IReadOnlyList[NarrowingFrame] {
    private let frames List[NarrowingFrame] = List[NarrowingFrame]()
    private var threaded NarrowingState = NarrowingState.Empty

    prop Count int32 -> frames.Count

    /// Gets the narrowing facts that hold now, kept in step with the frames.
    prop State NarrowingState -> threaded

    prop this[index int32]NarrowingFrame {
        get -> frames[index]
    }

    /// Wraps [`inner`](paramref) in a frame and pushes it.
    func Push(inner Dictionary[AccessPath, TypeSymbol]) NarrowingFrame {
        let frame = NarrowingFrame(inner)
        Add(frame)
        return frame
    }

    func Add(frame NarrowingFrame) {
        frames.Add(frame)
        frame.Owner = this
        for entry in frame {
            Recompute(entry.Key)
        }
    }

    /// Pushes each frame, in order.
    func AddRange(items IEnumerable[NarrowingFrame]) {
        for frame in items.ToArray() {
            Add(frame)
        }
    }

    /// Wraps each dictionary in a frame and pushes it, in order.
    func AddRange(items IEnumerable[Dictionary[AccessPath, TypeSymbol]]) {
        for inner in items.ToArray() {
            Push(inner)
        }
    }

    func RemoveAt(index int32) {
        let frame = frames[index]
        frames.RemoveAt(index)
        if !frames.Contains(frame) {
            frame.Owner = nil
        }
        for entry in frame {
            Recompute(entry.Key)
        }
    }

    func Clear() {
        for frame in frames {
            frame.Owner = nil
        }
        frames.Clear()
        // No frame is left, so no fact is: reset the state in one step.
        threaded = NarrowingState.Empty
    }

    /// Called by a frame that this stack holds after a write to [`path`](paramref).
    internal func FrameChanged(path AccessPath) {
        Recompute(path)
    }

    /// The one frame walk: returns the type of the innermost frame that has
    /// [`path`](paramref), or `nil`. Every narrowed-type lookup in the binder
    /// goes through it, so the parity assertion sees every query.
    func Query(path AccessPath) TypeSymbol? {
        var answer TypeSymbol? = nil
        for var i = frames.Count - 1; i >= 0; i-- {
            if frames[i].TryGetValue(path, out var narrowedType) {
                answer = narrowedType
                break
            }
        }
        if NarrowingParity.Enabled {
            NarrowingParity.Check(this, path, answer)
        }
        return answer
    }

    /// Compares the threaded state with a fresh projection of the frames, and
    /// throws when they differ: a write reached a frame without being seen.
    func AssertParity() {
        let projected = NarrowingState.FromFrames(this, ImmutableArray[VariableSymbol].Empty)
        if !threaded.Equals(projected) {
            throw InvalidOperationException(
                "The threaded narrowing state ${threaded} differs from the projection of the frames ${projected}."
            )
        }
    }

    func GetEnumerator() IEnumerator[NarrowingFrame] -> frames.GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    private func Recompute(path AccessPath) {
        for var i = frames.Count - 1; i >= 0; i-- {
            if frames[i].TryGetValue(path, out var narrowedType) {
                threaded = threaded.With(path, narrowedType)
                return
            }
        }
        threaded = threaded.Remove(path)
    }
}
