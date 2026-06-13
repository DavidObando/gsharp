// <copyright file="PInvokeMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The resolved attribute knobs for a P/Invoke function declaration —
/// either the classic <c>@DllImport</c> form (ADR-0086 / issue #727) or
/// the source-generator-shaped <c>@LibraryImport</c> form (ADR-0092 /
/// issue #758). One instance is attached to a <see cref="FunctionSymbol"/>
/// by the declaration binder when the function carries a well-formed
/// annotation; the emitter consumes it either to write a single
/// <c>ImplMap</c> row (DllImport) or to generate an explicit managed
/// marshalling stub that calls a hidden blittable P/Invoke inner method
/// (LibraryImport).
/// </summary>
public sealed class PInvokeMetadata
{
    /// <summary>Initializes a new instance of the <see cref="PInvokeMetadata"/> class.</summary>
    /// <param name="libraryName">The unmanaged library name (required positional argument).</param>
    /// <param name="entryPoint">The unmanaged entry-point name, or the function's own name when unset.</param>
    /// <param name="charSet">The marshalling <see cref="System.Runtime.InteropServices.CharSet"/>.</param>
    /// <param name="setLastError">Whether the CLR should capture the last OS error after the call.</param>
    /// <param name="callingConvention">The unmanaged <see cref="System.Runtime.InteropServices.CallingConvention"/>.</param>
    /// <param name="exactSpelling">When false, the CLR may probe for an <c>A</c>/<c>W</c> suffixed entry point per <paramref name="charSet"/>.</param>
    /// <param name="preserveSig">When false, the CLR replaces an HRESULT return with a thrown exception (COM-style).</param>
    /// <param name="bestFitMapping">Tri-state best-fit mapping (null when unspecified).</param>
    /// <param name="throwOnUnmappableChar">Tri-state unmappable-character behavior (null when unspecified).</param>
    /// <param name="isLibraryImport">When <c>true</c>, this function was declared with <c>@LibraryImport</c> (ADR-0092) and the emitter should generate an explicit managed stub instead of a single ImplMap row.</param>
    /// <param name="stringMarshalling">The <see cref="System.Runtime.InteropServices.StringMarshalling"/> mode that drives explicit string marshalling for <c>@LibraryImport</c> stubs. Ignored when <paramref name="isLibraryImport"/> is <c>false</c>.</param>
    public PInvokeMetadata(
        string libraryName,
        string entryPoint,
        System.Runtime.InteropServices.CharSet charSet,
        bool setLastError,
        System.Runtime.InteropServices.CallingConvention callingConvention,
        bool exactSpelling,
        bool preserveSig,
        bool? bestFitMapping,
        bool? throwOnUnmappableChar,
        bool isLibraryImport = false,
        System.Runtime.InteropServices.StringMarshalling stringMarshalling = System.Runtime.InteropServices.StringMarshalling.Custom)
    {
        LibraryName = libraryName;
        EntryPoint = entryPoint;
        CharSet = charSet;
        SetLastError = setLastError;
        CallingConvention = callingConvention;
        ExactSpelling = exactSpelling;
        PreserveSig = preserveSig;
        BestFitMapping = bestFitMapping;
        ThrowOnUnmappableChar = throwOnUnmappableChar;
        IsLibraryImport = isLibraryImport;
        StringMarshalling = stringMarshalling;
    }

    /// <summary>Gets the unmanaged library name. Required.</summary>
    public string LibraryName { get; }

    /// <summary>Gets the unmanaged entry-point name. Defaults to the G# function's identifier.</summary>
    public string EntryPoint { get; }

    /// <summary>Gets the marshalling <see cref="System.Runtime.InteropServices.CharSet"/>.</summary>
    public System.Runtime.InteropServices.CharSet CharSet { get; }

    /// <summary>Gets a value indicating whether the CLR should capture <c>GetLastError</c> after the call.</summary>
    public bool SetLastError { get; }

    /// <summary>Gets the unmanaged <see cref="System.Runtime.InteropServices.CallingConvention"/>.</summary>
    public System.Runtime.InteropServices.CallingConvention CallingConvention { get; }

    /// <summary>Gets a value indicating whether the entry point name is matched exactly (no <c>A</c>/<c>W</c> suffix probing).</summary>
    public bool ExactSpelling { get; }

    /// <summary>Gets a value indicating whether the original signature is preserved (vs HRESULT-to-exception translation).</summary>
    public bool PreserveSig { get; }

    /// <summary>Gets the optional <c>BestFitMapping</c> override (null when unspecified).</summary>
    public bool? BestFitMapping { get; }

    /// <summary>Gets the optional <c>ThrowOnUnmappableChar</c> override (null when unspecified).</summary>
    public bool? ThrowOnUnmappableChar { get; }

    /// <summary>
    /// Gets a value indicating whether this metadata was produced from an
    /// <c>@LibraryImport</c> attribute (ADR-0092 / issue #758) rather than
    /// the classic <c>@DllImport</c> shape. When <c>true</c>, the emitter
    /// generates an explicit marshalling stub that wraps a hidden blittable
    /// inner P/Invoke method; when <c>false</c>, the emitter writes a
    /// single PinvokeImpl method with an ImplMap row pointing at a
    /// ModuleRef (the ADR-0086 path).
    /// </summary>
    public bool IsLibraryImport { get; }

    /// <summary>
    /// Gets the <see cref="System.Runtime.InteropServices.StringMarshalling"/>
    /// mode driving string parameter / return marshalling for
    /// <c>@LibraryImport</c> stubs (ADR-0092). Defaults to
    /// <see cref="System.Runtime.InteropServices.StringMarshalling.Custom"/>
    /// when no value was supplied; the binder rejects programs that use a
    /// <c>string</c> parameter without an explicit
    /// <see cref="System.Runtime.InteropServices.StringMarshalling.Utf8"/>
    /// or <see cref="System.Runtime.InteropServices.StringMarshalling.Utf16"/>
    /// value. Ignored when <see cref="IsLibraryImport"/> is <c>false</c>.
    /// </summary>
    public System.Runtime.InteropServices.StringMarshalling StringMarshalling { get; }
}
