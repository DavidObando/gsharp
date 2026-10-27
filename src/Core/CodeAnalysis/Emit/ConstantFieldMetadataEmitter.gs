// <copyright file="ConstantFieldMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.CompilerServices

/// Emits CLR field metadata for supported G# constant values.
internal shared class ConstantFieldMetadataEmitter {
    /// Gets constant-field attributes appropriate for [`value`](paramref).
    /// @param value The target-typed constant value.
    /// @returns CLR field attributes for the constant representation.
    func GetAttributes(value object?) FieldAttributes {
        if value is decimal {
            return FieldAttributes.InitOnly
        }
        if IsEcmaConstant(value) {
            return FieldAttributes.Literal | FieldAttributes.HasDefault
        }
        throw ArgumentException("Value of type '${value?.GetType()}' is not a supported field constant.", "value")
    }

    /// Returns whether [`value`](paramref) needs runtime field initialization.
    /// @param value The target-typed constant value.
    /// @returns `true` for constants represented by static read-only storage.
    func RequiresRuntimeInitialization(value object?) bool -> value is decimal

    /// Returns whether any constant field requires runtime initialization.
    /// @param fields Constant fields to inspect.
    /// @returns `true` when at least one field uses static read-only storage.
    func ContainsRuntimeInitializedConstant(fields ImmutableArray[FieldSymbol]) bool {
        for field in fields {
            if RequiresRuntimeInitialization(field.ConstantValue) {
                return true
            }
        }
        return false
    }

    /// Emits the Constant row or decimal constant attribute for [`value`](paramref).
    /// @param emitCtx The active metadata emit context.
    /// @param getTypeReference Resolves the decimal attribute type reference.
    /// @param field The field receiving the constant metadata.
    /// @param value The target-typed constant value.
    func Emit(
        emitCtx EmitContext,
        getTypeReference(Type) -> TypeReferenceHandle,
        field FieldDefinitionHandle,
        value object?
    ) {
        if value is decimal decimalValue {
            EmitDecimalConstantAttribute(emitCtx, getTypeReference, field, decimalValue)
            return
        }
        if !IsEcmaConstant(value) {
            throw ArgumentException("Value of type '${value?.GetType()}' is not a supported field constant.", "value")
        }
        emitCtx.Metadata.AddConstant(field, value)
    }

    private func IsEcmaConstant(value object?) bool -> value == nil ||
        value is bool ||
        value is char ||
        value is int8 ||
        value is uint8 ||
        value is int16 ||
        value is uint16 ||
        value is int32 ||
        value is uint32 ||
        value is int64 ||
        value is uint64 ||
        value is float32 ||
        value is float64 ||
        value is string

    private func EmitDecimalConstantAttribute(
        emitCtx EmitContext,
        getTypeReference(Type) -> TypeReferenceHandle,
        field FieldDefinitionHandle,
        value decimal
    ) {
        let attributeType = typeof(DecimalConstantAttribute)
        let ctorSignature = BlobBuilder()
        BlobEncoder(ctorSignature).MethodSignature(isInstanceMethod: true).Parameters(
            5,
            (returns ReturnTypeEncoder) -> returns.Void(),
            (parameters ParametersEncoder) -> {
                parameters.AddParameter().Type().Byte()
                parameters.AddParameter().Type().Byte()
                parameters.AddParameter().Type().UInt32()
                parameters.AddParameter().Type().UInt32()
                parameters.AddParameter().Type().UInt32()
            }
        )
        let ctor = emitCtx.MetadataRows.AddMemberReference(
            getTypeReference(attributeType),
            emitCtx.Metadata.GetOrAddString(".ctor"),
            emitCtx.Metadata.GetOrAddBlob(ctorSignature)
        )
        let bits = decimal.GetBits(value)
        let attributeValue = BlobBuilder()
        attributeValue.WriteUInt16(0x0001)
        attributeValue.WriteByte(uint8(((bits[3] >> 16) & 0x7F)))
        attributeValue.WriteByte(
            uint8(
                (
                    if bits[3] < 0 {
                        1
                    } else {
                        0
                    }
                )
            )
        )
        attributeValue.WriteUInt32(unchecked(uint32(bits[2])))
        attributeValue.WriteUInt32(unchecked(uint32(bits[1])))
        attributeValue.WriteUInt32(unchecked(uint32(bits[0])))
        attributeValue.WriteUInt16(0)
        emitCtx.Metadata.AddCustomAttribute(field, ctor, emitCtx.Metadata.GetOrAddBlob(attributeValue))
    }
}
