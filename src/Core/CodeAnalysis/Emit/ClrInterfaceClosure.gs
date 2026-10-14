// <copyright file="ClrInterfaceClosure.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// The imported CLR interfaces a G# type's metadata lists: every declared CLR
/// interface followed by its transitive base interfaces, as csc emits them
/// (issue #4601). It is the single source for both the type's
/// `InterfaceImpl` rows and the `MethodImpl` rows of the
/// interfaces' static-virtual slots (issue #4614), so the two can never
/// disagree about which interfaces the type implements.
/// @remarks Each interface is keyed on its emitted metadata identity, so it appears
/// once and two distinct interfaces are never conflated. Concrete interfaces
/// use the assembly-qualified comparer the emitter's own TypeRef/TypeSpec
/// token caches use (a same-named interface from another assembly is a
/// different interface). Symbolic generic ones (`IList[Shape]`,
/// `IList[T]`) use the bytes of their TypeSpec signature (a display name
/// would conflate `Shape` with `Outer.Shape`).
internal class ClrInterfaceClosure {
    private let signatures SignatureEncoder
    private let concreteKeys HashSet[Type] = HashSet[Type](TypeIdentityComparer.Instance)
    private let symbolicKeys HashSet[string] = HashSet[string](StringComparer.Ordinal)
    private let entries List[(Symbolic TypeSymbol?, Concrete Type?)] = List[(Symbolic TypeSymbol?, Concrete Type?)]()

    private init(signatures SignatureEncoder) {
        this.signatures = signatures
    }

    /// Gets the interfaces in emission order. Exactly one of each entry's two
    /// positions is set: `Symbolic` for a generic interface closed over
    /// G# types (emitted through its symbolic TypeSpec), `Concrete`
    /// otherwise.
    prop Entries IReadOnlyList[(Symbolic TypeSymbol?, Concrete Type?)] -> this.entries

    /// Adds a concrete interface unless it is already present.
    /// @param iface The interface.
    /// @returns `true` when it was added.
    func TryAddConcrete(iface Type) bool {
        if !this.concreteKeys.Add(iface) {
            return false
        }
        this.entries.Add((nil, iface))
        return true
    }

    /// Adds a symbolic generic interface unless one with the same TypeSpec
    /// signature is already present.
    /// @param iface The interface.
    /// @returns `true` when it was added.
    func TryAddSymbolic(iface TypeSymbol) bool {
        let signature = BlobBuilder()
        this.signatures.EncodeTypeSymbol(BlobEncoder(signature).TypeSpecificationSignature(), iface)
        if !this.symbolicKeys.Add(Convert.ToBase64String(signature.ToArray())) {
            return false
        }
        this.entries.Add((iface, nil))
        return true
    }

    shared {
        /// Builds the closure of [`type`](paramref)'s declared CLR
        /// interfaces.
        /// @param type The G# type being emitted.
        /// @param signatures The emitter's signature encoder (symbolic keys).
        /// @returns The closure.
        func Build(type StructSymbol, signatures SignatureEncoder) ClrInterfaceClosure {
            let closure = ClrInterfaceClosure(signatures)
            if type.ImplementedClrInterfaces.IsDefaultOrEmpty {
                return closure
            }
            for declared in type.ImplementedClrInterfaces {
                // Issue #949: a CLR generic interface closed over a user G# type
                // (e.g. `IEquatable[Shape]`) carries symbolic type arguments
                // alongside its type-erased ClrType; it is emitted over the real
                // constructed shape, never the erased `IEquatable<object>`.
                if MemberLookup.TryGetSymbolicClrGenericInterface(declared, out var openIface, out var symbolicArgs) {
                    closure.TryAddSymbolic(declared)
                    for baseIface in ClrTypeUtilities.SafeGetInterfaces(openIface) {
                        let baseSym = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                            baseIface,
                            openIface,
                            symbolicArgs,
                            NullabilityFreeReason.TypeStructure
                        )
                        if MemberLookup.TryGetSymbolicClrGenericInterface(baseSym, out _, out _) {
                            closure.TryAddSymbolic(baseSym)
                        } else if baseSym.ClrType is Type concreteBase {
                            closure.TryAddConcrete(concreteBase)
                        }
                    }
                    continue
                }
                if declared?.ClrType is Type clrIface {
                    closure.TryAddConcrete(clrIface)
                    for baseIface in ClrTypeUtilities.SafeGetInterfaces(clrIface) {
                        closure.TryAddConcrete(baseIface)
                    }
                }
            }
            return closure
        }
    }
}
