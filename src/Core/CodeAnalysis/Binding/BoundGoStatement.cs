// <copyright file="BoundGoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>go f(args)</c> statement (Phase 5.3 / ADR-0022). The
/// expression is a call (or call-returning expression) that runs on a
/// background <see cref="System.Threading.Tasks.Task"/>.
/// </summary>
public sealed class BoundGoStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundGoStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound call expression to dispatch.</param>
    public BoundGoStatement(SyntaxNode syntax, BoundExpression expression)
        : base(syntax)
    {
        Expression = expression;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.GoStatement;

    /// <summary>Gets the bound expression to dispatch.</summary>
    public BoundExpression Expression { get; }
}
