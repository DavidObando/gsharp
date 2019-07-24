// <copyright file="BoundGotoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound goto statement.
    /// </summary>
    public sealed class BoundGotoStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundGotoStatement"/> class.
        /// </summary>
        /// <param name="label">The label.</param>
        public BoundGotoStatement(BoundLabel label)
        {
            Label = label;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.GotoStatement;

        /// <summary>
        /// Gets the label.
        /// </summary>
        public BoundLabel Label { get; }
    }
}
