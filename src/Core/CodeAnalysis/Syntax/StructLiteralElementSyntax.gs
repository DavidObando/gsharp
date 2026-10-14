// <copyright file="StructLiteralElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0180: the base class for a single ordered element of a
/// (cref:StructLiteralExpressionSyntax)'s (cref:StructLiteralExpressionSyntax.Elements)
/// list. The two concrete shapes are (cref:FieldInitializerSyntax) (a
/// member initializer `Field: value`) and
/// (cref:StructLiteralContentElementSyntax) (a bare content element or
/// a `...source` content spread, both of which lower to an
/// `Add(...)` call on the constructed receiver). Representing every
/// element as one ordered (cref:SeparatedSyntaxList{T}) — rather than a
/// members list plus a separate elements list — is what lets the binder
/// preserve lexical (source) order when members and content elements are
/// interleaved.
abstract class StructLiteralElementSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:StructLiteralElementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    internal init(syntaxTree SyntaxTree) : base(syntaxTree) { }
}
