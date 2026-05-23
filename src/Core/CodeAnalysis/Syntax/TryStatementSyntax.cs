// <copyright file="TryStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>try { … } catch (e Exception) { … } finally { … }</c>
/// statement. Either at least one catch clause or a finally clause
/// must be present.
/// </summary>
public sealed class TryStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TryStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="tryKeyword">The <c>try</c> keyword.</param>
    /// <param name="tryBlock">The protected block.</param>
    /// <param name="catchClauses">Zero or more catch clauses.</param>
    /// <param name="finallyClause">An optional finally clause.</param>
    public TryStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken tryKeyword,
        BlockStatementSyntax tryBlock,
        ImmutableArray<CatchClauseSyntax> catchClauses,
        FinallyClauseSyntax finallyClause)
        : base(syntaxTree)
    {
        TryKeyword = tryKeyword;
        TryBlock = tryBlock;
        CatchClauses = catchClauses;
        FinallyClause = finallyClause;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TryStatement;

    /// <summary>Gets the <c>try</c> keyword.</summary>
    public SyntaxToken TryKeyword { get; }

    /// <summary>Gets the protected block.</summary>
    public BlockStatementSyntax TryBlock { get; }

    /// <summary>Gets the catch clauses.</summary>
    public ImmutableArray<CatchClauseSyntax> CatchClauses { get; }

    /// <summary>Gets the optional finally clause.</summary>
    public FinallyClauseSyntax FinallyClause { get; }
}
