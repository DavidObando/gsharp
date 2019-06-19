// <copyright file="BoundConditionalGotoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound conditional goto statement.
    /// </summary>
    internal sealed class BoundConditionalGotoStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundConditionalGotoStatement"/> class.
        /// </summary>
        /// <param name="label">The label.</param>
        /// <param name="condition">The condition.</param>
        /// <param name="jumpIfTrue">Whether to jump on true, or on false.</param>
        public BoundConditionalGotoStatement(BoundLabel label, BoundExpression condition, bool jumpIfTrue = true)
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
}
