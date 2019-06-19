// <copyright file="BoundLabelStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound label statement.
    /// </summary>
    internal sealed class BoundLabelStatement : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundLabelStatement"/> class.
        /// </summary>
        /// <param name="label">The label.</param>
        public BoundLabelStatement(BoundLabel label)
        {
            Label = label;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.LabelStatement;

        /// <summary>
        /// Gets the label.
        /// </summary>
        public BoundLabel Label { get; }
    }
}
