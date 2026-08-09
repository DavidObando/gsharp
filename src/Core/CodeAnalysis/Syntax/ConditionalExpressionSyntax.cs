// <copyright file="ConditionalExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0062: a general two-arm conditional (ternary) expression of the form
/// <c>&lt;cond&gt; ? &lt;ifTrue&gt; : &lt;ifFalse&gt;</c>. Valid in any expression
/// position. The operator is right-associative and binds at a lower precedence
/// than logical-or but higher than assignment.
/// </summary>
/// <remarks>
/// In ref-kind argument payloads (<c>ref</c>/<c>out</c>/<c>in</c>) and as the
/// operand of <c>&amp;</c>, this same syntax is reinterpreted by the binder as
/// a conditional address-of (<see cref="GSharp.Core.CodeAnalysis.Binding.BoundConditionalAddressExpression"/>),
/// preserving ADR-0061's byref semantics.
/// </remarks>
public sealed class ConditionalExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ConditionalExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="condition">The condition expression.</param>
    /// <param name="questionToken">The literal <c>?</c> token.</param>
    /// <param name="whenTrue">The expression evaluated when the condition is <c>true</c>.</param>
    /// <param name="colonToken">The literal <c>:</c> token.</param>
    /// <param name="whenFalse">The expression evaluated when the condition is <c>false</c>.</param>
    public ConditionalExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax condition,
        SyntaxToken questionToken,
        ExpressionSyntax whenTrue,
        SyntaxToken colonToken,
        ExpressionSyntax whenFalse)
        : base(syntaxTree)
    {
        Condition = condition;
        QuestionToken = questionToken;
        WhenTrue = whenTrue;
        ColonToken = colonToken;
        WhenFalse = whenFalse;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ConditionalExpression;

    /// <summary>Gets the condition expression.</summary>
    public ExpressionSyntax Condition { get; }

    /// <summary>Gets the literal <c>?</c> token.</summary>
    public SyntaxToken QuestionToken { get; }

    /// <summary>Gets the expression evaluated when the condition is <c>true</c>.</summary>
    public ExpressionSyntax WhenTrue { get; }

    /// <summary>Gets the literal <c>:</c> token.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the expression evaluated when the condition is <c>false</c>.</summary>
    public ExpressionSyntax WhenFalse { get; }
}
