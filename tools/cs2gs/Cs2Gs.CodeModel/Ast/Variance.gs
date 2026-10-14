// <copyright file="Variance.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// Variance marker on an interface/delegate type parameter (ADR-0021).
enum Variance {
    None,
    Out,
    In
}
