// <copyright file="DelegateDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a named delegate type declaration
/// <c>delegate Name[TParams]?(params...) ReturnType? ;</c> (issue #3510;
/// originally ADR-0059 / issue #255 with the retired
/// <c>type Name = delegate func(...)</c> spelling, which now parses only as
/// an error-recovery form). Unlike an erased type alias, this declaration
/// emits a real CLR TypeDef deriving from <c>System.MulticastDelegate</c>.
/// The required trailing semicolon terminates the optional return-type
/// clause, matching extern natives and interface bodiless members.
/// </summary>
public sealed class DelegateDeclarationSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DelegateDeclarationSyntax"/> class
    /// for the canonical <c>delegate Name(params) R;</c> form (issue #3510).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>, <c>internal</c>, <c>private</c>).</param>
    /// <param name="delegateKeyword">The contextual <c>delegate</c> identifier token opening the declaration.</param>
    /// <param name="identifier">The delegate type name.</param>
    /// <param name="typeParameterList">Optional generic type-parameter list (<c>[T any]</c>).</param>
    /// <param name="openParenToken">The <c>(</c> token opening the parameter list.</param>
    /// <param name="parameters">The (possibly empty) parameter list.</param>
    /// <param name="closeParenToken">The <c>)</c> token closing the parameter list.</param>
    /// <param name="returnType">Optional return type clause; <c>null</c> for void.</param>
    /// <param name="semicolonToken">The required terminating <c>;</c> token.</param>
    public DelegateDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken delegateKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax? typeParameterList,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenToken,
        TypeClauseSyntax? returnType,
        SyntaxToken semicolonToken)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        DelegateKeyword = delegateKeyword;
        Identifier = identifier;
        TypeParameterList = typeParameterList;
        OpenParenToken = openParenToken;
        Parameters = parameters;
        CloseParenToken = closeParenToken;
        ReturnType = returnType;
        SemicolonToken = semicolonToken;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="DelegateDeclarationSyntax"/> class
    /// for the RETIRED <c>type Name = delegate func(...)</c> recovery form
    /// (issue #3510 — the parser reports the migration diagnostic and keeps
    /// binding through this node so downstream sees one clean error).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>, <c>internal</c>, <c>private</c>).</param>
    /// <param name="typeKeyword">The legacy <c>type</c> token that opened the declaration.</param>
    /// <param name="identifier">The delegate type name.</param>
    /// <param name="typeParameterList">Optional generic type-parameter list (<c>[T any]</c>).</param>
    /// <param name="equalsToken">The legacy <c>=</c> token.</param>
    /// <param name="delegateKeyword">The contextual <c>delegate</c> identifier token.</param>
    /// <param name="funcKeyword">The legacy <c>func</c> keyword.</param>
    /// <param name="openParenToken">The <c>(</c> token opening the parameter list.</param>
    /// <param name="parameters">The (possibly empty) parameter list.</param>
    /// <param name="closeParenToken">The <c>)</c> token closing the parameter list.</param>
    /// <param name="returnType">Optional return type clause; <c>null</c> for void.</param>
    public DelegateDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken? typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax? typeParameterList,
        SyntaxToken equalsToken,
        SyntaxToken delegateKeyword,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenToken,
        TypeClauseSyntax? returnType)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        TypeParameterList = typeParameterList;
        EqualsToken = equalsToken;
        DelegateKeyword = delegateKeyword;
        FuncKeyword = funcKeyword;
        OpenParenToken = openParenToken;
        Parameters = parameters;
        CloseParenToken = closeParenToken;
        ReturnType = returnType;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.DelegateDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken? AccessibilityModifier { get; }

    /// <summary>Gets the legacy <c>type</c> token (retired-form recovery only; issue #3510).</summary>
    public SyntaxToken? TypeKeyword { get; }

    /// <summary>Gets the delegate type identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional generic type-parameter list.</summary>
    public TypeParameterListSyntax? TypeParameterList { get; }

    /// <summary>Gets the legacy <c>=</c> token (retired-form recovery only; issue #3510).</summary>
    public SyntaxToken? EqualsToken { get; }

    /// <summary>Gets the contextual <c>delegate</c> identifier token.</summary>
    public SyntaxToken DelegateKeyword { get; }

    /// <summary>Gets the legacy <c>func</c> keyword (retired-form recovery only; issue #3510).</summary>
    public SyntaxToken? FuncKeyword { get; }

    /// <summary>Gets the required terminating <c>;</c> token of the canonical form (issue #3510); <see langword="null"/> on the retired-form recovery node.</summary>
    public SyntaxToken? SemicolonToken { get; }

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the parameter list (may be empty).</summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the optional return type clause; <c>null</c> for a <c>void</c>-returning delegate.</summary>
    public TypeClauseSyntax? ReturnType { get; }
}
