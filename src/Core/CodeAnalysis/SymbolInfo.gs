// <copyright file="SymbolInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import System

/// The result of a (cref:SemanticModel.GetSymbolInfo) query: the symbol
/// a syntax node refers to, if any. Mirrors Roslyn's `SymbolInfo` shape
/// (ADR-0169).
/// @param Symbol The referenced symbol, or `null` when the node does not refer to one.
data struct SymbolInfo(Symbol Symbol?) : IEquatable[SymbolInfo] {
    shared {
        /// Gets an empty result.
        prop None SymbolInfo -> default(SymbolInfo)
    }
}
