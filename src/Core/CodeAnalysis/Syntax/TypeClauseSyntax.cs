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
        : this(syntaxTree, openBracketToken, lengthToken, closeBracketToken, identifier, typeArgumentOpenBracketToken: null, typeArguments: default, typeArgumentCloseBracketToken: null, questionToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class supporting an optional type-argument list <c>Foo[T1, T2]</c> in type position (Phase 4.3c / ADR-0020).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token of the array/slice prefix, or <c>null</c>.</param>
    /// <param name="lengthToken">The numeric length token, or <c>null</c>.</param>
    /// <param name="closeBracketToken">The closing bracket token of the array/slice prefix, or <c>null</c>.</param>
    /// <param name="identifier">The (element) type identifier.</param>
    /// <param name="typeArgumentOpenBracketToken">The opening bracket of the type-argument list, or <c>null</c>.</param>
    /// <param name="typeArguments">The type-argument list, or the default value.</param>
    /// <param name="typeArgumentCloseBracketToken">The closing bracket of the type-argument list, or <c>null</c>.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> marking the type nullable.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        SyntaxToken identifier,
        SyntaxToken typeArgumentOpenBracketToken,
        SeparatedSyntaxList<TypeClauseSyntax> typeArguments,
        SyntaxToken typeArgumentCloseBracketToken,
        SyntaxToken questionToken)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthToken = lengthToken;
        CloseBracketToken = closeBracketToken;
        Identifier = identifier;
        TypeArgumentOpenBracketToken = typeArgumentOpenBracketToken;
        TypeArguments = typeArguments;
        TypeArgumentCloseBracketToken = typeArgumentCloseBracketToken;
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

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a map type <c>map[K]V?</c> (Phase 3.A.4).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="mapKeyword">The <c>map</c> keyword.</param>
    /// <param name="mapOpenBracketToken">The <c>[</c> introducing the key type.</param>
    /// <param name="mapKeyType">The key type clause.</param>
    /// <param name="mapCloseBracketToken">The <c>]</c> closing the key type.</param>
    /// <param name="mapValueType">The value type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken mapKeyword,
        SyntaxToken mapOpenBracketToken,
        TypeClauseSyntax mapKeyType,
        SyntaxToken mapCloseBracketToken,
        TypeClauseSyntax mapValueType,
        SyntaxToken questionToken)
        : base(syntaxTree)
    {
        MapKeyword = mapKeyword;
        MapOpenBracketToken = mapOpenBracketToken;
        MapKeyType = mapKeyType;
        MapCloseBracketToken = mapCloseBracketToken;
        MapValueType = mapValueType;
        QuestionToken = questionToken;
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a function type <c>func(T1, T2, ...) R?</c> (Phase 4.7), optionally prefixed by the <c>async</c> modifier per ADR-0043.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="returnTypeClause">The optional return-type clause; <c>null</c> for void.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
        : this(syntaxTree, asyncModifier: null, funcKeyword, openParenToken, functionParameterTypes, closeParenToken, returnTypeClause, questionToken, isFunction: true)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a channel type <c>chan T?</c> (Phase 5.4 / ADR-0022).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="chanKeyword">The <c>chan</c> keyword.</param>
    /// <param name="chanElementType">The element type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken chanKeyword,
        TypeClauseSyntax chanElementType,
        SyntaxToken questionToken)
        : base(syntaxTree)
    {
        ChanKeyword = chanKeyword;
        ChanElementType = chanElementType;
        QuestionToken = questionToken;
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a pointer type (ADR-0039).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken starToken,
        TypeClauseSyntax pointeeType,
        SyntaxToken questionToken,
        bool isPointer)
        : base(syntaxTree)
    {
        PointerStarToken = starToken;
        PointerPointeeType = pointeeType;
        QuestionToken = questionToken;
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a sequence type (ADR-0040) — optionally prefixed by the <c>async</c> modifier per ADR-0042.</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken sequenceKeyword,
        SyntaxToken openBracketToken,
        TypeClauseSyntax elementType,
        SyntaxToken closeBracketToken,
        SyntaxToken questionToken,
        bool isSequence)
        : base(syntaxTree)
    {
        AsyncModifier = asyncModifier;
        SequenceKeyword = sequenceKeyword;
        SequenceOpenBracketToken = openBracketToken;
        SequenceElementType = elementType;
        SequenceCloseBracketToken = closeBracketToken;
        QuestionToken = questionToken;
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for an (optionally <c>async</c>-modified) function type clause (ADR-0043).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken,
        bool isFunction)
        : base(syntaxTree)
    {
        AsyncModifier = asyncModifier;
        FuncKeyword = funcKeyword;
        OpenParenToken = openParenToken;
        FunctionParameterTypes = functionParameterTypes;
        CloseParenToken = closeParenToken;
        ReturnTypeClause = returnTypeClause;
        QuestionToken = questionToken;
    }
