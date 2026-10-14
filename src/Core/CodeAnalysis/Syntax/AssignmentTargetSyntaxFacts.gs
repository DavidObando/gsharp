// <copyright file="AssignmentTargetSyntaxFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Diagnostics.CodeAnalysis

/// Shared syntax shaping for assignment targets.
internal shared class AssignmentTargetSyntaxFacts {
    /// Removes grouping parentheses from an assignment target.
    func UnwrapParentheses(expression ExpressionSyntax) ExpressionSyntax {
        var expression = expression
        while expression is ParenthesizedExpressionSyntax parenthesized {
            expression = parenthesized.Expression
        }
        return expression
    }

    /// Builds the existing single-assignment syntax node for a parsed target.
    func TryCreateAssignment(
        target ExpressionSyntax,
        equalsToken SyntaxToken,
        value ExpressionSyntax,
        @NotNullWhen(true) out assignment ExpressionSyntax?
    ) bool {
        if target is NameExpressionSyntax name {
            assignment = AssignmentExpressionSyntax(target.SyntaxTree, name.IdentifierToken, equalsToken, value)
            return true
        }
        if TryLiftTrailingIndexer(target, out var indexed) {
            if !indexed.IsNullConditional && indexed.Target is NameExpressionSyntax indexedName {
                assignment = IndexAssignmentExpressionSyntax(
                    target.SyntaxTree,
                    indexedName.IdentifierToken,
                    indexed.OpenBracketToken,
                    indexed.Indices,
                    indexed.CloseBracketToken,
                    equalsToken,
                    value
                )
            } else {
                assignment = MemberIndexAssignmentExpressionSyntax(target.SyntaxTree, indexed, equalsToken, value)
            }
            return true
        }
        if TryLiftTrailingMemberAccess(target, out var receiver, out var dotToken, out var fieldIdentifier) {
            assignment = if receiver is NameExpressionSyntax receiverName && dotToken.Kind == SyntaxKind.DotToken {
                cast[ExpressionSyntax](
                    FieldAssignmentExpressionSyntax(
                        target.SyntaxTree,
                        receiverName.IdentifierToken,
                        dotToken,
                        fieldIdentifier,
                        equalsToken,
                        value
                    )
                )
            } else {
                cast[ExpressionSyntax](
                    MemberFieldAssignmentExpressionSyntax(
                        target.SyntaxTree,
                        receiver,
                        dotToken,
                        fieldIdentifier,
                        equalsToken,
                        value
                    )
                )
            }
            return true
        }
        if target is UnaryExpressionSyntax dereference && dereference.OperatorToken.Kind == SyntaxKind.StarToken {
            assignment = IndirectAssignmentExpressionSyntax(target.SyntaxTree, dereference, equalsToken, value)
            return true
        }
        if target is BaseInterfaceCallExpressionSyntax baseProperty &&
            baseProperty.IsPropertyAccess &&
            !baseProperty
            .IsPropertyWrite {
            assignment = BaseInterfaceCallExpressionSyntax(
                target.SyntaxTree,
                baseProperty.BaseKeyword,
                baseProperty.OpenBracketToken,
                baseProperty.InterfaceTypeClause,
                baseProperty.CloseBracketToken,
                baseProperty.DotToken,
                baseProperty.MethodIdentifier,
                equalsToken,
                value
            )
            return true
        }
        assignment = nil
        return false
    }

    /// Returns whether an expression's outermost operation is a call.
    func IsCallResult(expression ExpressionSyntax) bool -> switch UnwrapParentheses(expression) {
        case _ is CallExpressionSyntax: true
        case accessorExpressionSyntax is AccessorExpressionSyntax when accessorExpressionSyntax.RightPart is CallExpressionSyntax: true
        case _ is BaseClassCallExpressionSyntax: true
        case baseInterfaceCallExpressionSyntax is BaseInterfaceCallExpressionSyntax when baseInterfaceCallExpressionSyntax.IsPropertyAccess == false: true
        default: false
    }

    /// Canonicalizes an expression whose rightmost primary is an index access.
    func TryLiftTrailingIndexer(
        expression ExpressionSyntax,
        @NotNullWhen(true) out canonical IndexExpressionSyntax?
    ) bool {
        if expression is IndexExpressionSyntax direct {
            canonical = direct
            return true
        }
        if expression is AccessorExpressionSyntax accessor &&
            TryLiftTrailingIndexer(accessor.RightPart, out var inner) {
            let rebuiltReceiver = AccessorExpressionSyntax(
                expression.SyntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                inner!!.Target
            )
            canonical = IndexExpressionSyntax(
                expression.SyntaxTree,
                rebuiltReceiver,
                inner!!.OpenBracketToken,
                inner!!.Indices,
                inner!!.CloseBracketToken
            )
            return true
        }
        canonical = nil
        return false
    }

    /// Splits an accessor expression at its terminal member name.
    func TryLiftTrailingMemberAccess(
        expression ExpressionSyntax,
        @NotNullWhen(true) out receiver ExpressionSyntax?,
        @NotNullWhen(true) out dotToken SyntaxToken?,
        @NotNullWhen(true) out fieldIdentifier SyntaxToken?
    ) bool {
        receiver = nil
        dotToken = nil
        fieldIdentifier = nil
        if expression is AccessorExpressionSyntax accessor {
            if accessor.RightPart is NameExpressionSyntax name {
                receiver = accessor.LeftPart
                dotToken = accessor.DotToken
                fieldIdentifier = name.IdentifierToken
                return true
            }
            if accessor.RightPart is AccessorExpressionSyntax &&
                TryLiftTrailingMemberAccess(
                accessor.RightPart,
                out var innerReceiver,
                out var innerDotToken,
                out var innerFieldIdentifier
            ) {
                receiver = AccessorExpressionSyntax(
                    expression.SyntaxTree,
                    accessor.LeftPart,
                    accessor.DotToken,
                    innerReceiver!!
                )
                dotToken = innerDotToken
                fieldIdentifier = innerFieldIdentifier
                return true
            }
        }
        return false
    }
}
