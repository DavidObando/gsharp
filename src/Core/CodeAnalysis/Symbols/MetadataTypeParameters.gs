// <copyright file="MetadataTypeParameters.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata

/// The rules that turn generic parameter rows into (cref:TypeParameterSymbol) objects (ADR-0209 section 6).
/// @remarks Each rule is decided here once. The legacy constraint slots of the symbol hold the first constraint of
/// each kind. The owner keeps every constraint row, in table order.
internal shared class MetadataTypeParameters {
    /// Reads the generic parameter rows of a type or a method into symbols, with their constraints.
    /// Every parameter exists before any constraint is decoded, so a constraint may name a parameter of its own list.
    /// @param typeParameters The parameters of the declaring type, for a method; ignored for a type.
    internal func Read(
        module MetadataModule,
        handles GenericParameterHandleCollection,
        typeParameters ImmutableArray[TypeSymbol],
        isMethod bool
    ) MetadataGenericParameterSet {
        let reader = module.Reader
        let created = ImmutableArray.CreateBuilder[TypeParameterSymbol](handles.Count)
        for handle in handles {
            let row = reader.GetGenericParameter(handle)
            let parameter = Create(reader.GetString(row.Name), row.Index, row.Attributes)
            parameter.IsMethodTypeParameter = isMethod
            created.Add(parameter)
        }
        let parameters = created.MoveToImmutable()
        let own = CastUp(parameters)
        let context = if isMethod {
            MetadataGenericContext(typeParameters, own)
        } else {
            MetadataGenericContext(own, ImmutableArray[TypeSymbol].Empty)
        }
        let constraintTypes = ImmutableArray.CreateBuilder[ImmutableArray[TypeSymbol]](parameters.Length)
        var index = 0
        for handle in handles {
            let constraints = ImmutableArray.CreateBuilder[TypeSymbol]()
            for constraintHandle in reader.GetGenericParameter(handle).GetConstraints() {
                constraints.Add(
                    module.Decoder.Decode(reader.GetGenericParameterConstraint(constraintHandle).Type, context)
                )
            }
            let decoded = constraints.ToImmutable()
            constraintTypes.Add(decoded)
            Apply(parameters[index], decoded)
            index++
        }
        return MetadataGenericParameterSet(parameters, constraintTypes.MoveToImmutable())
    }

    /// Widens a list of parameters to a list of types.
    internal func CastUp(parameters ImmutableArray[TypeParameterSymbol]) ImmutableArray[TypeSymbol] {
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](parameters.Length)
        for parameter in parameters {
            builder.Add(parameter)
        }
        return builder.MoveToImmutable()
    }

    /// Creates the symbol of a generic parameter row, with its variance and special constraints.
    internal func Create(name string, ordinal int32, attributes GenericParameterAttributes) TypeParameterSymbol {
        let parameter = TypeParameterSymbol(name, ordinal, TypeParameterConstraint.Any, VarianceOf(attributes))
        parameter.HasReferenceTypeConstraint = (attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0
        parameter.HasValueTypeConstraint = (attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0
        parameter.HasDefaultConstructorConstraint = (
            attributes & GenericParameterAttributes.DefaultConstructorConstraint
        ) != 0
        return parameter
    }

    /// Fills the legacy constraint slots from the decoded constraint types.
    internal func Apply(parameter TypeParameterSymbol, constraintTypes ImmutableArray[TypeSymbol]) {
        for constraint in constraintTypes {
            if constraint is TypeParameterSymbol bound {
                parameter.TypeParameterBound ??= bound
            } else if IsInterfaceType(constraint) {
                parameter.ClrInterfaceConstraint ??= constraint
            } else if !IsValueTypeMarker(constraint) &&
                (constraint is MetadataTypeSymbol || constraint is ConstructedMetadataTypeSymbol) {
                parameter.ClassConstraint ??= constraint
            }
        }
    }

    // The one rule that maps the variance bits of the table onto the variance enum.
    internal func VarianceOf(attributes GenericParameterAttributes) TypeParameterVariance {
        let variance = attributes & GenericParameterAttributes.VarianceMask
        if variance == GenericParameterAttributes.Covariant {
            return TypeParameterVariance.Out
        }
        return if variance == GenericParameterAttributes.Contravariant {
            TypeParameterVariance.In
        } else {
            TypeParameterVariance.None
        }
    }

    // `where T : struct` stores a System.ValueType row, and `where T : Enum` stores a System.Enum row. Neither is a
    // reference-type bound, and ClassConstraint promises one (TypeParameterSymbol.ClassConstraint). The row stays in the
    // full list; it stays out of the legacy slot.
    private func IsValueTypeMarker(type TypeSymbol) bool {
        if type is not MetadataTypeSymbol definition {
            return false
        }
        let set = definition.Module.Set
        return set.IsWellKnown(definition.Module, definition.Handle, SpecialType.ValueType) || set.IsWellKnown(
            definition.Module,
            definition.Handle,
            SpecialType.Enum
        )
    }

    // The one rule that tells an interface constraint from a base class constraint.
    private func IsInterfaceType(type TypeSymbol) bool {
        if type is MetadataTypeSymbol definition {
            return definition.IsInterface
        }
        return type is ConstructedMetadataTypeSymbol constructed && constructed.Definition.IsInterface
    }
}

/// The generic parameters of a type or a method, with every constraint row of each, in table order.
internal class MetadataGenericParameterSet {
    internal init(
        parameters ImmutableArray[TypeParameterSymbol],
        constraints ImmutableArray[ImmutableArray[TypeSymbol]]
    ) {
        Parameters = parameters
        Constraints = constraints
    }

    internal prop Parameters ImmutableArray[TypeParameterSymbol]

    /// Gets the constraint types of each parameter. A missing type stays in the list.
    internal prop Constraints ImmutableArray[ImmutableArray[TypeSymbol]]
}
