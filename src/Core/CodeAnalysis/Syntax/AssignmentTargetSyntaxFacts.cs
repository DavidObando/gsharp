// <copyright file="AssignmentTargetSyntaxFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented

using System.Diagnostics.CodeAnalysis;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Shared syntax shaping for assignment targets.
/// </summary>
internal static class AssignmentTargetSyntaxFacts
{
    /// <summary>
    /// Builds the existing single-assignment syntax node for a parsed target.
    /// </summary>
    public static bool TryCreateAssignment(
        ExpressionSyntax target,
        SyntaxToken equalsToken,
        ExpressionSyntax value,
        [NotNullWhen(true)] out ExpressionSyntax? assignment)
    {
        if (target is NameExpressionSyntax name)
        {
            assignment = new AssignmentExpressionSyntax(
                target.SyntaxTree,
                name.IdentifierToken,
                equalsToken,
                value);
            return true;
        }

        if (TryLiftTrailingIndexer(target, out var indexed))
        {
            if (!indexed.IsNullConditional && indexed.Target is NameExpressionSyntax indexedName)
            {
                assignment = new IndexAssignmentExpressionSyntax(
                    target.SyntaxTree,
                    indexedName.IdentifierToken,
                    indexed.OpenBracketToken,
                    indexed.Indices,
                    indexed.CloseBracketToken,
                    equalsToken,
                    value);
            }
            else
            {
                assignment = new MemberIndexAssignmentExpressionSyntax(
                    target.SyntaxTree,
                    indexed,
                    equalsToken,
                    value);
            }

            return true;
        }

        if (TryLiftTrailingMemberAccess(
            target,
            out var receiver,
            out var dotToken,
            out var fieldIdentifier))
        {
            assignment = receiver is NameExpressionSyntax receiverName
                && dotToken.Kind == SyntaxKind.DotToken
                ? new FieldAssignmentExpressionSyntax(
                    target.SyntaxTree,
                    receiverName.IdentifierToken,
                    dotToken,
                    fieldIdentifier,
                    equalsToken,
                    value)
                : new MemberFieldAssignmentExpressionSyntax(
                    target.SyntaxTree,
                    receiver,
                    dotToken,
                    fieldIdentifier,
                    equalsToken,
                    value);
            return true;
        }

        if (target is UnaryExpressionSyntax dereference
            && dereference.OperatorToken.Kind == SyntaxKind.StarToken)
        {
            assignment = new IndirectAssignmentExpressionSyntax(
                target.SyntaxTree,
                dereference,
                equalsToken,
                value);
            return true;
        }

        if (target is BaseInterfaceCallExpressionSyntax baseProperty
            && baseProperty.IsPropertyAccess
            && !baseProperty.IsPropertyWrite)
        {
            assignment = new BaseInterfaceCallExpressionSyntax(
                target.SyntaxTree,
                baseProperty.BaseKeyword,
                baseProperty.OpenBracketToken,
                baseProperty.InterfaceTypeClause,
                baseProperty.CloseBracketToken,
                baseProperty.DotToken,
                baseProperty.MethodIdentifier,
                equalsToken,
                value);
            return true;
        }

        assignment = null;
        return false;
    }

    /// <summary>
    /// Canonicalizes an expression whose rightmost primary is an index access.
    /// </summary>
    public static bool TryLiftTrailingIndexer(
        ExpressionSyntax expression,
        [NotNullWhen(true)] out IndexExpressionSyntax? canonical)
    {
        if (expression is IndexExpressionSyntax direct)
        {
            canonical = direct;
            return true;
        }

        if (expression is AccessorExpressionSyntax accessor
            && TryLiftTrailingIndexer(accessor.RightPart, out var inner))
        {
            var rebuiltReceiver = new AccessorExpressionSyntax(
                expression.SyntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                inner.Target);
            canonical = new IndexExpressionSyntax(
                expression.SyntaxTree,
                rebuiltReceiver,
                inner.OpenBracketToken,
                inner.Indices,
                inner.CloseBracketToken);
            return true;
        }

        canonical = null;
        return false;
    }

    /// <summary>
    /// Splits an accessor expression at its terminal member name.
    /// </summary>
    public static bool TryLiftTrailingMemberAccess(
        ExpressionSyntax expression,
        [MaybeNullWhen(false)] out ExpressionSyntax receiver,
        [MaybeNullWhen(false)] out SyntaxToken dotToken,
        [MaybeNullWhen(false)] out SyntaxToken fieldIdentifier)
    {
        receiver = null;
        dotToken = default;
        fieldIdentifier = default;
        if (expression is AccessorExpressionSyntax accessor)
        {
            if (accessor.RightPart is NameExpressionSyntax name)
            {
                receiver = accessor.LeftPart;
                dotToken = accessor.DotToken;
                fieldIdentifier = name.IdentifierToken;
                return true;
            }

            if (accessor.RightPart is AccessorExpressionSyntax
                && TryLiftTrailingMemberAccess(
                    accessor.RightPart,
                    out var innerReceiver,
                    out var innerDotToken,
                    out var innerFieldIdentifier))
            {
                receiver = new AccessorExpressionSyntax(
                    expression.SyntaxTree,
                    accessor.LeftPart,
                    accessor.DotToken,
                    innerReceiver);
                dotToken = innerDotToken;
                fieldIdentifier = innerFieldIdentifier;
                return true;
            }
        }

        return false;
    }
}
