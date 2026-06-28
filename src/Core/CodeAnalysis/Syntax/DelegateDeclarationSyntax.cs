#nullable disable

// <copyright file="DelegateDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a named delegate type declaration of the form
/// <c>type Name = delegate func(params...) ret</c> (ADR-0059 / issue #255).
/// Unlike an erased type alias, this form emits a real CLR TypeDef that derives
/// from <c>System.MulticastDelegate</c>.
/// </summary>
public sealed class DelegateDeclarationSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DelegateDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>, <c>internal</c>, <c>private</c>).</param>
    /// <param name="typeKeyword">The <c>type</c> keyword that opens the declaration.</param>
    /// <param name="identifier">The delegate type name.</param>
    /// <param name="typeParameterList">Optional generic type-parameter list (<c>[T any]</c>).</param>
    /// <param name="equalsToken">The <c>=</c> token between the name and the delegate form.</param>
    /// <param name="delegateKeyword">The contextual <c>delegate</c> identifier token marking the delegate form.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword that opens the delegate signature.</param>
    /// <param name="openParenToken">The <c>(</c> token opening the parameter list.</param>
    /// <param name="parameters">The (possibly empty) parameter list.</param>
    /// <param name="closeParenToken">The <c>)</c> token closing the parameter list.</param>
    /// <param name="returnType">Optional return type clause; <c>null</c> for void.</param>
    public DelegateDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken equalsToken,
        SyntaxToken delegateKeyword,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnType)
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
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the <c>type</c> keyword.</summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>Gets the delegate type identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional generic type-parameter list.</summary>
    public TypeParameterListSyntax TypeParameterList { get; }

    /// <summary>Gets the <c>=</c> token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the contextual <c>delegate</c> identifier token.</summary>
    public SyntaxToken DelegateKeyword { get; }

    /// <summary>Gets the <c>func</c> keyword.</summary>
    public SyntaxToken FuncKeyword { get; }

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the parameter list (may be empty).</summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the optional return type clause; <c>null</c> for a <c>void</c>-returning delegate.</summary>
    public TypeClauseSyntax ReturnType { get; }
}
