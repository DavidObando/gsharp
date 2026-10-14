// <copyright file="BoundIsExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression-level pattern test: `expr is pattern` → `bool`.
/// Issues #575 and #3351.
class BoundIsExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundIsExpression) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression whose runtime type is tested.
    /// @param targetType The type to test against.
    convenience init(syntax SyntaxNode?, expression BoundExpression, targetType TypeSymbol) {
        init(
            syntax,
            expression,
            BoundTypePattern(
                syntax,
                expression.Type,
                targetType,
                LocalVariableSymbol("<is-type-value>", isReadOnly: true, targetType),
                hasBinding: false,
                propertyPattern: nil
            )
        )
    }

    /// Initializes a new instance of the (cref:BoundIsExpression) class.
    /// @param syntax The originating syntax.
    /// @param expression The expression whose value is tested.
    /// @param pattern The bound pattern.
    init(syntax SyntaxNode?, expression BoundExpression, pattern BoundPattern) : base(syntax) {
        Expression = expression
        Pattern = pattern
        InputVariable = LocalVariableSymbol("<is-pattern-input>", isReadOnly: true, expression.Type)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.IsExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeSymbol.Bool

    /// Gets the expression being type-tested.
    prop Expression BoundExpression {
        get;
    }

    /// Gets the pattern tested against (cref:Expression).
    prop Pattern BoundPattern {
        get;
    }

    /// Gets the synthesized local that holds the expression value exactly once.
    prop InputVariable LocalVariableSymbol {
        get;
    }

    /// Gets the tested type of a plain type test — the Roslyn
    /// `IIsTypeOperation.TypeOperand` analogue (ADR-0169, issue #4436).
    /// Roslyn models only a plain `x is T` as an is-type operation (a
    /// declaration or recursive pattern is an is-pattern operation over a
    /// pattern), so this is `null` unless
    /// (cref:IsSimpleTypeTest); the pattern forms are reached through
    /// their (cref:BoundTypePattern).
    prop TypeOperand TypeSymbol? -> if IsSimpleTypeTest {
        TargetType
    } else {
        default(TypeSymbol?)
    }

    /// Gets the direct tested type when the pattern starts with a type test.
    prop TargetType TypeSymbol? -> if Pattern is BoundTypePattern typePattern {
        typePattern.TargetType
    } else {
        default(TypeSymbol?)
    }

    /// Gets a value indicating whether this is a plain type test with no
    /// recursive suffix and no pattern variable (ADR-0166): the shape the
    /// emitter lowers to a bare `isinst` without storing the value.
    prop IsSimpleTypeTest bool -> Pattern is BoundTypePattern typePattern &&
        typePattern.PropertyPattern == nil &&
        !typePattern.HasBinding
}
