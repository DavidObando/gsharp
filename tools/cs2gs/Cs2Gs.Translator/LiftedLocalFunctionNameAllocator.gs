// <copyright file="LiftedLocalFunctionNameAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Runtime.CompilerServices
import SystemObject = System.Object

internal class LiftedLocalFunctionNameAllocator {
    private let gate object = SystemObject()
    private let assigned Dictionary[ISymbol, string] = Dictionary[ISymbol, string](SymbolEqualityComparer.Default)
    private let scopedLocalNames Dictionary[(Site SyntaxNode, Ordinal int32, Stem string), string] =
    Dictionary[(Site SyntaxNode, Ordinal int32, Stem string), string]()
    private let usedByType Dictionary[ISymbol, HashSet[string]] = Dictionary[ISymbol, HashSet[string]](
        SymbolEqualityComparer.Default
    )

    // Issue #4302: helper members from one partial document and file-scope
    // import aliases from another meet in the same emitted type. gsc resolves
    // an invocation to the member before the alias, so neither may take the
    // other's name, whichever document is translated first.
    private let helperNames HashSet[string] = HashSet[string](StringComparer.Ordinal)

    private let aliasNames HashSet[string] = HashSet[string](StringComparer.Ordinal)
    private let aliasesByTarget Dictionary[string, List[string]] = Dictionary[string, List[string]](
        StringComparer.Ordinal
    )

    // Issue #4302: synthesized locals can print beside bare helper references
    // in the same emitted type, so the two reserve against each other
    // whichever is allocated first.
    private let localNamesByType Dictionary[ISymbol, HashSet[string]] = Dictionary[ISymbol, HashSet[string]](
        SymbolEqualityComparer.Default
    )
    private let claimedLocalNamesByType Dictionary[ISymbol, HashSet[string]] = Dictionary[ISymbol, HashSet[string]](
        SymbolEqualityComparer.Default
    )
    private let preallocatedOwners HashSet[ISymbol] = HashSet[ISymbol](SymbolEqualityComparer.Default)
    private let backingFieldsByOwner Dictionary[ISymbol, List[(Property IPropertySymbol, Name string)]] = Dictionary[
        ISymbol,
        List[(Property IPropertySymbol, Name string)]
    ](SymbolEqualityComparer.Default)
    private var compilationPreallocated bool

    func TryBeginCompilationPreallocation() bool {
        lock this.gate {
            if this.compilationPreallocated {
                return false
            }
            this.compilationPreallocated = true
            return true
        }
    }

    func TryBeginPreallocation(owner ISymbol?) bool {
        if owner == nil {
            return false
        }
        lock this.gate {
            return this.preallocatedOwners.Add(owner.OriginalDefinition)
        }
    }

    func GetAllocatedBackingFields(owner ISymbol?) IReadOnlyList[(Property IPropertySymbol, Name string)] {
        if owner == nil {
            return Array.Empty[(Property IPropertySymbol, Name string)]()
        }
        lock this.gate {
            if this.backingFieldsByOwner.TryGetValue(owner.OriginalDefinition, out var fields) {
                return fields.ToArray()
            }
            return Array.Empty[(Property IPropertySymbol, Name string)]()
        }
    }

    func ClaimDesignator(emittedOwner INamedTypeSymbol?, stem string, reserved(string) -> bool) string {
        lock this.gate {
            let owner ISymbol? = emittedOwner?.OriginalDefinition
            let helpers HashSet[string]? = if owner != nil && this.usedByType.TryGetValue(owner, out var used) {
                used
            } else {
                default(HashSet[string]?)
            }
            let claimedLocals HashSet[string]? = if owner != nil && this.claimedLocalNamesByType.TryGetValue(
                owner,
                out var claimed
            ) {
                claimed
            } else {
                default(HashSet[string]?)
            }
            var designator = stem
            for var suffix = 2; reserved(designator) || helpers?.Contains(designator) == true ||
                claimedLocals?.Contains(designator) == true; suffix++ {
                designator = "${stem}_$suffix"
            }
            if owner != nil {
                if !this.localNamesByType.TryGetValue(owner, out var localNames) {
                    localNames = HashSet[string](StringComparer.Ordinal)
                    this.localNamesByType.Add(owner, localNames)
                }
                localNames.Add(designator)
            }
            return designator
        }
    }

