// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System
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
            let flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
            for type in assembly.GetExportedTypes().OrderBy((item Type) -> item.FullName, StringComparer.Ordinal) {
                let receiver = TypeSymbol.FromClrTypeWithoutNullability(type, NullabilityFreeReason.ResolvedTypeName)
                ValidateFixedArrayConstraints(type.GetGenericArguments())
                if ClrNullability.GetBaseTypeSymbol(type) is {} baseSignature {
                    abi.ValidateSignature(baseSignature)
                }
                if type.GetInterfaces().Any((item Type) -> FixedArrayAbi.ContainsCandidate(item)) {
                    throw InvalidDataException("fixed-array interface-inheritance metadata is not supported in F1")
                }
                for field in type.GetFields(flags) {
                    abi.ValidateSignature(MemberLookup.GetClrFieldTypeSymbol(receiver, field))
                }
                for property in type.GetProperties(flags) {
                    abi.ValidateSignature(MemberLookup.GetClrPropertyTypeSymbol(receiver, property))
                }
                for method in type.GetMethods(flags) {
                    ValidateFixedArrayConstraints(method.GetGenericArguments())
                    abi.ValidateSignature(MemberLookup.GetClrMethodReturnTypeSymbol(receiver, method))
                    for var index = 0; index < method.GetParameters().Length; index++ {
                        abi.ValidateSignature(MemberLookup.GetClrMethodParameterTypeSymbol(receiver, method, index))
                    }
                }
                for constructor in type.GetConstructors(flags) {
                    for parameter in constructor.GetParameters() {
                        abi.ValidateSignature(ClrNullability.GetParameterTypeSymbol(parameter))
                    }
                }
            }
        }

        private func ValidateFixedArrayConstraints(parameters[]Type) {
            if parameters.Any(
                (parameter Type) -> parameter.IsGenericParameter && parameter.GetGenericParameterConstraints().Any(
                    (bound Type) -> FixedArrayAbi.ContainsCandidate(bound)
                )
            ) {
                throw InvalidDataException("fixed-array generic-constraint metadata is not supported in F1")
            }
        }
    }
}
