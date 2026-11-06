// <copyright file="NarrowingFrame.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections
import System.Collections.Generic
import System.Linq

/// An immutable version-tree node recording one entry transition on a (cref:NarrowingFrame).
internal sealed class NarrowingFrameSnapshot {
    internal let Frame NarrowingFrame
    internal let Parent NarrowingFrameSnapshot?
    internal let Depth int32
    internal let Count int32
    internal let Path AccessPath
    internal let HadPrevious bool
    internal let PreviousType TypeSymbol?
    internal let HasCurrent bool
    internal let CurrentType TypeSymbol?

    internal init(
        frame NarrowingFrame,
        parent NarrowingFrameSnapshot?,
        depth int32,
        count int32,
        path AccessPath,
        hadPrevious bool,
        previousType TypeSymbol?,
        hasCurrent bool,
        currentType TypeSymbol?
    ) {
        Frame = frame
        Parent = parent
        Depth = depth
        Count = count
        Path = path
        HadPrevious = hadPrevious
        PreviousType = previousType
        HasCurrent = hasCurrent
        CurrentType = currentType
    }

    internal func ContainsKey(path AccessPath) bool -> TryGetValue(path, out _)

    internal func TryGetValue(path AccessPath, out narrowedType TypeSymbol) bool {
        let current = Frame.CurrentSnapshot
        if object.ReferenceEquals(this, current) {
            return Frame.TryGetValue(path, out narrowedType)
        }
        var a = current
        var b = this
        var foundOnA = false
        var hadPrevOnA = false
        var prevTypeOnA TypeSymbol? = nil
        while b.Depth > a.Depth {
            StatementBinder.SpeculativeRollbackWorkCount++
            if b.Path == path {
                narrowedType = b.CurrentType ?? TypeSymbol.Error
                return b.HasCurrent
            }
            b = b.Parent!!
        }
        while a.Depth > b.Depth {
            StatementBinder.SpeculativeRollbackWorkCount++
            if a.Path == path {
                foundOnA = true
                hadPrevOnA = a.HadPrevious
                prevTypeOnA = a.PreviousType
            }
            a = a.Parent!!
        }
        while !object.ReferenceEquals(a, b) {
            StatementBinder.SpeculativeRollbackWorkCount++
            if b.Path == path {
                narrowedType = b.CurrentType ?? TypeSymbol.Error
                return b.HasCurrent
            }
            if a.Path == path {
                foundOnA = true
                hadPrevOnA = a.HadPrevious
                prevTypeOnA = a.PreviousType
            }
            a = a.Parent!!
            b = b.Parent!!
        }
        if foundOnA {
            narrowedType = prevTypeOnA ?? TypeSymbol.Error
            return hadPrevOnA
        }
        return Frame.TryGetValue(path, out narrowedType)
    }
}

/// One frame of the narrowing stack: a map from access path to narrowed type
/// (ADR-0208 section 2). A frame behaves like the dictionary it wraps, and tells
/// the stack that holds it about every write, so that the stack can keep a
/// (cref:NarrowingState) in step with the frames.
/// @remarks A frame that is not on a stack has no owner and notifies nobody.
/// The same frame can be on a stack more than once.
internal sealed class NarrowingFrame : IEnumerable[KeyValuePair[AccessPath, TypeSymbol]] {
    private let entries Dictionary[AccessPath, TypeSymbol]
    private var currentSnapshot NarrowingFrameSnapshot

    init() {
        entries = Dictionary[AccessPath, TypeSymbol]()
        currentSnapshot = NarrowingFrameSnapshot(this, nil, 0, 0, default(AccessPath), false, nil, false, nil)
    }

    /// Wraps [`inner`](paramref). The frame shares the dictionary, so a write to
    /// the dictionary that bypasses the frame is not seen by the owner.
    init(inner Dictionary[AccessPath, TypeSymbol]) {
        entries = inner
        currentSnapshot = NarrowingFrameSnapshot(this, nil, 0, inner.Count, default(AccessPath), false, nil, false, nil)
    }

    /// Gets the stack that holds this frame, or `nil`.
    prop Owner NarrowingFrameStack? {
        get;
        set;
    }

    /// Gets a read-only view of the entries.
    prop Entries IReadOnlyDictionary[AccessPath, TypeSymbol] -> entries

    /// Gets the current version-tree snapshot node of this frame.
    internal prop CurrentSnapshot NarrowingFrameSnapshot -> currentSnapshot

