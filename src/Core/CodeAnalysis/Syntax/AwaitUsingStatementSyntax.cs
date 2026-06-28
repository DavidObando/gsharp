#nullable disable

// <copyright file="AwaitUsingStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an <c>await using let name = expr</c> declaration whose
/// bound variable is asynchronously disposed (via
/// <c>IAsyncDisposable.DisposeAsync</c>) when the enclosing scope exits.
/// </summary>
public sealed class AwaitUsingStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="AwaitUsingStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="awaitKeyword">The <c>await</c> keyword.</param>
    /// <param name="usingKeyword">The <c>using</c> keyword.</param>
    /// <param name="declaration">The wrapped variable declaration.</param>
    public AwaitUsingStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken awaitKeyword,
        SyntaxToken usingKeyword,
        VariableDeclarationSyntax declaration)
        : base(syntaxTree)
    {
        AwaitKeyword = awaitKeyword;
        UsingKeyword = usingKeyword;
        Declaration = declaration;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AwaitUsingStatement;

    /// <summary>Gets the <c>await</c> keyword.</summary>
    public SyntaxToken AwaitKeyword { get; }

    /// <summary>Gets the <c>using</c> keyword.</summary>
    public SyntaxToken UsingKeyword { get; }

    /// <summary>Gets the wrapped variable declaration.</summary>
    public VariableDeclarationSyntax Declaration { get; }
}
