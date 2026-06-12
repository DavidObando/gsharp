// <copyright file="PInvokeMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The resolved attribute knobs for a P/Invoke (`@DllImport`) function
/// declaration (ADR-0086 / issue #727). One instance is attached to a
/// <see cref="FunctionSymbol"/> by the declaration binder when the function
/// is annotated with a well-formed <c>@DllImport(...)</c>; the emitter
/// consumes it to build the corresponding <c>ImplMap</c> row.
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
    public PInvokeMetadata(
        string libraryName,
        string entryPoint,
        System.Runtime.InteropServices.CharSet charSet,
        bool setLastError,
        System.Runtime.InteropServices.CallingConvention callingConvention,
        bool exactSpelling,
        bool preserveSig,
        bool? bestFitMapping,
        bool? throwOnUnmappableChar)
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
}
