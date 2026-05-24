// <copyright file="BoundBinaryOperator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound binary operator.
/// </summary>
public sealed class BoundBinaryOperator
{
    private static BoundBinaryOperator[] supportedOperators =
    {
        // Supported operators for int operands:
        new BoundBinaryOperator(SyntaxKind.StarToken, BoundBinaryOperatorKind.Product, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.SlashToken, BoundBinaryOperatorKind.Quotient, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.PercentToken, BoundBinaryOperatorKind.Remainder, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.ShiftLeftToken, BoundBinaryOperatorKind.ShiftLeft, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.ShiftRightToken, BoundBinaryOperatorKind.ShiftRight, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.AmpersandHatToken, BoundBinaryOperatorKind.BitClear, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.PlusToken, BoundBinaryOperatorKind.Sum, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.MinusToken, BoundBinaryOperatorKind.Difference, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor, TypeSymbol.Int),
        new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.Int, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.Int, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.LessToken, BoundBinaryOperatorKind.Less, TypeSymbol.Int, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.LessOrEqualsToken, BoundBinaryOperatorKind.LessOrEquals, TypeSymbol.Int, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.GreaterToken, BoundBinaryOperatorKind.Greater, TypeSymbol.Int, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.GreaterOrEqualsToken, BoundBinaryOperatorKind.GreaterOrEquals, TypeSymbol.Int, TypeSymbol.Bool),

        // Supported operators for bool operands:
        new BoundBinaryOperator(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.AmpersandAmpersandToken, BoundBinaryOperatorKind.LogicalAnd, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.PipePipeToken, BoundBinaryOperatorKind.LogicalOr, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.Bool),

