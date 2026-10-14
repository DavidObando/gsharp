// <copyright file="GExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic
import System.Linq

/// Base type for a G# expression.
abstract class GExpression : GNode { }

/// A general block expression `{ statements; value }`.
class BlockExpression : GExpression {
    /// Initializes a new instance of the (cref:BlockExpression) class.
    /// @param statements Statements evaluated before the value.
    /// @param value The trailing value expression.
    init(statements IReadOnlyList[GStatement], value GExpression) {
        Statements = statements ?? List[GStatement]()
        Value = value
    }

    /// Gets the prefix statements.
    prop Statements IReadOnlyList[GStatement] {
        get;
    }

    /// Gets the trailing value expression.
    prop Value GExpression {
        get;
    }
}

/// A literal expression. The width of a numeric value is conveyed by the type
/// clause, not the literal text (ADR-0115 §B.12).
class LiteralExpression : GExpression {
    private init(kind LiteralKind, value string) {
        Kind = kind
        Value = value
    }

    /// Gets the literal kind.
    prop Kind LiteralKind {
        get;
    }

    /// Gets the raw, unquoted literal value (for string/char this is the inner text).
    prop Value string {
        get;
    }

    shared {
        /// Creates an integer literal.
        /// @param value The integer text.
        /// @returns The literal.
        func Int(value string) LiteralExpression -> LiteralExpression(LiteralKind.Int, value)

        /// Creates a floating-point literal.
        /// @param value The float text.
        /// @returns The literal.
        func Float(value string) LiteralExpression -> LiteralExpression(LiteralKind.Float, value)

        /// Creates a string literal from its unescaped inner text.
        /// @param value The unescaped inner text.
        /// @returns The literal.
        func String(value string) LiteralExpression -> LiteralExpression(LiteralKind.String, value)

        /// Creates a Go-style backtick raw string literal (issue #3501); the value must contain no backtick or
        /// CR.
        /// @param value The verbatim string value.
        /// @returns The literal.
        func Raw(value string) LiteralExpression -> LiteralExpression(LiteralKind.RawString, value)

        /// Creates a character literal from its unescaped inner text.
        /// @param value The unescaped inner text.
        /// @returns The literal.
        func Char(value string) LiteralExpression -> LiteralExpression(LiteralKind.Char, value)

        /// Creates a boolean literal.
        /// @param value The boolean value.
        /// @returns The literal.
        func Bool(value bool) LiteralExpression -> LiteralExpression(
            LiteralKind.Bool,
            if value {
                "true"
            } else {
                "false"
            }
        )

        /// Creates the null literal (`nil`).
        /// @returns The literal.
        func Null() LiteralExpression -> LiteralExpression(LiteralKind.Null, "nil")
    }
}

/// A bare identifier reference.
class IdentifierExpression : GExpression {
    /// Initializes a new instance of the (cref:IdentifierExpression) class.
    /// @param name The identifier name (preserved verbatim, ADR-0115 §B.12).
    init(name string) {
        Name = name
    }

    /// Gets the identifier name.
    prop Name string {
        get;
    }
}

/// The `this` expression.
class ThisExpression : GExpression { }

/// A member-access expression `target.Name`.
class MemberAccessExpression : GExpression {
    /// Initializes a new instance of the (cref:MemberAccessExpression) class.
    /// @param target The receiver expression.
    /// @param memberName The member name.
    /// @param isArrow Whether this access lowers from a C# pointer member access (`p->X`,
    /// issue #1905). G# has its own native `->` operator (sugar for
    /// `(*p).X`, ADR-0122 §4 / issue #1034) that the parser desugars at
    /// parse time; printing the arrow directly (rather than a hand-rolled
    /// `(*p).X`) reuses that existing, already-correct G# feature and
    /// avoids a distinct parser gap where the explicit parenthesized-deref
    /// form fails to parse as an assignment target.
    init(target GExpression, memberName string, isArrow bool = false) {
        Target = target
        MemberName = memberName
        IsArrow = isArrow
    }

    /// Gets the receiver expression.
    prop Target GExpression {
        get;
    }

    /// Gets the member name.
    prop MemberName string {
        get;
    }

    /// Gets a value indicating whether to print the G# native `->` pointer-member operator instead of `.`.
    prop IsArrow bool {
        get;
    }
}

/// An invocation `target(args)` with optional bracket type arguments
/// (`target[T](args)`, ADR-0115 §B.7).
class InvocationExpression : GExpression {
    /// Initializes a new instance of the (cref:InvocationExpression) class.
    /// @param target The callee expression.
    /// @param arguments The argument expressions.
    /// @param typeArguments The explicit bracket type arguments, if any.
    init(
        target GExpression,
        arguments IReadOnlyList[GExpression]? = nil,
        typeArguments IReadOnlyList[GTypeReference]? = nil
    ) {
        Target = target
        Arguments = arguments ?? List[GExpression]()
        TypeArguments = typeArguments ?? List[GTypeReference]()
    }

    /// Gets the callee expression.
    prop Target GExpression {
        get;
    }

    /// Gets the argument expressions.
    prop Arguments IReadOnlyList[GExpression] {
        get;
    }

    /// Gets the explicit bracket type arguments.
    prop TypeArguments IReadOnlyList[GTypeReference] {
        get;
    }
}

/// A canonical named call argument `name: value`.
class NamedArgumentExpression : GExpression {
    /// Initializes a new instance of the (cref:NamedArgumentExpression) class.
    /// @param name The target parameter name.
    /// @param value The argument value.
    init(name string, value GExpression) {
        Name = name
        Value = value
    }

