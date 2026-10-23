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
import System.Text

/// Reads the full names of the types of an assembly from its metadata tables.
/// No (cref:Type) is created.
/// @remarks The defined names are the names that `Assembly.GetTypes()` reports through a
/// (cref:System.Reflection.MetadataLoadContext). They follow the type-definition table
/// without the `<Module>` row. A nested type is spelled `Outer+Inner`.
/// The forwarded names are the top-level exported types that forward to another assembly.
/// Reflection reports a forward only when its target loads.
/// It then adds the public nested types of the type that the forward resolves to.
/// The caller checks the target and adds the nested types (see (cref:ReferenceResolver)).
/// (cref:TryReadNames) refuses an image with a name that reflection escapes.
/// The caller then reads that assembly through reflection.
/// (cref:ReadAllNames) spells such a name as reflection does and never refuses (ADR-0209).
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
            return ReadCore(peReader.GetMetadataReader(), defined, forwarded, publicNested, nil, false)
        } catch (ex Exception) when ex is BadImageFormatException || ex is InvalidOperationException {
            return false
        }
    }

    /// Reads the defined and forwarded type names of an open metadata reader.
    /// A name that reflection escapes is spelled as reflection spells it (ADR-0209 section 5).
    /// @param reader The metadata reader of the assembly.
    /// @param defined Receives the defined type names, in order.
    /// @param forwarded Receives each forwarded type name with the simple name of the
    /// assembly it is forwarded to, in order.
    /// @param publicNested Receives, for each defined type, the names of its public nested types
    /// in table order.
    /// @param definedHandles Receives the type definition of each defined name, in the same order.
    /// @exception BadImageFormatException The metadata is malformed.
    func ReadAllNames(
        reader MetadataReader,
        defined List[string],
        forwarded List[KeyValuePair[string, string]],
        publicNested Dictionary[string, List[string]],
        definedHandles List[TypeDefinitionHandle]
    ) {
        ReadCore(reader, defined, forwarded, publicNested, definedHandles, true)
    }

    /// Spells an identifier as reflection spells it in a full name.
    /// Reflection puts a backslash before each of the characters `,+&*[]\`.
    /// @param name The metadata name of a type or a namespace.
    /// @returns The escaped name.
    func Escape(name string) string {
        if name.IndexOfAny(SpecialNameCharacters) < 0 {
            return name
        }
        let builder = StringBuilder(name.Length + 2)
        for c in name {
            if Array.IndexOf(SpecialNameCharacters, c) >= 0 {
                builder.Append('\\')
            }
            builder.Append(c)
        }
        return builder.ToString()
    }

    /// Spells the full name of a top-level type as reflection spells it.
    /// @param namespaceName The metadata namespace, empty for the global namespace.
    /// @param typeName The metadata type name.
    /// @returns The escaped full name.
    func QualifyEscaped(namespaceName string, typeName string) string {
        return if namespaceName.Length == 0 {
            Escape(typeName)
        } else {
            Escape(namespaceName) + "." + Escape(typeName)
        }
    }

    // Reads all names. With spellEscaped set, every name is spelled and the result is always true.
    // Otherwise the result is false for a name that reflection escapes.
    private func ReadCore(
        reader MetadataReader,
        defined List[string],
        forwarded List[KeyValuePair[string, string]],
        publicNested Dictionary[string, List[string]],
        definedHandles List[TypeDefinitionHandle]?,
        spellEscaped bool
    ) bool {
        for handle in reader.TypeDefinitions {
            // Row 1 is the `<Module>` pseudo-type that holds global members;
            // reflection does not list it.
            if MetadataTokens.GetRowNumber(handle) == 1 {
                continue
            }
            let name = SpellDefinition(reader, handle, spellEscaped)
            if name == nil {
                return false
            }
            defined.Add(name)
            definedHandles?.Add(handle)
            let definition = reader.GetTypeDefinition(handle)
            let declaring = definition.GetDeclaringType()
            let visibility = definition.Attributes & TypeAttributes.VisibilityMask
            if !declaring.IsNil && visibility == TypeAttributes.NestedPublic {
                // The enclosing name is spelled again: a '+' inside an escaped name is not a separator.
                let outer = SpellDefinition(reader, declaring, spellEscaped)
                if outer == nil {
                    return false
                }
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
            let name = SpellExport(reader, handle, spellEscaped)
            if name == nil {
                return false
            }
            forwarded.Add(KeyValuePair[string, string](name, target))
        }
        return true
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
    // needs escaping and the caller does not spell escaped names.
    private func SpellDefinition(reader MetadataReader, handle TypeDefinitionHandle, spellEscaped bool) string? {
        let definition = reader.GetTypeDefinition(handle)
        let typeName = Identifier(reader.GetString(definition.Name), spellEscaped)
        if typeName == nil {
            return nil
        }
        let declaring = definition.GetDeclaringType()
        if !declaring.IsNil {
            let outer = SpellDefinition(reader, declaring, spellEscaped)
            return if outer == nil {
                nil
            } else {
                outer + "+" + typeName
            }
        }
        return Qualify(reader.GetString(definition.Namespace), typeName, spellEscaped)
    }

    // Returns the reflection spelling of a top-level exported type, or null when
    // a name needs escaping and the caller does not spell escaped names.
    private func SpellExport(reader MetadataReader, handle ExportedTypeHandle, spellEscaped bool) string? {
        let exported = reader.GetExportedType(handle)
        let typeName = Identifier(reader.GetString(exported.Name), spellEscaped)
        if typeName == nil {
            return nil
        }
        return Qualify(reader.GetString(exported.Namespace), typeName, spellEscaped)
    }

    // Takes the already spelled type name.
    private func Qualify(namespaceName string, typeName string, spellEscaped bool) string? {
        let spelledNamespace = Identifier(namespaceName, spellEscaped)
        if spelledNamespace == nil {
            return nil
        }
        return if spelledNamespace.Length == 0 {
            typeName
        } else {
            spelledNamespace + "." + typeName
        }
    }

    private func Identifier(name string, spellEscaped bool) string? {
        if spellEscaped {
            return Escape(name)
        }
        return if NeedsEscaping(name) {
            nil
        } else {
            name
        }
    }

    private func NeedsEscaping(name string) bool -> name.IndexOfAny(SpecialNameCharacters) >= 0
}
