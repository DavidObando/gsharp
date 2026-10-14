// <copyright file="BoundUnaryOperatorKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

/// Bound unary operator kind.
enum BoundUnaryOperatorKind {
    Identity,
    Negation,
    LogicalNegation,
    OnesComplement,
    DereferenceOf,
    ReferenceOf,
    NullAssertion
}