    /// Gets the target parameter name.
    prop Name string {
        get;
    }

    /// Gets the argument value.
    prop Value GExpression {
        get;
    }
}

/// An element-access expression `target[index]`.
class IndexExpression : GExpression {
    /// Initializes a new instance of the (cref:IndexExpression) class.
    /// @param target The indexed expression.
    /// @param index The index expression.
    convenience init(target GExpression, index GExpression) {
        init(target, List[GExpression]{index})
    }

    /// Initializes a new instance of the (cref:IndexExpression) class.
    /// @param target Indexed expression.
    /// @param indices Index expressions.
    init(target GExpression, indices IReadOnlyList[GExpression]) {
        Target = target
        Indices = indices ?? List[GExpression]()
    }

    /// Gets the indexed expression.
    prop Target GExpression {
        get;
    }

    /// Gets the index expression.
    prop Index GExpression -> Indices[0]

    /// Gets index expressions.
    prop Indices IReadOnlyList[GExpression] {
        get;
    }
}

/// A from-end index `^n`, used as (part of) an (cref:IndexExpression)
/// index (issue #1889, spec §Pattern matching / array slicing).
class FromEndIndexExpression : GExpression {
    /// Initializes a new instance of the (cref:FromEndIndexExpression) class.
    /// @param operand The distance-from-end operand.
    init(operand GExpression) {
        Operand = operand
    }

    /// Gets the distance-from-end operand.
    prop Operand GExpression {
        get;
    }
}

/// A range `start..end`, used as an (cref:IndexExpression) index to
/// slice an array (issue #1889). Either bound may be `null` for
/// an open range (`start..` / `..end` / `..`).
class RangeIndexExpression : GExpression {
    /// Initializes a new instance of the (cref:RangeIndexExpression) class.
    /// @param start The start bound, or `null` for the start of the target.
    /// @param end The end bound, or `null` for the end of the target.
    init(start GExpression, end GExpression) {
        Start = start
        End = end
    }

    /// Gets the start bound, or `null`.
    prop Start GExpression? {
        get;
    }

    /// Gets the end bound, or `null`.
    prop End GExpression? {
        get;
    }
}

/// A field initializer inside a composite literal (`Name: value`).
class FieldInitializer : GNode {
    /// Initializes a new instance of the (cref:FieldInitializer) class.
    /// @param name The field name.
    /// @param value The field value.
    init(name string, value GExpression) {
        Name = name
        Value = value
    }

    /// Gets the field name.
    prop Name string {
        get;
    }

    /// Gets the field value.
    prop Value GExpression {
        get;
    }
}

/// A composite (object) literal `Type{X: 1, Y: 2}`.
class CompositeLiteralExpression : GExpression {
    /// Initializes a new instance of the (cref:CompositeLiteralExpression) class.
    /// @param type The type being constructed.
    /// @param fieldInitializers The field initializers.
    init(type GTypeReference, fieldInitializers IReadOnlyList[FieldInitializer]? = nil) {
        Type = type
        FieldInitializers = fieldInitializers ?? List[FieldInitializer]()
    }

    /// Gets the type being constructed.
    prop Type GTypeReference {
        get;
    }

    /// Gets the field initializers.
    prop FieldInitializers IReadOnlyList[FieldInitializer] {
        get;
    }
}

/// A constructor call followed by a property-initializer suffix
/// `Target(args) { Name = value, ... }` (gsc issue #522). Used for a C#
/// object creation that combines constructor ARGUMENTS with an object
/// initializer (`new Foo(x) { Bar = 2 }`, issue #1728) — neither the
/// colon struct literal `T{Bar: 2}` nor a plain construction call has a
/// slot for both a positional constructor call and named member
/// assignments. gsc lowers this suffix form to a synthetic local, the
/// assignments, then a trailing value, so it is legal at any expression
/// position.
class ObjectCreationInitializerExpression : GExpression {
    /// Initializes a new instance of the (cref:ObjectCreationInitializerExpression) class.
    /// @param construction The constructor call expression.
    /// @param memberInitializers The member (property/field) initializers applied after construction.
    init(construction GExpression, memberInitializers IReadOnlyList[FieldInitializer]? = nil) {
        Construction = construction
        MemberInitializers = memberInitializers ?? List[FieldInitializer]()
    }

    /// Gets the constructor call expression.
    prop Construction GExpression {
        get;
    }

    /// Gets the member initializers applied after construction.
    prop MemberInitializers IReadOnlyList[FieldInitializer] {
        get;
    }
}

/// A single member of an (cref:AnonymousClassLiteralExpression):
/// `let Name Type = value` (issue #2224, redesigned to the
/// `object { let ... }` syntax). Unlike a plain (cref:FieldInitializer),
/// this carries a mandatory type — G# requires an explicit type annotation on
/// each anonymous-class member since (unlike C#) there is no
/// initializer-expression type inference at this syntax position.
class AnonymousClassMemberInitializer : GNode {
    /// Initializes a new instance of the (cref:AnonymousClassMemberInitializer) class.
    /// @param name The member name.
    /// @param type The member's explicit type annotation.
    /// @param value The member value.
    init(name string, type GTypeReference, value GExpression) {
        Name = name
        Type = type
        Value = value
    }

    /// Gets the member name.
    prop Name string {
        get;
    }

