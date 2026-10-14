// <copyright file="TypeParameterVariance.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Variance kind for a (cref:TypeParameterSymbol) (Phase 4.3 / ADR-0021).
enum TypeParameterVariance {
    None,
    In,
    Out
}
