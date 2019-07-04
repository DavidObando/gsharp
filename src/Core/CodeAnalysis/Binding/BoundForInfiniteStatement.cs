// <copyright file="BoundForInfiniteStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound for infinite statement.
    /// </summary>
    internal sealed class BoundForInfiniteStatement : BoundLoopStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundForInfiniteStatement"/> class.
        /// </summary>
        /// <param name="body">The body.</param>
        /// <param name="breakLabel">The break label.</param>
        /// <param name="continueLabel">The continue label.</param>
        public BoundForInfiniteStatement(
            BoundStatement body,
            BoundLabel breakLabel,
            BoundLabel continueLabel)
            : base(breakLabel, continueLabel)
        {
            Body = body;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ForInfiniteStatement;

        /// <summary>
        /// Gets the body.
        /// </summary>
        public BoundStatement Body { get; }
    }
}
