// <copyright file="LiteralKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// The kind of a (cref:LiteralExpression).
enum LiteralKind {
    Int,
    Float,
    String,
    RawString,
    Bool,
    Char,
    Null,
    ByteString
}
