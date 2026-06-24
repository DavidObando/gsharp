// <copyright file="BlockStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a block statement syntax in the language.
/// </summary>
public sealed class BlockStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BlockStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBraceToken">The open brace token.</param>
    /// <param name="statements">The immutable array of statements.</param>
    /// <param name="closeBraceToken">The close brace token.</param>
    public BlockStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBraceToken,
        ImmutableArray<StatementSyntax> statements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBraceToken = openBraceToken;
        Statements = statements;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.BlockStatement;

    /// <summary>
    /// Gets or sets the optional <c>unsafe</c> contextual keyword (ADR-0122 / issue #1014) that introduces this block as an <c>unsafe { … }</c>
    /// contextual keyword that introduces this block as an <c>unsafe { … }</c>
    /// block. When non-null the statements in the block are bound in an
    /// <c>unsafe</c> context (unmanaged raw pointers and raw-pointer operations
    /// permitted). Assigned by the parser; <c>null</c> for ordinary blocks.
    /// </summary>
    public SyntaxToken UnsafeKeyword { get; set; }

    /// <summary>Gets a value indicating whether this block is an <c>unsafe { … }</c> block (ADR-0122 / issue #1014).</summary>
    public bool IsUnsafe => UnsafeKeyword != null;

    /// <summary>
    /// Gets the open brace token.
    /// </summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>
    /// Gets the immutable array of statements.
    /// </summary>
    public ImmutableArray<StatementSyntax> Statements { get; }

    /// <summary>
    /// Gets the close brace token.
    /// </summary>
    public SyntaxToken CloseBraceToken { get; }
}