    func GetOrAllocateScopedLocalName(site SyntaxNode, ordinal int32, stem string, allocate() -> string) string {
        lock this.gate {
            let key = (site, ordinal, stem)
            if this.scopedLocalNames.TryGetValue(key, out var existing) {
                return existing
            }
            let name = allocate()
            this.scopedLocalNames.Add(key, name)
            return name
        }
    }

    func TryClaimLocalName(emittedOwner INamedTypeSymbol?, name string?) bool {
        lock this.gate {
            let owner ISymbol? = emittedOwner?.OriginalDefinition
            if owner == nil {
                return true
            }
            if this.usedByType.TryGetValue(owner, out var helpers) && helpers.Contains(name!!) {
                return false
            }
            if !this.localNamesByType.TryGetValue(owner, out var localNames) {
                localNames = HashSet[string](StringComparer.Ordinal)
                this.localNamesByType.Add(owner, localNames)
            }
            if !localNames.Add(name!!) {
                return false
            }
            if !this.claimedLocalNamesByType.TryGetValue(owner, out var claimedLocals) {
                claimedLocals = HashSet[string](StringComparer.Ordinal)
                this.claimedLocalNamesByType.Add(owner, claimedLocals)
            }
            claimedLocals.Add(name!!)
            return true
        }
    }

    func ReserveLocalName(emittedOwner INamedTypeSymbol?, name string) bool {
        lock this.gate {
            let owner ISymbol? = emittedOwner?.OriginalDefinition
            if owner == nil {
                return true
            }
            if this.usedByType.TryGetValue(owner, out var helpers) && helpers.Contains(name) {
                return false
            }
            if !this.localNamesByType.TryGetValue(owner, out var localNames) {
                localNames = HashSet[string](StringComparer.Ordinal)
                this.localNamesByType.Add(owner, localNames)
            }
            localNames.Add(name)
            if !this.claimedLocalNamesByType.TryGetValue(owner, out var claimedLocals) {
                claimedLocals = HashSet[string](StringComparer.Ordinal)
                this.claimedLocalNamesByType.Add(owner, claimedLocals)
            }
            claimedLocals.Add(name)
            return true
        }
    }

    func ClaimAlias(target string?, baseAlias string, reserved(string) -> bool) string {
        lock this.gate {
            if this.aliasesByTarget.TryGetValue(target!!, out var existing) {
                for existingAlias in existing {
                    if !reserved(existingAlias) {
                        return existingAlias
                    }
                }
            }
            var alias = baseAlias
            for var suffix = 2; reserved(alias) || this.helperNames.Contains(alias) || this.aliasNames.Contains(alias);
                suffix++ {
                alias = "${baseAlias}_$suffix"
            }
            this.aliasNames.Add(alias)
            if existing == nil {
                existing = List[string]()
                this.aliasesByTarget.Add(target!!, existing)
            }
            existing.Add(alias)
            return alias
        }
    }

    func ClaimAlias(baseAlias string, reserved(string) -> bool) string {
        lock this.gate {
            var alias = baseAlias
            for var suffix = 2; reserved(alias) || this.helperNames.Contains(alias) || this.aliasNames.Contains(alias);
                suffix++ {
                alias = "${baseAlias}_$suffix"
            }
            this.aliasNames.Add(alias)
            return alias
        }
    }

    func TryGetAllocated(localFunction IMethodSymbol, out allocated string?) bool {
        lock this.gate {
            return this.assigned.TryGetValue(localFunction.OriginalDefinition, out allocated)
        }
    }

    func Allocate(
        localFunction IMethodSymbol,
        emittedOwner INamedTypeSymbol?,
        occupied ISet[string],
        localName string?,
        unavailable(string?) -> bool
    ) string? {
        lock this.gate {
            let functionKey = localFunction.OriginalDefinition
            if this.assigned.TryGetValue(functionKey, out var assignedName) {
                return assignedName
            }
            let owner ISymbol? = cast[ISymbol](emittedOwner?.OriginalDefinition) ??
                cast[ISymbol](localFunction.ContainingType?.OriginalDefinition) ??
                localFunction.ContainingAssembly
            if !this.usedByType.TryGetValue(owner!!, out var used) {
                used = HashSet[string](StringComparer.Ordinal)
                this.usedByType.Add(owner!!, used)
            }
            this.localNamesByType.TryGetValue(owner!!, out var localNames)
            var candidate string? = localName
            for var suffix = 2; occupied.Contains(candidate!!) || used.Contains(candidate!!) ||
                this.RelatedAssignedNameExists(owner!!, candidate!!, recordAdaptersOnly: true) ||
                this
                .aliasNames
                .Contains(candidate!!) || localNames?.Contains(candidate!!) == true ||
                unavailable(candidate!!);
                suffix++ {
                candidate = "${localName}_$suffix"
            }
            used.Add(candidate!!)
            this.helperNames.Add(candidate!!)
            this.assigned.Add(functionKey, candidate!!)
            return candidate
        }
    }