    /// Gets the member's explicit type annotation.
    prop Type GTypeReference {
        get;
    }

    /// Gets the member value.
    prop Value GExpression {
        get;
    }
}

/// An anonymous-class literal `object { let Name Type = value; ... }`
/// (issue #2224). Translates a C# anonymous object creation
/// `new { Name = value, ... }` — gsc synthesizes a real backing type per
/// distinct member shape (structural typing, like Roslyn's anonymous types),
/// so, unlike a positional tuple, named-member access (`x.Name`) is
/// preserved and the literal is legal inside expression-tree lambdas. Each
/// member carries an explicit type annotation (the C# compiler's own inferred
/// anonymous-type property type), since G# has no type inference at this
/// syntax position.
class AnonymousClassLiteralExpression : GExpression {
    /// Initializes a new instance of the (cref:AnonymousClassLiteralExpression) class.
    /// @param members The member name/type/value initializers, in declaration order.
    init(members IReadOnlyList[AnonymousClassMemberInitializer]) {
        Members = members ?? List[AnonymousClassMemberInitializer]()
    }

    /// Gets the member name/value initializers, in declaration order.
    prop Members IReadOnlyList[AnonymousClassMemberInitializer] {
        get;
    }
}

/// A single element of a (cref:CollectionInitializerExpression):
/// a bare element, a `key: value` pair, or an `[key] = value`
/// indexer entry (ADR-0117). A native spread is represented as a bare
/// (cref:SpreadElementExpression) value.
class CollectionInitializerElement : GNode {
    /// Initializes a new instance of the (cref:CollectionInitializerElement)
    /// class representing a bare element `e`.
    /// @param value The element expression.
    init(value GExpression) {
        Kind = CollectionInitializerElementKind.Expression
        Value = value
    }

    /// Initializes a new instance of the (cref:CollectionInitializerElement)
    /// class representing a `key: value` pair or an `[key] = value`
    /// indexer entry.
    /// @param key The key expression.
    /// @param value The value expression.
    /// @param indexed `true` for an `[key] = value` indexer entry;
    /// `false` for a `key: value` pair.
    init(key GExpression, value GExpression, indexed bool) {
        Kind = if indexed {
            CollectionInitializerElementKind.Indexed
        } else {
            CollectionInitializerElementKind.Keyed
        }
        Key = key
        Value = value
    }

    /// Initializes a new instance of the (cref:CollectionInitializerElement)
    /// class representing a nested object-member assignment.
    /// @param memberName The assigned member name.
    /// @param value The assigned value.
    init(memberName string, value GExpression) {
        Kind = CollectionInitializerElementKind.Assignment
        MemberName = memberName
        Value = value
    }

    /// Gets the element kind.
    prop Kind CollectionInitializerElementKind {
        get;
    }

    /// Gets the key expression, or `null` for a bare element.
    prop Key GExpression {
        get;
    }

    /// Gets the assigned member name, or `null` for other element kinds.
    prop MemberName string {
        get;
    }

    /// Gets the value expression.
    prop Value GExpression {
        get;
    }
}

/// A collection initializer `Target{ elements }` — e.g.
/// `List[int32]{1, 2, 3}` or `Dictionary[string, int32]{ "a": 1 }`
/// (ADR-0117). (cref:Target) is the construction call.
///
/// Issue #1567: (cref:Target) is `null` for the
/// target-less <em>member</em> collection-initializer form `{ elements }`
/// used as a composite/object-initializer member value
/// (`T{ GetOnlyProp: { a, b } }`) to populate a get-only collection
/// property at construction (gsc lowers each element to an `Add(...)`
/// call / indexer set on the constructed receiver's member).
class CollectionInitializerExpression : GExpression {
    /// Initializes a new instance of the (cref:CollectionInitializerExpression) class.
    /// @param target The construction-call target.
    /// @param elements The collection elements.
    init(target GExpression, elements IReadOnlyList[CollectionInitializerElement]? = nil) {
        Target = target
        Elements = elements ?? List[CollectionInitializerElement]()
    }

    /// Gets the construction-call target.
    prop Target GExpression? {
        get;
    }

    /// Gets the collection elements.
    prop Elements IReadOnlyList[CollectionInitializerElement] {
        get;
    }
}

/// An ellipsis spread element `...source` inside an array or collection
/// initializer.
class SpreadElementExpression : GExpression {
    /// Initializes a new instance of the (cref:SpreadElementExpression) class.
    /// @param source The enumerable source expression.
    init(source GExpression) {
        Source = source
    }

    /// Gets the enumerable source expression.
    prop Source GExpression {
        get;
    }
}

/// An array/slice literal `[]T{a, b, c}`.
class ArrayLiteralExpression : GExpression {
    /// Initializes a new instance of the (cref:ArrayLiteralExpression) class.
    /// @param elementType The element type.
    /// @param elements The element expressions.
    init(elementType GTypeReference, elements IReadOnlyList[GExpression]? = nil) {
        ElementType = elementType
        Elements = elements ?? List[GExpression]()
    }

    /// Gets the element type.
    prop ElementType GTypeReference {
        get;
    }

    /// Gets the element expressions.
    prop Elements IReadOnlyList[GExpression] {
        get;
    }
}

