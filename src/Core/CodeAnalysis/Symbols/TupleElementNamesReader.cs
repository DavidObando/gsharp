// <copyright file="TupleElementNamesReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0172 Phase B: decodes
/// <c>System.Runtime.CompilerServices.TupleElementNamesAttribute</c> from an
/// imported parameter / return / field / property and applies the flattened
/// name array onto the already-mapped <see cref="TypeSymbol"/>, rebuilding
/// each tuple occurrence as a named <see cref="TupleTypeSymbol"/>. The walk
/// consumes names in the same DFS pre-order the C# compiler (and gsc's
/// emit-side <c>TupleElementNamesBuilder</c>) uses: every tuple contributes
/// its arity of entries before its element subtrees; non-tuple composites are
/// traversed transparently. Application is best-effort — a cursor/shape
/// mismatch (foreign compiler quirk) leaves the remaining tree unnamed rather
/// than failing the import.
/// </summary>
public static class TupleElementNamesReader
{
    private const string TupleElementNamesAttributeFullName = "System.Runtime.CompilerServices.TupleElementNamesAttribute";

    /// <summary>
    /// Applies any <c>[TupleElementNames]</c> metadata found on
    /// <paramref name="provider"/> to <paramref name="mapped"/>.
    /// Returns <paramref name="mapped"/> unchanged when the attribute is
    /// absent or carries no names.
    /// </summary>
    /// <param name="mapped">The already-mapped member type symbol.</param>
    /// <param name="provider">The imported parameter / field / property to read the attribute from.</param>
    /// <returns>The (possibly) name-enriched type symbol.</returns>
    public static TypeSymbol ApplyNames(TypeSymbol mapped, ICustomAttributeProvider provider)
    {
        var names = TryGetNames(provider);
        if (names.IsDefaultOrEmpty)
        {
            return mapped;
        }

        var position = 0;
        return Apply(mapped, names, ref position);
    }

    private static ImmutableArray<string?> TryGetNames(ICustomAttributeProvider provider)
    {
        IList<CustomAttributeData>? attrs;
        try
        {
            attrs = provider switch
            {
                MemberInfo member => member.GetCustomAttributesData(),
                ParameterInfo parameter => parameter.GetCustomAttributesData(),
                _ => null,
            };
        }
        catch (Exception ex) when (ex is TypeLoadException or FileNotFoundException or BadImageFormatException)
        {
            return ImmutableArray<string?>.Empty;
        }

        var attr = attrs?.FirstOrDefault(a => a.AttributeType.FullName == TupleElementNamesAttributeFullName);
        if (attr == null || attr.ConstructorArguments.Count != 1)
        {
            return ImmutableArray<string?>.Empty;
        }

        if (attr.ConstructorArguments[0].Value is not IReadOnlyCollection<CustomAttributeTypedArgument> entries)
        {
            return ImmutableArray<string?>.Empty;
        }

        return entries.Select(e => (string?)e.Value).ToImmutableArray();
    }

