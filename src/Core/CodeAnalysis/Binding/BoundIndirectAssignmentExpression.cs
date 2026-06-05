// <copyright file="BoundIndirectAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0060 §13: bound expression for an indirect assignment <c>*p = expr</c>. The
/// <see cref="Pointer"/> is a pointer expression of type <c>*T</c>
/// (<see cref="ByRefTypeSymbol"/>); the <see cref="Value"/> is of type <c>T</c>. The
/// emitter lowers to <c>&lt;load-address&gt; &lt;value&gt; stind.*</c> and the
/// expression has type <c>T</c> (the value that was stored).
/// </summary>
public sealed class BoundIndirectAssignmentExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundIndirectAssignmentExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax (may be null).</param>
    /// <param name="pointer">The pointer expression (type <c>*T</c>).</param>
    /// <param name="value">The value being stored through the pointer (type <c>T</c>).</param>
    public BoundIndirectAssignmentExpression(SyntaxNode syntax, BoundExpression pointer, BoundExpression value)
        : base(syntax)
    {
        Pointer = pointer;
        Value = value;
        Type = ((ByRefTypeSymbol)pointer.Type).PointeeType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IndirectAssignmentExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the pointer expression being assigned through.</summary>
    public BoundExpression Pointer { get; }

    /// <summary>Gets the value being stored through the pointer.</summary>
    public BoundExpression Value { get; }
}
