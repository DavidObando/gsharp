// <copyright file="BoundTryStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>try { … } catch (e T) { … } finally { … }</c> statement.
/// </summary>
public sealed class BoundTryStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundTryStatement"/> class.</summary>
    /// <param name="tryBlock">The protected block.</param>
    /// <param name="catchClauses">The bound catch clauses (possibly empty).</param>
    /// <param name="finallyBlock">The optional finally block.</param>
    public BoundTryStatement(BoundStatement tryBlock, ImmutableArray<BoundCatchClause> catchClauses, BoundStatement finallyBlock)
    {
        TryBlock = tryBlock;
        CatchClauses = catchClauses;
        FinallyBlock = finallyBlock;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.TryStatement;

    /// <summary>Gets the protected block.</summary>
    public BoundStatement TryBlock { get; }

    /// <summary>Gets the bound catch clauses.</summary>
    public ImmutableArray<BoundCatchClause> CatchClauses { get; }

    /// <summary>Gets the optional finally block.</summary>
    public BoundStatement FinallyBlock { get; }
}
