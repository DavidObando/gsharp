// <copyright file="Symbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System.IO;

    /// <summary>
    /// Represents a symbol in the language.
    /// </summary>
    public abstract class Symbol
    {
        private protected Symbol(string name)
        {
            Name = name;
        }

        /// <summary>
        /// Gets the kind of symbol this instance represents.
        /// </summary>
        public abstract SymbolKind Kind { get; }

        /// <summary>
        /// Gets the name of the symbol.
        /// </summary>
        public string Name { get; }

        /// <summary>
        /// Writes the symbol to the specified text writer.
        /// </summary>
        /// <param name="writer">The writer to write the symbol to.</param>
        public void WriteTo(TextWriter writer)
        {
            SymbolPrinter.WriteTo(this, writer);
        }

        /// <summary>
        /// Gives a string representation of this symbol.
        /// </summary>
        /// <returns>A string representation of the symbol.</returns>
        public override string ToString()
        {
            using (var writer = new StringWriter())
            {
                WriteTo(writer);
                return writer.ToString();
            }
        }
    }
}
