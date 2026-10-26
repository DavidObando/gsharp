// <copyright file="BlittableDetector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Reflection
import System.Runtime.InteropServices

/// Recursively determines whether a G# type is "blittable" — has the same
/// bit-for-bit representation in managed and unmanaged memory — using the
/// rules defined in ADR-0093 §2 (issue #759). The result drives the
/// `PInvokeBinder` decision to accept a struct or class in a
/// P/Invoke signature without a per-field `@MarshalAs`.
/// @remarks Primitive integers / floats / `nint` / `nuint` and raw
/// pointers (`*T`) are blittable. A user struct is blittable iff
/// every instance field is blittable. A class is blittable iff it
/// carries an explicit `@StructLayout(LayoutKind.Sequential|Explicit)`
/// annotation <em>and</em> every field is blittable; this matches the
/// CLR's "formatted class" concept and is the prerequisite for marshalling
/// a class instance by-reference across the P/Invoke boundary.
///
/// Imported CLR struct types are classified from their metadata layout and
/// instance fields. This works for both runtime types and types loaded through a
/// (cref:System.Reflection.MetadataLoadContext), and avoids treating
/// marshalable structs containing managed references as blittable.
internal class BlittableDetector {
    private let cache Dictionary[TypeSymbol, bool] = Dictionary[TypeSymbol, bool](ReferenceEqualityComparer.Instance)
    private let unmanagedCache Dictionary[TypeSymbol, bool] = Dictionary[TypeSymbol, bool](
        ReferenceEqualityComparer.Instance
    )

    /// Returns `true` when [`type`](paramref) is blittable per
    /// ADR-0093 §2.
    /// @param type The bound type symbol to classify.
    /// @returns `true` when blittable.
    func IsBlittable(type TypeSymbol?) bool {
        return type != nil &&
            IsBlittableImpl(type, HashSet[TypeSymbol](ReferenceEqualityComparer.Instance), unmanaged: false)
    }

    /// Issue #1336. Returns `true` when [`type`](paramref) is an
    /// <em>unmanaged</em> type — bit-for-bit representable with no GC-tracked
    /// references. This is a strict superset of (cref:IsBlittable):
    /// `bool`, `char` and `decimal` are unmanaged (they satisfy
    /// C#'s `where T : unmanaged` and are valid `sizeof` operands)
    /// even though they are not blittable for P/Invoke marshalling. Enums,
    /// pointers, and value structs whose fields are recursively unmanaged also
    /// qualify; managed reference types and structs containing a managed field
    /// do not.
    /// @param type The bound type symbol to classify.
    /// @returns `true` when unmanaged.
    func IsUnmanaged(type TypeSymbol?) bool {
        return type != nil &&
            IsBlittableImpl(type, HashSet[TypeSymbol](ReferenceEqualityComparer.Instance), unmanaged: true)
    }

    private func IsBlittableImpl(type TypeSymbol?, visiting HashSet[TypeSymbol], unmanaged bool) bool {
        if type == nil || type == TypeSymbol.Error {
            // Already reported as a separate diagnostic; don't double-fire.
            return true
        }
        let modeCache = if unmanaged {
            unmanagedCache
        } else {
            cache
        }
        if modeCache.TryGetValue(type, out var cached) {
            return cached
        }
        let result = ClassifyImpl(type, visiting, unmanaged)
        modeCache[type] = result
        return result
    }

    private func ClassifyImpl(type TypeSymbol, visiting HashSet[TypeSymbol], unmanaged bool) bool {
        if type is NullableTypeSymbol {
            return false
        }
        if IsBlittablePrimitive(type) {
            return true
        }
        // Issue #1336: `bool`, `char` and `decimal` are unmanaged (no GC
        // references) even though they are not blittable for P/Invoke
        // marshalling. In unmanaged mode they are accepted here; in blittable
        // mode they fall through to the known-non-blittable rejection below.
        if unmanaged && IsUnmanagedOnlyPrimitive(type) {
            return true
        }
        // Explicitly reject the known non-blittable language primitives before
        // imported metadata classification. In particular, bool and char have
        // unmanaged representations that require marshalling conversions.
        if IsKnownNonBlittablePrimitive(type) {
            return false
        }
        if TypeSymbol.IsByRefLike(type) {
            return false
        }
        if type is ByRefTypeSymbol {
            return false
        }
        // Issue #1336: a raw unmanaged pointer (`*T`) and an enum are unmanaged
        // (and blittable — a pointer is an address-sized integer, an enum is
        // its integral underlying type).
        if type is PointerTypeSymbol or FunctionPointerTypeSymbol {
            return true
        }
        if type is EnumSymbol {
            return true
        }
        if type is StructSymbol structSym {
            if structSym.IsGenericDefinition {
                return false
            }
            if structSym.ClrType is {} importedClr {
                return IsImportedValueType(type, importedClr, visiting, unmanaged)
            }
            return IsBlittableStruct(structSym, visiting, unmanaged)
        }
        let clr Type? = type.ClrType
        if clr?.IsPointer == true || clr?.IsFunctionPointer == true || clr?.IsEnum == true {
            return true
        }
        if clr?.IsGenericParameter == true || clr?.ContainsGenericParameters == true {
            return false
        }
        if clr != nil && clr.IsValueType {
            return IsImportedValueType(type, clr, visiting, unmanaged)
        }
        return false
    }

