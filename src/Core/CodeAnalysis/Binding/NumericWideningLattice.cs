// <copyright file="NumericWideningLattice.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #1482: the single authoritative source of truth for the implicit
/// numeric-widening lattice (ADR-0044 / C# §6.1.2 numeric promotions). Keyed by
/// source CLR <see cref="Type.FullName"/> → set of target CLR full names that
/// the source implicitly, losslessly widens to.
/// </summary>
/// <remarks>
/// <para>
/// Previously this lattice was hand-copied into three places — the conversion
/// classifier (<see cref="Conversion"/>), the overload "better conversion"
/// ranker (<see cref="OverloadResolution"/>), and the binary-operator binder.
/// The copies had already DIVERGED: the overload-resolution copy was missing
/// every native-width integer (<c>nint</c>/<c>nuint</c> = <c>System.IntPtr</c>/
/// <c>System.UIntPtr</c>) row, so <c>Conversion.Classify</c> and overload
/// "better conversion target" ranking disagreed about native-int widening.
/// </para>
/// <para>
/// All consumers now query this one table so the relation cannot drift again.
/// The data mirrors C# §6.1.2 plus the ADR-0044 inclusion of <c>decimal</c> as
/// a widening target for every integral source, and the C# native-integer
/// rules: <c>nint</c> widens to <c>int64/single/double/decimal</c>; <c>nuint</c>
/// widens to <c>uint64/single/double/decimal</c>; and the narrower integral and
/// <c>char</c> sources widen into <c>nint</c>/<c>nuint</c> exactly as they do in
/// C#.
/// </para>
/// </remarks>
internal static class NumericWideningLattice
{
    // ADR-0044 implicit numeric widening lattice, keyed by source CLR full
    // name → set of target CLR full names. Native-width integers (nint/nuint)
    // follow C#'s rules and are present both as source rows and as widening
    // targets of the narrower integral and char sources.
    private static readonly Dictionary<string, HashSet<string>> WideningTargetsBySource = new(StringComparer.Ordinal)
    {
        ["System.SByte"] = new(StringComparer.Ordinal) { "System.Int16", "System.Int32", "System.Int64", "System.IntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.Byte"] = new(StringComparer.Ordinal) { "System.Int16", "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.IntPtr", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int16"] = new(StringComparer.Ordinal) { "System.Int32", "System.Int64", "System.IntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt16"] = new(StringComparer.Ordinal) { "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.IntPtr", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int32"] = new(StringComparer.Ordinal) { "System.Int64", "System.IntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt32"] = new(StringComparer.Ordinal) { "System.Int64", "System.UInt64", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.Int64"] = new(StringComparer.Ordinal) { "System.Single", "System.Double", "System.Decimal" },
        ["System.UInt64"] = new(StringComparer.Ordinal) { "System.Single", "System.Double", "System.Decimal" },
        ["System.IntPtr"] = new(StringComparer.Ordinal) { "System.Int64", "System.Single", "System.Double", "System.Decimal" },
        ["System.UIntPtr"] = new(StringComparer.Ordinal) { "System.UInt64", "System.Single", "System.Double", "System.Decimal" },
        ["System.Char"] = new(StringComparer.Ordinal) { "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.IntPtr", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal" },
        ["System.Single"] = new(StringComparer.Ordinal) { "System.Double" },
    };

    // All numeric primitive CLR full-name set — every pair (source != target)
    // that isn't an implicit widening is permitted as an explicit narrowing
    // (per ADR-0044). `char` is included so `(char)<int>` and `(int)<char>`
    // both work the same way as in C#.
    private static readonly HashSet<string> NumericClrFullNames = new(StringComparer.Ordinal)
    {
        "System.SByte",
        "System.Byte",
        "System.Int16",
        "System.UInt16",
        "System.Int32",
        "System.UInt32",
        "System.Int64",
        "System.UInt64",
        "System.IntPtr",
        "System.UIntPtr",
        "System.Single",
        "System.Double",
        "System.Decimal",
        "System.Char",
    };

    private static readonly IReadOnlyCollection<string> EmptyTargets = Array.Empty<string>();

    /// <summary>
    /// Gets the set of CLR full names recognised as numeric primitives. Exposed
    /// so consumers (and the consistency guard test) share one definition of
    /// "numeric primitive" rather than re-listing it.
    /// </summary>
    public static IReadOnlyCollection<string> NumericPrimitiveClrNames => NumericClrFullNames;

    /// <summary>
    /// Determines whether <paramref name="clrFullName"/> is one of the numeric
    /// primitive CLR types covered by the lattice.
    /// </summary>
    /// <param name="clrFullName">The CLR <see cref="Type.FullName"/> to test.</param>
    /// <returns><see langword="true"/> when the type is a numeric primitive.</returns>
    public static bool IsNumericPrimitive(string clrFullName)
        => clrFullName != null && NumericClrFullNames.Contains(clrFullName);

    /// <summary>
    /// Determines whether the CLR type named <paramref name="fromClrFullName"/>
    /// implicitly, losslessly widens to the CLR type named
    /// <paramref name="toClrFullName"/> per the standard numeric-widening
    /// lattice (e.g. <c>System.UInt16</c> → <c>System.Int64</c>). Narrowing and
    /// signed/unsigned same-width mismatches return <see langword="false"/>.
    /// </summary>
    /// <param name="fromClrFullName">Source CLR <see cref="Type.FullName"/>.</param>
    /// <param name="toClrFullName">Target CLR <see cref="Type.FullName"/>.</param>
    /// <returns><see langword="true"/> when the source widens to the target.</returns>
    public static bool IsWidening(string fromClrFullName, string toClrFullName)
        => fromClrFullName != null
            && toClrFullName != null
            && WideningTargetsBySource.TryGetValue(fromClrFullName, out var targets)
            && targets.Contains(toClrFullName);

    /// <summary>
    /// Determines whether the CLR type <paramref name="from"/> implicitly,
    /// losslessly widens to the CLR type <paramref name="to"/>. Compared by
    /// <see cref="Type.FullName"/> so it is safe across reflection contexts.
    /// </summary>
    /// <param name="from">Source CLR type.</param>
    /// <param name="to">Target CLR type.</param>
    /// <returns><see langword="true"/> when the source widens to the target.</returns>
    public static bool IsWidening(Type from, Type to)
        => IsWidening(from?.FullName, to?.FullName);

    /// <summary>
    /// Gets the widening targets for the numeric primitive named
    /// <paramref name="fromClrFullName"/>, or an empty collection when the
    /// source has no widening targets (or is not a lattice source).
    /// </summary>
    /// <param name="fromClrFullName">Source CLR <see cref="Type.FullName"/>.</param>
    /// <returns>The set of CLR full names the source widens to.</returns>
    public static IReadOnlyCollection<string> WideningTargets(string fromClrFullName)
        => fromClrFullName != null && WideningTargetsBySource.TryGetValue(fromClrFullName, out var targets)
            ? targets
            : EmptyTargets;
}
