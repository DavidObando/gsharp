// <copyright file="BoundPropertyAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Represents an assignment to a user-defined property (ADR-0051).
class BoundPropertyAssignmentExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundPropertyAssignmentExpression) class.
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param receiver The instance receiver, or `null` for a static property.
    /// @param structType The declaring struct/class type, or `null` for an interface-constrained property.
    /// @param property The property to write.
    /// @param value The value to assign.
    convenience init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        property PropertySymbol,
        value BoundExpression
    ) {
        init(syntax, receiver, structType, property, value, nil, nil)
    }

    /// Initializes a new instance of the (cref:BoundPropertyAssignmentExpression) class with
    /// generic-construction context.
    /// @param syntax Originating syntax.
    /// @param receiver Instance receiver.
    /// @param structType Declaring struct/class type.
    /// @param property Property to write.
    /// @param value Converted assigned value.
    /// @param substitutedType Construction-substituted property type.
    /// @param interfaceType Effective interface owner.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        property PropertySymbol,
        value BoundExpression,
        substitutedType TypeSymbol?,
        interfaceType InterfaceSymbol?
    ) : base(syntax) {
        Receiver = receiver
        StructType = structType
        Property = property
        Value = value
        SubstitutedType = substitutedType
        InterfaceType = interfaceType
    }

    /// Gets the instance receiver, or `null` for a static property.
    prop Receiver BoundExpression? {
        get;
    }

    prop StructType StructSymbol? {
        get;
    }

    /// Gets the effective interface construction that declares (cref:Property).
    prop InterfaceType InterfaceSymbol? {
        get;
    }

    prop Property PropertySymbol {
        get;
    }

    prop Value BoundExpression {
        get;
    }

    /// Gets the property type after generic construction substitution.
    prop SubstitutedType TypeSymbol? {
        get;
    }

    override prop Type TypeSymbol -> SubstitutedType ?? Property.Type
    override prop Kind BoundNodeKind -> BoundNodeKind.PropertyAssignmentExpression
}
