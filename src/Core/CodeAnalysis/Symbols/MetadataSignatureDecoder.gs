// <copyright file="MetadataSignatureDecoder.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection.Metadata

/// Decodes the type structure of a signature blob into type symbols (ADR-0209 section 5, "One decoder").
/// @remarks The result holds no nullability: the funnel of ADR-0193 applies it later, once, from the attribute blobs.
/// This stage covers the structure that a base type, a constraint and a field type need.
/// Tuple canonical forms come with the nullability stage.
internal class MetadataSignatureDecoder : ISignatureTypeProvider[TypeSymbol, MetadataGenericContext] {
    private let module MetadataModule

    /// Creates a decoder for the signatures of a module.
    internal init(module MetadataModule) {
        this.module = module
    }

    func GetArrayType(elementType TypeSymbol, shape ArrayShape) TypeSymbol {
        // RectangularArrayTypeSymbol starts at rank 2. A rank-one ARRAY is its own symbol, apart from the vector.
        if shape.Rank == 1 {
            return module.Set.GetNonVectorArray(elementType)
        }
        return RectangularArrayTypeSymbol.Get(elementType, shape.Rank)
    }

    func GetByReferenceType(elementType TypeSymbol) TypeSymbol -> ByRefTypeSymbol.Get(elementType)

    func GetFunctionPointerType(signature MethodSignature[TypeSymbol]) TypeSymbol -> module.Set.GetFunctionPointer(
        signature.Header,
        signature.RequiredParameterCount,
        signature.ReturnType,
        signature.ParameterTypes
    )

    func GetGenericInstantiation(genericType TypeSymbol, typeArguments ImmutableArray[TypeSymbol]) TypeSymbol {
        if genericType is not MetadataTypeSymbol definition {
            // A missing generic keeps its name. The arguments are dropped, because a missing type has none.
            return genericType
        }
        // The canonical form: every construction of System.Nullable`1 is the nullable symbol.
        if typeArguments.Length == 1 && module.Set.IsWellKnown(
            definition.Module,
            definition.Handle,
            SpecialType.Nullable
        ) {
            return NullableTypeSymbol.Get(typeArguments[0])
        }
        return module.Set.GetConstructed(definition, typeArguments)
    }

    func GetGenericMethodParameter(genericContext MetadataGenericContext, index int32) TypeSymbol {
        if index < genericContext.MethodParameters.Length {
            return genericContext.MethodParameters[index]
        }
        return module.Set.GetMissing(nil, "!!${index}")
    }

    func GetGenericTypeParameter(genericContext MetadataGenericContext, index int32) TypeSymbol {
        if index < genericContext.TypeParameters.Length {
            return genericContext.TypeParameters[index]
        }
        return module.Set.GetMissing(nil, "!${index}")
    }

    // Custom modifiers are data beside the type (ADR-0209 section 6): a modified type wraps the type and keeps blob order.
    func GetModifiedType(
        modifier TypeSymbol,
        unmodifiedType TypeSymbol,
        isRequired bool
    ) TypeSymbol -> MetadataModifiers.Add(module.Set, modifier, isRequired, unmodifiedType)

    func GetPinnedType(elementType TypeSymbol) TypeSymbol -> elementType

    func GetPointerType(elementType TypeSymbol) TypeSymbol -> PointerTypeSymbol.Get(elementType)

    func GetPrimitiveType(typeCode PrimitiveTypeCode) TypeSymbol {
        // TypedReference has no built-in symbol: it is the core library definition that the set supplies, or a missing type.
        if typeCode == PrimitiveTypeCode.TypedReference {
            return Canonical(module.Set.WellKnown.TryGet("System.TypedReference")!!)
        }
        return BuiltIn(typeCode)
    }

    func GetSZArrayType(elementType TypeSymbol) TypeSymbol -> module.Set.GetArray(elementType)

    func GetTypeFromDefinition(
        reader MetadataReader,
        handle TypeDefinitionHandle,
        rawTypeKind uint8
    ) TypeSymbol -> Canonical(ResolvedTypeReference(module, handle))

    func GetTypeFromReference(
        reader MetadataReader,
        handle TypeReferenceHandle,
        rawTypeKind uint8
    ) TypeSymbol -> Canonical(module.Set.ResolveTypeReference(module, handle))

    func GetTypeFromSpecification(
        reader MetadataReader,
        genericContext MetadataGenericContext,
        handle TypeSpecificationHandle,
        rawTypeKind uint8
    ) TypeSymbol -> reader
        .GetTypeSpecification(handle).DecodeSignature[TypeSymbol, MetadataGenericContext](this, genericContext)

    /// Decodes the type that a TypeDef, TypeRef or TypeSpec handle names.
    internal func Decode(entity EntityHandle, genericContext MetadataGenericContext) TypeSymbol {
        if entity.Kind == HandleKind.TypeDefinition {
            return GetTypeFromDefinition(module.Reader, cast[TypeDefinitionHandle](entity), 0)
        }
        if entity.Kind == HandleKind.TypeReference {
            return GetTypeFromReference(module.Reader, cast[TypeReferenceHandle](entity), 0)
        }
        return GetTypeFromSpecification(module.Reader, genericContext, cast[TypeSpecificationHandle](entity), 0)
    }

    // The canonical form of a definition: System.Decimal is the built-in, every other definition is its symbol,
    // and an unresolvable reference is its missing type (ADR-0209 section 5).
    private func Canonical(resolved ResolvedTypeReference) TypeSymbol {
        if resolved.Missing is {} missing {
            return missing
        }
        let target = resolved.Module!!
        if module.Set.IsWellKnown(target, resolved.Handle, SpecialType.Decimal) {
            return TypeSymbol.Decimal
        }
        return target.GetTypeSymbol(resolved.Handle)
    }

    shared {
        /// The one rule that maps a primitive type code onto the built-in symbols.
        internal func BuiltIn(typeCode PrimitiveTypeCode) TypeSymbol {
            return switch typeCode {
                case PrimitiveTypeCode.Boolean: TypeSymbol.Bool
                case PrimitiveTypeCode.Char: TypeSymbol.Char
                case PrimitiveTypeCode.SByte: TypeSymbol.Int8
                case PrimitiveTypeCode.Byte: TypeSymbol.UInt8
                case PrimitiveTypeCode.Int16: TypeSymbol.Int16
                case PrimitiveTypeCode.UInt16: TypeSymbol.UInt16
                case PrimitiveTypeCode.Int32: TypeSymbol.Int32
                case PrimitiveTypeCode.UInt32: TypeSymbol.UInt32
                case PrimitiveTypeCode.Int64: TypeSymbol.Int64
                case PrimitiveTypeCode.UInt64: TypeSymbol.UInt64
                case PrimitiveTypeCode.IntPtr: TypeSymbol.NInt
                case PrimitiveTypeCode.UIntPtr: TypeSymbol.NUInt
                case PrimitiveTypeCode.Single: TypeSymbol.Float32
                case PrimitiveTypeCode.Double: TypeSymbol.Float64
                case PrimitiveTypeCode.String: TypeSymbol.String
                case PrimitiveTypeCode.Object: TypeSymbol.Object
                case PrimitiveTypeCode.Void: TypeSymbol.Void
                default: TypeSymbol.Error
            }
        }
    }
}
