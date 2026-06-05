// <copyright file="BoundConditionalAddressExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0061: bound representation of a call-site-only conditional lvalue
/// address-of expression of the form <c>&lt;cond&gt; ? &lt;lvalue&gt; : &lt;lvalue&gt;</c>.
/// Produced by the binder from a <see cref="ConditionalRefArgumentExpressionSyntax"/>
/// at the payload of a ref-kind modifier (<c>ref</c>/<c>out</c>/<c>in</c>) or as
/// the operand of <c>&amp;</c>. The result type is <c>T&amp;</c> (a
/// <see cref="ByRefTypeSymbol"/>) where T is the common pointee type of the two
/// branches. Lowered to a CIL branch around two address-of forms feeding a
/// single managed pointer onto the evaluation stack.
/// </summary>
public sealed class BoundConditionalAddressExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundConditionalAddressExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="condition">The condition expression (bound to type <c>bool</c>).</param>
    /// <param name="whenTrueOperand">The lvalue operand for the true branch (its address is taken at emit).</param>
    /// <param name="whenFalseOperand">The lvalue operand for the false branch (its address is taken at emit).</param>
    /// <param name="pointeeType">The common pointee type of the two branches.</param>
    public BoundConditionalAddressExpression(
        SyntaxNode syntax,
        BoundExpression condition,
        BoundExpression whenTrueOperand,
        BoundExpression whenFalseOperand,
        TypeSymbol pointeeType)
        : base(syntax)
    {
        Condition = condition;
        WhenTrueOperand = whenTrueOperand;
        WhenFalseOperand = whenFalseOperand;
        PointeeType = pointeeType;
        Type = ByRefTypeSymbol.Get(pointeeType);
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConditionalAddressExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the bound condition expression (typed <c>bool</c>).</summary>
    public BoundExpression Condition { get; }

    /// <summary>Gets the lvalue operand for the true branch.</summary>
    public BoundExpression WhenTrueOperand { get; }

    /// <summary>Gets the lvalue operand for the false branch.</summary>
    public BoundExpression WhenFalseOperand { get; }

    /// <summary>Gets the common pointee type of the two branches.</summary>
    public TypeSymbol PointeeType { get; }
}
