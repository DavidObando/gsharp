// <copyright file="AwaitForRangeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Phase 5.8 / ADR-0023: <c>await for v := range stream { ... }</c>.
/// Iterates an <c>IAsyncEnumerable[T]</c>; each iteration awaits the
/// underlying <c>MoveNextAsync()</c>. The canonical
/// <c>for v in stream</c> spelling subsumes this in Phase 7.
/// </summary>
public sealed class AwaitForRangeStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AwaitForRangeStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="awaitKeyword">The <c>await</c> keyword.</param>
    /// <param name="forKeyword">The <c>for</c> keyword.</param>
    /// <param name="identifier">The element identifier.</param>
    /// <param name="colonEqualsToken">The <c>:=</c> token.</param>
    /// <param name="rangeKeyword">The <c>range</c> keyword.</param>
    /// <param name="stream">The stream expression.</param>
    /// <param name="body">The loop body.</param>
    public AwaitForRangeStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken awaitKeyword,
        SyntaxToken forKeyword,
        SyntaxToken identifier,
        SyntaxToken colonEqualsToken,
        SyntaxToken rangeKeyword,
        ExpressionSyntax stream,
        StatementSyntax body)
        : base(syntaxTree)
    {
        AwaitKeyword = awaitKeyword;
        ForKeyword = forKeyword;
        Identifier = identifier;
        ColonEqualsToken = colonEqualsToken;
        RangeKeyword = rangeKeyword;
        Stream = stream;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AwaitForRangeStatement;

    /// <summary>Gets the <c>await</c> keyword.</summary>
    public SyntaxToken AwaitKeyword { get; }

    /// <summary>Gets the <c>for</c> keyword.</summary>
    public SyntaxToken ForKeyword { get; }

    /// <summary>Gets the element identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the <c>:=</c> token.</summary>
    public SyntaxToken ColonEqualsToken { get; }

    /// <summary>Gets the <c>range</c> keyword.</summary>
    public SyntaxToken RangeKeyword { get; }

    /// <summary>Gets the stream expression (must be an <c>IAsyncEnumerable[T]</c>).</summary>
    public ExpressionSyntax Stream { get; }

    /// <summary>Gets the loop body.</summary>
    public StatementSyntax Body { get; }
}
