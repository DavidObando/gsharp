#nullable disable

// <copyright file="LabeledStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a labeled statement of the form <c>name: loop-statement</c>
/// (ADR-0070). Only loop statements may carry a label; the binder reports
/// GS0294 when a non-loop statement is labeled but accepts the inner statement
/// so subsequent diagnostics are not suppressed.
/// </summary>
public sealed class LabeledStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LabeledStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="labelIdentifier">The label identifier token.</param>
    /// <param name="colonToken">The colon following the label.</param>
    /// <param name="statement">The labeled statement (expected to be a loop).</param>
    public LabeledStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken labelIdentifier,
        SyntaxToken colonToken,
        StatementSyntax statement)
        : base(syntaxTree)
    {
        LabelIdentifier = labelIdentifier;
        ColonToken = colonToken;
        Statement = statement;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.LabeledStatement;

    /// <summary>
    /// Gets the label identifier token.
    /// </summary>
    public SyntaxToken LabelIdentifier { get; }

    /// <summary>
    /// Gets the colon token.
    /// </summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>
    /// Gets the inner statement carrying the label.
    /// </summary>
    public StatementSyntax Statement { get; }
}
