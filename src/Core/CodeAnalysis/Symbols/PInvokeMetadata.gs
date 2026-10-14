// <copyright file="PInvokeMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Reflection
import System.Runtime.InteropServices

/// The resolved attribute knobs for a P/Invoke function declaration —
/// either the classic `@DllImport` form (ADR-0086 / issue #727) or
/// the source-generator-shaped `@LibraryImport` form (ADR-0092 /
/// issue #758). One instance is attached to a (cref:FunctionSymbol)
/// by the declaration binder when the function carries a well-formed
/// annotation; the emitter consumes it either to write a single
/// `ImplMap` row (DllImport) or to generate an explicit managed
/// marshalling stub that calls a hidden blittable P/Invoke inner method
/// (LibraryImport).
data class PInvokeMetadata : IEquatable[PInvokeMetadata] {
    /// Initializes a new instance of the (cref:PInvokeMetadata) class.
    /// @param libraryName The unmanaged library name (required positional argument).
    /// @param entryPoint The unmanaged entry-point name, or the function's own name when unset.
    /// @param charSet The marshalling (cref:System.Runtime.InteropServices.CharSet).
    /// @param setLastError Whether the CLR should capture the last OS error after the call.
    /// @param callingConvention The unmanaged (cref:System.Runtime.InteropServices.CallingConvention).
    /// @param exactSpelling When false, the CLR may probe for an `A`/`W` suffixed entry point per
    /// [`charSet`](paramref).
    /// @param preserveSig When false, the CLR replaces an HRESULT return with a thrown exception
    /// (COM-style).
    /// @param bestFitMapping Tri-state best-fit mapping (null when unspecified).
    /// @param throwOnUnmappableChar Tri-state unmappable-character behavior (null when unspecified).
    /// @param isLibraryImport When `true`, this function was declared with `@LibraryImport` (ADR-0092) and
    /// the emitter should generate an explicit managed stub instead of a single ImplMap row.
    /// @param stringMarshalling The (cref:System.Runtime.InteropServices.StringMarshalling) mode that
    /// drives explicit string marshalling for `@LibraryImport` stubs. Ignored when
    /// [`isLibraryImport`](paramref) is `false`.
    init(
        libraryName string,
        entryPoint string,
        charSet CharSet,
        setLastError bool,
        callingConvention CallingConvention,
        exactSpelling bool,
        preserveSig bool,
        bestFitMapping bool?,
        throwOnUnmappableChar bool?,
        isLibraryImport bool = false,
        stringMarshalling StringMarshalling = StringMarshalling.Custom
    ) {
        LibraryName = libraryName
        EntryPoint = entryPoint
        CharSet = charSet
        SetLastError = setLastError
        CallingConvention = callingConvention
        ExactSpelling = exactSpelling
        PreserveSig = preserveSig
        BestFitMapping = bestFitMapping
        ThrowOnUnmappableChar = throwOnUnmappableChar
        IsLibraryImport = isLibraryImport
        StringMarshalling = stringMarshalling
    }

    /// Gets the unmanaged library name. Required.
    prop LibraryName string {
        get;
    }

    /// Gets the unmanaged entry-point name. Defaults to the G# function's identifier.
    prop EntryPoint string {
        get;
    }

    /// Gets the marshalling (cref:System.Runtime.InteropServices.CharSet).
    prop CharSet CharSet {
        get;
    }

    /// Gets a value indicating whether the CLR should capture `GetLastError` after the call.
    prop SetLastError bool {
        get;
    }

    /// Gets the unmanaged (cref:System.Runtime.InteropServices.CallingConvention).
    prop CallingConvention CallingConvention {
        get;
    }

    /// Gets a value indicating whether the entry point name is matched exactly (no `A`/`W` suffix probing).
    prop ExactSpelling bool {
        get;
    }

    /// Gets a value indicating whether the original signature is preserved (vs HRESULT-to-exception
    /// translation).
    prop PreserveSig bool {
        get;
    }

    /// Gets the optional `BestFitMapping` override (null when unspecified).
    prop BestFitMapping bool? {
        get;
    }

    /// Gets the optional `ThrowOnUnmappableChar` override (null when unspecified).
    prop ThrowOnUnmappableChar bool? {
        get;
    }

    /// Gets a value indicating whether this metadata was produced from an
    /// `@LibraryImport` attribute (ADR-0092 / issue #758) rather than
    /// the classic `@DllImport` shape. When `true`, the emitter
    /// generates an explicit marshalling stub that wraps a hidden blittable
    /// inner P/Invoke method; when `false`, the emitter writes a
    /// single PinvokeImpl method with an ImplMap row pointing at a
    /// ModuleRef (the ADR-0086 path).
    prop IsLibraryImport bool {
        get;
    }

    /// Gets the (cref:System.Runtime.InteropServices.StringMarshalling)
    /// mode driving string parameter / return marshalling for
    /// `@LibraryImport` stubs (ADR-0092). Defaults to
    /// (cref:System.Runtime.InteropServices.StringMarshalling.Custom)
    /// when no value was supplied; the binder rejects programs that use a
    /// `string` parameter without an explicit
    /// (cref:System.Runtime.InteropServices.StringMarshalling.Utf8)
    /// or (cref:System.Runtime.InteropServices.StringMarshalling.Utf16)
    /// value. Ignored when (cref:IsLibraryImport) is `false`.
    prop StringMarshalling StringMarshalling {
        get;
    }
}
