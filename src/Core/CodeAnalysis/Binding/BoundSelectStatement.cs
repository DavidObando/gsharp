// <copyright file="BoundSelectStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>select { … }</c> statement (Phase 5.6 / ADR-0022).
/// Orchestrates several channel operations and runs the body of
/// whichever arm becomes ready first.
/// </summary>
public sealed class BoundSelectStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundSelectStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="cases">The arms in source order.</param>
    public BoundSelectStatement(SyntaxNode syntax, ImmutableArray<BoundSelectCase> cases)
        : base(syntax)
    {
        Cases = cases;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SelectStatement;

    /// <summary>Gets the arms in source order. Source order matters for
    /// tie-breaking when several arms become ready in the same wakeup.</summary>
    public ImmutableArray<BoundSelectCase> Cases { get; }
}
