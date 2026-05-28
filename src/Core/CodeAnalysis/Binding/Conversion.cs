// <copyright file="Conversion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Type conversion classifier.
/// </summary>
public sealed class Conversion
{
    /// <summary>
    /// States that there's no conversion between the given types.
    /// </summary>
    public static readonly Conversion None = new Conversion(exists: false, isIdentity: false, isImplicit: false);

    /// <summary>
    /// States that there's an identity conversion between the given types.
    /// </summary>
    public static readonly Conversion Identity = new Conversion(exists: true, isIdentity: true, isImplicit: true);

    /// <summary>
    /// States that there's an implicit conversion between the given types.
    /// </summary>
    public static readonly Conversion Implicit = new Conversion(exists: true, isIdentity: false, isImplicit: true);

    /// <summary>
    /// States that there's an explicit conversion between the given types.
    /// </summary>
    public static readonly Conversion Explicit = new Conversion(exists: true, isIdentity: false, isImplicit: false);

    // ADR-0044 implicit numeric widening lattice, keyed by source CLR full
    // name → set of target CLR full names. Mirrors C# §6.1.2 plus the
    // ADR-0044 inclusion of `decimal` as a widening target for every
    // integral source. Native-width integers (nint/nuint) follow C#'s
    // rules: nint widens to int64/single/double/decimal; nuint widens to
    // uint64/single/double/decimal.
    private static readonly Dictionary<string, HashSet<string>> NumericWideningTargets = new(StringComparer.Ordinal)
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

    private Conversion(bool exists, bool isIdentity, bool isImplicit)
    {
        Exists = exists;
        IsIdentity = isIdentity;
        IsImplicit = isImplicit;
    }

    /// <summary>
    /// Gets a value indicating whether the conversion exists or not.
    /// </summary>
    public bool Exists { get; }

    /// <summary>
    /// Gets a value indicating whether the conversion is identity or not.
    /// </summary>
    public bool IsIdentity { get; }

    /// <summary>
    /// Gets a value indicating whether the conversion is implicit or not.
    /// </summary>
    public bool IsImplicit { get; }

    /// <summary>
    /// Gets a value indicating whether the conversion is explicit or not.
    /// </summary>
    public bool IsExplicit => Exists && !IsImplicit;

    /// <summary>
    /// Clasifies the convertibility from one type to the other.
    /// </summary>
    /// <param name="from">From type.</param>
    /// <param name="to">To type.</param>
    /// <returns>The conversion mapping between the two types.</returns>
    public static Conversion Classify(TypeSymbol from, TypeSymbol to)
    {
        if (from == to)
        {
            return Conversion.Identity;
        }

        // Phase 3.C.1 / ADR-0001: T → T? is an implicit widening; T? → T?
        // when underlyings match is identity. T? → T requires the bang
        // operator (Phase 3.C.3) and is not implicit here.
        if (to is NullableTypeSymbol toNullable)
        {
            if (from == TypeSymbol.Null)
            {
                return Conversion.Implicit;
            }

            if (from is NullableTypeSymbol fromNullable)
            {
                return fromNullable.UnderlyingType == toNullable.UnderlyingType ? Conversion.Identity : Conversion.None;
            }

            if (from == toNullable.UnderlyingType)
            {
                return Conversion.Implicit;
            }
        }

        // Phase 3.C.2: nil literal is never assignable to a non-nullable type.
        if (from == TypeSymbol.Null && !(to is NullableTypeSymbol))
        {
            return Conversion.None;
        }

        // ADR-0044 numeric lattice. Both operands must be CLR primitives in
        // the numeric set; the widening map decides implicit vs. explicit.
        // Decimal narrowings (decimal → int etc.) and signed/unsigned
        // mismatches at the same width (int ↔ uint) are explicit per C#.
        var fromClr = from?.ClrType?.FullName;
        var toClr = to?.ClrType?.FullName;
        if (fromClr != null && toClr != null
            && NumericClrFullNames.Contains(fromClr)
            && NumericClrFullNames.Contains(toClr))
        {
            if (NumericWideningTargets.TryGetValue(fromClr, out var targets) && targets.Contains(toClr))
            {
                return Conversion.Implicit;
            }

            return Conversion.Explicit;
        }

        if (from == TypeSymbol.Bool || from == TypeSymbol.Int32)
        {
            if (to == TypeSymbol.String)
            {
                return Conversion.Explicit;
            }
        }

        if (from == TypeSymbol.String)
        {
            if (to == TypeSymbol.Bool || to == TypeSymbol.Int32)
            {
                return Conversion.Explicit;
            }
        }

        // Any value backed by a CLR type can be converted to string via ToString().
        if (to == TypeSymbol.String && from?.ClrType != null)
        {
            return Conversion.Explicit;
        }

        // ADR-0045: every value-type primitive (and every user struct)
        // boxes implicitly to `object`. Reference types convert to
        // `object` as a plain reference widening.
        if (to?.ClrType == typeof(object) && from?.ClrType != null)
        {
            return Conversion.Implicit;
        }

        // Boxing conversion for user value types to System.Object.
        if (from is StructSymbol fromStruct && !fromStruct.IsClass && to?.ClrType == typeof(object))
        {
            return Conversion.Implicit;
        }

        // ADR-0045 explicit unbox: `(T)objectValue` for any value-type T.
        if (from?.ClrType == typeof(object) && to?.ClrType != null && to.ClrType.IsValueType)
        {
            return Conversion.Explicit;
        }

        // Reference upcast: a class implicitly converts to any interface in
        // its (transitive) implements-list or to any of its (transitive)
        // base classes. The interpreter stores instances as objects of the
        // concrete class, and on the CLR the upcast is a no-op reference
        // conversion, so no representation change is needed.
        if (from is StructSymbol fromClass && fromClass.IsClass)
        {
            if (to is InterfaceSymbol toInterface)
            {
                for (var c = fromClass; c != null; c = c.BaseClass)
                {
                    foreach (var i in c.Interfaces)
                    {
                        if (i == toInterface)
                        {
                            return Conversion.Implicit;
                        }
                    }
                }
            }

            if (to is StructSymbol toClass && toClass.IsClass)
            {
                for (var c = fromClass.BaseClass; c != null; c = c.BaseClass)
                {
                    if (c == toClass)
                    {
                        return Conversion.Implicit;
                    }
                }
            }
        }

        return Conversion.None;
    }
}
