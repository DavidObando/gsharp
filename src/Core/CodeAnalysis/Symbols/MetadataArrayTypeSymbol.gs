// <copyright file="MetadataArrayTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// A single-dimensional array of an imported signature, length-free (ADR-0209 section 6, row "Array").
/// @remarks It is not (cref:ArrayTypeSymbol), the fixed-length source array, and not (cref:SliceTypeSymbol).
internal class MetadataArrayTypeSymbol : TypeSymbol {
    internal init(elementType TypeSymbol) : base(elementType.Name + "[]") {
        ElementType = elementType
    }

    /// Gets the element type.
    internal prop ElementType TypeSymbol
}
