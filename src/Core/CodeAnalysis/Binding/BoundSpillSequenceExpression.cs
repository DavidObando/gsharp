// <copyright file="BoundSpillSequenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// An intermediate expression node produced by the <c>SpillSequenceSpiller</c>
/// (spec §7). It carries a list of spill-temp locals, a sequence of
/// statements that must execute before the value is observed, and a
/// final value expression. After the spiller pass completes, no
/// <c>BoundSpillSequenceExpression</c> nodes should survive at statement
/// top-level — they are flattened into the enclosing statement list.
/// </summary>
public sealed class BoundSpillSequenceExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundSpillSequenceExpression"/> class.</summary>
    /// <param name="locals">Spill-temp locals owned by this sequence.</param>
    /// <param name="sideEffects">Statements that must run before the value is observed.</param>
    /// <param name="value">The final value expression.</param>
    public BoundSpillSequenceExpression(
        ImmutableArray<LocalVariableSymbol> locals,
        ImmutableArray<BoundStatement> sideEffects,
        BoundExpression value)
    {
        Locals = locals;
        SideEffects = sideEffects;
        Value = value;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SpillSequenceExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Value.Type;

    /// <summary>Gets the spill-temp locals owned by this sequence.</summary>
    public ImmutableArray<LocalVariableSymbol> Locals { get; }

    /// <summary>Gets the statements that must run before the value is observed.</summary>
    public ImmutableArray<BoundStatement> SideEffects { get; }

    /// <summary>Gets the final value expression.</summary>
    public BoundExpression Value { get; }
}
