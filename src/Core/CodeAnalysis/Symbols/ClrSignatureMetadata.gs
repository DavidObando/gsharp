// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable

/// Reads annotations attached to CLR relationship rows, which reflection omits.
internal shared class ClrSignatureMetadata {
    internal func Interfaces(declaration Type) ImmutableArray[(Layout Type, Flags ImmutableArray[uint8])] {
        using let image = ReferenceResolver.OpenAssemblyImage(declaration.Assembly)
        if image == nil {
            throw InvalidDataException("interface annotations require an available metadata image")
        }
        using let pe = PEReader(image)
        let reader = pe.GetMetadataReader()
        let definition = reader.GetTypeDefinition(
            MetadataTokens.TypeDefinitionHandle(declaration.MetadataToken & 0xffffff)
        )
        let matcher = SignatureMatcher(declaration, nil)
        let candidates = declaration.GetInterfaces()
        let result = ImmutableArray.CreateBuilder[(Layout Type, Flags ImmutableArray[uint8])]()
        for handle in definition.GetInterfaceImplementations() {
            let row = reader.GetInterfaceImplementation(handle)
            result.Add(
                (
                    Match(reader, row.Interface, matcher, candidates),
                    ReadFlags(reader, row.GetCustomAttributes(), declaration)
                )
            )
        }
        return result.ToImmutable()
    }

    internal func Constraints(parameter Type) ImmutableArray[(Layout Type, Flags ImmutableArray[uint8])] {
        using let image = ReferenceResolver.OpenAssemblyImage(parameter.Assembly)
        if image == nil {
            throw InvalidDataException("constraint annotations require an available metadata image")
        }
        using let pe = PEReader(image)
        let reader = pe.GetMetadataReader()
        let definition = reader.GetGenericParameter(
            MetadataTokens.GenericParameterHandle(parameter.MetadataToken & 0xffffff)
        )
        let enclosing MemberInfo = parameter.DeclaringMethod ?? cast[MemberInfo](parameter.DeclaringType!!)
        let matcher = SignatureMatcher(parameter.DeclaringType!!, parameter.DeclaringMethod)
        let candidates = parameter.GetGenericParameterConstraints()
        let result = ImmutableArray.CreateBuilder[(Layout Type, Flags ImmutableArray[uint8])]()
        for handle in definition.GetConstraints() {
            let row = reader.GetGenericParameterConstraint(handle)
            result.Add(
                (Match(reader, row.Type, matcher, candidates), ReadFlags(reader, row.GetCustomAttributes(), enclosing))
            )
        }
        return result.ToImmutable()
    }

    internal func TryGetInterfaceSlotOverrideIsAbstract(
        derivedInterface Type,
        slotOwner Type,
        slot MethodInfo,
        matchesSlotOwner(Type) -> bool,
        out isAbstract bool
    ) bool {
        isAbstract = false
        let candidates = derivedInterface.GetInterfaces()
        if !candidates.Any(matchesSlotOwner) {
            return false
        }
        using let image = ReferenceResolver.OpenAssemblyImage(derivedInterface.Assembly)
        if image == nil {
            return false
        }
        using let pe = PEReader(image)
        if !pe.HasMetadata {
            return false
        }
        let reader = pe.GetMetadataReader()
        let definition = reader.GetTypeDefinition(
            MetadataTokens.TypeDefinitionHandle(derivedInterface.MetadataToken & 0xffffff)
        )
        let methodImpls = definition.GetMethodImplementations()
        if methodImpls.Count == 0 {
            return false
        }
        let ifaceMatcher = SignatureMatcher(derivedInterface, nil)
        let slotParams = slot.GetParameters()
        let slotGenericArity = if slot.IsGenericMethod {
            slot.GetGenericArguments().Length
        } else {
            0
        }
        for handle in methodImpls {
            let impl = reader.GetMethodImplementation(handle)
            if impl.MethodBody.Kind != HandleKind.MethodDefinition {
                continue
            }
            var matchesSlot = false
            switch impl.MethodDeclaration.Kind {
                case HandleKind.MethodDefinition {
                    matchesSlot = derivedInterface.Module == slot.Module && MetadataTokens.GetToken(
                        impl.MethodDeclaration
                    ) == slot.MetadataToken &&
                        matchesSlotOwner(slotOwner)
                }
                case HandleKind.MemberReference {
                    let memberRef = reader.GetMemberReference(cast[MemberReferenceHandle](impl.MethodDeclaration))
                    if reader.GetString(memberRef.Name) != slot.Name {
                        continue
                    }
                    let matchedIface = TryMatch(reader, memberRef.Parent, ifaceMatcher, candidates)
                    if matchedIface == nil || !matchesSlotOwner(matchedIface) {
                        continue
                    }
                    let sig = memberRef.DecodeMethodSignature(SignatureMatcher(slotOwner, slot), default(object))
                    if sig.GenericParameterCount != slotGenericArity ||
                        sig
                        .ParameterTypes
                        .Length != slotParams.Length ||
                        !sig.ReturnType(slot.ReturnType) {
                        continue
                    }
                    var allParamsMatch = true
                    for var i = 0; i < slotParams.Length; i++ {
                        let paramMatcher = sig.ParameterTypes[i]
                        if !paramMatcher(slotParams[i].ParameterType) {
                            allParamsMatch = false
                            break
                        }
                    }
                    matchesSlot = allParamsMatch
                }
                default { }
            }
            if matchesSlot {
                let bodyDef = reader.GetMethodDefinition(cast[MethodDefinitionHandle](impl.MethodBody))
                isAbstract = (bodyDef.Attributes & MethodAttributes.Abstract) != 0
                return true
            }
        }
        return false
    }

    private func TryMatch(
        reader MetadataReader,
        handle EntityHandle,
        matcher SignatureMatcher,
        candidates[]Type
    ) Type? {
        let predicate = switch handle.Kind {
            case HandleKind.TypeSpecification:
            reader.GetTypeSpecification(cast[TypeSpecificationHandle](handle)).DecodeSignature(matcher, default(object))
            case HandleKind.TypeDefinition: matcher.GetTypeFromDefinition(reader, cast[TypeDefinitionHandle](handle), 0)
            case HandleKind.TypeReference: matcher.GetTypeFromReference(reader, cast[TypeReferenceHandle](handle), 0)
            default: default(Func[Type, bool]?)
        }
        if predicate == nil {
            return nil
        }
        let matches = candidates.Where(predicate).ToArray()
        return if matches.Length == 1 {
            matches[0]
        } else {
            default(Type?)
        }
    }

    private func Match(reader MetadataReader, handle EntityHandle, matcher SignatureMatcher, candidates[]Type) Type {
        let predicate = switch handle.Kind {
            case HandleKind.TypeSpecification:
            reader.GetTypeSpecification(cast[TypeSpecificationHandle](handle)).DecodeSignature(matcher, default(object))
            case HandleKind.TypeDefinition: matcher.GetTypeFromDefinition(reader, cast[TypeDefinitionHandle](handle), 0)
            case HandleKind.TypeReference: matcher.GetTypeFromReference(reader, cast[TypeReferenceHandle](handle), 0)
            default: throw InvalidDataException("unsupported CLR relationship signature")
        }
        let matches = candidates.Where(predicate).ToArray()
        if matches.Length != 1 {
            throw InvalidDataException("ambiguous or unresolved CLR relationship signature")
        }
        return matches[0]
    }

    private func ReadFlags(
        reader MetadataReader,
        attributes CustomAttributeHandleCollection,
        enclosing MemberInfo
    ) ImmutableArray[uint8] {
        var flags = default(ImmutableArray[uint8])
        for handle in attributes {
            let attribute = reader.GetCustomAttribute(handle)
            let parent = switch attribute.Constructor.Kind {
                case HandleKind.MemberReference: reader.GetMemberReference(
                    cast[MemberReferenceHandle](attribute.Constructor)
                )
                    .Parent
                case HandleKind.MethodDefinition:
                cast[EntityHandle](
                    reader.GetMethodDefinition(cast[MethodDefinitionHandle](attribute.Constructor)).GetDeclaringType()
                )
                default: default(EntityHandle)
            }
            if parent.IsNil || TypeName(reader, parent) != "System.Runtime.CompilerServices.NullableAttribute" {
                continue
            }
            if !flags.IsDefault {
                throw InvalidDataException("duplicate relationship nullability metadata")
            }
            var blob = reader.GetBlobReader(attribute.Value)
            if blob.ReadUInt16() != 1 {
                throw InvalidDataException("malformed relationship nullability metadata")
            }
            let count = if blob.RemainingBytes == 3 {
                1
            } else {
                blob.ReadInt32()
            }
            if count < 0 || count > blob.RemainingBytes - 2 {
                throw InvalidDataException("malformed relationship nullability metadata")
            }
            let values = ImmutableArray.CreateBuilder[uint8](count)
            for var index = 0; index < count; index++ {
                let value = blob.ReadByte()
                if value > 2 {
                    throw InvalidDataException("unsupported relationship nullability flag")
                }
                values.Add(value)
            }
            if blob.RemainingBytes != 2 || blob.ReadUInt16() != 0 {
                throw InvalidDataException("malformed relationship nullability metadata")
            }
            flags = values.MoveToImmutable()
        }
        return if flags.IsDefault {
            ClrNullability.ReadNullableContext(enclosing)
        } else {
            flags
        }
    }

    private func TypeName(reader MetadataReader, handle EntityHandle) string {
        if handle.Kind == HandleKind.TypeReference {
            let type = reader.GetTypeReference(cast[TypeReferenceHandle](handle))
            return if type.ResolutionScope.Kind == HandleKind.TypeReference {
                TypeName(reader, type.ResolutionScope) + "+" + reader.GetString(type.Name)
            } else {
                QualifiedName(reader.GetString(type.Namespace), reader.GetString(type.Name))
            }
        }
        if handle.Kind == HandleKind.TypeDefinition {
            let type = reader.GetTypeDefinition(cast[TypeDefinitionHandle](handle))
            return if !type.GetDeclaringType().IsNil {
                TypeName(reader, type.GetDeclaringType()) + "+" + reader.GetString(type.Name)
            } else {
                QualifiedName(reader.GetString(type.Namespace), reader.GetString(type.Name))
            }
        }
        return ""
    }

    private func QualifiedName(namespaceName string, name string) string ->
    if namespaceName.Length == 0 {
        name
    } else {
        namespaceName + "." + name
    }

    private func ScopeName(reader MetadataReader, handle EntityHandle, owner Assembly) string {
        if handle.Kind == HandleKind.TypeReference {
            let type = reader.GetTypeReference(cast[TypeReferenceHandle](handle))
            if type.ResolutionScope.Kind == HandleKind.AssemblyReference {
                return reader.GetString(
                    reader.GetAssemblyReference(cast[AssemblyReferenceHandle](type.ResolutionScope)).Name
                )
            }
            if type.ResolutionScope.Kind == HandleKind.TypeReference {
                return ScopeName(reader, type.ResolutionScope, owner)
            }
        }
        return owner.GetName().Name!!
    }

    private func HasForwardedIdentity(origin Assembly, assemblyScope string, actual Type, depth int32 = 0) bool {
        if assemblyScope == actual.Assembly.GetName().Name {
            return true
        }
        if depth >= 32 {
            throw InvalidDataException("type-forwarder chain exceeds the metadata complexity limit")
        }
        // CLR nested identities follow the forwarder of their outermost declaring type.
        var forwarded = actual
        while forwarded.DeclaringType is {} declaring {
            forwarded = declaring
        }
        using let image = ReferenceResolver.OpenReferencedAssemblyImage(origin, assemblyScope)
        if image == nil {
            return false
        }
        using let pe = PEReader(image)
        let reader = pe.GetMetadataReader()
        for handle in reader.ExportedTypes {
            let exported = reader.GetExportedType(handle)
            if QualifiedName(
                reader.GetString(exported.Namespace),
                reader.GetString(exported.Name)
            ) != forwarded.FullName ||
                !exported.IsForwarder ||
                exported
                .Implementation
                .Kind != HandleKind.AssemblyReference {
                continue
            }
            let target = reader.GetAssemblyReference(cast[AssemblyReferenceHandle](exported.Implementation))
            return HasForwardedIdentity(origin, reader.GetString(target.Name), actual, depth + 1)
        }
        return false
    }

    private class SignatureMatcher : ISignatureTypeProvider[Func[Type, bool], object] {
        private let origin Assembly
        private let typeArguments[]Type
        private let methodArguments[]Type
        private var depth int32

        internal init(declaration Type, method MethodBase?) {
            origin = declaration.Assembly
            typeArguments = declaration.GetGenericArguments()
            methodArguments = method?.GetGenericArguments() ?? []Type{}
        }

        func GetTypeFromDefinition(reader MetadataReader, handle TypeDefinitionHandle, rawTypeKind uint8) Func[
            Type,
            bool
        ] ->
        Named(reader, handle)

        func GetTypeFromReference(reader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) Func[
            Type,
            bool
        ] ->
        Named(reader, handle)

        private func Named(reader MetadataReader, handle EntityHandle) Func[Type, bool] {
            let name = TypeName(reader, handle)
            let assemblyScope = ScopeName(reader, handle, origin)
            return (actual Type) -> actual.FullName == name && HasForwardedIdentity(origin, assemblyScope, actual)
        }

        func GetTypeFromSpecification(
            reader MetadataReader,
            context object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) Func[Type, bool] {
            if depth++ >= 256 {
                throw InvalidDataException("CLR relationship signature exceeds the metadata complexity limit")
            }
            try {
                return reader.GetTypeSpecification(handle).DecodeSignature(this, context)
            } finally {
                depth--
            }
        }

        func GetGenericInstantiation(genericType Func[Type, bool], arguments ImmutableArray[Func[Type, bool]]) Func[
            Type,
            bool
        ] ->
        func (actual Type) bool {
            if !actual.IsGenericType || !genericType(actual.GetGenericTypeDefinition()) {
                return false
            }
            let actualArguments = actual.GetGenericArguments()
            if actualArguments.Length != arguments.Length {
                return false
            }
            for var index = 0; index < arguments.Length; index++ {
                let argumentMatcher = arguments[index]
                if !argumentMatcher(actualArguments[index]) {
                    return false
                }
            }
            return true
        }

        func GetGenericTypeParameter(context object, index int32) Func[Type, bool] ->
        (actual Type) -> index < typeArguments.Length && SameTypeOrParameter(actual, typeArguments[index])

        func GetGenericMethodParameter(context object, index int32) Func[Type, bool] ->
        (actual Type) -> index < methodArguments.Length && SameTypeOrParameter(actual, methodArguments[index])

        private func SameTypeOrParameter(actual Type, expected Type) bool ->
        if actual.IsGenericParameter || expected.IsGenericParameter {
            actual == expected
        } else {
            ClrTypeUtilities.AreSame(actual, expected)
        }

        func GetPrimitiveType(code PrimitiveTypeCode) Func[Type, bool] ->
        (actual Type) -> actual.FullName == "System." + code.ToString()

        func GetSZArrayType(element Func[Type, bool]) Func[Type, bool] ->
        (actual Type) -> actual.IsSZArray && element(actual.GetElementType()!!)

        func GetArrayType(element Func[Type, bool], shape ArrayShape) Func[Type, bool] ->
        (actual Type) -> actual.IsArray && !actual.IsSZArray && actual.GetArrayRank() == shape.Rank &&
            element(actual.GetElementType()!!)

        func GetByReferenceType(element Func[Type, bool]) Func[Type, bool] ->
        (actual Type) -> actual.IsByRef && element(actual.GetElementType()!!)

        func GetPointerType(element Func[Type, bool]) Func[Type, bool] ->
        (actual Type) -> actual.IsPointer && element(actual.GetElementType()!!)

        func GetModifiedType(modifier Func[Type, bool], unmodifiedType Func[Type, bool], isRequired bool) Func[
            Type,
            bool
        ] -> unmodifiedType

        func GetPinnedType(element Func[Type, bool]) Func[Type, bool] -> element

        func GetFunctionPointerType(signature MethodSignature[Func[Type, bool]]) Func[Type, bool] -> (_ Type) -> false
    }
}
