// <copyright file="BoundAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// A bound attribute application — the result of resolving an
/// (cref:AnnotationSyntax) against the declaring scope per
/// ADR-0047 §3.
class BoundAttribute : BoundNode {
    /// Initializes a new instance of the (cref:BoundAttribute) class.
    /// @param syntax The originating syntax node.
    /// @param attributeType The resolved (cref:System.Attribute)-derived type.
    /// @param target The use-site target (defaulted from declaration position when omitted).
    /// @param positionalArguments Positional and colon-named constructor arguments in source order.
    /// @param namedArguments Named property/field arguments in source order.
    init(
        syntax AnnotationSyntax,
        attributeType TypeSymbol,
        target AttributeTargetKind,
        positionalArguments ImmutableArray[BoundAttributeArgument],
        namedArguments ImmutableArray[BoundAttributeArgument]
    ) : base(syntax) {
        AttributeType = attributeType
        Target = target
        PositionalArguments = positionalArguments
        NamedArguments = namedArguments
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.Attribute

    // `base.Syntax` is nullable because a lowering pass can synthesise a bound
    // node with no source counterpart, but a BoundAttribute is only ever built
    // by the binder from a real annotation: the constructor's `syntax`
    // parameter is a non-nullable AnnotationSyntax.
    /// Gets the originating annotation syntax.
    prop Syntax AnnotationSyntax -> cast[AnnotationSyntax](base.Syntax!!)

    /// Gets the resolved attribute type.
    prop AttributeType TypeSymbol {
        get;
    }

    /// Gets the attribute's type — the Roslyn `AttributeData.AttributeClass`
    /// analogue (ADR-0169, issue #4436); the same symbol as
    /// (cref:AttributeType).
    prop AttributeClass TypeSymbol? -> AttributeType

    /// Gets the effective use-site target.
    prop Target AttributeTargetKind {
        get;
    }

    /// Gets the bound constructor arguments in source order.
    prop PositionalArguments ImmutableArray[BoundAttributeArgument] {
        get;
    }

    /// Gets the bound named arguments in source order.
    prop NamedArguments ImmutableArray[BoundAttributeArgument] {
        get;
    }

    /// Gets a constructor argument by its resolved parameter position/name.
    /// @param position The zero-based constructor parameter position.
    /// @param parameterName The CLR constructor parameter name.
    /// @returns The supplied argument, or `null` when omitted.
    func GetConstructorArgument(position int32, parameterName string) BoundAttributeArgument? {
        for argument in PositionalArguments {
            if string.Equals(argument.Name, parameterName, StringComparison.Ordinal) || string.Equals(
                GetConstructorParameterMetadataName(argument),
                parameterName,
                StringComparison.Ordinal
            ) {
                return argument
            }
        }
        for var sourceIndex = 0; sourceIndex < PositionalArguments.Length; sourceIndex++ {
            let argument = PositionalArguments[sourceIndex]
            if argument.Name == nil && sourceIndex == position {
                return argument
            }
        }
        return nil
    }

    /// Gets the CLR metadata name of the constructor parameter selected by a
    /// colon-named argument.
    /// @param argument A constructor argument.
    /// @returns The CLR parameter name, or the bound name when no imported constructor matches.
    func GetConstructorParameterMetadataName(argument BoundAttributeArgument) string? {
        if argument.Name is not{} argumentName || AttributeType.ClrType is not{} clrType {
            return argument.Name
        }
        let constructor ConstructorInfo? = CustomAttributeEncoder.TryResolveImportedAttributeConstructor(
            clrType,
            this,
            out _,
            out _,
            out _
        )
        if constructor == nil {
            return argumentName
        }
        let parameters = constructor.GetParameters()
        for parameter in parameters {
            if string.Equals(argumentName, parameter.Name, StringComparison.Ordinal) {
                return parameter.Name
            }
        }
        let parameterNames = parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty).ToArray()
        for parameter in parameters {
            let metadataName = parameter.Name ?? string.Empty
            if string.Equals(
                argumentName,
                SyntaxFacts.GetEmittedIdentifier(metadataName, IdentifierNameContext.Parameter, parameterNames),
                StringComparison.Ordinal
            ) {
                return metadataName
            }
        }
        return argumentName
    }
}