    private func IsBlittableStruct(structSym StructSymbol, visiting HashSet[TypeSymbol], unmanaged bool) bool {
        // ADR-0093 §4: a class is blittable only when it carries an
        // explicit @StructLayout annotation and every field is blittable.
        // The default class layout is Auto, which is not P/Invoke-portable.
        if structSym.IsClass {
            // Issue #1336: a class is a managed reference type — never unmanaged.
            if unmanaged {
                return false
            }
            let layout StructLayoutMetadata? = structSym.LayoutMetadata
            if layout == nil {
                return false
            }
            if layout.Layout != LayoutKind.Sequential && layout.Layout != LayoutKind.Explicit {
                return false
            }
        } else if !unmanaged && structSym.LayoutMetadata?.Layout == LayoutKind.Auto {
            return false
        }
        // Recursive value layouts are invalid. Pointer recursion never reaches
        // this guard because pointers classify as address-sized leaves above.
        if !visiting.Add(structSym) {
            return false
        }
        try {
            for field in structSym.Fields {
                if field.Type is StructSymbol{IsClass: true} || !IsBlittableImpl(field.Type, visiting, unmanaged) {
                    return false
                }
            }
            return true
        } finally {
            visiting.Remove(structSym)
        }
    }

    private func IsImportedValueType(symbol TypeSymbol, type Type, visiting HashSet[TypeSymbol], unmanaged bool) bool {
        var added = false
        try {
            if !type.IsValueType ||
                type.IsByRef ||
                type.IsGenericParameter ||
                type.ContainsGenericParameters ||
                (symbol is ImportedTypeSymbol imported && imported.HasTypeParameterArgument) {
                return false
            }
            if !unmanaged && !type.IsLayoutSequential && !type.IsExplicitLayout {
                return false
            }
            added = visiting.Add(symbol)
            if !added {
                return false
            }
            let fields = type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            for field in fields {
                let fieldType = MemberLookup.GetClrFieldTypeSymbol(symbol, field)
                if fieldType is StructSymbol{IsClass: true} || !IsBlittableImpl(fieldType, visiting, unmanaged) {
                    return false
                }
            }
            return true
        } catch {
            return false
        } finally {
            if added {
                visiting.Remove(symbol)
            }
        }
    }

    shared {
        /// Identifies aggregate value types without treating primitives, enums, or nullable values as structs.
        /// @param type The candidate type.
        /// @returns Whether the type has a value-struct layout.
        internal func IsValueStruct(type TypeSymbol?) bool {
            return type != nil &&
                type is not NullableTypeSymbol &&
                type is not EnumSymbol &&
                (
                type is StructSymbol{IsClass: false} ||
                    (
                    type.ClrType is {IsValueType: true, IsPrimitive: false, IsEnum: false} && type != TypeSymbol.Decimal
                )
            )
        }

        /// ADR-0122 §4 / issue #1034. Returns `true` when [`type`](paramref)
        /// is a legal unmanaged-pointer pointee that is a <em>blittable user/value
        /// struct</em> (e.g. `*Point`). A pointer to a struct is legal only when
        /// the struct is a value type (not a class) and every field is itself
        /// blittable — mirroring C#'s "unmanaged type" rule. Blittable formatted
        /// classes are deliberately excluded because a pointer-to-class would point
        /// at a managed reference, which is not a raw unmanaged pointer target.
        /// @param type The candidate pointee type.
        /// @returns `true` when the type is a blittable value-type struct.
        func IsBlittableValueStructPointee(type TypeSymbol?) bool {
            if type == nil {
                return false
            }
            let isValueStruct = (type is StructSymbol{IsClass: false}) ||
                (type is not StructSymbol && type.ClrType is {IsValueType: true})
            if !isValueStruct {
                return false
            }
            return BlittableDetector().IsBlittable(type)
        }

        private func IsUnmanagedOnlyPrimitive(type TypeSymbol) bool {
            return type == TypeSymbol.Bool || type == TypeSymbol.Char || type == TypeSymbol.Decimal
        }

        private func IsKnownNonBlittablePrimitive(type TypeSymbol) bool {
            return type == TypeSymbol.Bool ||
                type == TypeSymbol.Char ||
                type == TypeSymbol.String ||
                type == TypeSymbol.Decimal ||
                type == TypeSymbol.Object ||
                type == TypeSymbol.Null
        }

        private func IsBlittablePrimitive(type TypeSymbol) bool {
            return type == TypeSymbol.Int8 ||
                type == TypeSymbol.UInt8 ||
                type == TypeSymbol.Int16 ||
                type == TypeSymbol.UInt16 ||
                type == TypeSymbol.Int32 ||
                type == TypeSymbol.UInt32 ||
                type == TypeSymbol.Int64 ||
                type == TypeSymbol.UInt64 ||
                type == TypeSymbol.NInt ||
                type == TypeSymbol.NUInt ||
                type == TypeSymbol.Float32 ||
                type == TypeSymbol.Float64
        }
    }
}
