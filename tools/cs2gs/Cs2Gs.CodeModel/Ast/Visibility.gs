// <copyright file="Visibility.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// Accessibility of a declaration. (cref:Default) means "emit nothing";
/// the printer only renders a modifier when the accessibility differs from the
/// canonical default for that position (ADR-0115 §B.10).
enum Visibility {
    Default,
    Public,
    Internal,
    Private,
    Protected
}
