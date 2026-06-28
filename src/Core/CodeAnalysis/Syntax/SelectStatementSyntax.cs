#nullable disable

// <copyright file="SelectStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>select { … }</c> statement that orchestrates one of
/// several channel send/receive operations (Phase 5.6 / ADR-0022).
/// </summary>
public sealed class SelectStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="SelectStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="selectKeyword">The <c>select</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="cases">The arms (case + default).</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public SelectStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken selectKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<SelectCaseSyntax> cases,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        SelectKeyword = selectKeyword;
        OpenBraceToken = openBraceToken;
        Cases = cases;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SelectStatement;

    /// <summary>Gets the <c>select</c> keyword.</summary>
    public SyntaxToken SelectKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the arms.</summary>
    public ImmutableArray<SelectCaseSyntax> Cases { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
