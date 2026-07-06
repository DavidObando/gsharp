// <copyright file="NullableLifting.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Bug-overview §6.1 / phased Nullable&lt;T&gt; unification: single seam for
/// every <c>Nullable&lt;T&gt;</c> probe and constructor-projection helper
/// that the binder and emitter need. PR N-1 is a pure refactor that gathers
/// the previously scattered helpers in one place; subsequent PRs (N-2/N-3/N-4)
/// plug their fixes into this facade rather than into N separate call sites.
/// </summary>
public static class NullableLifting
{
    /// <summary>
    /// Issue #530: returns the effective CLR <see cref="Type"/> to use when
    /// matching <paramref name="typeSymbol"/> as a method argument in overload
    /// resolution. For a <see cref="NullableTypeSymbol"/> wrapping a value
    /// type, this returns <c>Nullable&lt;T&gt;</c> rather than the underlying
    /// <c>T</c>, because the emitter encodes the local as <c>Nullable&lt;T&gt;</c>
    /// and the selected overload must accept that type on the evaluation stack.
    /// For all other types the result equals <c>typeSymbol?.ClrType</c>.
    /// </summary>
    /// <param name="typeSymbol">The type symbol to resolve.</param>
    /// <returns>The CLR <see cref="Type"/> to use for overload resolution, or <see langword="null"/> if <paramref name="typeSymbol"/> is <see langword="null"/>.</returns>
    public static Type GetEffectiveClrType(TypeSymbol typeSymbol)
    {
        if (typeSymbol is NullableTypeSymbol nullable
            && nullable.UnderlyingType?.ClrType is { IsValueType: true } innerVt)
        {
            return typeof(Nullable<>).MakeGenericType(innerVt);
        }

        return typeSymbol?.ClrType;
    }

    /// <summary>
    /// Constructs <c>Nullable&lt;TUnderlying&gt;</c> projected onto
    /// <paramref name="references"/>. Returns <see langword="false"/> when the
    /// open <c>Nullable&lt;&gt;</c> is not reachable from the given reference
    /// set, or when projecting <paramref name="underlying"/> through the
    /// reference set fails.
    /// </summary>
    /// <param name="references">The reference resolver used to discover the open <c>Nullable&lt;&gt;</c> definition and to project <paramref name="underlying"/> onto.</param>
    /// <param name="underlying">The value-type underlying type.</param>
    /// <param name="constructed">The constructed nullable CLR type, on success.</param>
    /// <returns><see langword="true"/> when construction succeeded.</returns>
    public static bool TryConstructNullable(ReferenceResolver references, Type underlying, out Type constructed)
    {
        constructed = null;
        if (underlying == null)
        {
            return false;
        }

        if (!references.TryResolveType("System.Nullable`1", requireExternalVisibility: false, out var nullableOpen) || nullableOpen == null)
        {
            return false;
        }

        try
        {
            var mappedUnderlying = references.MapClrTypeToReferences(underlying) ?? underlying;
            constructed = nullableOpen.MakeGenericType(mappedUnderlying);
            return constructed != null;
        }
        catch
        {
            constructed = null;
            return false;
        }
    }

    /// <summary>
    /// Issue #530: returns the CLR type to use when <paramref name="typeSymbol"/>
    /// appears as a generic type argument (e.g. <c>Task[int32?]</c> or
    /// <c>FromResult[string?]</c>). For a <see cref="NullableTypeSymbol"/>
    /// wrapping a value type the result is <c>Nullable&lt;T&gt;</c>; for a
    /// nullable reference type the result is the underlying reference type
    /// (since CLR has no separate <c>string?</c> type).
    /// </summary>
    /// <param name="references">The reference resolver used to construct
    /// <c>Nullable&lt;T&gt;</c> and to project the result onto the reference
    /// load context.</param>
    /// <param name="typeSymbol">The type symbol to resolve.</param>
    /// <returns>
    /// The CLR type projected onto the reference load context, or <c>null</c>
    /// when the symbol has no CLR type.
    /// </returns>
    public static Type ResolveClrTypeForGenericArg(ReferenceResolver references, TypeSymbol typeSymbol)
    {
        if (typeSymbol is NullableTypeSymbol nullable
            && nullable.UnderlyingType?.ClrType is { IsValueType: true } innerVt
            && TryConstructNullable(references, innerVt, out var nullableClr))
        {
            return nullableClr;
        }

        var clr = typeSymbol?.ClrType;
        return clr != null ? references.MapClrTypeToReferences(clr) : null;
    }

