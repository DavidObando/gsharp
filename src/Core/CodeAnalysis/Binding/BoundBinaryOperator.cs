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
    private static readonly TypeSymbol[] SignedIntegralTypes =
    {
        TypeSymbol.SByte, TypeSymbol.Short, TypeSymbol.Int, TypeSymbol.Long, TypeSymbol.NInt,
    };

    private static readonly TypeSymbol[] UnsignedIntegralTypes =
    {
        TypeSymbol.Byte, TypeSymbol.UShort, TypeSymbol.UInt, TypeSymbol.ULong, TypeSymbol.NUInt,
    };

    private static readonly TypeSymbol[] FloatingPointTypes =
    {
        TypeSymbol.Float32, TypeSymbol.Float64,
    };

    private static BoundBinaryOperator[] supportedOperators = BuildSupportedOperators();

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

        // Phase 3.B.2 / ADR-0029 + ADR-0033: structural == / != on data and inline struct values.
        if (leftType is StructSymbol ls && rightType is StructSymbol rs && ls == rs && (ls.IsData || ls.IsInline))
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

    private static BoundBinaryOperator[] BuildSupportedOperators()
    {
        var list = new System.Collections.Generic.List<BoundBinaryOperator>();

        // ADR-0044: every integral primitive supports the full arithmetic,
        // comparison, bitwise, and shift operator set, closed under its own
        // type (sbyte + sbyte → sbyte, long + long → long, …). Cross-type
        // promotion happens through explicit casts.
        foreach (var t in SignedIntegralTypes)
        {
            AddIntegralOperators(list, t);
        }

        foreach (var t in UnsignedIntegralTypes)
        {
            AddIntegralOperators(list, t);
        }

        // Floating-point primitives support arithmetic + comparison, but
        // not bitwise or shifts.
        foreach (var t in FloatingPointTypes)
        {
            AddArithmeticAndComparisonOperators(list, t);
        }

        // Decimal mirrors the floating-point shape but is emitted through
        // System.Decimal's operator methods (handled by the emitter).
        AddArithmeticAndComparisonOperators(list, TypeSymbol.Decimal);

        // char is comparison-only at its own type: char + char would have to
        // widen to int in C#'s rules, and the binder does not yet promote
        // across types here. Users can write `int(c1) + int(c2)` explicitly.
        AddComparisonOperators(list, TypeSymbol.Char);

        // Bool operators (unchanged behaviour, kept here for one source of truth).
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandAmpersandToken, BoundBinaryOperatorKind.LogicalAnd, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.PipePipeToken, BoundBinaryOperatorKind.LogicalOr, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.Bool));

        // String operators (concatenation + equality through BCL helpers).
        list.Add(new BoundBinaryOperator(SyntaxKind.PlusToken, BoundBinaryOperatorKind.Sum, TypeSymbol.String));
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.String, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.String, TypeSymbol.Bool));

        // ADR-0045: `object` reference equality.
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, TypeSymbol.Object, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, TypeSymbol.Object, TypeSymbol.Bool));

        return list.ToArray();
    }

    private static void AddArithmeticAndComparisonOperators(System.Collections.Generic.List<BoundBinaryOperator> list, TypeSymbol t)
    {
        list.Add(new BoundBinaryOperator(SyntaxKind.PlusToken, BoundBinaryOperatorKind.Sum, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.MinusToken, BoundBinaryOperatorKind.Difference, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.StarToken, BoundBinaryOperatorKind.Product, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.SlashToken, BoundBinaryOperatorKind.Quotient, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.PercentToken, BoundBinaryOperatorKind.Remainder, t));
        AddComparisonOperators(list, t);
    }

    private static void AddIntegralOperators(System.Collections.Generic.List<BoundBinaryOperator> list, TypeSymbol t)
    {
        AddArithmeticAndComparisonOperators(list, t);
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandToken, BoundBinaryOperatorKind.BitwiseAnd, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.PipeToken, BoundBinaryOperatorKind.BitwiseOr, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.HatToken, BoundBinaryOperatorKind.BitwiseXor, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.AmpersandHatToken, BoundBinaryOperatorKind.BitClear, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.ShiftLeftToken, BoundBinaryOperatorKind.ShiftLeft, t, TypeSymbol.Int, t));
        list.Add(new BoundBinaryOperator(SyntaxKind.ShiftRightToken, BoundBinaryOperatorKind.ShiftRight, t, TypeSymbol.Int, t));
    }

    private static void AddComparisonOperators(System.Collections.Generic.List<BoundBinaryOperator> list, TypeSymbol t)
    {
        list.Add(new BoundBinaryOperator(SyntaxKind.EqualsEqualsToken, BoundBinaryOperatorKind.Equals, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.BangEqualsToken, BoundBinaryOperatorKind.NotEquals, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.LessToken, BoundBinaryOperatorKind.Less, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.LessOrEqualsToken, BoundBinaryOperatorKind.LessOrEquals, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.GreaterToken, BoundBinaryOperatorKind.Greater, t, t, TypeSymbol.Bool));
        list.Add(new BoundBinaryOperator(SyntaxKind.GreaterOrEqualsToken, BoundBinaryOperatorKind.GreaterOrEquals, t, t, TypeSymbol.Bool));
    }
}
