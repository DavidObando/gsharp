// <copyright file="StructDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a Go-style <c>type Name struct { ... }</c> declaration (Phase 3.B.1).
/// </summary>
public sealed class StructDeclarationSyntax : MemberSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The struct identifier.</param>
    /// <param name="structKeyword">The <c>struct</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="fields">The field declarations.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken structKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword: null, structKeyword, openBraceToken, fields, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The struct identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="structKeyword">The <c>struct</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="fields">The field declarations.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken structKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, structKeyword, primaryConstructorOpenParen: null, primaryConstructorParameters: new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty), primaryConstructorCloseParen: null, openBraceToken, fields, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a Kotlin-style primary constructor (classes only).</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list (empty when no primary constructor is declared).</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, structKeyword, primaryConstructorOpenParen, primaryConstructorParameters, primaryConstructorCloseParen, openBraceToken, fields, ImmutableArray<FunctionDeclarationSyntax>.Empty, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a Kotlin-style primary constructor (classes only).</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list (empty when no primary constructor is declared).</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="methods">The method declarations in the body (classes only, Phase 3.B.3 sub-step 2b).</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        DataKeyword = dataKeyword;
        StructKeyword = structKeyword;
        PrimaryConstructorOpenParenthesisToken = primaryConstructorOpenParen;
        PrimaryConstructorParameters = primaryConstructorParameters;
        PrimaryConstructorCloseParenthesisToken = primaryConstructorCloseParen;
        OpenBraceToken = openBraceToken;
        Fields = fields;
        Methods = methods;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StructDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the <c>type</c> keyword.</summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>Gets the struct identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional <c>data</c> contextual keyword. Non-null when this is a <c>data struct</c> (Phase 3.B.2).</summary>
    public SyntaxToken DataKeyword { get; }

    /// <summary>Gets the <c>struct</c> or <c>class</c> keyword that marks this aggregate declaration. Inspect <see cref="IsClass"/> to distinguish.</summary>
    public SyntaxToken StructKeyword { get; }

    /// <summary>Gets the optional opening paren of a Kotlin-style primary constructor parameter list (Phase 3.B.3 sub-step 2); null when none was declared.</summary>
    public SyntaxToken PrimaryConstructorOpenParenthesisToken { get; }

    /// <summary>Gets the primary constructor parameter list. Empty when no primary constructor was declared.</summary>
    public SeparatedSyntaxList<ParameterSyntax> PrimaryConstructorParameters { get; }

    /// <summary>Gets the optional closing paren of the primary constructor parameter list; null when none was declared.</summary>
    public SyntaxToken PrimaryConstructorCloseParenthesisToken { get; }

    /// <summary>Gets a value indicating whether this declaration carries a Kotlin-style primary constructor parameter list.</summary>
    public bool HasPrimaryConstructor => PrimaryConstructorOpenParenthesisToken != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>data</c> contextual keyword.</summary>
    public bool IsData => DataKeyword != null;

    /// <summary>Gets a value indicating whether this aggregate was declared with the <c>class</c> keyword (Phase 3.B.3) rather than <c>struct</c>.</summary>
    public bool IsClass => StructKeyword?.Kind == SyntaxKind.ClassKeyword;

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field declarations.</summary>
    public ImmutableArray<FieldDeclarationSyntax> Fields { get; }

    /// <summary>Gets the method declarations declared inside the body (Phase 3.B.3 sub-step 2b — classes only). Empty for struct types and for bodyless declarations.</summary>
    public ImmutableArray<FunctionDeclarationSyntax> Methods { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
