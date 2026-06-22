// <copyright file="CollectionInitializerElementKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// The kind of a <see cref="CollectionInitializerElement"/> inside a G#
/// collection initializer (ADR-0117).
/// </summary>
public enum CollectionInitializerElementKind
{
    /// <summary>A bare element <c>e</c>, lowered to <c>Add(e)</c>.</summary>
    Expression,

    /// <summary>A key/value pair <c>k: v</c>, lowered to <c>Add(k, v)</c>.</summary>
    Keyed,

    /// <summary>An indexer entry <c>[k] = v</c>, lowered to an indexer set.</summary>
    Indexed,
}
