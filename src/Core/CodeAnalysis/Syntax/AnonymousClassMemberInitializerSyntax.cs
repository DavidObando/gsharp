// <copyright file="AnonymousClassMemberInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single <c>let Name Type = value</c> element inside an
/// anonymous-class literal (issue #2224), e.g. the <c>let Name string =
/// "Foo"</c> in <c>object { let Name string = "Foo" }</c>. Modeled on an
/// ordinary <c>let</c> local declaration's grammar (<see cref="VariableDeclarationSyntax"/>),
/// but the type clause is mandatory here since there is no statement context
/// to infer it from.
/// </summary>
public sealed class AnonymousClassMemberInitializerSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AnonymousClassMemberInitializerSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="letKeyword">The <c>let</c> keyword.</param>
    /// <param name="identifier">The member name.</param>
    /// <param name="typeClause">The mandatory member type clause.</param>
    /// <param name="equalsToken">The member/value separator.</param>
    /// <param name="value">The value expression.</param>
    public AnonymousClassMemberInitializerSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken letKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        LetKeyword = letKeyword;
        Identifier = identifier;
        TypeClause = typeClause;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnonymousClassMemberInitializer;

    /// <summary>Gets the <c>let</c> keyword.</summary>
    public SyntaxToken LetKeyword { get; }

    /// <summary>Gets the member identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the mandatory member type clause.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the member/value separator token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
