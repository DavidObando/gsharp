// <copyright file="AnonymousClassMemberInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single field member inside an anonymous-object literal
/// (ADR-0146, issue #2243), e.g. the <c>let Name = "David"</c> or
/// <c>let Flag bool = true</c> in <c>object { let Name = "David" }</c>.
/// Modeled on an ordinary <c>let</c>/<c>var</c> local declaration's grammar
/// (<see cref="VariableDeclarationSyntax"/>): the type clause is now
/// <em>optional</em> — when omitted the member's type is inferred from its
/// initializer expression exactly like an ordinary <c>let x = expr</c>
/// declaration.
/// </summary>
public sealed class AnonymousClassMemberInitializerSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AnonymousClassMemberInitializerSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="letOrVarKeyword">The <c>let</c> or <c>var</c> keyword.</param>
    /// <param name="identifier">The member name.</param>
    /// <param name="typeClause">The optional member type clause (inferred when null).</param>
    /// <param name="equalsToken">The member/value separator.</param>
    /// <param name="value">The value expression.</param>
    public AnonymousClassMemberInitializerSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken letOrVarKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        LetOrVarKeyword = letOrVarKeyword;
        Identifier = identifier;
        TypeClause = typeClause;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnonymousClassMemberInitializer;

    /// <summary>Gets the <c>let</c> or <c>var</c> keyword.</summary>
    public SyntaxToken LetOrVarKeyword { get; }

    /// <summary>Gets the member identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional member type clause. Null when the type is inferred from <see cref="Value"/>.</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the member/value separator token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }

    /// <summary>Gets a value indicating whether this member was declared read-only (<c>let</c>).</summary>
    public bool IsReadOnly => LetOrVarKeyword != null && LetOrVarKeyword.Kind == SyntaxKind.LetKeyword;
}
