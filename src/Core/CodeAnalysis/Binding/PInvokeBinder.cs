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

        // ADR-0094 / issue #760: parameter ref-kinds (`ref`/`out`/`in`) are now
        // supported on P/Invoke declarations. The pointee type must be
        // byref-marshalling-compatible (blittable primitive or a blittable
        // struct). Validation runs inside the per-parameter loop below so
        // GS0352 anchors to the offending type clause.

        // Validate parameter types against the supported marshalling table.
        // Use the parameter-syntax type-clause location for diagnostics so
        // squiggles land on the offending type, not the function name.
        var parameterSyntaxes = syntax.Parameters;
        var hasStringParameter = false;
        var blittableDetector = new BlittableDetector();
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            var parameter = function.Parameters[i];
            if (parameter.Type == TypeSymbol.String)
            {
                hasStringParameter = true;
            }

            TextLocation typeLocation = identifierLocation;
            if (i < parameterSyntaxes.Count && parameterSyntaxes[i].Type != null)
            {
                typeLocation = parameterSyntaxes[i].Type.Location;
            }

            // ADR-0094 / issue #760: a ref/out/in parameter passes the
            // declared type by managed pointer; the runtime marshals it as
            // `T*` for the unmanaged callee, so the pointee must be
            // blittable. Struct pointees route through the existing GS0349
            // path; everything else (string / object / nullable / etc.)
            // routes through the new GS0352 diagnostic with a tailored
            // message. ParameterSymbol keeps the pointee type in `Type`
            // (the RefKind on the symbol is what makes the parameter a
            // byref); we re-form the ByRefTypeSymbol here so the rule
            // lives in a single helper.
            if (parameter.RefKind != RefKind.None)
            {
                ValidateByRefPInvokeParameter(parameter, ByRefTypeSymbol.Get(parameter.Type), typeLocation, blittableDetector, diagnostics);
                continue;
            }

            // ADR-0093 §3 / §4: struct values and (layout-annotated) class
            // references are validated separately so the binder can issue
            // the tailored GS0349 "not blittable" message rather than the
            // generic GS0323. Pointers to structs (`*S`) likewise route
            // through the blittable check.
            if (IsStructOrPointerToStruct(parameter.Type, out var structType))
            {
                if (!blittableDetector.IsBlittable(structType))
                {
                    diagnostics.ReportPInvokeNonBlittableType(typeLocation, structType.Name);
                }

                continue;
            }

            if (IsSupportedMarshallingType(parameter.Type))
            {
                continue;
            }

            diagnostics.ReportPInvokeUnsupportedMarshallingType(typeLocation, parameter.Type?.Name ?? "?");
        }

        var returnIsString = function.Type == TypeSymbol.String;
        if (function.Type != TypeSymbol.Void)
        {
            var returnLocation = syntax.Type?.Location ?? identifierLocation;
            if (IsStructOrPointerToStruct(function.Type, out var returnStruct))
            {
                if (returnStruct.IsClass)
                {
                    // ADR-0093 §4 — classes are not supported as P/Invoke
                    // return values; the user must declare a struct or
                    // return `nint` for opaque handles.
                    diagnostics.ReportPInvokeClassReturnNotSupported(returnLocation, returnStruct.Name);
                }
                else if (!blittableDetector.IsBlittable(returnStruct))
                {
                    diagnostics.ReportPInvokeNonBlittableType(returnLocation, returnStruct.Name);
                }
            }
            else if (!IsSupportedMarshallingType(function.Type))
            {
                diagnostics.ReportPInvokeUnsupportedMarshallingType(returnLocation, function.Type?.Name ?? "?");
            }
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
            // ADR-0094 / issue #760: byref pointees must be blittable. The
            // call site (PInvokeBinder loop) already routes byref parameters
            // through ValidateByRefPInvokeParameter for a tailored
            // diagnostic; this fallback applies when classification is
            // requested from an ad hoc context. Restrict to the strict
            // blittable-primitive set so `ref bool` / `ref char` do not
            // sneak through.
            return IsBlittablePrimitive(byRef.PointeeType);
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

    /// <summary>
    /// ADR-0094 / issue #760: the strict blittable-primitive set permitted
    /// as a byref pointee on a P/Invoke parameter. Excludes <c>bool</c>
    /// and <c>char</c> because their unmanaged representation depends on
    /// the surrounding <c>CharSet</c> / <c>MarshalAs</c> annotation, which
    /// v1 does not surface for byref slots — accepting them silently would
    /// produce inconsistent bit-widths across platforms.
    /// </summary>
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

    /// <summary>
    /// ADR-0094 / issue #760: validates a single P/Invoke parameter whose
    /// ref-kind is <c>ref</c>, <c>out</c>, or <c>in</c>. The pointee type
    /// must be one of:
    /// <list type="bullet">
    /// <item>A blittable primitive (<c>int8…int64</c>, <c>uint8…uint64</c>,
    /// <c>nint</c>, <c>nuint</c>, <c>float32</c>, <c>float64</c>).</item>
    /// <item>A user struct whose blittability is established by
    /// <see cref="BlittableDetector"/> (issued GS0349 otherwise).</item>
    /// </list>
    /// Every other pointee — <c>bool</c>, <c>char</c>, <c>string</c>,
    /// <c>object</c>, <c>decimal</c>, slices, sequences, nullable types —
    /// is rejected with the new GS0352 diagnostic. <c>ref string</c> is the
    /// canonical user mistake the diagnostic message coaches against
    /// (recommend an explicit <c>nint</c> + Marshal.PtrToStringUTF8 round
    /// trip instead).
    /// </summary>
    private static void ValidateByRefPInvokeParameter(
        ParameterSymbol parameter,
        ByRefTypeSymbol byRef,
        TextLocation typeLocation,
        BlittableDetector blittableDetector,
        DiagnosticBag diagnostics)
    {
        var pointee = byRef.PointeeType;
        if (pointee == null || pointee == TypeSymbol.Error)
        {
            return;
        }

        if (IsBlittablePrimitive(pointee))
        {
            return;
        }

        if (pointee is StructSymbol pointeeStruct)
        {
            if (!blittableDetector.IsBlittable(pointeeStruct))
            {
                diagnostics.ReportPInvokeNonBlittableType(typeLocation, pointeeStruct.Name);
            }

            return;
        }

        diagnostics.ReportPInvokeNonBlittableByRefPointee(typeLocation, parameter.Name, pointee.Name);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> is either a user
    /// <see cref="StructSymbol"/> directly, or a pointer (<c>*S</c>) to
    /// one. The matched struct symbol is returned via
    /// <paramref name="structSymbol"/>. ADR-0093 / issue #759: this
    /// classifier separates the struct / class marshalling path from the
    /// generic <see cref="IsSupportedMarshallingType"/> set so the
    /// blittability check can produce a tailored diagnostic.
    /// </summary>
    private static bool IsStructOrPointerToStruct(TypeSymbol type, out StructSymbol structSymbol)
    {
        if (type is StructSymbol direct)
        {
            structSymbol = direct;
            return true;
        }

        if (type is ByRefTypeSymbol byRef && byRef.PointeeType is StructSymbol pointee)
        {
            structSymbol = pointee;
            return true;
        }

        structSymbol = null;
        return false;
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
