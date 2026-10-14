// <copyright file="TypeInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import System

/// The result of a (cref:SemanticModel.GetTypeInfo) query: the type of
/// an expression node, if it has one. Mirrors Roslyn's `TypeInfo` shape
/// (ADR-0169).
/// @param Type The expression's type, or `null` when the node is not a typed expression.
data struct TypeInfo(Type TypeSymbol?) : IEquatable[TypeInfo] {
    shared {
        /// Gets an empty result.
        prop None TypeInfo -> default(TypeInfo)
    }
}
