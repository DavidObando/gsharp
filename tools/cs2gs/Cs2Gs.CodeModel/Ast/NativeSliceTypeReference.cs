// <copyright file="NativeSliceTypeReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>A native shared-storage slice, distinct from an exact CLR array.</summary>
public sealed class NativeSliceTypeReference : GTypeReference
{
    /// <summary>Initializes a new instance of the <see cref="NativeSliceTypeReference"/> class.</summary>
    /// <param name="elementType">The invariant element type.</param>
    /// <param name="isReadOnly">Whether elements are accessible only through readonly references.</param>
    public NativeSliceTypeReference(GTypeReference elementType, bool isReadOnly = false)
    {
        ElementType = elementType;
        IsReadOnly = isReadOnly;
    }

    /// <summary>Gets the invariant element type.</summary>
    public GTypeReference ElementType { get; }

    /// <summary>Gets a value indicating whether the descriptor grants readonly access.</summary>
    public bool IsReadOnly { get; }
}
