// <copyright file="BindingKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// Binding mutability keyword for fields and local declarations
/// (ADR-0008/ADR-0067, ADR-0115 §B.3).
enum BindingKind {
    Let,
    Var,
    Const,
    FixedBuffer
}
