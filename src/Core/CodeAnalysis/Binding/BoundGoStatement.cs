// <copyright file="BoundGoStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
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
        : this(syntax, expression, sink, resultCell: null, resultType: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundGoStatement"/> class for an <c>async let</c> child.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound call expression to dispatch. Its result is kept, not discarded.</param>
    /// <param name="sink">The child's cell, which is also its completion sink.</param>
    /// <param name="resultCell">A read of the <c>AsyncLetCell[R]</c> the child's value is deposited into (ADR-0174 D15), or <see langword="null"/> for an ordinary <c>go</c>.</param>
    /// <param name="resultType">The binding's type <c>R</c>, carried alongside the cell because a same-compilation type travels symbolically and the cell's CLR type closes over <c>object</c>.</param>
    public BoundGoStatement(SyntaxNode? syntax, BoundExpression expression, BoundExpression? sink, BoundExpression? resultCell, TypeSymbol? resultType)
        : base(syntax)
    {
        Expression = expression;
        Sink = sink;
        ResultCell = resultCell;
        ResultType = resultType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.GoStatement;

    /// <summary>Gets the bound expression to dispatch.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the completion sink expression (the enclosing scope frame), or <see langword="null"/> for a free goroutine.</summary>
    public BoundExpression? Sink { get; }

    /// <summary>
    /// Gets the <c>AsyncLetCell[R]</c> this child deposits its value into
    /// (ADR-0174 D15), or <see langword="null"/> when the result is discarded
    /// as an ordinary <c>go</c> discards it. The suspension pass wraps the
    /// operand in <c>cell.Run(…)</c>: the overload is chosen from the operand's
    /// <em>rewritten</em> type, because an inferred callee is typed <c>R</c>
    /// when the binder sees it and <c>ValueTask[R]</c> after the fixed point.
    /// </summary>
    public BoundExpression? ResultCell { get; }

    /// <summary>Gets the <c>async let</c> binding's type, or <see langword="null"/> for an ordinary <c>go</c>.</summary>
    public TypeSymbol? ResultType { get; }
}
