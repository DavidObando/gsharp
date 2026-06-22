// <copyright file="LiteralKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// The kind of a <see cref="LiteralExpression"/>.
/// </summary>
public enum LiteralKind
{
    /// <summary>An integer literal (e.g. <c>42</c>).</summary>
    Int,

    /// <summary>A floating-point literal (e.g. <c>2.0</c>).</summary>
    Float,

    /// <summary>A string literal; rendered double-quoted with <c>$</c> escaped to <c>$$</c>.</summary>
    String,

    /// <summary>A boolean literal (<c>true</c>/<c>false</c>).</summary>
    Bool,

    /// <summary>A character literal; rendered single-quoted.</summary>
    Char,

    /// <summary>The null literal, rendered as <c>nil</c>.</summary>
    Null,
}
