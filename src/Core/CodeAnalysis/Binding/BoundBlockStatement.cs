// <copyright file="BoundBlockStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound block statement.
/// </summary>
public sealed class BoundBlockStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundBlockStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="statements">The immutable array of bound statements.</param>
    public BoundBlockStatement(SyntaxNode? syntax, ImmutableArray<BoundStatement> statements)
        : this(syntax, statements, preEmitAnalysisBody: null)
    {
    }

    internal BoundBlockStatement(
        SyntaxNode? syntax,
        ImmutableArray<BoundStatement> statements,
        BoundBlockStatement? preEmitAnalysisBody)
        : base(syntax)
    {
        Statements = statements;
        PreEmitAnalysisBody = preEmitAnalysisBody;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BlockStatement;

    /// <summary>
    /// Gets the immutable array of bound statements.
    /// </summary>
    public ImmutableArray<BoundStatement> Statements { get; }

    /// <summary>
    /// Gets the pre-emit-rewrite body used by control-flow analyses.
    /// </summary>
    internal BoundBlockStatement? PreEmitAnalysisBody { get; }
}
