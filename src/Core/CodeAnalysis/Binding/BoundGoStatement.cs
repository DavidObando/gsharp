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
    public BoundGoStatement(SyntaxNode? syntax, BoundExpression expression)
        : this(syntax, expression, sink: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundGoStatement"/> class with a completion sink.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound call expression to dispatch, shaped to yield a <c>ValueTask</c> (or <c>void</c>).</param>
    /// <param name="sink">The enclosing scope's frame (ADR-0174 D5), or <see langword="null"/> for a free goroutine reporting to the runtime's sink.</param>
    public BoundGoStatement(SyntaxNode? syntax, BoundExpression expression, BoundExpression? sink)
        : base(syntax)
    {
        Expression = expression;
        Sink = sink;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.GoStatement;

    /// <summary>Gets the bound expression to dispatch.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the completion sink expression (the enclosing scope frame), or <see langword="null"/> for a free goroutine.</summary>
    public BoundExpression? Sink { get; }
}