/// A runtime/zero-initialised array allocation written in the native G# form
/// `[n]T` (issue #1272). It allocates a zero-initialised slice `[]T`
/// of length `n` — the idiomatic replacement for the BCL call
/// `System.GC.AllocateArray[T](n)` that the C# `new T[n]` form (no
/// initializer) was previously translated to.
class ArrayAllocationExpression : GExpression {
    /// Initializes a new instance of the (cref:ArrayAllocationExpression) class.
    /// @param elementType The element type.
    /// @param length The length expression.
    convenience init(elementType GTypeReference, length GExpression) {
        init(elementType, List[GExpression]{length}, nil)
    }

    /// Initializes a new instance of the (cref:ArrayAllocationExpression) class.
    /// @param elementType Element type.
    /// @param dimensions Dimension expressions.
    /// @param elements Optional flat row-major initializer elements.
    init(
        elementType GTypeReference,
        dimensions IReadOnlyList[GExpression],
        elements IReadOnlyList[GExpression]? = nil
    ) {
        ElementType = elementType
        Dimensions = dimensions ?? List[GExpression]()
        Elements = elements ?? List[GExpression]()
    }

    /// Gets the element type.
    prop ElementType GTypeReference {
        get;
    }

    /// Gets the length expression.
    prop Length GExpression -> Dimensions[0]

    /// Gets dimension expressions.
    prop Dimensions IReadOnlyList[GExpression] {
        get;
    }

    /// Gets flat row-major initializer elements.
    prop Elements IReadOnlyList[GExpression] {
        get;
    }
}

/// An explicit G# conversion. Ordinary conversions use `Type(expr)` or
/// `Type?(expr)`; checked reference casts can request the unambiguous
/// constructor-independent `cast[Type](expr)` form.
class ConversionExpression : GExpression {
    /// Initializes a new instance of the (cref:ConversionExpression) class.
    /// @param targetType The conversion target type.
    /// @param operand The value being converted.
    /// @param isCheckedReferenceCast Whether to use the unambiguous
    /// checked-reference-cast spelling.
    init(targetType GTypeReference, operand GExpression, isCheckedReferenceCast bool = false) {
        TargetType = targetType
        Operand = operand
        IsCheckedReferenceCast = isCheckedReferenceCast
    }

    /// Gets the conversion target type.
    prop TargetType GTypeReference {
        get;
    }

    /// Gets the value being converted.
    prop Operand GExpression {
        get;
    }

    /// Gets a value indicating whether this conversion bypasses constructor binding.
    prop IsCheckedReferenceCast bool {
        get;
    }
}

/// A copy/update expression `expr with { Field = value, ... }` for data
/// structs / data classes (spec §Struct literals; ADR-0115 §B.4). Note the
/// update fields use `=` (not the `:` of a composite literal).
class WithExpression : GExpression {
    /// Initializes a new instance of the (cref:WithExpression) class.
    /// @param target The source value being copied.
    /// @param updates The field updates (may be empty for `with { }`).
    init(target GExpression, updates IReadOnlyList[FieldInitializer]? = nil) {
        Target = target
        Updates = updates ?? List[FieldInitializer]()
    }

    /// Gets the source value being copied.
    prop Target GExpression {
        get;
    }

    /// Gets the field updates.
    prop Updates IReadOnlyList[FieldInitializer] {
        get;
    }
}

/// A tuple literal `(a, b, c)` (spec §Primary expressions,
/// `TupleLiteral`) — or, with ADR-0172 labels, `(line: 1, column: 2)`.
/// A tuple literal always has at least two elements.
class TupleLiteralExpression : GExpression {
    /// Initializes a new instance of the (cref:TupleLiteralExpression) class.
    /// @param elements The tuple element expressions.
    /// @param elementNames Optional per-element labels parallel to [`elements`](paramref), null where
    /// unlabeled; pass null for a fully unlabeled literal.
    init(elements IReadOnlyList[GExpression], elementNames IReadOnlyList[string]? = nil) {
        Elements = elements ?? List[GExpression]()
        ElementNames = if elementNames != nil && elementNames.Any((n string) -> n != nil) {
            elementNames
        } else {
            default(IReadOnlyList[string]?)
        }
    }

    /// Gets the tuple element expressions.
    prop Elements IReadOnlyList[GExpression] {
        get;
    }

    /// Gets the per-element labels parallel to (cref:Elements) (`null` entries where unlabeled), or `null`
    /// when fully unlabeled (ADR-0172).
    prop ElementNames IReadOnlyList[string]? {
        get;
    }
}

/// A binary operation `left op right`.
class BinaryExpression : GExpression {
    /// Initializes a new instance of the (cref:BinaryExpression) class.
    /// @param left The left operand.
    /// @param op The operator token (e.g. `+`, `==`).
    /// @param right The right operand.
    init(left GExpression, op string, right GExpression) {
        Left = left
        Operator = op
        Right = right
    }

    /// Gets the left operand.
    prop Left GExpression {
        get;
    }

    /// Gets the operator token.
    prop Operator string {
        get;
    }

    /// Gets the right operand.
    prop Right GExpression {
        get;
    }
}

/// A prefix unary operation `op operand` (e.g. `-x`, `!flag`).
class UnaryExpression : GExpression {
    /// Initializes a new instance of the (cref:UnaryExpression) class.
    /// @param op The operator token.
    /// @param operand The operand.
    init(op string, operand GExpression) {
        Operator = op
        Operand = operand
    }

    /// Gets the operator token.
    prop Operator string {
        get;
    }

    /// Gets the operand.
    prop Operand GExpression {
        get;
    }
}

