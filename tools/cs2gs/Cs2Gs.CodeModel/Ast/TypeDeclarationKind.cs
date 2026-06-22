// <copyright file="TypeDeclarationKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// The aggregate keyword of a <see cref="TypeDeclaration"/> (ADR-0029/ADR-0078,
/// ADR-0115 §B.4).
/// </summary>
public enum TypeDeclarationKind
{
    /// <summary>A reference type (<c>class</c>).</summary>
    Class,

    /// <summary>A value type (<c>struct</c>).</summary>
    Struct,

    /// <summary>A reference type with structural members (<c>data class</c>).</summary>
    DataClass,

    /// <summary>A value type with structural equality (<c>data struct</c>).</summary>
    DataStruct,

    /// <summary>A single-field value newtype (<c>inline struct</c>).</summary>
    InlineStruct,

    /// <summary>A signature-only contract (<c>interface</c>).</summary>
    Interface,
}
