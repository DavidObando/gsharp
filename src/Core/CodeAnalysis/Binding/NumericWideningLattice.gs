// <copyright file="NumericWideningLattice.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import System
import System.Collections.Generic

/// Issue #1482: the single authoritative source of truth for the implicit
/// numeric-widening lattice (ADR-0044 / C# §6.1.2 numeric promotions). Keyed by
/// source CLR (cref:Type.FullName) → set of target CLR full names that
/// the source implicitly, losslessly widens to.
/// @remarks Previously this lattice was hand-copied into three places — the conversion
/// classifier ((cref:Conversion)), the overload "better conversion"
/// ranker ((cref:ClrOverloadResolution)), and the binary-operator binder.
/// The copies had already DIVERGED: the overload-resolution copy was missing
/// every native-width integer (`nint`/`nuint` = `System.IntPtr`/
/// `System.UIntPtr`) row, so `Conversion.Classify` and overload
/// "better conversion target" ranking disagreed about native-int widening.
///
/// All consumers now query this one table so the relation cannot drift again.
/// The data mirrors C# §6.1.2 plus the ADR-0044 inclusion of `decimal` as
/// a widening target for every integral source, and the C# native-integer
/// rules: `nint` widens to `int64/single/double/decimal`; `nuint`
/// widens to `uint64/single/double/decimal`; and the narrower integral and
/// `char` sources widen into `nint`/`nuint` exactly as they do in
/// C#.
internal shared class NumericWideningLattice {
    // ADR-0044 implicit numeric widening lattice, keyed by source CLR full
    // name → set of target CLR full names. Native-width integers (nint/nuint)
    // follow C#'s rules and are present both as source rows and as widening
    // targets of the narrower integral and char sources.
    private let WideningTargetsBySource Dictionary[string, HashSet[string]] = Dictionary[string, HashSet[string]](
        StringComparer.Ordinal
    ){
        ["System.SByte"] = HashSet[string](StringComparer.Ordinal){
            "System.Int16",
            "System.Int32",
            "System.Int64",
            "System.IntPtr",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.Byte"] = HashSet[string](StringComparer.Ordinal){
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
            "System.Decimal"
        },
        ["System.Int16"] = HashSet[string](StringComparer.Ordinal){
            "System.Int32",
            "System.Int64",
            "System.IntPtr",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.UInt16"] = HashSet[string](StringComparer.Ordinal){
            "System.Int32",
            "System.UInt32",
            "System.Int64",
            "System.UInt64",
            "System.IntPtr",
            "System.UIntPtr",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.Int32"] = HashSet[string](StringComparer.Ordinal){
            "System.Int64",
            "System.IntPtr",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.UInt32"] = HashSet[string](StringComparer.Ordinal){
            "System.Int64",
            "System.UInt64",
            "System.UIntPtr",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.Int64"] = HashSet[string](StringComparer.Ordinal){"System.Single", "System.Double", "System.Decimal"},
        ["System.UInt64"] = HashSet[string](StringComparer.Ordinal){"System.Single", "System.Double", "System.Decimal"},
        ["System.IntPtr"] = HashSet[string](StringComparer.Ordinal){
            "System.Int64",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.UIntPtr"] = HashSet[string](StringComparer.Ordinal){
            "System.UInt64",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.Char"] = HashSet[string](StringComparer.Ordinal){
            "System.UInt16",
            "System.Int32",
            "System.UInt32",
            "System.Int64",
            "System.UInt64",
            "System.IntPtr",
            "System.UIntPtr",
            "System.Single",
            "System.Double",
            "System.Decimal"
        },
        ["System.Single"] = HashSet[string](StringComparer.Ordinal){"System.Double"}
    }

    // All numeric primitive CLR full-name set — every pair (source != target)
    // that isn't an implicit widening is permitted as an explicit narrowing
    // (per ADR-0044). `char` is included so `(char)<int>` and `(int)<char>`
    // both work the same way as in C#.
    private let NumericClrFullNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
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
        "System.Char"
    }

    private let EmptyTargets IReadOnlyCollection[string] = Array.Empty[string]()

    /// Gets the set of CLR full names recognised as numeric primitives. Exposed
    /// so consumers (and the consistency guard test) share one definition of
    /// "numeric primitive" rather than re-listing it.
    prop NumericPrimitiveClrNames IReadOnlyCollection[string] -> NumericClrFullNames

    /// Determines whether [`clrFullName`](paramref) is one of the numeric
    /// primitive CLR types covered by the lattice.
    /// @param clrFullName The CLR (cref:Type.FullName) to test.
    /// @returns `true` when the type is a numeric primitive.
    func IsNumericPrimitive(clrFullName string?) bool -> clrFullName != nil && NumericClrFullNames.Contains(clrFullName)

    /// Determines whether the CLR type named [`fromClrFullName`](paramref)
    /// implicitly, losslessly widens to the CLR type named
    /// [`toClrFullName`](paramref) per the standard numeric-widening
    /// lattice (e.g. `System.UInt16` → `System.Int64`). Narrowing and
    /// signed/unsigned same-width mismatches return `false`.
    /// @param fromClrFullName Source CLR (cref:Type.FullName).
    /// @param toClrFullName Target CLR (cref:Type.FullName).
    /// @returns `true` when the source widens to the target.
    func IsWidening(fromClrFullName string?, toClrFullName string?) bool -> fromClrFullName != nil &&
        toClrFullName != nil &&
        WideningTargetsBySource.TryGetValue(fromClrFullName, out var targets) && targets.Contains(toClrFullName)

    /// Determines whether the CLR type [`from`](paramref) implicitly,
    /// losslessly widens to the CLR type [`to`](paramref). Compared by
    /// (cref:Type.FullName) so it is safe across reflection contexts.
    /// @param from Source CLR type.
    /// @param to Target CLR type.
    /// @returns `true` when the source widens to the target.
    func IsWidening(from Type?, to Type?) bool -> IsWidening(from?.FullName, to?.FullName)

    /// Gets the widening targets for the numeric primitive named
    /// [`fromClrFullName`](paramref), or an empty collection when the
    /// source has no widening targets (or is not a lattice source).
    /// @param fromClrFullName Source CLR (cref:Type.FullName).
    /// @returns The set of CLR full names the source widens to.
    func WideningTargets(fromClrFullName string?) IReadOnlyCollection[string] -> if fromClrFullName != nil &&
        WideningTargetsBySource.TryGetValue(fromClrFullName, out var targets) {
        cast[IReadOnlyCollection[string]](targets)
    } else {
        EmptyTargets
    }
}