/// A postfix non-null assertion `operand!!` — the G# analogue of the C#
/// null-forgiving operator `operand!` (spec: "Postfix `!!` asserts
/// non-null").
class NonNullAssertionExpression : GExpression {
    /// Initializes a new instance of the (cref:NonNullAssertionExpression) class.
    /// @param operand The asserted operand.
    init(operand GExpression) {
        Operand = operand
    }

    /// Gets the asserted operand.
    prop Operand GExpression {
        get;
    }
}

/// A value-producing increment/decrement expression — postfix `x++` /
/// `x--` or prefix `++x` / `--x` (gsc issue #1027). G# now models
/// inc/dec as expressions, so they may appear in value positions (e.g. inside a
/// short-circuit condition) where no statement seam can hoist them.
class IncrementDecrementExpression : GExpression {
    /// Initializes a new instance of the (cref:IncrementDecrementExpression) class.
    /// @param operand The operand being mutated.
    /// @param op The operator token (`++` or `--`).
    /// @param isPrefix Whether the operator precedes the operand.
    init(operand GExpression, op string, isPrefix bool) {
        Operand = operand
        Operator = op
        IsPrefix = isPrefix
    }

    /// Gets the operand being mutated.
    prop Operand GExpression {
        get;
    }

    /// Gets the operator token.
    prop Operator string {
        get;
    }

    /// Gets a value indicating whether the operator precedes the operand.
    prop IsPrefix bool {
        get;
    }
}

/// A `stackalloc [count]ElemType` expression (gsc issues #1024, #1057,
/// #1041) in G#-style array grammar (the bracketed count first, then the
/// element type). In a safe context this yields a `Span<T>`;
/// targeting a raw pointer inside an `unsafe` context yields `T*`.
/// An optional brace-delimited initializer supplies the element values.
class StackAllocExpression : GExpression {
    /// Initializes a new instance of the (cref:StackAllocExpression) class.
    /// @param elementType The element type.
    /// @param count The element-count expression.
    /// @param elements The optional initializer element values.
    init(elementType GTypeReference, count GExpression, elements IReadOnlyList[GExpression]? = nil) {
        ElementType = elementType
        Count = count
        Elements = elements
    }

    /// Gets the element type.
    prop ElementType GTypeReference {
        get;
    }

    /// Gets the element-count expression.
    prop Count GExpression? {
        get;
    }

    /// Gets the optional initializer element values, or `null` when there is no initializer.
    prop Elements IReadOnlyList[GExpression]? {
        get;
    }
}

/// An assignment used in VALUE position — `target = value` yielding the
/// assigned value (ADR-0161 / issue #3350).
/// @remarks G# has had assignment as a full expression for some time; the belief that it
/// was statement-only (repeated in several cs2gs comments and in issue #3347)
/// was wrong. Emitting this node instead of hoisting the write into a preceding
/// (cref:AssignmentStatement) removes the synthetic `__spillN` temps
/// that carried the assigned value, and fixes the issue #1723 case where an
/// assignment inside a short-circuited operand was DROPPED because no statement
/// seam could legally host it.
///
/// The printer parenthesizes the whole form. That is required in an argument
/// list — where a bare `name = value` warns as the retired named-argument
/// spelling (GS0524, ADR-0161) — and is harmless everywhere else.
class AssignmentExpression : GExpression {
    /// Initializes a new instance of the (cref:AssignmentExpression) class.
    /// @param target The assignment target.
    /// @param value The assigned value.
    /// @param op The assignment operator (defaults to `=`).
    init(target GExpression, value GExpression, op string = "=") {
        Target = target
        Value = value
        Operator = op
    }

    /// Gets the assignment target.
    prop Target GExpression {
        get;
    }

    /// Gets the assigned value.
    prop Value GExpression {
        get;
    }

    /// Gets the assignment operator.
    prop Operator string {
        get;
    }
}

/// A native boolean pattern test, `value is pattern` (ADR-0162 / issue
/// #3351).
class PatternTestExpression : GExpression {
    /// Initializes a new instance of the (cref:PatternTestExpression) class.
    /// @param value The value tested by the pattern.
    /// @param pattern The non-binding pattern.
    init(value GExpression, pattern GPattern) {
        Value = value
        Pattern = pattern
    }

    /// Gets the tested value.
    prop Value GExpression {
        get;
    }

    /// Gets the pattern.
    prop Pattern GPattern {
        get;
    }
}

/// A parenthesized expression `(inner)`.
class ParenthesizedExpression : GExpression {
    /// Initializes a new instance of the (cref:ParenthesizedExpression) class.
    /// @param inner The inner expression.
    init(inner GExpression) {
        Inner = inner
    }

    /// Gets the inner expression.
    prop Inner GExpression {
        get;
    }
}

/// A `checked(inner)`/`unchecked(inner)` expression (issue #1881).
/// G# has no compile-time constant folding, so unlike real C# a checked
/// constant overflow is not a translation-time error here — it is simply
/// evaluated at run time like any other checked arithmetic.
class CheckedExpression : GExpression {
    /// Initializes a new instance of the (cref:CheckedExpression) class.
    /// @param inner The inner expression.
    /// @param isChecked `true` for `checked(...)`, `false` for `unchecked(...)`.
    init(inner GExpression, isChecked bool) {
        Inner = inner
        IsChecked = isChecked
    }

    /// Gets the inner expression.
    prop Inner GExpression {
        get;
    }

    /// Gets a value indicating whether this is `checked(...)` (true) or `unchecked(...)` (false).
    prop IsChecked bool {
        get;
    }
}

