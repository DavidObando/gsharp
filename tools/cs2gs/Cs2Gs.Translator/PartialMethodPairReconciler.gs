// <copyright file="PartialMethodPairReconciler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import System
import System.Collections.Generic
import System.Linq

/// ADR-0143 2026-09-23 amendment / ADR-0192: decides which G# partial method
/// pairs a project's translation keeps.
///
/// With `emitPartialMethodPairs` on, the translator emits a hand-authored
/// implemented C# partial method as a declaring part plus an implementing part,
/// each spelled in its own G# file and both tagged with the same
/// (cref:MethodDeclaration.PartialPairKey). gsc requires the two
/// signatures to be textually identical (GS0611), but each G# file's imports
/// and type aliases are built while THAT file is translated (including a
/// whole-file pre-scan of qualified references), so no check made while
/// translating one file can predict the other file's spelling. The pairs are
/// therefore tentative until (cref:TranslateUntilStable) has compared
/// them across every unit of the project.
shared class PartialMethodPairReconciler {
    /// The most re-translation rounds (cref:TranslateUntilStable) runs
    /// before it suppresses every remaining pair. Each round suppresses at
    /// least one more pair key or ends, so the real bound is the number of
    /// pairs; this is a guard, not an expected limit.
    const MaxRounds int32 = 32

    /// Translates every unit of one project, then repeatedly: finds each pair
    /// whose parts do not have exactly one declaring and one implementing part
    /// printing the same signature ((cref:FindMismatchedPairKeys)), adds
    /// its key to the suppressed set, and re-translates every unit holding a
    /// part of a newly suppressed pair — until no pair mismatches. A
    /// suppressed pair translates exactly as with pairs off, so its output is
    /// the pre-ADR-0192 output. Re-translation (rather than editing the
    /// printed tree) also discards any import or alias the dropped declaring
    /// part had recorded, and re-checks the other pairs of the same file,
    /// whose spelling that can change.
    /// @param unitCount The number of units in the project.
    /// @param translateUnit Translates unit `i` with the given suppressed pair keys. It is
    /// called once per unit and again for each re-translated unit, and must
    /// use a fresh translation context each time and the same translator
    /// instance for the same unit.
    /// @returns The final units, in order.
    func TranslateUntilStable(
        unitCount int32,
        translateUnit((int32, IReadOnlyCollection[string]) -> CompilationUnit)?
    ) IReadOnlyList[CompilationUnit] {
        if translateUnit == nil {
            throw ArgumentNullException("translateUnit")
        }
        let suppressed = HashSet[string](StringComparer.Ordinal)
        let units = List[CompilationUnit](unitCount)
        for var i = 0; i < unitCount; i++ {
            units.Add(translateUnit(i, suppressed.ToList()))
        }
        for var round = 0; ; round++ {
            let mismatched = FindMismatchedPairKeys(units)
            if mismatched.Count == 0 {
                return units
            }
            // Guard: stop iterating and suppress EVERY pair in the project, so
            // no tentative pair can survive unchecked.
            let newlySuppressed = if round < MaxRounds {
                cast[IEnumerable[string]](mismatched)
            } else {
                units.SelectMany(CollectPairKeys)
            }
            let added = HashSet[string](StringComparer.Ordinal)
            for key in newlySuppressed {
                if suppressed.Add(key) {
                    added.Add(key)
                }
            }
            if added.Count == 0 {
                // Cannot happen: a suppressed key is never emitted again.
                throw InvalidOperationException(
                    "Partial method pair reconciliation made no progress: " + string.Join(", ", mismatched)
                )
            }
            let snapshot IReadOnlyCollection[string] = suppressed.ToList()
            for var i = 0; i < units.Count; i++ {
                if CollectPairKeys(units[i]).Any(added.Contains) {
                    units[i] = translateUnit(i, snapshot)
                }
            }
        }
    }

    /// Finds the pair keys across [`units`](paramref) whose parts do not
    /// form exactly one declaring and one implementing part printing the same
    /// signature ((cref:GSharpPrinter.RenderMethodSignature): no body,
    /// no method-level attributes — gsc unions those — with parameter
    /// annotations and defaults, which gsc compares).
    /// @param units Every unit translated from one project.
    /// @returns The mismatched pair keys.
    func FindMismatchedPairKeys(units IReadOnlyList[CompilationUnit]?) IReadOnlyCollection[string] {
        if units == nil {
            throw ArgumentNullException("units")
        }
        let partsByKey = Dictionary[string, List[MethodDeclaration]](StringComparer.Ordinal)
        for unit in units {
            for part in CollectParts(unit) {
                if !partsByKey.TryGetValue(part.PartialPairKey!!, out var parts) {
                    parts = List[MethodDeclaration]()
                    partsByKey.Add(part.PartialPairKey!!, parts)
                }
                parts.Add(part)
            }
        }
        let mismatched = List[string]()
        for pair in partsByKey {
            let declaring = pair.Value.Where(IsDeclaringPart).ToList()
            let implementing = pair.Value.Where((part MethodDeclaration) -> !IsDeclaringPart(part)).ToList()
            let matches = declaring.Count == 1 && implementing.Count == 1 && string.Equals(
                GSharpPrinter.RenderMethodSignature(declaring[0]),
                GSharpPrinter.RenderMethodSignature(implementing[0]),
                StringComparison.Ordinal
            )
            if !matches {
                mismatched.Add(pair.Key)
            }
        }
        return mismatched
    }

    private func IsDeclaringPart(method MethodDeclaration) bool -> method.Body == nil && method.ExpressionBody == nil

    private func CollectPairKeys(unit CompilationUnit) IEnumerable[string] -> CollectParts(unit).Select(
        (part MethodDeclaration) -> part.PartialPairKey!!
    )

    private func CollectParts(unit CompilationUnit) IEnumerable[MethodDeclaration] {
        let parts = List[MethodDeclaration]()
        for member in unit.Members {
            CollectParts(member, parts)
        }
        return parts
    }

    private func CollectParts(node GNode, parts List[MethodDeclaration]) {
        switch node {
            case MethodDeclaration{IsPartial: true, PartialPairKey: not nil} method {
                parts.Add(method)
            }
            case type is TypeDeclaration {
                for member in type.Members {
                    CollectParts(member, parts)
                }
            }
            case shared is SharedBlock {
                for member in shared.Members {
                    CollectParts(member, parts)
                }
            }
        }
    }
}
