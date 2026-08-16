// <copyright file="SequenceTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a sequence type <c>sequence[T]</c> — alias for <c>IEnumerable&lt;T&gt;</c> (ADR-0040).
/// </summary>
public sealed class SequenceTypeSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<TypeSymbol, SequenceTypeSymbol> Cache = new();

    private SequenceTypeSymbol(TypeSymbol elementType)

        // TypeSymbol's legacy CLR-type constructor accepts null for symbolic
        // same-compilation element types.
        : base($"sequence[{elementType.Name}]", MakeClrType(elementType))
    {
        ElementType = elementType;
    }

    /// <summary>Gets the element type.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>
    /// Gets or creates the sequence type symbol for the given element type.
    /// </summary>
    /// <param name="elementType">The element type.</param>
    /// <returns>The cached <see cref="SequenceTypeSymbol"/>.</returns>
    public static SequenceTypeSymbol Get(TypeSymbol elementType)
    {
        if (elementType == null)
        {
            throw new ArgumentNullException(nameof(elementType));
        }

        return Cache.GetOrAdd(elementType, et => new SequenceTypeSymbol(et));
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    /// <summary>
    /// Issue #3093: projects the G# sequence aliases and their CLR interface
    /// spellings onto one common generic-interface shape.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <param name="openDefinition">
    /// The matching <c>IEnumerable&lt;&gt;</c> or
    /// <c>IAsyncEnumerable&lt;&gt;</c> definition.
    /// </param>
    /// <param name="elementType">The symbolic element type.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> has a sequence-interface shape.</returns>
    internal static bool TryGetEnumerableInterfaceShape(
        TypeSymbol type,
        out Type? openDefinition,
        out TypeSymbol elementType)
    {
        switch (type)
        {
            case SequenceTypeSymbol sequence:
                openDefinition = typeof(IEnumerable<>);
                elementType = sequence.ElementType;
                return true;
            case AsyncSequenceTypeSymbol sequence:
                openDefinition = typeof(IAsyncEnumerable<>);
                elementType = sequence.ElementType;
                return true;
            case ImportedTypeSymbol imported
                when imported.OpenDefinition != null
                    && imported.TypeArguments.Length == 1
                    && IsEnumerableInterfaceDefinition(imported.OpenDefinition):
                openDefinition = imported.OpenDefinition;
                elementType = imported.TypeArguments[0];
                return true;
        }

        var clrType = type?.ClrType;
        if (clrType != null && clrType.IsGenericType && !clrType.IsGenericTypeDefinition)
        {
            var definition = clrType.GetGenericTypeDefinition();
            if (IsEnumerableInterfaceDefinition(definition))
            {
                openDefinition = definition;
                elementType = TypeSymbol.FromClrType(clrType.GetGenericArguments()[0]);
                return true;
            }
        }

        openDefinition = null;

        // The value is ignored when the shape probe returns false.
        elementType = TypeSymbol.Error;
        return false;
    }

    private static Type? MakeClrType(TypeSymbol elementType)
    {
        var elementClrType = NullableTypeSymbol.GetEffectiveClrType(elementType);
        if (elementClrType == null)
        {
            return null;
        }

        return typeof(IEnumerable<>).MakeGenericType(elementClrType);
    }

    private static bool IsEnumerableInterfaceDefinition(Type? type)
        => type?.FullName == "System.Collections.Generic.IEnumerable`1"
            || type?.FullName == "System.Collections.Generic.IAsyncEnumerable`1";
}
