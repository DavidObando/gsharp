#nullable disable

// <copyright file="BoundSwitchExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound switch expression.
/// </summary>
public sealed class BoundSwitchExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundSwitchExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="discriminant">The bound discriminant expression.</param>
    /// <param name="arms">The bound switch-expression arms.</param>
    /// <param name="type">The unified result type.</param>
    public BoundSwitchExpression(SyntaxNode syntax, BoundExpression discriminant, ImmutableArray<BoundSwitchExpressionArm> arms, TypeSymbol type)
        : base(syntax)
    {
        Discriminant = discriminant;
        Arms = arms;
        Type = type;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SwitchExpression;

    /// <summary>Gets the bound discriminant expression.</summary>
    public BoundExpression Discriminant { get; }

    /// <summary>Gets the bound switch-expression arms.</summary>
    public ImmutableArray<BoundSwitchExpressionArm> Arms { get; }

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }
}
