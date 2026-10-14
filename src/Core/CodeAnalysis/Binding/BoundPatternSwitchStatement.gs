// <copyright file="BoundPatternSwitchStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound pattern switch statement evaluated by the interpreter.
class BoundPatternSwitchStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundPatternSwitchStatement) class.
    /// @param syntax The originating syntax.
    /// @param discriminant The discriminant expression.
    /// @param arms The switch arms.
    /// @param isExhaustive Whether closed-type analysis proved that the arms cover every value.
    init(
        syntax SyntaxNode?,
        discriminant BoundExpression,
        arms ImmutableArray[BoundPatternSwitchArm],
        isExhaustive bool
    ) : base(syntax) {
        Discriminant = discriminant
        Arms = arms
        IsExhaustive = isExhaustive
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.PatternSwitchStatement

    /// Gets the discriminant expression.
    prop Discriminant BoundExpression {
        get;
    }

    /// Gets the switch arms.
    prop Arms ImmutableArray[BoundPatternSwitchArm] {
        get;
    }

    /// Gets a value indicating whether closed-type analysis proved that the switch is exhaustive.
    prop IsExhaustive bool {
        get;
    }
}
