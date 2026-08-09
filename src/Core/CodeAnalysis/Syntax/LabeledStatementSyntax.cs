// <copyright file="LabeledStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a labeled statement of the form <c>name: statement</c>
/// (ADR-0070, extended by issue #1884). A label on a loop statement names it
/// for <c>break</c>/<c>continue</c> (ADR-0070); a label on any other
/// statement is a <c>goto</c> target (issue #1884). A duplicate label name
/// within the same enclosing function is reported as GS0470.
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
