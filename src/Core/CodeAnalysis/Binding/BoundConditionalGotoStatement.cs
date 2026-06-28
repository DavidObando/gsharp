#nullable disable

// <copyright file="BoundConditionalGotoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound conditional goto statement.
/// </summary>
public sealed class BoundConditionalGotoStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundConditionalGotoStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="label">The label.</param>
    /// <param name="condition">The condition.</param>
    /// <param name="jumpIfTrue">Whether to jump on true, or on false.</param>
    public BoundConditionalGotoStatement(SyntaxNode syntax, BoundLabel label, BoundExpression condition, bool jumpIfTrue = true)
        : base(syntax)
    {
        Label = label;
        Condition = condition;
        JumpIfTrue = jumpIfTrue;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConditionalGotoStatement;

    /// <summary>
    /// Gets the label.
    /// </summary>
    public BoundLabel Label { get; }

    /// <summary>
    /// Gets the condition.
    /// </summary>
    public BoundExpression Condition { get; }

    /// <summary>
    /// Gets a value indicating whether to jump on true, or on false.
    /// </summary>
    public bool JumpIfTrue { get; }
}
