// <copyright file="BoundErrorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound error expression.
    /// </summary>
    internal sealed class BoundErrorExpression : BoundExpression
    {
        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ErrorExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type => TypeSymbol.Error;
    }
}
