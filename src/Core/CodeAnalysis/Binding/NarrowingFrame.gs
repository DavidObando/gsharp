// <copyright file="NarrowingFrame.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections
import System.Collections.Generic
import System.Linq

/// One frame of the narrowing stack: a map from access path to narrowed type
/// (ADR-0208 section 2). A frame behaves like the dictionary it wraps, and tells
/// the stack that holds it about every write, so that the stack can keep a
/// (cref:NarrowingState) in step with the frames.
/// @remarks A frame that is not on a stack has no owner and notifies nobody.
/// The same frame can be on a stack more than once.
internal sealed class NarrowingFrame : IEnumerable[KeyValuePair[AccessPath, TypeSymbol]] {
    private let entries Dictionary[AccessPath, TypeSymbol]

    init() {
        entries = Dictionary[AccessPath, TypeSymbol]()
    }

    /// Wraps [`inner`](paramref). The frame shares the dictionary, so a write to
    /// the dictionary that bypasses the frame is not seen by the owner.
    init(inner Dictionary[AccessPath, TypeSymbol]) {
        entries = inner
    }

    /// Gets the stack that holds this frame, or `nil`.
    prop Owner NarrowingFrameStack? {
        get;
        set;
    }

    /// Gets a read-only view of the entries.
    prop Entries IReadOnlyDictionary[AccessPath, TypeSymbol] -> entries

    prop Count int32 -> entries.Count

    prop Keys Dictionary[AccessPath, TypeSymbol].KeyCollection -> entries.Keys

    prop Values Dictionary[AccessPath, TypeSymbol].ValueCollection -> entries.Values

    func ContainsKey(path AccessPath) bool -> entries.ContainsKey(path)

    func TryGetValue(path AccessPath, out narrowedType TypeSymbol) bool -> entries.TryGetValue(path, out narrowedType)

    func Add(path AccessPath, narrowedType TypeSymbol) {
        entries.Add(path, narrowedType)
        Owner?.FrameChanged(path)
    }

    func Remove(path AccessPath) bool {
        let removed = entries.Remove(path)
        if removed {
            Owner?.FrameChanged(path)
        }
        return removed
    }

    func Clear() {
        if entries.Count == 0 {
            return
        }
        let paths = entries.Keys.ToArray()
        entries.Clear()
        for path in paths {
            Owner?.FrameChanged(path)
        }
    }

    /// Gets or sets the type of a path. A write is a write even when the value is equal.
    prop this[path AccessPath]TypeSymbol {
        get -> entries[path]
        set {
            entries[path] = value
            Owner?.FrameChanged(path)
        }
    }

    func GetEnumerator() IEnumerator[KeyValuePair[AccessPath, TypeSymbol]] -> entries.GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}
