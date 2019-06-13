// <copyright file="BoundLabel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound label.
    /// </summary>
    internal sealed class BoundLabel
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundLabel"/> class.
        /// </summary>
        /// <param name="name">The label name.</param>
        internal BoundLabel(string name)
        {
            Name = name;
        }

        /// <summary>
        /// Gets the label name.
        /// </summary>
        public string Name { get; }

        /// <inheritdoc/>
        public override string ToString() => Name;
    }
}
