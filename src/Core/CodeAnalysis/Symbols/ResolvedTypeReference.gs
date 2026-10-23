// <copyright file="ResolvedTypeReference.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Reflection.Metadata

/// The answer to a type reference or a type name: a type definition in a module, or a missing type.
/// @remarks Forwards are already followed. The facade that forwarded the type never appears here.
/// This is the name-level result of ADR-0209 PR 1. The type symbol of a definition comes with the decoder in a later PR.
internal class ResolvedTypeReference {
    /// Creates the answer for a type definition.
    internal init(module MetadataModule, handle TypeDefinitionHandle) {
        Module = module
        Handle = handle
        FullName = module.GetFullName(handle) ?? string.Empty
    }

    /// Creates the answer for a type that no module supplies.
    internal init(missing MissingTypeSymbol) {
        Missing = missing
        FullName = missing.FullName
    }

    /// Gets the module that defines the type, or `null` for a missing type.
    internal prop Module MetadataModule?

    /// Gets the type definition in (cref:Module).
    internal prop Handle TypeDefinitionHandle

    /// Gets the missing type, or `null` when a module defines the type.
    internal prop Missing MissingTypeSymbol?

    /// Gets the full name in the spelling of reflection.
    internal prop FullName string

    /// Gets whether a module defines the type.
    internal prop IsResolved bool -> Missing == nil
}
