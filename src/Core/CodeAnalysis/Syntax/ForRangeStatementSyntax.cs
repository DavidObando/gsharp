// <copyright file="ForRangeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a for-range statement: <c>for v := range coll { ... }</c> or
/// <c>for k, v := range coll { ... }</c>. For arrays and slices the first
/// identifier binds the int index; for maps / CLR dictionaries the first
/// identifier binds the key. The second identifier (when present) binds
/// the element / value. Phase 4 exit.
/// </summary>
public sealed class ForRangeStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ForRangeStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>for</c> keyword.</param>
    /// <param name="firstIdentifier">The first identifier (index/key, or value when alone).</param>
    /// <param name="commaToken">Optional comma separating the two identifiers.</param>
    /// <param name="secondIdentifier">Optional second identifier (the value).</param>
    /// <param name="colonEqualsToken">The <c>:=</c> token.</param>
    /// <param name="rangeKeyword">The <c>range</c> keyword.</param>
    /// <param name="collection">The collection expression.</param>
    /// <param name="body">The loop body.</param>
    public ForRangeStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SyntaxToken firstIdentifier,
        SyntaxToken commaToken,
        SyntaxToken secondIdentifier,
        SyntaxToken colonEqualsToken,
        SyntaxToken rangeKeyword,
        ExpressionSyntax collection,
        StatementSyntax body)
        : base(syntaxTree)
    {
        Keyword = keyword;
        FirstIdentifier = firstIdentifier;
        CommaToken = commaToken;
        SecondIdentifier = secondIdentifier;
        ColonEqualsToken = colonEqualsToken;
        RangeKeyword = rangeKeyword;
        Collection = collection;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ForRangeStatement;

    /// <summary>Gets the <c>for</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the first identifier (index/key, or value when no second identifier is present).</summary>
    public SyntaxToken FirstIdentifier { get; }

    /// <summary>Gets the optional comma separating the two identifiers.</summary>
    public SyntaxToken CommaToken { get; }

    /// <summary>Gets the optional second identifier (the value).</summary>
    public SyntaxToken SecondIdentifier { get; }

    /// <summary>Gets the <c>:=</c> token.</summary>
    public SyntaxToken ColonEqualsToken { get; }

    /// <summary>Gets the <c>range</c> keyword.</summary>
    public SyntaxToken RangeKeyword { get; }

    /// <summary>Gets the collection expression.</summary>
    public ExpressionSyntax Collection { get; }

    /// <summary>Gets the loop body.</summary>
    public StatementSyntax Body { get; }
}
