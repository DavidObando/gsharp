// <copyright file="MetadataTypeNameReader.gs" company="GSharp">
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

/// Reads the full names of the types of an assembly from its metadata tables.
/// No (cref:Type) is created.
/// @remarks The defined names are the names that `Assembly.GetTypes()` reports through a
/// (cref:System.Reflection.MetadataLoadContext). They follow the type-definition table
/// without the `<Module>` row. A nested type is spelled `Outer+Inner`.
/// The forwarded names are the top-level exported types that forward to another assembly.
/// Reflection reports a forward only when its target loads.
/// It then adds the public nested types of the type that the forward resolves to.
/// The caller checks the target and adds the nested types (see (cref:ReferenceResolver)).
/// The reader refuses an image with a name that reflection escapes.
/// The caller then reads that assembly through reflection.
internal shared class MetadataTypeNameReader {
    // Characters that reflection escapes with a backslash in Type.FullName.
    private let SpecialNameCharacters[]char = []char{',', '+', '&', '*', '[', ']', '\\'}

    /// Reads the defined and forwarded type names of [`image`](paramref).
    /// @param image The assembly image.
    /// @param defined Receives the defined type names, in order.
    /// @param forwarded Receives each forwarded type name with the simple name of the
    /// assembly it is forwarded to, in order.
    /// @param publicNested Receives, for each defined type, the names of its public nested types
    /// in table order.
    /// @returns `true` when the image was read completely. `false` means the
    /// caller must enumerate the assembly through reflection and discard the
    /// collections, whose contents are then incomplete.
    func TryReadNames(
        image[]uint8,
        defined List[string],
        forwarded List[KeyValuePair[string, string]],
        publicNested Dictionary[string, List[string]]
    ) bool {
        try {
            using let peReader = PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image))
            if !peReader.HasMetadata {
                return false
            }
            let reader = peReader.GetMetadataReader()
            for handle in reader.TypeDefinitions {
                // Row 1 is the `<Module>` pseudo-type that holds global members;
                // reflection does not list it.
                if MetadataTokens.GetRowNumber(handle) == 1 {
                    continue
                }
                let name = SpellDefinition(reader, handle)
                if name == nil {
                    return false
                }
                defined.Add(name)
                let definition = reader.GetTypeDefinition(handle)
                let isNested = !definition.GetDeclaringType().IsNil
                let visibility = definition.Attributes & TypeAttributes.VisibilityMask
                if isNested && visibility == TypeAttributes.NestedPublic {
                    let outer = name.Substring(0, name.LastIndexOf('+'))
                    if !publicNested.TryGetValue(outer, out var children) {
                        children = List[string]()
                        publicNested[outer] = children
                    }
                    children.Add(name)
                }
            }
            for handle in reader.ExportedTypes {
                let target = ForwardTarget(reader, handle)
                if target == nil {
                    continue
                }
                let name = SpellExport(reader, handle)
                if name == nil {
                    return false
                }
                forwarded.Add(KeyValuePair[string, string](name, target))
            }
            return true
        } catch (ex Exception) when ex is BadImageFormatException || ex is InvalidOperationException {
            return false
        }
    }

    // Returns the simple name of the assembly that a top-level exported type forwards to.
    // Returns null for other exports. A nested export is not listed on its own,
    // because reflection reaches it through the type that encloses it.
    private func ForwardTarget(reader MetadataReader, handle ExportedTypeHandle) string? {
        let implementation = reader.GetExportedType(handle).Implementation
        if implementation.Kind != HandleKind.AssemblyReference {
            return nil
        }
        return reader.GetString(reader.GetAssemblyReference(cast[AssemblyReferenceHandle](implementation)).Name)
    }

    // Returns the reflection spelling of a type definition, or null when a name
    // needs escaping.
    private func SpellDefinition(reader MetadataReader, handle TypeDefinitionHandle) string? {
        let definition = reader.GetTypeDefinition(handle)
        let typeName = reader.GetString(definition.Name)
        if NeedsEscaping(typeName) {
            return nil
        }
        let declaring = definition.GetDeclaringType()
        if !declaring.IsNil {
            let outer = SpellDefinition(reader, declaring)
            return if outer == nil {
                nil
            } else {
                outer + "+" + typeName
            }
        }
        return Qualify(reader.GetString(definition.Namespace), typeName)
    }

    // Returns the reflection spelling of a top-level exported type, or null when
    // a name needs escaping.
    private func SpellExport(reader MetadataReader, handle ExportedTypeHandle) string? {
        let exported = reader.GetExportedType(handle)
        let typeName = reader.GetString(exported.Name)
        if NeedsEscaping(typeName) {
            return nil
        }
        return Qualify(reader.GetString(exported.Namespace), typeName)
    }

    private func Qualify(namespaceName string, typeName string) string? {
        if NeedsEscaping(namespaceName) {
            return nil
        }
        return if namespaceName.Length == 0 {
            typeName
        } else {
            namespaceName + "." + typeName
        }
    }

    private func NeedsEscaping(name string) bool -> name.IndexOfAny(SpecialNameCharacters) >= 0
}