    func TryReserveMemberName(member IMethodSymbol, name string, out assignedName string) bool {
        lock this.gate {
            let key = (member.PartialDefinitionPart ?? member).OriginalDefinition
            if this.assigned.TryGetValue(key, out assignedName) {
                return true
            }
            assignedName = name
            let owner = key.ContainingType.OriginalDefinition
            if !this.usedByType.TryGetValue(owner, out var used) {
                used = HashSet[string](StringComparer.Ordinal)
                this.usedByType.Add(owner, used)
            }
            if used.Contains(name) || this.RelatedAssignedNameExists(owner, name, recordAdaptersOnly: false) ||
                this
                .aliasNames
                .Contains(name) || (this.localNamesByType.TryGetValue(owner, out var locals) && locals.Contains(name)) {
                return false
            }
            used.Add(name)
            this.helperNames.Add(name)
            this.assigned.Add(key, name)
            return true
        }
    }

    private func RelatedAssignedNameExists(owner ISymbol, name string, recordAdaptersOnly bool) bool {
        if owner is not INamedTypeSymbol type || !this.helperNames.Contains(name) {
            return false
        }
        for pair in this.assigned {
            if pair.Value != name || pair.Key.ContainingType is not INamedTypeSymbol other {
                continue
            }
            if recordAdaptersOnly &&
                !(
                pair.Key is IMethodSymbol{MethodKind: MethodKind.Ordinary} method &&
                    EmittedNameAllocator.IsUserRecordDeconstruct(method)
            ) {
                continue
            }
            if this.IsTypeOrBase(type, other) || this.IsTypeOrBase(other, type) {
                return true
            }
        }
        return false
    }

    private func IsTypeOrBase(type INamedTypeSymbol, expected INamedTypeSymbol) bool {
        var current INamedTypeSymbol? = type
        while current != nil {
            if SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, expected.OriginalDefinition) {
                return true
            }
            current = current.BaseType
        }
        return false
    }

    func AllocateBackingField(property IPropertySymbol?, occupied ISet[string], baseName string) string {
        lock this.gate {
            let propertyKey = property!!.OriginalDefinition
            if this.assigned.TryGetValue(propertyKey, out var assignedName) {
                return assignedName
            }
            let owner ISymbol? = cast[ISymbol](property!!.ContainingType?.OriginalDefinition) ??
                property!!.ContainingAssembly
            if !this.usedByType.TryGetValue(owner!!, out var used) {
                used = HashSet[string](StringComparer.Ordinal)
                this.usedByType.Add(owner!!, used)
            }
            var candidate = baseName
            for var suffix = 2; occupied.Contains(candidate) || used.Contains(candidate); suffix++ {
                candidate = baseName + suffix.ToString()
            }
            used.Add(candidate)
            this.assigned.Add(propertyKey, candidate)
            if !this.backingFieldsByOwner.TryGetValue(owner!!, out var ownerFields) {
                ownerFields = List[(Property IPropertySymbol, Name string)]()
                this.backingFieldsByOwner.Add(owner!!, ownerFields)
            }
            ownerFields.Add((propertyKey, candidate))
            return candidate
        }
    }

    shared {
        private let ByCompilation ConditionalWeakTable[
            Compilation,
            LiftedLocalFunctionNameAllocator
        ] = ConditionalWeakTable[Compilation, LiftedLocalFunctionNameAllocator]()
        func For(compilation Compilation) LiftedLocalFunctionNameAllocator -> ByCompilation.GetValue(
            compilation,
            (_ Compilation) -> LiftedLocalFunctionNameAllocator()
        )
    }
}
