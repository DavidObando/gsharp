// <copyright file="BoundSwitchExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound switch expression.
class BoundSwitchExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundSwitchExpression) class.
    /// @param syntax The originating syntax.
    /// @param discriminant The bound discriminant expression.
    /// @param arms The bound switch-expression arms.
    /// @param type The unified result type.
    init(
        syntax SyntaxNode?,
        discriminant BoundExpression,
        arms ImmutableArray[BoundSwitchExpressionArm],
        type TypeSymbol
    ) : base(syntax) {
        Discriminant = discriminant
        Arms = arms
        _type = type
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.SwitchExpression

    /// Gets the bound discriminant expression.
    prop Discriminant BoundExpression {
        get;
    }

    /// Gets the bound switch-expression arms.
    prop Arms ImmutableArray[BoundSwitchExpressionArm] {
        get;
    }

    /// Enumerates dispatch order: the default runs after all other patterns.
    internal func GetDispatchArms() sequence[BoundSwitchExpressionArm] {
        for arm in Arms {
            if !arm.IsDefault {
                yield arm
            }
        }
        for arm in Arms {
            if arm.IsDefault {
                yield arm
            }
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type
}
