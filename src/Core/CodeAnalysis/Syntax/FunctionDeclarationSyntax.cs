// <copyright file="FunctionDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a function declaration in the language.
/// </summary>
public sealed class FunctionDeclarationSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    /// <param name="type">The function's type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken functionKeyword,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax type,
        BlockStatementSyntax body)
        : this(syntaxTree, accessibilityModifier: null, functionKeyword, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with an explicit accessibility modifier.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>).</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    /// <param name="type">The function's type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken functionKeyword,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax type,
        BlockStatementSyntax body)
        : this(syntaxTree, accessibilityModifier, openModifier: null, overrideModifier: null, functionKeyword, identifier, openParenthesisToken, parameters, closeParenthesisToken, type, body)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class with explicit accessibility and virtuality modifiers (Phase 3.B.3 sub-step 3).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>).</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword (marks the method as overridable per ADR-0017). Class methods only.</param>
    /// <param name="overrideModifier">The optional <c>override</c> contextual keyword (marks the method as overriding a base method). Class methods only.</param>
    /// <param name="functionKeyword">The func keyword.</param>
    /// <param name="identifier">The function identifier.</param>
    /// <param name="openParenthesisToken">The open parenthesis token.</param>
    /// <param name="parameters">The function's parameters.</param>
    /// <param name="closeParenthesisToken">The close parenthesis token.</param>
    /// <param name="type">The function's type.</param>
    /// <param name="body">The function's body.</param>
    public FunctionDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier,
        SyntaxToken functionKeyword,
        SyntaxToken identifier,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        TypeClauseSyntax type,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        OpenModifier = openModifier;
        OverrideModifier = overrideModifier;
        FunctionKeyword = functionKeyword;
        Identifier = identifier;
        OpenParenthesisToken = openParenthesisToken;
        Parameters = parameters;
        CloseParenthesisToken = closeParenthesisToken;
        Type = type;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FunctionDeclaration;

    /// <summary>
    /// Gets the optional accessibility modifier token (<c>public</c>/<c>internal</c>/<c>private</c>), or <c>null</c> if none was supplied.
    /// </summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the optional <c>open</c> modifier (Phase 3.B.3 sub-step 3). Non-null marks the method as overridable per ADR-0017. Only meaningful on class methods.</summary>
    public SyntaxToken OpenModifier { get; }

    /// <summary>Gets the optional <c>override</c> modifier (Phase 3.B.3 sub-step 3). Non-null marks the method as overriding a base method per ADR-0017. Only meaningful on class methods.</summary>
    public SyntaxToken OverrideModifier { get; }

    /// <summary>Gets a value indicating whether this function is marked <c>open</c>.</summary>
    public bool IsOpen => OpenModifier != null;

    /// <summary>Gets a value indicating whether this function is marked <c>override</c>.</summary>
    public bool IsOverride => OverrideModifier != null;

    /// <summary>
    /// Gets the func keyword.
    /// </summary>
    public SyntaxToken FunctionKeyword { get; }

    /// <summary>
    /// Gets the function identifier.
    /// </summary>
    public SyntaxToken Identifier { get; }

    /// <summary>
    /// Gets the open parenthesis token.
    /// </summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>
    /// Gets the function's parameters.
    /// </summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>
    /// Gets the close parenthesis token.
    /// </summary>
    public SyntaxToken CloseParenthesisToken { get; }

    /// <summary>
    /// Gets the function's type.
    /// </summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>
    /// Gets the function's body.
    /// </summary>
    public BlockStatementSyntax Body { get; }
}
