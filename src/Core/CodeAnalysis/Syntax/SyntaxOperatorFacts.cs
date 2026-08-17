// <copyright file="SyntaxOperatorFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Provides stable CLR entry points for operator precedence.
/// </summary>
public static class SyntaxOperatorFacts
{
    /// <summary>Gets binary-operator precedence.</summary>
    /// <param name="kind">The operator token kind.</param>
    /// <returns>The operator precedence, or zero for a non-operator.</returns>
    public static int GetBinaryOperatorPrecedence(SyntaxKind kind)
    {
        return kind.GetBinaryOperatorPrecedence();
    }

    /// <summary>Gets unary-operator precedence.</summary>
    /// <param name="kind">The operator token kind.</param>
    /// <returns>The operator precedence, or zero for a non-operator.</returns>
    public static int GetUnaryOperatorPrecedence(SyntaxKind kind)
    {
        return kind.GetUnaryOperatorPrecedence();
    }
}
