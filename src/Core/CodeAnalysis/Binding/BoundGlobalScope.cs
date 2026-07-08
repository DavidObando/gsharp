// <copyright file="BoundGlobalScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
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
        : this(previous, package, packages, diagnostics, imports, functions, variables, typeAliases, structs, interfaces, ImmutableArray<EnumSymbol>.Empty, entryPoint, statements)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundGlobalScope"/> class with declared enums (#193).
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
    /// <param name="enums">User-defined enum types declared in the current compilation (#193).</param>
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
        ImmutableArray<EnumSymbol> enums,
        FunctionSymbol entryPoint,
        ImmutableArray<BoundStatement> statements)
        : this(previous, package, packages, diagnostics, imports, functions, variables, typeAliases, structs, interfaces, enums, ImmutableArray<DelegateTypeSymbol>.Empty, entryPoint, statements)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundGlobalScope"/> class with declared named delegate types (ADR-0059 / issue #255).
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
    /// <param name="enums">User-defined enum types declared in the current compilation (#193).</param>
    /// <param name="delegates">User-declared named delegate types in the current compilation (ADR-0059).</param>
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
        ImmutableArray<EnumSymbol> enums,
        ImmutableArray<DelegateTypeSymbol> delegates,
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
        Enums = enums;
        Delegates = delegates.IsDefault ? ImmutableArray<DelegateTypeSymbol>.Empty : delegates;
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
    /// Gets the imports declared directly by <em>this</em> compilation's own
    /// syntax trees — NOT the transitively-visible import set (issue #2101).
    /// Mirrors <see cref="Functions"/>/<see cref="Variables"/>, which have
    /// always been per-level deltas rather than a cumulative snapshot. Callers
    /// that need every import visible across a chained REPL session (e.g.
    /// emit, which must see imports from every prior submission) should use
    /// <see cref="GetCumulativeImports"/> instead of reading this property
    /// directly on a single link of the <see cref="Previous"/> chain.
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
    /// Gets the user-defined enum types declared in the current compilation (#193).
    /// </summary>
    public ImmutableArray<EnumSymbol> Enums { get; }

    /// <summary>
    /// Gets the user-declared named delegate types in the current compilation (ADR-0059 / issue #255).
    /// </summary>
    public ImmutableArray<DelegateTypeSymbol> Delegates { get; }

    /// <summary>
    /// Gets the synthesized or explicit entry-point function for this compilation,
    /// or null if the compilation produces a library (no entry point).
    /// </summary>
    public FunctionSymbol EntryPoint { get; }

    /// <summary>
    /// Gets the statements in the current compilation.
    /// </summary>
    public ImmutableArray<BoundStatement> Statements { get; }

    /// <summary>
    /// Gets the active preprocessor symbol set used by
    /// <c>[Conditional("SYMBOL")]</c> call-site elision (ADR-0047 §6 /
    /// issue #176). Threaded onto the bound global scope so that
    /// <see cref="Binder.BindProgram(BoundGlobalScope, Symbols.ReferenceResolver)"/> — which builds its own scope chain
    /// from this snapshot — can rehydrate the same symbol set when binding
    /// function bodies. Defaults to <see cref="ImmutableHashSet{T}.Empty"/>.
    /// </summary>
    public ImmutableHashSet<string> PreprocessorSymbols { get; internal set; } = ImmutableHashSet<string>.Empty;

    /// <summary>
    /// Gets the distinct set of friend-assembly names this compilation
    /// declares via <c>@assembly:InternalsVisibleTo("...")</c> annotations
    /// (issue #1929/#1953). The emitter writes a real
    /// <see cref="System.Runtime.CompilerServices.InternalsVisibleToAttribute"/>
    /// custom attribute row for each entry so the producer genuinely opts
    /// in to cross-assembly internal access — there is no consumer-side
    /// name-based heuristic.
    /// </summary>
    public ImmutableArray<string> FriendAssemblies { get; internal set; } = ImmutableArray<string>.Empty;

    /// <summary>
    /// Gets every file-level <c>@assembly:</c> annotation (issue #2237)
    /// EXCEPT <c>InternalsVisibleTo</c> (see <see cref="FriendAssemblies"/>),
    /// bound through the general attribute binder so any C#-parity assembly
    /// attribute (<c>AssemblyVersionAttribute</c>,
    /// <c>AssemblyMetadataAttribute</c>, a same-compilation user attribute,
    /// ...) becomes a real assembly-level <c>CustomAttribute</c> row.
    /// </summary>
    public ImmutableArray<BoundAttribute> AssemblyAttributes { get; internal set; } = ImmutableArray<BoundAttribute>.Empty;

    /// <summary>
    /// Gets or sets every anonymous-class type (issue #2224) synthesized
    /// while binding this compilation's top-level statements and (once
    /// <c>Binder.BindProgram</c> runs) its function/method bodies.
    /// <c>Binder.BindProgram</c> unions this set into the emitted
    /// <c>BoundProgram.Structs</c> so every synthesized shape gets a real
    /// TypeDef, regardless of which phase's bind pass first encountered its
    /// shape.
    /// </summary>
    internal ImmutableArray<StructSymbol> AnonymousTypes { get; set; } = ImmutableArray<StructSymbol>.Empty;

    /// <summary>
    /// Gets or sets the map from each "rich" anonymous-object literal (one
    /// carrying a base/interface clause, method, or event — ADR-0146 / issue
    /// #2243) to its compiler-synthesized backing class. Populated while
    /// binding the global scope and consumed by <c>Binder.BindProgram</c>
    /// (which rehydrates it onto the fresh body-binding scope) so a literal
    /// appearing inside a function or method body binds to the right
    /// synthesized class.
    /// </summary>
    internal Dictionary<GSharp.Core.CodeAnalysis.Syntax.AnonymousClassExpressionSyntax, StructSymbol> RichAnonymousClassMap { get; set; }
        = new Dictionary<GSharp.Core.CodeAnalysis.Syntax.AnonymousClassExpressionSyntax, StructSymbol>();

    /// <summary>
    /// Returns every import visible across the whole <see cref="Previous"/>
    /// chain, oldest submission first (issue #2101). This is the cumulative
    /// view that <see cref="Imports"/> itself used to provide directly —
    /// moved here (an explicit, one-time O(chain length) walk) so that
    /// per-level binding (<see cref="Binder.BindGlobalScope(BoundGlobalScope, ImmutableArray{Syntax.SyntaxTree}, Symbols.ReferenceResolver, bool, ImmutableHashSet{string}, bool)"/>)
    /// no longer has to re-flatten (and get re-flattened by) the entire
    /// history on every single chained submission.
    /// </summary>
    /// <returns>The cumulative imports, oldest-declared first.</returns>
    public ImmutableArray<ImportSymbol> GetCumulativeImports()
    {
        var chain = new Stack<BoundGlobalScope>();
        for (var scope = this; scope != null; scope = scope.Previous)
        {
            chain.Push(scope);
        }

        var builder = ImmutableArray.CreateBuilder<ImportSymbol>();
        while (chain.Count > 0)
        {
            builder.AddRange(chain.Pop().Imports);
        }

        return builder.ToImmutable();
    }
}
