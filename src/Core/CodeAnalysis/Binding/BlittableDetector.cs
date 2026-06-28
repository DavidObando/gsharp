// <copyright file="BlittableDetector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Recursively determines whether a G# type is "blittable" — has the same
/// bit-for-bit representation in managed and unmanaged memory — using the
/// rules defined in ADR-0093 §2 (issue #759). The result drives the
/// <c>PInvokeBinder</c> decision to accept a struct or class in a
/// P/Invoke signature without a per-field <c>@MarshalAs</c>.
/// </summary>
/// <remarks>
/// <para>
/// Primitive integers / floats / <c>nint</c> / <c>nuint</c> and raw
/// pointers (<c>*T</c>) are blittable. A user struct is blittable iff
/// every instance field is blittable. A class is blittable iff it
/// carries an explicit <c>@StructLayout(LayoutKind.Sequential|Explicit)</c>
/// annotation <em>and</em> every field is blittable; this matches the
/// CLR's "formatted class" concept and is the prerequisite for marshalling
/// a class instance by-reference across the P/Invoke boundary.
/// </para>
/// <para>
/// Imported CLR struct types defer to the runtime's classification —
/// <see cref="System.Runtime.InteropServices.Marshal.SizeOf(System.Type)"/>
/// only succeeds for blittable types, so a successful call confirms the
/// classification. The result is cached per type to keep the recursion
/// cheap when a top-level signature visits the same field type twice.
/// </para>
/// </remarks>
internal sealed class BlittableDetector
{
    private readonly Dictionary<TypeSymbol, bool> cache = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<TypeSymbol, bool> unmanagedCache = new(ReferenceEqualityComparer.Instance);

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> is blittable per
    /// ADR-0093 §2.
    /// </summary>
    /// <param name="type">The bound type symbol to classify.</param>
    /// <returns><c>true</c> when blittable.</returns>
    public bool IsBlittable(TypeSymbol type)
    {
        return type != null && IsBlittableImpl(type, new HashSet<StructSymbol>(ReferenceEqualityComparer.Instance), unmanaged: false);
    }

    /// <summary>
    /// Issue #1336. Returns <c>true</c> when <paramref name="type"/> is an
    /// <em>unmanaged</em> type — bit-for-bit representable with no GC-tracked
    /// references. This is a strict superset of <see cref="IsBlittable"/>:
    /// <c>bool</c>, <c>char</c> and <c>decimal</c> are unmanaged (they satisfy
    /// C#'s <c>where T : unmanaged</c> and are valid <c>sizeof</c> operands)
    /// even though they are not blittable for P/Invoke marshalling. Enums,
    /// pointers, and value structs whose fields are recursively unmanaged also
    /// qualify; managed reference types and structs containing a managed field
    /// do not.
    /// </summary>
    /// <param name="type">The bound type symbol to classify.</param>
    /// <returns><c>true</c> when unmanaged.</returns>
    public bool IsUnmanaged(TypeSymbol type)
    {
        return type != null && IsBlittableImpl(type, new HashSet<StructSymbol>(ReferenceEqualityComparer.Instance), unmanaged: true);
    }

    /// <summary>
    /// ADR-0122 §4 / issue #1034. Returns <c>true</c> when <paramref name="type"/>
    /// is a legal unmanaged-pointer pointee that is a <em>blittable user/value
    /// struct</em> (e.g. <c>*Point</c>). A pointer to a struct is legal only when
    /// the struct is a value type (not a class) and every field is itself
    /// blittable — mirroring C#'s "unmanaged type" rule. Blittable formatted
    /// classes are deliberately excluded because a pointer-to-class would point
    /// at a managed reference, which is not a raw unmanaged pointer target.
    /// </summary>
    /// <param name="type">The candidate pointee type.</param>
    /// <returns><c>true</c> when the type is a blittable value-type struct.</returns>
    public static bool IsBlittableValueStructPointee(TypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        var isValueStruct = (type is StructSymbol { IsClass: false })
            || (type is not StructSymbol && type.ClrType is { IsValueType: true });
        if (!isValueStruct)
        {
            return false;
        }

        return new BlittableDetector().IsBlittable(type);
    }

    private bool IsBlittableImpl(TypeSymbol type, HashSet<StructSymbol> visiting, bool unmanaged)
    {
        if (type == null || type == TypeSymbol.Error)
        {
            // Already reported as a separate diagnostic; don't double-fire.
            return true;
        }

        var modeCache = unmanaged ? unmanagedCache : cache;
        if (modeCache.TryGetValue(type, out var cached))
        {
            return cached;
        }

        var result = ClassifyImpl(type, visiting, unmanaged);
        modeCache[type] = result;
        return result;
    }

