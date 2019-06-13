// <copyright file="BoundUnaryOperatorKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    /// <summary>
    /// Bound unary operator kind.
    /// </summary>
    internal enum BoundUnaryOperatorKind
    {
        /// <summary>
        /// Used when the PlusToken is used as a unary operator.
        /// </summary>
        Identity,

        /// <summary>
        /// Used when the MinusToken is used as a unary operator.
        /// </summary>
        Negation,

        /// <summary>
        /// Used when the BangToken is used as a unary operator.
        /// </summary>
        LogicalNegation,

        /// <summary>
        /// Used when the HatToken is used as a unary operator.
        /// </summary>
        OnesComplement,

        /// <summary>
        /// Used when the StarToken is used as a unary operator.
        /// </summary>
        DereferenceOf,

        /// <summary>
        /// Used when the AmpersandToken is used as a unary operator.
        /// </summary>
        ReferenceOf,
    }
}