// <copyright file="SymbolDisplayPartKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols.Display;

/// <summary>
/// Classifies a single <see cref="SymbolDisplayPart"/> so renderers (LSP hover,
/// signature help, completion) can colorize or place parts independently. Mirrors
/// a trimmed subset of Roslyn's <c>SymbolDisplayPartKind</c>.
/// </summary>
public enum SymbolDisplayPartKind
{
    /// <summary>A language keyword (e.g. <c>func</c>, <c>struct</c>, <c>let</c>).</summary>
    Keyword,

    /// <summary>Punctuation (e.g. <c>(</c>, <c>,</c>, <c>{</c>).</summary>
    Punctuation,

    /// <summary>Whitespace between parts.</summary>
    Space,

    /// <summary>A generic identifier with no more specific classification.</summary>
    Identifier,

    /// <summary>A type name (class/struct/interface/enum/primitive).</summary>
    TypeName,

    /// <summary>A parameter name.</summary>
    ParameterName,

    /// <summary>A property name.</summary>
    PropertyName,

    /// <summary>A field name.</summary>
    FieldName,

    /// <summary>A method or function name.</summary>
    MethodName,

    /// <summary>An enum member name.</summary>
    EnumMemberName,

    /// <summary>A namespace or package name.</summary>
    NamespaceName,

    /// <summary>An import alias name.</summary>
    AliasName,

    /// <summary>A numeric literal (e.g. an enum member's constant value).</summary>
    NumericLiteral,

    /// <summary>A descriptor such as <c>(local variable)</c> or <c>(+ 2 overloads)</c>.</summary>
    Descriptor,

    /// <summary>Free text with no other classification.</summary>
    Text,
}
