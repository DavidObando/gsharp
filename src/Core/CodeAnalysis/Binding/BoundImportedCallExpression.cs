// <copyright file="BoundImportedCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Collections.Immutable;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound call expression.
    /// </summary>
    internal sealed class BoundImportedCallExpression : BoundExpression
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundImportedCallExpression"/> class.
        /// </summary>
        /// <param name="function">The function symbol.</param>
        /// <param name="arguments">The provided arguments.</param>
        public BoundImportedCallExpression(ImportedFunctionSymbol function, ImmutableArray<BoundExpression> arguments)
        {
            Function = function;
            Arguments = arguments;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.ImportedCallExpression;

        /// <inheritdoc/>
        public override TypeSymbol Type => Function.Type;

        /// <summary>
        /// Gets the imported function symbol.
        /// </summary>
        public ImportedFunctionSymbol Function { get; }

        /// <summary>
        /// Gets the provided arguments.
        /// </summary>
        public ImmutableArray<BoundExpression> Arguments { get; }
    }
}