    /// <summary>
    /// Issue #504: a <see cref="NullableTypeSymbol"/> whose underlying CLR
    /// type is a value type maps to the CLR struct <c>System.Nullable&lt;T&gt;</c>
    /// — a distinct CLR value type with its own layout and ctor.
    /// <see cref="NullableTypeSymbol"/> over a reference type, by contrast,
    /// shares the CLR representation of T (the wrapper is a binder-level
    /// annotation; <c>ldnull</c> is a valid value for it). Emit-time conversion
    /// logic for value-type <c>Nullable&lt;T&gt;</c> needs a
    /// <c>newobj Nullable&lt;T&gt;::.ctor(T)</c> for the lift, an
    /// <c>initobj</c> for the default value, and <c>box Nullable&lt;T&gt;</c>
    /// for object widening — none of which the reference-type path handles.
    /// </summary>
    /// <param name="nullable">The wrapper to test.</param>
    /// <returns><see langword="true"/> when the underlying type is a CLR value type.</returns>
    internal static bool IsValueTypeNullable(NullableTypeSymbol nullable)
    {
        if (nullable?.UnderlyingType?.ClrType is { IsValueType: true })
        {
            return true;
        }

        // Issue #814 / ADR-0084 §L5: `T?` over an open type parameter
        // constrained to `struct` is a value-type `Nullable<T>` at the IL
        // level (encoded as `GENERICINST System.Nullable`1<MVAR>`). All
        // emit-side decisions that distinguish value-type Nullable from
        // reference-type Nullable (slot-based default-init, newobj lift,
        // HasValue branching in `??`) must treat the open struct case
        // the same as a closed value type.
        if (nullable?.UnderlyingType is TypeParameterSymbol tp && tp.HasValueTypeConstraint)
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1572: returns <see langword="true"/> when <paramref name="nullable"/>
    /// wraps a <em>user-declared</em> value type emitted in the current
    /// compilation — a value-kind <see cref="StructSymbol"/> (i.e.
    /// <c>!IsClass</c>) or an <see cref="EnumSymbol"/>. Such underlyings have a
    /// null CLR <see cref="Type"/> during emit, so the
    /// <see cref="IsValueTypeNullable"/> ClrType probe misclassifies them as
    /// reference nullables. Emit and slot-planning code that must close
    /// <c>System.Nullable`1</c> over the emitted TypeDef/TypeSpec (rather than a
    /// host <c>Type</c>) uses this symbol-aware predicate to detect them. Both
    /// the slot collectors and the corresponding emit arms call it so the two
    /// sides stay in exact agreement.
    /// </summary>
    /// <param name="nullable">The wrapper to test.</param>
    /// <returns><see langword="true"/> for a user value-type <c>Nullable&lt;T&gt;</c>.</returns>
    internal static bool IsUserValueTypeNullable(NullableTypeSymbol nullable)
    {
        return nullable?.UnderlyingType is EnumSymbol
            || (nullable?.UnderlyingType is StructSymbol s && !s.IsClass);
    }

    /// <summary>
    /// Issue #1700: unifies <see cref="IsValueTypeNullable"/> (BCL / open
    /// struct-constrained type-parameter underlyings, which carry a runtime
    /// <c>ClrType</c>) and <see cref="IsUserValueTypeNullable"/> (same-
    /// compilation user struct/enum underlyings, which do not) into a single
    /// predicate for emit-side code that must treat every value-type
    /// <c>Nullable&lt;T&gt;</c> receiver the same way — e.g. the null-
    /// conditional-access receiver probe, which cannot use <c>brtrue</c>
    /// directly on a <c>Nullable&lt;T&gt;</c> struct value (ilverify
    /// <c>StackUnexpected</c>) regardless of which kind of <c>T</c> it wraps.
    /// </summary>
    /// <param name="nullable">The wrapper to test.</param>
    /// <returns><see langword="true"/> for any value-type <c>Nullable&lt;T&gt;</c>, BCL or user-declared.</returns>
    internal static bool IsAnyValueTypeNullable(NullableTypeSymbol nullable)
    {
        return IsValueTypeNullable(nullable) || IsUserValueTypeNullable(nullable);
    }

    /// <summary>
    /// Returns <see langword="true"/> when <paramref name="type"/> is a
    /// constructed <c>System.Nullable&lt;T&gt;</c> (i.e. closed-generic over the
    /// open <c>System.Nullable`1</c> definition). The open definition itself
    /// and non-generic / unconstructed types return <see langword="false"/>.
    /// </summary>
    /// <param name="type">The CLR <see cref="Type"/> to probe.</param>
    /// <returns><see langword="true"/> for a constructed <c>Nullable&lt;T&gt;</c>.</returns>
    internal static bool IsValueTypeNullableClr(Type type)
    {
        return type != null
            && type.IsGenericType
            && !type.IsGenericTypeDefinition
            && string.Equals(type.GetGenericTypeDefinition().FullName, "System.Nullable`1", StringComparison.Ordinal);
    }
}
