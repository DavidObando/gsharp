// <copyright file="StructLayoutBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Helpers for validating and extracting <c>@StructLayout(LayoutKind.…)</c>
/// and <c>@FieldOffset(N)</c> attribute metadata from struct and class
/// declarations (ADR-0093 / issue #759). The resolved values are written
/// onto <see cref="StructSymbol.LayoutMetadata"/> and
/// <see cref="FieldSymbol.ExplicitOffset"/>; the emitter consumes them to
/// pick the right CLR <see cref="System.Reflection.TypeAttributes"/>
/// layout flag and to write the matching <c>ClassLayout</c> /
/// <c>FieldLayout</c> rows. Reports GS0346–GS0350 on any malformed input.
/// </summary>
internal static class StructLayoutBinder
{
    /// <summary>
    /// When <paramref name="structSymbol"/> carries a
    /// <c>@StructLayout(LayoutKind.…)</c> annotation, validates the shape,
    /// builds a <see cref="StructLayoutMetadata"/>, and attaches it to the
    /// symbol. Independently of the type-level annotation, also validates
    /// each field's <c>@FieldOffset(N)</c> annotation and writes the
    /// resolved offset onto the field symbol.
    /// </summary>
    /// <param name="structSymbol">The bound struct or class symbol.</param>
    /// <param name="diagnostics">The diagnostics bag for the declaring binder.</param>
    internal static void ResolveLayoutAndFieldOffsets(StructSymbol structSymbol, DiagnosticBag diagnostics)
    {
        var typeAttr = KnownAttributes.FindStructLayout(structSymbol.Attributes);
        var metadata = ExtractStructLayout(typeAttr, diagnostics);
        if (metadata != null)
        {
            structSymbol.SetLayoutMetadata(metadata);
        }

        // Effective layout for field-offset validation: a missing
        // @StructLayout annotation defaults to Sequential for structs and
        // Auto for classes (matching the C# defaults). Auto-layout types
        // are not P/Invoke-portable; the GS0349 check in PInvokeBinder
        // separately rejects them — at this point we only need to know
        // whether the type is Explicit-layout so we can validate
        // @FieldOffset placements.
        var isExplicit = metadata?.Layout == LayoutKind.Explicit;

        foreach (var field in structSymbol.Fields)
        {
            if (field.Attributes.IsDefaultOrEmpty)
            {
                if (isExplicit && !structSymbol.IsClass)
                {
                    // Every field of an Explicit-layout struct must carry
                    // a @FieldOffset annotation; missing offsets are GS0347.
                    diagnostics.ReportFieldOffsetRequiredOnExplicitLayout(
                        FieldIdentifierLocation(structSymbol, field),
                        field.Name,
                        structSymbol.Name);
                }

                continue;
            }

            var fieldOffsetAttr = KnownAttributes.FindFieldOffset(field.Attributes);
            if (fieldOffsetAttr == null)
            {
                if (isExplicit)
                {
                    diagnostics.ReportFieldOffsetRequiredOnExplicitLayout(
                        FieldIdentifierLocation(structSymbol, field),
                        field.Name,
                        structSymbol.Name);
                }

                continue;
            }

            // @FieldOffset is only valid inside Explicit-layout types.
            // For a non-Explicit type (including a missing annotation that
            // defaults to Sequential/Auto), report GS0348.
            if (!isExplicit)
            {
                diagnostics.ReportFieldOffsetInvalidOnNonExplicitLayout(
                    fieldOffsetAttr.Syntax.Location,
                    field.Name,
                    structSymbol.Name);
                continue;
            }

            if (!TryReadInt32(fieldOffsetAttr.PositionalArguments, out var offset) || offset < 0)
            {
                var raw = fieldOffsetAttr.PositionalArguments.IsDefaultOrEmpty
                    ? "<missing>"
                    : (fieldOffsetAttr.PositionalArguments[0].Value?.ToString() ?? "<null>");
                diagnostics.ReportFieldOffsetInvalidValue(fieldOffsetAttr.Syntax.Location, raw);
                continue;
            }

            field.SetExplicitOffset(offset);
        }
    }

    private static StructLayoutMetadata ExtractStructLayout(BoundAttribute attribute, DiagnosticBag diagnostics)
    {
        if (attribute == null)
        {
            return null;
        }

        // 1) Positional LayoutKind. Reject Auto (ADR-0093 §1 / GS0346).
        var layout = LayoutKind.Sequential;
        if (!attribute.PositionalArguments.IsDefaultOrEmpty)
        {
            var raw = attribute.PositionalArguments[0].Value;
            if (KnownAttributes.TryConvertAttributeEnum<LayoutKind>(raw, out var parsed))
            {
                if (parsed != LayoutKind.Sequential && parsed != LayoutKind.Explicit)
                {
                    diagnostics.ReportStructLayoutInvalidLayoutKind(
                        attribute.Syntax.Location,
                        parsed.ToString());
                    return null;
                }

                layout = parsed;
            }
            else
            {
                diagnostics.ReportStructLayoutInvalidLayoutKind(
                    attribute.Syntax.Location,
                    raw?.ToString() ?? "<null>");
                return null;
            }
        }

        // 2) Optional named arguments. Pack and Size are typed as int32 on
        //    the CLR attribute; only positive (or zero) packings are
        //    meaningful but we accept whatever the user supplies so the
        //    runtime gets the matching diagnostic if it is invalid.
        int? pack = null;
        int? size = null;
        foreach (var named in attribute.NamedArguments)
        {
            switch (named.Name)
            {
                case "Pack":
                    if (TryConvertToInt32(named.Value, out var packValue))
                    {
                        pack = packValue;
                    }

                    break;

                case "Size":
                    if (TryConvertToInt32(named.Value, out var sizeValue))
                    {
                        size = sizeValue;
                    }

                    break;

                case "CharSet":
                    // Accepted at the source level for forward
                    // compatibility — the existing CharSet enum binding is
                    // already validated by the attribute-arg binder, so a
                    // bogus value is reported through the generic
                    // attribute-property path rather than a new code.
                    break;

                default:
                    // Unknown named arguments fall through to the generic
                    // attribute-arg binder's "no matching property"
                    // diagnostic (GS0207).
                    break;
            }
        }

        return new StructLayoutMetadata(layout, pack, size);
    }

    private static bool TryReadInt32(ImmutableArray<BoundAttributeArgument> positional, out int value)
    {
        value = 0;
        if (positional.IsDefaultOrEmpty)
        {
            return false;
        }

        return TryConvertToInt32(positional[0].Value, out value);
    }

    private static bool TryConvertToInt32(object value, out int result)
    {
        result = 0;
        switch (value)
        {
            case int i:
                result = i;
                return true;
            case long l when l >= int.MinValue && l <= int.MaxValue:
                result = (int)l;
                return true;
            case short s:
                result = s;
                return true;
            case byte b:
                result = b;
                return true;
            case sbyte sb:
                result = sb;
                return true;
            case ushort us:
                result = us;
                return true;
            case uint ui when ui <= int.MaxValue:
                result = (int)ui;
                return true;
            default:
                return false;
        }
    }

    private static TextLocation FieldIdentifierLocation(StructSymbol structSymbol, FieldSymbol field)
    {
        var decl = structSymbol.Declaration;
        if (decl != null)
        {
            foreach (var fieldSyntax in decl.Fields)
            {
                if (fieldSyntax.Identifier?.Text == field.Name)
                {
                    return fieldSyntax.Identifier.Location;
                }
            }

            return decl.Identifier?.Location ?? default;
        }

        return default;
    }
}
