// <copyright file="TypeClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a type clause in the language.
/// </summary>
public sealed class TypeClauseSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a simple type.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The type clause identifier.</param>
    public TypeClauseSyntax(SyntaxTree syntaxTree, SyntaxToken identifier)
        : this(syntaxTree, openBracketToken: null, lengthToken: null, closeBracketToken: null, identifier, questionToken: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="TypeClauseSyntax"/> class, optionally
    /// wrapping the named element type in an array shape <c>[N]T</c>.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token, or <c>null</c> for a non-array type.</param>
    /// <param name="lengthToken">The numeric length token, or <c>null</c> for a non-array type.</param>
    /// <param name="closeBracketToken">The closing bracket token, or <c>null</c> for a non-array type.</param>
    /// <param name="identifier">The element type identifier.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        SyntaxToken identifier)
        : this(syntaxTree, openBracketToken, lengthToken, closeBracketToken, identifier, questionToken: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class with an optional nullable suffix (Phase 3.C.1).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token, or <c>null</c> for a non-array type.</param>
    /// <param name="lengthToken">The numeric length token, or <c>null</c> for a non-array type.</param>
    /// <param name="closeBracketToken">The closing bracket token, or <c>null</c> for a non-array type.</param>
    /// <param name="identifier">The (element) type identifier.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> marking the type nullable (Phase 3.C.1).</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        SyntaxToken identifier,
        SyntaxToken questionToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthToken = lengthToken;
        CloseBracketToken = closeBracketToken;
        Identifier = identifier;
        QuestionToken = questionToken;
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a tuple type <c>(T1, T2, ...)</c> (Phase 4.5).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="tupleElements">The comma-separated element type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> tupleElements,
        SyntaxToken closeParenToken,
        SyntaxToken questionToken)
        : base(syntaxTree)
    {
        OpenParenToken = openParenToken;
        TupleElements = tupleElements;
        CloseParenToken = closeParenToken;
        QuestionToken = questionToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeClause;

    /// <summary>Gets the opening bracket token, or <c>null</c> for non-array types.</summary>
    public SyntaxToken OpenBracketToken { get; }

    /// <summary>Gets the numeric length token, or <c>null</c> for non-array types.</summary>
    public SyntaxToken LengthToken { get; }

    /// <summary>Gets the closing bracket token, or <c>null</c> for non-array types.</summary>
    public SyntaxToken CloseBracketToken { get; }

    /// <summary>Gets the (element) type identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets a value indicating whether this clause denotes an array-shaped type (fixed-length array or slice).</summary>
    public bool IsArray => OpenBracketToken != null;

    /// <summary>Gets a value indicating whether this clause denotes a variable-length slice type <c>[]T</c>.</summary>
    public bool IsSlice => OpenBracketToken != null && LengthToken == null;

    /// <summary>Gets the optional trailing <c>?</c> token marking the type as nullable (Phase 3.C.1 / ADR-0001).</summary>
    public SyntaxToken QuestionToken { get; }

    /// <summary>Gets a value indicating whether this clause denotes a nullable type <c>T?</c> (Phase 3.C.1).</summary>
    public bool IsNullable => QuestionToken != null;

    /// <summary>Gets the opening <c>(</c> token for tuple types, or <c>null</c>.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the closing <c>)</c> token for tuple types, or <c>null</c>.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the comma-separated element-type clauses for a tuple type, or the default value.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> TupleElements { get; }

    /// <summary>Gets a value indicating whether this clause denotes a tuple type <c>(T1, T2, ...)</c> (Phase 4.5).</summary>
    public bool IsTuple => OpenParenToken != null;
}
