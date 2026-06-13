// <copyright file="PInvokeBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Helpers for validating and extracting P/Invoke metadata from a function
/// declaration. Recognises both the classic <c>@DllImport</c> shape
/// (ADR-0086 / issue #727) and the modern <c>@LibraryImport</c>
/// source-generator-flavored shape (ADR-0092 / issue #758).
/// </summary>
internal static class PInvokeBinder
{
    /// <summary>
    /// When <paramref name="function"/> carries an <c>@DllImport</c> or
    /// <c>@LibraryImport</c> annotation, validates the shape and produces
    /// a <see cref="PInvokeMetadata"/> attached to the symbol. Reports
    /// GS0322–GS0329 (DllImport) and GS0342–GS0345 (LibraryImport) on any
    /// malformed input.
    /// </summary>
    /// <param name="function">The function symbol being declared.</param>
    /// <param name="syntax">The originating function declaration syntax.</param>
    /// <param name="diagnostics">The diagnostics bag for this binder.</param>
    /// <returns><c>true</c> when the function is a P/Invoke (with or without errors); <c>false</c> when no recognised P/Invoke attribute is present.</returns>
    internal static bool TryAttachPInvokeMetadata(
        FunctionSymbol function,
        FunctionDeclarationSyntax syntax,
        DiagnosticBag diagnostics)
    {
        var dllImport = KnownAttributes.FindDllImport(function.Attributes);
        var libraryImport = KnownAttributes.FindLibraryImport(function.Attributes);
        if (dllImport == null && libraryImport == null)
        {
            return false;
        }

        var identifierLocation = syntax.Identifier.Location;

        // ADR-0092 / issue #758: the two attribute shapes are mutually exclusive.
        if (dllImport != null && libraryImport != null)
        {
            diagnostics.ReportPInvokeMixedDllAndLibraryImport(identifierLocation, function.Name);
        }

        var isLibraryImport = libraryImport != null && dllImport == null;
        var attribute = isLibraryImport ? libraryImport : (dllImport ?? libraryImport);

        // Validate function shape: no body, no instance/static-receiver,
        // no async, no generic, no extension, no ref-return. These rules
        // mirror ADR-0086 §1 / ADR-0092 §1 — the v1 surface area is identical
        // across the two attribute shapes.
        if (syntax.Body != null)
        {
            diagnostics.ReportPInvokeMustNotHaveBody(syntax.Body.Location, function.Name);
        }

        if (function.IsAsync)
        {
            diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, "async functions are not supported");
        }

