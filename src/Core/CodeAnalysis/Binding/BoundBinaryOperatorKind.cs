// <copyright file="BoundBinaryOperatorKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound binary operator kind.
    /// </summary>
    internal enum BoundBinaryOperatorKind
    {
        /// <summary>
        /// Used when the StarToken is used as a binary operator.
        /// </summary>
        Product,

        /// <summary>
        /// Used when the SlashToken is used as a binary operator.
        /// </summary>
        Quotient,

        /// <summary>
        /// Used when the PercentToken is used as a binary operator.
        /// </summary>
        Remainder,

        /// <summary>
        /// Used when the ShiftLeftToken is used as a binary operator.
        /// </summary>
        ShiftLeft,

        /// <summary>
        /// Used when the ShiftRightToken is used as a binary operator.
        /// </summary>
        ShiftRight,

        /// <summary>
        /// Used when the AmpersandToken is used as a binary operator.
        /// </summary>
        BitwiseAnd,

        /// <summary>
        /// Used when the AmpersandHatToken is used as a binary operator.
        /// </summary>
        BitClear,

        /// <summary>
        /// Used when the PlusToken is used as a binary operator.
        /// </summary>
        Sum,

        /// <summary>
        /// Used when a MinusToken is used as a binary operator.
        /// </summary>
        Difference,

        /// <summary>
        /// Used when a PipeToken is used as a binary operator.
        /// </summary>
        BitwiseOr,

        /// <summary>
        /// Used when a HatToken is used as a binary operator.
        /// </summary>
        BitwiseXor,

        /// <summary>
        /// Used when an EqualsEqualsToken is used as a binary operator.
        /// </summary>
        Equals,

        /// <summary>
        /// Used when a BangEqualsToken is used as a binary operator.
        /// </summary>
        NotEquals,

        /// <summary>
        /// Used when a LessToken is used as a binary operator.
        /// </summary>
        Less,

        /// <summary>
        /// Used when a LessOrEqualsToken is used as a binary operator.
        /// </summary>
        LessOrEquals,

        /// <summary>
        /// Used when a GreaterToken is used as a binary operator.
        /// </summary>
        Greater,

        /// <summary>
        /// Used when a GreaterOrEqualsToken is used as a binary operator.
        /// </summary>
        GreaterOrEquals,

        /// <summary>
        /// Used when an AmpersandAmpersandToken is used as a binary operator.
        /// </summary>
        LogicalAnd,

        /// <summary>
        /// Used when a PipePipeToken is used as a binary operator.
        /// </summary>
        LogicalOr,
    }
}
