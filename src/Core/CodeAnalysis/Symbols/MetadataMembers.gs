// <copyright file="MetadataMembers.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Threading

/// One parameter of a method or an indexer: the name and flags from the `Param` row, the type from the signature.
internal class MetadataParameter {
    internal init(name string, ordinal int32, type TypeSymbol, attributes ParameterAttributes) {
        Name = name
        Ordinal = ordinal
        Type = type
        Attributes = attributes
    }

    internal prop Name string

    /// Gets the zero-based position among the parameters.
    internal prop Ordinal int32

    internal prop Type TypeSymbol

    internal prop Attributes ParameterAttributes
}

/// A decoded method signature: return type, parameters and the full signature header.
/// @remarks The header keeps `this`, explicit `this`, the calling convention and the vararg boundary
/// (cref:RequiredParameterCount). Nothing about the header is reduced to one flag.
internal class MetadataMethodSignature {
    internal init(
        returnType TypeSymbol,
        parameters ImmutableArray[MetadataParameter],
        header SignatureHeader,
        requiredParameterCount int32
    ) {
        ReturnType = returnType
        Parameters = parameters
        Header = header
        RequiredParameterCount = requiredParameterCount
    }

    internal prop ReturnType TypeSymbol

    internal prop Parameters ImmutableArray[MetadataParameter]

    internal prop Header SignatureHeader

    /// Gets the number of parameters before the vararg sentinel, or all of them when the method has no sentinel.
    internal prop RequiredParameterCount int32

    internal prop HasThis bool -> Header.IsInstance

    internal prop IsVarArg bool -> Header.CallingConvention == SignatureCallingConvention.VarArgs

    /// Tells whether any type of the signature is, or contains, a missing type.
    internal prop ContainsMissing bool {
        get {
            if MetadataTypeKeys.ContainsMissing(ReturnType) {
                return true
            }
            for parameter in Parameters {
                if MetadataTypeKeys.ContainsMissing(parameter.Type) {
                    return true
                }
            }
            return false
        }
    }
}

/// A method definition row as a symbol (ADR-0209 section 6, row "Method").
/// @remarks The signature and the generic parameters are decoded on first request. A decode that saw a missing type is
/// kept, because the answer is stable for the set.
internal class MetadataMethodSymbol : Symbol {
    private let genericParameters Lazy[MetadataGenericParameterSet]
    private let signature Lazy[MetadataMethodSignature]
    private let nullableSignature Lazy[MetadataNullableSignature]