    private static TypeSymbol Apply(TypeSymbol type, ImmutableArray<string?> names, ref int position)
    {
        // An imported generic type argument surfaces as an imported
        // `System.ValueTuple<…>` rather than a TupleTypeSymbol (issue #813 /
        // #1922 identity bridging covers the two spellings elsewhere).
        // Flatten it first so its positions line up with the name cursor.
        if (type is not TupleTypeSymbol
            && type is ImportedTypeSymbol { ClrType: { } importedClr }
            && TypeSymbol.TryGetTupleTypeSymbolFromClr(importedClr, out var flattened))
        {
            type = flattened;
        }

        switch (type)
        {
            case TupleTypeSymbol tuple:
            {
                if (position + tuple.Arity > names.Length)
                {
                    // Shape mismatch — stop consuming, keep the subtree as-is.
                    position = names.Length;
                    return tuple;
                }

                var elementNames = ImmutableArray.CreateBuilder<string?>(tuple.Arity);
                for (var i = 0; i < tuple.Arity; i++)
                {
                    elementNames.Add(names[position++]);
                }

                var elements = ImmutableArray.CreateBuilder<TypeSymbol>(tuple.Arity);
                foreach (var element in tuple.ElementTypes)
                {
                    elements.Add(Apply(element, names, ref position));
                }

                return TupleTypeSymbol.Get(elements.MoveToImmutable(), elementNames.MoveToImmutable());
            }

            case NullableTypeSymbol nullable:
            {
                var applied = Apply(nullable.UnderlyingType, names, ref position);
                return ReferenceEquals(applied, nullable.UnderlyingType) ? type : NullableTypeSymbol.Get(applied);
            }

            case ArrayTypeSymbol array:
            {
                var applied = Apply(array.ElementType, names, ref position);
                return ReferenceEquals(applied, array.ElementType) ? type : ArrayTypeSymbol.Get(applied, array.Length);
            }

            case SliceTypeSymbol slice:
            {
                var applied = Apply(slice.ElementType, names, ref position);
                return ReferenceEquals(applied, slice.ElementType) ? type : SliceTypeSymbol.Get(applied);
            }

            case RectangularArrayTypeSymbol rectangular:
            {
                var applied = Apply(rectangular.ElementType, names, ref position);
                return ReferenceEquals(applied, rectangular.ElementType) ? type : RectangularArrayTypeSymbol.Get(applied, rectangular.Rank);
            }

            case MapTypeSymbol map:
            {
                var key = Apply(map.KeyType, names, ref position);
                var value = Apply(map.ValueType, names, ref position);
                return ReferenceEquals(key, map.KeyType) && ReferenceEquals(value, map.ValueType)
                    ? type
                    : MapTypeSymbol.Get(key, value);
            }

            case SequenceTypeSymbol sequence:
            {
                var applied = Apply(sequence.ElementType, names, ref position);
                return ReferenceEquals(applied, sequence.ElementType) ? type : SequenceTypeSymbol.Get(applied);
            }

            case AsyncSequenceTypeSymbol asyncSequence:
            {
                var applied = Apply(asyncSequence.ElementType, names, ref position);
                return ReferenceEquals(applied, asyncSequence.ElementType) ? type : AsyncSequenceTypeSymbol.Get(applied);
            }

            case ChannelTypeSymbol channel:
            {
                var applied = Apply(channel.ElementType, names, ref position);
                return ReferenceEquals(applied, channel.ElementType) ? type : ChannelTypeSymbol.Get(applied);
            }

            case ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } imported:
            {
                var arguments = ImmutableArray.CreateBuilder<TypeSymbol>(imported.TypeArguments.Length);
                var changed = false;
                foreach (var argument in imported.TypeArguments)
                {
                    var applied = Apply(argument, names, ref position);
                    arguments.Add(applied);
                    changed |= !ReferenceEquals(applied, argument);
                }

                return changed
                    ? ImportedTypeSymbol.GetConstructed(imported.Type, imported.OpenDefinition, arguments.MoveToImmutable())
                    : type;
            }

            case NullabilityAnnotatedTypeSymbol annotated:
            {
                var applied = Apply(annotated.BaseType, names, ref position);
                return ReferenceEquals(applied, annotated.BaseType)
                    ? type
                    : new NullabilityAnnotatedTypeSymbol(applied, annotated.NullableFlags);
            }

            // A closed generic imported wholesale from a CLR signature (e.g.
            // `List<ValueTuple<int,int>>`) maps to a plain CLR-backed symbol
            // with no symbolic TypeArguments — rebuild it as a constructed
            // imported symbol whose arguments have names applied, so
            // receiver-projected member access (`list[0].line`) sees them.
            case { ClrType: { IsGenericType: true, IsGenericTypeDefinition: false } closedClr }:
            {
                Type[] clrArguments;
                try
                {
                    clrArguments = closedClr.GetGenericArguments();
                }
                catch (Exception ex) when (ex is TypeLoadException or FileNotFoundException or BadImageFormatException)
                {
                    return type;
                }

                var arguments = ImmutableArray.CreateBuilder<TypeSymbol>(clrArguments.Length);
                var changed = false;
                foreach (var clrArgument in clrArguments)
                {
                    var argumentSymbol = TypeSymbol.FromClrType(clrArgument);
                    var applied = Apply(argumentSymbol, names, ref position);
                    arguments.Add(applied);
                    changed |= !ReferenceEquals(applied, argumentSymbol);
                }

                return changed
                    ? ImportedTypeSymbol.GetConstructed(closedClr, closedClr.GetGenericTypeDefinition(), arguments.MoveToImmutable())
                    : type;
            }

            default:
                return type;
        }
    }
}