/// A lambda (ADR-0074). An expression body renders as the arrow form
/// `(x int32) -> expr` (an expression-block); a block body renders as the
/// function-literal form `func (x int32) RetType { … }` (a statement-block),
/// which handles control flow and supplies an explicit (cref:ReturnType) for
/// value-returning literals.
class LambdaExpression : GExpression {
    /// Initializes a new instance of the (cref:LambdaExpression) class.
    /// @param parameters The lambda parameters.
    /// @param expressionBody The single-expression body, when present.
    /// @param blockBody The block body, when present.
    /// @param isAsync Whether the lambda is asynchronous.
    /// @param returnType The explicit return type for a function-literal block body
    /// ((cref:IsFunctionLiteral) is `true`), or
    /// `null` when the block returns no value (void), the body is an
    /// expression, or the lambda renders as the arrow form. The function-literal form
    /// `func (params) RetType { … }` needs the explicit return type so a
    /// value-returning literal is not inferred as `void`; an arrow lambda
    /// (ADR-0128) infers its return type, so none is required.
    /// @param isFunctionLiteral When `true`, a block body renders as the G# function-literal
    /// form `func (params) RetType { … }` (used for C# local functions, which are
    /// not arrow lambdas). When `false` (the default), a block body
    /// renders as the idiomatic arrow form `(params) -> { … }` (ADR-0128 /
    /// issue #1172), whose statement-block body reaches parity with func literals.
    /// @param isRefReturn Whether the function literal returns by reference.
    init(
        parameters IReadOnlyList[Parameter],
        expressionBody GExpression? = nil,
        blockBody BlockStatement? = nil,
        isAsync bool = false,
        returnType GTypeReference? = nil,
        isFunctionLiteral bool = false,
        isRefReturn bool = false
    ) {
        Parameters = parameters ?? List[Parameter]()
        ExpressionBody = expressionBody
        BlockBody = blockBody
        IsAsync = isAsync
        ReturnType = returnType
        IsFunctionLiteral = isFunctionLiteral
        IsRefReturn = isRefReturn
    }

    /// Gets the lambda parameters.
    prop Parameters IReadOnlyList[Parameter] {
        get;
    }

    /// Gets the single-expression body, or `null` for a block body.
    prop ExpressionBody GExpression? {
        get;
    }

    /// Gets the block body, or `null` for an expression body.
    prop BlockBody BlockStatement? {
        get;
    }

    /// Gets a value indicating whether the lambda is asynchronous.
    prop IsAsync bool {
        get;
    }

    /// Gets the explicit return type for a function-literal block body, or
    /// `null` when the block is void, the body is an expression, or
    /// the lambda renders as the arrow form (whose return type is inferred).
    prop ReturnType GTypeReference? {
        get;
    }

    /// Gets a value indicating whether a block body renders as the G#
    /// function-literal form `func (params) RetType { … }` (true, for C# local
    /// functions) rather than the idiomatic arrow form `(params) -> { … }`
    /// (false, the default — ADR-0128 / issue #1172).
    prop IsFunctionLiteral bool {
        get;
    }

    /// Gets a value indicating whether a function literal returns by reference.
    prop IsRefReturn bool {
        get;
    }
}

/// An `await` expression `await operand` (ADR-0115 §B; samples
/// `AsyncTask.gs`, `AsyncAwaitInLoop.gs`). Suspends until the awaited
/// task completes and yields its result.
class AwaitExpression : GExpression {
    /// Initializes a new instance of the (cref:AwaitExpression) class.
    /// @param operand The awaited operand.
    init(operand GExpression) {
        Operand = operand
    }

    /// Gets the awaited operand.
    prop Operand GExpression {
        get;
    }
}

/// One arm of a (cref:SwitchExpression): a pattern (or `default`
/// when (cref:Pattern) is `null`) and the result
/// expression it yields.
class SwitchArm : GNode {
    /// Initializes a new instance of the (cref:SwitchArm) class.
    /// @param pattern The arm pattern, or `null` for the `default` arm.
    /// @param body The result expression.
    /// @param guard The optional `when` guard expression, or `null`.
    init(pattern GPattern, body GExpression, $guard GExpression? = nil) {
        Pattern = pattern
        Body = body
        Guard = $guard
    }

    /// Gets the arm pattern, or `null` for the `default` arm.
    prop Pattern GPattern? {
        get;
    }

    /// Gets the result expression.
    prop Body GExpression {
        get;
    }

    /// Gets the optional `when` guard expression, or `null` when the arm has no guard.
    prop Guard GExpression? {
        get;
    }
}

/// A `switch` expression `switch subject { case <pattern>: <expr> … default: <expr> }`
/// (spec §Pattern matching; samples `SwitchExpression.gs`). Used in
/// expression position (assignable / returnable).
class SwitchExpression : GExpression {
    /// Initializes a new instance of the (cref:SwitchExpression) class.
    /// @param subject The value being matched.
    /// @param arms The ordered arms.
    init(subject GExpression, arms IReadOnlyList[SwitchArm]) {
        Subject = subject
        Arms = arms ?? List[SwitchArm]()
    }

    /// Gets the value being matched.
    prop Subject GExpression {
        get;
    }

    /// Gets the ordered arms.
    prop Arms IReadOnlyList[SwitchArm] {
        get;
    }
}

/// One segment of an interpolated string: either literal text or a hole.
class InterpolationPart : GNode {
    private init(text string?, expression GExpression?, alignment string?, format string?) {
        Text = text
        Expression = expression
        Alignment = alignment
        Format = format
    }

