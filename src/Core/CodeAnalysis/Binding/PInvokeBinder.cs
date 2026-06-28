#nullable disable

// <copyright file="PInvokeBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // Elements should appear in the correct order — the new ADR-0096 helpers (SupportedUnmanagedTypes, TryAttachMarshalAsMetadata, …) are grouped together at the bottom for diff locality; keeping the layout means StyleCop would reject the field-after-method order.
#pragma warning disable SA1202 // 'public' / 'internal' members should come before 'private' — the new ADR-0096 internal helper (ReportMarshalAsOnNonPInvokeFunction) lives next to its private helpers so the file stays one feature per block.

using System;
using System.Collections.Generic;
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
/// source-generator-flavored shape (ADR-0092 / issue #758). Also owns the
/// per-parameter <c>@MarshalAs(UnmanagedType.…)</c> validation pass
/// (ADR-0096 / issue #762).
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

        // ADR-0086 / issue #1203: a P/Invoke declared inside a class's
        // `shared { }` block (function.IsStatic) is the canonical G# spelling
        // of a C# `static extern [DllImport]` member. The CLR represents every
        // P/Invoke as a static method, so a `shared`-block extern is precisely
        // the supported shape — it is no longer rejected here.
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

            // ADR-0096 / issue #762: extract and validate the optional
            // `@MarshalAs(UnmanagedType.…)` override before the per-shape
            // checks below. The marshal-as metadata never relaxes the
            // shape rules (`ref string` is still rejected by the byref
            // path), it only overrides how a supported parameter type
            // is marshalled at the unmanaged boundary.
            TryAttachMarshalAsMetadata(parameter, i, function, isLibraryImport, parameterSyntaxes, diagnostics);

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

            // ADR-0095 / issue #761: delegate-typed parameters must carry
            // the `@UnmanagedFunctionPointer` attribute on the delegate
            // declaration. The CLR keeps the delegate alive for the duration
            // of the call, so the caller is responsible for rooting the
            // delegate beyond the call site (typically by keeping the
            // assigned local in scope or in a field). FunctionPointerType
            // parameters are accepted directly — they are raw `IntPtr` /
            // `nint`-sized values in the metadata blob (FNPTR).
            if (parameter.Type is DelegateTypeSymbol delegateParam)
            {
                if (KnownAttributes.FindUnmanagedFunctionPointer(delegateParam.Attributes) == null)
                {
                    diagnostics.ReportPInvokeDelegateMissingUnmanagedFunctionPointer(typeLocation, parameter.Name, delegateParam.Name);
                }

                continue;
            }

            if (parameter.Type is FunctionPointerTypeSymbol)
            {
                continue;
            }

            // ADR-0086 §2 / issue #1208: SafeHandle (and derived types such as
            // SafeFileHandle, SafeWaitHandle) marshal as managed handle
            // wrappers — the CLR marshaller performs the handle ref-count /
            // lifetime bookkeeping automatically. Accept them as a by-value
            // parameter; this guard takes precedence over the struct / class
            // and generic unsupported-type rejections below.
            if (IsSafeHandleType(parameter.Type))
            {
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

            // ADR-0095 / issue #761: a delegate return is rejected because
            // the v1 runtime cannot synthesize a managed wrapper for an
            // arbitrary native function pointer without knowing its
            // ownership / lifetime contract. The caller should declare the
            // return as `unmanaged[CC] (...) -> R` or `nint` and use
            // `Marshal.GetDelegateForFunctionPointer` manually.
            if (IsSafeHandleType(function.Type))
            {
                // ADR-0086 §2 / issue #1208: SafeHandle return — the CLR
                // marshaller constructs the managed wrapper and assumes
                // ownership of the native handle. This guard precedes the
                // class-return / unsupported-type rejections so an imported
                // BCL handle type (e.g. SafeFileHandle) is never misclassified.
            }
            else if (function.Type is DelegateTypeSymbol returnDelegate)
            {
                diagnostics.ReportPInvokeDelegateReturnNotSupported(returnLocation, returnDelegate.Name);
            }
            else if (function.Type is FunctionPointerTypeSymbol)
            {
                // FNPTR return is accepted directly.
            }
            else if (IsStructOrPointerToStruct(function.Type, out var returnStruct))
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

        if (IsSafeHandleType(type))
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

        // ADR-0122 / issue #1014: an unmanaged raw pointer `*T` (CLR
        // ELEMENT_TYPE_PTR) marshals as a native pointer when its pointee is a
        // blittable primitive (or another pointer). This is the plain-`*T`
        // P/Invoke parameter path (e.g. `void* pBuffer`, `int* pRead`).
        // ADR-0122 §3 / issue #1033: a true `*void` (C# `void*`, the canonical
        // Win32 opaque-buffer parameter) likewise marshals as a native pointer.
        if (type is PointerTypeSymbol pointer)
        {
            // ADR-0122 §4 / issue #1034: a pointer to a blittable user/value
            // struct (`*Point`) marshals as a native pointer (ELEMENT_TYPE_PTR
            // over the struct's TypeDef/TypeRef). Pointee legality is already
            // gated at type-binding time (GS0398), so any surviving struct
            // pointee here is a legal blittable value struct.
            return TypeSymbol.IsVoidPointer(type)
                || IsBlittablePrimitive(pointer.PointeeType)
                || pointer.PointeeType is PointerTypeSymbol
                || pointer.PointeeType is StructSymbol { IsClass: false }
                || pointer.PointeeType?.ClrType is { IsValueType: true };
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

    /// <summary>
    /// ADR-0086 §2 / issue #1208: returns <c>true</c> when
    /// <paramref name="type"/> is
    /// <c>System.Runtime.InteropServices.SafeHandle</c> or any type deriving
    /// from it (e.g. <c>Microsoft.Win32.SafeHandles.SafeFileHandle</c>,
    /// <c>Microsoft.Win32.SafeHandles.SafeWaitHandle</c>). <c>SafeHandle</c> is
    /// a managed reference type that the CLR marshaller special-cases for
    /// P/Invoke: it performs the handle ref-count / lifetime management
    /// automatically and accepts the type as both a parameter and a return
    /// value. <c>SafeHandle</c> is neither blittable nor a pointer, so it must
    /// bypass the struct / pointer marshalling checks. Detection walks the CLR
    /// base-type chain on the symbol's <see cref="TypeSymbol.ClrType"/> and
    /// compares the full name, so it works for imported BCL handle types loaded
    /// through a <c>MetadataLoadContext</c>. A <see cref="NullableTypeSymbol"/>
    /// wrapper is unwrapped first so <c>SafeFileHandle?</c> is still recognised.
    /// Only <c>SafeHandle</c> and its subclasses are accepted — arbitrary
    /// reference types are not broadened in.
    /// </summary>
    /// <param name="type">The bound parameter or return type.</param>
    /// <returns><c>true</c> when the type is or derives from <c>SafeHandle</c>.</returns>
    internal static bool IsSafeHandleType(TypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        var unwrapped = type is NullableTypeSymbol nullable ? nullable.UnderlyingType : type;
        var clrType = unwrapped?.ClrType;
        for (var current = clrType; current != null; current = current.BaseType)
        {
            if (current.FullName == "System.Runtime.InteropServices.SafeHandle")
            {
                return true;
            }
        }

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

    /// <summary>
    /// ADR-0096 / issue #762: the v1 supported <see cref="UnmanagedType"/>
    /// values. Everything else (custom marshallers, <c>IUnknown</c>,
    /// <c>FunctionPtr</c>, …) is rejected with GS0357 so users do not
    /// accidentally encode an unsupported descriptor into the
    /// <c>FieldMarshal</c> blob.
    /// </summary>
    private static readonly HashSet<UnmanagedType> SupportedUnmanagedTypes = new()
    {
        UnmanagedType.LPStr,
        UnmanagedType.LPWStr,
        UnmanagedType.LPUTF8Str,
        UnmanagedType.BStr,
        UnmanagedType.LPArray,
        UnmanagedType.SafeArray,
        UnmanagedType.I1,
        UnmanagedType.U1,
        UnmanagedType.I2,
        UnmanagedType.U2,
        UnmanagedType.I4,
        UnmanagedType.U4,
        UnmanagedType.I8,
        UnmanagedType.U8,
        UnmanagedType.Bool,
        UnmanagedType.VariantBool,
        UnmanagedType.SysInt,
        UnmanagedType.SysUInt,
        UnmanagedType.Struct,
        UnmanagedType.ByValTStr,
        UnmanagedType.ByValArray,
    };

    /// <summary>
    /// ADR-0096 / issue #762: extracts a <c>@MarshalAs(UnmanagedType.…)</c>
    /// annotation from <paramref name="parameter"/>, validates it
    /// against the parameter's G# type, and attaches the resolved
    /// <see cref="MarshalAsMetadata"/> on success. Reports GS0357
    /// (unsupported <see cref="UnmanagedType"/>), GS0358 (type
    /// incompatibility), GS0359 (missing required knob), and GS0360
    /// (rejected on <c>@LibraryImport</c> string surface).
    /// </summary>
    /// <param name="parameter">The parameter symbol being validated.</param>
    /// <param name="parameterIndex">Its zero-based ordinal in the function's parameter list.</param>
    /// <param name="function">The enclosing function symbol.</param>
    /// <param name="isLibraryImport">Whether the enclosing function is a <c>@LibraryImport</c> declaration.</param>
    /// <param name="parameterSyntaxes">The parameter syntaxes; supplies the annotation location for diagnostics.</param>
    /// <param name="diagnostics">The diagnostics bag for this binder.</param>
    private static void TryAttachMarshalAsMetadata(
        ParameterSymbol parameter,
        int parameterIndex,
        FunctionSymbol function,
        bool isLibraryImport,
        SeparatedSyntaxList<ParameterSyntax> parameterSyntaxes,
        DiagnosticBag diagnostics)
    {
        var attr = KnownAttributes.FindMarshalAs(parameter.Attributes);
        if (attr == null)
        {
            return;
        }

        var annotationLocation = attr.Syntax?.Location
            ?? (parameterIndex < parameterSyntaxes.Count ? parameterSyntaxes[parameterIndex].Location : function.Declaration.Identifier.Location);

        // ADR-0096 §3 — @MarshalAs on a string parameter under
        // @LibraryImport collides with the function-wide
        // StringMarshalling knob, which is the canonical per-call lever.
        // Reject with GS0360 rather than silently honour one or the other.
        if (isLibraryImport && parameter.Type == TypeSymbol.String)
        {
            diagnostics.ReportMarshalAsRejected(
                annotationLocation,
                parameter.Name,
                "@LibraryImport string parameters take their encoding from the function-wide StringMarshalling knob; use @LibraryImport(StringMarshalling: StringMarshalling.Utf8) (or Utf16) instead");
            return;
        }

        // 1) Required positional UnmanagedType.
        UnmanagedType unmanagedType;
        if (attr.PositionalArguments.IsDefaultOrEmpty
            || !KnownAttributes.TryConvertAttributeEnum<UnmanagedType>(attr.PositionalArguments[0].Value, out unmanagedType))
        {
            diagnostics.ReportMarshalAsUnsupportedUnmanagedType(
                annotationLocation,
                attr.PositionalArguments.IsDefaultOrEmpty ? "<missing>" : attr.PositionalArguments[0].Value?.ToString() ?? "<null>");
            return;
        }

        if (!SupportedUnmanagedTypes.Contains(unmanagedType))
        {
            diagnostics.ReportMarshalAsUnsupportedUnmanagedType(annotationLocation, unmanagedType.ToString());
            return;
        }

        // 2) Named arguments.
        UnmanagedType? arraySubType = null;
        VarEnum? safeArraySubType = null;
        int? sizeConst = null;
        int? sizeParamIndex = null;
        foreach (var named in attr.NamedArguments)
        {
            switch (named.Name)
            {
                case "ArraySubType":
                    if (KnownAttributes.TryConvertAttributeEnum<UnmanagedType>(named.Value, out var ast))
                    {
                        arraySubType = ast;
                    }

                    break;

                case "SafeArraySubType":
                    if (KnownAttributes.TryConvertAttributeEnum<VarEnum>(named.Value, out var sast))
                    {
                        safeArraySubType = sast;
                    }

                    break;

                case "SizeConst":
                    if (TryReadInt32(named.Value, out var sc) && sc >= 0)
                    {
                        sizeConst = sc;
                    }

                    break;

                case "SizeParamIndex":
                    if (TryReadInt32(named.Value, out var spi) && spi >= 0)
                    {
                        sizeParamIndex = spi;
                    }

                    break;

                default:
                    // Unknown named arguments fall through to the attribute-arg
                    // binder's generic "no matching property" path; v1 ignores
                    // the rest of the MarshalAs surface (IidParameterIndex,
                    // MarshalCookie, MarshalType, MarshalTypeRef).
                    break;
            }
        }

        // 3) Per-UnmanagedType compatibility check against the
        // parameter's G# type. The byref case is handled by stripping
        // the ref-kind: a `@MarshalAs(...)` on `ref int32` validates
        // against `int32` (the pointee), since the marshalling rule
        // applies to the pointed-at unmanaged form.
        var effectiveType = parameter.Type;
        if (!IsCompatibleMarshalAs(unmanagedType, effectiveType))
        {
            diagnostics.ReportMarshalAsIncompatibleType(
                annotationLocation,
                parameter.Name,
                effectiveType?.Name ?? "?",
                unmanagedType.ToString());
            return;
        }

        // 4) Required-knob checks for the size-bearing forms.
        if (unmanagedType == UnmanagedType.ByValTStr && !sizeConst.HasValue)
        {
            diagnostics.ReportMarshalAsMissingRequiredArgument(annotationLocation, parameter.Name, unmanagedType.ToString(), "SizeConst");
            return;
        }

        if (unmanagedType == UnmanagedType.ByValArray && !sizeConst.HasValue)
        {
            diagnostics.ReportMarshalAsMissingRequiredArgument(annotationLocation, parameter.Name, unmanagedType.ToString(), "SizeConst");
            return;
        }

        if (unmanagedType == UnmanagedType.LPArray && !sizeConst.HasValue && !sizeParamIndex.HasValue)
        {
            diagnostics.ReportMarshalAsMissingRequiredArgument(annotationLocation, parameter.Name, unmanagedType.ToString(), "SizeConst or SizeParamIndex");
            return;
        }

        parameter.SetMarshalAsMetadata(new MarshalAsMetadata(unmanagedType, arraySubType, safeArraySubType, sizeConst, sizeParamIndex));
    }

    /// <summary>
    /// ADR-0096 / issue #762: the per-UnmanagedType compatibility
    /// table. Returns <c>true</c> when <paramref name="unmanagedType"/>
    /// is a valid override for a parameter of <paramref name="paramType"/>.
    /// The rules are deliberately strict so misuse surfaces at compile
    /// time rather than at runtime through a <c>TypeLoadException</c>
    /// or a silently corrupted blob.
    /// </summary>
    private static bool IsCompatibleMarshalAs(UnmanagedType unmanagedType, TypeSymbol paramType)
    {
        if (paramType == null || paramType == TypeSymbol.Error)
        {
            return true; // already reported as a separate diagnostic
        }

        switch (unmanagedType)
        {
            case UnmanagedType.LPStr:
            case UnmanagedType.LPWStr:
            case UnmanagedType.LPUTF8Str:
            case UnmanagedType.BStr:
            case UnmanagedType.ByValTStr:
                return paramType == TypeSymbol.String;

            case UnmanagedType.Bool:
            case UnmanagedType.VariantBool:
                return paramType == TypeSymbol.Bool;

            case UnmanagedType.I1:
            case UnmanagedType.U1:
            case UnmanagedType.I2:
            case UnmanagedType.U2:
            case UnmanagedType.I4:
            case UnmanagedType.U4:
            case UnmanagedType.I8:
            case UnmanagedType.U8:
                // Accepted on bool (the canonical "C function takes int
                // but G# parameter is bool" case) and on any integer
                // primitive. Width mismatches are the user's
                // responsibility — the runtime will reinterpret.
                return paramType == TypeSymbol.Bool
                    || IsIntegerOrNativeInteger(paramType)
                    || paramType == TypeSymbol.Char;

            case UnmanagedType.SysInt:
            case UnmanagedType.SysUInt:
                return IsIntegerOrNativeInteger(paramType);

            case UnmanagedType.Struct:
                return paramType is StructSymbol;

            case UnmanagedType.LPArray:
            case UnmanagedType.SafeArray:
            case UnmanagedType.ByValArray:
                return paramType is SliceTypeSymbol;

            default:
                return false;
        }
    }

    private static bool IsIntegerOrNativeInteger(TypeSymbol t)
    {
        return t == TypeSymbol.Int8 || t == TypeSymbol.UInt8
            || t == TypeSymbol.Int16 || t == TypeSymbol.UInt16
            || t == TypeSymbol.Int32 || t == TypeSymbol.UInt32
            || t == TypeSymbol.Int64 || t == TypeSymbol.UInt64
            || t == TypeSymbol.NInt || t == TypeSymbol.NUInt;
    }

    private static bool TryReadInt32(object value, out int result)
    {
        result = 0;
        if (value is int i)
        {
            result = i;
            return true;
        }

        try
        {
            result = Convert.ToInt32(value);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// ADR-0096 / issue #762: walks the parameter symbols of a
    /// non-P/Invoke function and reports GS0360 for every parameter
    /// that carries a <c>@MarshalAs(...)</c> annotation. Called from
    /// <see cref="DeclarationBinder"/> after a function declaration has
    /// been confirmed to lack an <c>@DllImport</c> / <c>@LibraryImport</c>.
    /// </summary>
    /// <param name="syntax">The originating function declaration.</param>
    /// <param name="diagnostics">The diagnostics bag for this binder.</param>
    internal static void ReportMarshalAsOnNonPInvokeFunction(
        FunctionDeclarationSyntax syntax,
        DiagnosticBag diagnostics)
    {
        if (syntax?.Parameters == null)
        {
            return;
        }

        foreach (var ps in syntax.Parameters)
        {
            if (ps.Annotations.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ann in ps.Annotations)
            {
                if (ann.NameSegments.IsDefaultOrEmpty)
                {
                    continue;
                }

                var lastSegment = ann.NameSegments[ann.NameSegments.Length - 1].Text;
                if (lastSegment == "MarshalAs" || lastSegment == "MarshalAsAttribute")
                {
                    diagnostics.ReportMarshalAsRejected(
                        ann.Location,
                        ps.Identifier.Text,
                        "the enclosing function is not a P/Invoke declaration (`@DllImport` or `@LibraryImport`)");
                }
            }
        }
    }
}
