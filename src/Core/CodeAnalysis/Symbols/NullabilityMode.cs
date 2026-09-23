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
/// adds a third value, <see cref="Oblivious"/> — a declaration-scope switch for
/// cs2gs — to the same switch (step 5). It is a third <em>value</em> rather
/// than a second axis because the combination an axis would add, "ADR-0136's
/// <c>T?</c> import reading plus oblivious source declarations", has no
/// consumer: an oblivious declaration exists to be read as <c>T!</c>, and only
/// a mode that reads <c>T!</c> can say so.
/// </para>
/// <para>
/// <b>Spelling, reconciled with ADR-0186 §9.</b> §9 names the switch's values
/// <c>enabled|oblivious</c>, default <c>enabled</c>, where "enabled" means
/// "source declarations are nullability-enabled". Steps 1–3 had already given
/// <c>enabled</c> a different meaning on this switch — ADR-0136's import
/// reading — so §9's "enabled" is spelled <c>platform-types</c> here (the
/// default), and <c>enabled</c> keeps its step-1 meaning.
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
    /// was still off would transiently reinstate failure mode 1. Step 4 found
    /// that carve-out was not dead once this reading became load-bearing: it
    /// also carries member chains through <em>annotated</em>-nullable imported
    /// members, which ADR-0186 leaves untouched, so it was kept
    /// (see <c>ExpressionBinder.CanBindClrInstanceMember</c>). Under this mode
    /// an oblivious receiver no longer reaches it.
    /// </para>
    /// <para>
    /// This is also ADR-0186 §9's <em>nullability-enabled</em> compilation: an
    /// unadorned reference position a G# declaration writes means <c>T</c>,
    /// unless an enclosing <c>@Oblivious</c> says otherwise.
    /// </para>
    /// </summary>
    PlatformTypes,

    /// <summary>
    /// ADR-0186 §9's <b>oblivious compilation</b>
    /// (<c>--nullability=oblivious</c>): everything
    /// <see cref="PlatformTypes"/> does, and in addition every unadorned
    /// reference position <em>written in G# source</em> means <c>T!</c> unless
    /// an enclosing <c>@NullabilityEnabled</c> says otherwise. <c>T?</c> still
    /// means <c>T?</c>.
    /// <para>
    /// Hand-written G# never uses it. It exists for one consumer, cs2gs, which
    /// renders a nullability-oblivious C# project with it; it is removable per
    /// project as that project's C# source migrates. Which source positions
    /// it reaches is decided by <c>Binding.ObliviousScope</c>, and the answer
    /// is the same one <c>@Oblivious</c> gives a single declaration.
    /// </para>
    /// </summary>
    Oblivious,
}
