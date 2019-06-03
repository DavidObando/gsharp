// <copyright file="SymbolPrinter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System;
    using System.IO;
    using GSharp.Core.IO;

    /// <summary>
    /// Symbol printer.
    /// </summary>
    public static class SymbolPrinter
    {
        /// <summary>
        /// Writes a symbol to the specified writer.
        /// </summary>
        /// <param name="symbol">The symbol.</param>
        /// <param name="writer">The writer.</param>
        public static void WriteTo(Symbol symbol, TextWriter writer)
        {
            switch (symbol.Kind)
            {
                case SymbolKind.Type:
                    WriteTypeTo((TypeSymbol)symbol, writer);
                    break;
                default:
                    throw new Exception($"Unexpected symbol: {symbol.Kind}");
            }
        }

        private static void WriteTypeTo(TypeSymbol symbol, TextWriter writer)
        {
            writer.WriteIdentifier(symbol.Name);
        }
    }
}
