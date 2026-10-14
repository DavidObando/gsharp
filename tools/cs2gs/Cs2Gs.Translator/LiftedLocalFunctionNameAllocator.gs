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

    func ClaimDesignator(emittedOwner INamedTypeSymbol?, stem string, reserved(string) -> bool) string {
        lock this.gate {
            let owner ISymbol? = emittedOwner?.OriginalDefinition
            let helpers HashSet[string]? = if owner != nil && this.usedByType.TryGetValue(owner, out var used) {
                used
            } else {
                default(HashSet[string]?)
            }
            var designator = stem
            for var suffix = 2; reserved(designator) || helpers?.Contains(designator) == true; suffix++ {
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
            return localNames.Add(name!!)
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
