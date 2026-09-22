// <copyright file="PlatformTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0186 §1: the <b>platform type</b> <c>T!</c> — a reference position whose
/// nullability nobody stated.
/// <para>
/// A <see cref="NullableTypeSymbol"/> means "the declarer said this may be
/// nil". A bare <see cref="TypeSymbol"/> means "the declarer said this is never
/// nil". <see cref="PlatformTypeSymbol"/> is the third answer, and the only
/// honest one for a position imported from nullability-<em>oblivious</em> CLR
/// metadata: <em>the declarer said nothing</em>. ADR-0136 collapsed that third
/// answer onto <c>T?</c>, which is what forced every use site to discharge a
/// proof obligation about a fact the compiler does not have — and what the
/// carve-out predicates ADR-0186 removes were reconstructing, one bound-node
/// kind at a time.
/// </para>
/// <para>
/// The wrapper is deliberately a <b>distinct symbol</b> rather than a flag on
/// <see cref="NullableTypeSymbol"/> (ADR-0186 alternative 2). The sites that
/// must not treat a platform value as nullable — member lookup, overload
/// resolution, GS0159 — simply never match <c>is NullableTypeSymbol</c>, and
/// they do so <em>by construction</em> rather than by each remembering to ask a
/// predicate. It is equally deliberately <b>not</b> an erasure to <c>T</c>:
/// <c>T!</c> must still admit <c>== nil</c>, <c>if let</c>, <c>?.</c> and
/// <c>!!</c>, and erasing it would reinstate verbatim the hole ADR-0136 closed.
/// </para>
/// <para>
/// It is <b>never writable in source</b>. No syntax produces one; it is
/// produced by exactly one mechanism (ADR-0186 §2 — <c>ClrNullability</c>'s
/// three reading paths, for a position whose nullability byte is oblivious) and
/// appears only in diagnostics, hover text and <c>DisplayFormat</c> output,
/// spelled <c>T!</c>.
/// </para>
/// <para>
/// Like <see cref="NullableTypeSymbol"/> the wrapper is purely a binder-level
/// annotation: <see cref="TypeSymbol.ClrType"/> is the underlying type's, and
/// emit erases the wrapper to <c>T</c>.
/// </para>
/// </summary>
/// <remarks>
/// ADR-0186 step 1 built the symbol and its read path behind
/// <c>--nullability=platform-types</c>; step 3 made that mode the <b>default</b>
/// (<see cref="NullabilityOptions"/>), so an ordinary compilation constructs
/// these wrappers for every oblivious imported reference position.
/// <c>--nullability=enabled</c> restores ADR-0136's reading, and under it
/// nothing constructs one.
/// </remarks>
public sealed class PlatformTypeSymbol : TypeSymbol
{
    /// <summary>
    /// Reference-identity cache, mirroring <see cref="NullableTypeSymbol"/>'s.
    /// <para>
    /// This is not an optimisation. <c>SymbolEqualityComparer.Default</c> is
    /// <c>ReferenceEquals</c> and G# symbols are reference-unique within a
    /// compilation, so two independently-constructed wrappers over the same
    /// underlying type would be two <em>different</em> types to every symbol
    /// set, dictionary and identity comparison in the binder. De-duplicating
    /// here is what makes <c>T!</c> a type rather than a family of
    /// indistinguishable look-alikes.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<TypeSymbol, PlatformTypeSymbol> Cache = new();

    private PlatformTypeSymbol(TypeSymbol underlyingType)
        : base(ComputeDisplayName(underlyingType), underlyingType.ClrType)
    {
        UnderlyingType = underlyingType;
    }

    /// <summary>Gets the underlying type whose nullability was never stated.</summary>
    public TypeSymbol UnderlyingType { get; }

    /// <summary>
    /// Returns the cached <see cref="PlatformTypeSymbol"/> wrapping the given
    /// underlying type.
    /// </summary>
    /// <param name="underlyingType">The underlying reference type.</param>
    /// <returns>
    /// A cached platform wrapper. Wrapping a <see cref="PlatformTypeSymbol"/>
    /// is a no-op, exactly as <see cref="NullableTypeSymbol.Get"/> is
    /// idempotent over its own wrapper.
    /// </returns>
    public static PlatformTypeSymbol Get(TypeSymbol underlyingType)
    {
        if (underlyingType is PlatformTypeSymbol already)
        {
            return already;
        }

        return Cache.GetOrAdd(underlyingType, static t => new PlatformTypeSymbol(t));
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> alongside
    /// <see cref="NullableTypeSymbol.ClearCache"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    /// <summary>
    /// ADR-0186 §1 / ADR-0132: the <c>!</c> follows the same <b>positional</b>
    /// rule as <see cref="NullableTypeSymbol"/>'s <c>?</c>, and it needs a
    /// parallel implementation rather than falling out for free.
    /// <para>
    /// A platform array/slice must render with the <c>!</c> bound to the array
    /// itself (<c>[]!T</c> / <c>[N]!T</c>) so its display name is distinct from
    /// a slice of platform elements (<c>[]T!</c> =
    /// <c>Slice(Platform(T))</c>) — the exact distinction ADR-0132 draws for
    /// <c>[]?T</c> versus <c>[]T?</c>. A platform function type wraps the whole
    /// arrow shape in parentheses (<c>((int32) -&gt; void)!</c>) so the
    /// <c>!</c> applies to the function type and not just its return type. For
    /// every other underlying type the marker trails the name (<c>T!</c>).
    /// </para>
    /// </summary>
    /// <param name="underlyingType">The underlying type.</param>
    /// <returns>The G# display name for the platform wrapper.</returns>
    private static string ComputeDisplayName(TypeSymbol underlyingType)
    {
        return underlyingType switch
        {
            SliceTypeSymbol slice => $"[]!{slice.ElementType.Name}",
            ArrayTypeSymbol array => $"[{array.Length}]!{array.ElementType.Name}",
            RectangularArrayTypeSymbol array => $"[{new string(',', array.Rank - 1)}]!{array.ElementType.Name}",
            FunctionTypeSymbol function => $"({function.Name})!",
            _ => underlyingType.Name + "!",
        };
    }
}
