// <copyright file="BoundUnaryOperator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Bound unary operator.
    /// </summary>
    public sealed class BoundUnaryOperator
    {
        private static BoundUnaryOperator[] supportedOperators =
        {
            new BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, TypeSymbol.Int),
            new BoundUnaryOperator(SyntaxKind.MinusToken, BoundUnaryOperatorKind.Negation, TypeSymbol.Int),
            new BoundUnaryOperator(SyntaxKind.BangToken, BoundUnaryOperatorKind.LogicalNegation, TypeSymbol.Bool),
            new BoundUnaryOperator(SyntaxKind.HatToken, BoundUnaryOperatorKind.OnesComplement, TypeSymbol.Int),

            // Unsupported as of this point:
            //   - SyntaxKind.StarToken
            //   - SyntaxKind.AmpersandToken
            //   - SyntaxKind.LeftArrowToken
        };

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
            foreach (var op in supportedOperators)
            {
                if (op.SyntaxKind == syntaxKind && op.OperandType == operandType)
                {
                    return op;
                }
            }

            return null;
        }
    }
}
