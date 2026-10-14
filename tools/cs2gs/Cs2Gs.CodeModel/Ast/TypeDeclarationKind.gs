// <copyright file="TypeDeclarationKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// The aggregate keyword of a (cref:TypeDeclaration) (ADR-0029/ADR-0078,
/// ADR-0115 §B.4).
enum TypeDeclarationKind {
    Class,
    Struct,
    DataClass,
    DataStruct,
    InlineStruct,
    Interface
}
