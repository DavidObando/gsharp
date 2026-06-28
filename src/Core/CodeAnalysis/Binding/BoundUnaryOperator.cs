// <copyright file="BoundUnaryOperator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound unary operator.
/// </summary>
public sealed record BoundUnaryOperator
{
    private static BoundUnaryOperator[] supportedOperators = BuildSupportedOperators();

    private BoundUnaryOperator(SyntaxKind syntaxKind, BoundUnaryOperatorKind kind, TypeSymbol operandType)
        : this(syntaxKind, kind, operandType, operandType)
    {
    }

    private BoundUnaryOperator(SyntaxKind syntaxKind, BoundUnaryOperatorKind kind, TypeSymbol operandType, TypeSymbol resultType)
    {
        SyntaxKind = syntaxKind;
        Kind = kind;
        OperandType = operandType;
        Type = resultType;
    }

    /// <summary>
    /// Gets the syntax kind.
    /// </summary>
    public SyntaxKind SyntaxKind { get; }

    /// <summary>
    /// Gets the operator kind.
    /// </summary>
    public BoundUnaryOperatorKind Kind { get; }

    /// <summary>
    /// Gets the operand type.
    /// </summary>
    public TypeSymbol OperandType { get; }

    /// <summary>
    /// Gets the type symbol type.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Binds a syntax kind and a type symbol to the corresponding bound unary operator, or
    /// null if the syntax kind isn't a unary operator, or is not a supported unary operator.
    /// </summary>
    /// <param name="syntaxKind">The syntax kind.</param>
    /// <param name="operandType">The type symbol.</param>
    /// <returns>A bound unary operator.</returns>
    public static BoundUnaryOperator Bind(SyntaxKind syntaxKind, TypeSymbol operandType)
    {
        // Phase 3.C.3 / ADR-0001: postfix `!!` is dynamically typed by the
        // operand: it returns the underlying type when applied to T?, and is
        // a no-op on already-non-nullable values (binder will diagnose).
        //
        // Issue #614 audit: intentionally a single arm — there is only ONE
        // null-assertion operator token, and the result type is computed from
        // the operand type at runtime. No combinatorial dimension to tabulate.
        if (syntaxKind == SyntaxKind.BangBangToken)
        {
            var underlying = operandType is NullableTypeSymbol n ? n.UnderlyingType : operandType;
            return new BoundUnaryOperator(syntaxKind, BoundUnaryOperatorKind.NullAssertion, operandType, underlying);
        }

        foreach (var op in supportedOperators)
        {
            if (op.SyntaxKind == syntaxKind && op.OperandType == operandType)
            {
                return op;
            }
        }

        // Issues #534 and 6.6 unification: ^ (ones complement) on enum
        // values drives through the EnumOperatorTable.
        if (EnumOperatorTable.TryBindUnary(syntaxKind, operandType, out var enumKind, out var enumResultType))
        {
            return new BoundUnaryOperator(syntaxKind, enumKind, operandType, enumResultType);
        }

        return null;
    }

    private static BoundUnaryOperator[] BuildSupportedOperators()
    {
        var list = new System.Collections.Generic.List<BoundUnaryOperator>
        {
            new BoundUnaryOperator(SyntaxKind.BangToken, BoundUnaryOperatorKind.LogicalNegation, TypeSymbol.Bool),
        };

        // ADR-0044: unary +, -, ~ on every signed integral primitive.
        TypeSymbol[] signed = { TypeSymbol.Int8, TypeSymbol.Int16, TypeSymbol.Int32, TypeSymbol.Int64, TypeSymbol.NInt };
        foreach (var t in signed)
        {
            list.Add(new BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, t));
            list.Add(new BoundUnaryOperator(SyntaxKind.MinusToken, BoundUnaryOperatorKind.Negation, t));
            list.Add(new BoundUnaryOperator(SyntaxKind.HatToken, BoundUnaryOperatorKind.OnesComplement, t));
        }

        // Unsigned integrals: unary + and ~ only (C# does not define unary
        // minus on unsigned types directly; users can cast first).
        TypeSymbol[] unsigned = { TypeSymbol.UInt8, TypeSymbol.UInt16, TypeSymbol.UInt32, TypeSymbol.UInt64, TypeSymbol.NUInt };
        foreach (var t in unsigned)
        {
            list.Add(new BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, t));
            list.Add(new BoundUnaryOperator(SyntaxKind.HatToken, BoundUnaryOperatorKind.OnesComplement, t));
        }

        // char: unary + only (treat as identity); ~ and - require explicit promotion.
        list.Add(new BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, TypeSymbol.Char));

        // Floating-point + decimal: unary + and -.
        TypeSymbol[] floats = { TypeSymbol.Float32, TypeSymbol.Float64, TypeSymbol.Decimal };
        foreach (var t in floats)
        {
            list.Add(new BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, t));
            list.Add(new BoundUnaryOperator(SyntaxKind.MinusToken, BoundUnaryOperatorKind.Negation, t));
        }

        return list.ToArray();
    }
}
