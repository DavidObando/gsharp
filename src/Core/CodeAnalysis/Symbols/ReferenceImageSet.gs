// <copyright file="ReferenceImageSet.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection.Metadata
import System.Threading

/// One assembly image that a (cref:ReferenceImageSet) is built from.
internal class ReferenceImage {
    internal init(bytes[]uint8, path string?, isSearched bool) {
        Bytes = bytes
        Path = path
        IsSearched = isSearched
    }

    /// Gets the image bytes.
    internal prop Bytes[]uint8

    /// Gets the path that the image was read from, or `null`.
    internal prop Path string?

    /// Gets whether the name index of the set covers the image.
    internal prop IsSearched bool
}

/// The immutable set of reference images that handle-backed symbols read (ADR-0209 section 5).
/// @remarks The set owns one (cref:MetadataModule) for each image, in reference order.
/// It resolves type references through forwards, interns the missing types and holds the name index and the well-known types.
/// The modules that the name index covers come first, in reference order. A later module is a dependency.
/// A type reference can reach a dependency, but a name lookup does not search it.
/// This is the partition that the `MetadataLoadContext` has today between the loaded assemblies and the resolver closure.
/// When two modules have the same simple name, the first one owns the name (ADR-0209 section 9).
internal class ReferenceImageSet {
    // A type reference whose resolutionScope chain is deeper than this is malformed.
    private let MaximumNesting int32 = 64

    private let modulesByName Dictionary[string, MetadataModule]
    private let indexedNames Lazy[IndexedNames]
    private let missingTypes ConcurrentDictionary[MissingTypeKey, MissingTypeSymbol] = ConcurrentDictionary[
        MissingTypeKey,
        MissingTypeSymbol
    ]()

    /// Creates a set. The searched images must come before the others.
    /// @param images The images in reference order.
    /// @exception BadImageFormatException An image is not an assembly with metadata.
    /// @exception ArgumentException A searched image follows an image that is not searched.
    internal init(images ImmutableArray[ReferenceImage]) {
        let modules = ImmutableArray.CreateBuilder[MetadataModule](images.Length)
        var searched = 0
        var sawDependency = false
        for var i = 0; i < images.Length; i++ {
            let image = images[i]
            if image.IsSearched {
                if sawDependency {
                    throw ArgumentException("A searched image follows a dependency image.", nameof(images))
                }
                searched++
            } else {
                sawDependency = true
            }
            modules.Add(MetadataModule(this, i, image.Bytes, image.Path, image.IsSearched))
        }
        Modules = modules.MoveToImmutable()
        SearchedCount = searched
        modulesByName = Dictionary[string, MetadataModule](Modules.Length, StringComparer.OrdinalIgnoreCase)
        for module in Modules {
            modulesByName.TryAdd(module.Identity.Name, module)
        }
        indexedNames = Lazy[IndexedNames](BuildIndexedNames, LazyThreadSafetyMode.ExecutionAndPublication)
        WellKnown = WellKnownTypes(this)
    }

    /// Gets the modules in reference order.
    internal prop Modules ImmutableArray[MetadataModule]

    /// Gets the number of leading modules that the name index covers.
    internal prop SearchedCount int32

    /// Gets the well-known types of the set.
    internal prop WellKnown WellKnownTypes

    /// Finds the module that owns an assembly simple name. The first module with the name owns it.
    /// @returns The module, or `null` when the set has no assembly with the name.
    internal func FindModule(simpleName string) MetadataModule? {
        return if modulesByName.TryGetValue(simpleName, out var module) {
            module
        } else {
            nil
        }
    }

    /// Gets the names that the name index holds for a searched module, in the order that reflection reports them.
    /// These are the defined names, then each name that the module forwards to a type that loads,
    /// each followed by the public nested types of the type that it resolves to.
    internal func GetIndexedNames(moduleIndex int32) List[string] -> indexedNames.Value.NamesByModule[moduleIndex]

    /// Finds the type definition that a full name denotes in the name index.
    /// The first searched module that defines or forwards the name owns it.
    /// @param fullName The full name in the spelling of reflection.
    /// @returns The definition after forwards, or `null` when no searched module has the name.
    internal func TryResolveName(fullName string) ResolvedTypeReference? {
        let snapshot = indexedNames.Value
        if !snapshot.Index.TryGetValue(fullName, out var moduleIndex) {
            return nil
        }
        let module = Modules[moduleIndex]
        if module.TryGetDefinition(fullName, out var handle) {
            return ResolvedTypeReference(module, handle)
        }
        return if snapshot.Forwarded[moduleIndex].TryGetValue(fullName, out var resolved) {
            resolved
        } else {
            nil
        }
    }

