#nullable disable

// <copyright file="CollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #479 / ADR-0117: the base class for a single element of a
/// <see cref="CollectionInitializerExpressionSyntax"/>. The three concrete
/// shapes are <see cref="ExpressionCollectionElementSyntax"/> (a bare element
/// <c>expr</c>), <see cref="KeyedCollectionElementSyntax"/> (a key/value entry
/// <c>key: value</c>), and <see cref="IndexedCollectionElementSyntax"/> (an
/// indexed entry <c>[key] = value</c>).
/// </summary>
public abstract class CollectionElementSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CollectionElementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    private protected CollectionElementSyntax(SyntaxTree syntaxTree)
        : base(syntaxTree)
    {
    }
}
