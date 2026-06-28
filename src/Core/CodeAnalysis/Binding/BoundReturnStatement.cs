#nullable disable

// <copyright file="BoundReturnStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound return statement.
/// </summary>
public sealed class BoundReturnStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundReturnStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression to return.</param>
    public BoundReturnStatement(SyntaxNode syntax, BoundExpression expression)
        : this(syntax, expression, isRef: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundReturnStatement"/> class with an
    /// explicit <paramref name="isRef"/> flag (issue #490).
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression to return. When <paramref name="isRef"/> is true,
    /// this is a <see cref="BoundAddressOfExpression"/> wrapping the lvalue being returned by reference.</param>
    /// <param name="isRef">When <c>true</c>, the statement returns the value by managed pointer
    /// (the enclosing function must have <c>ReturnRefKind == Ref</c>).</param>
    public BoundReturnStatement(SyntaxNode syntax, BoundExpression expression, bool isRef)
        : base(syntax)
    {
        Expression = expression;
        IsRef = isRef;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ReturnStatement;

    /// <summary>
    /// Gets the expression to return.
    /// </summary>
    public BoundExpression Expression { get; }

    /// <summary>
    /// Gets a value indicating whether this is a <c>return ref</c> statement (issue #490).
    /// When true, <see cref="Expression"/> is a <see cref="BoundAddressOfExpression"/> wrapping the lvalue.
    /// </summary>
    public bool IsRef { get; }
}
