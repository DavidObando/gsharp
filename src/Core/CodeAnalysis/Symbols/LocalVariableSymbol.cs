// <copyright file="LocalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    /// <summary>
    /// Represents a local variable symbol in the language.
    /// </summary>
    public class LocalVariableSymbol : VariableSymbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="LocalVariableSymbol"/> class.
        /// </summary>
        /// <param name="name">The local variable's name.</param>
        /// <param name="isReadOnly">Whether the local variable is read-only or not.</param>
        /// <param name="type">The local variable's type.</param>
        public LocalVariableSymbol(string name, bool isReadOnly, TypeSymbol type)
            : base(name, isReadOnly, type)
        {
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.LocalVariable;
    }
}
