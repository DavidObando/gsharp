// <copyright file="BoundThrowStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>throw expr</c> statement.
/// </summary>
public sealed class BoundThrowStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundThrowStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound exception expression.</param>
    public BoundThrowStatement(SyntaxNode? syntax, BoundExpression expression)
        : this(syntax, expression, null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundThrowStatement"/> class
    /// for a compiler-generated throw with an interpreter diagnostic.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The bound exception expression.</param>
    /// <param name="diagnosticDescriptor">The interpreter diagnostic.</param>
    internal BoundThrowStatement(
        SyntaxNode? syntax,
        BoundExpression expression,
        DiagnosticDescriptor? diagnosticDescriptor)
        : base(syntax)
    {
        Expression = expression;
        DiagnosticDescriptor = diagnosticDescriptor;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ThrowStatement;

    /// <summary>Gets the bound exception expression.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the interpreter diagnostic for a compiler-generated throw.</summary>
    internal DiagnosticDescriptor? DiagnosticDescriptor { get; }
}
