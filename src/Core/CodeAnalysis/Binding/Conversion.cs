// <copyright file="Conversion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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

        if (from == TypeSymbol.Bool || from == TypeSymbol.Int)
        {
            if (to == TypeSymbol.String)
            {
                return Conversion.Explicit;
            }
        }

        if (from == TypeSymbol.String)
        {
            if (to == TypeSymbol.Bool || to == TypeSymbol.Int)
            {
                return Conversion.Explicit;
            }
        }

        // Any value backed by a CLR type can be converted to string via ToString().
        if (to == TypeSymbol.String && from?.ClrType != null)
        {
            return Conversion.Explicit;
        }

        return Conversion.None;
    }
}
