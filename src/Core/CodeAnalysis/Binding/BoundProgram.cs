// <copyright file="BoundProgram.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System.Collections.Immutable;
    using GSharp.Core.CodeAnalysis.Symbols;

    /// <summary>
    /// Bound program.
    /// </summary>
    internal sealed class BoundProgram
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BoundProgram"/> class.
        /// </summary>
        /// <param name="packageName">The package name.</param>
        /// <param name="diagnostics">The diagnostics.</param>
        /// <param name="functions">The functions.</param>
        /// <param name="statement">The statements.</param>
        public BoundProgram(
            string packageName,
            ImmutableArray<Diagnostic> diagnostics,
            ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
            BoundBlockStatement statement)
        {
            PackageName = packageName;
            Diagnostics = diagnostics;
            Functions = functions;
            Statement = statement;
        }

        /// <summary>
        /// Gets the package name for this bound program.
        /// </summary>
        public string PackageName { get; }

        /// <summary>
        /// Gets the diagnostics.
        /// </summary>
        public ImmutableArray<Diagnostic> Diagnostics { get; }

        /// <summary>
        /// Gets the functions.
        /// </summary>
        public ImmutableDictionary<FunctionSymbol, BoundBlockStatement> Functions { get; }

        /// <summary>
        /// Gets the statements.
        /// </summary>
        public BoundBlockStatement Statement { get; }
    }
}