    /// Gets the literal (unescaped) text for a text segment, else `null`.
    prop Text string? {
        get;
    }

    /// Gets the hole expression for a hole segment, else `null`.
    prop Expression GExpression? {
        get;
    }

    /// Gets the optional alignment specifier for a hole.
    prop Alignment string? {
        get;
    }

    /// Gets the optional format specifier for a hole.
    prop Format string? {
        get;
    }

    /// Gets a value indicating whether this part is a hole.
    prop IsHole bool -> Expression != nil

    shared {
        /// Creates a literal-text part from its unescaped text.
        /// @param text The unescaped text.
        /// @returns The part.
        func Literal(text string) InterpolationPart -> InterpolationPart(text, nil, nil, nil)

        /// Creates a hole part.
        /// @param expression The hole expression.
        /// @param alignment The optional alignment specifier.
        /// @param format The optional format specifier.
        /// @returns The part.
        func Hole(
            expression GExpression,
            alignment string? = nil,
            format string? = nil
        ) InterpolationPart -> InterpolationPart(nil, expression, alignment, format)
    }
}

/// An interpolated string (ADR-0055, ADR-0115 §B.9). Every G# string literal is
/// interpolation-capable, so there is no `$` prefix; holes use
/// `${expr}` (or `$ident` for a bare identifier) and a literal
/// `$` in surrounding text is escaped to `$$`.
class InterpolatedStringExpression : GExpression {
    /// Initializes a new instance of the (cref:InterpolatedStringExpression) class.
    /// @param parts The ordered segments.
    init(parts IReadOnlyList[InterpolationPart]) {
        Parts = parts ?? List[InterpolationPart]()
    }

    /// Gets the ordered segments.
    prop Parts IReadOnlyList[InterpolationPart] {
        get;
    }
}

/// An `if` expression used in value position
/// (`if cond { thenExpr } else { elseExpr }`; ADR-0064, issue #711,
/// sample `IfExpression.gs`). The canonical G# form for a C# conditional
/// (ternary) expression `cond ? a : b` (ADR-0115 §B).
class IfExpression : GExpression {
    /// Initializes a new instance of the (cref:IfExpression) class.
    /// @param condition The condition expression.
    /// @param thenExpression The value of the then-branch.
    /// @param elseExpression The value of the else-branch.
    /// @param thenStatements Statements evaluated before the then-branch value.
    /// @param elseStatements Statements evaluated before the else-branch value.
    init(
        condition GExpression,
        thenExpression GExpression,
        elseExpression GExpression,
        thenStatements IReadOnlyList[GStatement]? = nil,
        elseStatements IReadOnlyList[GStatement]? = nil
    ) {
        Condition = condition
        ThenExpression = thenExpression
        ElseExpression = elseExpression
        ThenStatements = thenStatements ?? List[GStatement]()
        ElseStatements = elseStatements ?? List[GStatement]()
    }

    /// Gets the condition expression.
    prop Condition GExpression {
        get;
    }

    /// Gets the then-branch value expression.
    prop ThenExpression GExpression {
        get;
    }

    /// Gets the else-branch value expression.
    prop ElseExpression GExpression {
        get;
    }

    /// Gets statements evaluated before the then-branch value.
    prop ThenStatements IReadOnlyList[GStatement] {
        get;
    }

    /// Gets statements evaluated before the else-branch value.
    prop ElseStatements IReadOnlyList[GStatement] {
        get;
    }
}

/// One `let name [T] = expr` clause of an (cref:IfLetExpression)
/// header (ADR-0151; ADR-0071 for the shared binding rules). The initializer
/// must be of nullable type; the binding is observed at the underlying
/// non-null type inside the guard and the then-branch.
class IfLetBinding : GNode {
    /// Initializes a new instance of the (cref:IfLetBinding) class.
    /// @param name The bound name.
    /// @param initializer The nullable initializer expression.
    /// @param declaredType The optional explicit UNDERLYING (non-null) type clause.
    init(name string, initializer GExpression, declaredType GTypeReference? = nil) {
        Name = name
        Initializer = initializer
        DeclaredType = declaredType
    }

    /// Gets the bound name.
    prop Name string {
        get;
    }

    /// Gets the optional explicit underlying (non-null) type clause.
    prop DeclaredType GTypeReference? {
        get;
    }

    /// Gets the nullable initializer expression.
    prop Initializer GExpression {
        get;
    }
}

/// An `if let` expression used in value position — ADR-0151:
/// `if let a = e [, let b = e2]* [&& guard] { thenValue } else { elseValue }`.
/// The canonical G# form for a C# conditional whose condition is a bare
/// non-null declaration pattern (`receiver is { } name [&& predicate]`),
/// which otherwise needs a single-evaluation spill temp plus a `!!` at
/// every binder reference.
class IfLetExpression : GExpression {
    /// Initializes a new instance of the (cref:IfLetExpression) class.
    /// @param bindings The comma-separated binding clauses (at least one).
    /// @param guard The optional boolean guard introduced by a top-level `&&`, or `null`.
    /// @param thenExpression The value of the then-branch.
    /// @param elseExpression The value of the (mandatory) else-branch.
    init(
        bindings IReadOnlyList[IfLetBinding],
        $guard GExpression,
        thenExpression GExpression,
        elseExpression GExpression
    ) {
        Bindings = bindings ?? List[IfLetBinding]()
        Guard = $guard
        ThenExpression = thenExpression
        ElseExpression = elseExpression
    }

