#nullable disable

// <copyright file="IndirectAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0060 §13: syntax for an indirect assignment <c>*p = expr</c>. The
/// <see cref="Target"/> is a <see cref="UnaryExpressionSyntax"/> whose
/// operator is <c>*</c> (managed-pointer dereference). The binder lowers
/// this to a <c>BoundIndirectAssignmentExpression</c>; the emitter lowers
/// to <c>&lt;load-address&gt; &lt;value&gt; stind.*</c>.
/// </summary>
public sealed class IndirectAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="IndirectAssignmentExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The <c>*p</c> dereference target (unary expression with <c>*</c> operator).</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="value">The right-hand-side expression being stored through the pointer.</param>
    public IndirectAssignmentExpressionSyntax(SyntaxTree syntaxTree, UnaryExpressionSyntax target, SyntaxToken equalsToken, ExpressionSyntax value)
        : base(syntaxTree)
    {
        Target = target;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.IndirectAssignmentExpression;

    /// <summary>Gets the <c>*p</c> dereference target.</summary>
    public UnaryExpressionSyntax Target { get; }

    /// <summary>Gets the <c>=</c> token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the right-hand-side value being stored.</summary>
    public ExpressionSyntax Value { get; }
}
