// <copyright file="BoundProgram.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

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
        : this(entryPointPackage, packages, diagnostics, functions, entryPoint, statement, structs, interfaces, ImmutableArray<EnumSymbol>.Empty)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundProgram"/> class with declared enums (#193).
    /// </summary>
    /// <param name="entryPointPackage">The entry-point package; its name is exposed via <see cref="PackageName"/> for back-compat.</param>
    /// <param name="packages">All distinct packages in this program, in declaration order.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions. Each <see cref="FunctionSymbol"/> key carries its owning package via <see cref="FunctionSymbol.Package"/>.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    /// <param name="structs">User-defined struct types declared in this program, grouped by declaring package.</param>
    /// <param name="interfaces">User-defined interface types declared in this program (Phase 3.B.4).</param>
    /// <param name="enums">User-defined enum types declared in this program (#193).</param>
    public BoundProgram(
        PackageSymbol entryPointPackage,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement,
        ImmutableArray<StructSymbol> structs,
        ImmutableArray<InterfaceSymbol> interfaces,
        ImmutableArray<EnumSymbol> enums)
        : this(entryPointPackage, packages, diagnostics, functions, entryPoint, statement, structs, interfaces, enums, ImmutableArray<GlobalVariableSymbol>.Empty)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundProgram"/> class with declared globals (#191).
    /// </summary>
    /// <param name="entryPointPackage">The entry-point package; its name is exposed via <see cref="PackageName"/> for back-compat.</param>
    /// <param name="packages">All distinct packages in this program, in declaration order.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions. Each <see cref="FunctionSymbol"/> key carries its owning package via <see cref="FunctionSymbol.Package"/>.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    /// <param name="structs">User-defined struct types declared in this program, grouped by declaring package.</param>
    /// <param name="interfaces">User-defined interface types declared in this program (Phase 3.B.4).</param>
    /// <param name="enums">User-defined enum types declared in this program (#193).</param>
    /// <param name="globals">User-declared top-level <c>var</c>/<c>let</c>/<c>const</c> declarations (#191).</param>
    public BoundProgram(
        PackageSymbol entryPointPackage,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement,
        ImmutableArray<StructSymbol> structs,
        ImmutableArray<InterfaceSymbol> interfaces,
        ImmutableArray<EnumSymbol> enums,
        ImmutableArray<GlobalVariableSymbol> globals)
        : this(entryPointPackage, packages, diagnostics, functions, entryPoint, statement, structs, interfaces, enums, globals, ImmutableArray<DelegateTypeSymbol>.Empty)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundProgram"/> class with declared named delegate types (ADR-0059 / issue #255).
    /// </summary>
    /// <param name="entryPointPackage">The entry-point package; its name is exposed via <see cref="PackageName"/> for back-compat.</param>
    /// <param name="packages">All distinct packages in this program, in declaration order.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    /// <param name="functions">The functions. Each <see cref="FunctionSymbol"/> key carries its owning package via <see cref="FunctionSymbol.Package"/>.</param>
    /// <param name="entryPoint">The entry-point function, or null if the compilation is a library.</param>
    /// <param name="statement">The statements.</param>
    /// <param name="structs">User-defined struct types declared in this program, grouped by declaring package.</param>
    /// <param name="interfaces">User-defined interface types declared in this program (Phase 3.B.4).</param>
    /// <param name="enums">User-defined enum types declared in this program (#193).</param>
    /// <param name="globals">User-declared top-level <c>var</c>/<c>let</c>/<c>const</c> declarations (#191).</param>
    /// <param name="delegates">User-declared named delegate types in this program (ADR-0059).</param>
    public BoundProgram(
        PackageSymbol entryPointPackage,
        ImmutableArray<PackageSymbol> packages,
        ImmutableArray<Diagnostic> diagnostics,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement> functions,
        FunctionSymbol entryPoint,
        BoundBlockStatement statement,
        ImmutableArray<StructSymbol> structs,
        ImmutableArray<InterfaceSymbol> interfaces,
        ImmutableArray<EnumSymbol> enums,
        ImmutableArray<GlobalVariableSymbol> globals,
        ImmutableArray<DelegateTypeSymbol> delegates)
    {
        EntryPointPackage = entryPointPackage;
        Packages = packages;
        Diagnostics = diagnostics;
        Functions = functions;
        EntryPoint = entryPoint;
        Statement = statement;
        Structs = structs;
        Interfaces = interfaces;
        Enums = enums;
        Globals = globals;
        Delegates = delegates.IsDefault ? ImmutableArray<DelegateTypeSymbol>.Empty : delegates;
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

    /// <summary>
    /// Gets the user-defined enum types declared in this program (#193).
    /// Each enum carries its declaring package via <see cref="EnumSymbol.PackageName"/>.
    /// </summary>
    public ImmutableArray<EnumSymbol> Enums { get; }

    /// <summary>
    /// Gets the user-declared top-level <c>var</c>/<c>let</c>/<c>const</c>
    /// declarations (#191). Each is emitted as a static <c>FieldDef</c> on the
    /// entry-point package's <c>&lt;Program&gt;</c> TypeDef so attribute
    /// metadata (#187) can attach to a real field row and so the global is
    /// observable from other assemblies.
    /// </summary>
    public ImmutableArray<GlobalVariableSymbol> Globals { get; }

    /// <summary>
    /// Gets the user-declared named delegate types in this program (ADR-0059 / issue #255).
    /// Each delegate is emitted as a sealed CLR <c>TypeDef</c> deriving from
    /// <c>System.MulticastDelegate</c> with a runtime-implemented
    /// <c>.ctor</c> and <c>Invoke</c>.
    /// </summary>
    public ImmutableArray<DelegateTypeSymbol> Delegates { get; }

    /// <summary>
    /// Gets the explicit (user-written) import symbols declared across all
    /// syntax trees. Implicit compiler-synthesized imports (e.g. the implicit
    /// <c>import System</c>) are excluded. Populated by
    /// <see cref="Binding.Binder.BindProgram(BoundGlobalScope, Symbols.ReferenceResolver)"/> from the bound global scope;
    /// the PDB emitter uses this to produce per-file <c>ImportScope</c> chains.
    /// </summary>
    public ImmutableArray<ImportSymbol> Imports { get; internal set; } = ImmutableArray<ImportSymbol>.Empty;

    /// <summary>
    /// Gets the distinct friend-assembly names declared via
    /// <c>@assembly:InternalsVisibleTo("...")</c> (issue #1929/#1953).
    /// Populated from <see cref="BoundGlobalScope.FriendAssemblies"/>; the
    /// emitter writes one real
    /// <see cref="System.Runtime.CompilerServices.InternalsVisibleToAttribute"/>
    /// row per entry.
    /// </summary>
    public ImmutableArray<string> FriendAssemblies { get; internal set; } = ImmutableArray<string>.Empty;
}