    internal init(owner MetadataTypeSymbol, handle MethodDefinitionHandle) : base(
        owner.Module.Reader.GetString(owner.Module.Reader.GetMethodDefinition(handle).Name)
    ) {
        Owner = owner
        Handle = handle
        genericParameters = Lazy[MetadataGenericParameterSet](
            ReadGenericParameters,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
        signature = Lazy[MetadataMethodSignature](Decode, LazyThreadSafetyMode.ExecutionAndPublication)
        nullableSignature = Lazy[MetadataNullableSignature](
            ReadNullableSignature,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
    }

    override prop Kind SymbolKind -> SymbolKind.Function

    internal prop Owner MetadataTypeSymbol

    internal prop Handle MethodDefinitionHandle

    internal prop Flags MethodAttributes -> Owner.Module.Reader.GetMethodDefinition(Handle).Attributes

    internal prop ImplAttributes MethodImplAttributes -> Owner.Module.Reader.GetMethodDefinition(Handle).ImplAttributes

    /// Gets the generic parameters of the method, with their constraints.
    internal prop GenericParameters MetadataGenericParameterSet -> genericParameters.Value

    /// Gets the decoded signature.
    internal prop Signature MetadataMethodSignature -> signature.Value

    /// Gets the nullability of the return value and of each parameter, read through the funnel.
    internal prop NullableSignature MetadataNullableSignature -> nullableSignature.Value

    // The Param row of a sequence number (0 is the return value), or nil when the method has none.
    private func OwnRow(rows Dictionary[int32, EntityHandle], number int32) EntityHandle -> if rows.TryGetValue(
        number,
        out var row
    ) {
        row
    } else {
        default(EntityHandle)
    }

    private func ReadNullableSignature() MetadataNullableSignature {
        let module = Owner.Module
        let reader = module.Reader
        let definition = reader.GetMethodDefinition(Handle)
        let holders = MetadataNullability.ContextHolders(module, Handle, definition.GetDeclaringType())
        let rows = Dictionary[int32, EntityHandle]()
        for handle in definition.GetParameters() {
            rows[reader.GetParameter(handle).SequenceNumber] = handle
        }
        let signature = Signature
        let returnPosition = MetadataNullability.ApplyPosition(
            module.Set,
            signature.ReturnType,
            MetadataNullability.ReadFlags(module, OwnRow(rows, 0), holders)
        )
        let parameters = ImmutableArray.CreateBuilder[MetadataNullablePosition](signature.Parameters.Length)
        for parameter in signature.Parameters {
            parameters.Add(
                MetadataNullability.ApplyPosition(
                    module.Set,
                    parameter.Type,
                    MetadataNullability.ReadFlags(module, OwnRow(rows, parameter.Ordinal + 1), holders)
                )
            )
        }
        return MetadataNullableSignature(returnPosition, parameters.MoveToImmutable())
    }

    private func ReadGenericParameters() MetadataGenericParameterSet -> MetadataTypeParameters.Read(
        Owner.Module,
        Owner.Module.Reader.GetMethodDefinition(Handle).GetGenericParameters(),
        MetadataTypeParameters.CastUp(Owner.TypeParameters),
        true
    )

    private func Decode() MetadataMethodSignature {
        let module = Owner.Module
        let definition = module.Reader.GetMethodDefinition(Handle)
        let context = MetadataGenericContext(
            MetadataTypeParameters.CastUp(Owner.TypeParameters),
            MetadataTypeParameters.CastUp(GenericParameters.Parameters)
        )
        let decoded = definition.DecodeSignature[TypeSymbol, MetadataGenericContext](module.Decoder, context)
        return MetadataMethodSignature(
            decoded.ReturnType,
            MetadataMembers.ReadParameters(module.Reader, definition.GetParameters(), decoded.ParameterTypes),
            decoded.Header,
            decoded.RequiredParameterCount
        )
    }
}

/// A field definition row as a symbol.
internal class MetadataFieldSymbol : Symbol {
    private let type Lazy[TypeSymbol]
    private let nullablePosition Lazy[MetadataNullablePosition]

    internal init(owner MetadataTypeSymbol, handle FieldDefinitionHandle) : base(
        owner.Module.Reader.GetString(owner.Module.Reader.GetFieldDefinition(handle).Name)
    ) {
        Owner = owner
        Handle = handle
        type = Lazy[TypeSymbol](Decode, LazyThreadSafetyMode.ExecutionAndPublication)
        nullablePosition = Lazy[MetadataNullablePosition](
            ReadNullablePosition,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
    }

    override prop Kind SymbolKind -> SymbolKind.Field

    internal prop Owner MetadataTypeSymbol

    internal prop Handle FieldDefinitionHandle

    internal prop Flags FieldAttributes -> Owner.Module.Reader.GetFieldDefinition(Handle).Attributes

    /// Gets the declared type of the field.
    internal prop FieldType TypeSymbol -> type.Value

    /// Gets the declared type with its nullability, read through the funnel.
    internal prop NullableFieldType MetadataNullablePosition -> nullablePosition.Value

    private func ReadNullablePosition() MetadataNullablePosition {
        let module = Owner.Module
        let holders = MetadataNullability.ContextHolders(module, default(EntityHandle), Owner.Handle)
        return MetadataNullability.ApplyPosition(
            module.Set,
            FieldType,
            MetadataNullability.ReadFlags(module, Handle, holders)
        )
    }

    private func Decode() TypeSymbol -> Owner
        .Module
        .Reader
        .GetFieldDefinition(Handle)
        .DecodeSignature[TypeSymbol, MetadataGenericContext](
        Owner.Module.Decoder,
        MetadataGenericContext(MetadataTypeParameters.CastUp(Owner.TypeParameters), ImmutableArray[TypeSymbol].Empty)
    )
}

/// A property definition row as a symbol, with its accessors from the `MethodSemantics` table.
internal class MetadataPropertySymbol : Symbol {
    private let signature Lazy[MetadataMethodSignature]
    private let nullablePosition Lazy[MetadataNullablePosition]

    internal init(owner MetadataTypeSymbol, handle PropertyDefinitionHandle) : base(
        owner.Module.Reader.GetString(owner.Module.Reader.GetPropertyDefinition(handle).Name)
    ) {
        Owner = owner
        Handle = handle
        signature = Lazy[MetadataMethodSignature](Decode, LazyThreadSafetyMode.ExecutionAndPublication)
        nullablePosition = Lazy[MetadataNullablePosition](
            ReadNullablePosition,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
    }

    override prop Kind SymbolKind -> SymbolKind.Property

    internal prop Owner MetadataTypeSymbol

    internal prop Handle PropertyDefinitionHandle

    internal prop Flags PropertyAttributes -> Owner.Module.Reader.GetPropertyDefinition(Handle).Attributes

    /// Gets the signature: the property type is the return type and the index parameters are the parameters.
    internal prop Signature MetadataMethodSignature -> signature.Value

    /// Gets the property type with its nullability, read through the funnel.
    internal prop NullablePropertyType MetadataNullablePosition -> nullablePosition.Value

    private func ReadNullablePosition() MetadataNullablePosition {
        let module = Owner.Module
        let holders = MetadataNullability.ContextHolders(module, default(EntityHandle), Owner.Handle)
        return MetadataNullability.ApplyPosition(
            module.Set,
            Signature.ReturnType,
            MetadataNullability.ReadFlags(module, Handle, holders)
        )
    }

    /// Gets the getter, or `null`.
    internal prop Getter MethodDefinitionHandle -> Owner
        .Module
        .Reader
        .GetPropertyDefinition(Handle)
        .GetAccessors()
        .Getter

    /// Gets the setter, or `null`.
    internal prop Setter MethodDefinitionHandle -> Owner
        .Module
        .Reader
        .GetPropertyDefinition(Handle)
        .GetAccessors()
        .Setter

    private func Decode() MetadataMethodSignature {
        let module = Owner.Module
        let decoded = module
            .Reader
            .GetPropertyDefinition(Handle)
            .DecodeSignature[TypeSymbol, MetadataGenericContext](
            module.Decoder,
            MetadataGenericContext(
                MetadataTypeParameters.CastUp(Owner.TypeParameters),
                ImmutableArray[TypeSymbol].Empty
            )
        )
        // An indexer's parameter names live on its getter or setter, so only the types are read here.
        let parameters = ImmutableArray.CreateBuilder[MetadataParameter](decoded.ParameterTypes.Length)
        for var i = 0; i < decoded.ParameterTypes.Length; i++ {
            parameters.Add(MetadataParameter("", i, decoded.ParameterTypes[i], ParameterAttributes.None))
        }
        return MetadataMethodSignature(
            decoded.ReturnType,
            parameters.MoveToImmutable(),
            decoded.Header,
            decoded.RequiredParameterCount
        )
    }
}

/// An event definition row as a symbol, with its accessors from the `MethodSemantics` table.
internal class MetadataEventSymbol : Symbol {
    private let type Lazy[TypeSymbol]

    internal init(owner MetadataTypeSymbol, handle EventDefinitionHandle) : base(
        owner.Module.Reader.GetString(owner.Module.Reader.GetEventDefinition(handle).Name)
    ) {
        Owner = owner
        Handle = handle
        type = Lazy[TypeSymbol](Decode, LazyThreadSafetyMode.ExecutionAndPublication)
    }

    override prop Kind SymbolKind -> SymbolKind.Event

    internal prop Owner MetadataTypeSymbol

    internal prop Handle EventDefinitionHandle

    internal prop Flags EventAttributes -> Owner.Module.Reader.GetEventDefinition(Handle).Attributes

    /// Gets the handler type.
    internal prop HandlerType TypeSymbol -> type.Value

    /// Gets the raise method, or `null`.
    internal prop Raiser MethodDefinitionHandle -> Owner.Module.Reader.GetEventDefinition(Handle).GetAccessors().Raiser

    internal prop Adder MethodDefinitionHandle -> Owner.Module.Reader.GetEventDefinition(Handle).GetAccessors().Adder

    internal prop Remover MethodDefinitionHandle -> Owner
        .Module
        .Reader
        .GetEventDefinition(Handle)
        .GetAccessors()
        .Remover

    private func Decode() TypeSymbol -> Owner
        .Module
        .Decoder
        .Decode(
        Owner.Module.Reader.GetEventDefinition(Handle).Type,
        MetadataGenericContext(MetadataTypeParameters.CastUp(Owner.TypeParameters), ImmutableArray[TypeSymbol].Empty)
    )
}

/// The rules shared by the member symbols.
internal shared class MetadataMembers {
    /// Reads how many parameters a property row declares in its own signature blob.
    /// The accessor may declare more or fewer: the table is the truth.
    internal func DeclaredParameterCount(reader MetadataReader, handle PropertyDefinitionHandle) int32 {
        var blob = reader.GetBlobReader(reader.GetPropertyDefinition(handle).Signature)
        blob.ReadByte()
        return blob.ReadCompressedInteger()
    }

    /// Joins the types of a signature with the `Param` rows of the method.
    /// A `Param` row with sequence 0 describes the return value. A parameter without a row has an empty name.
    internal func ReadParameters(
        reader MetadataReader,
        rows ParameterHandleCollection,
        types ImmutableArray[TypeSymbol]
    ) ImmutableArray[MetadataParameter] {
        let names = [types.Length]string
        let attributes = [types.Length]ParameterAttributes
        for handle in rows {
            let row = reader.GetParameter(handle)
            let index = row.SequenceNumber - 1
            if index >= 0 && index < types.Length {
                names[index] = reader.GetString(row.Name)
                attributes[index] = row.Attributes
            }
        }
        let builder = ImmutableArray.CreateBuilder[MetadataParameter](types.Length)
        for var i = 0; i < types.Length; i++ {
            builder.Add(MetadataParameter(names[i] ?? "", i, types[i], attributes[i]))
        }
        return builder.MoveToImmutable()
    }
}
