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
    public BoundPatternSwitchStatement(SyntaxNode syntax, BoundExpression discriminant, ImmutableArray<BoundPatternSwitchArm> arms)
        : base(syntax)
    {
        Discriminant = discriminant;
        Arms = arms;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PatternSwitchStatement;

    /// <summary>Gets the discriminant expression.</summary>
    public BoundExpression Discriminant { get; }

    /// <summary>Gets the switch arms.</summary>
    public ImmutableArray<BoundPatternSwitchArm> Arms { get; }
}
