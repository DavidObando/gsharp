// <copyright file="BoundProgram.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound program.
/// </summary>
public sealed class BoundProgram
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundProgram"/> class.
    /// </summary>
    /// <param name="packageName">The package name.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    public BoundProgram(
        string packageName,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement)
    {
        PackageName = packageName;
        Diagnostics = diagnostics;
        Functions = functions;
        EntryPoint = entryPoint;
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
    /// Gets the synthesized or explicit entry-point function for this program,
    /// or null when the compilation produces a library. The body of the entry
    /// point is available via <see cref="Functions"/> using this key.
    /// </summary>
    public FunctionSymbol EntryPoint { get; }

    /// <summary>
    /// Gets the statements.
    /// </summary>
    public BoundBlockStatement Statement { get; }
}