    private bool ClassifyImpl(TypeSymbol type, HashSet<StructSymbol> visiting, bool unmanaged)
    {
        if (IsBlittablePrimitive(type))
        {
            return true;
        }

        // Issue #1336: `bool`, `char` and `decimal` are unmanaged (no GC
        // references) even though they are not blittable for P/Invoke
        // marshalling. In unmanaged mode they are accepted here; in blittable
        // mode they fall through to the known-non-blittable rejection below.
        if (unmanaged && IsUnmanagedOnlyPrimitive(type))
        {
            return true;
        }

        // Explicitly reject the known non-blittable language primitives
        // before falling back to the Marshal.SizeOf heuristic — the runtime
        // happily reports `Marshal.SizeOf(typeof(bool)) == 4`, which would
        // otherwise cause the fallback to misclassify `bool` and `char` as
        // blittable.
        if (IsKnownNonBlittablePrimitive(type))
        {
            return false;
        }

        if (type is ByRefTypeSymbol byRef)
        {
            // A pointer is blittable regardless of its pointee (the
            // pointer value is just an address-sized integer at runtime).
            return byRef.PointeeType != null;
        }

        // Issue #1336: a raw unmanaged pointer (`*T`) and an enum are unmanaged
        // (and blittable — a pointer is an address-sized integer, an enum is
        // its integral underlying type).
        if (type is PointerTypeSymbol)
        {
            return true;
        }

        if (type is EnumSymbol)
        {
            return true;
        }

        if (type is StructSymbol structSym)
        {
            return IsBlittableStruct(structSym, visiting, unmanaged);
        }

        // Imported CLR types: defer to the runtime's classification by
        // attempting Marshal.SizeOf. A non-blittable type raises
        // ArgumentException; blittable types return the size in bytes.
        var clr = type.ClrType;
        if (clr != null && clr.IsValueType)
        {
            if (clr.IsEnum)
            {
                return true;
            }

            try
            {
                System.Runtime.InteropServices.Marshal.SizeOf(clr);
                return true;
            }
            catch
            {
                return false;
            }
        }

        return false;
    }

    private static bool IsUnmanagedOnlyPrimitive(TypeSymbol type)
    {
        return type == TypeSymbol.Bool
            || type == TypeSymbol.Char
            || type == TypeSymbol.Decimal;
    }

    private static bool IsKnownNonBlittablePrimitive(TypeSymbol type)
    {
        return type == TypeSymbol.Bool
            || type == TypeSymbol.Char
            || type == TypeSymbol.String
            || type == TypeSymbol.Decimal
            || type == TypeSymbol.Object
            || type == TypeSymbol.Null;
    }

    private bool IsBlittableStruct(StructSymbol structSym, HashSet<StructSymbol> visiting, bool unmanaged)
    {
        // ADR-0093 §4: a class is blittable only when it carries an
        // explicit @StructLayout annotation and every field is blittable.
        // The default class layout is Auto, which is not P/Invoke-portable.
        if (structSym.IsClass)
        {
            // Issue #1336: a class is a managed reference type — never unmanaged.
            if (unmanaged)
            {
                return false;
            }

            var layout = structSym.LayoutMetadata;
            if (layout == null)
            {
                return false;
            }

            if (layout.Layout != System.Runtime.InteropServices.LayoutKind.Sequential
                && layout.Layout != System.Runtime.InteropServices.LayoutKind.Explicit)
            {
                return false;
            }
        }

        // Cycle guard: recursive struct definitions are already rejected
        // elsewhere, but defensively treat a visited node as blittable to
        // avoid unbounded recursion in pathological cases.
        if (!visiting.Add(structSym))
        {
            return true;
        }

        try
        {
            foreach (var field in structSym.Fields)
            {
                if (!IsBlittableImpl(field.Type, visiting, unmanaged))
                {
                    return false;
                }
            }

            return true;
        }
        finally
        {
            visiting.Remove(structSym);
        }
    }

    private static bool IsBlittablePrimitive(TypeSymbol type)
    {
        return type == TypeSymbol.Int8
            || type == TypeSymbol.UInt8
            || type == TypeSymbol.Int16
            || type == TypeSymbol.UInt16
            || type == TypeSymbol.Int32
            || type == TypeSymbol.UInt32
            || type == TypeSymbol.Int64
            || type == TypeSymbol.UInt64
            || type == TypeSymbol.NInt
            || type == TypeSymbol.NUInt
            || type == TypeSymbol.Float32
            || type == TypeSymbol.Float64;
    }
}
