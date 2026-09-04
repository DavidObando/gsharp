// <copyright file="CatchClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a catch clause attached to a <see cref="TryStatementSyntax"/>.
/// ADR-0177 gives the clause C# parity, so four shapes are legal:
/// <c>catch (e Type)</c> (typed and bound), <c>catch (Type)</c> (typed,
/// unbound), <c>catch</c> (catch-all, unbound), and any of those followed by a
/// <c>when</c> filter. The pre-ADR-0177 untyped <c>catch (name)</c> form is
/// retired: a parenthesized single identifier now names a type, not a binder.
/// </summary>
public sealed class CatchClauseSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="CatchClauseSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="catchKeyword">The <c>catch</c> keyword.</param>
    /// <param name="openParenthesisToken">The opening parenthesis token; <c>null</c> for a bare <c>catch</c>.</param>
    /// <param name="identifier">The bound variable identifier; <c>null</c> when the clause is unbound.</param>
    /// <param name="typeClause">The exception type clause; <c>null</c> for a bare <c>catch</c>.</param>
    /// <param name="closeParenthesisToken">The closing parenthesis token; <c>null</c> for a bare <c>catch</c>.</param>
    /// <param name="whenKeyword">The contextual <c>when</c> keyword; <c>null</c> when the clause has no filter.</param>
    /// <param name="filter">The filter expression; <c>null</c> when the clause has no filter.</param>
    /// <param name="body">The handler block.</param>
    public CatchClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken catchKeyword,
        SyntaxToken? openParenthesisToken,
        SyntaxToken? identifier,
        TypeClauseSyntax? typeClause,
        SyntaxToken? closeParenthesisToken,
        SyntaxToken? whenKeyword,
        ExpressionSyntax? filter,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        CatchKeyword = catchKeyword;
        OpenParenthesisToken = openParenthesisToken;
        Identifier = identifier;
        TypeClause = typeClause;
        CloseParenthesisToken = closeParenthesisToken;
        WhenKeyword = whenKeyword;
        Filter = filter;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.CatchClause;

    /// <summary>Gets the <c>catch</c> keyword.</summary>
    public SyntaxToken CatchKeyword { get; }

    /// <summary>Gets the opening parenthesis token; <c>null</c> for a bare <c>catch</c>.</summary>
    public SyntaxToken? OpenParenthesisToken { get; }

    /// <summary>Gets the bound variable identifier; <c>null</c> when the clause is unbound.</summary>
    public SyntaxToken? Identifier { get; }

    /// <summary>Gets the exception type clause; <c>null</c> for a bare <c>catch</c>, which catches <c>System.Exception</c>.</summary>
    public TypeClauseSyntax? TypeClause { get; }

    /// <summary>Gets the closing parenthesis token; <c>null</c> for a bare <c>catch</c>.</summary>
    public SyntaxToken? CloseParenthesisToken { get; }

    /// <summary>Gets the contextual <c>when</c> keyword; <c>null</c> when the clause has no filter.</summary>
    public SyntaxToken? WhenKeyword { get; }

    /// <summary>Gets the filter expression evaluated in the CLR's first pass; <c>null</c> when the clause has no filter.</summary>
    public ExpressionSyntax? Filter { get; }

    /// <summary>Gets the handler block.</summary>
    public BlockStatementSyntax Body { get; }
}
