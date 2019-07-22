// <copyright file="BoundGlobalScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Collections.Immutable;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Global scope-level binding. Enables compilations to be chained.
    /// </summary>
    internal sealed class BoundGlobalScope
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundGlobalScope"/> class.
        /// </summary>
        /// <param name="previous">Previous compilation global scope.</param>
        /// <param name="package">The package for the current compilation.</param>
        /// <param name="diagnostics">Diagnostics for the current compilation.</param>
        /// <param name="functions">Functions in the current compilation.</param>
        /// <param name="variables">Variables in the current compilation.</param>
        /// <param name="statements">Statements in the current compilation.</param>
        public BoundGlobalScope(
            BoundGlobalScope previous,
            PackageSymbol package,
            ImmutableArray<Diagnostic> diagnostics,
            ImmutableArray<FunctionSymbol> functions,
            ImmutableArray<VariableSymbol> variables,
            ImmutableArray<BoundStatement> statements)
        {
            Previous = previous;
            Package = package;
            Diagnostics = diagnostics;
            Functions = functions;
            Variables = variables;
            Statements = statements;
        }

        /// <summary>
        /// Gets the previous compilation global scope.
        /// </summary>
        public BoundGlobalScope Previous { get; }

        /// <summary>
        /// Gets the package symbol for the current compilation.
        /// </summary>
        public PackageSymbol Package { get; }

        /// <summary>
        /// Gets the diagnostics for the current compilation.
        /// </summary>
        public ImmutableArray<Diagnostic> Diagnostics { get; }

        /// <summary>
        /// Gets the functions in the current compilation.
        /// </summary>
        public ImmutableArray<FunctionSymbol> Functions { get; }

        /// <summary>
        /// Gets the variables in the current compilation.
        /// </summary>
        public ImmutableArray<VariableSymbol> Variables { get; }

        /// <summary>
        /// Gets the statements in the current compilation.
        /// </summary>
        public ImmutableArray<BoundStatement> Statements { get; }
    }
}
