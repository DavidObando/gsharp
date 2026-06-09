// <copyright file="BoundClrIndexAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Assigns through a CLR indexer (Phase 4 exit). Example:
/// <c>d["key"] = 42</c> where <c>d</c> is a <c>Dictionary[string, int]</c>.
/// Interpreter-only — the evaluator calls
/// <c>Indexer.SetValue(target, value, args)</c>.
/// The target is either a simple variable reference or, after closure-boxing
/// lowering, an arbitrary expression (issue #618).
/// </summary>
public sealed class BoundClrIndexAssignmentExpression : BoundExpression
{
    public BoundClrIndexAssignmentExpression(SyntaxNode syntax, VariableSymbol target, PropertyInfo indexer, ImmutableArray<BoundExpression> arguments, BoundExpression value, TypeSymbol resultType)
        : base(syntax)
    {
        Target = target;
        Indexer = indexer;
        Arguments = arguments;
        Value = value;
        Type = resultType;
    }

    private BoundClrIndexAssignmentExpression(SyntaxNode syntax, BoundExpression targetExpression, PropertyInfo indexer, ImmutableArray<BoundExpression> arguments, BoundExpression value, TypeSymbol resultType)
        : base(syntax)
    {
        TargetExpression = targetExpression;
        Indexer = indexer;
        Arguments = arguments;
        Value = value;
        Type = resultType;
    }

    public VariableSymbol Target { get; }

    /// <summary>
    /// Gets the expression-based target, or <c>null</c> when the simple
    /// <see cref="Target"/> variable form is used. When non-null, the emitter
    /// evaluates this expression to produce the instance reference instead of
    /// loading <see cref="Target"/>.
    /// </summary>
    public BoundExpression TargetExpression { get; }

    public PropertyInfo Indexer { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public BoundExpression Value { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrIndexAssignmentExpression;

    /// <summary>
    /// Creates a CLR index assignment with an expression-based target. Used
    /// after closure-boxing lowering when the original target local has been
    /// replaced by a field access through a box (issue #618).
    /// </summary>
    /// <param name="syntax">The originating syntax, or <c>null</c> for synthesized nodes.</param>
    /// <param name="targetExpression">The expression that produces the instance reference.</param>
    /// <param name="indexer">The CLR indexer property.</param>
    /// <param name="arguments">The indexer argument expressions.</param>
    /// <param name="value">The value to assign.</param>
    /// <param name="resultType">The result type of the assignment expression.</param>
    /// <returns>A new <see cref="BoundClrIndexAssignmentExpression"/> with an expression target.</returns>
    public static BoundClrIndexAssignmentExpression WithExpressionTarget(
        SyntaxNode syntax,
        BoundExpression targetExpression,
        PropertyInfo indexer,
        ImmutableArray<BoundExpression> arguments,
        BoundExpression value,
        TypeSymbol resultType)
    {
        return new BoundClrIndexAssignmentExpression(syntax, targetExpression, indexer, arguments, value, resultType);
    }
}
