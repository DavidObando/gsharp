// <copyright file="SyntaxOperatorFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Provides stable CLR entry points for operator precedence.
shared class SyntaxOperatorFacts {
    /// Gets binary-operator precedence.
    /// @param kind The operator token kind.
    /// @returns The operator precedence, or zero for a non-operator.
    func GetBinaryOperatorPrecedence(kind SyntaxKind) int32 {
        return kind.GetBinaryOperatorPrecedence()
    }

    /// Gets unary-operator precedence.
    /// @param kind The operator token kind.
    /// @returns The operator precedence, or zero for a non-operator.
    func GetUnaryOperatorPrecedence(kind SyntaxKind) int32 {
        return kind.GetUnaryOperatorPrecedence()
    }
}
