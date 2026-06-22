// <copyright file="ExpressionCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #479 / ADR-0117: a bare element of a sequence/set collection
/// initializer, e.g. the <c>1</c> in <c>List[int32]{1, 2, 3}</c>. Lowers to a
/// <c>Add(expr)</c> call on the constructed collection.
/// </summary>
public sealed class ExpressionCollectionElementSyntax : CollectionElementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ExpressionCollectionElementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The element expression.</param>
    public ExpressionCollectionElementSyntax(SyntaxTree syntaxTree, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ExpressionCollectionElement;

    /// <summary>Gets the element expression.</summary>
    public ExpressionSyntax Expression { get; }
}
