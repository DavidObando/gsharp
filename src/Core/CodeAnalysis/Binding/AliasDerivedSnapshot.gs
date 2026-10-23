// <copyright file="AliasDerivedSnapshot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Threading

/// One immutable value derived from a scope's type aliases, together with the
/// inputs it was derived from. A scope stores the pair behind one reference, so a
/// reader never sees a value that belongs to different inputs.
internal sealed class AliasDerivedSnapshot[TValue] {
    internal init(
        own ImmutableDictionary[string, TypeSymbol]?,
        inherited ImmutableArray[KeyValuePair[string, TypeSymbol]],
        value TValue
    ) {
        Own = own
        Inherited = inherited
        Value = value
    }

    internal prop Own ImmutableDictionary[string, TypeSymbol]? {
        get;
    }

    internal prop Inherited ImmutableArray[KeyValuePair[string, TypeSymbol]] {
        get;
    }

    internal prop Value TValue {
        get;
    }

    /// Returns whether this snapshot was derived from exactly these inputs.
    internal func Matches(
        own ImmutableDictionary[string, TypeSymbol]?,
        inherited ImmutableArray[KeyValuePair[string, TypeSymbol]]
    ) bool -> object.ReferenceEquals(Own, own) && Inherited.Equals(inherited)

    shared {
        /// Reads the published value when it was derived from exactly these inputs. Readers
        /// call this first and build only on a miss, so a hit allocates nothing.
        /// @param slot The field that holds the current snapshot.
        /// @param own The scope's own aliases, or `null` when the value does not depend on them.
        /// @param inherited The inherited aliases.
        /// @param value The published value on a hit.
        /// @returns Whether the slot held a snapshot for these inputs.
        internal func TryGet(
            ref slot AliasDerivedSnapshot[TValue]?,
            own ImmutableDictionary[string, TypeSymbol]?,
            inherited ImmutableArray[KeyValuePair[string, TypeSymbol]],
            out value TValue
        ) bool {
            let current = Volatile.Read(&slot)
            if current != nil && current.Matches(own, inherited) {
                value = current.Value
                return true
            }
            value = default
            return false
        }

        /// Publishes a value built after a (cref:TryGet) miss, with compare-exchange.
        /// When another thread published first for the same inputs, the loser drops its
        /// build and returns the winner's value, so every caller of these inputs shares
        /// one instance. A build is a pure function of the inputs, so a lost race wastes
        /// work and nothing else.
        /// @param slot The field that holds the current snapshot.
        /// @param own The scope's own aliases, or `null` when the value does not depend on them.
        /// @param inherited The inherited aliases.
        /// @param counter The measurement name prefix for builds and publishes.
        /// @param built The value computed from the inputs.
        /// @returns The value every caller of these inputs shares.
        internal func Publish(
            ref slot AliasDerivedSnapshot[TValue]?,
            own ImmutableDictionary[string, TypeSymbol]?,
            inherited ImmutableArray[KeyValuePair[string, TypeSymbol]],
            counter string,
            built TValue
        ) TValue {
            CompilationMeasurements.Count(counter + ".builds")
            let candidate = AliasDerivedSnapshot[TValue](own, inherited, built)
            var current = Volatile.Read(&slot)
            while true {
                if current != nil && current.Matches(own, inherited) {
                    return current.Value
                }
                let previous = Interlocked.CompareExchange(&slot, candidate, current)
                if object.ReferenceEquals(previous, current) {
                    CompilationMeasurements.Count(counter + ".publishes")
                    return built
                }
                current = previous
            }
        }
    }
}
