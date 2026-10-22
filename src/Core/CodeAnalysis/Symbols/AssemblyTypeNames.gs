// <copyright file="AssemblyTypeNames.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Linq

/// The type full names that one assembly adds to a reference set.
/// @remarks (cref:Defined) holds the names in the order that reflection reports them.
/// For an assembly read from its metadata image, (cref:Forwarded) lists the forwarded names.
/// The resolver checks their targets, and (cref:Types) is empty.
/// For an assembly read through reflection, (cref:Defined) already holds the forwarded names that load.
/// (cref:Types) then holds the (cref:Type) of each name.
internal class AssemblyTypeNames {
    private var definedSet HashSet[string]?
    private let definedCount int32

    internal init(
        defined List[string],
        forwarded List[KeyValuePair[string, string]],
        types List[Type],
        publicNested Dictionary[string, List[string]],
        imageOf Func[string, ([]uint8)?]?
    ) {
        Defined = defined
        definedCount = defined.Count
        Forwarded = forwarded
        Types = types
        PublicNested = publicNested
        ImageOf = imageOf
    }

    /// Gets the defined names, and for a reflection read also the forwarded ones.
    internal prop Defined List[string]

    /// Gets each forwarded name with the simple name of the assembly it is forwarded to.
    internal prop Forwarded List[KeyValuePair[string, string]]

    /// Gets the types for the names read through reflection, parallel to (cref:Defined).
    internal prop Types List[Type]

    /// Gets the public nested types of each defined type, in table order.
    internal prop PublicNested Dictionary[string, List[string]]

    /// Gets the lookup of an image by assembly simple name, in the load context of this assembly.
    internal prop ImageOf Func[string, ([]uint8)?]?

    /// Gets whether the assembly itself declares a type with this name.
    internal func Declares(name string) bool {
        // Use only the names that the assembly defines.
        // The resolver adds forwarded names to Defined later.
        // They must not make this assembly look like the declarer of a forwarded type.
        let set = definedSet ?? HashSet[string](Defined.Take(definedCount), StringComparer.Ordinal)
        definedSet = set
        return set.Contains(name)
    }
}
