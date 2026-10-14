// <copyright file="CollectionInitializerElementKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// The kind of a (cref:CollectionInitializerElement) inside a G#
/// collection initializer (ADR-0117).
enum CollectionInitializerElementKind {
    Expression,
    Keyed,
    Indexed,
    Assignment
}
