// <copyright file="ReferenceTypeNameIndex.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable

/// The full-type-name index that a (cref:ReferenceResolver) builds over its assemblies.
/// Each name maps to the index of the first assembly, in search order, that defines or forwards it.
/// @remarks The resolver reads an assembly with no image (a host runtime assembly) through reflection.
/// (cref:LoadedTypes) keeps the types that this read found.
/// A lookup returns them as they were found.
internal class ReferenceTypeNameIndex {
    internal init(
        names Dictionary[string, int32],
        loadedTypes Dictionary[string, Type],
        namespaces Lazy[ImmutableHashSet[string]],
        arityInsensitiveNames Lazy[Dictionary[string, ImmutableArray[string]]],
        emittedNames Lazy[Dictionary[string, string]]
    ) {
        Names = names
        LoadedTypes = loadedTypes
        Namespaces = namespaces
        ArityInsensitiveNames = arityInsensitiveNames
        EmittedNames = emittedNames
    }

    /// Gets the full-name to declaring-assembly-index map.
    internal prop Names Dictionary[string, int32]

    /// Gets the types found by reflection, for the names whose assembly had no image.
    internal prop LoadedTypes Dictionary[string, Type]

    /// Gets the namespace prefixes present in (cref:Names).
    internal prop Namespaces Lazy[ImmutableHashSet[string]]

    /// Gets the arity-insensitive type name groups over (cref:Names).
    internal prop ArityInsensitiveNames Lazy[Dictionary[string, ImmutableArray[string]]]

    /// Gets the emitted-to-raw type name map over (cref:Names).
    internal prop EmittedNames Lazy[Dictionary[string, string]]
}
