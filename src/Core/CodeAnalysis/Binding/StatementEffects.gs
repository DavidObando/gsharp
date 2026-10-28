// <copyright file="StatementEffects.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// What a bound node does to narrowing facts (ADR-0208 section 13): the roots
/// it assigns, the roots it writes through a reference, and the flags that
/// name the kinds of write it may perform.
/// @remarks The record is immutable. The effects of a compound statement are
/// the union of the effects of its children, so a parent composes its
/// children's records and does not walk them again. The record holds raw sets
/// only. Nothing in it depends on the alias state at the entry of the node.
internal sealed class StatementEffects {
    private init(
        assignedRoots ImmutableArray[VariableSymbol],
        writableReferenceRoots ImmutableArray[VariableSymbol],
        mayMutateMemberPaths bool,
        mayMutateAnyRoot bool,
        mayMutateAnyRootViaPointer bool,
        mayMutateGlobalRoots bool,
        mayMutateWritableReferenceRoots bool,
        mayRunEscapedClosure bool
    ) {
        AssignedRoots = assignedRoots
        WritableReferenceRoots = writableReferenceRoots
        MayMutateMemberPaths = mayMutateMemberPaths
        MayMutateAnyRoot = mayMutateAnyRoot
        MayMutateAnyRootViaPointer = mayMutateAnyRootViaPointer
        MayMutateGlobalRoots = mayMutateGlobalRoots
        MayMutateWritableReferenceRoots = mayMutateWritableReferenceRoots
        MayRunEscapedClosure = mayRunEscapedClosure
    }

    /// Gets the roots the node assigns, in order of first write.
    prop AssignedRoots ImmutableArray[VariableSymbol] {
        get;
    }

    /// Gets the roots written through an `out`/`ref` argument or an
    /// address-of operand. Each one is also in (cref:AssignedRoots).
    prop WritableReferenceRoots ImmutableArray[VariableSymbol] {
        get;
    }

    prop MayMutateMemberPaths bool {
        get;
    }

    prop MayMutateAnyRoot bool {
        get;
    }

    prop MayMutateAnyRootViaPointer bool {
        get;
    }

    prop MayMutateGlobalRoots bool {
        get;
    }

    prop MayMutateWritableReferenceRoots bool {
        get;
    }

    /// Whether the node runs source code that can run a closure that escaped (ADR-0208 row R15).
    prop MayRunEscapedClosure bool {
        get;
    }

    prop IsEmpty bool -> AssignedRoots.IsEmpty &&
        WritableReferenceRoots.IsEmpty &&
        !MayMutateMemberPaths &&
        !MayMutateAnyRoot &&
        !MayMutateAnyRootViaPointer &&
        !MayMutateGlobalRoots &&
        !MayMutateWritableReferenceRoots &&
        !MayRunEscapedClosure

    func AssignsRoot(root VariableSymbol) bool -> AssignedRoots.Contains(root)

    /// Returns the union of this record and [`other`](paramref). The roots of
    /// this record come first, so the result is deterministic.
    func Union(other StatementEffects) StatementEffects {
        if other.IsEmpty {
            return this
        }
        if IsEmpty {
            return other
        }
        return StatementEffects(
            UnionRoots(AssignedRoots, other.AssignedRoots),
            UnionRoots(WritableReferenceRoots, other.WritableReferenceRoots),
            MayMutateMemberPaths || other.MayMutateMemberPaths,
            MayMutateAnyRoot || other.MayMutateAnyRoot,
            MayMutateAnyRootViaPointer || other.MayMutateAnyRootViaPointer,
            MayMutateGlobalRoots || other.MayMutateGlobalRoots,
            MayMutateWritableReferenceRoots || other.MayMutateWritableReferenceRoots,
            MayRunEscapedClosure || other.MayRunEscapedClosure
        )
    }

