// <copyright file="MetadataTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Threading

/// The kind flags of a type definition. One function computes them, so no consumer decides them again.
internal class MetadataTypeKinds {
    internal init(isInterface bool, isAbstract bool, isSealed bool, isValueType bool, isEnum bool, isDelegate bool) {
        IsInterface = isInterface
        IsAbstract = isAbstract
        IsSealed = isSealed
        IsValueType = isValueType
        IsEnum = isEnum
        IsDelegate = isDelegate
    }

    internal prop IsInterface bool
    internal prop IsAbstract bool
    internal prop IsSealed bool
    internal prop IsValueType bool
    internal prop IsEnum bool
    internal prop IsDelegate bool
}

/// One generic parameter row of a type definition.
internal class MetadataGenericParameter {
    internal init(name string, ordinal int32, attributes GenericParameterAttributes) {
        Name = name
        Ordinal = ordinal
        Attributes = attributes
    }

    internal prop Name string
    internal prop Ordinal int32

    /// Gets the variance and the special constraints, as the table holds them.
    internal prop Attributes GenericParameterAttributes

    /// Gets the variance part of (cref:Attributes).
    internal prop Variance GenericParameterAttributes -> Attributes & GenericParameterAttributes.VarianceMask
}

/// A type definition of a (cref:MetadataModule) as a symbol (ADR-0209 section 5, "Definitions").
/// @remarks A module creates one symbol for each type definition row. A race publishes one winner.
/// The symbol has no CLR type: its `ClrType` is `nil`.
/// This stage holds the name, the nesting, the kind flags, the generic parameters and the base definition.
/// Members, signatures and constraints come with the decoder in the next stage.
internal class MetadataTypeSymbol : TypeSymbol {
    private let kinds Lazy[MetadataTypeKinds]
    private let genericParameters Lazy[ImmutableArray[MetadataGenericParameter]]
    private let baseDefinition Lazy[ResolvedTypeReference?]

    internal init(module MetadataModule, handle TypeDefinitionHandle) : base(
        module.Reader.GetString(module.Reader.GetTypeDefinition(handle).Name)
    ) {
        Module = module
        Handle = handle
        FullName = module.GetFullName(handle) ?? string.Empty
        kinds = Lazy[MetadataTypeKinds](ComputeKinds, LazyThreadSafetyMode.ExecutionAndPublication)
        genericParameters = Lazy[ImmutableArray[MetadataGenericParameter]](
            ReadGenericParameters,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
        baseDefinition = Lazy[ResolvedTypeReference?](ResolveBase, LazyThreadSafetyMode.ExecutionAndPublication)
    }

    /// Gets the module that defines the type.
    internal prop Module MetadataModule

    /// Gets the type definition row.
    internal prop Handle TypeDefinitionHandle

    /// Gets the full name in the spelling of reflection.
    internal prop FullName string

    /// Gets the namespace, empty for the global namespace and for a nested type.
    internal prop Namespace string -> Module.Reader.GetString(Module.Reader.GetTypeDefinition(Handle).Namespace)

    /// Gets the type that encloses this one, or `null`.
    internal prop EnclosingType MetadataTypeSymbol? {
        get {
            let declaring = Module.Reader.GetTypeDefinition(Handle).GetDeclaringType()
            return if declaring.IsNil {
                nil
            } else {
                Module.GetTypeSymbol(declaring)
            }
        }
    }

    /// Gets the type attributes of the row.
    internal prop Attributes TypeAttributes -> Module.Reader.GetTypeDefinition(Handle).Attributes

    /// Gets the generic parameter rows in ordinal order.
    /// A nested type in a generic type repeats the parameters of the enclosing type first, as the table holds them.
    internal prop GenericParameters ImmutableArray[MetadataGenericParameter] -> genericParameters.Value

    /// Gets the kind flags.
    internal prop Kinds MetadataTypeKinds -> kinds.Value

    /// Gets the definition of the base type, or `null` when the type has no base or the base is not a class type.
    /// A missing base is a (cref:MissingTypeSymbol) in the answer.
    internal prop BaseDefinition ResolvedTypeReference? -> baseDefinition.Value

    private func ReadGenericParameters() ImmutableArray[MetadataGenericParameter] {
        let reader = Module.Reader
        let parameters = reader.GetTypeDefinition(Handle).GetGenericParameters()
        let builder = ImmutableArray.CreateBuilder[MetadataGenericParameter](parameters.Count)
        for parameterHandle in parameters {
            let parameter = reader.GetGenericParameter(parameterHandle)
            builder.Add(
                MetadataGenericParameter(reader.GetString(parameter.Name), parameter.Index, parameter.Attributes)
            )
        }
        return builder.ToImmutable()
    }

    private func ResolveBase() ResolvedTypeReference? {
        let baseType = Module.Reader.GetTypeDefinition(Handle).BaseType
        return if baseType.IsNil {
            nil
        } else {
            Module.Set.ResolveTypeEntity(Module, baseType)
        }
    }

    // The one place that decides the kind flags.
    // Only the direct base decides value type, enum and delegate, as the runtime builds them.
    private func ComputeKinds() MetadataTypeKinds {
        let attributes = Attributes
        let isInterface = (attributes & TypeAttributes.ClassSemanticsMask) == TypeAttributes.Interface
        var isValueType = false
        var isEnum = false
        var isDelegate = false
        if baseDefinition.Value is {} resolvedBase && resolvedBase.IsResolved {
            let selfIsValueType = Module.Set.IsWellKnown(Module, Handle, SpecialType.ValueType)
            let selfIsEnum = Module.Set.IsWellKnown(Module, Handle, SpecialType.Enum)
            let baseIsValueType = Module.Set.IsWellKnown(resolvedBase, SpecialType.ValueType)
            let baseIsEnum = Module.Set.IsWellKnown(resolvedBase, SpecialType.Enum)
            isValueType = (baseIsValueType || baseIsEnum) && !selfIsValueType && !selfIsEnum
            isEnum = baseIsEnum && !selfIsEnum
            isDelegate = Module.Set.IsWellKnown(resolvedBase, SpecialType.MulticastDelegate)
        }
        return MetadataTypeKinds(
            isInterface,
            (attributes & TypeAttributes.Abstract) != 0,
            (attributes & TypeAttributes.Sealed) != 0,
            isValueType,
            isEnum,
            isDelegate
        )
    }

    /// Reads the answer for a type this module defines. The symbol is a view, so it has no state of its own.
    override prop IsValueType bool -> Kinds.IsValueType
}
