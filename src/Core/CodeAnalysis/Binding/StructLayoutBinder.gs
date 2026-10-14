// <copyright file="StructLayoutBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Runtime.InteropServices

/// Helpers for validating and extracting `@StructLayout(LayoutKind.…)`
/// and `@FieldOffset(N)` attribute metadata from struct and class
/// declarations (ADR-0093 / issue #759). The resolved values are written
/// onto (cref:StructSymbol.LayoutMetadata) and
/// (cref:FieldSymbol.ExplicitOffset); the emitter consumes them to
/// pick the right CLR (cref:System.Reflection.TypeAttributes)
/// layout flag and to write the matching `ClassLayout` /
/// `FieldLayout` rows. Reports GS0346–GS0350 on any malformed input.
internal shared class StructLayoutBinder {
    /// When [`structSymbol`](paramref) carries a
    /// `@StructLayout(LayoutKind.…)` annotation, validates the shape,
    /// builds a (cref:StructLayoutMetadata), and attaches it to the
    /// symbol. Independently of the type-level annotation, also validates
    /// each field's `@FieldOffset(N)` annotation and writes the
    /// resolved offset onto the field symbol.
    /// @param structSymbol The bound struct or class symbol.
    /// @param diagnostics The diagnostics bag for the declaring binder.
    internal func ResolveLayoutAndFieldOffsets(structSymbol StructSymbol, diagnostics DiagnosticBag) {
        let typeAttr = KnownAttributes.FindStructLayout(structSymbol.Attributes)
        let metadata StructLayoutMetadata? = ExtractStructLayout(typeAttr, diagnostics)
        if metadata != nil {
            structSymbol.SetLayoutMetadata(metadata)
        }
        // Effective layout for field-offset validation: a missing
        // @StructLayout annotation defaults to Sequential for structs and
        // Auto for classes (matching the C# defaults). Auto-layout types
        // are not P/Invoke-portable; the GS0349 check in PInvokeBinder
        // separately rejects them — at this point we only need to know
        // whether the type is Explicit-layout so we can validate
        // @FieldOffset placements.
        let isExplicit = metadata?.Layout == LayoutKind.Explicit
        for field in structSymbol.Fields {
            if field.Attributes.IsDefaultOrEmpty {
                if isExplicit && !structSymbol.IsClass {
                    // Every field of an Explicit-layout struct must carry
                    // a @FieldOffset annotation; missing offsets are GS0347.
                    diagnostics.ReportFieldOffsetRequiredOnExplicitLayout(
                        FieldIdentifierLocation(structSymbol, field),
                        field.Name,
                        structSymbol.Name
                    )
                }
                continue
            }
            let fieldOffsetAttr BoundAttribute? = KnownAttributes.FindFieldOffset(field.Attributes)
            if fieldOffsetAttr == nil {
                if isExplicit {
                    diagnostics.ReportFieldOffsetRequiredOnExplicitLayout(
                        FieldIdentifierLocation(structSymbol, field),
                        field.Name,
                        structSymbol.Name
                    )
                }
                continue
            }
            // @FieldOffset is only valid inside Explicit-layout types.
            // For a non-Explicit type (including a missing annotation that
            // defaults to Sequential/Auto), report GS0348.
            if !isExplicit {
                diagnostics.ReportFieldOffsetInvalidOnNonExplicitLayout(
                    fieldOffsetAttr.Syntax.Location,
                    field.Name,
                    structSymbol.Name
                )
                continue
            }
            let offsetArgument BoundAttributeArgument? = fieldOffsetAttr.GetConstructorArgument(0, "offset")
            if offsetArgument == nil ||
                !TryReadInt32(ImmutableArray.Create(offsetArgument), out var offset) ||
                offset < 0 {
                let raw = offsetArgument?.Value?.ToString() ?? "<missing>"
                diagnostics.ReportFieldOffsetInvalidValue(fieldOffsetAttr.Syntax.Location, raw)
                continue
            }
            field.SetExplicitOffset(offset)
        }
    }

    /// Reports CLR-invalid reference field alignment and overlaps after all type bodies are bound.
    /// @param structSymbol The fully bound struct symbol.
    /// @param diagnostics The compilation diagnostics.
    internal func ReportReferenceFieldOverlaps(structSymbol StructSymbol, diagnostics DiagnosticBag) {
        if structSymbol.LayoutMetadata?.Layout != LayoutKind.Explicit {
            return
        }
        for var i = 0; i < structSymbol.Fields.Length; i++ {
            let left = structSymbol.Fields[i]
            if left.ExplicitOffset is not int32 leftOffset {
                continue
            }
            let leftIsReference = IsReferenceFieldType(left.Type)
            if leftIsReference && IsMisalignedReference(leftOffset) {
                diagnostics.ReportExplicitLayoutReferenceStorageInvalid(
                    FieldIdentifierLocation(structSymbol, left),
                    structSymbol.Name,
                    left.Name,
                    "its offset $leftOffset is not aligned to pointer size ${nint.Size}"
                )
                continue
            }
            for var j = i + 1; j < structSymbol.Fields.Length; j++ {
                let right = structSymbol.Fields[j]
                if right.ExplicitOffset is not int32 rightOffset {
                    continue
                }
                let rightIsReference = IsReferenceFieldType(right.Type)
                if (rightIsReference && IsMisalignedReference(rightOffset)) || leftIsReference == rightIsReference {
                    continue
                }
                let reference = if leftIsReference {
                    left
                } else {
                    right
                }
                let referenceOffset = if leftIsReference {
                    leftOffset
                } else {
                    rightOffset
                }
                let nonReference = if leftIsReference {
                    right
                } else {
                    left
                }
                let nonReferenceOffset = if leftIsReference {
                    rightOffset
                } else {
                    leftOffset
                }
                if !TryGetStorageSize(nonReference.Type, out var nonReferenceSize) {
                    continue
                }
                let referenceEnd = int64(referenceOffset) + int64(nint.Size)
                let nonReferenceEnd = int64(nonReferenceOffset) + int64(nonReferenceSize)
                if int64(referenceOffset) < nonReferenceEnd && int64(nonReferenceOffset) < referenceEnd {
                    diagnostics.ReportExplicitLayoutReferenceStorageInvalid(
                        FieldIdentifierLocation(structSymbol, nonReference),
                        structSymbol.Name,
                        reference.Name,
                        "it overlaps non-reference field '${nonReference.Name}'"
                    )
                }
            }
        }
    }

    private func IsMisalignedReference(offset int32) bool -> offset % nint.Size != 0

    private func IsReferenceFieldType(type TypeSymbol) bool {
        if type is NullableTypeSymbol nullable {
            return IsReferenceFieldType(nullable.UnderlyingType)
        }
        return type == TypeSymbol.Object || Binder.IsReferenceTypeForConstraint(type)
    }

    private func TryGetStorageSize(type TypeSymbol, out size int32) bool {
        size = 0
        if type is NullableTypeSymbol {
            return TryGetClrStorageSize(NullableTypeSymbol.GetEffectiveClrType(type), out size)
        }
        if type is EnumSymbol enumType {
            return TryGetStorageSize(enumType.UnderlyingType, out size)
        }
        if type is PointerTypeSymbol || type is ByRefTypeSymbol {
            size = nint.Size
            return true
        }
        if type == TypeSymbol.Bool || type == TypeSymbol.Int8 || type == TypeSymbol.UInt8 {
            size = 1
            return true
        }
        if type == TypeSymbol.Char || type == TypeSymbol.Int16 || type == TypeSymbol.UInt16 {
            size = 2
            return true
        }
        if type == TypeSymbol.Int32 || type == TypeSymbol.UInt32 || type == TypeSymbol.Float32 {
            size = 4
            return true
        }
        if type == TypeSymbol.Int64 || type == TypeSymbol.UInt64 || type == TypeSymbol.Float64 {
            size = 8
            return true
        }
        if type == TypeSymbol.Decimal {
            size = 16
            return true
        }
        if type == TypeSymbol.NInt || type == TypeSymbol.NUInt {
            size = nint.Size
            return true
        }
        if type is StructSymbol structType {
            return !structType.IsClass &&
                (
                TryGetClrStorageSize(structType.ClrType, out size) || StructValue.TryGetStorageSize(
                    structType,
                    out size
                )
            )
        }
        return TryGetClrStorageSize(type?.ClrType, out size)
    }

    private func TryGetClrStorageSize(type Type?, out size int32) bool {
        size = 0
        if type == nil || !type.IsValueType {
            return false
        }
        try {
            size = Marshal.SizeOf(type)
            return true
        } catch (ArgumentException) {
            return false
        }
    }

    private func ExtractStructLayout(attribute BoundAttribute?, diagnostics DiagnosticBag) StructLayoutMetadata? {
        if attribute == nil {
            return nil
        }
        // 1) Positional LayoutKind. Reject Auto (ADR-0093 §1 / GS0346).
        var layout = LayoutKind.Sequential
        if attribute.GetConstructorArgument(0, "layoutKind") is {} layoutArgument {
            let raw object? = layoutArgument.Value
            if raw != nil && KnownAttributes.TryConvertAttributeEnum[LayoutKind](raw, out var parsed) {
                if parsed != LayoutKind.Sequential && parsed != LayoutKind.Explicit {
                    diagnostics.ReportStructLayoutInvalidLayoutKind(attribute.Syntax.Location, parsed.ToString())
                    return nil
                }
                layout = parsed
            } else {
                diagnostics.ReportStructLayoutInvalidLayoutKind(attribute.Syntax.Location, raw?.ToString() ?? "<null>")
                return nil
            }
        }
        // 2) Optional named arguments. Pack and Size are typed as int32 on
        //    the CLR attribute; only positive (or zero) packings are
        //    meaningful but we accept whatever the user supplies so the
        //    runtime gets the matching diagnostic if it is invalid.
        var pack int32? = nil
        var size int32? = nil
        for named in attribute.NamedArguments {
            switch named.Name {
                case "Pack" {
                    if TryConvertToInt32(named.Value, out var packValue) {
                        pack = packValue
                    }
                }
                case "Size" {
                    if TryConvertToInt32(named.Value, out var sizeValue) {
                        size = sizeValue
                    }
                }
                case "CharSet" { }
                default { }
            }
        }
        return StructLayoutMetadata(layout, pack, size)
    }

    private func TryReadInt32(positional ImmutableArray[BoundAttributeArgument], out value int32) bool {
        value = 0
        if positional.IsDefaultOrEmpty {
            return false
        }
        return TryConvertToInt32(positional[0].Value, out value)
    }

    private func TryConvertToInt32(value object?, out result int32) bool {
        result = 0
        switch value {
            case i is int32 {
                result = i
                return true
            }
            case l is int64 when l >= int64(int32.MinValue) && l <= int64(int32.MaxValue) {
                result = int32(l)
                return true
            }
            case s is int16 {
                result = s
                return true
            }
            case b is uint8 {
                result = b
                return true
            }
            case sb is int8 {
                result = sb
                return true
            }
            case us is uint16 {
                result = us
                return true
            }
            case ui is uint32 when ui <= uint32(int32.MaxValue) {
                result = int32(ui)
                return true
            }
            default {
                return false
            }
        }
    }

    private func FieldIdentifierLocation(structSymbol StructSymbol, field FieldSymbol) TextLocation {
        let decl StructDeclarationSyntax? = structSymbol.Declaration
        if decl != nil {
            for fieldSyntax in decl.Fields {
                if fieldSyntax.Identifier?.Text == field.Name {
                    return fieldSyntax.Identifier.Location
                }
            }
            return decl.Identifier?.Location ?? default(TextLocation)
        }
        return default(TextLocation)
    }
}
