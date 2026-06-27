// <copyright file="TypeClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

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
        QualifierDotTokens = ImmutableArray<SyntaxToken>.Empty;
        QualifierIdentifierTokens = ImmutableArray<SyntaxToken>.Empty;
    }

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class supporting a dotted-qualifier chain for nested CLR types (<see cref="QualifierIdentifierTokens"/>), an optional type-argument list, and an optional nullable suffix (issue #526).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening bracket token of the array/slice prefix, or <c>null</c>.</param>
    /// <param name="lengthToken">The numeric length token, or <c>null</c>.</param>
    /// <param name="closeBracketToken">The closing bracket token of the array/slice prefix, or <c>null</c>.</param>
    /// <param name="identifier">The first (outermost) identifier of the dotted name.</param>
    /// <param name="qualifierDotTokens">The <c>.</c> tokens separating each qualifier segment (same count as <paramref name="qualifierIdentifierTokens"/>), or empty when the name is not dotted.</param>
    /// <param name="qualifierIdentifierTokens">The identifier tokens that follow each <c>.</c>, in source order, or empty when the name is not dotted.</param>
    /// <param name="typeArgumentOpenBracketToken">The opening bracket of the type-argument list, or <c>null</c>.</param>
    /// <param name="typeArguments">The type-argument list, or the default value.</param>
    /// <param name="typeArgumentCloseBracketToken">The closing bracket of the type-argument list, or <c>null</c>.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> marking the type nullable.</param>
    /// <param name="arrayQuestionToken">The optional <c>?</c> placed immediately after <c>]</c>, marking the whole array nullable (<c>[]?T</c>, issue #1212).</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        SyntaxToken identifier,
        ImmutableArray<SyntaxToken> qualifierDotTokens,
        ImmutableArray<SyntaxToken> qualifierIdentifierTokens,
        SyntaxToken typeArgumentOpenBracketToken,
        SeparatedSyntaxList<TypeClauseSyntax> typeArguments,
        SyntaxToken typeArgumentCloseBracketToken,
        SyntaxToken questionToken,
        SyntaxToken arrayQuestionToken = null)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthToken = lengthToken;
        CloseBracketToken = closeBracketToken;
        Identifier = identifier;
        QualifierDotTokens = qualifierDotTokens.IsDefault ? ImmutableArray<SyntaxToken>.Empty : qualifierDotTokens;
        QualifierIdentifierTokens = qualifierIdentifierTokens.IsDefault ? ImmutableArray<SyntaxToken>.Empty : qualifierIdentifierTokens;
        TypeArgumentOpenBracketToken = typeArgumentOpenBracketToken;
        TypeArguments = typeArguments;
        TypeArgumentCloseBracketToken = typeArgumentCloseBracketToken;
        QuestionToken = questionToken;
        ArrayQuestionToken = arrayQuestionToken;
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

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for a map type <c>map[K,V]?</c> (ADR-0104, supersedes the Phase 3.A.4 Go-flavored <c>map[K]V</c> shape).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="mapKeyword">The <c>map</c> keyword.</param>
    /// <param name="mapOpenBracketToken">The <c>[</c> introducing the key/value type pair.</param>
    /// <param name="mapKeyType">The key type clause.</param>
    /// <param name="mapCommaToken">The <c>,</c> separating the key type from the value type. May be <see langword="null"/> when the parser recovered from a legacy <c>map[K]V</c> shape (see GS0366).</param>
    /// <param name="mapValueType">The value type clause.</param>
    /// <param name="mapCloseBracketToken">The <c>]</c> closing the map type-argument list.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    public TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken mapKeyword,
        SyntaxToken mapOpenBracketToken,
        TypeClauseSyntax mapKeyType,
        SyntaxToken mapCommaToken,
        TypeClauseSyntax mapValueType,
        SyntaxToken mapCloseBracketToken,
        SyntaxToken questionToken)
        : base(syntaxTree)
    {
        MapKeyword = mapKeyword;
        MapOpenBracketToken = mapOpenBracketToken;
        MapKeyType = mapKeyType;
        MapCommaToken = mapCommaToken;
        MapValueType = mapValueType;
        MapCloseBracketToken = mapCloseBracketToken;
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

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for an array/slice whose element is itself a (non-identifier) nested type clause — e.g. a jagged array <c>[][]T</c>, an array of pointers <c>[]*T</c>, or an array of maps <c>[]map[K,V]</c> (issue #1046).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        TypeClauseSyntax arrayElementType,
        SyntaxToken questionToken,
        bool isNestedArray,
        SyntaxToken arrayQuestionToken = null)
        : base(syntaxTree)
    {
        OpenBracketToken = openBracketToken;
        LengthToken = lengthToken;
        CloseBracketToken = closeBracketToken;
        ArrayElementType = arrayElementType;
        QuestionToken = questionToken;
        ArrayQuestionToken = arrayQuestionToken;
        QualifierDotTokens = ImmutableArray<SyntaxToken>.Empty;
        QualifierIdentifierTokens = ImmutableArray<SyntaxToken>.Empty;
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
        : this(syntaxTree, asyncModifier, funcKeyword, openParenToken, functionParameterTypes, functionParameterEllipsisTokens: default, closeParenToken, returnTypeClause, questionToken, isFunction)
    {
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for an (optionally <c>async</c>-modified) function type clause (ADR-0043) with optional per-parameter variadic markers (ADR-0102 follow-up / issue #818).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        ImmutableArray<SyntaxToken> functionParameterEllipsisTokens,
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
        FunctionParameterEllipsisTokens = functionParameterEllipsisTokens.IsDefault ? ImmutableArray<SyntaxToken>.Empty : functionParameterEllipsisTokens;
        CloseParenToken = closeParenToken;
        ReturnTypeClause = returnTypeClause;
        QuestionToken = questionToken;
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for the arrow-form function type clause <c>(T1, T2, ...) -&gt; R?</c> (ADR-0075 / issue #715), optionally prefixed by the <c>async</c> modifier.</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken,
        bool isArrowFunction)
        : this(syntaxTree, asyncModifier, openParenToken, functionParameterTypes, functionParameterEllipsisTokens: default, closeParenToken, arrowToken, returnTypeClause, questionToken, isArrowFunction)
    {
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for the arrow-form function type clause <c>(T1, T2, ...) -&gt; R?</c> with optional per-parameter variadic markers <c>(T1, ...T2) -&gt; R</c> (ADR-0102 follow-up / issue #818).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        ImmutableArray<SyntaxToken> functionParameterEllipsisTokens,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken,
        bool isArrowFunction)
        : base(syntaxTree)
    {
        AsyncModifier = asyncModifier;
        OpenParenToken = openParenToken;
        FunctionParameterTypes = functionParameterTypes;
        FunctionParameterEllipsisTokens = functionParameterEllipsisTokens.IsDefault ? ImmutableArray<SyntaxToken>.Empty : functionParameterEllipsisTokens;
        CloseParenToken = closeParenToken;
        ArrowToken = arrowToken;
        ReturnTypeClause = returnTypeClause;
        QuestionToken = questionToken;
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for the raw function-pointer type clause <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c> (ADR-0095 / issue #761).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken unmanagedKeyword,
        SyntaxToken callingConventionOpenBracketToken,
        SyntaxToken callingConventionIdentifierToken,
        SyntaxToken callingConventionCloseBracketToken,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        bool isFunctionPointer)
        : base(syntaxTree)
    {
        UnmanagedKeyword = unmanagedKeyword;
        CallingConventionOpenBracketToken = callingConventionOpenBracketToken;
        CallingConventionIdentifierToken = callingConventionIdentifierToken;
        CallingConventionCloseBracketToken = callingConventionCloseBracketToken;
        OpenParenToken = openParenToken;
        FunctionParameterTypes = functionParameterTypes;
        CloseParenToken = closeParenToken;
        ArrowToken = arrowToken;
        ReturnTypeClause = returnTypeClause;
    }
#pragma warning restore SA1642

    /// <summary>Initializes a new instance of the <see cref="TypeClauseSyntax"/> class for the managed function-pointer type clause <c>*func(T1, T2, ...) R</c> (ADR-0122 §9 / issue #1035).</summary>
#pragma warning disable SA1642
    private TypeClauseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken managedFunctionPointerStarToken,
        SyntaxToken managedFunctionPointerFuncKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause)
        : base(syntaxTree)
    {
        ManagedFunctionPointerStarToken = managedFunctionPointerStarToken;
        ManagedFunctionPointerFuncKeyword = managedFunctionPointerFuncKeyword;
        OpenParenToken = openParenToken;
        FunctionParameterTypes = functionParameterTypes;
        CloseParenToken = closeParenToken;
        ReturnTypeClause = returnTypeClause;
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

    /// <summary>Gets the (element) type identifier. For a dotted-qualifier name (issue #526) this is the outermost segment (e.g. <c>Outer</c> in <c>Outer.Inner</c>).</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the <c>.</c> tokens separating each dotted-qualifier segment (issue #526). Empty when the name is a single identifier.</summary>
    public ImmutableArray<SyntaxToken> QualifierDotTokens { get; } = ImmutableArray<SyntaxToken>.Empty;

    /// <summary>Gets the qualifier identifier tokens that follow each <c>.</c> in source order (issue #526). Empty when the name is a single identifier.</summary>
    public ImmutableArray<SyntaxToken> QualifierIdentifierTokens { get; } = ImmutableArray<SyntaxToken>.Empty;

    /// <summary>Gets a value indicating whether this clause uses a dotted-qualifier name <c>Outer.Inner</c> (issue #526).</summary>
    public bool HasQualifier => !QualifierIdentifierTokens.IsDefaultOrEmpty;

    /// <summary>
    /// Gets the dotted source representation of the named portion of this type clause
    /// (without any array/slice prefix, pointer star, type arguments, or trailing <c>?</c>).
    /// For a simple identifier this is just the identifier's text; for a dotted-qualifier
    /// name (issue #526) the qualifier segments are joined with <c>.</c>.
    /// </summary>
    public string DottedName
    {
        get
        {
            if (Identifier == null)
            {
                return string.Empty;
            }

            if (QualifierIdentifierTokens.IsDefaultOrEmpty)
            {
                return Identifier.Text;
            }

            var builder = new System.Text.StringBuilder(Identifier.Text);
            foreach (var segment in QualifierIdentifierTokens)
            {
                builder.Append('.').Append(segment.Text);
            }

            return builder.ToString();
        }
    }

    /// <summary>Gets a value indicating whether this clause denotes an array-shaped type (fixed-length array or slice).</summary>
    public bool IsArray => OpenBracketToken != null;

    /// <summary>Gets the nested element type clause for a jagged/nested array (issue #1046), or <c>null</c> when the array element is a plain identifier element carried via <see cref="Identifier"/>/<see cref="QualifierIdentifierTokens"/>/<see cref="TypeArguments"/>.</summary>
    public TypeClauseSyntax ArrayElementType { get; }

    /// <summary>Gets a value indicating whether this array/slice clause stores its element as a nested type clause (jagged array, array of pointers, array of maps, …) rather than a flat identifier element (issue #1046).</summary>
    public bool HasNestedArrayElement => ArrayElementType != null;

    /// <summary>Gets a value indicating whether this clause denotes a variable-length slice type <c>[]T</c>.</summary>
    public bool IsSlice => OpenBracketToken != null && LengthToken == null;

    /// <summary>Gets the optional trailing <c>?</c> token marking the type as nullable (Phase 3.C.1 / ADR-0001).</summary>
    public SyntaxToken QuestionToken { get; }

    /// <summary>Gets a value indicating whether this clause denotes a nullable type <c>T?</c> (Phase 3.C.1).</summary>
    public bool IsNullable => QuestionToken != null;

    /// <summary>Gets the optional <c>?</c> token placed immediately after the array <c>]</c> (before the element type), marking the whole array reference nullable (<c>[]?T</c> / <c>[N]?T</c>, issue #1212).</summary>
    public SyntaxToken ArrayQuestionToken { get; }

    /// <summary>Gets a value indicating whether this array/slice clause is itself a nullable array reference (<c>[]?T</c>), spelled with a <c>?</c> right after <c>]</c> (issue #1212).</summary>
    public bool IsArrayNullable => ArrayQuestionToken != null;

    /// <summary>Gets the opening <c>(</c> token for tuple types, or <c>null</c>.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the closing <c>)</c> token for tuple types, or <c>null</c>.</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the comma-separated element-type clauses for a tuple type, or the default value.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> TupleElements { get; }

    /// <summary>Gets a value indicating whether this clause denotes a tuple type <c>(T1, T2, ...)</c> (Phase 4.5).</summary>
    public bool IsTuple => OpenParenToken != null && FuncKeyword == null && ArrowToken == null && UnmanagedKeyword == null && ManagedFunctionPointerFuncKeyword == null;

    /// <summary>Gets the <c>func</c> keyword for function-type clauses, or <c>null</c>.</summary>
    public SyntaxToken FuncKeyword { get; }

    /// <summary>Gets the <c>-&gt;</c> token for arrow-form function-type clauses (ADR-0075), or <c>null</c>.</summary>
    public SyntaxToken ArrowToken { get; }

    /// <summary>Gets the function parameter-type clauses, or the default value.</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> FunctionParameterTypes { get; }

    /// <summary>
    /// Gets the per-parameter <c>...</c> tokens for a variadic anonymous
    /// function-type clause (ADR-0102 follow-up / issue #818). The array is
    /// parallel to <see cref="FunctionParameterTypes"/> — entry <c>i</c> is
    /// the leading <c>...</c> token of the i-th parameter slot, or
    /// <see langword="null"/> when that slot is not variadic. The array is
    /// always non-default; it is <see cref="ImmutableArray{T}.Empty"/> when
    /// the clause is not a function-type clause or carries no variadic.
    /// </summary>
    public ImmutableArray<SyntaxToken> FunctionParameterEllipsisTokens { get; } = ImmutableArray<SyntaxToken>.Empty;

    /// <summary>Gets the function return-type clause, or <c>null</c> when the type is void / not a function type.</summary>
    public TypeClauseSyntax ReturnTypeClause { get; }

    /// <summary>Gets a value indicating whether this clause denotes a function type — either the legacy <c>func(...) R?</c> form (Phase 4.7), the canonical arrow form <c>(...) -&gt; R?</c> (ADR-0075), or the raw function-pointer form <c>unmanaged[CC] (...) -&gt; R</c> (ADR-0095).</summary>
    public bool IsFunction => FuncKeyword != null || ArrowToken != null;

    /// <summary>Gets a value indicating whether this clause uses the legacy <c>func(...) R?</c> spelling. Such clauses are accepted but emit a deprecation warning (GS0303 / ADR-0075).</summary>
    public bool IsLegacyFuncFunction => FuncKeyword != null;

    /// <summary>Gets a value indicating whether this clause uses the canonical arrow-form spelling <c>(...) -&gt; R?</c> (ADR-0075).</summary>
    public bool IsArrowFunction => ArrowToken != null && UnmanagedKeyword == null;

    /// <summary>Gets the <c>unmanaged</c> contextual keyword token introducing a raw function-pointer type clause (ADR-0095 / issue #761), or <c>null</c>.</summary>
    public SyntaxToken UnmanagedKeyword { get; }

    /// <summary>Gets the opening <c>[</c> of a raw function-pointer's calling-convention slot (ADR-0095), or <c>null</c>.</summary>
    public SyntaxToken CallingConventionOpenBracketToken { get; }

    /// <summary>Gets the calling-convention identifier inside the <c>[CC]</c> slot of a raw function-pointer type clause (e.g. <c>Cdecl</c>, <c>Stdcall</c>) (ADR-0095), or <c>null</c>.</summary>
    public SyntaxToken CallingConventionIdentifierToken { get; }

    /// <summary>Gets the closing <c>]</c> of a raw function-pointer's calling-convention slot (ADR-0095), or <c>null</c>.</summary>
    public SyntaxToken CallingConventionCloseBracketToken { get; }

    /// <summary>Gets a value indicating whether this clause denotes a raw function-pointer type <c>unmanaged[CC] (T) -&gt; R</c> (ADR-0095 / issue #761) or the managed form <c>*func(T) R</c> (ADR-0122 §9 / issue #1035).</summary>
    public bool IsFunctionPointer => UnmanagedKeyword != null || ManagedFunctionPointerFuncKeyword != null;

    /// <summary>Gets the <c>*</c> token introducing a managed function-pointer type clause <c>*func(T) R</c> (ADR-0122 §9 / issue #1035), or <c>null</c>.</summary>
    public SyntaxToken ManagedFunctionPointerStarToken { get; }

    /// <summary>Gets the <c>func</c> keyword of a managed function-pointer type clause <c>*func(T) R</c> (ADR-0122 §9 / issue #1035), or <c>null</c>.</summary>
    public SyntaxToken ManagedFunctionPointerFuncKeyword { get; }

    /// <summary>Gets a value indicating whether this clause denotes a managed function-pointer type <c>*func(T) R</c> (ADR-0122 §9 / issue #1035).</summary>
    public bool IsManagedFunctionPointer => ManagedFunctionPointerFuncKeyword != null;

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

    /// <summary>Gets the <c>[</c> opening the map key/value type-argument list (ADR-0104), or <c>null</c>.</summary>
    public SyntaxToken MapOpenBracketToken { get; }

    /// <summary>Gets the map key type clause, or <c>null</c>.</summary>
    public TypeClauseSyntax MapKeyType { get; }

    /// <summary>Gets the <c>,</c> separating the map key type from the map value type (ADR-0104), or <c>null</c> when absent (e.g. parser recovered from a legacy <c>map[K]V</c> shape under GS0366).</summary>
    public SyntaxToken MapCommaToken { get; }

    /// <summary>Gets the <c>]</c> closing the map key/value type-argument list (ADR-0104), or <c>null</c>.</summary>
    public SyntaxToken MapCloseBracketToken { get; }

    /// <summary>Gets the map value type clause, or <c>null</c>.</summary>
    public TypeClauseSyntax MapValueType { get; }

    /// <summary>Gets a value indicating whether this clause denotes a map type <c>map[K,V]</c> (ADR-0104).</summary>
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

    /// <summary>Gets a value indicating whether this clause denotes an async function type <c>async func(...) R?</c> (ADR-0043) or the canonical arrow form <c>async (...) -&gt; R?</c> (ADR-0075).</summary>
    public bool IsAsyncFunction => IsFunction && AsyncModifier != null;

    /// <summary>Returns a value indicating whether the parameter at <paramref name="index"/> carries a leading <c>...</c> marker (ADR-0102 follow-up / issue #818).</summary>
    /// <param name="index">The parameter slot index.</param>
    /// <returns><see langword="true"/> when the parameter is variadic.</returns>
    public bool IsParameterVariadic(int index)
    {
        return !FunctionParameterEllipsisTokens.IsDefaultOrEmpty
            && index >= 0
            && index < FunctionParameterEllipsisTokens.Length
            && FunctionParameterEllipsisTokens[index] != null;
    }

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

    /// <summary>Creates an array/slice type clause <c>[N]T</c>/<c>[]T</c> whose element <paramref name="elementType"/> is itself a nested type clause — enabling jagged arrays <c>[][]T</c>, arrays of pointers <c>[]*T</c>, arrays of maps <c>[]map[K,V]</c>, etc. (issue #1046).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBracketToken">The opening <c>[</c> token of the array/slice prefix.</param>
    /// <param name="lengthToken">The numeric length token for a fixed-length array, or <c>null</c> for a slice.</param>
    /// <param name="closeBracketToken">The closing <c>]</c> token of the array/slice prefix.</param>
    /// <param name="elementType">The nested element type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <param name="arrayQuestionToken">The optional <c>?</c> placed immediately after <c>]</c>, marking the whole array nullable (<c>[]?T</c>, issue #1212).</param>
    /// <returns>An array/slice type clause carrying a nested element type clause.</returns>
    public static TypeClauseSyntax CreateArray(
        SyntaxTree syntaxTree,
        SyntaxToken openBracketToken,
        SyntaxToken lengthToken,
        SyntaxToken closeBracketToken,
        TypeClauseSyntax elementType,
        SyntaxToken questionToken,
        SyntaxToken arrayQuestionToken = null)
    {
        return new TypeClauseSyntax(syntaxTree, openBracketToken, lengthToken, closeBracketToken, elementType, questionToken, isNestedArray: true, arrayQuestionToken);
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
        return new TypeClauseSyntax(syntaxTree, asyncModifier, funcKeyword, openParenToken, functionParameterTypes, functionParameterEllipsisTokens: default, closeParenToken, returnTypeClause, questionToken, isFunction: true);
    }

    /// <summary>Creates an async function type clause <c>async func(P, ...T) R?</c> with per-parameter variadic markers (ADR-0102 follow-up / issue #818).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="asyncModifier">The leading <c>async</c> modifier token.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="functionParameterEllipsisTokens">The per-slot <c>...</c> tokens (parallel to <paramref name="functionParameterTypes"/>); entries may be <see langword="null"/> for non-variadic slots.</param>
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
        ImmutableArray<SyntaxToken> functionParameterEllipsisTokens,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier, funcKeyword, openParenToken, functionParameterTypes, functionParameterEllipsisTokens, closeParenToken, returnTypeClause, questionToken, isFunction: true);
    }

    /// <summary>Creates a legacy <c>func(P, ...T) R?</c> function type clause with per-parameter variadic markers (ADR-0102 follow-up / issue #818).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="funcKeyword">The <c>func</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="functionParameterEllipsisTokens">The per-slot <c>...</c> tokens.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="returnTypeClause">The optional return-type clause; <c>null</c> for void.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>A legacy function type clause.</returns>
    public static TypeClauseSyntax CreateLegacyFunction(
        SyntaxTree syntaxTree,
        SyntaxToken funcKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        ImmutableArray<SyntaxToken> functionParameterEllipsisTokens,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier: null, funcKeyword, openParenToken, functionParameterTypes, functionParameterEllipsisTokens, closeParenToken, returnTypeClause, questionToken, isFunction: true);
    }

    /// <summary>Creates the canonical arrow-form function type clause <c>(T1, T2, ...) -&gt; R?</c> (ADR-0075).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="arrowToken">The <c>-&gt;</c> token.</param>
    /// <param name="returnTypeClause">The return-type clause (use a tuple type clause for multi-return shapes).</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>An arrow-form function type clause.</returns>
    public static TypeClauseSyntax CreateArrowFunction(
        SyntaxTree syntaxTree,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier: null, openParenToken, functionParameterTypes, functionParameterEllipsisTokens: default, closeParenToken, arrowToken, returnTypeClause, questionToken, isArrowFunction: true);
    }

    /// <summary>Creates the canonical arrow-form function type clause <c>(T1, T2, ...Tk) -&gt; R?</c> with per-parameter variadic markers (ADR-0102 follow-up / issue #818).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="functionParameterEllipsisTokens">Per-slot <c>...</c> tokens (parallel to <paramref name="functionParameterTypes"/>); entries may be <see langword="null"/>.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="arrowToken">The <c>-&gt;</c> token.</param>
    /// <param name="returnTypeClause">The return-type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>An arrow-form function type clause.</returns>
    public static TypeClauseSyntax CreateArrowFunction(
        SyntaxTree syntaxTree,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        ImmutableArray<SyntaxToken> functionParameterEllipsisTokens,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier: null, openParenToken, functionParameterTypes, functionParameterEllipsisTokens, closeParenToken, arrowToken, returnTypeClause, questionToken, isArrowFunction: true);
    }

    /// <summary>Creates the canonical async arrow-form function type clause <c>async (T1, T2, ...) -&gt; R?</c> (ADR-0075).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="asyncModifier">The leading <c>async</c> modifier token.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="arrowToken">The <c>-&gt;</c> token.</param>
    /// <param name="returnTypeClause">The return-type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>An async arrow-form function type clause.</returns>
    public static TypeClauseSyntax CreateAsyncArrowFunction(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier, openParenToken, functionParameterTypes, functionParameterEllipsisTokens: default, closeParenToken, arrowToken, returnTypeClause, questionToken, isArrowFunction: true);
    }

    /// <summary>Creates the canonical async arrow-form function type clause <c>async (T1, T2, ...Tk) -&gt; R?</c> with per-parameter variadic markers (ADR-0102 follow-up / issue #818).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="asyncModifier">The leading <c>async</c> modifier token.</param>
    /// <param name="openParenToken">The opening <c>(</c> token.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="functionParameterEllipsisTokens">Per-slot <c>...</c> tokens.</param>
    /// <param name="closeParenToken">The closing <c>)</c> token.</param>
    /// <param name="arrowToken">The <c>-&gt;</c> token.</param>
    /// <param name="returnTypeClause">The return-type clause.</param>
    /// <param name="questionToken">The optional trailing <c>?</c> nullability marker.</param>
    /// <returns>An async arrow-form function type clause.</returns>
    public static TypeClauseSyntax CreateAsyncArrowFunction(
        SyntaxTree syntaxTree,
        SyntaxToken asyncModifier,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        ImmutableArray<SyntaxToken> functionParameterEllipsisTokens,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause,
        SyntaxToken questionToken)
    {
        return new TypeClauseSyntax(syntaxTree, asyncModifier, openParenToken, functionParameterTypes, functionParameterEllipsisTokens, closeParenToken, arrowToken, returnTypeClause, questionToken, isArrowFunction: true);
    }

    /// <summary>Creates the raw function-pointer type clause <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c> (ADR-0095 / issue #761).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="unmanagedKeyword">The <c>unmanaged</c> contextual keyword token.</param>
    /// <param name="callingConventionOpenBracketToken">The opening <c>[</c> of the calling-convention slot.</param>
    /// <param name="callingConventionIdentifierToken">The calling-convention identifier (<c>Cdecl</c>, <c>Stdcall</c>, <c>Thiscall</c>, <c>Fastcall</c>).</param>
    /// <param name="callingConventionCloseBracketToken">The closing <c>]</c> of the calling-convention slot.</param>
    /// <param name="openParenToken">The opening <c>(</c> of the parameter-type list.</param>
    /// <param name="functionParameterTypes">The comma-separated parameter-type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c> of the parameter-type list.</param>
    /// <param name="arrowToken">The <c>-&gt;</c> token.</param>
    /// <param name="returnTypeClause">The return-type clause.</param>
    /// <returns>A raw function-pointer type clause.</returns>
    public static TypeClauseSyntax CreateFunctionPointer(
        SyntaxTree syntaxTree,
        SyntaxToken unmanagedKeyword,
        SyntaxToken callingConventionOpenBracketToken,
        SyntaxToken callingConventionIdentifierToken,
        SyntaxToken callingConventionCloseBracketToken,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        SyntaxToken arrowToken,
        TypeClauseSyntax returnTypeClause)
    {
        return new TypeClauseSyntax(
            syntaxTree,
            unmanagedKeyword,
            callingConventionOpenBracketToken,
            callingConventionIdentifierToken,
            callingConventionCloseBracketToken,
            openParenToken,
            functionParameterTypes,
            closeParenToken,
            arrowToken,
            returnTypeClause,
            isFunctionPointer: true);
    }

    /// <summary>
    /// Creates a managed function-pointer type clause <c>*func(T1, T2, ...) R</c>
    /// (ADR-0122 §9 / issue #1035).
    /// </summary>
    /// <param name="syntaxTree">The owning syntax tree.</param>
    /// <param name="managedFunctionPointerStarToken">The leading <c>*</c> token.</param>
    /// <param name="managedFunctionPointerFuncKeyword">The <c>func</c> keyword.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="functionParameterTypes">The parameter type clauses.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    /// <param name="returnTypeClause">The return type clause, or <c>null</c> for void.</param>
    /// <returns>A managed function-pointer <see cref="TypeClauseSyntax"/>.</returns>
    public static TypeClauseSyntax CreateManagedFunctionPointer(
        SyntaxTree syntaxTree,
        SyntaxToken managedFunctionPointerStarToken,
        SyntaxToken managedFunctionPointerFuncKeyword,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<TypeClauseSyntax> functionParameterTypes,
        SyntaxToken closeParenToken,
        TypeClauseSyntax returnTypeClause)
    {
        return new TypeClauseSyntax(
            syntaxTree,
            managedFunctionPointerStarToken,
            managedFunctionPointerFuncKeyword,
            openParenToken,
            functionParameterTypes,
            closeParenToken,
            returnTypeClause);
    }
}
