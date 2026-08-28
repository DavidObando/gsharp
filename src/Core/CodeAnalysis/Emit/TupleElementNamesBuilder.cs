// <copyright file="TupleElementNamesBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// ADR-0172 Phase B: computes the C#-compatible
/// <c>[System.Runtime.CompilerServices.TupleElementNamesAttribute]</c>
/// <c>string[]</c> for a G# <see cref="TypeSymbol"/> — a DFS pre-order walk
/// of the type tree in which every tuple occurrence contributes its arity of
/// entries (declared name, or <see langword="null"/> for an unnamed position)
/// before its element subtrees are visited. Non-tuple composites (arrays,
/// slices, maps, sequences, channels, nullable wrappers, generic
/// instantiations, function types) contribute no entries of their own but are
/// traversed, matching Roslyn's <c>TupleNamesEncoder</c>. Arity ≥ 8 tuples
/// contribute their LOGICAL elements only — the CLR's synthesized
/// <c>TRest</c> nesting is invisible, exactly as in C#. The attribute is
/// only emitted when at least one entry is non-null; <see cref="Build"/>
/// returns an empty array otherwise.
/// </summary>
internal static class TupleElementNamesBuilder
{
    /// <summary>
    /// Computes the flattened element-name array for the supplied type.
    /// Returns an empty array when no tuple position anywhere in the type
    /// declares a name (no attribute needed).
    /// </summary>
    /// <param name="type">The parameter / return / field / property type to inspect.</param>
    /// <returns>The names array — possibly empty; never <see langword="default"/>.</returns>
    internal static ImmutableArray<string?> Build(TypeSymbol type)
    {
        var builder = ImmutableArray.CreateBuilder<string?>();
        var anyName = false;
        Append(type, builder, ref anyName);
        return anyName ? builder.ToImmutable() : ImmutableArray<string?>.Empty;
    }

    private static void Append(TypeSymbol type, ImmutableArray<string?>.Builder builder, ref bool anyName)
    {
        switch (type)
        {
            case TupleTypeSymbol tuple:
                for (var i = 0; i < tuple.Arity; i++)
                {
                    var name = tuple.HasNames ? tuple.ElementNames[i] : null;
                    builder.Add(name);
                    anyName |= name != null;
                }

                foreach (var element in tuple.ElementTypes)
                {
                    Append(element, builder, ref anyName);
                }

                break;

            case NullableTypeSymbol nullable:
                Append(nullable.UnderlyingType, builder, ref anyName);
                break;

            case ArrayTypeSymbol array:
                Append(array.ElementType, builder, ref anyName);
                break;

            case SliceTypeSymbol slice:
                Append(slice.ElementType, builder, ref anyName);
                break;

            case RectangularArrayTypeSymbol rectangular:
                Append(rectangular.ElementType, builder, ref anyName);
                break;

            case MapTypeSymbol map:
                Append(map.KeyType, builder, ref anyName);
                Append(map.ValueType, builder, ref anyName);
                break;

            case SequenceTypeSymbol sequence:
                Append(sequence.ElementType, builder, ref anyName);
                break;

            case AsyncSequenceTypeSymbol asyncSequence:
                Append(asyncSequence.ElementType, builder, ref anyName);
                break;

            case ChannelTypeSymbol channel:
                Append(channel.ElementType, builder, ref anyName);
                break;

            case FunctionTypeSymbol function:
                foreach (var parameterType in function.ParameterTypes)
                {
                    Append(parameterType, builder, ref anyName);
                }

                Append(function.ReturnType, builder, ref anyName);
                break;

            case StructSymbol { TypeArguments.IsDefaultOrEmpty: false } aggregate:
                foreach (var argument in aggregate.TypeArguments)
                {
                    Append(argument, builder, ref anyName);
                }

                break;

            case ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } imported:
                foreach (var argument in imported.TypeArguments)
                {
                    Append(argument, builder, ref anyName);
                }

                break;

            default:
                break;
        }
    }
}