        if (function.IsGeneric)
        {
            diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, "generic functions are not supported");
        }

        if (function.IsExtension)
        {
            diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, "extension functions are not supported");
        }

        if (function.IsInstanceMethod)
        {
            diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, "instance methods are not supported");
        }

        if (function.IsStatic)
        {
            diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, "members of 'shared' blocks are not supported");
        }

        if (function.ReturnRefKind != RefKind.None)
        {
            diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, "ref-returning functions are not supported");
        }

        // Validate parameter ref-kinds — v1 does not support ref/out/in primitive
        // marshalling (filed as follow-up #728).
        foreach (var parameter in function.Parameters)
        {
            if (parameter.RefKind != RefKind.None)
            {
                diagnostics.ReportDllImportInvalidFunctionShape(identifierLocation, function.Name, $"ref/out/in parameter '{parameter.Name}' is not supported");
            }
        }

        // Validate parameter types against the supported marshalling table.
        // Use the parameter-syntax type-clause location for diagnostics so
        // squiggles land on the offending type, not the function name.
        var parameterSyntaxes = syntax.Parameters;
        var hasStringParameter = false;
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            var parameter = function.Parameters[i];
            if (parameter.Type == TypeSymbol.String)
            {
                hasStringParameter = true;
            }

            if (IsSupportedMarshallingType(parameter.Type))
            {
                continue;
            }

            TextLocation typeLocation = identifierLocation;
            if (i < parameterSyntaxes.Count && parameterSyntaxes[i].Type != null)
            {
                typeLocation = parameterSyntaxes[i].Type.Location;
            }

            diagnostics.ReportPInvokeUnsupportedMarshallingType(typeLocation, parameter.Type?.Name ?? "?");
        }

        var returnIsString = function.Type == TypeSymbol.String;
        if (function.Type != TypeSymbol.Void && !IsSupportedMarshallingType(function.Type))
        {
            var returnLocation = syntax.Type?.Location ?? identifierLocation;
            diagnostics.ReportPInvokeUnsupportedMarshallingType(returnLocation, function.Type?.Name ?? "?");
        }

        // ADR-0092 §4 — the v1 LibraryImport stub generator cannot safely
        // free CLR-owned string returns. Reject them with a tailored
        // diagnostic so users reach for `nint` + `Marshal.PtrToStringUTF8`.
        if (isLibraryImport && returnIsString)
        {
            var returnLocation = syntax.Type?.Location ?? identifierLocation;
            diagnostics.ReportLibraryImportStringReturnNotSupported(returnLocation, function.Name);
        }

        // Extract metadata from the attribute arguments.
        var metadata = isLibraryImport
            ? ExtractLibraryImportMetadata(libraryImport, function, hasStringParameter || returnIsString, diagnostics)
            : ExtractDllImportMetadata(dllImport, syntax, function, diagnostics);
        if (metadata != null)
        {
            function.PInvokeMetadata = metadata;
        }

        return true;
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> is in the v1
    /// supported P/Invoke marshalling set (ADR-0086 §2).
    /// </summary>
    /// <param name="type">The bound parameter or return type.</param>
    /// <returns><c>true</c> when supported.</returns>
    internal static bool IsSupportedMarshallingType(TypeSymbol type)
    {
        if (type == null || type == TypeSymbol.Error)
        {
            // Already reported as a separate diagnostic; don't double-fire.
            return true;
        }

        if (IsSupportedPrimitive(type))
        {
            return true;
        }

        if (type == TypeSymbol.String)
        {
            return true;
        }

        if (type is ByRefTypeSymbol byRef)
        {
            return IsSupportedPrimitive(byRef.PointeeType);
        }

        if (type is SliceTypeSymbol slice)
        {
            return IsSupportedPrimitive(slice.ElementType);
        }

        return false;
    }

    private static bool IsSupportedPrimitive(TypeSymbol type)
    {
        return type == TypeSymbol.Bool
            || type == TypeSymbol.Char
            || type == TypeSymbol.Int8
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

    private static PInvokeMetadata ExtractDllImportMetadata(
        BoundAttribute attribute,
        FunctionDeclarationSyntax syntax,
        FunctionSymbol function,
        DiagnosticBag diagnostics)
    {
        // 1) Required positional library name.
        string libraryName = null;
        if (!attribute.PositionalArguments.IsDefaultOrEmpty
            && attribute.PositionalArguments[0].Value is string s
            && !string.IsNullOrEmpty(s))
        {
            libraryName = s;
        }

        if (libraryName == null)
        {
            diagnostics.ReportDllImportMissingLibraryName(attribute.Syntax.Location);

            // Continue extraction so we can still surface other errors,
            // but return null so the symbol is not flagged as a valid P/Invoke.
            return null;
        }

        // 2) Named arguments.
        string entryPoint = function.Name;
        var charSet = CharSet.Ansi;
        var setLastError = false;
        var callingConvention = CallingConvention.Winapi;
        bool? exactSpelling = null;
        var preserveSig = true;
        bool? bestFitMapping = null;
        bool? throwOnUnmappableChar = null;

        foreach (var named in attribute.NamedArguments)
        {
            var argSyntax = FindNamedArgSyntax(attribute.Syntax, named.Name) ?? attribute.Syntax;
            switch (named.Name)
            {
                case "EntryPoint":
                    if (named.Value is string entryString && !string.IsNullOrEmpty(entryString))
                    {
                        entryPoint = entryString;
                    }
                    else
                    {
                        diagnostics.ReportDllImportInvalidEntryPoint(argSyntax.Location);
                    }

                    break;

                case "CharSet":
                    if (KnownAttributes.TryConvertAttributeEnum<CharSet>(named.Value, out var cs))
                    {
                        charSet = cs;
                    }
                    else
                    {
                        diagnostics.ReportDllImportInvalidCharSet(argSyntax.Location, named.Value?.ToString() ?? "<null>");
                    }

                    break;

                case "SetLastError":
                    if (named.Value is bool sle)
                    {
                        setLastError = sle;
                    }

                    break;

                case "CallingConvention":
                    if (KnownAttributes.TryConvertAttributeEnum<CallingConvention>(named.Value, out var cc))
                    {
                        callingConvention = cc;
                    }
                    else
                    {
                        diagnostics.ReportDllImportInvalidCallingConvention(argSyntax.Location, named.Value?.ToString() ?? "<null>");
                    }

                    break;

                case "ExactSpelling":
                    if (named.Value is bool es)
                    {
                        exactSpelling = es;
                    }

                    break;

                case "PreserveSig":
                    if (named.Value is bool ps)
                    {
                        preserveSig = ps;
                    }

                    break;

                case "BestFitMapping":
                    if (named.Value is bool bfm)
                    {
                        bestFitMapping = bfm;
                    }

                    break;

                case "ThrowOnUnmappableChar":
                    if (named.Value is bool tum)
                    {
                        throwOnUnmappableChar = tum;
                    }

                    break;

                default:
                    // Unknown named arguments fall through silently here;
                    // the attribute-arg binder already reports them via the
                    // generic "no matching property" path.
                    break;
            }
        }

        // ExactSpelling default follows the CLR rule: Auto => true, else false.
        var resolvedExactSpelling = exactSpelling ?? (charSet == CharSet.Auto);

        return new PInvokeMetadata(
            libraryName,
            entryPoint,
            charSet,
            setLastError,
            callingConvention,
            resolvedExactSpelling,
            preserveSig,
            bestFitMapping,
            throwOnUnmappableChar);
    }

    /// <summary>
    /// Extracts the resolved metadata for an <c>@LibraryImport</c> attribute
    /// (ADR-0092 / issue #758). <c>@LibraryImport</c> exposes a deliberately
    /// smaller surface than <c>@DllImport</c>: only <c>LibraryName</c>
    /// (positional), <c>EntryPoint</c>, <c>SetLastError</c>,
    /// <c>StringMarshalling</c>, and <c>StringMarshallingCustomType</c>.
    /// The remaining knobs (CharSet, CallingConvention, PreserveSig,
    /// BestFitMapping, ThrowOnUnmappableChar) are not part of the attribute
    /// — calling-convention overrides live on a separate
    /// <c>@UnmanagedCallConv</c> attribute, which v1 does not support.
    /// </summary>
    private static PInvokeMetadata ExtractLibraryImportMetadata(
        BoundAttribute attribute,
        FunctionSymbol function,
        bool hasStringSurface,
        DiagnosticBag diagnostics)
    {
        // 1) Required positional library name.
        string libraryName = null;
        if (!attribute.PositionalArguments.IsDefaultOrEmpty
            && attribute.PositionalArguments[0].Value is string s
            && !string.IsNullOrEmpty(s))
        {
            libraryName = s;
        }

        if (libraryName == null)
        {
            diagnostics.ReportDllImportMissingLibraryName(attribute.Syntax.Location);
            return null;
        }

        // 2) Named arguments. Defaults match LibraryImportAttribute itself:
        //    EntryPoint defaults to the function name, StringMarshalling
        //    defaults to Custom (which fails GS0344 for string-bearing
        //    signatures because no explicit encoding was given).
        string entryPoint = function.Name;
        var setLastError = false;
        var stringMarshalling = StringMarshalling.Custom;

        foreach (var named in attribute.NamedArguments)
        {
            var argSyntax = FindNamedArgSyntax(attribute.Syntax, named.Name) ?? attribute.Syntax;
            switch (named.Name)
            {
                case "EntryPoint":
                    if (named.Value is string entryString && !string.IsNullOrEmpty(entryString))
                    {
                        entryPoint = entryString;
                    }
                    else
                    {
                        diagnostics.ReportDllImportInvalidEntryPoint(argSyntax.Location);
                    }

                    break;

                case "SetLastError":
                    if (named.Value is bool sle)
                    {
                        setLastError = sle;
                    }

                    break;

                case "StringMarshalling":
                    if (KnownAttributes.TryConvertAttributeEnum<StringMarshalling>(named.Value, out var sm))
                    {
                        stringMarshalling = sm;
                    }
                    else
                    {
                        diagnostics.ReportLibraryImportInvalidStringMarshalling(argSyntax.Location, named.Value?.ToString() ?? "<null>");
                    }

                    break;

                case "StringMarshallingCustomType":
                    // v1: accepted in source for forward compatibility but the
                    // stub generator does not honour it. A future ADR will lift
                    // this restriction once custom marshaller types are bound.
                    break;

                default:
                    // Unknown named arguments fall through to the attribute-arg
                    // binder's "no matching property" diagnostic (GS0207).
                    break;
            }
        }

        // ADR-0092 §3 — a string-bearing signature requires an explicit
        // StringMarshalling value of Utf8 or Utf16. Custom is reserved for
        // a future ADR; Custom + a string parameter is an error today.
        if (hasStringSurface
            && stringMarshalling != StringMarshalling.Utf8
            && stringMarshalling != StringMarshalling.Utf16)
        {
            diagnostics.ReportLibraryImportRequiresStringMarshalling(function.Declaration.Identifier.Location, function.Name);
        }

        return new PInvokeMetadata(
            libraryName,
            entryPoint,
            CharSet.None,
            setLastError,
            CallingConvention.Winapi,
            exactSpelling: true,
            preserveSig: true,
            bestFitMapping: null,
            throwOnUnmappableChar: null,
            isLibraryImport: true,
            stringMarshalling: stringMarshalling);
    }

    private static SyntaxNode FindNamedArgSyntax(AnnotationSyntax annotation, string name)
    {
        if (annotation?.Arguments == null)
        {
            return null;
        }

        foreach (var arg in annotation.Arguments)
        {
            if (arg is NamedArgumentExpressionSyntax named && named.NameToken.Text == name)
            {
                return named;
            }
        }

        return null;
    }
}
