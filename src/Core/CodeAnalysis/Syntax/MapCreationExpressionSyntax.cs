// <copyright file="MapCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a map creation expression <c>map[K]V{k1: v1, k2: v2, …}</c>
/// (Phase 3.A.4).
/// </summary>
public sealed class MapCreationExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MapCreationExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="typeClause">The leading <c>map[K]V</c> type clause.</param>
    /// <param name="openBraceToken">The opening <c>{</c> token.</param>
    /// <param name="entries">The comma-separated key/value entries.</param>
    /// <param name="closeBraceToken">The closing <c>}</c> token.</param>
    public MapCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        TypeClauseSyntax typeClause,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<MapEntrySyntax> entries,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        TypeClause = typeClause;
        OpenBraceToken = openBraceToken;
        Entries = entries;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MapCreationExpression;

    /// <summary>Gets the <c>map[K]V</c> type clause.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the opening <c>{</c> token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the comma-separated key/value entries.</summary>
    public SeparatedSyntaxList<MapEntrySyntax> Entries { get; }

    /// <summary>Gets the closing <c>}</c> token.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
