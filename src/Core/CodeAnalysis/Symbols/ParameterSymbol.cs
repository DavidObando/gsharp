// <copyright file="ParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    /// <summary>
    /// Represents a function declaration parameter symbol in the language.
    /// </summary>
    public sealed class ParameterSymbol : LocalVariableSymbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ParameterSymbol"/> class.
        /// </summary>
        /// <param name="name">The parameter name.</param>
        /// <param name="type">The parameter type.</param>
        public ParameterSymbol(string name, TypeSymbol type)
            : base(name, isReadOnly: true, type)
        {
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.Parameter;
    }
}
