// <copyright file="BoundExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound expression.
    /// </summary>
    internal abstract class BoundExpression : BoundNode
    {
        /// <summary>
        /// Gets the bound expression type.
        /// </summary>
        public abstract TypeSymbol Type { get; }
    }
}
