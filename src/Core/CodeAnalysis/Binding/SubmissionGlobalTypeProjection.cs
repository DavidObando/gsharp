// <copyright file="SubmissionGlobalTypeProjection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #3308 / ADR-0156 Phase 2: reverse projection for prior-submission
/// globals whose declared G# type is a compiler-magic wrapper kind. Later
/// cells bind a prior cell's top-level global through its emitted CLR field
/// (the #3186 submission-as-metadata seam), so the field's type surfaces as
/// the CLR <em>projection</em> of the declared type — e.g. a <c>chan T</c>
/// global surfaces as imported <c>System.Threading.Channels.Channel[T]</c>.
/// Kinds whose operations type-check against the magic symbol itself
/// (<see cref="ChannelTypeSymbol"/> for <c>&lt;-</c>/<c>select</c>/<c>close</c>,
/// <see cref="SliceTypeSymbol"/>/<see cref="ArrayTypeSymbol"/> for
/// <c>len</c>/<c>cap</c>/<c>append</c>) lose those operations cross-cell
/// unless the CLR projection is mapped back to the magic symbol.
/// <para>
/// The reverse projection is steered by the declaring submission's
/// source-side type (recorded in its <see cref="BoundGlobalScope"/>), which
/// settles otherwise-ambiguous CLR shapes (a <c>T[]</c> field is a slice or
/// a fixed array depending on the declaration, and the fixed length exists
/// only source-side); component types are rebuilt from the CURRENT
/// compilation's metadata view of the field (never from the prior
/// compilation's symbols, whose CLR identities belong to a different
/// resolver). Kinds that already round-trip correctly through the seam are
/// intentionally left on their existing paths: maps bind through the erased
/// <c>IDictionary`2</c> member family, sequences through the duck-typed
/// enumerable probes, and function-typed globals through the delegate-shape
/// mapping in the call binder (#3184).
/// </para>
/// </summary>
internal static class SubmissionGlobalTypeProjection
{
    /// <summary>
    /// Maps a prior-submission global's CLR-projected type back to its magic
    /// wrapper symbol when the source-side declaration says the global was a
    /// magic kind whose operations require symbol identity. Returns
    /// <paramref name="projected"/> unchanged when no arm applies.
    /// </summary>
    /// <param name="projected">The CLR-projected type the metadata read produced.</param>
    /// <param name="clrFieldType">The emitted field's CLR type, seen through the current resolver.</param>
    /// <param name="declaredType">The declaring submission's source-side type for the global (may be <see langword="null"/>).</param>
    /// <param name="references">The current compilation's reference resolver.</param>
    /// <returns>The reverse-projected type, or <paramref name="projected"/> when no arm applies.</returns>
    internal static TypeSymbol ReverseProject(TypeSymbol projected, Type clrFieldType, TypeSymbol? declaredType, ReferenceResolver references)
    {
        switch (declaredType)
        {
            case ChannelTypeSymbol declaredChannel:
                if (TryGetChannelElement(clrFieldType, out var elementClr, out var direction)
                    && direction == declaredChannel.Direction
                    && TryProjectComponent(elementClr, declaredChannel.ElementType, references, out var element))
                {
                    return ChannelTypeSymbol.Get(element, direction);
                }

                break;

            case SliceTypeSymbol declaredSlice:
                if (clrFieldType is { IsSZArray: true }
                    && TryProjectComponent(clrFieldType.GetElementType(), declaredSlice.ElementType, references, out var sliceElement))
                {
                    return SliceTypeSymbol.Get(sliceElement);
                }

                break;

            case ArrayTypeSymbol declaredArray:
                // The CLR projection of `[N]T` is the same `T[]` a slice
                // projects to — the fixed length N exists only source-side,
                // so it is recovered from the declaration.
                if (clrFieldType is { IsSZArray: true }
                    && TryProjectComponent(clrFieldType.GetElementType(), declaredArray.ElementType, references, out var arrayElement))
                {
                    return ArrayTypeSymbol.Get(arrayElement, declaredArray.Length);
                }

                break;
        }

        return projected;
    }

    // Projects one component (element) type of a magic wrapper through the
    // current resolver's metadata view, recursing so nested magic kinds
    // (e.g. `chan []int32`) keep their identity too.
    private static bool TryProjectComponent(
        Type? clrType,
        TypeSymbol declaredComponent,
        ReferenceResolver references,
        [NotNullWhen(true)] out TypeSymbol? component)
    {
        component = null;
        if (clrType == null)
        {
            return false;
        }

        var projected = ImportedTypeSymbol.NormalizeSemanticAggregate(TypeSymbol.FromClrType(clrType), clrType, references);
        if (projected == null || projected == TypeSymbol.Error || projected == TypeSymbol.Void)
        {
            return false;
        }

        component = ReverseProject(projected, clrType, declaredComponent, references);
        return true;
    }

    // Matches the emitted backing shape of a channel type clause (ADR-0174 D2)
    // — a closed `Channel<T>` (chan[T]), `ChannelReader<T>` (in chan[T]) or
    // `ChannelWriter<T>` (out chan[T]) — by open-definition full name, so
    // types seen through a MetadataLoadContext still match. The runtime's
    // constructed `Chan<T>` is deliberately NOT matched: a global declared by
    // construction (`let ch = chan[T](1)`) keeps its imported class type so
    // `Length()`/`Capacity`/`Close()` stay bindable in later cells.
    private static bool TryGetChannelElement(Type clrFieldType, [NotNullWhen(true)] out Type? elementClr, out ChannelDirection direction)
    {
        elementClr = null;
        direction = ChannelDirection.Both;
        if (clrFieldType is not { IsGenericType: true })
        {
            return false;
        }

        switch (clrFieldType.GetGenericTypeDefinition().FullName)
        {
            case "System.Threading.Channels.Channel`1":
                direction = ChannelDirection.Both;
                break;
            case "System.Threading.Channels.ChannelReader`1":
                direction = ChannelDirection.In;
                break;
            case "System.Threading.Channels.ChannelWriter`1":
                direction = ChannelDirection.Out;
                break;
            default:
                return false;
        }

        elementClr = clrFieldType.GetGenericArguments()[0];
        return true;
    }
}
