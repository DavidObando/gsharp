// <copyright file="GPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic

/// Base type for a G# pattern (spec §Pattern matching). Patterns are shared by
/// switch arms and native boolean `is` expressions. A
/// `null` pattern in a (cref:SwitchArm) denotes the
/// `default` arm.
abstract class GPattern : GNode { }

/// A constant pattern `case 0:` / `case "x":` matching a literal value
/// (spec §Pattern matching, `ConstantPattern`).
class ConstantPattern : GPattern {
    /// Initializes a new instance of the (cref:ConstantPattern) class.
    /// @param value The constant value expression.
    init(value GExpression) {
        Value = value
    }

    /// Gets the constant value expression.
    prop Value GExpression {
        get;
    }
}

/// A relational pattern `case < 10:` matching against a comparison
/// operator and bound (spec §Pattern matching, `RelationalPattern`).
class RelationalPattern : GPattern {
    /// Initializes a new instance of the (cref:RelationalPattern) class.
    /// @param op The relational operator token (e.g. `<`).
    /// @param value The bound expression.
    init(op string, value GExpression) {
        Operator = op
        Value = value
    }

    /// Gets the relational operator token.
    prop Operator string {
        get;
    }

    /// Gets the bound expression.
    prop Value GExpression {
        get;
    }
}

/// A type pattern binding the subject to a designator when it has the given
/// runtime type (spec §Pattern matching, `TypePattern`). Two spellings
/// exist: the switch form `case d is Dog:` and the ADR-0166 designation
/// form `Dog d` / `Dog { Name: "Rex" } d`, which is the only form a
/// boolean `is` accepts and the one that preserves C# pattern syntax.
class TypePattern : GPattern {
    /// Initializes a new instance of the (cref:TypePattern) class.
    /// @param designator The bound variable name (`_` for none).
    /// @param type The matched type.
    /// @param suffix The optional property-pattern suffix (`Dog { Name: "Rex" }`).
    /// @param designationAfterType `true` to print the ADR-0166 spelling `Type designator`;
    /// `false` for the switch spelling `designator is Type`.
    init(designator string, type GTypeReference, suffix PropertyPattern? = nil, designationAfterType bool = false) {
        Designator = designator
        Type = type
        Suffix = suffix
        DesignationAfterType = designationAfterType
    }

    /// Gets the bound variable name.
    prop Designator string {
        get;
    }

    /// Gets the matched type.
    prop Type GTypeReference {
        get;
    }

    /// Gets the optional property-pattern suffix matched against the narrowed value.
    prop Suffix PropertyPattern? {
        get;
    }

    /// Gets a value indicating whether the designator prints after the type
    /// (ADR-0166 `Type name`) rather than before it (`name is Type`).
    prop DesignationAfterType bool {
        get;
    }
}

/// One field of a property pattern (`X: <pattern>`).
class PropertyPatternField : GNode {
    /// Initializes a new instance of the (cref:PropertyPatternField) class.
    /// @param name The property name.
    /// @param pattern The nested pattern the property must match.
    init(name string, pattern GPattern) {
        Name = name
        Pattern = pattern
    }

    /// Gets the property name.
    prop Name string {
        get;
    }

    /// Gets the nested pattern.
    prop Pattern GPattern {
        get;
    }
}

/// A property pattern `case { X: 0, Y: 0 }:` matching the subject's members
/// against nested patterns (spec §Pattern matching, `PropertyPattern`).
class PropertyPattern : GPattern {
    /// Initializes a new instance of the (cref:PropertyPattern) class.
    /// @param fields The property field patterns.
    /// @param designator The optional ADR-0166 designation printed after the closing brace
    /// (`{ Length: > 0 } text`), binding the matched non-nil value.
    init(fields IReadOnlyList[PropertyPatternField], designator string? = nil) {
        Fields = fields ?? List[PropertyPatternField]()
        Designator = designator
    }

