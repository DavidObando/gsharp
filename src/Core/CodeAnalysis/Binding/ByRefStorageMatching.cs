// <copyright file="ByRefStorageMatching.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #4422: decides whether the storage behind a by-reference argument
/// (<c>&amp;x</c> at a <c>ref</c>, <c>out</c> or <c>in</c> parameter of a G#
/// callee) has the parameter's type.
/// <para>
/// A by-reference argument passes the storage location itself, so its type
/// must be the parameter type, with no conversion. Reference nullability is
/// the one exception: <c>[]?int32</c> and <c>[]int32</c>, or
/// <c>List[string?]</c> and <c>List[string]</c>, are one runtime type, and C#
/// accepts such an argument with only a nullability warning. A value-type
/// <c>int32?</c> is <c>Nullable&lt;int32&gt;</c>, a different runtime type, and
/// is never accepted for <c>int32</c>.
/// </para>
/// <para>
/// This replaces <see cref="DeclarationBinder.TypeSignaturesEquivalent(TypeSymbol, TypeSymbol)"/>
/// at the by-ref gates. That predicate is exact only by accident here: when
/// exactly one side is a <see cref="NullableTypeSymbol"/> it falls through to
/// comparing CLR types, and a nullable wrapper relays its underlying type's
/// CLR type. So it accepted every same-compilation <c>T?</c> storage silently
/// (including <c>int32?</c> at <c>ref int32</c>, which then wrote an
/// <c>int32</c> over a <c>Nullable&lt;int32&gt;</c>), while it rejected an
/// imported <c>int[]?</c> field, whose array symbol is not the slice symbol the
/// parameter spells.
/// </para>
/// </summary>
internal static class ByRefStorageMatching
{
    /// <summary>
    /// Compares the storage type of a by-reference argument with the
    /// parameter type.
    /// </summary>
    /// <param name="storageType">The type of the storage the argument's address points at.</param>
    /// <param name="parameterType">The (substituted) parameter type.</param>
    /// <param name="storageNullable">
    /// Set when the top-level storage type is stated nullable (<c>T?</c>) and the
    /// parameter type is stated non-null (<c>T</c>): a nil in the storage
    /// reaches the callee as a non-null value.
    /// </param>
    /// <param name="parameterNullable">
    /// Set when the top-level parameter type is stated nullable and the storage
    /// type is stated non-null: the callee may store nil into storage declared
    /// non-null.
    /// </param>
    /// <param name="nestedMismatch">
    /// Set when an element or type-argument position differs in stated
    /// nullability. Both views share one object, so values of either
    /// nullability can flow through it in both directions.
    /// </param>
    /// <returns>
    /// <see langword="true"/> when the two types are the same runtime type,
    /// differing at most in reference nullability.
    /// </returns>
    public static bool AreSameStorageType(
        TypeSymbol storageType,
        TypeSymbol parameterType,
        out bool storageNullable,
        out bool parameterNullable,
        out bool nestedMismatch)
    {
        storageNullable = false;
        parameterNullable = false;
        nestedMismatch = false;
        var storageKind = storageType.ReferenceNullability;
        var parameterKind = parameterType.ReferenceNullability;

        // ADR-0186: a platform (`T!`) position stated nothing, so it differs
        // from neither `T` nor `T?`; only two stated positions can disagree.
        if (storageKind == ReferenceNullabilityKind.Nullable && parameterKind == ReferenceNullabilityKind.NotNull)
        {
            storageNullable = true;
        }
        else if (parameterKind == ReferenceNullabilityKind.Nullable && storageKind == ReferenceNullabilityKind.NotNull)
        {
            parameterNullable = true;
        }

        var storage = StripReferenceWrapper(storageType);
        var parameter = StripReferenceWrapper(parameterType);
        if (storage is NullableTypeSymbol || parameter is NullableTypeSymbol)
        {
            // What is left is a value-type `Nullable<V>`, a runtime type of its
            // own: both sides must be one.
            if (storage is not NullableTypeSymbol storageValue || parameter is not NullableTypeSymbol parameterValue)
            {
                return false;
            }

            storage = storageValue.UnderlyingType;
            parameter = parameterValue.UnderlyingType;
        }

        if (!IsSameRuntimeType(storage, parameter))
        {
            return false;
        }

        nestedMismatch = HasNestedNullabilityMismatch(storage, parameter);
        return true;
    }

