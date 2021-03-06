﻿// <copyright file="BoundForEllipsisStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound for ellipsis statement.
    /// </summary>
    public sealed class BoundForEllipsisStatement : BoundLoopStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundForEllipsisStatement"/> class.
        /// </summary>
        /// <param name="variable">The variable.</param>
        /// <param name="lowerBound">The lower bound expression.</param>
        /// <param name="upperBound">The upper bound expression.</param>
        /// <param name="body">The body.</param>
        /// <param name="breakLabel">The break label.</param>
        /// <param name="continueLabel">The continue label.</param>
        public BoundForEllipsisStatement(
            VariableSymbol variable,
            BoundExpression lowerBound,
            BoundExpression upperBound,
            BoundStatement body,
            BoundLabel breakLabel,
            BoundLabel continueLabel)
            : base(breakLabel, continueLabel)
        {
            Variable = variable;
            LowerBound = lowerBound;
            UpperBound = upperBound;
            Body = body;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ForEllipsisStatement;

        /// <summary>
        /// Gets the variable.
        /// </summary>
        public VariableSymbol Variable { get; }

        /// <summary>
        /// Gets the lower bound expression.
        /// </summary>
        public BoundExpression LowerBound { get; }

        /// <summary>
        /// Gets the upper bound expression.
        /// </summary>
        public BoundExpression UpperBound { get; }

        /// <summary>
        /// Gets the body.
        /// </summary>
        public BoundStatement Body { get; }
    }
}
