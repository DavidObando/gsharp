// <copyright file="ManagedReferenceTypeReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>A persistent managed-reference type with an optional readonly modifier.</summary>
public sealed class ManagedReferenceTypeReference : GTypeReference
{
    /// <summary>Initializes a new instance of the <see cref="ManagedReferenceTypeReference"/> class.</summary>
    /// <param name="elementType">The invariant referent type.</param>
    /// <param name="isReadOnly">Whether only readonly borrows are permitted.</param>
    public ManagedReferenceTypeReference(GTypeReference elementType, bool isReadOnly = false)
    {
        ElementType = elementType;
        IsReadOnly = isReadOnly;
    }

    /// <summary>Gets the referent type.</summary>
    public GTypeReference ElementType { get; }

    /// <summary>Gets a value indicating whether the handle is readonly.</summary>
    public bool IsReadOnly { get; }
}
