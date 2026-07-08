// <copyright file="AnonymousClassExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an anonymous-object literal expression (ADR-0146, issue #2243).
/// The redesigned, Kotlin-flavoured shape supports four forms:
/// <list type="bullet">
/// <item><c>object { let Name = "David" }</c> — field members (types optional/inferred);</item>
/// <item><c>object : IFace { func f() { ... } }</c> — implementing an interface;</item>
/// <item><c>object : Base(args) { override func f() ... }</c> — extending an open base class;</item>
/// <item><c>data object { let Name = "David" }</c> — a value-semantics data object (Equals/GetHashCode/ToString/Deconstruct/with).</item>
/// </list>
/// Members are separated by newlines or semicolons (like the rest of the
/// language), never commas. Field, method, and event members are supported;
/// <c>init</c>/<c>deinit</c> are rejected.
/// </summary>
public sealed class AnonymousClassExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AnonymousClassExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="objectKeyword">The <c>object</c> keyword.</param>
    /// <param name="baseColonToken">The optional <c>:</c> introducing a base/interface clause.</param>
    /// <param name="baseTypeClause">The optional first base/interface type clause.</param>
    /// <param name="baseConstructorOpenParenthesisToken">The optional base-constructor argument list open paren.</param>
    /// <param name="baseConstructorArguments">The optional base-constructor arguments.</param>
    /// <param name="baseConstructorCloseParenthesisToken">The optional base-constructor argument list close paren.</param>
    /// <param name="additionalBaseTypeClauses">The additional comma-separated interface clauses.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="members">The ordered field / method / event members.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public AnonymousClassExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken dataKeyword,
        SyntaxToken objectKeyword,
        SyntaxToken baseColonToken,
        TypeClauseSyntax baseTypeClause,
        SyntaxToken baseConstructorOpenParenthesisToken,
        SeparatedSyntaxList<ExpressionSyntax> baseConstructorArguments,
        SyntaxToken baseConstructorCloseParenthesisToken,
        SeparatedSyntaxList<TypeClauseSyntax> additionalBaseTypeClauses,
        SyntaxToken openBraceToken,
        ImmutableArray<SyntaxNode> members,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        DataKeyword = dataKeyword;
        ObjectKeyword = objectKeyword;
        BaseColonToken = baseColonToken;
        BaseTypeClause = baseTypeClause;
        BaseConstructorOpenParenthesisToken = baseConstructorOpenParenthesisToken;
        BaseConstructorArguments = baseConstructorArguments;
        BaseConstructorCloseParenthesisToken = baseConstructorCloseParenthesisToken;
        AdditionalBaseTypeClauses = additionalBaseTypeClauses;
        OpenBraceToken = openBraceToken;
        Members = members;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnonymousClassExpression;

    /// <summary>Gets the optional <c>data</c> contextual keyword. Non-null for a <c>data object</c>.</summary>
    public SyntaxToken DataKeyword { get; }

    /// <summary>Gets the <c>object</c> keyword.</summary>
    public SyntaxToken ObjectKeyword { get; }

    /// <summary>Gets the optional <c>:</c> token introducing the base/interface clause.</summary>
    public SyntaxToken BaseColonToken { get; }

    /// <summary>Gets the optional first base/interface type clause.</summary>
    public TypeClauseSyntax BaseTypeClause { get; }

    /// <summary>Gets the optional base-constructor argument list open paren.</summary>
    public SyntaxToken BaseConstructorOpenParenthesisToken { get; }

    /// <summary>Gets the optional base-constructor arguments.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> BaseConstructorArguments { get; }

    /// <summary>Gets the optional base-constructor argument list close paren.</summary>
    public SyntaxToken BaseConstructorCloseParenthesisToken { get; }

    /// <summary>Gets the additional comma-separated interface clauses.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> AdditionalBaseTypeClauses { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>
    /// Gets the ordered members. Each element is one of
    /// <see cref="AnonymousClassMemberInitializerSyntax"/> (a field),
    /// <see cref="FunctionDeclarationSyntax"/> (a method), or
    /// <see cref="EventDeclarationSyntax"/> (an event). Source order is
    /// preserved so member spans stay stable.
    /// </summary>
    public ImmutableArray<SyntaxNode> Members { get; }

    /// <summary>Gets a value indicating whether this is a <c>data object</c>.</summary>
    public bool IsData => DataKeyword != null;

    /// <summary>Gets a value indicating whether this literal carries a base-class or interface clause.</summary>
    public bool HasBaseType => BaseColonToken != null;

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
