// <copyright file="TypeSymbol.NullabilityQueries.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0193 §2: the answer to <em>"what is this type's reference
/// nullability?"</em> for one top-level position.
/// <para>
/// A separate enum from <see cref="ImportedReferenceNullability"/>, which is
/// the import rule's <em>decision</em> (its fourth value is "leave the input
/// as it is"). This one is a query result, and its fourth value says the
/// question does not apply: a value type, including <c>Nullable&lt;V&gt;</c>,
/// has no reference nullability. Value optionality (ADR-0001) is a different
/// question.
/// </para>
/// </summary>
internal enum ReferenceNullabilityKind
{
    /// <summary>A value type (including <c>Nullable&lt;V&gt;</c>), <c>void</c>, or the error type.</summary>
    NotApplicable,

    /// <summary>A reference position stated non-null: <c>T</c>.</summary>
    NotNull,

    /// <summary>A reference position stated nullable: <c>T?</c>, and the nil type.</summary>
    Nullable,

    /// <summary>A reference position whose nullability nobody stated: <c>T!</c> (ADR-0186).</summary>
    Platform,
}

/// <content>
/// ADR-0193 §2: the type-level nullability queries. Phase 1 adds the two
/// read-only members the §4 reader-agreement test compares readers through;
/// no consumer moves onto them until Phase 3, which adds the rest of the API.
/// </content>
public partial class TypeSymbol
{
    /// <summary>
    /// Gets the reference nullability of this type's top-level position, read
    /// through whichever wrapper represents it (<see cref="NullableTypeSymbol"/>,
    /// <see cref="PlatformTypeSymbol"/>, or a
    /// <see cref="NullabilityAnnotatedTypeSymbol"/> over either Layer 3
    /// representation). Value types — including a value-type
    /// <c>Nullable&lt;V&gt;</c>, decided by
    /// <see cref="NullableLifting.IsAnyValueTypeNullable"/> — report
    /// <see cref="ReferenceNullabilityKind.NotApplicable"/>.
    /// </summary>
    internal ReferenceNullabilityKind ReferenceNullability
    {
        get
        {
            switch (this)
            {
                case NullableTypeSymbol nullable:
                    return NullableLifting.IsAnyValueTypeNullable(nullable)
                        ? ReferenceNullabilityKind.NotApplicable
                        : ReferenceNullabilityKind.Nullable;
                case PlatformTypeSymbol:
                    return ReferenceNullabilityKind.Platform;
                case NullabilityAnnotatedTypeSymbol annotated:
                    // The walkers express byte 0's state as the wrapper AROUND
                    // this symbol, so the top-level answer is the wrapper's.
                    // A bare annotated symbol reads as its base. Decoding byte
                    // 0 here instead is a Phase 3 query-API precision item
                    // (#4363): the event readers strip only the outer `?`, so
                    // the byte and the wrapper disagree today.
                    return annotated.BaseType.ReferenceNullability;
                case ByRefTypeSymbol byRef:
                    // A by-ref contributes no nullability position of its own;
                    // `[Nullable]` on a by-ref annotates the pointee.
                    return byRef.PointeeType.ReferenceNullability;
            }

            if (ReferenceEquals(this, Null))
            {
                return ReferenceNullabilityKind.Nullable;
            }

            if (ReferenceEquals(this, Error) || ReferenceEquals(this, Void) || ReferenceEquals(this, Never))
            {
                return ReferenceNullabilityKind.NotApplicable;
            }

            return NullabilityImportRule.ClassifyArgument(this) == TypeArgumentKind.Value
                ? ReferenceNullabilityKind.NotApplicable
                : ReferenceNullabilityKind.NotNull;
        }
    }

