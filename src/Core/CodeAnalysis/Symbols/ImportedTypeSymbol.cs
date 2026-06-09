// <copyright file="ImportedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Documentation;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an imported .NET type as a <see cref="TypeSymbol"/>.
/// Instances are cached per CLR <see cref="Type"/> so that reference equality
/// and identity conversions work as expected.
/// </summary>
public sealed class ImportedTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<Type, ImportedTypeSymbol> Cache = new();

    private ImportedTypeSymbol(Type type)
        : base(type.FullName ?? type.Name, type)
    {
        TypeArguments = ImmutableArray<TypeSymbol>.Empty;
    }

    private ImportedTypeSymbol(string name, Type erasedClosedType, Type openDefinition, ImmutableArray<TypeSymbol> typeArguments)
        : base(name, erasedClosedType)
    {
        OpenDefinition = openDefinition;
        TypeArguments = typeArguments;
    }

    /// <summary>
    /// Gets the underlying CLR type. For a type constructed over an in-scope
    /// generic type parameter (#313) this is the type-erased closed form
    /// (e.g. <c>List&lt;object&gt;</c> for <c>List[T]</c>) so member, index, and
    /// conversion resolution keep working.
    /// </summary>
    public Type Type => ClrType;

    /// <summary>
    /// Gets the open generic CLR definition this symbol was constructed from
    /// (e.g. <c>List&lt;&gt;</c>), or <c>null</c> when this is a plain imported
    /// type rather than a #313 type-parameter construction.
    /// </summary>
    public Type OpenDefinition { get; }

    /// <summary>
    /// Gets the symbolic type arguments this generic type was constructed with
    /// (#313). May contain <see cref="TypeParameterSymbol"/> entries for an
    /// in-scope type parameter (e.g. <c>[T]</c> in <c>List[T]</c>). Empty for a
    /// plain imported type whose arguments are fully described by its
    /// <see cref="TypeSymbol.ClrType"/>.
    /// </summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; }

    /// <summary>
    /// Gets a value indicating whether this symbol carries symbolic type
    /// arguments that include an in-scope generic type parameter (#313), in
    /// which case it is an open/partially-constructed generic whose emit form
    /// is type-erased to <c>System.Object</c>.
    /// </summary>
    public bool HasTypeParameterArgument =>
        !TypeArguments.IsDefaultOrEmpty && TypeArguments.Any(TypeSymbol.ContainsTypeParameter);

    /// <summary>
    /// Gets or creates the imported type symbol for the given CLR type.
    /// </summary>
    /// <param name="type">The CLR type.</param>
    /// <returns>The cached <see cref="ImportedTypeSymbol"/>.</returns>
    public static ImportedTypeSymbol Get(Type type)
    {
        if (type == null)
        {
            throw new ArgumentNullException(nameof(type));
        }

        return Cache.GetOrAdd(type, t => new ImportedTypeSymbol(t));
    }

    /// <summary>
    /// #313: creates a generic type constructed over one or more in-scope type
    /// parameters (e.g. <c>List[T]</c>). The instance is intentionally not
    /// cached because each construction carries distinct symbolic type
    /// arguments while sharing the same type-erased closed CLR shape.
    /// </summary>
    /// <param name="erasedClosedType">The type-erased closed CLR type (type parameters projected onto <c>object</c>).</param>
    /// <param name="openDefinition">The open generic CLR definition (e.g. <c>List&lt;&gt;</c>).</param>
    /// <param name="typeArguments">The symbolic type arguments, possibly containing <see cref="TypeParameterSymbol"/>.</param>
    /// <returns>A fresh constructed <see cref="ImportedTypeSymbol"/>.</returns>
    public static ImportedTypeSymbol GetConstructed(Type erasedClosedType, Type openDefinition, ImmutableArray<TypeSymbol> typeArguments)
    {
        if (erasedClosedType == null)
        {
            throw new ArgumentNullException(nameof(erasedClosedType));
        }

        var argNames = string.Join(", ", typeArguments.Select(a => a?.Name ?? "?"));
        var baseName = openDefinition?.FullName ?? openDefinition?.Name ?? erasedClosedType.FullName ?? erasedClosedType.Name;
        var name = $"{baseName}[{argNames}]";
        return new ImportedTypeSymbol(name, erasedClosedType, openDefinition, typeArguments);
    }

    /// <inheritdoc/>
    public override DocumentationComment GetDocumentation()
    {
        return AssemblyDocumentationProvider.Resolve(OpenDefinition ?? Type) ?? base.GetDocumentation();
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();
}
