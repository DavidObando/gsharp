// <copyright file="BoundPatternSwitchStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound pattern switch statement evaluated by the interpreter.</summary>
public sealed class BoundPatternSwitchStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundPatternSwitchStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="discriminant">The discriminant expression.</param>
    /// <param name="arms">The switch arms.</param>
    /// <param name="isExhaustive">Whether closed-type analysis proved that the arms cover every value.</param>
    public BoundPatternSwitchStatement(
        SyntaxNode syntax,
        BoundExpression discriminant,
        ImmutableArray<BoundPatternSwitchArm> arms,
        bool isExhaustive)
        : base(syntax)
    {
        Discriminant = discriminant;
        Arms = arms;
        IsExhaustive = isExhaustive;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PatternSwitchStatement;

    /// <summary>Gets the discriminant expression.</summary>
    public BoundExpression Discriminant { get; }

    /// <summary>Gets the switch arms.</summary>
    public ImmutableArray<BoundPatternSwitchArm> Arms { get; }

    /// <summary>Gets a value indicating whether closed-type analysis proved that the switch is exhaustive.</summary>
    public bool IsExhaustive { get; }
}
