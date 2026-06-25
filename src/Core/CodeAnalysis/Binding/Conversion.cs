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

        // Issue #1018: the bottom (`never`) type of a throw-expression is
        // implicitly convertible to ANY target type — a throw never yields a
        // value, so it satisfies any target without a runtime conversion.
        if (from == TypeSymbol.Never)
        {
            return Conversion.Implicit;
        }

        // ADR-0122 / issue #1014: unmanaged pointer conversions.
        // * pointer -> pointer: explicit reinterpret (e.g. `(byte*)p`).
        // * pointer <-> nint/nuint: explicit round-trip (IntPtr.ToPointer()).
        // * nil -> pointer: implicit null pointer.
        // These share the native-int CLR representation, so emit is a no-op
        // (or `conv.i` for narrower integer sources).
        if (from is PointerTypeSymbol || to is PointerTypeSymbol)
        {
            if (from == TypeSymbol.Null && to is PointerTypeSymbol)
            {
                return Conversion.Implicit;
            }

            if (from is PointerTypeSymbol && to is PointerTypeSymbol)
            {
                return Conversion.Explicit;
            }

            var nativeIntPartner = to is PointerTypeSymbol ? from : to;
            if (nativeIntPartner == TypeSymbol.NInt || nativeIntPartner == TypeSymbol.NUInt
                || nativeIntPartner == TypeSymbol.Int32 || nativeIntPartner == TypeSymbol.UInt32
                || nativeIntPartner == TypeSymbol.Int64 || nativeIntPartner == TypeSymbol.UInt64
                || TypeSymbol.IsLegalPointeeType(nativeIntPartner))
            {
                return Conversion.Explicit;
            }

            return Conversion.None;
        }

        // ADR-0122 §9 / issue #1035: function-pointer conversions.
        // * fnptr -> fnptr: explicit reinterpret.
        // * fnptr <-> nint/nuint/IntPtr/integer: explicit round-trip (an
        //   unmanaged function pointer is just an address-sized integer).
        // * nil -> fnptr: implicit null pointer.
        if (from is FunctionPointerTypeSymbol || to is FunctionPointerTypeSymbol)
        {
            if (from == TypeSymbol.Null && to is FunctionPointerTypeSymbol)
            {
                return Conversion.Implicit;
            }

            if (from is FunctionPointerTypeSymbol && to is FunctionPointerTypeSymbol)
            {
                return Conversion.Explicit;
            }

            var fpPartner = to is FunctionPointerTypeSymbol ? from : to;
            if (fpPartner == TypeSymbol.NInt || fpPartner == TypeSymbol.NUInt
                || fpPartner == TypeSymbol.Int32 || fpPartner == TypeSymbol.UInt32
                || fpPartner == TypeSymbol.Int64 || fpPartner == TypeSymbol.UInt64
                || fpPartner is PointerTypeSymbol)
            {
                return Conversion.Explicit;
            }

            return Conversion.None;
        }

        // Issue #813: a G# `TupleTypeSymbol` and an imported CLR
        // `System.ValueTuple<…>` instantiation denote the same type when
        // their closed CLR backings agree. The former is produced by tuple
        // literals (`yield (idx, v)`) and tuple type syntax; the latter
        // appears when a fully-closed tuple element is recovered from a
        // generic signature like `IEnumerable[(int32, string)]` whose
        // element type round-trips through `TypeSymbol.FromClrType`. Treat
        // them as identity so iterators returning tuple element types
        // accept tuple literals.
        if (IsTupleClrEquivalent(from, to))
        {
            return Conversion.Identity;
        }

        // #313: two erased generics constructed over the same open definition
        // with structurally-equivalent symbolic arguments (e.g. the `List[T]`
        // parameter type and the `List[T]` declared return type) are distinct
        // symbol instances but denote the same type. Treat them as identity so
        // `return items` inside a generic function binds.
        // Issue #1088 extends this to the same-compilation user-type-argument
        // case (e.g. `Channel[BufferEntry]`), where one side's `ClrType` erases
        // to `Channel`1[object]` (or is null entirely) while both carry the
        // same symbolic argument. Comparing the SYMBOLIC type arguments — rather
        // than the erased `ClrType` — lets `let ch Channel[BufferEntry] = ...`
        // bind even though `BufferEntry` has a null `ClrType` during binding.
        if (from is ImportedTypeSymbol fromGeneric
            && to is ImportedTypeSymbol toGeneric
            && fromGeneric.OpenDefinition != null
            && toGeneric.OpenDefinition != null
            && (fromGeneric.HasSubstitutableTypeArgument || toGeneric.HasSubstitutableTypeArgument)
            && AreConstructedGenericsIdentical(fromGeneric, toGeneric))
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

            // Issue #1121: a non-nullable T is implicitly convertible to U?
            // whenever T is implicitly convertible to its underlying U. This
            // combines a reference upcast (to a base class or an implemented
            // interface of T) with nullable wrapping into a single implicit
            // conversion — a non-null reference is always a valid U?. For a
            // reference-type underlying U the nullable wrap is a representation
            // no-op, so we defer to the full implicit-conversion classification
            // of `T → U` (identity, reference/upcast, interface implementation,
            // boxing-to-object). Restricted to reference-like underlying targets
            // so numeric nullable lifting (e.g. int32 → int64?) is unaffected.
            if (IsReferenceLikeTarget(toNullable.UnderlyingType))
            {
                var underlyingConversion = Classify(from, toNullable.UnderlyingType);
                if (underlyingConversion.Exists && underlyingConversion.IsImplicit)
                {
                    return Conversion.Implicit;
                }
            }
        }

        // Phase 3.C.2: nil literal is never assignable to a non-nullable type.
        if (from == TypeSymbol.Null && !(to is NullableTypeSymbol))
        {
            return Conversion.None;
        }

        // ADR-0102 follow-up / issue #818: two anonymous function types that
        // share parameter types and return type but differ only in the
        // per-parameter variadic flag tuple convert implicitly. The variadic
        // flag is a call-site directive (pack / pass-through) — it does not
        // change the parameter storage shape or the underlying CLR delegate
        // erasure, so a `(int32, ...string) -> int32` value can flow into a
        // `(int32, []string) -> int32` slot and vice versa. Identity (i.e.
        // exact same FunctionTypeSymbol cache instance) was already handled
        // by the early reference-equality short circuit at the top.
        //
        // Issue #1150: also allow the conversion when the parameter types match
        // but the source's numeric return type implicitly, losslessly widens to
        // the target's return type (e.g. `(int32) -> uint16` flowing into a
        // `(int32) -> int64` slot) — mirroring C#'s implicit numeric conversion
        // of a lambda body to an expected delegate return type.
        if (from is FunctionTypeSymbol fnFrom && to is FunctionTypeSymbol fnTo
            && fnFrom.Arity == fnTo.Arity
            && (fnFrom.ReturnType == fnTo.ReturnType || ReturnTypeWidens(fnFrom.ReturnType, fnTo.ReturnType)))
        {
            var sameShape = true;
            for (var i = 0; i < fnFrom.Arity; i++)
            {
                if (fnFrom.ParameterTypes[i] != fnTo.ParameterTypes[i])
                {
                    sameShape = false;
                    break;
                }
            }

            if (sameShape)
            {
                return Conversion.Implicit;
            }
        }

        // Issue #295: a GSharp function value (a `func` literal or any
        // function-typed value) implicitly converts to ANY compatible CLR
        // delegate type — one deriving from System.MulticastDelegate whose
        // `Invoke` signature is assignment-compatible. This lifts the
        // materialization that previously only happened in argument position
        // into a general rule, so assignment, return, and cast positions all
        // accept func → delegate conversions (Action/Func/Predicate and named
        // delegate types alike).
        if (from is FunctionTypeSymbol fnSource && to?.ClrType != null
            && IsFunctionToDelegateConvertible(fnSource, to.ClrType))
        {
            return Conversion.Implicit;
        }

        // ADR-0059 / issue #255: same rule for user-declared named delegate
        // types. They have no ClrType during binding, so the func→delegate
        // path above does not fire — classify the conversion structurally
        // against the delegate's parameter/return signature instead.
        if (from is FunctionTypeSymbol fnSource2 && to is DelegateTypeSymbol toDelegate
            && IsFunctionStructurallyAssignable(fnSource2, toDelegate))
        {
            return Conversion.Implicit;
        }

        // ADR-0059: a named delegate VALUE (variable typed as a
        // DelegateTypeSymbol) is structurally a delegate; widening to
        // System.Delegate / System.MulticastDelegate follows the existing
        // rule and is handled below. Conversions BETWEEN two distinct
        // DelegateTypeSymbol instances are explicitly *not* implicit, per
        // CLR rules — the user must round-trip through a func value.

        // Issue #323: any delegate-typed value widens implicitly to
        // System.Delegate (and System.MulticastDelegate), since every CLR
        // delegate derives from those base types. This covers both a GSharp
        // `func` literal (FunctionTypeSymbol, which materializes as a delegate
        // instance) and a named/generic CLR delegate value such as
        // `Func[string]`. At the IL level this is a plain reference upcast,
        // so EMIT needs no conversion opcode.
        if (to?.ClrType != null && IsSystemDelegateBaseType(to.ClrType))
        {
            if (from is FunctionTypeSymbol)
            {
                return Conversion.Implicit;
            }

            if (from?.ClrType != null && ClrTypeUtilities.IsDelegateType(from.ClrType))
            {
                return Conversion.Implicit;
            }

            if (from is DelegateTypeSymbol)
            {
                return Conversion.Implicit;
            }
        }

        // Issue #421 P2-5: user-defined and imported enums convert to/from
        // their underlying numeric primitive, and one enum converts to
        // another. Mirrors C# §10.2.4: every enum⇄numeric direction is an
        // explicit conversion (even enum→its own underlying), since enum
        // identity is intentionally distinct from the integral identity.
        if (TryClassifyEnumConversion(from, to, out var enumConversion))
        {
            return enumConversion;
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
        if (to?.ClrType.IsSameAs(typeof(object)) == true && from?.ClrType != null)
        {
            return Conversion.Implicit;
        }

        // Boxing conversion for user value types to System.Object.
        if (from is StructSymbol fromStruct && !fromStruct.IsClass && to?.ClrType.IsSameAs(typeof(object)) == true)
        {
            return Conversion.Implicit;
        }

        // ADR-0045 explicit unbox: `(T)objectValue` for any value-type T.
        if (from?.ClrType.IsSameAs(typeof(object)) == true && to?.ClrType != null && to.ClrType.IsValueType)
        {
            return Conversion.Explicit;
        }

        // Issue #421 P2-5: an interface-typed reference holding a boxed
        // value type unboxes back to that value type via an explicit cast
        // (`MyStruct(iface)`). On the CLR this lowers to `unbox.any`. We
        // accept either a user-declared interface (InterfaceSymbol, whose
        // own ClrType is null) or an imported CLR interface (e.g.
        // System.IComparable). Mirrors C# §10.3.5.
        if (IsInterfaceLikeType(from) && to?.ClrType != null && to.ClrType.IsValueType)
        {
            return Conversion.Explicit;
        }

        // Issue #421 P2-5: a value-typed expression implicitly boxes to any
        // interface it implements. The IL is a single `box <T>` followed by
        // a reference-level interface upcast (which is a no-op since the
        // boxed object's type implements the interface). User-declared
        // value structs reach this path once they participate in the
        // interface relation; imported value types (e.g. `int32`
        // implementing `System.IComparable`) use the CLR's
        // `IsAssignableFrom` check.
        if (IsValueTypeLikeFrom(from) && IsInterfaceLikeType(to)
            && IsValueTypeAssignableToInterface(from, to))
        {
            return Conversion.Implicit;
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

            // Issue #525: a G# class implicitly upcasts to any imported CLR
            // interface that appears in its base-type clause (or any base
            // class's base-type clause). The G# class has no ClrType during
            // binding, so the general #521 rule below cannot fire — match
            // structurally against `ImplementedClrInterfaces` and use the
            // CLR's IsAssignableFrom to cover interface inheritance from the
            // imported side (e.g. implementing `IList<T>` also satisfies
            // `IEnumerable<T>`).
            if (to?.ClrType != null && to.ClrType.IsInterface)
            {
                for (var c = fromClass; c != null; c = c.BaseClass)
                {
                    foreach (var iface in c.ImplementedClrInterfaces)
                    {
                        var ifaceClr = iface?.ClrType;
                        if (ifaceClr == null)
                        {
                            continue;
                        }

                        if (ifaceClr == to.ClrType || to.ClrType.IsAssignableFrom(ifaceClr))
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

        // Issue #528: a G# slice `[]T` is backed by a CLR `T[]` at runtime
        // (`SliceTypeSymbol.ClrType` is built via `MakeArrayType()` on the
        // element's `ClrType`). The reverse direction (`T[] → []T`) is
        // already classified above; this branch documents and enforces the
        // forward direction (`[]T → T[]`) explicitly so it survives any
        // future refactor of the generic #521 reference upcast below.
        // Element-type identity is required (matched by CLR full name to
        // bridge live ↔ MetadataLoadContext types), preserving slice
        // invariance: `[]string` does NOT convert to `object[]` even though
        // the CLR allows array reference covariance, because G# slices are
        // invariant in their element type. The IL is a no-op since the
        // runtime representation is identical.
        if (from is SliceTypeSymbol sliceSrc
            && to?.ClrType != null && to.ClrType.IsArray && to.ClrType.GetArrayRank() == 1
            && sliceSrc.ElementType?.ClrType != null
            && to.ClrType.GetElementType() is Type targetElement
            && string.Equals(targetElement.FullName, sliceSrc.ElementType.ClrType.FullName, StringComparison.Ordinal))
        {
            return Conversion.Implicit;
        }

        // Slice-to-interface: a G# slice `[]T` is backed by a CLR `T[]`
        // at runtime. Extend to every interface that `T[]` implements
        // (IEnumerable<T>, IReadOnlyList<T>, IList<T>, non-generic
        // IEnumerable/ICollection/IList, ICloneable, etc.) using the
        // cross-context-safe `ImplementsInterfaceByName` walk (#570/#610).
        //
        // G# slices are invariant: `[]string` does NOT convert to
        // `IEnumerable<object>` despite CLR array covariance.
        // `ImplementsInterfaceByName` matches generic arguments by name,
        // enforcing invariance. This block also serves as the invariance
        // guard: slices that do NOT match are rejected here, preventing
        // the general #521 arm below (whose same-context fast path would
        // accept covariant matches via `IsAssignableFrom`) from firing.
        if (from is SliceTypeSymbol sliceForIface && to?.ClrType != null && to.ClrType.IsInterface)
        {
            if (sliceForIface.ClrType != null
                && SliceImplementsInterface(sliceForIface, to))
            {
                return Conversion.Implicit;
            }

            return Conversion.None;
        }

        // Issue #521: standard CLR identity / reference upcast — a
        // reference-typed expression of CLR type `from` widens implicitly
        // to any base class or implemented interface `to`. The CLR
        // satisfies the contract at the reference level (no IL op
        // required), so the emitter treats this as a no-op. Restricted to
        // genuine reference types on both sides to avoid colliding with
        // the boxing / unboxing / value-type-to-interface rules above.
        if (from?.ClrType != null && to?.ClrType != null
            && !from.ClrType.IsValueType && !to.ClrType.IsValueType
            && !from.ClrType.IsPointer && !to.ClrType.IsPointer
            && !from.ClrType.IsByRef && !to.ClrType.IsByRef
            && ClrTypeUtilities.IsAssignableByName(to.ClrType, from.ClrType))
        {
            return Conversion.Implicit;
        }

        return Conversion.None;
    }

    /// <summary>
    /// Issue #1088: determines whether two constructed generic
    /// <see cref="ImportedTypeSymbol"/> instances denote the same closed type
    /// by comparing their open definitions and SYMBOLIC type arguments, rather
    /// than their (possibly erased) <see cref="TypeSymbol.ClrType"/>. A
    /// same-compilation user type used as a CLR generic argument has a
    /// <see langword="null"/> <c>ClrType</c> and erases to <c>object</c> on the
    /// closed shape, so a purely CLR-based comparison spuriously fails for
    /// otherwise identical instantiations (e.g. the declared variable type
    /// <c>Channel[BufferEntry]</c> vs. a factory method's return type).
    /// </summary>
    private static bool AreConstructedGenericsIdentical(ImportedTypeSymbol from, ImportedTypeSymbol to)
    {
        if (!ClrTypeUtilities.IsSameAs(from.OpenDefinition, to.OpenDefinition))
        {
            return false;
        }

        if (from.TypeArguments.IsDefaultOrEmpty || to.TypeArguments.IsDefaultOrEmpty
            || from.TypeArguments.Length != to.TypeArguments.Length)
        {
            return false;
        }

        for (var i = 0; i < from.TypeArguments.Length; i++)
        {
            if (!AreTypeArgumentsEquivalent(from.TypeArguments[i], to.TypeArguments[i]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1088: compares two symbolic generic type arguments for identity,
    /// recovering same-compilation user types whose <see cref="TypeSymbol.ClrType"/>
    /// has erased to <c>object</c> (or is <see langword="null"/>). Same-compilation
    /// symbols are reference-equal; distinct user types differ by reference / name
    /// so genuine negative conversions (e.g. <c>Channel[A]</c> → <c>Channel[B]</c>)
    /// still report GS0155.
    /// </summary>
    private static bool AreTypeArgumentsEquivalent(TypeSymbol a, TypeSymbol b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a is null || b is null)
        {
            return false;
        }

        // Nested constructed generics (e.g. List[List[MyGs]]) compare structurally.
        if (a is ImportedTypeSymbol nestedA && b is ImportedTypeSymbol nestedB
            && nestedA.OpenDefinition != null && nestedB.OpenDefinition != null)
        {
            return AreConstructedGenericsIdentical(nestedA, nestedB);
        }

        // Both arguments resolve to a real CLR type: compare those by name.
        if (a.ClrType != null && b.ClrType != null)
        {
            return ClrTypeUtilities.AreSame(a.ClrType, b.ClrType);
        }

        // Both arguments are same-compilation user types with a null ClrType:
        // compare by symbol kind and name so distinct user types stay distinct.
        if (a.ClrType == null && b.ClrType == null)
        {
            return a.GetType() == b.GetType()
                && string.Equals(a.Name, b.Name, StringComparison.Ordinal);
        }

        return false;
    }

    /// <summary>
    /// Determines whether a GSharp function type is convertible to a CLR
    /// delegate type by matching parameter arity / assignability and the
    /// return type. Uses metadata-safe (name-based) checks so it works for
    /// delegate types loaded through a MetadataLoadContext.
    /// </summary>
    private static bool IsFunctionToDelegateConvertible(FunctionTypeSymbol fn, Type delegateType)
    {
        if (!ClrTypeUtilities.IsDelegateType(delegateType))
        {
            return false;
        }

        // Issue #1100: a constructed generic delegate closed over a
        // same-compilation user type (e.g. `Action[Entry]`) surfaces as a
        // `System.Reflection.Emit.TypeBuilderInstantiation` whose
        // `GetMethod("Invoke")` throws `NotSupportedException` ("TypeBuilder
        // generic instantiation does not support resolving members"). Recover
        // the `Invoke` signature from the open generic definition and
        // substitute the type arguments by position so convertibility is
        // decided without resolving a member directly off the instantiation.
        if (!TryGetDelegateInvokeSignature(delegateType, out var invokeParamTypes, out var invokeReturnType))
        {
            return false;
        }

        if (invokeParamTypes.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < invokeParamTypes.Length; i++)
        {
            var fnParamClr = fn.ParameterTypes[i]?.ClrType;
            if (fnParamClr == null || !ClrTypeUtilities.IsAssignableByName(invokeParamTypes[i], fnParamClr))
            {
                return false;
            }
        }

        var invokeReturnIsVoid = invokeReturnType == null
            || string.Equals(invokeReturnType.FullName, "System.Void", StringComparison.Ordinal);
        if (fn.ReturnType == TypeSymbol.Void || fn.ReturnType == null)
        {
            return invokeReturnIsVoid;
        }

        if (invokeReturnIsVoid)
        {
            return false;
        }

        var fnReturnClr = fn.ReturnType.ClrType;
        if (fnReturnClr == null)
        {
            return false;
        }

        // Identity / reference-assignable return (covers exact match and
        // reference covariance).
        if (ClrTypeUtilities.IsAssignableByName(invokeReturnType, fnReturnClr))
        {
            return true;
        }

        // Issue #1150: the function's numeric return type implicitly, losslessly
        // widens to the delegate's numeric return type (e.g. a `uint16`-returning
        // lambda flowing into a `Func<int32,int64>` parameter). Mirrors C#'s
        // implicit numeric conversion of a lambda body to the expected delegate
        // return type. Consulted by CLR full name so it is safe across reflection
        // contexts. Narrowing and signed/unsigned same-width mismatches are not
        // accepted here; they still require an explicit cast.
        return WidensNumerically(fnReturnClr, invokeReturnType);
    }

    /// <summary>
    /// Issue #1100: resolves a delegate type's <c>Invoke</c> parameter and
    /// return types without resolving a member directly off a
    /// <c>System.Reflection.Emit.TypeBuilderInstantiation</c>. A
    /// constructed generic delegate closed over a same-compilation user type
    /// (whose CLR backing is an in-flight emit <c>TypeBuilder</c>) cannot serve
    /// <see cref="Type.GetMethod(string)"/> — it throws
    /// <see cref="NotSupportedException"/>. In that case the <c>Invoke</c>
    /// signature is recovered from the open generic definition and each
    /// generic parameter is substituted by position with the constructed type's
    /// actual type argument. Returns <see langword="false"/> when no usable
    /// <c>Invoke</c> can be resolved.
    /// </summary>
    private static bool TryGetDelegateInvokeSignature(Type delegateType, out Type[] parameterTypes, out Type returnType)
    {
        parameterTypes = Array.Empty<Type>();
        returnType = null;

        try
        {
            var invoke = delegateType.GetMethod("Invoke");
            if (invoke == null)
            {
                return false;
            }

            var parms = invoke.GetParameters();
            parameterTypes = new Type[parms.Length];
            for (var i = 0; i < parms.Length; i++)
            {
                parameterTypes[i] = parms[i].ParameterType;
            }

            returnType = invoke.ReturnType;
            return true;
        }
        catch (NotSupportedException)
        {
            // delegateType is a TypeBuilderInstantiation; fall through to the
            // open-definition resolution below.
        }

        if (!delegateType.IsGenericType || delegateType.IsGenericTypeDefinition)
        {
            return false;
        }

        Type definition;
        Type[] typeArguments;
        try
        {
            definition = delegateType.GetGenericTypeDefinition();
            typeArguments = delegateType.GetGenericArguments();
        }
        catch (NotSupportedException)
        {
            return false;
        }

        var openInvoke = definition.GetMethod("Invoke");
        if (openInvoke == null)
        {
            return false;
        }

        Type Substitute(Type t)
        {
            if (t != null && t.IsGenericParameter)
            {
                var pos = t.GenericParameterPosition;
                if ((uint)pos < (uint)typeArguments.Length)
                {
                    return typeArguments[pos];
                }
            }

            return t;
        }

        var openParms = openInvoke.GetParameters();
        parameterTypes = new Type[openParms.Length];
        for (var i = 0; i < openParms.Length; i++)
        {
            parameterTypes[i] = Substitute(openParms[i].ParameterType);
        }

        returnType = Substitute(openInvoke.ReturnType);
        return true;
    }

    /// <summary>
    /// Determines whether a CLR type is the System.Delegate or
    /// System.MulticastDelegate base type (the common bases of every delegate),
    /// using name-based checks so it works under a MetadataLoadContext.
    /// </summary>
    private static bool IsSystemDelegateBaseType(Type type)
    {
        var fullName = type.FullName;
        return string.Equals(fullName, "System.Delegate", StringComparison.Ordinal)
            || string.Equals(fullName, "System.MulticastDelegate", StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0059 / issue #255: structural compatibility check between a
    /// G# function-typed value and a user-declared named delegate
    /// (<see cref="DelegateTypeSymbol"/>). Used in lieu of the CLR-Type-based
    /// <see cref="IsFunctionToDelegateConvertible"/> because the delegate has
    /// no <c>ClrType</c> during binding — its TypeDef is materialized at emit.
    /// </summary>
    private static bool IsFunctionStructurallyAssignable(FunctionTypeSymbol fn, DelegateTypeSymbol target)
    {
        var parameters = target.Parameters;
        if (parameters.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < parameters.Length; i++)
        {
            var fromType = fn.ParameterTypes[i];
            var toType = parameters[i].Type;
            if (fromType == null || toType == null)
            {
                return false;
            }

            // Parameter types are contravariant in C#; G# v1 mirrors the
            // existing CLR-typed func→delegate rule, which is name-based
            // assignability — i.e., identity or an implicit conversion.
            var conv = Classify(fromType, toType);
            if (!conv.Exists || !conv.IsImplicit)
            {
                return false;
            }
        }

        var fnReturn = fn.ReturnType ?? TypeSymbol.Void;
        var targetReturn = target.ReturnType ?? TypeSymbol.Void;
        if (fnReturn == TypeSymbol.Void)
        {
            return targetReturn == TypeSymbol.Void;
        }

        if (targetReturn == TypeSymbol.Void)
        {
            return false;
        }

        var retConv = Classify(fnReturn, targetReturn);
        return retConv.Exists && retConv.IsImplicit;
    }

    // Issue #421 P2-5: enum⇄numeric and enum⇄enum conversions. Both
    // directions are explicit per C# §10.3.3 / §10.3.4 — the binder must
    // permit them so the cast syntax (`int32(myEnum)`) reaches the emitter,
    // which then routes them through the underlying numeric primitive.
    private static bool TryClassifyEnumConversion(TypeSymbol from, TypeSymbol to, out Conversion conversion)
    {
        var fromIsEnum = IsEnumLikeType(from);
        var toIsEnum = IsEnumLikeType(to);

        if (!fromIsEnum && !toIsEnum)
        {
            conversion = Conversion.None;
            return false;
        }

        // enum → enum (any pair, including the same enum). Identity already
        // returned above, so this only fires for distinct enum types.
        if (fromIsEnum && toIsEnum)
        {
            conversion = Conversion.Explicit;
            return true;
        }

        // enum → numeric primitive.
        if (fromIsEnum && to?.ClrType?.FullName is string toName && NumericClrFullNames.Contains(toName))
        {
            conversion = Conversion.Explicit;
            return true;
        }

        // numeric primitive → enum.
        if (toIsEnum && from?.ClrType?.FullName is string fromName && NumericClrFullNames.Contains(fromName))
        {
            conversion = Conversion.Explicit;
            return true;
        }

        conversion = Conversion.None;
        return false;
    }

    /// <summary>
    /// Issue #1150: determines whether the CLR type <paramref name="fromClr"/>
    /// implicitly, losslessly widens to the CLR type <paramref name="toClr"/>
    /// per the standard numeric-widening lattice (e.g. <c>uint16</c> →
    /// <c>int64</c>). Compared by <see cref="Type.FullName"/> so it is safe
    /// across reflection contexts. Narrowing and signed/unsigned same-width
    /// mismatches return <see langword="false"/>.
    /// </summary>
    private static bool WidensNumerically(Type fromClr, Type toClr)
    {
        return fromClr?.FullName is { } fromName
            && toClr?.FullName is { } toName
            && NumericWideningTargets.TryGetValue(fromName, out var targets)
            && targets.Contains(toName);
    }

    /// <summary>
    /// Issue #1150: determines whether <paramref name="fromReturn"/> implicitly,
    /// losslessly widens to <paramref name="toReturn"/> per the numeric-widening
    /// lattice. Used for the function-type → function-type return-type
    /// relaxation. Both types must be non-void numeric CLR primitives.
    /// </summary>
    private static bool ReturnTypeWidens(TypeSymbol fromReturn, TypeSymbol toReturn)
    {
        if (fromReturn == null || toReturn == null
            || fromReturn == TypeSymbol.Void || toReturn == TypeSymbol.Void)
        {
            return false;
        }

        return WidensNumerically(fromReturn.ClrType, toReturn.ClrType);
    }

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Issue #1100: a constructed generic delegate closed over a
        // same-compilation user type (whose CLR backing is an in-flight emit
        // TypeBuilder) surfaces as a
        // System.Reflection.Emit.TypeBuilderInstantiation. Its reflection
        // predicates throw NotSupportedException ("TypeBuilder generic
        // instantiation does not support resolving members") — IsEnum probes the
        // base-type chain via IsSubclassOf, which is one of the unsupported
        // operations. Such a delegate type is never an enum, so treat a throw as
        // a definite "not enum-like".
        try
        {
            return clr.IsEnum;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    private static bool IsReferenceLikeTarget(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        if (type is StructSymbol { IsClass: true })
        {
            return true;
        }

        // Imported / CLR-backed types are reference-like when the CLR backing
        // is a class or interface (not a value type, pointer, or by-ref). User
        // value structs carry a null ClrType during binding and fall through.
        if (type?.ClrType is { } clrBacking)
        {
            return !clrBacking.IsValueType && !clrBacking.IsPointer && !clrBacking.IsByRef;
        }

        return false;
    }

    private static bool IsInterfaceLikeType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Issue #1100: as with IsEnumLikeType, querying IsInterface on a
        // TypeBuilderInstantiation throws NotSupportedException. A constructed
        // generic delegate is never an interface.
        try
        {
            return clr.IsInterface;
        }
        catch (NotSupportedException)
        {
            return false;
        }
    }

    private static bool IsValueTypeLikeFrom(TypeSymbol type)
    {
        // User structs (non-class StructSymbol) and user enums are CLR value
        // types even though their symbols carry no ClrType.
        if (type is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        if (type is EnumSymbol)
        {
            return true;
        }

        return type?.ClrType != null && type.ClrType.IsValueType;
    }

    private static bool IsValueTypeAssignableToInterface(TypeSymbol from, TypeSymbol to)
    {
        // User-declared struct → user-declared interface: walk the struct's
        // declared interface list.
        if (from is StructSymbol fromStruct && to is InterfaceSymbol toInterface)
        {
            foreach (var i in fromStruct.Interfaces)
            {
                if (i == toInterface)
                {
                    return true;
                }
            }

            return false;
        }

        // Issue #976: a user-declared value-type struct → imported CLR
        // interface declared in its `: …` clause. The struct symbol has no
        // ClrType during binding, so the general CLR-assignability path below
        // cannot fire — match structurally against `ImplementedClrInterfaces`,
        // mirroring the class reference-upcast rule. This covers both plain
        // CLR interfaces (e.g. `IComparable`) and CLR generic interfaces closed
        // over a user G# type (e.g. `IEquatable[Money]`).
        if (from is StructSymbol fromValueStruct && !fromValueStruct.IsClass
            && to?.ClrType != null && to.ClrType.IsInterface)
        {
            foreach (var iface in fromValueStruct.ImplementedClrInterfaces)
            {
                var ifaceClr = iface?.ClrType;
                if (ifaceClr == null)
                {
                    continue;
                }

                if (ifaceClr == to.ClrType
                    || ClrTypeUtilities.IsAssignableByName(to.ClrType, ifaceClr))
                {
                    return true;
                }
            }
        }

        // Either side imported / CLR-typed: defer to the CLR's own
        // assignability check.
        var fromClr = from?.ClrType;
        var toClr = to?.ClrType;
        if (fromClr != null && toClr != null)
        {
            return ClrTypeUtilities.IsAssignableByName(toClr, fromClr);
        }

        return false;
    }

    /// <summary>
    /// Issue #813: returns <see langword="true"/> when one side is a G#
    /// <see cref="TupleTypeSymbol"/> and the other is the equivalent CLR
    /// <c>System.ValueTuple&lt;…&gt;</c> instantiation (with identical
    /// closed element types).
    /// </summary>
    private static bool IsTupleClrEquivalent(TypeSymbol a, TypeSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (a is TupleTypeSymbol ta && b is not TupleTypeSymbol)
        {
            return ta.ClrType != null && b.ClrType != null && ta.ClrType == b.ClrType;
        }

        if (b is TupleTypeSymbol tb && a is not TupleTypeSymbol)
        {
            return tb.ClrType != null && a.ClrType != null && tb.ClrType == a.ClrType;
        }

        return false;
    }

    /// <summary>
    /// Issue #821: cross-context-safe slice-to-interface check. When the
    /// target is a constructed <see cref="ImportedTypeSymbol"/> whose
    /// <c>ClrType</c> is the type-erased open-definition form (because
    /// <see cref="Type.MakeGenericType(Type[])"/> could not be closed at
    /// substitution time — typically because the open definition lives in a
    /// <see cref="System.Reflection.MetadataLoadContext"/> while the
    /// substituted argument types live in the live runtime) the symbolic
    /// <see cref="ImportedTypeSymbol.TypeArguments"/> carry the real
    /// substituted G# types. Match against those, not the erased CLR
    /// arguments, so the slice still classifies as implicitly convertible to
    /// the constructed interface.
    /// </summary>
    /// <param name="slice">The source slice type.</param>
    /// <param name="targetInterface">The constructed interface target.</param>
    /// <returns><see langword="true"/> when the slice's backing array
    /// implements the target interface.</returns>
    private static bool SliceImplementsInterface(SliceTypeSymbol slice, TypeSymbol targetInterface)
    {
        // Cheap path: the target's CLR generic arguments are already the
        // properly substituted closed form. Defer to the existing
        // by-name interface walk.
        if (ClrTypeUtilities.ImplementsInterfaceByName(slice.ClrType, targetInterface.ClrType))
        {
            return true;
        }

        if (targetInterface is not ImportedTypeSymbol imported
            || imported.OpenDefinition is null
            || imported.TypeArguments.IsDefaultOrEmpty)
        {
            return false;
        }

        // Cross-context fallback: walk the slice's backing CLR array
        // interfaces and match each generic argument against the symbolic
        // TypeArguments by ClrType FullName, which is assembly-qualifier
        // free for leaf types (System.Int32, System.String, …) and so
        // compares correctly across reflection contexts.
        var openDef = imported.OpenDefinition;
        foreach (var iface in slice.ClrType.GetInterfaces())
        {
            if (!iface.IsGenericType)
            {
                continue;
            }

            if (!string.Equals(
                    iface.GetGenericTypeDefinition().FullName,
                    openDef.FullName,
                    StringComparison.Ordinal))
            {
                continue;
            }

            var ifaceArgs = iface.GetGenericArguments();
            if (ifaceArgs.Length != imported.TypeArguments.Length)
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < ifaceArgs.Length; i++)
            {
                var symbolic = imported.TypeArguments[i];
                if (symbolic?.ClrType is null
                    || !string.Equals(ifaceArgs[i].FullName, symbolic.ClrType.FullName, StringComparison.Ordinal))
                {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }
}
