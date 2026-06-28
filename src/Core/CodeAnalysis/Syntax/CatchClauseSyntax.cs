#nullable disable

// <copyright file="CatchClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>catch (e Exception) { … }</c> or <c>catch (e) { … }</c>
/// clause attached to a <see cref="TryStatementSyntax"/>.
/// </summary>
public sealed class CatchClauseSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="CatchClauseSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="catchKeyword">The <c>catch</c> keyword.</param>
    /// <param name="openParenthesisToken">The opening parenthesis token.</param>
    /// <param name="identifier">The bound variable identifier.</param>
    /// <param name="typeClause">The optional exception type clause.</param>
    /// <param name="closeParenthesisToken">The closing parenthesis token.</param>
    /// <param name="body">The handler block.</param>
    public CatchClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken catchKeyword,
        SyntaxToken openParenthesisToken,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken closeParenthesisToken,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        CatchKeyword = catchKeyword;
        OpenParenthesisToken = openParenthesisToken;
        Identifier = identifier;
        TypeClause = typeClause;
        CloseParenthesisToken = closeParenthesisToken;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.CatchClause;

    /// <summary>Gets the <c>catch</c> keyword.</summary>
    public SyntaxToken CatchKeyword { get; }

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>Gets the bound variable identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional exception type clause; <c>null</c> for an untyped catch.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenthesisToken { get; }

    /// <summary>Gets the handler block.</summary>
    public BlockStatementSyntax Body { get; }
}
