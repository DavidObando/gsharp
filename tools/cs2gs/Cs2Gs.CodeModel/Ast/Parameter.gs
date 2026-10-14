// <copyright file="Parameter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic

/// A formal parameter `name Type`, optionally variadic (`name ...T`),
/// ref-kinded (`ref`/`out`/`in`), or with a default value.
class Parameter : GNode {
    /// Initializes a new instance of the (cref:Parameter) class.
    /// @param name The parameter name.
    /// @param type The parameter type (for a variadic param this is the element type).
    /// @param isVariadic Whether the parameter is variadic (`...T`).
    /// @param refKind The optional ref-kind modifier (`ref`/`out`/`in`).
    /// @param defaultValue The optional default value.
    /// @param attributes Optional per-parameter attributes.
    init(
        name string,
        type GTypeReference,
        isVariadic bool = false,
        refKind string? = nil,
        defaultValue GExpression? = nil,
        attributes IReadOnlyList[AttributeUse]? = nil
    ) {
        Name = name
        Type = type
        IsVariadic = isVariadic
        RefKind = refKind
        DefaultValue = defaultValue
        Attributes = attributes ?? List[AttributeUse]()
    }

    /// Initializes a new instance of the (cref:Parameter) class for a
    /// tuple-DESTRUCTURING arrow-lambda parameter (ADR-0185)
    /// (`(name1 T1, name2 T2, ...)`) — (cref:Name) and
    /// (cref:Type) are both `null` and
    /// (cref:DestructuredElements) carries the real range-variable
    /// names/types instead. Used by `BuildScopeParameter` to emit a
    /// query-scope lambda parameter directly under its real names, in place
    /// of the retired `__q{N}` synthetic tuple parameter (issue #4304).
    /// @param destructuredElements The pattern's `(name, type)` elements, in order.
    init(destructuredElements IReadOnlyList[(Name string, Type GTypeReference)]) {
        DestructuredElements = destructuredElements
        Attributes = List[AttributeUse]()
    }

    /// Gets the parameter name, or `null` for a destructured parameter (ADR-0185).
    prop Name string {
        get;
    }

    /// Gets the parameter type (element type when variadic), or `null` for a destructured parameter
    /// (ADR-0185).
    prop Type GTypeReference {
        get;
    }

    /// Gets a value indicating whether the parameter is variadic.
    prop IsVariadic bool {
        get;
    }

    /// Gets the optional ref-kind modifier.
    prop RefKind string? {
        get;
    }

    /// Gets the optional default value.
    prop DefaultValue GExpression? {
        get;
    }

    /// Gets the per-parameter attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets the `(name1 T1, name2 T2, ...)` tuple-destructuring pattern
    /// (ADR-0185) elements, or `null` for an ordinary
    /// single-identifier parameter.
    prop DestructuredElements IReadOnlyList[(Name string, Type GTypeReference)]? {
        get;
    }

    /// Gets a value indicating whether this is a destructured parameter (ADR-0185).
    prop IsDestructured bool -> DestructuredElements != nil
}

/// A generic type parameter and its constraints, rendered inside the bracket
/// section (ADR-0020/ADR-0097, ADR-0115 §B.7). The legacy slot carries a single
/// constraint name (`any`, `comparable`, or an interface); the flag
/// constraints (`class`, `struct`, `init()`) are repeatable.
class TypeParameter : GNode {
    /// Initializes a new instance of the (cref:TypeParameter) class.
    /// @param name The type-parameter name.
    /// @param legacyConstraint The legacy single-slot constraint, if any.
    /// @param flagConstraints The repeatable flag constraints, in order.
    /// @param variance The variance marker.
    init(
        name string,
        legacyConstraint string? = nil,
        flagConstraints IReadOnlyList[string]? = nil,
        variance Variance = Variance.None
    ) {
        Name = name
        LegacyConstraint = legacyConstraint
        FlagConstraints = flagConstraints ?? List[string]()
        Variance = variance
    }

    /// Gets the type-parameter name.
    prop Name string {
        get;
    }

    /// Gets the legacy single-slot constraint, if any.
    prop LegacyConstraint string? {
        get;
    }

    /// Gets the repeatable flag constraints (`class`, `struct`, `init()`).
    prop FlagConstraints IReadOnlyList[string] {
        get;
    }

    /// Gets the variance marker.
    prop Variance Variance {
        get;
    }
}

/// A named or positional argument inside an attribute application
/// (`"x"` or `EntryPoint: "x"`).
class AttributeArgument : GNode {
    /// Initializes a new instance of the (cref:AttributeArgument) class.
    /// @param value The argument value.
    /// @param name The optional argument name (named-argument form).
    /// @param isMemberAssignment Whether the name targets a property or field.
    init(value GExpression, name string? = nil, isMemberAssignment bool = false) {
        Value = value
        Name = name
        IsMemberAssignment = isMemberAssignment
    }

    /// Gets the optional argument name.
    prop Name string? {
        get;
    }

    /// Gets a value indicating whether the name targets a property or field rather than a constructor
    /// parameter.
    prop IsMemberAssignment bool {
        get;
    }

    /// Gets the argument value.
    prop Value GExpression {
        get;
    }
}

/// An attribute application `@Name(args)` with an optional use-site target
/// (ADR-0047, ADR-0115 §B.11). One per line, order preserved.
class AttributeUse : GNode {
    /// Initializes a new instance of the (cref:AttributeUse) class.
    /// @param name The (possibly dotted) attribute name.
    /// @param arguments The attribute arguments.
    /// @param target The optional use-site target (e.g. `return`, `field`).
    init(name string, arguments IReadOnlyList[AttributeArgument]? = nil, target string? = nil) {
        Name = name
        Arguments = arguments ?? List[AttributeArgument]()
        Target = target
    }

    /// Gets the (possibly dotted) attribute name.
    prop Name string {
        get;
    }

    /// Gets the attribute arguments.
    prop Arguments IReadOnlyList[AttributeArgument] {
        get;
    }

    /// Gets the optional use-site target.
    prop Target string? {
        get;
    }
}

/// A receiver clause `(name Type)` for an extension function
/// (ADR-0019/ADR-0079, ADR-0115 §B.5). ADR-0182 (issue #4240) made every
/// receiver clause unconditionally an extension, retiring the issue #3357
/// `func extension (name Type)` marker this type used to be able to
/// render — a receiver clause has exactly one printed form now.
class Receiver : GNode {
    /// Initializes a new instance of the (cref:Receiver) class.
    /// @param name The receiver parameter name.
    /// @param type The receiver type.
    convenience init(name string, type GTypeReference) {
        init(name, type, nil)
    }

    /// Initializes a new instance of the (cref:Receiver) class with parameter attributes.
    /// @param name The receiver parameter name.
    /// @param type The receiver type.
    /// @param attributes Optional receiver-parameter attributes.
    init(name string, type GTypeReference, attributes IReadOnlyList[AttributeUse]?) {
        Name = name
        Type = type
        Attributes = attributes ?? List[AttributeUse]()
    }

    /// Gets the receiver parameter name.
    prop Name string {
        get;
    }

    /// Gets the receiver type.
    prop Type GTypeReference {
        get;
    }

    /// Gets the receiver-parameter attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }
}
