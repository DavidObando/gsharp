// <copyright file="EventSubscriptionExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Stream B′: <c>receiver.Event += handler</c> / <c>receiver.Event -= handler</c>
/// subscription to a CLR event. The <see cref="LeftHandSide"/> is the full
/// member-access chain ending at the event name (so multi-segment receivers
/// such as <c>foo.Bar.Baz.Event += h</c> are captured naturally as an
/// <see cref="AccessorExpressionSyntax"/>).
/// </summary>
public sealed class EventSubscriptionExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EventSubscriptionExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="leftHandSide">The accessor chain identifying the event (receiver.Event).</param>
    /// <param name="operatorToken">The <c>+=</c> or <c>-=</c> token.</param>
    /// <param name="value">The handler expression on the right side.</param>
    public EventSubscriptionExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax leftHandSide,
        SyntaxToken operatorToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        LeftHandSide = leftHandSide;
        OperatorToken = operatorToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.EventSubscriptionExpression;

    /// <summary>Gets the member-access chain identifying the event.</summary>
    public ExpressionSyntax LeftHandSide { get; }

    /// <summary>Gets the <c>+=</c> or <c>-=</c> token.</summary>
    public SyntaxToken OperatorToken { get; }

    /// <summary>Gets the handler expression on the right-hand side.</summary>
    public ExpressionSyntax Value { get; }
}
