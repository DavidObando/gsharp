// <copyright file="MetadataArrayTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// A rank-one array of an imported signature, length-free (ADR-0209 section 6, row "Array").
/// @remarks It is not (cref:ArrayTypeSymbol), the fixed-length source array, and not (cref:SliceTypeSymbol).
internal class MetadataArrayTypeSymbol : TypeSymbol {
    internal init(elementType TypeSymbol, isVector bool) : base(
        elementType.Name + if isVector {
            "[]"
        } else {
            "[*]"
        }
    ) {
        ElementType = elementType
        IsVector = isVector
    }

    /// Gets whether this is a vector (`SZARRAY`). A rank-one `ARRAY` is not: it keeps its bounds and is a distinct type.
    internal prop IsVector bool

    /// Gets the element type.
    internal prop ElementType TypeSymbol
}
