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
    /// <param name="entryPointPackage">The entry-point package; its name is exposed via <see cref="PackageName"/> for back-compat.</param>
    /// <param name="packages">All distinct packages in this program, in declaration order.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions. Each <see cref="FunctionSymbol"/> key carries its owning package via <see cref="FunctionSymbol.Package"/>.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    public BoundProgram(
        PackageSymbol entryPointPackage,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement)
        : this(entryPointPackage, packages, diagnostics, functions, entryPoint, statement, ImmutableArray<StructSymbol>.Empty)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundProgram"/> class.
    /// </summary>
    /// <param name="entryPointPackage">The entry-point package; its name is exposed via <see cref="PackageName"/> for back-compat.</param>
    /// <param name="packages">All distinct packages in this program, in declaration order.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions. Each <see cref="FunctionSymbol"/> key carries its owning package via <see cref="FunctionSymbol.Package"/>.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    /// <param name="structs">User-defined struct types declared in this program, grouped by declaring package.</param>
    /// <param name="interfaces">User-defined interface types declared in this program (Phase 3.B.4).</param>
    public BoundProgram(
        PackageSymbol entryPointPackage,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement,
        ImmutableArray<StructSymbol> structs,
        ImmutableArray<InterfaceSymbol> interfaces)
    {
        EntryPointPackage = entryPointPackage;
        Packages = packages;
        Diagnostics = diagnostics;
        Functions = functions;
        EntryPoint = entryPoint;
        Statement = statement;
        Structs = structs;
        Interfaces = interfaces;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundProgram"/> class.
    /// </summary>
    /// <param name="entryPointPackage">The entry-point package; its name is exposed via <see cref="PackageName"/> for back-compat.</param>
    /// <param name="packages">All distinct packages in this program, in declaration order.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions. Each <see cref="FunctionSymbol"/> key carries its owning package via <see cref="FunctionSymbol.Package"/>.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    /// <param name="structs">User-defined struct types declared in this program, grouped by declaring package.</param>
    public BoundProgram(
        PackageSymbol entryPointPackage,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement,
        ImmutableArray<StructSymbol> structs)
        : this(entryPointPackage, packages, diagnostics, functions, entryPoint, statement, structs, ImmutableArray<InterfaceSymbol>.Empty)
    {
    }

    /// <summary>
    /// Gets the entry-point package for this bound program. Its name is the
    /// namespace whose <c>&lt;Program&gt;</c> carries the assembly's entry
    /// point (when any).
    /// </summary>
    public PackageSymbol EntryPointPackage { get; }

    /// <summary>
    /// Gets all distinct packages in this bound program, in declaration order.
    /// Each user-defined function (via <see cref="FunctionSymbol.Package"/>) is
    /// tagged with one of these packages; the emitter produces one
    /// <c>&lt;Program&gt;</c> type per package, each in its declaring CLR
    /// namespace.
    /// </summary>
    public ImmutableArray<PackageSymbol> Packages { get; }

    /// <summary>
    /// Gets the entry-point package name. Back-compat shim equivalent to
    /// <c>EntryPointPackage.Name</c>.
    /// </summary>
    public string PackageName => EntryPointPackage?.Name;

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

    /// <summary>
    /// Gets the user-defined struct types declared in this program.
    /// Each struct carries its declaring package via <see cref="StructSymbol.PackageName"/>.
    /// </summary>
    public ImmutableArray<StructSymbol> Structs { get; }

    /// <summary>
    /// Gets the user-defined interface types declared in this program (Phase 3.B.4).
    /// </summary>
    public ImmutableArray<InterfaceSymbol> Interfaces { get; }
}