    /// Returns an immutable version-tree snapshot of this frame's entries in O(1) without copying.
    internal func SnapshotEntries() NarrowingFrameSnapshot -> currentSnapshot

    /// Restores this frame to [`target`](paramref) by walking only the entries changed along the version-tree path.
    internal func RestoreTo(target NarrowingFrameSnapshot?) {
        if target == nil {
            Clear()
            return
        }
        if object.ReferenceEquals(currentSnapshot, target) {
            return
        }
        var a = currentSnapshot
        var b = target
        while a.Depth > b.Depth {
            ApplyRawEntry(a.Path, a.HadPrevious, a.PreviousType)
            a = a.Parent!!
        }
        if object.ReferenceEquals(a, b) {
            currentSnapshot = target
            return
        }
        let redo = List[NarrowingFrameSnapshot]()
        while b.Depth > a.Depth {
            redo.Add(b)
            b = b.Parent!!
        }
        while !object.ReferenceEquals(a, b) {
            ApplyRawEntry(a.Path, a.HadPrevious, a.PreviousType)
            redo.Add(b)
            a = a.Parent!!
            b = b.Parent!!
        }
        for var i = redo.Count - 1; i >= 0; i-- {
            let step = redo[i]
            ApplyRawEntry(step.Path, step.HasCurrent, step.CurrentType)
        }
        currentSnapshot = target
    }

    /// Visits each key whose presence or narrowed type differs between this frame and [`other`](paramref).
    internal func ForEachChangedKey(
        other NarrowingFrameSnapshot?,
        action(AccessPath, bool, TypeSymbol?, bool, TypeSymbol?) -> void
    ) {
        if object.ReferenceEquals(currentSnapshot, other) ||
            (entries.Count == 0 && (other == nil || other.Count == 0)) {
            return
        }
        if other == nil {
            for kv in entries.ToArray() {
                StatementBinder.SpeculativeRollbackWorkCount++
                action(kv.Key, true, kv.Value, false, nil)
            }
            return
        }
        var a = currentSnapshot
        var b = other
        if object.ReferenceEquals(a.Parent, b) {
            StatementBinder.SpeculativeRollbackWorkCount++
            let path = a.Path
            let currentExists = entries.TryGetValue(path, out var currentType)
            let otherExists = a.HadPrevious
            let otherType = a.PreviousType
            if currentExists != otherExists || (currentExists && !object.Equals(currentType, otherType)) {
                action(path, currentExists, currentType, otherExists, otherType)
            }
            return
        }
        if object.ReferenceEquals(b.Parent, a) {
            StatementBinder.SpeculativeRollbackWorkCount++
            let path = b.Path
            let currentExists = entries.TryGetValue(path, out var currentType)
            let otherExists = b.HasCurrent
            let otherType = b.CurrentType
            if currentExists != otherExists || (currentExists && !object.Equals(currentType, otherType)) {
                action(path, currentExists, currentType, otherExists, otherType)
            }
            return
        }
        let candidates = List[AccessPath]()
        let lcaState = Dictionary[AccessPath, (Exists bool, Type TypeSymbol?)]()
        let otherState = Dictionary[AccessPath, (Exists bool, Type TypeSymbol?)]()
        while a.Depth > b.Depth {
            StatementBinder.SpeculativeRollbackWorkCount++
            if !lcaState.ContainsKey(a.Path) && !otherState.ContainsKey(a.Path) {
                candidates.Add(a.Path)
            }
            lcaState[a.Path] = (a.HadPrevious, a.PreviousType)
            a = a.Parent!!
        }
        while b.Depth > a.Depth {
            StatementBinder.SpeculativeRollbackWorkCount++
            if !otherState.ContainsKey(b.Path) {
                if !lcaState.ContainsKey(b.Path) {
                    candidates.Add(b.Path)
                }
                otherState[b.Path] = (b.HasCurrent, b.CurrentType)
            }
            b = b.Parent!!
        }
        while !object.ReferenceEquals(a, b) {
            StatementBinder.SpeculativeRollbackWorkCount++
            if !lcaState.ContainsKey(a.Path) && !otherState.ContainsKey(a.Path) {
                candidates.Add(a.Path)
            }
            lcaState[a.Path] = (a.HadPrevious, a.PreviousType)
            if !otherState.ContainsKey(b.Path) {
                if !lcaState.ContainsKey(b.Path) {
                    candidates.Add(b.Path)
                }
                otherState[b.Path] = (b.HasCurrent, b.CurrentType)
            }
            a = a.Parent!!
            b = b.Parent!!
        }
        let changes = List[
            (Path AccessPath, CurrentExists bool, CurrentType TypeSymbol?, OtherExists bool, OtherType TypeSymbol?)
        ](candidates.Count)
        for path in candidates {
            let currentExists = entries.TryGetValue(path, out var currentType)
            var otherExists bool
            var otherType TypeSymbol?
            if otherState.TryGetValue(path, out var oState) {
                otherExists = oState.Exists
                otherType = oState.Type
            } else if lcaState.TryGetValue(path, out var lState) {
                otherExists = lState.Exists
                otherType = lState.Type
            } else {
                otherExists = currentExists
                otherType = currentType
            }
            if currentExists != otherExists || (currentExists && !object.Equals(currentType, otherType)) {
                changes.Add((path, currentExists, currentType, otherExists, otherType))
            }
        }
        for change in changes {
            action(change.Path, change.CurrentExists, change.CurrentType, change.OtherExists, change.OtherType)
        }
    }

