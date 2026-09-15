// <copyright file="StructLiteralContentElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0180: a bare content element or content spread inside a struct/class
/// composite literal, e.g. the <c>Text("Account")</c> or <c>...rows</c> in
/// <c>Container{ Width: 320.0, Text("Account"), ...rows }</c>. Mirrors
/// <see cref="ExpressionCollectionElementSyntax"/>: a bare element lowers to
/// <c>Add(expr)</c> on the constructed receiver, and when
/// <see cref="Expression"/> is a <see cref="SpreadElementExpressionSyntax"/>
/// the source is evaluated once, iterated once, and each item is added in
/// order.
/// </summary>
public sealed class StructLiteralContentElementSyntax : StructLiteralElementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StructLiteralContentElementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The element expression (or a <see cref="SpreadElementExpressionSyntax"/> for a content spread).</param>
    public StructLiteralContentElementSyntax(SyntaxTree syntaxTree, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StructLiteralContentElement;

    /// <summary>Gets the element expression.</summary>
    public ExpressionSyntax Expression { get; }
}
