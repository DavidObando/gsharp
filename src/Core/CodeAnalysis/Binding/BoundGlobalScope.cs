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
    /// <param name="package">The entry-point package for the current compilation.</param>
    /// <param name="packages">All distinct packages declared in the current compilation, in declaration order.</param>
    /// <param name="diagnostics">Diagnostics for the current compilation.</param>
    /// <param name="imports">Imports in the current compilation.</param>
    /// <param name="functions">Functions in the current compilation.</param>
    /// <param name="variables">Variables in the current compilation.</param>
    /// <param name="entryPoint">The entry-point function for this compilation, or null if the compilation is a library.</param>
    /// <param name="statements">Statements in the current compilation.</param>
    public BoundGlobalScope(
        BoundGlobalScope previous,
        PackageSymbol package,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableArray<ImportSymbol> imports,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<VariableSymbol> variables,
        FunctionSymbol entryPoint,
        ImmutableArray<BoundStatement> statements)
        : this(previous, package, packages, diagnostics, imports, functions, variables, ImmutableDictionary<string, TypeSymbol>.Empty, ImmutableArray<StructSymbol>.Empty, entryPoint, statements)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundGlobalScope"/> class
    /// with declared type aliases.
    /// </summary>
    /// <param name="previous">Previous compilation global scope.</param>
    /// <param name="package">The entry-point package for the current compilation.</param>
    /// <param name="packages">All distinct packages declared in the current compilation, in declaration order.</param>
    /// <param name="diagnostics">Diagnostics for the current compilation.</param>
    /// <param name="imports">Imports in the current compilation.</param>
    /// <param name="functions">Functions in the current compilation.</param>
    /// <param name="variables">Variables in the current compilation.</param>
    /// <param name="typeAliases">Type aliases declared in the current compilation.</param>
    /// <param name="structs">User-defined struct types declared in the current compilation.</param>
    /// <param name="interfaces">User-defined interface types declared in the current compilation (Phase 3.B.4).</param>
    /// <param name="entryPoint">The entry-point function for this compilation, or null if the compilation is a library.</param>
    /// <param name="statements">Statements in the current compilation.</param>
    public BoundGlobalScope(
        BoundGlobalScope previous,
        PackageSymbol package,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableArray<ImportSymbol> imports,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<VariableSymbol> variables,
        ImmutableDictionary<string, TypeSymbol> typeAliases,
        ImmutableArray<StructSymbol> structs,
        ImmutableArray<InterfaceSymbol> interfaces,
        FunctionSymbol entryPoint,
        ImmutableArray<BoundStatement> statements)
    {
        Previous = previous;
        Package = package;
        Packages = packages;
        Diagnostics = diagnostics;
        Imports = imports;
        Functions = functions;
        Variables = variables;
        TypeAliases = typeAliases;
        Structs = structs;
        Interfaces = interfaces;
        EntryPoint = entryPoint;
        Statements = statements;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundGlobalScope"/> class
    /// with declared type aliases.
    /// </summary>
    /// <param name="previous">Previous compilation global scope.</param>
    /// <param name="package">The entry-point package for the current compilation.</param>
    /// <param name="packages">All distinct packages declared in the current compilation, in declaration order.</param>
    /// <param name="diagnostics">Diagnostics for the current compilation.</param>
    /// <param name="imports">Imports in the current compilation.</param>
    /// <param name="functions">Functions in the current compilation.</param>
    /// <param name="variables">Variables in the current compilation.</param>
    /// <param name="typeAliases">Type aliases declared in the current compilation.</param>
    /// <param name="structs">User-defined struct types declared in the current compilation.</param>
    /// <param name="entryPoint">The entry-point function for this compilation, or null if the compilation is a library.</param>
    /// <param name="statements">Statements in the current compilation.</param>
    public BoundGlobalScope(
        BoundGlobalScope previous,
        PackageSymbol package,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableArray<ImportSymbol> imports,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<VariableSymbol> variables,
        ImmutableDictionary<string, TypeSymbol> typeAliases,
        ImmutableArray<StructSymbol> structs,
        FunctionSymbol entryPoint,
        ImmutableArray<BoundStatement> statements)
        : this(previous, package, packages, diagnostics, imports, functions, variables, typeAliases, structs, ImmutableArray<InterfaceSymbol>.Empty, entryPoint, statements)
    {
    }

    /// <summary>
    /// Gets the previous compilation global scope.
    /// </summary>
    public BoundGlobalScope Previous { get; }

    /// <summary>
    /// Gets the entry-point package symbol for the current compilation. This
    /// is the package owning the synthesized top-level statements or the
    /// explicit <c>Main</c> function, and it is the package whose
    /// <c>&lt;Program&gt;</c> type holds the assembly's entry point.
    /// </summary>
    public PackageSymbol Package { get; }

    /// <summary>
    /// Gets all distinct packages declared across the current compilation's
    /// syntax trees, in first-seen declaration order. Each user-defined
    /// function is tagged with its declaring package via
    /// <see cref="FunctionSymbol.Package"/>.
    /// </summary>
    public ImmutableArray<PackageSymbol> Packages { get; }

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
    /// Gets the type aliases declared in the current compilation.
    /// </summary>
    public ImmutableDictionary<string, TypeSymbol> TypeAliases { get; }

    /// <summary>
    /// Gets the user-defined struct types declared in the current compilation.
    /// </summary>
    public ImmutableArray<StructSymbol> Structs { get; }

    /// <summary>
    /// Gets the user-defined interface types declared in the current compilation (Phase 3.B.4).
    /// </summary>
    public ImmutableArray<InterfaceSymbol> Interfaces { get; }

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