    /// Finds the type definition that a well-known name denotes.
    /// The first searched module that supplies the name owns it, unless the type is not public.
    /// Then the first public type of that name in a searched module wins, because a dependency can embed
    /// an internal copy of a framework type (#3445, #4233). With no public copy, the first writer stands.
    /// @remarks The grant of `InternalsVisibleTo` to the consumer is not applied here.
    /// It belongs to the compilation, not to the set (ADR-0209 section 7c).
    internal func TryResolveVisibleName(fullName string) ResolvedTypeReference? {
        let first = TryResolveName(fullName)
        if first == nil {
            return nil
        }
        let firstModule = first.Module
        if firstModule == nil || firstModule.IsExternallyVisible(first.Handle) {
            return first
        }
        for var i = 0; i < SearchedCount; i++ {
            let candidate = ResolveInModule(Modules[i], first.FullName, HashSet[string](StringComparer.Ordinal))
            if candidate == nil {
                continue
            }
            let candidateModule = candidate.Module
            if candidateModule != nil && candidateModule.IsExternallyVisible(candidate.Handle) {
                return candidate
            }
        }
        return first
    }

    /// Finds a type that one named assembly defines, after the forwards of that assembly.
    internal func TryResolveNameInAssembly(simpleName string, fullName string) ResolvedTypeReference? {
        let module = FindModule(simpleName)
        if module == nil {
            return nil
        }
        return ResolveInModule(module, fullName, HashSet[string](StringComparer.Ordinal))
    }

    /// Gets the interned missing type for a pair of assembly identity and full name.
    internal func GetMissing(identity AssemblyIdentity?, fullName string) MissingTypeSymbol -> missingTypes.GetOrAdd(
        MissingTypeKey(identity, fullName),
        (key MissingTypeKey) -> MissingTypeSymbol(key.Identity, key.FullName)
    )

    /// Resolves a type reference row of a module to the definition it names, or to a missing type.
    /// Forwards are followed to the definition. The module that forwarded the type never appears in the answer.
    internal func ResolveTypeReference(
        module MetadataModule,
        handle TypeReferenceHandle
    ) ResolvedTypeReference -> ResolveTypeReference(module, handle, 0)

    private func ResolveTypeReference(
        module MetadataModule,
        handle TypeReferenceHandle,
        depth int32
    ) ResolvedTypeReference -> module.GetOrAddTypeReference(
        handle,
        () -> ResolveTypeReferenceCore(module, handle, depth)
    )

    private func ResolveTypeReferenceCore(
        module MetadataModule,
        handle TypeReferenceHandle,
        depth int32
    ) ResolvedTypeReference {
        let reader = module.Reader
        let reference = reader.GetTypeReference(handle)
        let typeName = MetadataTypeNameReader.Escape(reader.GetString(reference.Name))
        let resolutionScope = reference.ResolutionScope
        if resolutionScope.Kind == HandleKind.AssemblyReference {
            let target = AssemblyIdentity.FromReference(
                reader.GetAssemblyReference(cast[AssemblyReferenceHandle](resolutionScope))
            )
            let fullName = MetadataTypeNameReader.QualifyEscaped(reader.GetString(reference.Namespace), typeName)
            return ResolveInAssembly(target, fullName)
        }
        if resolutionScope.Kind == HandleKind.TypeReference {
            // A nested type: resolve the enclosing type first, then look for the nested name in the same module.
            if depth >= MaximumNesting {
                return ResolvedTypeReference(GetMissing(module.Identity, typeName))
            }
            let enclosing = ResolveTypeReference(module, cast[TypeReferenceHandle](resolutionScope), depth + 1)
            let nestedName = enclosing.FullName + "+" + typeName
            if enclosing.Module is {} enclosingModule {
                return if enclosingModule.TryGetDefinition(nestedName, out var nested) {
                    ResolvedTypeReference(enclosingModule, nested)
                } else {
                    ResolvedTypeReference(GetMissing(enclosingModule.Identity, nestedName))
                }
            }
            return ResolvedTypeReference(GetMissing(enclosing.Missing?.AssemblyIdentity, nestedName))
        }
        let ownName = MetadataTypeNameReader.QualifyEscaped(reader.GetString(reference.Namespace), typeName)
        if resolutionScope.Kind == HandleKind.ModuleDefinition && module.TryGetDefinition(ownName, out var own) {
            return ResolvedTypeReference(module, own)
        }
        // A module reference (multi-module assembly) and a nil resolutionScope (exported type) are not importable.
        return ResolvedTypeReference(GetMissing(module.Identity, ownName))
    }