    /// Gets the property field patterns.
    prop Fields IReadOnlyList[PropertyPatternField] {
        get;
    }

    /// Gets the optional designation that names the matched value, or `null`.
    prop Designator string? {
        get;
    }
}

/// A discard pattern `case _:` matching any value (spec §Pattern matching,
/// `DiscardPattern`).
class DiscardPattern : GPattern { }

/// A total `var name` pattern that binds the input at its static type.
class VarPattern : GPattern {
    /// Initializes a new instance of the (cref:VarPattern) class.
    /// @param designator The bound variable name, or `_` for a discard.
    init(designator string) {
        Designator = designator
    }

    /// Gets the bound variable name or discard.
    prop Designator string {
        get;
    }
}

/// A binary pattern combinator — a conjunction (`and`) or disjunction
/// (`or`) of two sub-patterns (issue #992, spec §Pattern matching,
/// `BinaryPattern`).
class BinaryPattern : GPattern {
    /// Initializes a new instance of the (cref:BinaryPattern) class.
    /// @param isConjunction `true` for `and`; `false` for `or`.
    /// @param left The left sub-pattern.
    /// @param right The right sub-pattern.
    init(isConjunction bool, left GPattern, right GPattern) {
        IsConjunction = isConjunction
        Left = left
        Right = right
    }

    /// Gets a value indicating whether this is an `and` (conjunction) pattern.
    prop IsConjunction bool {
        get;
    }

    /// Gets the left sub-pattern.
    prop Left GPattern {
        get;
    }

    /// Gets the right sub-pattern.
    prop Right GPattern {
        get;
    }
}

/// A negated pattern `not <pattern>` (issue #992, spec §Pattern
/// matching, `NotPattern`).
class NotPattern : GPattern {
    /// Initializes a new instance of the (cref:NotPattern) class.
    /// @param pattern The negated sub-pattern.
    init(pattern GPattern) {
        Pattern = pattern
    }

    /// Gets the negated sub-pattern.
    prop Pattern GPattern {
        get;
    }
}

/// A parenthesized pattern `( <pattern> )` used to override
/// combinator precedence (issue #992, spec §Pattern matching).
class ParenthesizedPattern : GPattern {
    /// Initializes a new instance of the (cref:ParenthesizedPattern) class.
    /// @param pattern The inner pattern.
    init(pattern GPattern) {
        Pattern = pattern
    }

    /// Gets the inner pattern.
    prop Pattern GPattern {
        get;
    }
}

/// A list pattern `[1, .., 4]` matching an array/slice element-by-element,
/// with at most one (cref:SlicePattern) element (issue #1889, spec
/// §Pattern matching, `ListPattern`).
class ListPattern : GPattern {
    /// Initializes a new instance of the (cref:ListPattern) class.
    /// @param elements The element patterns, in source order.
    init(elements IReadOnlyList[GPattern]) {
        Elements = elements ?? List[GPattern]()
    }

    /// Gets the element patterns, in source order.
    prop Elements IReadOnlyList[GPattern] {
        get;
    }
}

/// A slice ("rest") subpattern inside a (cref:ListPattern), e.g. the
/// `..` in `[1, .., 4]` — a discard slice, a named capture
/// `..rest` binding the middle slice to a new `[]T` variable, or a
/// nested sub-pattern matched against the middle slice (issue #1889, spec
/// §Pattern matching, `SlicePattern`).
class SlicePattern : GPattern {
    /// Initializes a new instance of the (cref:SlicePattern) class.
    /// @param designator The capture name, or `null` for a discard/nested-pattern slice.
    /// @param pattern The nested sub-pattern matched against the slice, or `null`.
    init(designator string, pattern GPattern? = nil) {
        Designator = designator
        Pattern = pattern
    }

    /// Gets the capture name, or `null`.
    prop Designator string? {
        get;
    }

    /// Gets the nested sub-pattern matched against the slice, or `null`.
    prop Pattern GPattern? {
        get;
    }
}
