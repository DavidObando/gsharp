// <copyright file="ForTupleRangeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a deconstructing for-in loop, <c>for (a, b, ...) in coll { ... }</c>
/// (issue #1922). Each loop iteration binds one read-only local per
/// identifier to the corresponding element of the current tuple- or
/// data-struct-typed sequence value, instead of requiring a separate hidden
/// loop variable plus a <c>let (a, b) = tmp</c> deconstruction statement.
/// </summary>
public sealed class ForTupleRangeStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ForTupleRangeStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>for</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="identifiers">The comma-separated deconstruction target identifiers.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    /// <param name="inToken">The contextual <c>in</c> token.</param>
    /// <param name="collection">The collection expression.</param>
    /// <param name="body">The loop body.</param>
    public ForTupleRangeStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<SyntaxToken> identifiers,
        SyntaxToken closeParenToken,
        SyntaxToken inToken,
        ExpressionSyntax collection,
        StatementSyntax body)
        : base(syntaxTree)
    {
        Keyword = keyword;
        OpenParenToken = openParenToken;
        Identifiers = identifiers;
        CloseParenToken = closeParenToken;
        InToken = inToken;
        Collection = collection;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ForTupleRangeStatement;

    /// <summary>Gets the <c>for</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the deconstruction target identifiers.</summary>
    public SeparatedSyntaxList<SyntaxToken> Identifiers { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the contextual <c>in</c> token.</summary>
    public SyntaxToken InToken { get; }

    /// <summary>Gets the collection expression.</summary>
    public ExpressionSyntax Collection { get; }

    /// <summary>Gets the loop body.</summary>
    public StatementSyntax Body { get; }
}
