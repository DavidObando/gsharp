// <copyright file="ConstructedMetadataTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Immutable

/// A generic type definition closed over type arguments (ADR-0209 section 5, "Constructions").
/// @remarks A (cref:ReferenceImageSet) interns one object for each definition and each list of argument objects.
/// The arguments are symbols, so a source type or a type parameter can be an argument.
internal class ConstructedMetadataTypeSymbol : TypeSymbol {
    internal init(definition MetadataTypeSymbol, typeArguments ImmutableArray[TypeSymbol]) : base(definition.Name) {
        Definition = definition
        TypeArguments = typeArguments
    }

    /// Gets the generic definition.
    internal prop Definition MetadataTypeSymbol

    /// Gets the type arguments, in order.
    internal prop TypeArguments ImmutableArray[TypeSymbol]
}
