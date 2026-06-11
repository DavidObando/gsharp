// <copyright file="IfLetBindingClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// One <c>let name [T] = expr</c> clause inside an
/// <see cref="IfLetStatementSyntax"/> or <see cref="GuardLetStatementSyntax"/>
/// header (ADR-0071 / issue #708).
/// </summary>
public sealed class IfLetBindingClauseSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfLetBindingClauseSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="letKeyword">The <c>let</c> keyword token.</param>
    /// <param name="identifier">The identifier the binding introduces.</param>
    /// <param name="typeClause">The optional declared (underlying, non-null) type.</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="initializer">The right-hand-side initializer expression.</param>
    public IfLetBindingClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken letKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken equalsToken,
        ExpressionSyntax initializer)
        : base(syntaxTree)
    {
        LetKeyword = letKeyword;
        Identifier = identifier;
        TypeClause = typeClause;
        EqualsToken = equalsToken;
        Initializer = initializer;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IfLetBindingClause;

    /// <summary>Gets the <c>let</c> keyword token.</summary>
    public SyntaxToken LetKeyword { get; }

    /// <summary>Gets the identifier the binding introduces.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional declared (underlying, non-null) type clause.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the <c>=</c> token between the identifier (or type clause) and the initializer.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the right-hand-side initializer expression.</summary>
    public ExpressionSyntax Initializer { get; }
}