    /// Gets the binding clauses, in source order.
    prop Bindings IReadOnlyList[IfLetBinding] {
        get;
    }

    /// Gets the optional boolean guard, or `null` when absent.
    prop Guard GExpression? {
        get;
    }

    /// Gets the then-branch value expression.
    prop ThenExpression GExpression {
        get;
    }

    /// Gets the else-branch value expression.
    prop ElseExpression GExpression {
        get;
    }
}

/// An `out`-argument declaration passed to a method's `out` parameter
/// (ADR-0115 §B; sample `TryParseOutVar.gs`). Renders the inline
/// declaration forms `out var x`, `out let x`, or the discard
/// `out _`. A C# `out` argument naming a pre-declared variable maps
/// instead to the address-of form `&x` (a (cref:UnaryExpression)).
class OutArgumentExpression : GExpression {
    /// Initializes a new instance of the (cref:OutArgumentExpression) class.
    /// @param keyword The leading keyword (`out var`, `out let`, or `out`).
    /// @param name The declared local name, or `_` for a discard.
    init(keyword string, name string) {
        Keyword = keyword
        Name = name
    }

    /// Gets the leading keyword.
    prop Keyword string {
        get;
    }

    /// Gets the declared local name (or `_`).
    prop Name string {
        get;
    }
}

/// A `typeof(T)` expression (spec §Primary expressions; ADR-0115 §B). The
/// C# `typeof(T)` maps directly to the identically-spelled G# form, whose
/// argument is a type clause rather than an expression.
class TypeOfExpression : GExpression {
    /// Initializes a new instance of the (cref:TypeOfExpression) class.
    /// @param type The type whose runtime `System.Type` is taken.
    init(type GTypeReference) {
        Type = type
    }

    /// Gets the type whose runtime token is taken.
    prop Type GTypeReference {
        get;
    }
}

/// A `default(T)` / bare `default` expression (ADR-0100; spec
/// §Primary expressions). The C# `default(T)` maps to `default(T)`;
/// the C# target-typed `default` literal maps to the bare `default`
/// form, whose type is supplied by the surrounding context.
class DefaultValueExpression : GExpression {
    /// Initializes a new instance of the (cref:DefaultValueExpression) class.
    /// @param type The explicit type, or `null` for the bare form.
    init(type GTypeReference? = nil) {
        Type = type
    }

    /// Gets the explicit target type, or `null` for bare `default`.
    prop Type GTypeReference? {
        get;
    }
}

/// A type used in expression position — the right operand of an `as` or
/// `is` type test (e.g. `o as []object`, `o is string`). Renders
/// the canonical G# type clause (slices as `[]T`, generics as `T[U]`).
class TypeExpression : GExpression {
    /// Initializes a new instance of the (cref:TypeExpression) class.
    /// @param type The referenced type.
    init(type GTypeReference) {
        Type = type
    }

    /// Gets the referenced type.
    prop Type GTypeReference {
        get;
    }
}

/// The empty receiver placeholder at the head of a null-conditional
/// continuation (`?.b`, `?[i]`, `?.M()`). It renders as the empty
/// string so the enclosing member-access / index / invocation emits the bare
/// `.b` / `[i]` / `.M()` tail that follows the `?`.
class ConditionalReceiverExpression : GExpression { }

/// A null-conditional access `target?{whenNotNull}` — the C#
/// `a?.b`, `a?.b()`, `a?[i]` forms, which map directly to the
/// identically-spelled G# null-conditional member / index / call (spec
/// §Member access and indexing). The (cref:WhenNotNull) continuation is
/// rooted at a (cref:ConditionalReceiverExpression) so it renders as the
/// bare `.b` / `[i]` / `.b()` tail.
class ConditionalAccessExpression : GExpression {
    /// Initializes a new instance of the (cref:ConditionalAccessExpression) class.
    /// @param target The receiver tested for null.
    /// @param whenNotNull The continuation evaluated when the receiver is non-null.
    init(target GExpression, whenNotNull GExpression) {
        Target = target
        WhenNotNull = whenNotNull
    }

    /// Gets the receiver tested for null.
    prop Target GExpression {
        get;
    }

    /// Gets the non-null continuation.
    prop WhenNotNull GExpression {
        get;
    }
}

/// A C# `throw` expression used in value position (`a ?? throw e`,
/// `cond ? a : throw e`, a `switch` arm value). G# supports
/// throw-as-expression natively (issue #1153), so it renders as a bare
/// `throw e` in coalesce-RHS, switch-arm, and ternary positions. In the one
/// position gsc rejects a bare throw — the sole trailing value of an
/// if-expression block branch (GS0277) — it is emitted as a throw STATEMENT
/// followed by a value-producing typed tail: `throw e\n default(T)`.
class ThrowExpression : GExpression {
    /// Initializes a new instance of the (cref:ThrowExpression) class.
    /// @param operand The thrown exception value.
    /// @param resultType The type the surrounding if-expression block branch expects, used for the
    /// value-producing `default(T)` tail. May be `null` when
    /// no type is resolvable, in which case a bare `default` is emitted.
    init(operand GExpression, resultType GTypeReference) {
        Operand = operand
        ResultType = resultType
    }

    /// Gets the thrown exception value.
    prop Operand GExpression {
        get;
    }

    /// Gets the result type used for the if-expression block branch tail.
    prop ResultType GTypeReference? {
        get;
    }
}
