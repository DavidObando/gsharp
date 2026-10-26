// <copyright file="NullableLifting.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Diagnostics.CodeAnalysis

/// Bug-overview §6.1 / phased Nullable<T> unification: single seam for
/// every `Nullable<T>` probe and constructor-projection helper
/// that the binder and emitter need. PR N-1 is a pure refactor that gathers
/// the previously scattered helpers in one place; subsequent PRs (N-2/N-3/N-4)
/// plug their fixes into this facade rather than into N separate call sites.
shared class NullableLifting {
    /// Issue #530: returns the effective CLR (cref:Type) to use when
    /// matching [`typeSymbol`](paramref) as a method argument in overload
    /// resolution. For a (cref:NullableTypeSymbol) wrapping a value
    /// type, this returns `Nullable<T>` rather than the underlying
    /// `T`, because the emitter encodes the local as `Nullable<T>`
    /// and the selected overload must accept that type on the evaluation stack.
    /// For all other types the result equals `typeSymbol?.ClrType`.
    /// @param typeSymbol The type symbol to resolve.
    /// @returns The CLR (cref:Type) to use for overload resolution, or `null` if [`typeSymbol`](paramref)
    /// is `null`.
    func GetEffectiveClrType(typeSymbol TypeSymbol?) Type? {
        if typeSymbol is NullableTypeSymbol nullable {
            let innerVt = nullable.UnderlyingType?.ClrType
            if innerVt?.IsValueType == true {
                return typeof(Nullable[_]).MakeGenericType(innerVt!!)
            }
        }
        // Issue #4422: the address of value-type `int32?` storage is a
        // `Nullable<int32>&`. The by-ref symbol's own ClrType is built from its
        // pointee's relayed `int32`, which made `&x` applicable to an imported
        // `ref int` parameter (`Interlocked.Increment`) and emitted unverifiable
        // IL that wrote an int over the Nullable.
        if typeSymbol is ByRefTypeSymbol{PointeeType: NullableTypeSymbol} byRef &&
            GetEffectiveClrType(byRef.PointeeType) is {IsGenericType: true} nullablePointee {
            return nullablePointee.MakeByRefType()
        }
        return typeSymbol?.ClrType
    }

    /// Constructs `Nullable<TUnderlying>` projected onto
    /// [`references`](paramref). Returns `false` when
    /// [`underlying`](paramref) is `null`, when the open
    /// `Nullable<>` is not reachable from the given reference set,
    /// or when projecting [`underlying`](paramref) through the reference
    /// set fails.
    /// @param references The reference resolver used to discover the open `Nullable<>` definition and to
    /// project [`underlying`](paramref) onto.
    /// @param underlying The value-type underlying type.
    /// @param constructed The constructed nullable CLR type, on success.
    /// @returns `true` when construction succeeded.
    func TryConstructNullable(
        references ReferenceResolver,
        underlying Type?,
        @NotNullWhen(true) out constructed Type?
    ) bool {
        constructed = nil
        if underlying == nil {
            return false
        }
        if !references.TryResolveType("System.Nullable`1", requireExternalVisibility: false, out var nullableOpen) ||
            nullableOpen == nil {
            return false
        }
        try {
            let mappedUnderlying = references.MapClrTypeToReferences(underlying) ?? underlying
            constructed = nullableOpen.MakeGenericType(mappedUnderlying)
            return constructed != nil
        } catch {
            constructed = nil
            return false
        }
    }

    /// Issue #530: returns the CLR type to use when [`typeSymbol`](paramref)
    /// appears as a generic type argument (e.g. `Task[int32?]` or
    /// `FromResult[string?]`). For a (cref:NullableTypeSymbol)
    /// wrapping a value type the result is `Nullable<T>`; for a
    /// nullable reference type the result is the underlying reference type
    /// (since CLR has no separate `string?` type).
    /// @param references The reference resolver used to construct
    /// `Nullable<T>` and to project the result onto the reference
    /// load context.
    /// @param typeSymbol The type symbol to resolve.
    /// @returns The CLR type projected onto the reference load context, or `null`
    /// when the symbol has no CLR type.
    func ResolveClrTypeForGenericArg(references ReferenceResolver, typeSymbol TypeSymbol?) Type? {
        if typeSymbol is NullableTypeSymbol nullable {
            let innerVt = nullable.UnderlyingType?.ClrType
            if innerVt?.IsValueType == true && TryConstructNullable(references, innerVt, out var nullableClr) {
                return nullableClr!!
            }
        }
        let clr Type? = typeSymbol?.ClrType
        return if clr != nil {
            references.MapClrTypeToReferences(clr)
        } else {
            default(Type?)
        }
    }

    /// Issue #504: a (cref:NullableTypeSymbol) whose underlying CLR
    /// type is a value type maps to the CLR struct `System.Nullable<T>`
    /// — a distinct CLR value type with its own layout and ctor.
    /// (cref:NullableTypeSymbol) over a reference type, by contrast,
    /// shares the CLR representation of T (the wrapper is a binder-level
    /// annotation; `ldnull` is a valid value for it). Emit-time conversion
    /// logic for value-type `Nullable<T>` needs a
    /// `newobj Nullable<T>::.ctor(T)` for the lift, an
    /// `initobj` for the default value, and `box Nullable<T>`
    /// for object widening — none of which the reference-type path handles.
    /// @param nullable The wrapper to test.
    /// @returns `true` when the underlying type has a CLR value-type representation.
    internal func IsValueTypeNullable(nullable NullableTypeSymbol?) bool {
        if nullable?.UnderlyingType is TupleTypeSymbol {
            return true
        }
        if nullable?.UnderlyingType?.ClrType is {IsValueType: true} {
            return true
        }
        // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter
        // constrained to `struct` is a value-type `Nullable<T>` at the IL
        // level (encoded as `GENERICINST System.Nullable`1<MVAR>`). All
        // emit-side decisions that distinguish value-type Nullable from
        // reference-type Nullable (slot-based default-init, newobj lift,
        // HasValue branching in `??`) must treat the open struct case
        // the same as a closed value type.
        if nullable?.UnderlyingType is TypeParameterSymbol tp && tp.HasValueTypeConstraint {
            return true
        }
        return false
    }

    /// Issue #1572: returns `true` when [`nullable`](paramref)
    /// wraps a <em>user-declared</em> value type emitted in the current
    /// compilation — a value-kind (cref:StructSymbol) (i.e.
    /// `!IsClass`) or an (cref:EnumSymbol). Such underlyings have a
    /// null CLR (cref:Type) during emit, so the
    /// (cref:IsValueTypeNullable) ClrType probe misclassifies them as
    /// reference nullables. Emit and slot-planning code that must close
    /// `System.Nullable`1` over the emitted TypeDef/TypeSpec (rather than a
    /// host `Type`) uses this symbol-aware predicate to detect them. Both
    /// the slot collectors and the corresponding emit arms call it so the two
    /// sides stay in exact agreement.
    /// @param nullable The wrapper to test.
    /// @returns `true` for a user value-type `Nullable<T>`.
    internal func IsUserValueTypeNullable(nullable NullableTypeSymbol?) bool {
        return nullable?.UnderlyingType is EnumSymbol || (nullable?.UnderlyingType is StructSymbol s && !s.IsClass)
    }

    /// Issue #2333: returns `true` when [`nullable`](paramref)
    /// wraps an underlying whose `Nullable<T>::get_Value()` MemberRef
    /// cannot be built from a runtime (cref:Type) (the emit-side
    /// `WellKnownReferences.GetNullableGetValueReference` helper) because
    /// the underlying has no `ClrType` during emit. Three shapes qualify:
    /// - a user-declared value-kind struct or enum (see (cref:IsUserValueTypeNullable));
    /// - an open type parameter constrained to `struct` — its `Nullable<T>` instantiation closes over a
    /// generic-parameter var/mvar signature slot, not a resolvable host `Type`.
    /// - a tuple whose symbolic element annotations prevent a direct `ClrType`, while its runtime
    /// representation remains `System.ValueTuple`.
    /// All shapes route through the emit-side
    /// `ReflectionMetadataEmitter.GetNullableGetValueMemberRefForUserValueType`
    /// helper, which builds the MemberRef symbolically off the
    /// emitted/encoded parent TypeSpec instead. Callers that must pick
    /// between the ClrType-based and symbolic `get_Value` paths
    /// (`EmitUnary`'s `!!` arm, the null-conditional receiver
    /// probe, and `NullableValueTypeUnwrapCollector`'s slot-planning
    /// pass) use this single predicate so all three stay in agreement.
    /// @param nullable The wrapper to test.
    /// @returns `true` when the symbolic `get_Value` path is required.
    internal func RequiresSymbolicNullableGetValue(nullable NullableTypeSymbol?) bool {
        return IsUserValueTypeNullable(nullable) ||
            (nullable?.UnderlyingType is TupleTypeSymbol and {ClrType: nil}) ||
            (
            nullable?.UnderlyingType is ImportedTypeSymbol imported &&
                imported
                .OpenDefinition
                ?.IsValueType == true &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty
        ) ||
            (nullable?.UnderlyingType is TypeParameterSymbol tp && tp.HasValueTypeConstraint)
    }

    /// Issue #1700: unifies (cref:IsValueTypeNullable) (BCL / open
    /// struct-constrained type-parameter underlyings, which carry a runtime
    /// `ClrType`) and (cref:IsUserValueTypeNullable) (same-
    /// compilation user struct/enum underlyings, which do not) into a single
    /// predicate for emit-side code that must treat every value-type
    /// `Nullable<T>` receiver the same way — e.g. the null-
    /// conditional-access receiver probe, which cannot use `brtrue`
    /// directly on a `Nullable<T>` struct value (ilverify
    /// `StackUnexpected`) regardless of which kind of `T` it wraps.
    /// @param nullable The wrapper to test.
    /// @returns `true` for any value-type `Nullable<T>`, BCL or user-declared.
    internal func IsAnyValueTypeNullable(nullable NullableTypeSymbol?) bool {
        return IsValueTypeNullable(nullable) || IsUserValueTypeNullable(nullable)
    }

    /// Returns `true` when [`type`](paramref) is a
    /// constructed `System.Nullable<T>` (i.e. closed-generic over the
    /// open `System.Nullable`1` definition). The open definition itself
    /// and non-generic / unconstructed types return `false`.
    /// @param type The CLR (cref:Type) to probe.
    /// @returns `true` for a constructed `Nullable<T>`.
    internal func IsValueTypeNullableClr(type Type?) bool {
        return GetValueTypeNullableUnderlyingClr(type) != nil
    }

    /// ADR-0193 §3: wraps a value type read from a CLR `Nullable<V>`
    /// as G#'s `V?`. This is value optionality (ADR-0001), which the CLR
    /// signature itself spells, not a reference-nullability decision, so it
    /// does not go through (cref:NullabilityImportRule). The funnel's
    /// walkers call this rather than (cref:NullableTypeSymbol.Get), so
    /// GSA0007's walker clause keeps every <em>reference</em> wrapper they
    /// build on the rule.
    /// @param valueUnderlying The mapped `V` of a CLR `Nullable<V>`.
    /// @returns `V?`.
    internal func WrapValueTypeNullable(valueUnderlying TypeSymbol) TypeSymbol -> NullableTypeSymbol.Get(
        valueUnderlying
    )

    /// Returns the underlying type of a constructed CLR `Nullable<T>`.
    /// Uses (cref:Nullable.GetUnderlyingType(Type)) for runtime types and
    /// a metadata-name fallback for types owned by a
    /// (cref:System.Reflection.MetadataLoadContext).
    /// @param type CLR type to inspect.
    /// @returns The underlying `T`, or `null`.
    internal func GetValueTypeNullableUnderlyingClr(type Type?) Type? {
        if type == nil {
            return nil
        }
        try {
            if Nullable.GetUnderlyingType(type.UnderlyingSystemType) != nil {
                return type.GetGenericArguments()[0]
            }
        } catch (ArgumentException) {
            // MetadataLoadContext types cannot be passed to runtime Nullable APIs.

        }
        if !type.IsGenericType || type.IsGenericTypeDefinition {
            return nil
        }
        try {
            return if string.Equals(
                type.UnderlyingSystemType.GetGenericTypeDefinition().FullName,
                "System.Nullable`1",
                StringComparison.Ordinal
            ) {
                type.GetGenericArguments()[0]
            } else {
                default(Type?)
            }
        } catch (NotSupportedException) {
            // A TypeBuilderInstantiation (a same-compilation type mid-binding)
            // throws here; such a type is never a real Nullable<T> for this
            // probe's purposes anyway (issue #4184).
            return nil
        }
    }
}
