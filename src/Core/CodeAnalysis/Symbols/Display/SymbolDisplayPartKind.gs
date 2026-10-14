// <copyright file="SymbolDisplayPartKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols.Display

/// Classifies a single (cref:SymbolDisplayPart) so renderers (LSP hover,
/// signature help, completion) can colorize or place parts independently. Mirrors
/// a trimmed subset of Roslyn's `SymbolDisplayPartKind`.
enum SymbolDisplayPartKind {
    Keyword,
    Punctuation,
    Space,
    Identifier,
    TypeName,
    ParameterName,
    PropertyName,
    FieldName,
    MethodName,
    EnumMemberName,
    NamespaceName,
    AliasName,
    NumericLiteral,
    Descriptor,
    Text
}
