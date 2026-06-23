// <copyright file="BoundPatternSwitchArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound arm for a pattern switch statement.</summary>
public sealed class BoundPatternSwitchArm : BoundNode
{
    /// <summary>Initializes a new instance of the <see cref="BoundPatternSwitchArm"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="pattern">The arm pattern, or null for default.</param>
    /// <param name="guard">The optional boolean guard expression (<c>when</c> clause), or null.</param>
    /// <param name="body">The arm body.</param>
    public BoundPatternSwitchArm(SyntaxNode syntax, BoundPattern pattern, BoundExpression guard, BoundStatement body)
        : base(syntax)
    {
        Pattern = pattern;
        Guard = guard;
        Body = body;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PatternSwitchArm;

    /// <summary>Gets the pattern, or null for default.</summary>
    public BoundPattern Pattern { get; }

    /// <summary>Gets the optional boolean guard expression (<c>when</c> clause), or null when the arm has no guard.</summary>
    public BoundExpression Guard { get; }

    /// <summary>Gets the arm body.</summary>
    public BoundStatement Body { get; }

    /// <summary>Gets a value indicating whether this is the default arm.</summary>
    public bool IsDefault => Pattern == null;
}
