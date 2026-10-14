// <copyright file="BoundPatternSwitchArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis

/// Bound arm for a pattern switch statement.
class BoundPatternSwitchArm : BoundNode {
    /// Initializes a new instance of the (cref:BoundPatternSwitchArm) class.
    /// @param syntax The originating syntax.
    /// @param pattern The arm pattern, or null for default.
    /// @param guard The optional boolean guard expression (`when` clause), or null.
    /// @param body The arm body.
    init(syntax SyntaxNode?, pattern BoundPattern?, $guard BoundExpression?, body BoundStatement) : base(syntax) {
        Pattern = pattern
        Guard = $guard
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.PatternSwitchArm

    /// Gets the pattern, or null for default.
    prop Pattern BoundPattern? {
        get;
    }

    /// Gets the optional boolean guard expression (`when` clause), or null when the arm has no guard.
    prop Guard BoundExpression? {
        get;
    }

    /// Gets the arm body.
    prop Body BoundStatement {
        get;
    }

    /// Gets a value indicating whether this is the default arm.
    @MemberNotNullWhen(false, "Pattern")
    prop IsDefault bool -> Pattern == nil
}
