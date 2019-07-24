// <copyright file="BoundBlockStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Collections.Immutable;

    /// <summary>
    /// Bound block statement.
    /// </summary>
    public sealed class BoundBlockStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundBlockStatement"/> class.
        /// </summary>
        /// <param name="statements">The immutable array of bound statements.</param>
        public BoundBlockStatement(ImmutableArray<BoundStatement> statements)
        {
            Statements = statements;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.BlockStatement;

        /// <summary>
        /// Gets the immutable array of bound statements.
        /// </summary>
        public ImmutableArray<BoundStatement> Statements { get; }
    }
}
