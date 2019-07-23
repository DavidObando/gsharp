// <copyright file="ImportSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Represents an import symbol in the language.
    /// </summary>
    public sealed class ImportSymbol : Symbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ImportSymbol"/> class.
        /// </summary>
        /// <param name="name">The import name.</param>
        /// <param name="declaration">The declaration.</param>
        public ImportSymbol(string name, ImportSyntax declaration)
            : base(name)
        {
            Declaration = declaration;
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.Import;

        /// <summary>
        /// Gets the declaration of the import.
        /// </summary>
        public ImportSyntax Declaration { get; }
    }
}
