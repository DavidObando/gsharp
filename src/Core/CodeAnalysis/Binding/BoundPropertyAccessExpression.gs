// <copyright file="BoundPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Represents a read access to a user-defined property (ADR-0051).
class BoundPropertyAccessExpression : BoundPropertyReferenceOperationExpression {
    convenience init(syntax SyntaxNode?, receiver BoundExpression?, structType StructSymbol?, property PropertySymbol) {
        init(syntax, receiver, structType, property, nil, nil)
    }

    /// Initializes a new instance of the (cref:BoundPropertyAccessExpression)
    /// class with a narrowed type. ADR-0069 addendum / issue #1180: used by
    /// smart-cast flow analysis to surface a narrowed (tested) view of an
    /// immutable property read through a stable access path, without changing
    /// the underlying property symbol identity (so the emitter still calls the
    /// same getter).
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param receiver The instance receiver, or `null` for a static property.
    /// @param structType The declaring struct/class type.
    /// @param property The property to read.
    /// @param narrowedType The narrowed type to surface, or `null` to use [`property`](paramref)'s declared
    /// type.
    convenience init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        property PropertySymbol,
        narrowedType TypeSymbol?
    ) {
        init(syntax, receiver, structType, property, nil, narrowedType)
    }

    /// Initializes a new instance of the (cref:BoundPropertyAccessExpression)
    /// class with distinct construction-substituted and flow-narrowed types.
    /// @param syntax Originating syntax.
    /// @param receiver Instance receiver, or `null` for static access.
    /// @param structType Declaring struct/class type.
    /// @param property Property to read.
    /// @param substitutedType Construction-substituted member type.
    /// @param narrowedType Flow-narrowed type.
    convenience init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        property PropertySymbol,
        substitutedType TypeSymbol?,
        narrowedType TypeSymbol?
    ) {
        init(syntax, receiver, structType, property, substitutedType, narrowedType, nil)
    }

    /// Initializes a new instance of the (cref:BoundPropertyAccessExpression)
    /// class with distinct construction, narrowing, and interface-owner state.
    /// @param syntax Originating syntax.
    /// @param receiver Instance receiver, or `null` for static access.
    /// @param structType Declaring struct/class type.
    /// @param property Property to read.
    /// @param substitutedType Construction-substituted member type.
    /// @param narrowedType Flow-narrowed type.
    /// @param interfaceType Effective interface owner, or `null`.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        property PropertySymbol,
        substitutedType TypeSymbol?,
        narrowedType TypeSymbol?,
        interfaceType InterfaceSymbol?
    ) : base(syntax) {
        Receiver = receiver
        StructType = structType
        Property = property
        NarrowedType = narrowedType
        SubstitutedType = substitutedType
        InterfaceType = interfaceType
    }

    /// Gets the instance receiver, or `null` for a static property.
    prop Receiver BoundExpression? {
        get;
    }

    /// Gets the struct/class that declares (cref:Property), or
    /// `null` for an access through an interface-typed
    /// receiver, where the declaring type is the interface rather than an
    /// aggregate.
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

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ReferencedProperty Symbol? -> Property

    /// Gets the narrowed type for flow-analysis smart-cast (ADR-0069 addendum /
    /// issue #1180), or `null` to use the property's declared type. When
    /// non-null the binder reports this type to callers so member-access and
    /// type-compatibility checks see the narrowed view; the emitter always uses
    /// (cref:Property) for the getter call and inserts the narrowing cast.
    prop NarrowedType TypeSymbol? {
        get;
    }

    /// Gets the member type after generic construction substitution, before flow narrowing.
    prop SubstitutedType TypeSymbol? {
        get;
    }

    override prop Type TypeSymbol -> NarrowedType ?? SubstitutedType ?? Property.Type

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Instance BoundExpression? -> Receiver

    override prop Kind BoundNodeKind -> BoundNodeKind.PropertyAccessExpression
}
