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
        /// The type error symbol.
        /// </summary>
        public static readonly TypeSymbol Error = new TypeSymbol("?");

        /// <summary>
        /// The `bool` symbol.
        /// </summary>
        public static readonly TypeSymbol Bool = new TypeSymbol("bool");

        /// <summary>
        /// The `int` symbol.
        /// </summary>
        public static readonly TypeSymbol Int = new TypeSymbol("int");

        /// <summary>
        /// The `string` symbol.
        /// </summary>
        public static readonly TypeSymbol String = new TypeSymbol("string");

        /// <summary>
        /// The void type symbol.
        /// </summary>
        public static readonly TypeSymbol Void = new TypeSymbol("void");

        private TypeSymbol(string name)
            : base(name)
        {
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.Type;
    }
}
