// <copyright file="MetadataModule.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import System.Threading

/// One assembly image of a (cref:ReferenceImageSet), with its metadata reader and its type names.
/// @remarks The module keeps the image bytes (#853: no file handle stays open).
/// The reader is a view over those bytes and copies nothing.
/// ADR-0209 section 5.
internal class MetadataModule {
    private let peReader PEReader
    private let names Lazy[MetadataModuleNames]
    private let isCoreLibrary Lazy[bool]
    // One slot for each TypeRef row. A race publishes one winner (ADR-0209 section 11).
    private let typeReferences[]ResolvedTypeReference?
    // One slot for each TypeDef row, indexed by row number.
    private let typeSymbols[]MetadataTypeSymbol?

    /// Creates a module over an image.
    /// @param set The set that owns the module.
    /// @param index The position of the module in the set.
    /// @param image The assembly image. The module does not change it.
    /// @param path The path that the image was read from, or `null`.
    /// @param isSearched Whether the name index of the set covers the module.
    /// @exception BadImageFormatException The image is not an assembly with metadata.
    internal init(set ReferenceImageSet, index int32, image[]uint8, path string?, isSearched bool) {
        Set = set
        Index = index
        Image = image
        Path = path
        IsSearched = isSearched
        peReader = PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image))
        if !peReader.HasMetadata {
            throw BadImageFormatException("The image has no metadata.")
        }
        Reader = peReader.GetMetadataReader()
        if !Reader.IsAssembly {
            throw BadImageFormatException("The image has no assembly manifest.")
        }
        Identity = AssemblyIdentity.FromDefinition(Reader)
        typeReferences = [Reader.GetTableRowCount(TableIndex.TypeRef) + 1]ResolvedTypeReference?
        typeSymbols = [Reader.GetTableRowCount(TableIndex.TypeDef) + 1]MetadataTypeSymbol?
        names = Lazy[MetadataModuleNames](ReadNames, LazyThreadSafetyMode.ExecutionAndPublication)
        isCoreLibrary = Lazy[bool](DefinesObject, LazyThreadSafetyMode.ExecutionAndPublication)
    }

    /// Gets the set that owns the module.
    internal prop Set ReferenceImageSet

    /// Gets the position of the module in the set.
    internal prop Index int32

    /// Gets the image bytes.
    internal prop Image[]uint8

    /// Gets the path that the image was read from, or `null`.
    internal prop Path string?

    /// Gets whether the name index of the set covers this module.
    /// A module that is not searched is reachable only through a type reference.
    internal prop IsSearched bool

    /// Gets the metadata reader.
    internal prop Reader MetadataReader

    /// Gets the identity of the assembly.
    internal prop Identity AssemblyIdentity

    /// Gets the full names of the types that the assembly defines, in table order, without `<Module>`.
    /// A nested type is spelled `Outer+Inner`, and a name is escaped as reflection escapes it.
    internal prop DefinedNames List[string] -> names.Value.Defined

    /// Gets the full name of a type definition of this module, or `null` for the `<Module>` row.
    internal func GetFullName(handle TypeDefinitionHandle) string? {
        let row = MetadataTokens.GetRowNumber(handle)
        return names.Value.ByRow[row]
    }

    /// Finds a type that the assembly defines.
    internal func TryGetDefinition(fullName string, out handle TypeDefinitionHandle) bool -> names
        .Value
        .ByName
        .TryGetValue(fullName, out handle)

    /// Gets whether this module is a core library: it defines `System.Object`, and that type has no base.
    /// Inside a core library, `System.ValueType` and the other special types are the module's own definitions.
    internal prop IsCoreLibrary bool -> isCoreLibrary.Value

    /// Gets whether outside code can name a type definition: the type and each enclosing type is public.
    /// This ignores `InternalsVisibleTo`, which depends on the consumer (ADR-0209 section 7c).
    internal func IsExternallyVisible(handle TypeDefinitionHandle) bool {
        var current = handle
        while true {
            let definition = Reader.GetTypeDefinition(current)
            let visibility = definition.Attributes & TypeAttributes.VisibilityMask
            if visibility == TypeAttributes.Public {
                return true
            }
            if visibility != TypeAttributes.NestedPublic {
                return false
            }
            current = definition.GetDeclaringType()
        }
    }

    /// Gets the forwarded top-level names with the simple name of the target assembly, in table order.
    internal prop Forwarded List[KeyValuePair[string, string]] -> names.Value.Forwarded

    /// Gets the target assemblies of the forwards of a name, in table order.
    internal func GetForwardTargets(fullName string) List[string]? {
        return if names.Value.ForwardTargets.TryGetValue(fullName, out var targets) {
            targets
        } else {
            nil
        }
    }

    /// Gets the public nested types of a defined type, in table order.
    internal func GetPublicNestedTypes(fullName string) List[string]? {
        return if names.Value.PublicNested.TryGetValue(fullName, out var children) {
            children
        } else {
            nil
        }
    }

    /// Gets the symbol of a type definition row. A race creates one winner, and the loser is dropped unseen.
    internal func GetTypeSymbol(handle TypeDefinitionHandle) MetadataTypeSymbol {
        let row = MetadataTokens.GetRowNumber(handle)
        let existing = typeSymbols[row]
        if existing != nil {
            return existing
        }
        let created = MetadataTypeSymbol(this, handle)
        return Interlocked.CompareExchange(&typeSymbols[row], created, nil) ?? created
    }

    // Reads and publishes the resolution of a TypeRef row.
    internal func GetOrAddTypeReference(
        handle TypeReferenceHandle,
        resolve Func[ResolvedTypeReference]
    ) ResolvedTypeReference {
        let row = MetadataTokens.GetRowNumber(handle)
        let existing = typeReferences[row]
        if existing != nil {
            return existing
        }
        let created = resolve()
        return Interlocked.CompareExchange(&typeReferences[row], created, nil) ?? created
    }

    private func DefinesObject() bool {
        if !names.Value.ByName.TryGetValue("System.Object", out var handle) {
            return false
        }
        return Reader.GetTypeDefinition(handle).BaseType.IsNil
    }

    private func ReadNames() MetadataModuleNames {
        let defined = List[string]()
        let definedHandles = List[TypeDefinitionHandle]()
        let forwarded = List[KeyValuePair[string, string]]()
        let publicNested = Dictionary[string, List[string]](StringComparer.Ordinal)
        MetadataTypeNameReader.ReadAllNames(Reader, defined, forwarded, publicNested, definedHandles)
        let byRow = [Reader.GetTableRowCount(TableIndex.TypeDef) + 1]string?
        let byName = Dictionary[string, TypeDefinitionHandle](defined.Count, StringComparer.Ordinal)
        for var i = 0; i < defined.Count; i++ {
            byRow[MetadataTokens.GetRowNumber(definedHandles[i])] = defined[i]
            // The first definition of a name owns it.
            byName.TryAdd(defined[i], definedHandles[i])
        }
        let targets = Dictionary[string, List[string]](StringComparer.Ordinal)
        for forward in forwarded {
            if !targets.TryGetValue(forward.Key, out var list) {
                list = List[string]()
                targets[forward.Key] = list
            }
            list.Add(forward.Value)
        }
        return MetadataModuleNames(defined, byName, byRow, forwarded, targets, publicNested)
    }
}

/// The type names of one (cref:MetadataModule). The lists keep table order. No code enumerates a dictionary.
internal class MetadataModuleNames {
    internal init(
        defined List[string],
        byName Dictionary[string, TypeDefinitionHandle],
        byRow[]string?,
        forwarded List[KeyValuePair[string, string]],
        forwardTargets Dictionary[string, List[string]],
        publicNested Dictionary[string, List[string]]
    ) {
        Defined = defined
        ByName = byName
        ByRow = byRow
        Forwarded = forwarded
        ForwardTargets = forwardTargets
        PublicNested = publicNested
    }

    internal prop Defined List[string]
    internal prop ByName Dictionary[string, TypeDefinitionHandle]
    internal prop ByRow[]string?
    internal prop Forwarded List[KeyValuePair[string, string]]
    internal prop ForwardTargets Dictionary[string, List[string]]
    internal prop PublicNested Dictionary[string, List[string]]
}
