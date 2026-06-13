// <copyright file="StructLayoutMetadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The resolved <see cref="StructLayoutAttribute"/>-derived layout for a
/// user struct or class declaration (ADR-0093 / issue #759). The binder
/// attaches one instance to a <see cref="StructSymbol"/> when the type
/// carries a well-formed <c>@StructLayout(LayoutKind.…)</c> annotation;
/// the emitter consumes it to pick the right
/// <see cref="System.Reflection.TypeAttributes"/> layout flag and to
/// write a <c>ClassLayout</c> row when <see cref="Pack"/> or
/// <see cref="Size"/> is specified.
/// </summary>
/// <remarks>
/// <para>
/// Only <see cref="LayoutKind.Sequential"/> and <see cref="LayoutKind.Explicit"/>
/// are accepted in v1; <see cref="LayoutKind.Auto"/> is rejected with
/// <c>GS0346</c> because Auto-layout types are not portable across the
/// P/Invoke boundary (the CLR is permitted to reorder Auto-layout
/// fields). See ADR-0093 §1 for the full rationale.
/// </para>
/// <para>
/// When this metadata is <c>null</c>, the emitter falls back to the
/// historical defaults: <see cref="LayoutKind.Sequential"/> for
/// <c>struct</c> and <see cref="LayoutKind.Auto"/> for <c>class</c>.
/// </para>
/// </remarks>
public sealed class StructLayoutMetadata
{
    /// <summary>Initializes a new instance of the <see cref="StructLayoutMetadata"/> class.</summary>
    /// <param name="layout">The validated layout kind (Sequential or Explicit).</param>
    /// <param name="pack">The optional <c>Pack</c> field; null when unspecified.</param>
    /// <param name="size">The optional <c>Size</c> field; null when unspecified.</param>
    public StructLayoutMetadata(LayoutKind layout, int? pack, int? size)
    {
        Layout = layout;
        Pack = pack;
        Size = size;
    }

    /// <summary>Gets the resolved <see cref="LayoutKind"/> for the declaring type.</summary>
    public LayoutKind Layout { get; }

    /// <summary>Gets the optional <c>Pack</c> override (null when unspecified).</summary>
    public int? Pack { get; }

    /// <summary>Gets the optional <c>Size</c> override (null when unspecified).</summary>
    public int? Size { get; }
}
