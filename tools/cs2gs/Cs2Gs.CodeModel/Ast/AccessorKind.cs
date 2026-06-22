// <copyright file="AccessorKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// The kind of a <see cref="PropertyAccessor"/>.
/// </summary>
public enum AccessorKind
{
    /// <summary>A <c>get</c> accessor.</summary>
    Get,

    /// <summary>A <c>set</c> accessor.</summary>
    Set,

    /// <summary>An <c>init</c> accessor.</summary>
    Init,
}
