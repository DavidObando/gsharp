// <copyright file="BoundVariableDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound variable declaration.
    /// </summary>
    public sealed class BoundVariableDeclaration : BoundStatement
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundVariableDeclaration"/> class.
        /// </summary>
        /// <param name="variable">The variable symbol.</param>
        /// <param name="initializer">The bound expression.</param>
        public BoundVariableDeclaration(VariableSymbol variable, BoundExpression initializer)
        {
            Variable = variable;
            Initializer = initializer;
        }

        /// <inheritdoc/>
        public override BoundNodeKind Kind => BoundNodeKind.VariableDeclaration;

        /// <summary>
        /// Gets the variable symbol.
        /// </summary>
        public VariableSymbol Variable { get; }

        /// <summary>
        /// Gets the bound expression.
        /// </summary>
        public BoundExpression Initializer { get; }
    }
}
