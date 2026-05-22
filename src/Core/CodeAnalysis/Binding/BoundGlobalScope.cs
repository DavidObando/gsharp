// <copyright file="BoundGlobalScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Global scope-level binding. Enables compilations to be chained.
/// </summary>
public sealed class BoundGlobalScope
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundGlobalScope"/> class.
    /// </summary>
    /// <param name="previous">Previous compilation global scope.</param>
    /// <param name="package">The package for the current compilation.</param>
    /// <param name="diagnostics">Diagnostics for the current compilation.</param>
    /// <param name="imports">Imports in the current compilation.</param>
    /// <param name="functions">Functions in the current compilation.</param>
    /// <param name="variables">Variables in the current compilation.</param>
    /// <param name="entryPoint">The entry-point function for this compilation, or null if the compilation is a library.</param>
    /// <param name="statements">Statements in the current compilation.</param>
    public BoundGlobalScope(
        BoundGlobalScope previous,
        PackageSymbol package,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableArray<ImportSymbol> imports,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<VariableSymbol> variables,
        FunctionSymbol entryPoint,
        ImmutableArray<BoundStatement> statements)
    {
        Previous = previous;
        Package = package;
        Diagnostics = diagnostics;
        Imports = imports;
        Functions = functions;
        Variables = variables;
        EntryPoint = entryPoint;
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
    /// Gets the imports for the current compilation.
    /// </summary>
    public ImmutableArray<ImportSymbol> Imports { get; }

    /// <summary>
    /// Gets the functions in the current compilation.
    /// </summary>
    public ImmutableArray<FunctionSymbol> Functions { get; }

    /// <summary>
    /// Gets the variables in the current compilation.
    /// </summary>
    public ImmutableArray<VariableSymbol> Variables { get; }

    /// <summary>
    /// Gets the synthesized or explicit entry-point function for this compilation,
    /// or null if the compilation produces a library (no entry point).
    /// </summary>
    public FunctionSymbol EntryPoint { get; }

    /// <summary>
    /// Gets the statements in the current compilation.
    /// </summary>
    public ImmutableArray<BoundStatement> Statements { get; }
}
