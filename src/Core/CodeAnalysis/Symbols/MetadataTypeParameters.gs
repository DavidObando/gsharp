// <copyright file="MetadataTypeParameters.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Immutable
import System.Reflection

/// The rules that turn generic parameter rows into (cref:TypeParameterSymbol) objects (ADR-0209 section 6).
/// @remarks Each rule is decided here once. The legacy constraint slots of the symbol hold the first constraint of
/// each kind. The owner keeps every constraint row, in table order.
internal shared class MetadataTypeParameters {
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
