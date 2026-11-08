// <copyright file="BoundConstantPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0208 (#5593): the test that the emitter produces for a constant pattern. `NullCheck` tests the reference,
/// `StringEquals` calls `string.Equals(string, string)`, `DecimalEquals` calls `decimal.op_Equality`,
/// `BoxedFloatEquals` unboxes a floating-point input with `isinst` and compares it with `ceq`, `ObjectEquals` calls
/// `object.Equals(object, object)`, which calls the virtual `Equals` of the input, and `PrimitiveEquals` is `ceq`.
internal enum ConstantPatternTestKind {
    NullCheck,
    StringEquals,
    DecimalEquals,
    BoxedFloatEquals,
    ObjectEquals,
    PrimitiveEquals
}

/// Bound constant pattern.
class BoundConstantPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundConstantPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param value The value expression.
    init(syntax SyntaxNode?, type TypeSymbol, value BoundExpression) : base(syntax, type) {
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.ConstantPattern

    /// Gets the value expression.
    prop Value BoundExpression {
        get;
    }

    shared {
        /// ADR-0208 (#5593): the one decision of which test a constant pattern emits. The emitter emits it, and the
        /// narrowing effect collector counts an `ObjectEquals` test as a call when the input's `Equals` can be user
        /// code.
        /// @param valueType The static type of the tested value.
        /// @param value The pattern value.
        /// @returns The test.
        internal func ClassifyTest(
            valueType TypeSymbol,
            value BoundExpression
        ) ConstantPatternTestKind -> ClassifyTestOf(
            valueType,
            value is BoundLiteralExpression literal && literal.Value == nil,
            UnwrapInputConversion(valueType, value).Type
        )

        /// The test that a constant pattern emits, from the types alone (ADR-0213: the loop walker has no bound
        /// value): the static type of the tested value, whether the pattern value is the `nil` literal, and the type
        /// of the pattern value without its conversion to the input type, or `nil` when it is not known.
        internal func ClassifyTestOf(
            valueType TypeSymbol,
            valueIsNullLiteral bool,
            patternValueType TypeSymbol?
        ) ConstantPatternTestKind {
            if valueIsNullLiteral {
                return ConstantPatternTestKind.NullCheck
            }
            if valueType == TypeSymbol.String ||
                (
                valueType is NullableTypeSymbol nullableString && nullableString.UnderlyingType == TypeSymbol.String
            ) ||
                (valueType is PlatformTypeSymbol platformString && platformString.UnderlyingType == TypeSymbol.String) {
                return ConstantPatternTestKind.StringEquals
            }
            if valueType == TypeSymbol.Decimal {
                return ConstantPatternTestKind.DecimalEquals
            }
            let isObject = valueType.ClrType is {} clrType && ClrTypeInspector.IsSameAs(clrType, typeof(object))
            let isValueNullable = valueType is NullableTypeSymbol nullable && NullableLifting.IsValueTypeNullable(
                nullable
            )
            if !isObject && !isValueNullable {
                return ConstantPatternTestKind.PrimitiveEquals
            }
            return if patternValueType == TypeSymbol.Float32 || patternValueType == TypeSymbol.Float64 {
                ConstantPatternTestKind.BoxedFloatEquals
            } else {
                ConstantPatternTestKind.ObjectEquals
            }
        }

        /// The pattern value without the one conversion to the input type that the binder adds. Inner conversions
        /// stay: they decide the run-time type of the value.
        /// @param valueType The static type of the tested value.
        /// @param value The pattern value.
        /// @returns The value before that conversion.
        internal func UnwrapInputConversion(
            valueType TypeSymbol,
            value BoundExpression
        ) BoundExpression -> if value is BoundConversionExpression conversion &&
            conversion.Type == valueType &&
            conversion.IsPatternInputConversion {
            conversion.Expression
        } else {
            value
        }
    }
}
