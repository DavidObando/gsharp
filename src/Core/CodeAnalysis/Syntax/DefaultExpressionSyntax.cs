#nullable disable

// <copyright file="DefaultExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0100 / issue #795: a <c>default(T)</c> or bare <c>default</c>
/// expression. The two forms are surfaced by the same node so downstream
/// code only sees one syntax kind: <see cref="TypeClause"/> is non-null
/// for <c>default(T)</c> and null for the bare literal.
/// </summary>
/// <remarks>
/// The <c>default</c> keyword's existing role as a switch-arm leader is
/// preserved. <see cref="Parser"/> matches arm-leading <c>default</c>
/// inside <c>ParseSwitchCase</c>, <c>ParseSelectCase</c>, and
/// <c>ParseSwitchExpressionArm</c> before any expression dispatch, so
/// this expression node only fires for true value-position uses.
/// </remarks>
public sealed class DefaultExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DefaultExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="defaultKeyword">The <c>default</c> keyword token.</param>
    /// <param name="openParenthesis">The <c>(</c> token, or <see langword="null"/> for bare <c>default</c>.</param>
    /// <param name="typeClause">The type clause inside the parentheses, or <see langword="null"/> for bare <c>default</c>.</param>
    /// <param name="closeParenthesis">The <c>)</c> token, or <see langword="null"/> for bare <c>default</c>.</param>
    public DefaultExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken defaultKeyword,
        SyntaxToken openParenthesis,
        TypeClauseSyntax typeClause,
        SyntaxToken closeParenthesis)
        : base(syntaxTree)
    {
        DefaultKeyword = defaultKeyword;
        OpenParenthesis = openParenthesis;
        TypeClause = typeClause;
        CloseParenthesis = closeParenthesis;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.DefaultExpression;

    /// <summary>Gets the <c>default</c> keyword token.</summary>
    public SyntaxToken DefaultKeyword { get; }

    /// <summary>Gets the opening <c>(</c> token, or <see langword="null"/> for the bare form.</summary>
    public SyntaxToken OpenParenthesis { get; }

    /// <summary>Gets the type clause argument, or <see langword="null"/> for the bare form.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the closing <c>)</c> token, or <see langword="null"/> for the bare form.</summary>
    public SyntaxToken CloseParenthesis { get; }

    /// <summary>
    /// Gets a value indicating whether this is the parenthesized
    /// <c>default(T)</c> form (with an explicit type clause) rather than
    /// the bare <c>default</c> literal.
    /// </summary>
    public bool HasTypeClause => TypeClause != null;
}
