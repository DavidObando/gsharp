// <copyright file="TypeParameterConstraint.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Constraint kind for a (cref:TypeParameterSymbol) (Phase 4.1 / ADR-0020; widened in Phase 4.2).
enum TypeParameterConstraint {
    Any,
    Comparable
}