        // Supported operators for string operands:
        new BoundBinaryOperator(SyntaxKind.PlusToken, BoundBinaryOperatorKind.Sum, TypeSymbol.String),
        new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.String, TypeSymbol.Bool),
        new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.String, TypeSymbol.Bool),
    };

    private BoundBinaryOperator(SyntaxKind syntaxKind, BoundBinaryOperatorKind kind, TypeSymbol type)
        : this(syntaxKind, kind, type, type, type)
    {
    }

    private BoundBinaryOperator(SyntaxKind syntaxKind, BoundBinaryOperatorKind kind, TypeSymbol operandType, TypeSymbol resultType)
        : this(syntaxKind, kind, operandType, operandType, resultType)
    {
    }

    private BoundBinaryOperator(SyntaxKind syntaxKind, BoundBinaryOperatorKind kind, TypeSymbol leftType, TypeSymbol rightType, TypeSymbol resultType)
    {
        SyntaxKind = syntaxKind;
        Kind = kind;
        LeftType = leftType;
        RightType = rightType;
        Type = resultType;
    }

    /// <summary>
    /// Gets the syntax kind.
    /// </summary>
    public SyntaxKind SyntaxKind { get; }

    /// <summary>
    /// Gets the bound binary operator kind.
    /// </summary>
    public BoundBinaryOperatorKind Kind { get; }

    /// <summary>
    /// Gets the left type symbol.
    /// </summary>
    public TypeSymbol LeftType { get; }

    /// <summary>
    /// Gets the right type symbol.
    /// </summary>
    public TypeSymbol RightType { get; }

    /// <summary>
    /// Gets the bound binary operator type symbol.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Binds a syntax kind and a type symbol to the corresponding bound binary operator, or
    /// null if the syntax kind isn't a binary operator, or is not a supported binary operator.
    /// </summary>
    /// <param name="syntaxKind">The syntax kind.</param>
    /// <param name="leftType">The left type symbol.</param>
    /// <param name="rightType">The right type symbol.</param>
    /// <returns>A bound unary operator.</returns>
    public static BoundBinaryOperator Bind(SyntaxKind syntaxKind, TypeSymbol leftType, TypeSymbol rightType)
    {
        foreach (var op in supportedOperators)
        {
            if (op.SyntaxKind == syntaxKind && op.LeftType == leftType && op.RightType == rightType)
            {
                return op;
            }
        }

        // Phase 4.2 / ADR-0020: `==` / `!=` on a `comparable`-constrained type parameter.
        // Allowed only when both operands are the SAME type-parameter symbol whose
        // constraint is `Comparable`. (`any` falls through to "operator undefined".)
        if ((syntaxKind == SyntaxKind.EqualsEqualsToken || syntaxKind == SyntaxKind.BangEqualsToken)
            && leftType is TypeParameterSymbol ltp && ltp == rightType
            && ltp.Constraint == TypeParameterConstraint.Comparable)
        {
            var cmpKind = syntaxKind == SyntaxKind.EqualsEqualsToken
                ? BoundBinaryOperatorKind.Equals
                : BoundBinaryOperatorKind.NotEquals;
            return new BoundBinaryOperator(syntaxKind, cmpKind, ltp, ltp, TypeSymbol.Bool);
        }

        // Phase 6.8: enum equality compares the underlying int values.
        if ((syntaxKind == SyntaxKind.EqualsEqualsToken || syntaxKind == SyntaxKind.BangEqualsToken)
            && leftType is EnumSymbol le && rightType is EnumSymbol re && le == re)
        {
            var enumKind = syntaxKind == SyntaxKind.EqualsEqualsToken
                ? BoundBinaryOperatorKind.Equals
                : BoundBinaryOperatorKind.NotEquals;
            return new BoundBinaryOperator(syntaxKind, enumKind, leftType, rightType, TypeSymbol.Bool);
        }

        // Phase 3.B.2 / ADR-0029: structural == / != on data struct values.
        if (leftType is StructSymbol ls && rightType is StructSymbol rs && ls == rs && ls.IsData)
        {
            if (syntaxKind == SyntaxKind.EqualsEqualsToken)
            {
                return new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, ls, ls, TypeSymbol.Bool);
            }

            if (syntaxKind == SyntaxKind.BangEqualsToken)
            {
                return new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, ls, ls, TypeSymbol.Bool);
            }
        }

        // Phase 3.C.2 / ADR-0001: == and != against nil for any nullable type.
        if ((syntaxKind == SyntaxKind.EqualsEqualsToken || syntaxKind == SyntaxKind.BangEqualsToken) &&
            (IsNullCompare(leftType, rightType) || IsNullCompare(rightType, leftType)))
        {
            var kind = syntaxKind == SyntaxKind.EqualsEqualsToken ? BoundBinaryOperatorKind.Equals : BoundBinaryOperatorKind.NotEquals;
            return new BoundBinaryOperator(syntaxKind, kind, leftType, rightType, TypeSymbol.Bool);
        }

        // Phase 3.C.3 / ADR-0001: null-coalescing `?:` returns the left if
        // non-nil, otherwise the right. Type is the underlying of the left
        // side (when the right is the same underlying or is itself nullable
        // with that underlying).
        if (syntaxKind == SyntaxKind.QuestionColonToken)
        {
            TypeSymbol leftUnderlying = leftType is NullableTypeSymbol leftNullable ? leftNullable.UnderlyingType : leftType;
            TypeSymbol rightUnderlying = rightType is NullableTypeSymbol rightNullable ? rightNullable.UnderlyingType : rightType;
            if (leftType == TypeSymbol.Null)
            {
                return new BoundBinaryOperator(syntaxKind, BoundBinaryOperatorKind.NullCoalesce, leftType, rightType, rightType);
            }

            if (leftUnderlying == rightUnderlying)
            {
                var result = rightType is NullableTypeSymbol ? (TypeSymbol)NullableTypeSymbol.Get(leftUnderlying) : leftUnderlying;
                return new BoundBinaryOperator(syntaxKind, BoundBinaryOperatorKind.NullCoalesce, leftType, rightType, result);
            }
        }

        return null;
    }

    private static bool IsNullCompare(TypeSymbol nullableOrUnderlying, TypeSymbol nullCandidate)
    {
        return nullCandidate == TypeSymbol.Null && (nullableOrUnderlying is NullableTypeSymbol || nullableOrUnderlying == TypeSymbol.Null);
    }
}
