// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Emit
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable

/// Validates nominal ADR-0210 carriers without changing source array symbols.
internal class FixedArrayAbi {
    internal const Namespace string = "Gsharp.Values.FixedArrays.V1."
    internal const OwnerKey string = "GSharp.FixedArrayAbi"
    internal const CapabilityKey string = "GSharp.FixedArrays"
    internal const Revision string = "1"
    internal const MaxLength int32 = 32
    private const MaxDepth int32 = 256

    private let empty Type
    private let leaf Type
    private let branch Type

    internal init(owner Assembly) {
        if owner.GetName()
            .Name != NativeSliceTypes.AssemblyName ||
            owner
            .GetName()
            .Version
            ?.ToString() != "0.5.0.0" ||
            !string.IsNullOrEmpty(owner.GetName().CultureName) ||
            (owner.GetName().GetPublicKeyToken()?.Length ?? 0) != 0 ||
            ReadMarker(owner, OwnerKey) != Revision {
            throw InvalidDataException("missing or incompatible canonical fixed-array ABI owner")
        }
        empty = RequireDefinition(owner, "Empty`1", 1, []string{})
        leaf = RequireDefinition(owner, "Leaf`1", 1, []string{"Item"})
        branch = RequireDefinition(owner, "Branch`3", 3, []string{"Left", "Right"})
    }

    internal prop Owner Assembly -> empty.Assembly

    internal func Encode(element Type, length int32) Type {
        CheckElement(element)
        if IsCandidate(element) {
            Decode(element)
        }
        if length < 0 || length > MaxLength {
            throw InvalidDataException("fixed-array length must be between 0 and 32")
        }
        return if length == 0 {
            empty.MakeGenericType(element)
        } else {
            if length == 1 {
                leaf.MakeGenericType(element)
            } else {
                branch.MakeGenericType(element, Encode(element, length / 2), Encode(element, length - length / 2))
            }
        }
    }

    internal func Decode(carrier Type)(Element Type, Length int32) -> DecodeCore(carrier, 0)

    private func DecodeCore(carrier Type, depth int32)(Element Type, Length int32) {
        if depth >= MaxDepth {
            throw InvalidDataException("fixed-array shape exceeds the metadata complexity limit")
        }
        if !carrier.IsGenericType {
            throw InvalidDataException("fixed-array carrier must be a canonical constructed value type")
        }
        let definition = carrier.GetGenericTypeDefinition()
        let arguments = carrier.GetGenericArguments()
        if definition != empty && definition != leaf && definition != branch {
            throw InvalidDataException("fixed-array carrier does not use the canonical ABI owner")
        }
        let element = arguments[0]
        CheckElement(element)
        if IsCandidate(element) {
            DecodeCore(element, depth + 1)
        }
        if definition == empty {
            return (element, 0)
        }
        if definition == leaf {
            return (element, 1)
        }
        let left = DecodeCore(arguments[1], depth + 1)
        let right = DecodeCore(arguments[2], depth + 1)
        let length = left.Length + right.Length
        if length < 2 ||
            length > MaxLength ||
            left.Length != length / 2 ||
            right.Length != length - length / 2 ||
            left.Element != element ||
            right.Element != element {
            throw InvalidDataException("noncanonical fixed-array split or element identity")
        }
        return (element, length)
    }

    internal func ValidateSignature(type TypeSymbol) -> ValidateSignatureCore(type, 0)

