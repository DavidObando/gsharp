// <copyright file="NativeSliceTypeReference.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// A native shared-storage slice, distinct from an exact CLR array.
class NativeSliceTypeReference : GTypeReference {
    /// Initializes a new instance of the (cref:NativeSliceTypeReference) class.
    /// @param elementType The invariant element type.
    /// @param isReadOnly Whether elements are accessible only through readonly references.
    init(elementType GTypeReference, isReadOnly bool = false) {
        ElementType = elementType
        IsReadOnly = isReadOnly
    }

    /// Gets the invariant element type.
    prop ElementType GTypeReference {
        get;
    }

    /// Gets a value indicating whether the descriptor grants readonly access.
    prop IsReadOnly bool {
        get;
    }
}
