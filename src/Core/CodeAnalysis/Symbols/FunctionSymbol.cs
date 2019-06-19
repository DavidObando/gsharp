// <copyright file="FunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols
{
    using System.Collections.Immutable;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Represents a function symbol in the language.
    /// </summary>
    public sealed class FunctionSymbol : Symbol
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
        /// </summary>
        /// <param name="name">The name of the function.</param>
        /// <param name="parameters">The parameters of the function.</param>
        /// <param name="type">The type of the function.</param>
        /// <param name="declaration">The declaration of the function.</param>
        public FunctionSymbol(
            string name,
            ImmutableArray<ParameterSymbol> parameters,
            TypeSymbol type,
            FunctionDeclarationSyntax declaration = null)
            : base(name)
        {
            Parameters = parameters;
            Type = type;
            Declaration = declaration;
        }

        /// <inheritdoc/>
        public override SymbolKind Kind => SymbolKind.Function;

        /// <summary>
        /// Gets the parameters of the function.
        /// </summary>
        public ImmutableArray<ParameterSymbol> Parameters { get; }

        /// <summary>
        /// Gets the type of the function.
        /// </summary>
        public TypeSymbol Type { get; }

        /// <summary>
        /// Gets the declaration of the function.
        /// </summary>
        public FunctionDeclarationSyntax Declaration { get; }
    }
}