    private func ValidateSignatureCore(type TypeSymbol, depth int32) {
        if depth >= MaxDepth {
            throw InvalidDataException("fixed-array signature exceeds the metadata complexity limit")
        }
        let positions = type.GetElementPositions()
        var shape = type.ClrType
        if shape?.IsByRef == true {
            shape = shape!!.GetElementType()
        }
        shape = NullableLifting.GetValueTypeNullableUnderlyingClr(shape) ?? shape
        if IsCandidate(shape) {
            let decoded = Decode(shape!!)
            if positions.Length != (
                if decoded.Length < 2 {
                    1
                } else {
                    3
                }
            ) {
                throw InvalidDataException("fixed-array signature has incompatible generic positions")
            }
            if decoded.Length >= 2 {
                let left = positions[1].GetElementPositions()
                let right = positions[2].GetElementPositions()
                if left.Length == 0 ||
                    right.Length == 0 ||
                    !SameElement(positions[0], left[0]) ||
                    !SameElement(positions[0], right[0]) {
                    throw InvalidDataException("fixed-array signature has contradictory element nullability")
                }
            }
        }
        for position in positions {
            ValidateSignatureCore(position, depth + 1)
        }
    }

    shared {
        internal func ContainsCandidate(type Type) bool -> ContainsCandidateCore(type, 0)

        private func ContainsCandidateCore(type Type, depth int32) bool {
            if depth >= MaxDepth {
                throw InvalidDataException("fixed-array signature exceeds the metadata complexity limit")
            }
            if IsCandidate(type) {
                return true
            }
            if type.HasElementType {
                return ContainsCandidateCore(type.GetElementType()!!, depth + 1)
            }
            return type.IsGenericType && type.GetGenericArguments().Any(
                (argument Type) -> ContainsCandidateCore(argument, depth + 1)
            )
        }

        internal func IsCandidate(type Type?) bool {
            if type?.IsGenericType != true {
                return false
            }
            let definition = type!!.GetGenericTypeDefinition()
            if definition.IsNested || definition.Namespace != "Gsharp.Values.FixedArrays.V1" {
                return false
            }
            return definition.Name.StartsWith("Empty`", StringComparison.Ordinal) || definition.Name.StartsWith(
                "Leaf`",
                StringComparison.Ordinal
            ) ||
                definition
                .Name
                .StartsWith("Branch`", StringComparison.Ordinal)
        }

        internal func ReadMarker(assembly Assembly, key string) string? {
            // Inspect marker blobs without resolving unrelated attribute dependencies.
            using let stream = ReferenceResolver.OpenAssemblyImage(assembly)
            if stream != nil {
                using let pe = PEReader(stream)
                let reader = pe.GetMetadataReader()
                var marker string? = nil
                for handle in reader.GetAssemblyDefinition().GetCustomAttributes() {
                    let attribute = reader.GetCustomAttribute(handle)
                    if !IsMetadataAttribute(reader, attribute) {
                        continue
                    }
                    var blob = reader.GetBlobReader(attribute.Value)
                    if blob.ReadUInt16() != 1 {
                        throw InvalidDataException("malformed fixed-array assembly metadata")
                    }
                    if blob.ReadSerializedString() != key {
                        continue
                    }
                    let decoded = blob.ReadSerializedString()
                    if marker != nil || decoded == nil || blob.RemainingBytes != 2 || blob.ReadUInt16() != 0 {
                        throw InvalidDataException("duplicate or malformed fixed-array capability metadata")
                    }
                    marker = decoded
                }
                return marker
            }
            var value string? = nil
            for attribute in assembly.GetCustomAttributesData() {
                if attribute
                    .AttributeType
                    .FullName != "System.Reflection.AssemblyMetadataAttribute" ||
                    attribute
                    .ConstructorArguments
                    .Count != 2 ||
                    attribute
                    .ConstructorArguments[0]
                    .Value as string != key {
                    continue
                }
                if value != nil || attribute.ConstructorArguments[1].Value is not string marker {
                    throw InvalidDataException("duplicate or malformed fixed-array capability metadata")
                }
                value = marker
            }
            return value
        }

        private func IsMetadataAttribute(reader MetadataReader, attribute CustomAttribute) bool {
            let parent = switch attribute.Constructor.Kind {
                case HandleKind.MemberReference:
                reader.GetMemberReference(cast[MemberReferenceHandle](attribute.Constructor)).Parent
                case HandleKind.MethodDefinition:
                cast[EntityHandle](
                    reader.GetMethodDefinition(cast[MethodDefinitionHandle](attribute.Constructor)).GetDeclaringType()
                )
                default: default(EntityHandle)
            }
            if parent.IsNil {
                return false
            }
            if parent.Kind == HandleKind.TypeReference {
                let type = reader.GetTypeReference(cast[TypeReferenceHandle](parent))
                return reader.GetString(type.Namespace) == "System.Reflection" && reader.GetString(
                    type.Name
                ) == "AssemblyMetadataAttribute"
            }
            if parent.Kind == HandleKind.TypeDefinition {
                let type = reader.GetTypeDefinition(cast[TypeDefinitionHandle](parent))
                return reader.GetString(type.Namespace) == "System.Reflection" && reader.GetString(
                    type.Name
                ) == "AssemblyMetadataAttribute"
            }
            return false
        }

        private func SameElement(left TypeSymbol, right TypeSymbol) bool -> left.ClrType == right.ClrType &&
            NullableFlagsBuilder
            .Build(left).SequenceEqual(NullableFlagsBuilder.Build(right))

        private func CheckElement(element Type) {
            if element.FullName == "System.Void" ||
                element.IsByRef ||
                element.IsPointer ||
                element.IsByRefLike ||
                element.IsFunctionPointer ||
                element.IsGenericParameter &&
                (element.GenericParameterAttributes & GenericParameterAttributes.AllowByRefLike) != 0 {
                throw InvalidDataException("fixed-array elements must be ordinary heap-storable generic arguments")
            }
        }

        private func RequireDefinition(owner Assembly, name string, arity int32, names[]string) Type {
            let definition = owner.GetType(Namespace + name)
            if definition == nil ||
                definition.Assembly != owner ||
                !definition.IsPublic ||
                !definition.IsValueType ||
                !definition.IsLayoutSequential ||
                !definition.IsGenericTypeDefinition ||
                definition
                .GetGenericArguments()
                .Length != arity ||
                definition.IsByRefLike ||
                (definition.StructLayoutAttribute?.Pack ?? 0) != 0 ||
                (definition.StructLayoutAttribute?.Size ?? 0) != 0 {
                throw InvalidDataException("incompatible fixed-array value definition " + name)
            }
            let parameters = definition.GetGenericArguments()
            for var index = 0; index < parameters.Length; index++ {
                let expected = if index == 0 {
                    GenericParameterAttributes.None
                } else {
                    GenericParameterAttributes.NotNullableValueTypeConstraint |
                    GenericParameterAttributes.DefaultConstructorConstraint
                }
                if parameters[index].GenericParameterAttributes != expected {
                    throw InvalidDataException("incompatible fixed-array generic constraints " + name)
                }
                let constraints = parameters[index].GetGenericParameterConstraints()
                if constraints.Length > (
                    if index == 0 {
                        0
                    } else {
                        1
                    }
                ) ||
                    constraints.Length == 1 &&
                    constraints[0].FullName != "System.ValueType" ||
                    parameters[index]
                    .GetCustomAttributesData().Any(
                    (attribute CustomAttributeData) ->
                    attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsUnmanagedAttribute"
                ) {
                    throw InvalidDataException("incompatible fixed-array constraint types " + name)
                }
            }
            let fields = definition
                .GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .OrderBy((field FieldInfo) -> field.MetadataToken)
                .ToArray()
            if fields.Length != names.Length {
                throw InvalidDataException("incompatible fixed-array value fields " + name)
            }
            for var index = 0; index < fields.Length; index++ {
                if fields[index].Name != names[index] ||
                    !fields[index].IsPublic ||
                    fields[index].IsInitOnly ||
                    fields[index].FieldType != parameters[
                    if arity == 1 {
                        0
                    } else {
                        index + 1
                    }
                ] {
                    throw InvalidDataException("incompatible fixed-array field layout " + name)
                }
            }
            return definition
        }
    }
}
