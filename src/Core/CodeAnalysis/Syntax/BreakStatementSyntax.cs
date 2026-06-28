#nullable disable

// <copyright file="BreakStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the break statement syntax in the language. An optional trailing
/// identifier (on the same source line) names an enclosing labeled loop
/// (ADR-0070).
/// </summary>
public class BreakStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BreakStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The break keyword.</param>
    /// <param name="labelIdentifier">
    /// Optional target label identifier (must appear on the same source line
    /// as the <paramref name="keyword"/>); <see langword="null"/> for an
    /// innermost-loop break.
    /// </param>
    public BreakStatementSyntax(SyntaxTree syntaxTree, SyntaxToken keyword, SyntaxToken labelIdentifier = null)
        : base(syntaxTree)
    {
        Keyword = keyword;
        LabelIdentifier = labelIdentifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.BreakStatement;

    /// <summary>
    /// Gets the break keyword.
    /// </summary>
    public SyntaxToken Keyword { get; }

    /// <summary>
    /// Gets the optional target label identifier (<see langword="null"/> when
    /// the break targets the innermost enclosing loop).
    /// </summary>
    public SyntaxToken LabelIdentifier { get; }
}
