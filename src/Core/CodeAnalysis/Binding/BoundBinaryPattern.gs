// <copyright file="BoundBinaryPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound binary pattern combinator: a conjunction (`and`) or disjunction
/// (`or`) of two sub-patterns. For `and` both sub-patterns must
/// match (left-to-right, right evaluated only if the left matched); for
/// `or` either sub-pattern matching succeeds (short-circuit).
class BoundBinaryPattern : BoundPattern {
    /// Initializes a new instance of the (cref:BoundBinaryPattern) class.
    /// @param syntax The originating syntax.
    /// @param type The discriminant type.
    /// @param isConjunction `true` for `and`; `false` for `or`.
    /// @param left The left sub-pattern.
    /// @param right The right sub-pattern.
    /// @param rightInputVariable A narrowed left-hand value used to bind and evaluate the right side.
    init(
        syntax SyntaxNode?,
        type TypeSymbol,
        isConjunction bool,
        left BoundPattern,
        right BoundPattern,
        rightInputVariable LocalVariableSymbol? = nil
    ) : base(syntax, type) {
        IsConjunction = isConjunction
        Left = left
        Right = right
        RightInputVariable = rightInputVariable
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.BinaryPattern

    /// Gets a value indicating whether this is an `and` (conjunction) pattern.
    prop IsConjunction bool {
        get;
    }

    /// Gets the left sub-pattern.
    prop Left BoundPattern {
        get;
    }

    /// Gets the right sub-pattern.
    prop Right BoundPattern {
        get;
    }

    /// Gets the narrowed input local used by the right side of an `and` pattern.
    prop RightInputVariable LocalVariableSymbol? {
        get;
    }
}