#pragma warning restore SA1642

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
    public bool IsTuple => OpenParenToken != null && FuncKeyword == null;

    /// <summary>Gets the <c>func</c> keyword for function-type clauses, or <c>null</c>.</summary>
    public SyntaxToken FuncKeyword { get; }

    /// <summary>Gets the function parameter-type clauses, or the default value.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> FunctionParameterTypes { get; }

    /// <summary>Gets the function return-type clause, or <c>null</c> when the type is void / not a function type.</summary>
    public TypeClauseSyntax ReturnTypeClause { get; }

    /// <summary>Gets a value indicating whether this clause denotes a function type <c>func(...) R?</c> (Phase 4.7).</summary>
    public bool IsFunction => FuncKeyword != null;

    /// <summary>Gets the opening <c>[</c> of the type-argument list (Phase 4.3c), or <c>null</c>.</summary>
    public SyntaxToken TypeArgumentOpenBracketToken { get; }

    /// <summary>Gets the comma-separated type-argument clauses for a constructed generic type (Phase 4.3c), or the default value.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> TypeArguments { get; }

    /// <summary>Gets the closing <c>]</c> of the type-argument list (Phase 4.3c), or <c>null</c>.</summary>
    public SyntaxToken TypeArgumentCloseBracketToken { get; }

    /// <summary>Gets a value indicating whether this clause carries a type-argument list <c>Foo[T1, T2]</c> (Phase 4.3c).</summary>
    public bool HasTypeArguments => TypeArgumentOpenBracketToken != null;

    /// <summary>Gets the <c>map</c> keyword for map types, or <c>null</c>.</summary>
    public SyntaxToken MapKeyword { get; }

    /// <summary>Gets the <c>[</c> opening the map key type, or <c>null</c>.</summary>
    public SyntaxToken MapOpenBracketToken { get; }

    /// <summary>Gets the map key type clause, or <c>null</c>.</summary>
    public TypeClauseSyntax MapKeyType { get; }

    /// <summary>Gets the <c>]</c> closing the map key type, or <c>null</c>.</summary>
    public SyntaxToken MapCloseBracketToken { get; }

    /// <summary>Gets the map value type clause, or <c>null</c>.</summary>
    public TypeClauseSyntax MapValueType { get; }

    /// <summary>Gets a value indicating whether this clause denotes a map type <c>map[K]V</c> (Phase 3.A.4).</summary>
    public bool IsMap => MapKeyword != null;

    /// <summary>Gets the <c>chan</c> keyword for channel types, or <c>null</c>.</summary>
    public SyntaxToken ChanKeyword { get; }

    /// <summary>Gets the channel element type clause, or <c>null</c>.</summary>
    public TypeClauseSyntax ChanElementType { get; }

    /// <summary>Gets a value indicating whether this clause denotes a channel type <c>chan T</c> (Phase 5.4 / ADR-0022).</summary>
    public bool IsChannel => ChanKeyword != null;

    /// <summary>Gets the <c>*</c> token for pointer types, or <c>null</c> (ADR-0039).</summary>
    public SyntaxToken PointerStarToken { get; }

    /// <summary>Gets the pointee type clause for pointer types, or <c>null</c> (ADR-0039).</summary>
    public TypeClauseSyntax PointerPointeeType { get; }

    /// <summary>Gets a value indicating whether this clause denotes a pointer type <c>*T</c> (ADR-0039).</summary>
    public bool IsPointer => PointerStarToken != null;

    /// <summary>Gets the <c>sequence</c> keyword for sequence types, or <c>null</c> (ADR-0040).</summary>
    public SyntaxToken SequenceKeyword { get; }

    /// <summary>Gets the <c>[</c> opening the sequence element type, or <c>null</c> (ADR-0040).</summary>
    public SyntaxToken SequenceOpenBracketToken { get; }

    /// <summary>Gets the sequence element type clause, or <c>null</c> (ADR-0040).</summary>
    public TypeClauseSyntax SequenceElementType { get; }

    /// <summary>Gets the <c>]</c> closing the sequence element type, or <c>null</c> (ADR-0040).</summary>
    public SyntaxToken SequenceCloseBracketToken { get; }

    /// <summary>Gets a value indicating whether this clause denotes a sequence type <c>sequence[T]</c> (ADR-0040).</summary>
    public bool IsSequence => SequenceKeyword != null;

    /// <summary>Gets the optional <c>async</c> modifier preceding a sequence type clause (ADR-0042), or <c>null</c>.</summary>
    public SyntaxToken AsyncModifier { get; }

    /// <summary>Gets a value indicating whether this clause denotes an async sequence type <c>async sequence[T]</c> (ADR-0042).</summary>
    public bool IsAsyncSequence => SequenceKeyword != null && AsyncModifier != null;

    /// <summary>Gets a value indicating whether this clause denotes an async function type <c>async func(...) R?</c> (ADR-0043).</summary>
    public bool IsAsyncFunction => FuncKeyword != null && AsyncModifier != null;

    /// <summary>Creates a pointer type clause <c>*T</c> (ADR-0039).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="starToken">The <c>*</c> prefix token.</param>
    /// <param name="pointeeType">The pointee type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>A pointer type clause.</returns>
    public static TypeClauseSyntax CreatePointer(
        SyntaxTree syntaxTree,
        SyntaxToken starToken,
        TypeClauseSyntax pointeeType,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, starToken, pointeeType, questionToken, isPointer: true);
    }

    /// <summary>Creates a sequence type clause <c>sequence[T]</c> (ADR-0040).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="sequenceKeyword">The <c>sequence</c> keyword.</param>
    /// <param name="openBracketToken">The <c>[</c> token.</param>
    /// <param name="elementType">The element type clause.</param>
    /// <param name="closeBracketToken">The <c>]</c> token.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>A sequence type clause.</returns>
    public static TypeClauseSyntax CreateSequence(
        SyntaxTree syntaxTree,
        SyntaxToken sequenceKeyword,
        SyntaxToken openBracketToken,
        TypeClauseSyntax elementType,
        SyntaxToken closeBracketToken,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier: null, sequenceKeyword, openBracketToken, elementType, closeBracketToken, questionToken, isSequence: true);
    }

    /// <summary>Creates an async sequence type clause <c>async sequence[T]</c> (ADR-0042).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="asyncModifier">The <c>async</c> modifier token.</param>
    /// <param name="sequenceKeyword">The <c>sequence</c> keyword.</param>
    /// <param name="openBracketToken">The <c>[</c> token.</param>
    /// <param name="elementType">The element type clause.</param>
    /// <param name="closeBracketToken">The <c>]</c> token.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>An async sequence type clause.</returns>
    public static TypeClauseSyntax CreateAsyncSequence(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken sequenceKeyword,
        SyntaxToken openBracketToken,
        TypeClauseSyntax elementType,
        SyntaxToken closeBracketToken,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier, sequenceKeyword, openBracketToken, elementType, closeBracketToken, questionToken, isSequence: true);
    }

    /// <summary>Creates an async function type clause <c>async func(P) R?</c> (ADR-0043).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="asyncModifier">The leading <c>async</c> modifier token.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="returnTypeClause">The optional return-type clause; <c>null</c> for void.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>An async function type clause.</returns>
    public static TypeClauseSyntax CreateAsyncFunction(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier, funcKeyword, openParenToken, functionParameterTypes, closeParenToken, returnTypeClause, questionToken, isFunction: true);
    }
}
