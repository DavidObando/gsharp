// <copyright file="BindingReferenceGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0212 section 11, gate 2: the language server asks semantic questions of
/// `SemanticModel` and does not name the binder's types. The allowance list holds the
/// types the server still references. Each later slice of ADR-0212 shrinks the list and
/// slice S7 empties it.
open class BindingReferenceGateTests {
    @Fact
    func Server_ReferencesNoBindingTypeOutsideTheAllowanceList() {
        let referenced = ReferencedBindingTypes()
        let unexpected = referenced.Where((name string) -> !Allowed.Contains(name)).ToArray()
        Assert.True(
            unexpected.Length == 0,
            "GSharp.LanguageServer.dll references binding types that are not on the allowance list: " + string.Join(
                ", ",
                unexpected
            )
        )
    }

    @Fact
    func AllowanceList_HoldsNoTypeTheServerStopped_Referencing() {
        let referenced = ReferencedBindingTypes()
        let stale = Allowed
            .Where((name string) -> !referenced.Contains(name))
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        Assert.True(
            stale.Length == 0,
            "Remove these types from the allowance list; the server no longer references them: " + string.Join(
                ", ",
                stale
            )
        )
    }

    shared {
        private const BindingNamespace string = "GSharp.Core.CodeAnalysis.Binding"

        // ADR-0212 slice S2 baseline. Remove entries as slices S4 to S7 migrate their uses.
        private let Allowed HashSet[string] = HashSet[string](AllowanceEntries(), StringComparer.Ordinal)

        // Simple names in the binding namespace, one per line.
        private const AllowedNames string = `
            Binder
            BoundGlobalScope
            BoundProgram
`

        private func AllowanceEntries() List[string] {
            let entries = List[string]()
            for line in AllowedNames.Split('\n') {
                let name = line.Trim()
                if name.Length > 0 {
                    entries.Add(BindingNamespace + "." + name)
                }
            }
            return entries
        }

        private func ReferencedBindingTypes() HashSet[string] {
            let path = typeof(BoundSemantics).Assembly.Location
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let result = HashSet[string](StringComparer.Ordinal)
            for handle in reader.TypeReferences {
                let reference = reader.GetTypeReference(handle)
                let ns = reader.GetString(reference.Namespace)
                if reference.ResolutionScope.Kind == HandleKind.TypeReference {
                    let name = FullName(reader, reference)
                    if name.StartsWith(BindingNamespace + ".", StringComparison.Ordinal) {
                        result.Add(name)
                    }
                } else if ns == BindingNamespace || ns.StartsWith(BindingNamespace + ".", StringComparison.Ordinal) {
                    result.Add(FullName(reader, reference))
                }
            }
            return result
        }

        private func FullName(reader MetadataReader, reference TypeReference) string {
            let name = reader.GetString(reference.Name)
            if reference.ResolutionScope.Kind == HandleKind.TypeReference {
                let outer = reader.GetTypeReference(cast[TypeReferenceHandle](reference.ResolutionScope))
                return FullName(reader, outer) + "+" + name
            }
            let ns = reader.GetString(reference.Namespace)
            return if ns.Length == 0 {
                name
            } else {
                ns + "." + name
            }
        }
    }
}