    private func ApplyRawEntry(path AccessPath, exists bool, narrowedType TypeSymbol?) {
        StatementBinder.SpeculativeRollbackWorkCount++
        let hadPrevious = entries.TryGetValue(path, out var previous)
        if hadPrevious == exists && (!exists || object.Equals(previous, narrowedType)) {
            return
        }
        Owner?.FrameEntryChanging(this, path, hadPrevious, previous)
        if exists {
            entries[path] = narrowedType!!
        } else {
            entries.Remove(path)
        }
        Version++
        Owner?.FrameChanged(path)
    }

    /// Gets the number of entries in this frame.
    prop Count int32 -> entries.Count

    /// Gets a counter incremented on every mutation of this frame.
    internal var Version int32

    prop Keys Dictionary[AccessPath, TypeSymbol].KeyCollection -> entries.Keys

    prop Values Dictionary[AccessPath, TypeSymbol].ValueCollection -> entries.Values

    func ContainsKey(path AccessPath) bool -> entries.ContainsKey(path)

    func TryGetValue(path AccessPath, out narrowedType TypeSymbol) bool -> entries.TryGetValue(path, out narrowedType)

    func Add(path AccessPath, narrowedType TypeSymbol) {
        let hadPrevious = entries.TryGetValue(path, out var previous)
        Owner?.FrameEntryChanging(this, path, hadPrevious, previous)
        entries.Add(path, narrowedType)
        currentSnapshot = NarrowingFrameSnapshot(
            this,
            currentSnapshot,
            currentSnapshot.Depth + 1,
            entries.Count,
            path,
            hadPrevious,
            previous,
            true,
            narrowedType
        )
        Version++
        Owner?.FrameChanged(path)
    }

    func Remove(path AccessPath) bool {
        if !entries.TryGetValue(path, out var previous) {
            return false
        }
        Owner?.FrameEntryChanging(this, path, true, previous)
        entries.Remove(path)
        currentSnapshot = NarrowingFrameSnapshot(
            this,
            currentSnapshot,
            currentSnapshot.Depth + 1,
            entries.Count,
            path,
            true,
            previous,
            false,
            nil
        )
        Version++
        Owner?.FrameChanged(path)
        return true
    }

    func Clear() {
        if entries.Count == 0 {
            return
        }
        let paths = entries.Keys.ToArray()
        for path in paths {
            let previous = entries[path]
            Owner?.FrameEntryChanging(this, path, true, previous)
            entries.Remove(path)
            currentSnapshot = NarrowingFrameSnapshot(
                this,
                currentSnapshot,
                currentSnapshot.Depth + 1,
                entries.Count,
                path,
                true,
                previous,
                false,
                nil
            )
        }
        Version++
        for path in paths {
            Owner?.FrameChanged(path)
        }
    }

    /// Gets or sets the type of a path. A write is a write even when the value is equal.
    prop this[path AccessPath]TypeSymbol {
        get -> entries[path]
        set {
            let hadPrevious = entries.TryGetValue(path, out var previous)
            Owner?.FrameEntryChanging(this, path, hadPrevious, previous)
            entries[path] = value
            currentSnapshot = NarrowingFrameSnapshot(
                this,
                currentSnapshot,
                currentSnapshot.Depth + 1,
                entries.Count,
                path,
                hadPrevious,
                previous,
                true,
                value
            )
            Version++
            Owner?.FrameChanged(path)
        }
    }

    func GetEnumerator() IEnumerator[KeyValuePair[AccessPath, TypeSymbol]] -> entries.GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}
