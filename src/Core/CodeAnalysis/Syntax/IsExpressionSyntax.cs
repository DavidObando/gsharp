// <copyright file="IsExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an expression-level pattern test: <c>expr is pattern</c> → <c>bool</c>.
/// Issues #575 and #3351.
/// </summary>
public sealed class IsExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="IsExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The expression whose runtime type is tested.</param>
    /// <param name="isKeyword">The <c>is</c> keyword token.</param>
    /// <param name="pattern">The pattern tested against the expression value.</param>
    public IsExpressionSyntax(SyntaxTree syntaxTree, ExpressionSyntax expression, SyntaxToken isKeyword, PatternSyntax pattern)
        : base(syntaxTree)
    {
        Expression = expression;
        IsKeyword = isKeyword;
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IsExpression;

    /// <summary>Gets the left-hand expression being type-tested.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the <c>is</c> keyword token.</summary>
    public SyntaxToken IsKeyword { get; }

    /// <summary>Gets the pattern tested against the expression value.</summary>
    public PatternSyntax Pattern { get; }

    /// <summary>
    /// Gets the target type clause for a direct type test, or <see langword="null"/>
    /// for a general pattern.
    /// </summary>
    [SyntaxChildIgnore]
    public TypeClauseSyntax? TypeClause => Pattern switch
    {
        TypePatternSyntax typePattern => typePattern.Type,
        TypeOrConstantPatternSyntax candidate => candidate.CandidateType,
        _ => null,
    };
}
