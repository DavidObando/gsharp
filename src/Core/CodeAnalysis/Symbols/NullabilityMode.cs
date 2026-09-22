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
    /// ADR-0136's reading: an oblivious imported reference position is
    /// <c>T?</c>, indistinguishable from a position the declarer explicitly
    /// annotated nullable. <b>No longer the default</b> — ADR-0186 step 3
    /// moved that to <see cref="PlatformTypes"/> — but still selectable with
    /// <c>/nullability:enabled</c>.
    /// <para>
    /// This is deliberately still the enum's <b>zero</b> value even though it
    /// is no longer the default, because the two facts are unrelated and
    /// coupling them is what would go wrong quietly: the ambient scope stores
    /// a <em>nullable</em> mode and resolves "unset" to
    /// <c>NullabilityOptions.DefaultMode</c>, so nothing reads the zero value
    /// as an answer. Renumbering would change a persisted/serialised meaning
    /// for no gain.
    /// </para>
    /// </summary>
    Enabled,

    /// <summary>
    /// ADR-0186's reading, and the <b>default</b> since step 3: an oblivious
    /// imported reference position is the platform type <c>T!</c>
    /// (<see cref="PlatformTypeSymbol"/>), distinct from both <c>T</c> and
    /// <c>T?</c>.
    /// <para>
    /// ADR-0186's sequencing landed this behind an off-by-default flag first
    /// (step 1), taught conversions, lookup and the coercion check about it
    /// (step 2), and only then flipped the default (step 3) — in that order,
    /// never the reverse, because deleting the old carve-out while the flag
    /// was still off would transiently reinstate failure mode 1. Step 4
    /// deleted that carve-out once this reading became load-bearing.
    /// </para>
    /// </summary>
    PlatformTypes,
}