    /// <summary>
    /// Whether <paramref name="storage"/> and <paramref name="parameter"/>, both
    /// already stripped of a top-level reference-nullability wrapper, denote
    /// one runtime type.
    /// </summary>
    /// <param name="storage">The storage type.</param>
    /// <param name="parameter">The parameter type.</param>
    /// <returns><see langword="true"/> when they are one runtime type.</returns>
    private static bool IsSameRuntimeType(TypeSymbol storage, TypeSymbol parameter)
    {
        if (TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(storage, parameter))
        {
            return true;
        }

        // Two representations of one CLR type, such as an imported `int[]`
        // (an ImportedTypeSymbol) and the `[]int32` a G# parameter spells (a
        // SliceTypeSymbol). A composite symbol's CLR type is built from its
        // parts' effective CLR types (`[]int32?` is `Nullable<int32>[]`), so
        // it keeps value-type nullability; only a top-level NullableTypeSymbol
        // relays its underlying type, and the caller has removed that.
        var storageClr = storage.ClrType;
        var parameterClr = parameter.ClrType;
        return storageClr != null
            && parameterClr != null
            && ClrTypeUtilities.AreSame(storageClr, parameterClr);
    }

    /// <summary>
    /// Whether any element or type-argument position of the two types differs
    /// in stated reference nullability, at any depth.
    /// </summary>
    /// <param name="storage">The storage type.</param>
    /// <param name="parameter">The parameter type.</param>
    /// <returns><see langword="true"/> when a nested position differs.</returns>
    private static bool HasNestedNullabilityMismatch(TypeSymbol storage, TypeSymbol parameter)
    {
        var storagePositions = storage.GetElementPositions();
        var parameterPositions = parameter.GetElementPositions();
        if (storagePositions.Length != parameterPositions.Length)
        {
            return false;
        }

        for (var i = 0; i < storagePositions.Length; i++)
        {
            if (PositionDiffers(storagePositions[i], parameterPositions[i]))
            {
                return true;
            }
        }

        return false;
    }

    private static bool PositionDiffers(TypeSymbol storage, TypeSymbol parameter)
    {
        var storageKind = storage.ReferenceNullability;
        var parameterKind = parameter.ReferenceNullability;
        if ((storageKind == ReferenceNullabilityKind.Nullable && parameterKind == ReferenceNullabilityKind.NotNull)
            || (storageKind == ReferenceNullabilityKind.NotNull && parameterKind == ReferenceNullabilityKind.Nullable))
        {
            return true;
        }

        var innerStorage = StripValueWrapper(StripReferenceWrapper(storage));
        var innerParameter = StripValueWrapper(StripReferenceWrapper(parameter));
        return HasNestedNullabilityMismatch(innerStorage, innerParameter);
    }

    /// <summary>
    /// Removes a top-level reference-nullability wrapper — a <c>T?</c> over a
    /// reference type, or a platform <c>T!</c> — leaving a value-type
    /// <c>Nullable&lt;V&gt;</c> in place.
    /// </summary>
    /// <param name="type">The type.</param>
    /// <returns>The type without its top-level reference-nullability wrapper.</returns>
    private static TypeSymbol StripReferenceWrapper(TypeSymbol type)
    {
        if (type is PlatformTypeSymbol platform)
        {
            return platform.UnderlyingType;
        }

        if (type is NullableTypeSymbol nullable && type.ReferenceNullability == ReferenceNullabilityKind.Nullable)
        {
            return nullable.UnderlyingType;
        }

        return type;
    }

    private static TypeSymbol StripValueWrapper(TypeSymbol type)
        => type is NullableTypeSymbol nullable ? nullable.UnderlyingType : type;
}
