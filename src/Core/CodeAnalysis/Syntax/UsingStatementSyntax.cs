#nullable disable

// <copyright file="UsingStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>using let name = expr</c> or
/// <c>using var name = expr</c> declaration whose bound variable is
/// disposed (via <c>IDisposable.Dispose</c>) when the enclosing scope
/// exits.
/// </summary>
public sealed class UsingStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="UsingStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="usingKeyword">The <c>using</c> keyword.</param>
    /// <param name="declaration">The wrapped variable declaration.</param>
    public UsingStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken usingKeyword,
        VariableDeclarationSyntax declaration)
        : base(syntaxTree)
    {
        UsingKeyword = usingKeyword;
        Declaration = declaration;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.UsingStatement;

    /// <summary>Gets the <c>using</c> keyword.</summary>
    public SyntaxToken UsingKeyword { get; }

    /// <summary>Gets the wrapped variable declaration.</summary>
    public VariableDeclarationSyntax Declaration { get; }
}
