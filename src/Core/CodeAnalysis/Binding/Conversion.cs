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

        // #313: two erased generics constructed over the same open definition
        // with structurally-equivalent symbolic arguments (e.g. the `List[T]`
        // parameter type and the `List[T]` declared return type) are distinct
        // symbol instances but denote the same type. Treat them as identity so
        // `return items` inside a generic function binds.
        if (from is ImportedTypeSymbol fromGeneric && fromGeneric.HasTypeParameterArgument
            && to is ImportedTypeSymbol toGeneric && toGeneric.HasTypeParameterArgument
            && ReferenceEquals(fromGeneric.OpenDefinition, toGeneric.OpenDefinition)
            && fromGeneric.TypeArguments.Length == toGeneric.TypeArguments.Length)
        {
            var equivalent = true;
            for (var i = 0; i < fromGeneric.TypeArguments.Length; i++)
            {
                if (!ReferenceEquals(fromGeneric.TypeArguments[i], toGeneric.TypeArguments[i]))
                {
                    equivalent = false;
                    break;
                }
            }

            if (equivalent)
            {
                return Conversion.Identity;
            }
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

        var invoke = delegateType.GetMethod("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var parms = invoke.GetParameters();
        if (parms.Length != fn.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < parms.Length; i++)
        {
            var fnParamClr = fn.ParameterTypes[i]?.ClrType;
            if (fnParamClr == null || !ClrTypeUtilities.IsAssignableByName(parms[i].ParameterType, fnParamClr))
            {
                return false;
            }
        }

        var invokeReturnIsVoid = invoke.ReturnType == null
            || string.Equals(invoke.ReturnType.FullName, "System.Void", StringComparison.Ordinal);
        if (fn.ReturnType == TypeSymbol.Void || fn.ReturnType == null)
        {
            return invokeReturnIsVoid;
        }

        if (invokeReturnIsVoid)
        {
            return false;
        }

        var fnReturnClr = fn.ReturnType.ClrType;
        return fnReturnClr != null && ClrTypeUtilities.IsAssignableByName(invoke.ReturnType, fnReturnClr);
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

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        return type?.ClrType?.IsEnum == true;
    }

    private static bool IsInterfaceLikeType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        return type?.ClrType?.IsInterface == true;
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
}
