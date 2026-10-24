// <copyright file="MetadataTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
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
    private let baseChain Lazy[MetadataBaseChain]
    private let typeParameters Lazy[MetadataGenericParameterSet]
    private let decodedBase Lazy[TypeSymbol?]

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
        baseChain = Lazy[MetadataBaseChain](WalkBaseChain, LazyThreadSafetyMode.ExecutionAndPublication)
        typeParameters = Lazy[MetadataGenericParameterSet](
            ReadTypeParameters,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
        decodedBase = Lazy[TypeSymbol?](DecodeBase, LazyThreadSafetyMode.ExecutionAndPublication)
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

    /// Gets whether the row is an interface. This reads the row only, so a type parameter constraint can ask it while
    /// the kind flags of the same type are still being computed.
    internal prop IsInterface bool -> (Attributes & TypeAttributes.ClassSemanticsMask) == TypeAttributes.Interface

    /// Gets the methods and constructors the type declares, in table order.
    internal prop Methods ImmutableArray[MetadataMethodSymbol] {
        get {
            let builder = ImmutableArray.CreateBuilder[MetadataMethodSymbol]()
            for handle in Module.Reader.GetTypeDefinition(Handle).GetMethods() {
                builder.Add(Module.GetMethodSymbol(handle))
            }
            return builder.ToImmutable()
        }
    }

    /// Gets the fields the type declares, in table order.
    internal prop Fields ImmutableArray[MetadataFieldSymbol] {
        get {
            let builder = ImmutableArray.CreateBuilder[MetadataFieldSymbol]()
            for handle in Module.Reader.GetTypeDefinition(Handle).GetFields() {
                builder.Add(Module.GetFieldSymbol(handle))
            }
            return builder.ToImmutable()
        }
    }

    /// Gets the properties the type declares, in table order.
    internal prop Properties ImmutableArray[MetadataPropertySymbol] {
        get {
            let builder = ImmutableArray.CreateBuilder[MetadataPropertySymbol]()
            for handle in Module.Reader.GetTypeDefinition(Handle).GetProperties() {
                builder.Add(Module.GetPropertySymbol(this, handle))
            }
            return builder.ToImmutable()
        }
    }

    /// Gets the events the type declares, in table order.
    internal prop Events ImmutableArray[MetadataEventSymbol] {
        get {
            let builder = ImmutableArray.CreateBuilder[MetadataEventSymbol]()
            for handle in Module.Reader.GetTypeDefinition(Handle).GetEvents() {
                builder.Add(Module.GetEventSymbol(this, handle))
            }
            return builder.ToImmutable()
        }
    }

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

    /// Gets the type parameter symbols, one for each generic parameter row, with their constraints.
    internal prop TypeParameters ImmutableArray[TypeParameterSymbol] -> typeParameters.Value.Parameters

    /// Gets the base type with its type arguments, or `null` when the type has no base.
    /// A base that the set lacks is a (cref:MissingTypeSymbol).
    override prop BaseType TypeSymbol? -> decodedBase.Value

    private func ReadTypeParameters() MetadataGenericParameterSet -> MetadataTypeParameters.Read(
        Module,
        Module.Reader.GetTypeDefinition(Handle).GetGenericParameters(),
        ImmutableArray[TypeSymbol].Empty,
        false
    )

    /// Gets every constraint type of a generic parameter, in table order. A missing type stays in the list.
    internal func GetConstraintTypes(ordinal int32) ImmutableArray[TypeSymbol] -> typeParameters
        .Value
        .Constraints[ordinal]

    private func DecodeBase() TypeSymbol? {
        let baseType = Module.Reader.GetTypeDefinition(Handle).BaseType
        if baseType.IsNil {
            return nil
        }
        return Module.Decoder.Decode(
            baseType,
            MetadataGenericContext(MetadataTypeParameters.CastUp(TypeParameters), ImmutableArray[TypeSymbol].Empty)
        )
    }

    private func ResolveBase() ResolvedTypeReference? {
        let baseType = Module.Reader.GetTypeDefinition(Handle).BaseType
        return if baseType.IsNil {
            nil
        } else {
            Module.Set.ResolveTypeEntity(Module, baseType)
        }
    }

    // One walk of the base chain answers two questions, so they cannot disagree about where the chain ends:
    // does the chain reach a delegate base type, and is every link resolved.
    private func WalkBaseChain() MetadataBaseChain {
        var reachesDelegate = false
        var complete = true
        var current MetadataTypeSymbol? = this
        // Inheritance has no depth limit. Only a cycle ends the walk early, and a cycle is a malformed chain.
        let visited = HashSet[MetadataTypeSymbol](ReferenceEqualityComparer.Instance)
        while current != nil {
            let set = current.Module.Set
            if !visited.Add(current) {
                complete = false
                break
            }
            if set.IsWellKnown(current.Module, current.Handle, SpecialType.Delegate) || set.IsWellKnown(
                current.Module,
                current.Handle,
                SpecialType.MulticastDelegate
            ) {
                reachesDelegate = true
            }
            let next = current.BaseDefinition
            if next != nil && !next.IsResolved {
                complete = false
            }
            // A base such as Base<Gone> resolves, but the context cannot build it when an argument is missing.
            if MetadataTypeKeys.ContainsMissing(current.BaseType) {
                complete = false
            }
            current = if next == nil || !next.IsResolved {
                nil
            } else {
                set.GetTypeSymbol(next)
            }
        }
        return MetadataBaseChain(reachesDelegate, complete)
    }

    /// Gets whether every link of the base chain resolves. A missing link makes the answers that need the chain
    /// unanswerable by the context (ADR-0209 table 7b, Q4).
    internal prop IsBaseChainComplete bool -> baseChain.Value.IsComplete

    // The one place that decides the kind flags.
    // Only the direct base decides value type, enum and delegate, as the runtime builds them.
    private func ComputeKinds() MetadataTypeKinds {
        let attributes = Attributes
        let isInterface = IsInterface
        var isValueType = false
        var isEnum = false
        if baseDefinition.Value is {} resolvedBase && resolvedBase.IsResolved {
            let selfIsValueType = Module.Set.IsWellKnown(Module, Handle, SpecialType.ValueType)
            let selfIsEnum = Module.Set.IsWellKnown(Module, Handle, SpecialType.Enum)
            let baseIsValueType = Module.Set.IsWellKnown(resolvedBase, SpecialType.ValueType)
            let baseIsEnum = Module.Set.IsWellKnown(resolvedBase, SpecialType.Enum)
            isValueType = (baseIsValueType || baseIsEnum) && !selfIsValueType && !selfIsEnum
            isEnum = baseIsEnum && !selfIsEnum
        }
        // A delegate type is System.Delegate, System.MulticastDelegate, or any type whose chain reaches one of them,
        // as ClrTypeUtilities.IsDelegateType answers. A missing link ends the chain.
        let isDelegate = baseChain.Value.ReachesDelegate
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

/// The result of walking the base chain of a type definition.
internal class MetadataBaseChain {
    internal init(reachesDelegate bool, isComplete bool) {
        ReachesDelegate = reachesDelegate
        IsComplete = isComplete
    }

    /// Gets whether the type or a base is System.Delegate or System.MulticastDelegate.
    internal prop ReachesDelegate bool

    /// Gets whether every link resolved and the chain ended at a type with no base.
    internal prop IsComplete bool
}
