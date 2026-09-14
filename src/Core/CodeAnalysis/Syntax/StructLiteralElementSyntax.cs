// <copyright file="StructLiteralElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0180: the base class for a single ordered element of a
/// <see cref="StructLiteralExpressionSyntax"/>'s <see cref="StructLiteralExpressionSyntax.Elements"/>
/// list. The two concrete shapes are <see cref="FieldInitializerSyntax"/> (a
/// member initializer <c>Field: value</c>) and
/// <see cref="StructLiteralContentElementSyntax"/> (a bare content element or
/// a <c>...source</c> content spread, both of which lower to an
/// <c>Add(...)</c> call on the constructed receiver). Representing every
/// element as one ordered <see cref="SeparatedSyntaxList{T}"/> — rather than a
/// members list plus a separate elements list — is what lets the binder
/// preserve lexical (source) order when members and content elements are
/// interleaved.
/// </summary>
public abstract class StructLiteralElementSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StructLiteralElementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    private protected StructLiteralElementSyntax(SyntaxTree syntaxTree)
        : base(syntaxTree)
    {
    }
}
