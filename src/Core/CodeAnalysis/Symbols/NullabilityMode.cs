// <copyright file="NullabilityMode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0186: how a compilation reads nullability-<em>oblivious</em> imported
/// reference positions. Selected by <c>--nullability=&lt;mode&gt;</c> (equivalently
/// <c>/nullability:&lt;mode&gt;</c>).
/// <para>
/// This is modelled as a named mode rather than a boolean because ADR-0186 §9
/// adds a second, orthogonal value (<c>oblivious</c> — a declaration-scope
/// switch for cs2gs) to the same switch in a later step. A <c>bool</c> here
/// would have to be renamed then.
/// </para>
/// </summary>
public enum NullabilityMode
{
    /// <summary>
    /// ADR-0136's reading, and the <b>default</b>: an oblivious imported
    /// reference position is <c>T?</c>, indistinguishable from a position the
    /// declarer explicitly annotated nullable.
    /// </summary>
    Enabled,

    /// <summary>
    /// ADR-0186's reading: an oblivious imported reference position is the
    /// platform type <c>T!</c> (<see cref="PlatformTypeSymbol"/>), distinct
    /// from both <c>T</c> and <c>T?</c>.
    /// <para>
    /// ADR-0186's sequencing lands this behind an off-by-default flag first
    /// (step 1), teaches conversions, lookup and the coercion check about it
    /// (step 2), and only then flips the default (step 3) — in that order,
    /// never the reverse, because deleting the old carve-out while the flag is
    /// still off would transiently reinstate failure mode 1.
    /// </para>
    /// </summary>
    PlatformTypes,
}