    /// Whether [`other`](paramref) has the same roots (as sets) and flags.
    func SameEffects(other StatementEffects) bool {
        return MayMutateMemberPaths == other.MayMutateMemberPaths &&
            MayMutateAnyRoot == other.MayMutateAnyRoot &&
            MayMutateAnyRootViaPointer == other.MayMutateAnyRootViaPointer &&
            MayMutateGlobalRoots == other.MayMutateGlobalRoots &&
            MayMutateWritableReferenceRoots == other.MayMutateWritableReferenceRoots &&
            MayRunEscapedClosure == other.MayRunEscapedClosure &&
            SameRoots(AssignedRoots, other.AssignedRoots) &&
            SameRoots(WritableReferenceRoots, other.WritableReferenceRoots)
    }

    /// Whether this record has every root and every flag of [`other`](paramref).
    /// A composed record may cover a full walk and carry more, because a child
    /// statement is walked without the writes that precede it in its parent.
    func Covers(other StatementEffects) bool {
        return (MayMutateMemberPaths || !other.MayMutateMemberPaths) &&
            (MayMutateAnyRoot || !other.MayMutateAnyRoot) &&
            (MayMutateAnyRootViaPointer || !other.MayMutateAnyRootViaPointer) &&
            (MayMutateGlobalRoots || !other.MayMutateGlobalRoots) &&
            (MayMutateWritableReferenceRoots || !other.MayMutateWritableReferenceRoots) &&
            (MayRunEscapedClosure || !other.MayRunEscapedClosure) &&
            other
            .AssignedRoots
            .All((root VariableSymbol) -> AssignedRoots.Contains(root)) && other.WritableReferenceRoots.All(
            (root VariableSymbol) -> WritableReferenceRoots.Contains(root)
        )
    }

    override func ToString() string {
        let roots = string.Join(",", AssignedRoots.Select((root VariableSymbol) -> root.Name))
        return "roots=[${roots}] member=${MayMutateMemberPaths} any=${MayMutateAnyRoot} pointer=${MayMutateAnyRootViaPointer} global=${MayMutateGlobalRoots}"
    }

    private func UnionRoots(left ImmutableArray[VariableSymbol], right ImmutableArray[VariableSymbol]) ImmutableArray[
        VariableSymbol
    ] {
        var result = left
        for root in right {
            if !result.Contains(root) {
                result = result.Add(root)
            }
        }
        return result
    }

    private func SameRoots(left ImmutableArray[VariableSymbol], right ImmutableArray[VariableSymbol]) bool {
        if left.Length != right.Length {
            return false
        }
        for root in left {
            if !right.Contains(root) {
                return false
            }
        }
        return true
    }

    shared {
        private let emptyEffects StatementEffects = StatementEffects(
            ImmutableArray[VariableSymbol].Empty,
            ImmutableArray[VariableSymbol].Empty,
            false,
            false,
            false,
            false,
            false,
            false
        )

        /// Gets the record of a node that changes nothing.
        prop Empty StatementEffects -> emptyEffects

        /// Builds a record from raw sets. The roots keep the order given.
        func Create(
            assignedRoots IEnumerable[VariableSymbol],
            writableReferenceRoots IEnumerable[VariableSymbol],
            mayMutateMemberPaths bool,
            mayMutateAnyRoot bool,
            mayMutateAnyRootViaPointer bool,
            mayMutateGlobalRoots bool,
            mayMutateWritableReferenceRoots bool,
            mayRunEscapedClosure bool = false
        ) StatementEffects {
            return StatementEffects(
                assignedRoots.ToImmutableArray(),
                writableReferenceRoots.ToImmutableArray(),
                mayMutateMemberPaths,
                mayMutateAnyRoot,
                mayMutateAnyRootViaPointer,
                mayMutateGlobalRoots,
                mayMutateWritableReferenceRoots,
                mayRunEscapedClosure
            )
        }

        /// Composes the records of the children of a compound node, in order.
        func Compose(children IEnumerable[StatementEffects]) StatementEffects {
            var result = Empty
            for child in children {
                result = result.Union(child)
            }
            return result
        }
    }
}