    /// <summary>
    /// Returns this type's element and type-argument positions, each with the
    /// nullability the reader gave it, whichever Layer 3 representation holds
    /// it: nested wrapper types (<see cref="ImportedTypeSymbol.TypeArguments"/>,
    /// slice and array elements, map keys and values, tuple elements) or the
    /// lazily-decoded flags of a <see cref="NullabilityAnnotatedTypeSymbol"/>
    /// (through <see cref="NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol"/>
    /// and <see cref="NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType"/>,
    /// the accessors an element read uses).
    /// <para>
    /// A top-level <c>?</c>, <c>!</c>, <c>Nullable&lt;V&gt;</c> or by-ref is
    /// transparent: its positions are its underlying type's, exactly as
    /// C# nullable metadata lays them out.
    /// </para>
    /// </summary>
    /// <returns>The immediate positions, in declaration order; empty for a leaf type.</returns>
    internal ImmutableArray<TypeSymbol> GetElementPositions()
    {
        switch (this)
        {
            case NullableTypeSymbol nullable:
                return nullable.UnderlyingType.GetElementPositions();
            case PlatformTypeSymbol platform:
                return platform.UnderlyingType.GetElementPositions();
            case ByRefTypeSymbol byRef:
                return byRef.PointeeType.GetElementPositions();
            case NullabilityAnnotatedTypeSymbol annotated:
                return SpliceTupleRest(annotated.ClrType, annotated.GetAnnotatedElementPositions());
            case ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } imported:
                return SpliceTupleRest(imported.OpenDefinition ?? imported.ClrType, imported.TypeArguments);
            case SliceTypeSymbol slice:
                return ImmutableArray.Create(slice.ElementType);
            case ArrayTypeSymbol array:
                return ImmutableArray.Create(array.ElementType);
            case RectangularArrayTypeSymbol rectangular:
                return ImmutableArray.Create(rectangular.ElementType);
            case MapTypeSymbol map:
                return ImmutableArray.Create(map.KeyType, map.ValueType);
            case TupleTypeSymbol tuple:
                return tuple.ElementTypes;
            case SequenceTypeSymbol sequence:
                return ImmutableArray.Create(sequence.ElementType);
            case AsyncSequenceTypeSymbol asyncSequence:
                return ImmutableArray.Create(asyncSequence.ElementType);
            case ChannelTypeSymbol channel:
                return ImmutableArray.Create(channel.ElementType);
            case FunctionTypeSymbol function:
                // The delegate shape `Func<T1, …, TResult>` lays its
                // parameters out before its return; an `Action<…>` has no
                // return position at all.
                return ReferenceEquals(function.ReturnType, Void)
                    ? function.ParameterTypes
                    : function.ParameterTypes.Add(function.ReturnType);

            // Constructed same-compilation types carry their arguments
            // symbolically; their ClrType is commonly null before emit. A
            // nested type's CLR arity puts the enclosing type's arguments
            // first, and so do its positions.
            case StructSymbol structure
                when !structure.TypeArguments.IsDefaultOrEmpty || !structure.EnclosingTypeArguments.IsDefaultOrEmpty:
                return structure.EnclosingTypeArguments.IsDefaultOrEmpty
                    ? structure.TypeArguments
                    : structure.EnclosingTypeArguments.AddRange(
                        structure.TypeArguments.IsDefault ? ImmutableArray<TypeSymbol>.Empty : structure.TypeArguments);
            case InterfaceSymbol constructedInterface when !constructedInterface.TypeArguments.IsDefaultOrEmpty:
                return constructedInterface.TypeArguments;
            case DelegateTypeSymbol constructedDelegate when !constructedDelegate.TypeArguments.IsDefaultOrEmpty:
                return constructedDelegate.TypeArguments;
        }

