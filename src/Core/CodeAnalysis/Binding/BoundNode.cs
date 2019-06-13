// <copyright file="BoundNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.IO;

    /// <summary>
    /// Abstract base for a bound node.
    /// </summary>
    internal abstract class BoundNode
    {
        /// <summary>
        /// Gets the kind of bound node for this instance.
        /// </summary>
        public abstract BoundNodeKind Kind { get; }

        /// <inheritdoc/>
        public override string ToString()
        {
            using (var writer = new StringWriter())
            {
                this.WriteTo(writer);
                return writer.ToString();
            }
        }
    }
}