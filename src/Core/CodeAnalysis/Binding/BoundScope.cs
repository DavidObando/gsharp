// <copyright file="BoundScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound scope.
/// </summary>
public sealed class BoundScope
{
    private Dictionary<string, Symbol> symbols;
    private List<ImportSymbol> imports;
    private Dictionary<string, TypeSymbol> typeAliases;

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    public BoundScope(BoundScope parent)
        : this(parent, references: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class with
    /// an explicit reference resolver. Child scopes inherit the parent's
    /// resolver when one is not supplied.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="references">The reference resolver; defaults to the parent's resolver, or <see cref="ReferenceResolver.Default"/> if none.</param>
    public BoundScope(BoundScope parent, ReferenceResolver references)
    {
        Parent = parent;
        imports = parent?.imports ?? new List<ImportSymbol>();
        typeAliases = parent?.typeAliases ?? new Dictionary<string, TypeSymbol>();
        References = references ?? parent?.References ?? ReferenceResolver.Default();
    }

    /// <summary>
    /// Gets the parent scope.
    /// </summary>
    public BoundScope Parent { get; }

    /// <summary>
    /// Gets the reference resolver used to look up imported CLR types.
    /// </summary>
    public ReferenceResolver References { get; }

    /// <summary>
    /// Tries to add an import to this scope.
    /// </summary>
    /// <param name="import">The import.</param>
    /// <returns>Whether the import was registered or not.</returns>
    public bool TryImport(ImportSymbol import)
    {
        if (imports == null)
        {
            imports = new List<ImportSymbol>();
        }

        imports.Add(import);
        return true;
    }

    /// <summary>
    /// Tries to declare a variable in this scope.
    /// </summary>
    /// <param name="variable">The variable to declare.</param>
    /// <returns>Wherther the variable was declared or not.</returns>
    public bool TryDeclareVariable(VariableSymbol variable)
        => TryDeclareSymbol(variable);

    /// <summary>
    /// Tries to declare a function in this scope.
    /// </summary>
    /// <param name="function">The function to declare.</param>
    /// <returns>Whether the function was declared or not.</returns>
    public bool TryDeclareFunction(FunctionSymbol function)
        => TryDeclareSymbol(function);

    /// <summary>
    /// Tries to look up a symbol by its name in this scope.
    /// </summary>
    /// <param name="name">The symbol name.</param>
    /// <returns>The symbol.</returns>
    public Symbol TryLookupSymbol(string name)
    {
        if (symbols != null && symbols.TryGetValue(name, out var symbol))
        {
            return symbol;
        }

        return Parent?.TryLookupSymbol(name);
    }

    /// <summary>
    /// Tries to lookup an imported class.
    /// </summary>
    /// <param name="name">The class name.</param>
    /// <param name="declaration">The declaration.</param>
    /// <param name="importedClass">The result, if found.</param>
    /// <returns>Whether a class was found or not.</returns>
    public bool TryLookupImportedClass(string name, ExpressionSyntax declaration, out ImportedClassSymbol importedClass)
    {
        importedClass = null;

        if (imports == null)
        {
            return false;
        }

        foreach (var import in imports)
        {
            var typeName = import.Target + "." + name;
            if (References.TryResolveType(typeName, out var type))
            {
                importedClass = new ImportedClassSymbol(type, declaration);
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Tries to look up an imported namespace by the name the user references it with
    /// (the alias if one was declared, otherwise the import path).
    /// </summary>
    /// <param name="name">The name as it appears in user code.</param>
    /// <param name="import">The matching import, when found.</param>
    /// <returns>Whether a matching import exists.</returns>
    public bool TryLookupImport(string name, out ImportSymbol import)
    {
        import = null;

        if (imports == null)
        {
            return false;
        }

        foreach (var candidate in imports)
        {
            if (string.Equals(candidate.Name, name, System.StringComparison.Ordinal))
            {
                import = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Gets an immutable array of all the declared variables.
    /// </summary>
    /// <returns>The declared variables.</returns>
    public ImmutableArray<VariableSymbol> GetDeclaredVariables()
        => GetDeclaredSymbols<VariableSymbol>();

    /// <summary>
    /// Gets an immutable array of all the declared functions.
    /// </summary>
    /// <returns>The declared functions.</returns>
    public ImmutableArray<FunctionSymbol> GetDeclaredFunctions()
        => GetDeclaredSymbols<FunctionSymbol>();

    /// <summary>
    /// Gets an immutable array of all the declared imports.
    /// </summary>
    /// <returns>The declared imports.</returns>
    public ImmutableArray<ImportSymbol> GetDeclaredImports()
        => imports.ToImmutableArray();

    /// <summary>
    /// Tries to declare a type alias.
    /// </summary>
    /// <param name="name">The alias name.</param>
    /// <param name="target">The underlying type.</param>
    /// <returns>Whether the alias was declared (false if the name was already taken).</returns>
    public bool TryDeclareTypeAlias(string name, TypeSymbol target)
    {
        if (typeAliases == null)
        {
            typeAliases = new Dictionary<string, TypeSymbol>();
        }

        if (typeAliases.ContainsKey(name))
        {
            return false;
        }

        typeAliases.Add(name, target);
        return true;
    }

    /// <summary>
    /// Tries to look up a type alias by name.
    /// </summary>
    /// <param name="name">The alias name.</param>
    /// <param name="type">The aliased type, when found.</param>
    /// <returns>Whether an alias exists.</returns>
    public bool TryLookupTypeAlias(string name, out TypeSymbol type)
    {
        if (typeAliases != null && typeAliases.TryGetValue(name, out type))
        {
            return true;
        }

        type = null;
        return false;
    }

    /// <summary>
    /// Gets the set of declared type aliases.
    /// </summary>
    /// <returns>The map of alias names to underlying types.</returns>
    public ImmutableDictionary<string, TypeSymbol> GetDeclaredTypeAliases()
        => typeAliases == null ? ImmutableDictionary<string, TypeSymbol>.Empty : typeAliases.ToImmutableDictionary();

    /// <summary>
    /// Gets the set of declared user-defined struct types in this scope chain.
    /// </summary>
    /// <returns>The structs in declaration order.</returns>
    public ImmutableArray<StructSymbol> GetDeclaredStructs()
        => typeAliases == null
            ? ImmutableArray<StructSymbol>.Empty
            : typeAliases.Values.OfType<StructSymbol>().ToImmutableArray();

    private bool TryDeclareSymbol<TSymbol>(TSymbol symbol)
        where TSymbol : Symbol
    {
        if (symbols == null)
        {
            symbols = new Dictionary<string, Symbol>();
        }
        else if (symbols.ContainsKey(symbol.Name))
        {
            return false;
        }

        symbols.Add(symbol.Name, symbol);
        return true;
    }

    private ImmutableArray<TSymbol> GetDeclaredSymbols<TSymbol>()
        where TSymbol : Symbol
    {
        if (symbols == null)
        {
            return ImmutableArray<TSymbol>.Empty;
        }

        return symbols.Values.OfType<TSymbol>().ToImmutableArray();
    }
}
