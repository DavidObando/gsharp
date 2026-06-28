#nullable disable

// <copyright file="IndexedCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #479 / ADR-0117: an indexed element of a dictionary collection
/// initializer, e.g. the <c>["a"] = 1</c> in
/// <c>Dictionary[string, int32]{ ["a"] = 1 }</c>. Lowers to an indexer set
/// <c>self["a"] = 1</c> (overwrite semantics, matching C#'s indexed
/// element initializer).
/// </summary>
public sealed class IndexedCollectionElementSyntax : CollectionElementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IndexedCollectionElementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening <c>[</c> token.</param>
    /// <param name="key">The key expression inside the brackets.</param>
    /// <param name="closeBracketToken">The closing <c>]</c> token.</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="value">The value expression.</param>
    public IndexedCollectionElementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        ExpressionSyntax key,
        SyntaxToken closeBracketToken,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        Key = key;
        CloseBracketToken = closeBracketToken;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndexedCollectionElement;

    /// <summary>Gets the opening <c>[</c> token.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the key expression inside the brackets.</summary>
    public ExpressionSyntax Key { get; }

    /// <summary>Gets the closing <c>]</c> token.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the <c>=</c> token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
