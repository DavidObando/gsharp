#nullable disable

// <copyright file="BoundScopeStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>scope { … }</c> statement (Phase 5.7 / ADR-0022). Spawned
/// <c>go</c> tasks lexically inside the body are tracked by the scope
/// and awaited when the body exits; the first failure is rethrown
/// (additional failures attach as <see cref="System.AggregateException"/>
/// inner exceptions). The scope's cancellation token is signalled on
/// the first failure so cooperating tasks can short-circuit.
/// </summary>
public sealed class BoundScopeStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundScopeStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="body">The bound body block.</param>
    public BoundScopeStatement(SyntaxNode syntax, BoundStatement body)
        : base(syntax)
    {
        Body = body;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ScopeStatement;

    /// <summary>Gets the bound body block.</summary>
    public BoundStatement Body { get; }
}
