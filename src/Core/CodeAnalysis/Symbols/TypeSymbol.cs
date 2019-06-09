// <copyright file="TypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    /// <summary>
    /// Represents a type symbol in the language.
    /// </summary>
    public sealed class TypeSymbol : Symbol
    {
        /// <summary>
        /// The `int` symbol.
        /// </summary>
        public static readonly TypeSymbol Int = new TypeSymbol("int");

        /// <summary>
        /// The `string` symbol.
        /// </summary>
        public static readonly TypeSymbol String = new TypeSymbol("string");

        private TypeSymbol(string name)
            : base(name)
        {
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.Type;
    }
}
