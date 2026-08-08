// <copyright file="BoundIfStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound if statement.
/// </summary>
public sealed class BoundIfStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundIfStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="condition">The bound if statement condition.</param>
    /// <param name="thenStatement">The then statement.</param>
    /// <param name="elseStatement">The else statement, or <c>null</c> for an
    /// <c>if</c> with no <c>else</c> clause.</param>
    public BoundIfStatement(
        SyntaxNode? syntax,
        BoundExpression condition,
        BoundStatement thenStatement,
        BoundStatement? elseStatement)
        : base(syntax)
    {
        Condition = condition;
        ThenStatement = thenStatement;
        ElseStatement = elseStatement;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IfStatement;

    /// <summary>
    /// Gets the bound if statement condition.
    /// </summary>
    public BoundExpression Condition { get; }

    /// <summary>
    /// Gets the then statement.
    /// </summary>
    public BoundStatement ThenStatement { get; }

    /// <summary>
    /// Gets the else statement, or <c>null</c> for an <c>if</c> with no
    /// <c>else</c> clause. Every rewriter and walker over this node already
    /// tests it before recursing.
    /// </summary>
    public BoundStatement? ElseStatement { get; }
}
