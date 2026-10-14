// <copyright file="ManagedReferenceTypeReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// A persistent managed-reference type with an optional readonly modifier.
class ManagedReferenceTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:ManagedReferenceTypeReference) class.
    /// @param elementType The invariant referent type.
    /// @param isReadOnly Whether only readonly borrows are permitted.
    init(elementType GTypeReference, isReadOnly bool = false) {
        ElementType = elementType
        IsReadOnly = isReadOnly
    }

    /// Gets the referent type.
    prop ElementType GTypeReference {
        get;
    }

    /// Gets a value indicating whether the handle is readonly.
    prop IsReadOnly bool {
        get;
    }
}
