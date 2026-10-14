// <copyright file="BoundBinaryOperatorKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

/// Bound binary operator kind.
enum BoundBinaryOperatorKind {
    Product,
    Quotient,
    Remainder,
    ShiftLeft,
    ShiftRight,
    UnsignedShiftRight,
    BitwiseAnd,
    BitClear,
    Sum,
    Difference,
    BitwiseOr,
    BitwiseXor,
    Equals,
    NotEquals,
    Less,
    LessOrEquals,
    Greater,
    GreaterOrEquals,
    LogicalAnd,
    LogicalOr,
    NullCoalesce,
    Undefined
}
