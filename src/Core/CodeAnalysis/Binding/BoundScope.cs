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
    private List<FunctionSymbol> extensionFunctions;

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    public BoundScope(BoundScope parent)
        : this(parent, references: null, preprocessorSymbols: null)
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
        : this(parent, references, preprocessorSymbols: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class with
    /// an explicit reference resolver and an active preprocessor-symbol set
    /// (ADR-0047 §6 / issue #176). Child scopes inherit both from the parent
    /// when not supplied.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="references">The reference resolver; defaults to the parent's resolver, or <see cref="ReferenceResolver.Default"/> if none.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; defaults to the parent's set, or an empty set if none.</param>
    public BoundScope(BoundScope parent, ReferenceResolver references, ImmutableHashSet<string> preprocessorSymbols)
    {
        Parent = parent;
        imports = parent?.imports ?? new List<ImportSymbol>();
        typeAliases = parent?.typeAliases ?? new Dictionary<string, TypeSymbol>();
        References = references ?? parent?.References ?? ReferenceResolver.Default();
        PreprocessorSymbols = preprocessorSymbols ?? parent?.PreprocessorSymbols ?? ImmutableHashSet<string>.Empty;
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
    /// Gets the active preprocessor symbol set (ADR-0047 §6 / issue #176).
    /// Empty by default. <c>[Conditional("SYMBOL")]</c> call-site elision
    /// keys off this set: a call is elided when *none* of the symbols named
    /// by the function's <c>[Conditional]</c> applications is in this set.
    /// </summary>
    public ImmutableHashSet<string> PreprocessorSymbols { get; }

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
    /// Tries to declare an extension function (Phase 3.B.6 / ADR-0019). Extension
    /// functions live outside the normal symbol table because their identity is
    /// the pair (receiverType, name): two extensions with the same name but
    /// different receivers are legal.
    /// </summary>
    /// <param name="function">The extension function symbol. Must have <see cref="FunctionSymbol.IsExtension"/> set.</param>
    /// <returns>True if the extension was registered; false if an identical (receiver, name) pair already exists in this scope.</returns>
    public bool TryDeclareExtensionFunction(FunctionSymbol function)
    {
        if (extensionFunctions == null)
        {
            extensionFunctions = new List<FunctionSymbol>();
        }

        foreach (var existing in extensionFunctions)
        {
            if (existing.Name == function.Name && existing.ExtensionReceiverType == function.ExtensionReceiverType)
            {
                return false;
            }
        }

        extensionFunctions.Add(function);
        return true;
    }

    /// <summary>
    /// Tries to look up an extension function by receiver type and name (walks parent scopes).
    /// </summary>
    /// <param name="receiverType">The static type of the call receiver.</param>
    /// <param name="name">The method name at the call site.</param>
    /// <param name="function">The matching extension function, when found.</param>
    /// <returns>True when an extension function matches.</returns>
    public bool TryLookupExtensionFunction(TypeSymbol receiverType, string name, out FunctionSymbol function)
    {
        function = null;
        if (extensionFunctions != null)
        {
            foreach (var ext in extensionFunctions)
            {
                if (ext.Name == name && ext.ExtensionReceiverType == receiverType)
                {
                    function = ext;
                    return true;
                }
            }
        }

        return Parent?.TryLookupExtensionFunction(receiverType, name, out function) ?? false;
    }

    /// <summary>Gets the extension functions declared in this scope (Phase 3.B.6).</summary>
    /// <returns>An immutable array of extension functions.</returns>
    public ImmutableArray<FunctionSymbol> GetDeclaredExtensionFunctions()
        => extensionFunctions?.ToImmutableArray() ?? ImmutableArray<FunctionSymbol>.Empty;

    /// <summary>
    /// Tries to look up a symbol by its name in this scope.
    /// </summary>
    /// <param name="name">The symbol name.</param>
    /// <returns>The symbol.</returns>
    public Symbol TryLookupSymbol(string name)
    {
        if (name != null && symbols != null && symbols.TryGetValue(name, out var symbol))
        {
            return symbol;
        }

        return Parent?.TryLookupSymbol(name);
    }

    /// <summary>
    /// Tries to lookup an imported generic open type by simple name and arity (Phase 4.4 / ADR-0020).
    /// CLR generic types are stored under the mangled name <c>Name`N</c>; this overload
    /// searches each active import for <c>Target.Name`arity</c>.
    /// </summary>
    /// <param name="name">The simple type name as written in source (without the backtick suffix).</param>
    /// <param name="arity">The number of type parameters.</param>
    /// <param name="type">The resolved open generic <see cref="System.Type"/> on success.</param>
    /// <returns>Whether a matching open generic type was found.</returns>
    public bool TryLookupImportedGenericClass(string name, int arity, out System.Type type)
    {
        type = null;
        if (imports == null || arity <= 0)
        {
            return false;
        }

        var mangled = name + "`" + arity;
        foreach (var import in imports)
        {
            var typeName = import.Target + "." + mangled;
            if (References.TryResolveType(typeName, out var t))
            {
                type = t;
                return true;
            }
        }

        return false;
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
        if (name == null)
        {
            return false;
        }

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
        if (name != null && typeAliases != null && typeAliases.TryGetValue(name, out type))
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

    /// <summary>
    /// Gets the set of declared user-defined interface types in this scope chain (Phase 3.B.4).
    /// </summary>
    /// <returns>The interfaces in declaration order.</returns>
    public ImmutableArray<InterfaceSymbol> GetDeclaredInterfaces()
        => typeAliases == null
            ? ImmutableArray<InterfaceSymbol>.Empty
            : typeAliases.Values.OfType<InterfaceSymbol>().ToImmutableArray();

    /// <summary>
    /// Gets the set of declared user-defined enum types in this scope chain (#193).
    /// </summary>
    /// <returns>The enums in declaration order.</returns>
    public ImmutableArray<EnumSymbol> GetDeclaredEnums()
        => typeAliases == null
            ? ImmutableArray<EnumSymbol>.Empty
            : typeAliases.Values.OfType<EnumSymbol>().ToImmutableArray();

    private bool TryDeclareSymbol<TSymbol>(TSymbol symbol)
        where TSymbol : Symbol
    {
        if (symbol.Name == null)
        {
            return false;
        }

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
