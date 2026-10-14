// <copyright file="ByRefStorageMatching.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System

/// Issue #4422: decides whether the storage behind a by-reference argument
/// (`&x` at a `ref`, `out` or `in` parameter of a G#
/// callee) has the parameter's type.
///
/// A by-reference argument passes the storage location itself, so its type
/// must be the parameter type, with no conversion. Reference nullability is
/// the one exception: `[]?int32` and `[]int32`, or
/// `List[string?]` and `List[string]`, are one runtime type, and C#
/// accepts such an argument with only a nullability warning. A value-type
/// `int32?` is `Nullable<int32>`, a different runtime type, and
/// is never accepted for `int32`.
///
/// This replaces (cref:DeclarationBinder.TypeSignaturesEquivalent(TypeSymbol, TypeSymbol))
/// at the by-ref gates. The shared comparer answers a boolean equivalence
/// question for declarations, inference, overload identity, and related
/// signature decisions. This matcher additionally records the direction and
/// nesting of reference-nullability differences for `GS0612`, and
/// normalizes equivalent imported-array and native-slice storage views.
internal shared class ByRefStorageMatching {
    /// Compares the storage type of a by-reference argument with the
    /// parameter type.
    /// @param storageType The type of the storage the argument's address points at.
    /// @param parameterType The (substituted) parameter type.
    /// @param storageNullable Set when the top-level storage type is stated nullable (`T?`) and the
    /// parameter type is stated non-null (`T`): a nil in the storage
    /// reaches the callee as a non-null value.
    /// @param parameterNullable Set when the top-level parameter type is stated nullable and the storage
    /// type is stated non-null: the callee may store nil into storage declared
    /// non-null.
    /// @param nestedMismatch Set when an element or type-argument position differs in stated
    /// nullability. Both views share one object, so values of either
    /// nullability can flow through it in both directions.
    /// @returns `true` when the two types are the same runtime type,
    /// differing at most in reference nullability.
    func AreSameStorageType(
        storageType TypeSymbol,
        parameterType TypeSymbol,
        out storageNullable bool,
        out parameterNullable bool,
        out nestedMismatch bool
    ) bool {
        storageNullable = false
        parameterNullable = false
        nestedMismatch = false
        let storageKind = storageType.ReferenceNullability
        let parameterKind = parameterType.ReferenceNullability
        // ADR-0186: a platform (`T!`) position stated nothing, so it differs
        // from neither `T` nor `T?`; only two stated positions can disagree.
        if storageKind == ReferenceNullabilityKind.Nullable && parameterKind == ReferenceNullabilityKind.NotNull {
            storageNullable = true
        } else if parameterKind == ReferenceNullabilityKind.Nullable &&
            storageKind == ReferenceNullabilityKind.NotNull {
            parameterNullable = true
        }
        var storage = StripReferenceWrapper(storageType)
        var parameter = StripReferenceWrapper(parameterType)
        if storage is NullableTypeSymbol || parameter is NullableTypeSymbol {
            // What is left is a value-type `Nullable<V>`, a runtime type of its
            // own: both sides must be one.
            if storage is not NullableTypeSymbol storageValue || parameter is not NullableTypeSymbol parameterValue {
                return false
            }
            storage = storageValue.UnderlyingType
            parameter = parameterValue.UnderlyingType
        }
        if !IsSameRuntimeType(storage, parameter) {
            return false
        }
        nestedMismatch = HasNestedNullabilityMismatch(storage, parameter)
        return true
    }

    /// Issue #4422: the storage a by-reference argument addresses — the
    /// operand of `&x` or the shared pointee of a conditional
    /// address — when it is known. An unresolved inline `out var` has
    /// the error type and is not known yet.
    /// @param argument The bound argument.
    /// @returns The storage type, or `null`.
    func TryGetStorageType(argument BoundExpression?) TypeSymbol? {
        let storageType = switch argument {
            case address is BoundAddressOfExpression: address.Operand?.Type
            case conditional is BoundConditionalAddressExpression: conditional.PointeeType
            default: default(TypeSymbol?)
        }
        return if storageType == TypeSymbol.Error {
            default(TypeSymbol?)
        } else {
            storageType
        }
    }

    /// Issue #4422: how well a by-reference argument's storage fits a candidate
    /// parameter, for overload ranking. An exact match is an identity; a match
    /// that differs only in reference nullability (a GS0612 warning) ranks
    /// below it, as C#'s betterness prefers the exact `ref string?` over
    /// `ref string` for `string?` storage. A platform (`T!`)
    /// storage prefers the non-null parameter, ADR-0186 §3's tie-break.
    /// @param storageType The storage type.
    /// @param parameterType The (substituted) parameter type.
    /// @returns `null` when the storage does not fit at all;
    /// otherwise `true` for an exact fit.
    func IsExactStorageMatch(storageType TypeSymbol, parameterType TypeSymbol) bool? {
        if !AreSameStorageType(
            storageType,
            parameterType,
            out var storageNullable,
            out var parameterNullable,
            out var nestedMismatch
        ) {
            return nil
        }
        if storageNullable || parameterNullable || nestedMismatch {
            return false
        }
        return !(
            storageType.ReferenceNullability == ReferenceNullabilityKind.Platform &&
                parameterType.ReferenceNullability == ReferenceNullabilityKind.Nullable
        )
    }

    /// Whether [`storage`](paramref) and [`parameter`](paramref), both
    /// already stripped of a top-level reference-nullability wrapper, denote
    /// one runtime type.
    /// @param storage The storage type.
    /// @param parameter The parameter type.
    /// @returns `true` when they are one runtime type.
    private func IsSameRuntimeType(storage TypeSymbol, parameter TypeSymbol) bool {
        if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(storage, parameter) {
            return true
        }
        // Two representations of one CLR type, such as an imported `int[]`
        // (an ImportedTypeSymbol) and the `[]int32` a G# parameter spells (a
        // SliceTypeSymbol). A composite symbol's CLR type is built from its
        // parts' effective CLR types (`[]int32?` is `Nullable<int32>[]`), so
        // it keeps value-type nullability; only a top-level NullableTypeSymbol
        // relays its underlying type, and the caller has removed that.
        let storageClr Type? = storage.ClrType
        let parameterClr Type? = parameter.ClrType
        return storageClr != nil && parameterClr != nil && ClrTypeUtilities.AreSame(storageClr, parameterClr)
    }

    /// Whether any element or type-argument position of the two types differs
    /// in stated reference nullability, at any depth.
    /// @param storage The storage type.
    /// @param parameter The parameter type.
    /// @returns `true` when a nested position differs.
    private func HasNestedNullabilityMismatch(storage TypeSymbol, parameter TypeSymbol) bool {
        let storagePositions = storage.GetElementPositions()
        let parameterPositions = parameter.GetElementPositions()
        if storagePositions.Length != parameterPositions.Length {
            return false
        }
        for var i = 0; i < storagePositions.Length; i++ {
            if PositionDiffers(storagePositions[i], parameterPositions[i]) {
                return true
            }
        }
        return false
    }

    private func PositionDiffers(storage TypeSymbol, parameter TypeSymbol) bool {
        let storageKind = storage.ReferenceNullability
        let parameterKind = parameter.ReferenceNullability
        if (storageKind == ReferenceNullabilityKind.Nullable && parameterKind == ReferenceNullabilityKind.NotNull) ||
            (storageKind == ReferenceNullabilityKind.NotNull && parameterKind == ReferenceNullabilityKind.Nullable) {
            return true
        }
        let innerStorage = StripValueWrapper(StripReferenceWrapper(storage))
        let innerParameter = StripValueWrapper(StripReferenceWrapper(parameter))
        return HasNestedNullabilityMismatch(innerStorage, innerParameter)
    }

    /// Removes a top-level reference-nullability wrapper — a `T?` over a
    /// reference type, or a platform `T!` — leaving a value-type
    /// `Nullable<V>` in place.
    /// @param type The type.
    /// @returns The type without its top-level reference-nullability wrapper.
    private func StripReferenceWrapper(type TypeSymbol) TypeSymbol {
        if type is PlatformTypeSymbol platform {
            return platform.UnderlyingType
        }
        if type is NullableTypeSymbol nullable && type.ReferenceNullability == ReferenceNullabilityKind.Nullable {
            return nullable.UnderlyingType
        }
        return type
    }

    private func StripValueWrapper(type TypeSymbol) TypeSymbol -> if type is NullableTypeSymbol nullable {
        nullable.UnderlyingType
    } else {
        type
    }
}
