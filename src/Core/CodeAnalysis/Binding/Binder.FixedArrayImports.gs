// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection

partial class Binder {
    private func ValidateFixedArrayImports(location TextLocation) {
        if $scope.References is not{} references {
            return
        }
        for assembly in references.Assemblies.OrderBy((item Assembly) -> item.FullName, StringComparer.Ordinal) {
            try {
                let capability = FixedArrayAbi.ReadMarker(assembly, FixedArrayAbi.CapabilityKey)
                if capability == nil {
                    continue
                }
                if capability != FixedArrayAbi.Revision {
                    throw InvalidDataException("unsupported fixed-array capability revision")
                }
                let owners = references
                    .Assemblies
                    .Where((item Assembly) -> item.GetName().Name == NativeSliceTypes.AssemblyName)
                    .ToArray()
                if owners.Length != 1 {
                    throw InvalidDataException("one canonical fixed-array ABI owner is required")
                }
                let abi = FixedArrayAbi(owners[0])
                ValidateFixedArraySignatures(assembly, abi)
            } catch (error Exception) when error is InvalidDataException ||
                error is TypeLoadException ||
                error is FileNotFoundException ||
                error is FileLoadException ||
                error is BadImageFormatException ||
                error is CustomAttributeFormatException ||
                error is ArgumentException {
                Diagnostics.ReportFixedArrayContract(location, assembly.FullName + ": " + error.Message)
            }
        }
    }

    shared {
        private func ValidateFixedArraySignatures(assembly Assembly, abi FixedArrayAbi) {
            let mark = ClrNullability.MarkMetadataReadFailures()
            for type in assembly.GetExportedTypes().OrderBy((item Type) -> item.FullName, StringComparer.Ordinal) {
                let receiver = TypeSymbol.FromClrTypeWithoutNullability(type, NullabilityFreeReason.ResolvedTypeName)
                ValidateFixedArrayRelationships(receiver, abi)
            }
            if ClrNullability.MetadataReadFailedSince(mark) {
                throw InvalidDataException("fixed-array annotations could not be read")
            }
        }

        private func ValidateFixedArrayMembers(receiver TypeSymbol, abi FixedArrayAbi) bool {
            let type = receiver.ClrType!!
            let definition = if type.IsGenericType {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
            var fixedBearing = ValidateFixedArrayConstraints(receiver, definition.GetGenericArguments(), abi)
            const Flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
            for field in type.GetFields(Flags) {
                fixedBearing = ValidateFixedArraySignature(MemberLookup.GetClrFieldTypeSymbol(receiver, field), abi) ||
                    fixedBearing
            }
            for property in type.GetProperties(Flags) {
                fixedBearing = ValidateFixedArraySignature(
                    MemberLookup.GetClrPropertyTypeSymbol(receiver, property),
                    abi
                ) ||
                    fixedBearing
            }
            for eventInfo in type.GetEvents(Flags) {
                fixedBearing = ValidateFixedArraySignature(
                    MemberLookup.GetClrEventHandlerTypeSymbol(receiver, eventInfo),
                    abi
                ) ||
                    fixedBearing
            }
            for method in type.GetMethods(Flags) {
                fixedBearing = ValidateFixedArrayConstraints(receiver, method.GetGenericArguments(), abi) ||
                    fixedBearing
                fixedBearing = ValidateFixedArraySignature(
                    MemberLookup.GetClrMethodReturnTypeSymbol(receiver, method),
                    abi
                ) ||
                    fixedBearing
                for var index = 0; index < method.GetParameters().Length; index++ {
                    fixedBearing = ValidateFixedArraySignature(
                        MemberLookup.GetClrMethodParameterTypeSymbol(receiver, method, index),
                        abi
                    ) ||
                        fixedBearing
                }
            }
            for constructor in type.GetConstructors(Flags) {
                for var index = 0; index < constructor.GetParameters().Length; index++ {
                    fixedBearing = ValidateFixedArraySignature(
                        MemberLookup.GetClrMethodParameterTypeSymbol(receiver, constructor, index),
                        abi
                    ) ||
                        fixedBearing
                }
            }
            return fixedBearing
        }

        private func ValidateFixedArraySignature(signature TypeSymbol, abi FixedArrayAbi) bool {
            abi.ValidateSignature(signature)
            return signature.ClrType is {} type && FixedArrayAbi.ContainsCandidate(type)
        }

        private func ValidateFixedArrayRelationships(receiver TypeSymbol, abi FixedArrayAbi) {
            let pending = Queue[(Signature TypeSymbol, Depth int32)]()
            let seen = HashSet[(Type, string)]()
            let interfaceAnnotations = Dictionary[Type, string]()
            pending.Enqueue((receiver, 0))
            while pending.Count > 0 {
                let (signature, depth) = pending.Dequeue()
                if depth >= 256 {
                    throw InvalidDataException(
                        "fixed-array relationship hierarchy exceeds the metadata complexity limit"
                    )
                }
                let type = signature.ClrType
                if type == nil {
                    throw InvalidDataException("fixed-array relationship has no CLR identity")
                }
                let flags = Convert.ToBase64String(NullableFlagsBuilder.Build(signature).ToArray())
                if !seen.Add((type, flags)) {
                    continue
                }
                abi.ValidateSignature(signature)
                let fixedMembers = ValidateFixedArrayMembers(signature, abi)
                if type.IsInterface && (FixedArrayAbi.ContainsCandidate(type) || fixedMembers) {
                    if interfaceAnnotations.TryGetValue(type, out var previous) && previous != flags {
                        throw InvalidDataException("ambiguous fixed-bearing interface annotations")
                    }
                    interfaceAnnotations[type] = flags
                }
                for relationship in MemberLookup.GetClrRelationshipTypeSymbols(signature) {
                    pending.Enqueue((relationship, depth + 1))
                }
            }
        }

        private func ValidateFixedArrayConstraints(receiver TypeSymbol, parameters[]Type, abi FixedArrayAbi) bool {
            var fixedBearing = false
            for parameter in parameters {
                if !parameter.IsGenericParameter || parameter.GetGenericParameterConstraints().Length == 0 {
                    continue
                }
                for signature in MemberLookup.GetClrGenericParameterConstraintTypeSymbols(receiver, parameter) {
                    fixedBearing = ValidateFixedArraySignature(signature, abi) || fixedBearing
                }
            }
            return fixedBearing
        }
    }
}
