// <copyright file="GlobalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    /// <summary>
    /// Represents a global variable symbol in the language.
    /// </summary>
    public sealed class GlobalVariableSymbol : VariableSymbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="GlobalVariableSymbol"/> class.
        /// </summary>
        /// <param name="name">The variable name.</param>
        /// <param name="isReadOnly">Whether it's read-only or not.</param>
        /// <param name="type">The type of the variable.</param>
        internal GlobalVariableSymbol(string name, bool isReadOnly, TypeSymbol type)
            : base(name, isReadOnly, type)
        {
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.GlobalVariable;
    }
}
