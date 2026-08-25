// <copyright file="ConstantFieldMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>Emits CLR field metadata for supported G# constant values.</summary>
internal static class ConstantFieldMetadataEmitter
{
    /// <summary>Gets constant-field attributes appropriate for <paramref name="value"/>.</summary>
    /// <param name="value">The target-typed constant value.</param>
    /// <returns>CLR field attributes for the constant representation.</returns>
    public static FieldAttributes GetAttributes(object? value)
    {
        if (value is decimal)
        {
            return FieldAttributes.InitOnly;
        }

        if (IsEcmaConstant(value))
        {
            return FieldAttributes.Literal | FieldAttributes.HasDefault;
        }

        throw new ArgumentException($"Value of type '{value?.GetType()}' is not a supported field constant.", nameof(value));
    }

    /// <summary>Returns whether <paramref name="value"/> needs runtime field initialization.</summary>
    /// <param name="value">The target-typed constant value.</param>
    /// <returns><see langword="true"/> for constants represented by static read-only storage.</returns>
    public static bool RequiresRuntimeInitialization(object? value) => value is decimal;

    /// <summary>Returns whether any constant field requires runtime initialization.</summary>
    /// <param name="fields">Constant fields to inspect.</param>
    /// <returns><see langword="true"/> when at least one field uses static read-only storage.</returns>
    public static bool ContainsRuntimeInitializedConstant(ImmutableArray<FieldSymbol> fields)
    {
        foreach (var field in fields)
        {
            if (RequiresRuntimeInitialization(field.ConstantValue))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Emits the Constant row or decimal constant attribute for <paramref name="value"/>.</summary>
    /// <param name="emitCtx">The active metadata emit context.</param>
    /// <param name="getTypeReference">Resolves the decimal attribute type reference.</param>
    /// <param name="field">The field receiving the constant metadata.</param>
    /// <param name="value">The target-typed constant value.</param>
    public static void Emit(
        EmitContext emitCtx,
        Func<Type, TypeReferenceHandle> getTypeReference,
        FieldDefinitionHandle field,
        object? value)
    {
        if (value is decimal decimalValue)
        {
            EmitDecimalConstantAttribute(emitCtx, getTypeReference, field, decimalValue);
            return;
        }

        if (!IsEcmaConstant(value))
        {
            throw new ArgumentException($"Value of type '{value?.GetType()}' is not a supported field constant.", nameof(value));
        }

        emitCtx.Metadata.AddConstant(field, value);
    }

    private static bool IsEcmaConstant(object? value)
        => value is null
            or bool
            or char
            or sbyte
            or byte
            or short
            or ushort
            or int
            or uint
            or long
            or ulong
            or float
            or double
            or string;

    private static void EmitDecimalConstantAttribute(
        EmitContext emitCtx,
        Func<Type, TypeReferenceHandle> getTypeReference,
        FieldDefinitionHandle field,
        decimal value)
    {
        var attributeType = typeof(System.Runtime.CompilerServices.DecimalConstantAttribute);
        var ctorSignature = new BlobBuilder();
        new BlobEncoder(ctorSignature).MethodSignature(isInstanceMethod: true)
            .Parameters(5, returns => returns.Void(), parameters =>
            {
                parameters.AddParameter().Type().Byte();
                parameters.AddParameter().Type().Byte();
                parameters.AddParameter().Type().UInt32();
                parameters.AddParameter().Type().UInt32();
                parameters.AddParameter().Type().UInt32();
            });
        var ctor = emitCtx.Metadata.AddMemberReference(
            getTypeReference(attributeType),
            emitCtx.Metadata.GetOrAddString(".ctor"),
            emitCtx.Metadata.GetOrAddBlob(ctorSignature));

        var bits = decimal.GetBits(value);
        var attributeValue = new BlobBuilder();
        attributeValue.WriteUInt16(0x0001);
        attributeValue.WriteByte((byte)((bits[3] >> 16) & 0x7F));
        attributeValue.WriteByte((byte)(bits[3] < 0 ? 1 : 0));
        attributeValue.WriteUInt32(unchecked((uint)bits[2]));
        attributeValue.WriteUInt32(unchecked((uint)bits[1]));
        attributeValue.WriteUInt32(unchecked((uint)bits[0]));
        attributeValue.WriteUInt16(0);

        emitCtx.Metadata.AddCustomAttribute(
            field,
            ctor,
            emitCtx.Metadata.GetOrAddBlob(attributeValue));
    }
}
