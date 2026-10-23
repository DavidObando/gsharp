// <copyright file="MemberFieldAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a chained member-access assignment whose receiver is an arbitrary
/// expression rather than a bare identifier, e.g. `a.B.C = value` or
/// `GetObj().Field = value`. Issue #648: this complements
/// (cref:FieldAssignmentExpressionSyntax) (which is restricted to a
/// single identifier on the left of the dot) by allowing the assigned target
/// to be reached through any expression that produces a value with a settable
/// member.
partial class MemberFieldAssignmentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:MemberFieldAssignmentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param receiver The expression producing the receiver (everything before the last dot).
    /// @param dotToken The dot token preceding the assigned field/property.
    /// @param fieldIdentifier The field or property name being assigned.
    /// @param equalsToken The equals token.
    /// @param value The value expression on the right of the equals sign.
    init(
        syntaxTree SyntaxTree,
        receiver ExpressionSyntax,
        dotToken SyntaxToken,
        fieldIdentifier SyntaxToken,
        equalsToken SyntaxToken,
        value ExpressionSyntax
    ) : base(syntaxTree) {
        Receiver = receiver
        DotToken = dotToken
        FieldIdentifier = fieldIdentifier
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.MemberFieldAssignmentExpression

    /// Gets the receiver expression (the chain before the last dot).
    prop Receiver ExpressionSyntax {
        get;
    }

    /// Gets the dot token.
    prop DotToken SyntaxToken {
        get;
    }

    /// Gets the field/property identifier being assigned.
    prop FieldIdentifier SyntaxToken {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression on the right of the equals sign.
    prop Value ExpressionSyntax {
        get;
    }
}
