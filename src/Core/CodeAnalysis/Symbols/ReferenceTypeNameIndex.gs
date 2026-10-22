// <copyright file="ReferenceTypeNameIndex.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic

/// The full-type-name index that a (cref:ReferenceResolver) builds over its assemblies.
/// Each name maps to the index of the first assembly, in search order, that defines or forwards it.
/// @remarks The resolver reads an assembly with no image (a host runtime assembly) through reflection.
/// (cref:LoadedTypes) keeps the types that this read found.
/// A lookup returns them as they were found.
internal class ReferenceTypeNameIndex {
    internal init(names Dictionary[string, int32], loadedTypes Dictionary[string, Type]) {
        Names = names
        LoadedTypes = loadedTypes
    }

    /// Gets the full-name to declaring-assembly-index map.
    internal prop Names Dictionary[string, int32]

    /// Gets the types found by reflection, for the names whose assembly had no image.
    internal prop LoadedTypes Dictionary[string, Type]
}