        return GetClrElementPositions(ClrType);
    }

    /// <summary>
    /// ADR-0193 Phase 2: the shape a caller that deliberately ignores
    /// reference nullability used to get from <see cref="FromClrType"/>. It
    /// removes a top-level reference <c>?</c> and platform <c>!</c>, and the
    /// <see cref="NullabilityAnnotatedTypeSymbol"/> carrier, repeatedly, and
    /// leaves a value-type <c>Nullable&lt;V&gt;</c> alone.
    /// <para>
    /// Dropping the carrier also drops the inner-position flags it holds
    /// (<c>List[string?]?</c> becomes <c>List[string]</c>), while
    /// inner positions held as nested wrappers survive. That is deliberate
    /// for the few Phase 2 callers: each read a signature position erased
    /// before, and wants that exact shape (an <c>object</c> member called on an
    /// erased type parameter, a boxing target, a method group's inference
    /// signature, a lowered local). Nothing that wants nullability should
    /// call this. Phase 3's <c>StripReferenceNullability(deep)</c> replaces it
    /// with a representation-independent answer.
    /// </para>
    /// </summary>
    /// <returns>The bare type.</returns>
    internal TypeSymbol StripToBareShape()
    {
        var type = this;
        while (true)
        {
            switch (type)
            {
                case PlatformTypeSymbol platform:
                    type = platform.UnderlyingType;
                    continue;
                case NullableTypeSymbol nullable when !NullableLifting.IsAnyValueTypeNullable(nullable):
                    type = nullable.UnderlyingType;
                    continue;
                case NullabilityAnnotatedTypeSymbol annotated:
                    type = annotated.BaseType;
                    continue;
                default:
                    return type;
            }
        }
    }

    /// <summary>
    /// An eight-argument <c>ValueTuple</c>/<c>Tuple</c> nests elements eight
    /// onward in its <c>TRest</c> argument. <see cref="TupleTypeSymbol"/> — what
    /// <see cref="FromClrType"/> builds — is already flat (issue #2750), so the
    /// other representations splice their rest in too: the positions of a
    /// tuple are its elements, however it is held.
    /// </summary>
    /// <param name="shape">The CLR definition or closed type of the holder.</param>
    /// <param name="positions">The holder's own positions.</param>
    /// <returns>The flattened positions.</returns>
    private static ImmutableArray<TypeSymbol> SpliceTupleRest(System.Type? shape, ImmutableArray<TypeSymbol> positions)
    {
        if (positions.Length != 8 || shape is not { IsGenericType: true })
        {
            return positions;
        }

        var definition = shape.IsGenericTypeDefinition ? shape : shape.GetGenericTypeDefinition();
        if (definition.FullName is not ("System.ValueTuple`8" or "System.Tuple`8"))
        {
            return positions;
        }

        // Only a canonical rest — itself a tuple — nests elements. A
        // non-canonical `ValueTuple<…, int>` is eight elements, exactly as
        // FromClrType reads it.
        var rest = positions[7];
        var restShape = rest is ImportedTypeSymbol restImported ? restImported.OpenDefinition ?? rest.ClrType : rest.ClrType;
        var restIsTuple = rest is TupleTypeSymbol
            || (restShape is { IsGenericType: true } restGeneric
                && (restGeneric.IsGenericTypeDefinition ? restGeneric : restGeneric.GetGenericTypeDefinition()).FullName is { } restName
                && (restName.StartsWith("System.ValueTuple`", StringComparison.Ordinal)
                    || restName.StartsWith("System.Tuple`", StringComparison.Ordinal)));
        return restIsTuple
            ? positions.RemoveAt(7).AddRange(rest.GetElementPositions())
            : positions;
    }

    /// <summary>
    /// The positions of a type that carries no symbolic arguments: its CLR
    /// shape is all there is, and a CLR type states no reference nullability
    /// of its own, so each position is <see cref="FromClrType"/>'s bare answer.
    /// </summary>
    /// <param name="clrType">The CLR shape.</param>
    /// <returns>The positions.</returns>
    private static ImmutableArray<TypeSymbol> GetClrElementPositions(System.Type? clrType)
    {
        if (clrType == null)
        {
            return ImmutableArray<TypeSymbol>.Empty;
        }

        if (clrType.IsArray)
        {
            return clrType.GetElementType() is { } element
                ? ImmutableArray.Create(FromClrTypeWithoutNullability(element, NullabilityFreeReason.TypeStructure))
                : ImmutableArray<TypeSymbol>.Empty;
        }

        if (!clrType.IsGenericType || clrType.IsGenericTypeDefinition)
        {
            return ImmutableArray<TypeSymbol>.Empty;
        }

        var arguments = clrType.GetGenericArguments();
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(arguments.Length);
        foreach (var argument in arguments)
        {
            builder.Add(FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure));
        }

        return builder.MoveToImmutable();
    }
}
