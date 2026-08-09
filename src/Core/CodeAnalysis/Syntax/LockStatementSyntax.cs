// <copyright file="LockStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>lock expr { body }</c> statement (issue #1885). Mutual
/// exclusion follows the classic <c>System.Threading.Monitor.Enter</c> /
/// <c>try</c> / <c>finally</c> / <c>Monitor.Exit</c> pattern C# uses to
/// lower <c>lock (expr) { body }</c>.
/// </summary>
public sealed class LockStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="LockStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="lockKeyword">The <c>lock</c> keyword.</param>
    /// <param name="expression">The lock-target expression.</param>
    /// <param name="body">The body statement.</param>
    public LockStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken lockKeyword,
        ExpressionSyntax expression,
        StatementSyntax body)
        : base(syntaxTree)
    {
        LockKeyword = lockKeyword;
        Expression = expression;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.LockStatement;

    /// <summary>Gets the <c>lock</c> keyword.</summary>
    public SyntaxToken LockKeyword { get; }

    /// <summary>Gets the lock-target expression.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>Gets the body statement.</summary>
    public StatementSyntax Body { get; }
}
