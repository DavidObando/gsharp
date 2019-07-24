// <copyright file="BoundCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Collections.Immutable;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound call expression.
    /// </summary>
    public sealed class BoundCallExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundCallExpression"/> class.
        /// </summary>
        /// <param name="function">The function symbol.</param>
        /// <param name="arguments">The provided arguments.</param>
        public BoundCallExpression(FunctionSymbol function, ImmutableArray<BoundExpression> arguments)
        {
            Function = function;
            Arguments = arguments;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.CallExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type => Function.Type;

        /// <summary>
        /// Gets the function symbol.
        /// </summary>
        public FunctionSymbol Function { get; }

        /// <summary>
        /// Gets the provided arguments.
        /// </summary>
        public ImmutableArray<BoundExpression> Arguments { get; }
    }
}
