#nullable disable

// <copyright file="MultiAssignmentStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a multi-target assignment or short-variable declaration statement,
/// e.g. <c>a, b = b, a</c> or <c>a, b := 1, 2</c>.
/// </summary>
public sealed class MultiAssignmentStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MultiAssignmentStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="targets">The comma-separated target identifiers (each a <see cref="NameExpressionSyntax"/>).</param>
    /// <param name="operatorToken">The operator token (<c>=</c> or <c>:=</c>).</param>
    /// <param name="values">The comma-separated right-hand side expressions.</param>
    public MultiAssignmentStatementSyntax(
        SyntaxTree syntaxTree,
        SeparatedSyntaxList<ExpressionSyntax> targets,
        SyntaxToken operatorToken,
        SeparatedSyntaxList<ExpressionSyntax> values)
        : base(syntaxTree)
    {
        Targets = targets;
        OperatorToken = operatorToken;
        Values = values;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MultiAssignmentStatement;

    /// <summary>
    /// Gets the comma-separated target identifiers.
    /// </summary>
    public SeparatedSyntaxList<ExpressionSyntax> Targets { get; }

    /// <summary>
    /// Gets the operator token (<c>=</c> for assignment, <c>:=</c> for short var declaration).
    /// </summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>
    /// Gets the comma-separated right-hand side value expressions.
    /// </summary>
    public SeparatedSyntaxList<ExpressionSyntax> Values { get; }
}
