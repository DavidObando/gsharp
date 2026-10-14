// <copyright file="SymbolEqualityComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Generic
import System.Runtime.CompilerServices

/// Symbol identity comparer — the Roslyn `SymbolEqualityComparer`
/// analogue (ADR-0169). G# symbols are reference-unique within a compilation,
/// so identity is reference equality; the type exists so migrated analyzers'
/// `SymbolEqualityComparer.Default` usage carries over verbatim.
class SymbolEqualityComparer : IEqualityComparer[Symbol] {
    private init() { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(x Symbol?, y Symbol?) bool -> object.ReferenceEquals(x, y)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func GetHashCode(obj Symbol) int32 -> RuntimeHelpers.GetHashCode(obj)

    shared {
        /// Gets the singleton comparer.
        private let _default SymbolEqualityComparer = SymbolEqualityComparer()

        prop Default SymbolEqualityComparer {
            get {
                return _default
            }
        }
    }
}
