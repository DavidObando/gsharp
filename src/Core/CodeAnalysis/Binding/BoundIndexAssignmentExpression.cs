// <copyright file="BoundIndexAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound indexed assignment <c>target[index] = value</c>. The target is either
/// a simple variable reference or, after closure-boxing lowering, an arbitrary
/// expression (e.g. <c>boxLocal.Value</c> for a boxed captured variable —
/// issue #618).
/// </summary>
public sealed class BoundIndexAssignmentExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundIndexAssignmentExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="target">The target variable holding the array.</param>
    /// <param name="index">The index expression.</param>
    /// <param name="value">The value expression.</param>
    /// <param name="elementType">The element type of the array.</param>
    public BoundIndexAssignmentExpression(
        SyntaxNode syntax,
        VariableSymbol target,
        BoundExpression index,
        BoundExpression value,
        TypeSymbol elementType)
        : base(syntax)
    {
        Target = target;
        Index = index;
        Value = value;
        Type = elementType;
    }

    private BoundIndexAssignmentExpression(
        SyntaxNode syntax,
        BoundExpression targetExpression,
        BoundExpression index,
        BoundExpression value,
        TypeSymbol elementType)
        : base(syntax)
    {
        TargetExpression = targetExpression;
        Index = index;
        Value = value;
        Type = elementType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IndexAssignmentExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the target variable holding the array.</summary>
    public VariableSymbol Target { get; }

    /// <summary>
    /// Gets the expression-based target, or <c>null</c> when the simple
    /// <see cref="Target"/> variable form is used. When non-null, the emitter
    /// evaluates this expression to produce the array/map/slice reference
    /// instead of loading <see cref="Target"/>.
    /// </summary>
    public BoundExpression TargetExpression { get; }

    /// <summary>Gets the index expression.</summary>
    public BoundExpression Index { get; }

    /// <summary>Gets the value expression.</summary>
    public BoundExpression Value { get; }

    /// <summary>
    /// Creates an index assignment with an expression-based target. Used after
    /// closure-boxing lowering when the original target local has been replaced
    /// by a field access through a box (issue #618).
    /// </summary>
    /// <param name="syntax">The originating syntax, or <c>null</c> for synthesized nodes.</param>
    /// <param name="targetExpression">The expression that produces the array/map/slice reference.</param>
    /// <param name="index">The index expression.</param>
    /// <param name="value">The value to assign.</param>
    /// <param name="elementType">The element type of the array.</param>
    /// <returns>A new <see cref="BoundIndexAssignmentExpression"/> with an expression target.</returns>
    public static BoundIndexAssignmentExpression WithExpressionTarget(
        SyntaxNode syntax,
        BoundExpression targetExpression,
        BoundExpression index,
        BoundExpression value,
        TypeSymbol elementType)
    {
        return new BoundIndexAssignmentExpression(syntax, targetExpression, index, value, elementType);
    }
}