    private func ResolveInAssembly(target AssemblyIdentity, fullName string) ResolvedTypeReference {
        let module = FindModule(target.Name)
        if module != nil {
            let found = ResolveInModule(module, fullName, HashSet[string](StringComparer.Ordinal))
            if found != nil {
                return found
            }
        }
        return ResolvedTypeReference(GetMissing(target, fullName))
    }

    // Finds the definition of a name in a module or, through its forwards, in another module.
    private func ResolveInModule(
        module MetadataModule,
        fullName string,
        visiting HashSet[string]
    ) ResolvedTypeReference? {
        if module.TryGetDefinition(fullName, out var handle) {
            return ResolvedTypeReference(module, handle)
        }
        // A cycle of forwards ends the search.
        if !visiting.Add(module.Identity.Name) {
            return nil
        }
        if module.GetForwardTargets(fullName) is {} targets {
            for target in targets {
                let next = FindModule(target)
                if next != nil {
                    let found = ResolveInModule(next, fullName, visiting)
                    if found != nil {
                        return found
                    }
                }
            }
        }
        return nil
    }

    private func BuildIndexedNames() IndexedNames {
        let index = Dictionary[string, int32](StringComparer.Ordinal)
        let namesByModule = List[List[string]](SearchedCount)
        let forwarded = List[Dictionary[string, ResolvedTypeReference]](SearchedCount)
        for var i = 0; i < SearchedCount; i++ {
            let module = Modules[i]
            let names = List[string](module.DefinedNames)
            let resolutions = Dictionary[string, ResolvedTypeReference](StringComparer.Ordinal)
            for forward in module.Forwarded {
                // The forwarded name counts only when the target loads and declares it, as reflection reports.
                let target = FindModule(forward.Value)
                if target == nil {
                    continue
                }
                let declaring = ResolveInModule(target, forward.Key, HashSet[string](StringComparer.Ordinal))
                if declaring?.Module is {} declaringModule {
                    AddWithPublicNestedTypes(declaringModule, forward.Key, names, resolutions)
                }
            }
            namesByModule.Add(names)
            forwarded.Add(resolutions)
        }
        // The first module in reference order owns a name.
        for var i = 0; i < namesByModule.Count; i++ {
            for name in namesByModule[i] {
                index.TryAdd(name, i)
            }
        }
        return IndexedNames(index, namesByModule, forwarded)
    }

    private func AddWithPublicNestedTypes(
        declaring MetadataModule,
        name string,
        destination List[string],
        resolutions Dictionary[string, ResolvedTypeReference]
    ) {
        destination.Add(name)
        if declaring.TryGetDefinition(name, out var handle) {
            resolutions.TryAdd(name, ResolvedTypeReference(declaring, handle))
        }
        if declaring.GetPublicNestedTypes(name) is {} children {
            for child in children {
                AddWithPublicNestedTypes(declaring, child, destination, resolutions)
            }
        }
    }
}

/// The name index of a (cref:ReferenceImageSet): each name maps to the first searched module that defines or forwards it.
internal class IndexedNames {
    internal init(
        index Dictionary[string, int32],
        namesByModule List[List[string]],
        forwarded List[Dictionary[string, ResolvedTypeReference]]
    ) {
        Index = index
        NamesByModule = namesByModule
        Forwarded = forwarded
    }

    internal prop Index Dictionary[string, int32]
    internal prop NamesByModule List[List[string]]
    internal prop Forwarded List[Dictionary[string, ResolvedTypeReference]]
}

/// The key of an interned missing type.
internal class MissingTypeKey : IEquatable[MissingTypeKey] {
    internal init(identity AssemblyIdentity?, fullName string) {
        Identity = identity
        FullName = fullName
    }

    internal prop Identity AssemblyIdentity?

    internal prop FullName string

    func Equals(other MissingTypeKey?) bool -> other != nil && string.Equals(
        FullName,
        other.FullName,
        StringComparison.Ordinal
    ) &&
        object.Equals(Identity, other.Identity)

    override func Equals(obj object?) bool -> obj is MissingTypeKey other && Equals(other)

    override func GetHashCode() int32 -> HashCode.Combine(
        StringComparer.Ordinal.GetHashCode(FullName),
        Identity?.GetHashCode() ?? 0
    )
}
