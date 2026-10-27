// <copyright file="TypeClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text

/// Represents a type clause in the language.
@SyntaxChildSourceOrder
partial class TypeClauseSyntax : SyntaxNode {
    /// Issue #1506: per-<em>outer</em>-segment type-argument lists, aligned to the segment
    /// sequence (index 0 = (cref:Identifier); index `i` = qualifier segment
    /// `i`). The last segment's arguments live in (cref:TypeArguments); these
    /// arrays hold the brackets/lists for every earlier segment, with `null` entries
    /// where a segment carries no type-argument list. Stored in plain arrays (rather than as
    /// reflected child properties) because the reflection-based child walk only enumerates a
    /// single (cref:SeparatedSyntaxList) per property; (cref:OuterSegmentTypeArgumentChildren)
    /// re-exposes them for full-fidelity traversal.
    private let outerSegmentTypeArgumentOpenBracketTokens ImmutableArray[SyntaxToken?] = ImmutableArray[
        SyntaxToken?
    ].Empty

    private let outerSegmentTypeArgumentLists ImmutableArray[SeparatedSyntaxList[TypeClauseSyntax]?] = ImmutableArray[
        SeparatedSyntaxList[TypeClauseSyntax]?
    ].Empty
    private let outerSegmentTypeArgumentCloseBracketTokens ImmutableArray[SyntaxToken?] = ImmutableArray[
        SyntaxToken?
    ].Empty

    // ADR-0095 v2 / issue #3611: the calling-convention slot tokens after the
    // first identifier (alternating `,` separators and identifiers).
    private let callingConventionRestTokens ImmutableArray[SyntaxToken] = ImmutableArray[SyntaxToken].Empty

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a simple type.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The type clause identifier.
    convenience init(syntaxTree SyntaxTree, identifier SyntaxToken) {
        init(syntaxTree, nil, nil, nil, identifier, nil)
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class, optionally
    /// wrapping the named element type in an array shape `[N]T`.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token, or `null` for a non-array type.
    /// @param lengthToken The numeric length token, or `null` for a non-array type.
    /// @param closeBracketToken The closing bracket token, or `null` for a non-array type.
    /// @param identifier The element type identifier.
    convenience init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken?,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken?,
        identifier SyntaxToken
    ) {
        init(syntaxTree, openBracketToken, lengthToken, closeBracketToken, identifier, nil)
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class with an optional nullable suffix
    /// (Phase 3.C.1).
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token, or `null` for a non-array type.
    /// @param lengthToken The numeric length token, or `null` for a non-array type.
    /// @param closeBracketToken The closing bracket token, or `null` for a non-array type.
    /// @param identifier The (element) type identifier.
    /// @param questionToken The optional trailing `?` marking the type nullable (Phase 3.C.1).
    convenience init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken?,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken?,
        identifier SyntaxToken,
        questionToken SyntaxToken?
    ) {
        init(
            syntaxTree,
            openBracketToken,
            lengthToken,
            closeBracketToken,
            identifier,
            nil,
            default(SeparatedSyntaxList[TypeClauseSyntax]?),
            nil,
            questionToken
        )
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class supporting an optional type-argument
    /// list `Foo[T1, T2]` in type position (Phase 4.3c / ADR-0020).
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token of the array/slice prefix, or `null`.
    /// @param lengthToken The numeric length token, or `null`.
    /// @param closeBracketToken The closing bracket token of the array/slice prefix, or `null`.
    /// @param identifier The (element) type identifier.
    /// @param typeArgumentOpenBracketToken The opening bracket of the type-argument list, or `null`.
    /// @param typeArguments The type-argument list, or the default value.
    /// @param typeArgumentCloseBracketToken The closing bracket of the type-argument list, or `null`.
    /// @param questionToken The optional trailing `?` marking the type nullable.
    convenience init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken?,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken?,
        identifier SyntaxToken,
        typeArgumentOpenBracketToken SyntaxToken?,
        typeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
        typeArgumentCloseBracketToken SyntaxToken?,
        questionToken SyntaxToken?
    ) {
        init(
            syntaxTree,
            openBracketToken,
            lengthToken,
            closeBracketToken,
            identifier,
            typeArgumentOpenBracketToken,
            typeArguments,
            typeArgumentCloseBracketToken,
            questionToken,
            ImmutableArray[SyntaxToken].Empty
        )
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class.
    /// @param syntaxTree Parent syntax tree.
    /// @param openBracketToken Optional opening bracket.
    /// @param lengthToken Optional fixed length.
    /// @param closeBracketToken Optional closing bracket.
    /// @param identifier Type identifier.
    /// @param typeArgumentOpenBracketToken Optional generic opening bracket.
    /// @param typeArguments Optional type arguments.
    /// @param typeArgumentCloseBracketToken Optional generic closing bracket.
    /// @param questionToken Optional nullable marker.
    /// @param arrayCommaTokens Rectangular rank commas.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken?,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken?,
        identifier SyntaxToken,
        typeArgumentOpenBracketToken SyntaxToken?,
        typeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
        typeArgumentCloseBracketToken SyntaxToken?,
        questionToken SyntaxToken?,
        arrayCommaTokens ImmutableArray[SyntaxToken]
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        OpenBracketToken = openBracketToken
        LengthToken = lengthToken
        ArrayCommaTokens = if arrayCommaTokens.IsDefault {
            ImmutableArray[SyntaxToken].Empty
        } else {
            arrayCommaTokens
        }
        CloseBracketToken = closeBracketToken
        Identifier = identifier
        TypeArgumentOpenBracketToken = typeArgumentOpenBracketToken
        TypeArguments = typeArguments
        TypeArgumentCloseBracketToken = typeArgumentCloseBracketToken
        QuestionToken = questionToken
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class supporting a dotted-qualifier chain
    /// for nested CLR types ((cref:QualifierIdentifierTokens)), an optional type-argument list, and an
    /// optional nullable suffix (issue #526).
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token of the array/slice prefix, or `null`.
    /// @param lengthToken The numeric length token, or `null`.
    /// @param closeBracketToken The closing bracket token of the array/slice prefix, or `null`.
    /// @param identifier The first (outermost) identifier of the dotted name.
    /// @param qualifierDotTokens The `.` tokens separating each qualifier segment (same count as
    /// [`qualifierIdentifierTokens`](paramref)), or empty when the name is not dotted.
    /// @param qualifierIdentifierTokens The identifier tokens that follow each `.`, in source order, or
    /// empty when the name is not dotted.
    /// @param typeArgumentOpenBracketToken The opening bracket of the type-argument list, or `null`.
    /// @param typeArguments The type-argument list, or the default value.
    /// @param typeArgumentCloseBracketToken The closing bracket of the type-argument list, or `null`.
    /// @param questionToken The optional trailing `?` marking the type nullable.
    /// @param arrayQuestionToken The optional `?` placed immediately after `]`, marking the whole array
    /// nullable (`[]?T`, issue #1212).
    /// @param outerSegmentTypeArgumentOpenBracketTokens Issue #1506: the opening `[` of the type-argument
    /// list carried by each <em>outer</em> (non-last) segment, aligned to the segment sequence (index 0 =
    /// (cref:Identifier); index `i` = qualifier segment `i`). A `null` entry means that segment carries no
    /// type-argument list. Empty when no outer segment is generic.
    /// @param outerSegmentTypeArgumentLists Issue #1506: the type-argument list carried by each outer
    /// (non-last) segment, aligned identically to [`outerSegmentTypeArgumentOpenBracketTokens`](paramref).
    /// A `null` entry means that segment carries no type-argument list.
    /// @param outerSegmentTypeArgumentCloseBracketTokens Issue #1506: the closing `]` of the type-argument
    /// list carried by each outer (non-last) segment, aligned identically to
    /// [`outerSegmentTypeArgumentOpenBracketTokens`](paramref).
    /// @param arrayCommaTokens Commas forming a rectangular-array rank specifier.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken?,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken?,
        identifier SyntaxToken,
        qualifierDotTokens ImmutableArray[SyntaxToken],
        qualifierIdentifierTokens ImmutableArray[SyntaxToken],
        typeArgumentOpenBracketToken SyntaxToken?,
        typeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
        typeArgumentCloseBracketToken SyntaxToken?,
        questionToken SyntaxToken?,
        arrayQuestionToken SyntaxToken? = nil,
        outerSegmentTypeArgumentOpenBracketTokens ImmutableArray[SyntaxToken?] = default(ImmutableArray[SyntaxToken?]),
        outerSegmentTypeArgumentLists ImmutableArray[SeparatedSyntaxList[TypeClauseSyntax]?] = default(
            ImmutableArray[SeparatedSyntaxList[TypeClauseSyntax]?]
        ),
        outerSegmentTypeArgumentCloseBracketTokens ImmutableArray[SyntaxToken?] = default(ImmutableArray[SyntaxToken?]),
        arrayCommaTokens ImmutableArray[SyntaxToken] = default(ImmutableArray[SyntaxToken])
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        OpenBracketToken = openBracketToken
        LengthToken = lengthToken
        ArrayCommaTokens = if arrayCommaTokens.IsDefault {
            ImmutableArray[SyntaxToken].Empty
        } else {
            arrayCommaTokens
        }
        CloseBracketToken = closeBracketToken
        Identifier = identifier
        QualifierDotTokens = if qualifierDotTokens.IsDefault {
            ImmutableArray[SyntaxToken].Empty
        } else {
            qualifierDotTokens
        }
        QualifierIdentifierTokens = if qualifierIdentifierTokens.IsDefault {
            ImmutableArray[SyntaxToken].Empty
        } else {
            qualifierIdentifierTokens
        }
        TypeArgumentOpenBracketToken = typeArgumentOpenBracketToken
        TypeArguments = typeArguments
        TypeArgumentCloseBracketToken = typeArgumentCloseBracketToken
        QuestionToken = questionToken
        ArrayQuestionToken = arrayQuestionToken
        this.outerSegmentTypeArgumentOpenBracketTokens = if outerSegmentTypeArgumentOpenBracketTokens.IsDefault {
            ImmutableArray[SyntaxToken?].Empty
        } else {
            outerSegmentTypeArgumentOpenBracketTokens
        }
        this.outerSegmentTypeArgumentLists = if outerSegmentTypeArgumentLists.IsDefault {
            ImmutableArray[SeparatedSyntaxList[TypeClauseSyntax]?].Empty
        } else {
            outerSegmentTypeArgumentLists
        }
        this.outerSegmentTypeArgumentCloseBracketTokens = if outerSegmentTypeArgumentCloseBracketTokens.IsDefault {
            ImmutableArray[SyntaxToken?].Empty
        } else {
            outerSegmentTypeArgumentCloseBracketTokens
        }
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a tuple type `(T1, T2, ...)`
    /// (Phase 4.5).
    /// @param syntaxTree The parent syntax tree.
    /// @param openParenToken The opening `(` token.
    /// @param tupleElements The comma-separated element type clauses.
    /// @param closeParenToken The closing `)` token.
    /// @param questionToken The optional trailing `?` nullability marker.
    init(
        syntaxTree SyntaxTree,
        openParenToken SyntaxToken?,
        tupleElements SeparatedSyntaxList[TypeClauseSyntax],
        closeParenToken SyntaxToken?,
        questionToken SyntaxToken?
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        OpenParenToken = openParenToken
        TupleElements = tupleElements
        CloseParenToken = closeParenToken
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a map type `map[K,V]?`
    /// (ADR-0104, supersedes the Phase 3.A.4 Go-flavored `map[K]V` shape).
    /// @param syntaxTree The parent syntax tree.
    /// @param mapKeyword The `map` keyword.
    /// @param mapOpenBracketToken The `[` introducing the key/value type pair.
    /// @param mapKeyType The key type clause.
    /// @param mapCommaToken The `,` separating the key type from the value type. May be `null` when the
    /// parser recovered from a legacy `map[K]V` shape (see GS0366).
    /// @param mapValueType The value type clause.
    /// @param mapCloseBracketToken The `]` closing the map type-argument list.
    /// @param questionToken The optional trailing `?` nullability marker.
    init(
        syntaxTree SyntaxTree,
        mapKeyword SyntaxToken,
        mapOpenBracketToken SyntaxToken,
        mapKeyType TypeClauseSyntax,
        mapCommaToken SyntaxToken?,
        mapValueType TypeClauseSyntax,
        mapCloseBracketToken SyntaxToken,
        questionToken SyntaxToken?
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        MapKeyword = mapKeyword
        MapOpenBracketToken = mapOpenBracketToken
        MapKeyType = mapKeyType
        MapCommaToken = mapCommaToken
        MapValueType = mapValueType
        MapCloseBracketToken = mapCloseBracketToken
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a function type
    /// `func(T1, T2, ...) R?` (Phase 4.7), optionally prefixed by the `async` modifier per ADR-0043.
    /// @param syntaxTree The parent syntax tree.
    /// @param funcKeyword The `func` keyword.
    /// @param openParenToken The opening `(` token.
    /// @param functionParameterTypes The comma-separated parameter-type clauses.
    /// @param closeParenToken The closing `)` token.
    /// @param returnTypeClause The optional return-type clause; `null` for void.
    /// @param questionToken The optional trailing `?` nullability marker.
    convenience init(
        syntaxTree SyntaxTree,
        funcKeyword SyntaxToken,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        closeParenToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?,
        questionToken SyntaxToken?
    ) {
        init(
            syntaxTree,
            nil,
            funcKeyword,
            openParenToken,
            functionParameterTypes,
            closeParenToken,
            returnTypeClause,
            questionToken,
            true
        )
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a channel type `chan[T]?`,
    /// `in chan[T]?`, or `out chan[T]?` (ADR-0174 D2).
    /// @param syntaxTree The parent syntax tree.
    /// @param chanDirectionToken The optional `in`/`out` direction token.
    /// @param chanKeyword The `chan` keyword.
    /// @param chanOpenBracketToken The `[` opening the element type; `null` when the parser recovered from
    /// the legacy `chan T` shape (see GS0567).
    /// @param chanElementType The element type clause.
    /// @param chanCloseBracketToken The `]` closing the element type; `null` for the legacy shape.
    /// @param questionToken The optional trailing `?` marking the whole channel nullable.
    init(
        syntaxTree SyntaxTree,
        chanDirectionToken SyntaxToken?,
        chanKeyword SyntaxToken,
        chanOpenBracketToken SyntaxToken?,
        chanElementType TypeClauseSyntax,
        chanCloseBracketToken SyntaxToken?,
        questionToken SyntaxToken?
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        ChanDirectionToken = chanDirectionToken
        ChanKeyword = chanKeyword
        ChanOpenBracketToken = chanOpenBracketToken
        ChanElementType = chanElementType
        ChanCloseBracketToken = chanCloseBracketToken
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a pointer type (ADR-0039).
    private init(
        syntaxTree SyntaxTree,
        starToken SyntaxToken,
        pointeeType TypeClauseSyntax,
        questionToken SyntaxToken?,
        isPointer bool
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        PointerStarToken = starToken
        PointerPointeeType = pointeeType
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for an array/slice whose element is
    /// itself a (non-identifier) nested type clause — e.g. a jagged array `[][]T`, an array of pointers
    /// `[]*T`, or an array of maps `[]map[K,V]` (issue #1046).
    private init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken?,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken?,
        arrayElementType TypeClauseSyntax,
        questionToken SyntaxToken?,
        isNestedArray bool,
        arrayQuestionToken SyntaxToken? = nil,
        arrayCommaTokens ImmutableArray[SyntaxToken] = default(ImmutableArray[SyntaxToken])
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        OpenBracketToken = openBracketToken
        LengthToken = lengthToken
        ArrayCommaTokens = if arrayCommaTokens.IsDefault {
            ImmutableArray[SyntaxToken].Empty
        } else {
            arrayCommaTokens
        }
        CloseBracketToken = closeBracketToken
        ArrayElementType = arrayElementType
        QuestionToken = questionToken
        ArrayQuestionToken = arrayQuestionToken
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for a sequence type (ADR-0040) —
    /// optionally prefixed by the `async` modifier per ADR-0042.
    private init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        sequenceKeyword SyntaxToken,
        openBracketToken SyntaxToken?,
        elementType TypeClauseSyntax,
        closeBracketToken SyntaxToken?,
        questionToken SyntaxToken?,
        isSequence bool
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        AsyncModifier = asyncModifier
        SequenceKeyword = sequenceKeyword
        SequenceOpenBracketToken = openBracketToken
        SequenceElementType = elementType
        SequenceCloseBracketToken = closeBracketToken
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for an (optionally `async`-modified)
    /// function type clause (ADR-0043).
    private convenience init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        funcKeyword SyntaxToken,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        closeParenToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?,
        questionToken SyntaxToken?,
        isFunction bool
    ) {
        init(
            syntaxTree,
            asyncModifier,
            funcKeyword,
            openParenToken,
            functionParameterTypes,
            default(ImmutableArray[SyntaxToken?]),
            closeParenToken,
            returnTypeClause,
            questionToken,
            isFunction
        )
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for an (optionally `async`-modified)
    /// function type clause (ADR-0043) with optional per-parameter variadic markers (ADR-0102 follow-up /
    /// issue #818).
    private init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        funcKeyword SyntaxToken,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        functionParameterEllipsisTokens ImmutableArray[SyntaxToken?],
        closeParenToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?,
        questionToken SyntaxToken?,
        isFunction bool
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        AsyncModifier = asyncModifier
        FuncKeyword = funcKeyword
        OpenParenToken = openParenToken
        FunctionParameterTypes = functionParameterTypes
        FunctionParameterEllipsisTokens = if functionParameterEllipsisTokens.IsDefault {
            ImmutableArray[SyntaxToken?].Empty
        } else {
            functionParameterEllipsisTokens
        }
        CloseParenToken = closeParenToken
        ReturnTypeClause = returnTypeClause
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for the arrow-form function type
    /// clause `(T1, T2, ...) -> R?` (ADR-0075 / issue #715), optionally prefixed by the `async` modifier.
    private convenience init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        closeParenToken SyntaxToken?,
        arrowToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?,
        questionToken SyntaxToken?,
        isArrowFunction bool
    ) {
        init(
            syntaxTree,
            asyncModifier,
            openParenToken,
            functionParameterTypes,
            default(ImmutableArray[SyntaxToken?]),
            closeParenToken,
            arrowToken,
            returnTypeClause,
            questionToken,
            isArrowFunction
        )
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for the arrow-form function type
    /// clause `(T1, T2, ...) -> R?` with optional per-parameter variadic markers `(T1, ...T2) -> R`
    /// (ADR-0102 follow-up / issue #818).
    private init(
        syntaxTree SyntaxTree,
        asyncModifier SyntaxToken?,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        functionParameterEllipsisTokens ImmutableArray[SyntaxToken?],
        closeParenToken SyntaxToken?,
        arrowToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?,
        questionToken SyntaxToken?,
        isArrowFunction bool
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        AsyncModifier = asyncModifier
        OpenParenToken = openParenToken
        FunctionParameterTypes = functionParameterTypes
        FunctionParameterEllipsisTokens = if functionParameterEllipsisTokens.IsDefault {
            ImmutableArray[SyntaxToken?].Empty
        } else {
            functionParameterEllipsisTokens
        }
        CloseParenToken = closeParenToken
        ArrowToken = arrowToken
        ReturnTypeClause = returnTypeClause
        QuestionToken = questionToken
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for the raw function-pointer type
    /// clause `unmanaged[CC] (T1, T2, ...) -> R` (ADR-0095 / issue #761).
    private init(
        syntaxTree SyntaxTree,
        unmanagedKeyword SyntaxToken,
        callingConventionOpenBracketToken SyntaxToken?,
        callingConventionIdentifierToken SyntaxToken?,
        callingConventionRestTokens ImmutableArray[SyntaxToken],
        callingConventionCloseBracketToken SyntaxToken?,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        closeParenToken SyntaxToken?,
        arrowToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?,
        isFunctionPointer bool
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        UnmanagedKeyword = unmanagedKeyword
        CallingConventionOpenBracketToken = callingConventionOpenBracketToken
        CallingConventionIdentifierToken = callingConventionIdentifierToken
        this.callingConventionRestTokens = if callingConventionRestTokens.IsDefault {
            ImmutableArray[SyntaxToken].Empty
        } else {
            callingConventionRestTokens
        }
        CallingConventionCloseBracketToken = callingConventionCloseBracketToken
        OpenParenToken = openParenToken
        FunctionParameterTypes = functionParameterTypes
        CloseParenToken = closeParenToken
        ArrowToken = arrowToken
        ReturnTypeClause = returnTypeClause
    }

    /// Initializes a new instance of the (cref:TypeClauseSyntax) class for the managed function-pointer
    /// type clause `*func(T1, T2, ...) R` (ADR-0122 §9 / issue #1035).
    private init(
        syntaxTree SyntaxTree,
        managedFunctionPointerStarToken SyntaxToken,
        managedFunctionPointerFuncKeyword SyntaxToken,
        openParenToken SyntaxToken?,
        functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
        closeParenToken SyntaxToken?,
        returnTypeClause TypeClauseSyntax?
    ) : base(syntaxTree) {
        ArrayCommaTokens = ImmutableArray[SyntaxToken].Empty
        QualifierDotTokens = ImmutableArray[SyntaxToken].Empty
        QualifierIdentifierTokens = ImmutableArray[SyntaxToken].Empty
        FunctionParameterEllipsisTokens = ImmutableArray[SyntaxToken?].Empty
        ManagedFunctionPointerStarToken = managedFunctionPointerStarToken
        ManagedFunctionPointerFuncKeyword = managedFunctionPointerFuncKeyword
        OpenParenToken = openParenToken
        FunctionParameterTypes = functionParameterTypes
        CloseParenToken = closeParenToken
        ReturnTypeClause = returnTypeClause
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeClause

    /// Gets the contextual readonly modifier of a native slice type.
    prop ReadOnlySliceModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the contextual readonly modifier of a CLR span alias.
    prop ReadOnlySpanModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the contextual readonly modifier of a managed-reference type.
    prop ReadOnlyManagedModifier SyntaxToken? {
        get;
        internal set;
    }

    /// Gets the opening bracket token, or `null` for non-array types.
    prop OpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the numeric length token, or `null` for non-array types.
    prop LengthToken SyntaxToken? {
        get;
    }

    /// Gets commas in a rectangular-array rank specifier.
    prop ArrayCommaTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets rectangular-array rank, or zero for other type clauses.
    prop RectangularRank int32 -> if ArrayCommaTokens.IsDefaultOrEmpty {
        0
    } else {
        ArrayCommaTokens.Length + 1
    }

    /// Gets the closing bracket token, or `null` for non-array types.
    prop CloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets the (element) type identifier. For a dotted-qualifier name (issue #526) this is the outermost
    /// segment (e.g. `Outer` in `Outer.Inner`).
    prop Identifier SyntaxToken? {
        get;
    }

    /// Gets the `.` tokens separating each dotted-qualifier segment (issue #526). Empty when the name is a
    /// single identifier.
    prop QualifierDotTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the qualifier identifier tokens that follow each `.` in source order (issue #526). Empty when
    /// the name is a single identifier.
    prop QualifierIdentifierTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the final identifier of a named type clause, or `null` for a composite type.
    @SyntaxChildIgnore
    prop NameIdentifier SyntaxToken? -> if QualifierIdentifierTokens.IsDefaultOrEmpty {
        Identifier
    } else {
        QualifierIdentifierTokens[^1]
    }

    /// Gets a value indicating whether this clause uses a dotted-qualifier name `Outer.Inner` (issue #526).
    prop HasQualifier bool -> !QualifierIdentifierTokens.IsDefaultOrEmpty

    /// Gets the dotted source representation of the named portion of this type clause
    /// (without any array/slice prefix, pointer star, type arguments, or trailing `?`).
    /// For a simple identifier this is just the identifier's text; for a dotted-qualifier
    /// name (issue #526) the qualifier segments are joined with `.`.
    prop DottedName string {
        get {
            if Identifier == nil {
                return string.Empty
            }
            let identifier = Identifier!!
            if QualifierIdentifierTokens.IsDefaultOrEmpty {
                return identifier.Text
            }
            let builder = StringBuilder(identifier.Text)
            for segment in QualifierIdentifierTokens {
                builder.Append('.').Append(segment.Text)
            }
            return builder.ToString()
        }
    }

    /// Gets a value indicating whether this clause denotes an array-shaped type (fixed-length array or
    /// slice).
    prop IsArray bool -> OpenBracketToken != nil

    /// Gets the nested element type clause for a jagged/nested array (issue #1046), or `null` when the
    /// array element is a plain identifier element carried via
    /// (cref:Identifier)/(cref:QualifierIdentifierTokens)/(cref:TypeArguments).
    prop ArrayElementType TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this array/slice clause stores its element as a nested type clause
    /// (jagged array, array of pointers, array of maps, …) rather than a flat identifier element (issue
    /// #1046).
    prop HasNestedArrayElement bool -> ArrayElementType != nil

    /// Gets a value indicating whether this clause denotes a variable-length slice type `[]T`.
    prop IsSlice bool -> OpenBracketToken != nil && LengthToken == nil && ArrayCommaTokens.IsDefaultOrEmpty

    /// Gets the optional trailing `?` token marking the type as nullable (Phase 3.C.1 / ADR-0001).
    prop QuestionToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a nullable type `T?` (Phase 3.C.1).
    prop IsNullable bool -> QuestionToken != nil

    /// Gets the optional `?` token placed immediately after the array `]` (before the element type),
    /// marking the whole array reference nullable (`[]?T` / `[N]?T`, issue #1212).
    prop ArrayQuestionToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this array/slice clause is itself a nullable array reference
    /// (`[]?T`), spelled with a `?` right after `]` (issue #1212).
    prop IsArrayNullable bool -> ArrayQuestionToken != nil

    /// Gets the `?` that followed the closing `)` of a parenthesized
    /// type clause (issue #3315 / ADR-0159 addendum). Grouping parens are
    /// otherwise transparent — `(T)` parses to `T`'s own clause — but
    /// their trailing `?` marks the WHOLE inner type nullable, giving the
    /// composite types whose own trailing `?` binds tighter an explicit
    /// whole-type-nullable spelling: `(chan int32)?` is a nullable channel
    /// of `int32`, whereas `chan int32?` is a channel of nullable
    /// elements. Set by the parser via
    /// (cref:SetParenthesizedQuestionToken) immediately after the inner
    /// clause is built (the sanctioned parser-time mutation pattern, see
    /// (cref:SyntaxNode.InvalidateCachedSpan)).
    prop ParenthesizedQuestionToken SyntaxToken? {
        get;
        private set;
    }

    /// Gets a value indicating whether this clause carries a parenthesized whole-type `?` — `(chan T)?`,
    /// `([]T)?`, … (issue #3315).
    prop IsParenthesizedNullable bool -> ParenthesizedQuestionToken != nil

    /// Gets the element name declared before this clause when it is
    /// a named element of a tuple type — `(line int32, column int32)` —
    /// or `null`. Set by the parser via
    /// (cref:SetTupleElementNameToken) immediately after the element
    /// clause is built (the sanctioned parser-time mutation pattern, see
    /// (cref:SetParenthesizedQuestionToken)).
    prop TupleElementNameToken SyntaxToken? {
        get;
        private set;
    }

    /// Gets the opening `(` token for tuple types, or `null`.
    prop OpenParenToken SyntaxToken? {
        get;
    }

    /// Gets the closing `)` token for tuple types, or `null`.
    prop CloseParenToken SyntaxToken? {
        get;
    }

    /// Gets the comma-separated element-type clauses for a tuple type, or the default value.
    prop TupleElements SeparatedSyntaxList[TypeClauseSyntax]? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a tuple type `(T1, T2, ...)` (Phase 4.5).
    prop IsTuple bool -> OpenParenToken != nil &&
        FuncKeyword == nil &&
        ArrowToken == nil &&
        UnmanagedKeyword == nil &&
        ManagedFunctionPointerFuncKeyword == nil

    /// Gets the `func` keyword for function-type clauses, or `null`.
    prop FuncKeyword SyntaxToken? {
        get;
    }

    /// Gets the `->` token for arrow-form function-type clauses (ADR-0075), or `null`.
    prop ArrowToken SyntaxToken? {
        get;
    }

    /// Gets the function parameter-type clauses, or the default value.
    prop FunctionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]? {
        get;
    }

    /// Gets the per-parameter `...` tokens for a variadic anonymous
    /// function-type clause (ADR-0102 follow-up / issue #818). The array is
    /// parallel to (cref:FunctionParameterTypes) — entry `i` is
    /// the leading `...` token of the i-th parameter slot, or
    /// `null` when that slot is not variadic. The array is
    /// always non-default; it is (cref:ImmutableArray{T}.Empty) when
    /// the clause is not a function-type clause or carries no variadic.
    prop FunctionParameterEllipsisTokens ImmutableArray[SyntaxToken?] {
        get;
    }

    /// Gets the per-parameter `ref`/`out`/`in` contextual
    /// modifier tokens of an arrow-form function-type clause (issue #3501
    /// A2: `(ref int32) -> void`). The array is parallel to
    /// (cref:FunctionParameterTypes) — entry `i` is the leading
    /// modifier token of the i-th parameter slot, or `null`
    /// when that slot is a plain by-value parameter. Always non-default;
    /// (cref:ImmutableArray{T}.Empty) when the clause is not a
    /// function-type clause or carries no ref-kind modifiers. Assigned by
    /// the parser after construction.
    private var _functionParameterRefKindTokens ImmutableArray[SyntaxToken?] = ImmutableArray[SyntaxToken?].Empty

    prop FunctionParameterRefKindTokens ImmutableArray[SyntaxToken?] {
        get {
            return _functionParameterRefKindTokens
        }
        internal set {
            _functionParameterRefKindTokens = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the function return-type clause, or `null` when the type is void / not a function type.
    prop ReturnTypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a function type — either the legacy
    /// `func(...) R?` form (Phase 4.7), the canonical arrow form `(...) -> R?` (ADR-0075), or the raw
    /// function-pointer form `unmanaged[CC] (...) -> R` (ADR-0095).
    prop IsFunction bool -> FuncKeyword != nil || ArrowToken != nil

    /// Gets a value indicating whether this clause uses the legacy `func(...) R?` spelling. Such clauses
    /// are accepted but emit a deprecation warning (GS0303 / ADR-0075).
    prop IsLegacyFuncFunction bool -> FuncKeyword != nil

    /// Gets a value indicating whether this clause uses the canonical arrow-form spelling `(...) -> R?`
    /// (ADR-0075).
    prop IsArrowFunction bool -> ArrowToken != nil && UnmanagedKeyword == nil

    /// Gets the `unmanaged` contextual keyword token introducing a raw function-pointer type clause
    /// (ADR-0095 / issue #761), or `null`.
    prop UnmanagedKeyword SyntaxToken? {
        get;
    }

    /// Gets the opening `[` of a raw function-pointer's calling-convention slot (ADR-0095), or `null`.
    prop CallingConventionOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the first calling-convention identifier inside the `[CC]` slot of a raw function-pointer type
    /// clause (e.g. `Cdecl`, `Stdcall`) (ADR-0095), or `null` for the bare platform-default form
    /// `unmanaged (T) -> R` (ADR-0095 v2 / issue #3611).
    prop CallingConventionIdentifierToken SyntaxToken? {
        get;
    }

    /// Gets the tokens of the calling-convention slot after the first
    /// identifier — alternating `,` separators and convention
    /// identifiers, in source order (ADR-0095 v2 / issue #3611, e.g. the
    /// `, SuppressGCTransition` tail of
    /// `unmanaged[Cdecl, SuppressGCTransition] (T) -> R`). Empty for
    /// a single-convention or bare slot.
    prop CallingConventionRestTokens IEnumerable[SyntaxNode] -> if callingConventionRestTokens.IsDefaultOrEmpty {
        Enumerable.Empty[SyntaxNode]()
    } else {
        callingConventionRestTokens
    }

    /// Gets the closing `]` of a raw function-pointer's calling-convention slot (ADR-0095), or `null`.
    prop CallingConventionCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a raw function-pointer type
    /// `unmanaged[CC] (T) -> R` (ADR-0095 / issue #761) or the managed form `*func(T) R` (ADR-0122 §9 /
    /// issue #1035).
    prop IsFunctionPointer bool -> UnmanagedKeyword != nil || ManagedFunctionPointerFuncKeyword != nil

    /// Gets the `*` token introducing a managed function-pointer type clause `*func(T) R` (ADR-0122 §9 /
    /// issue #1035), or `null`.
    prop ManagedFunctionPointerStarToken SyntaxToken? {
        get;
    }

    /// Gets the `func` keyword of a managed function-pointer type clause `*func(T) R` (ADR-0122 §9 / issue
    /// #1035), or `null`.
    prop ManagedFunctionPointerFuncKeyword SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a managed function-pointer type `*func(T) R`
    /// (ADR-0122 §9 / issue #1035).
    prop IsManagedFunctionPointer bool -> ManagedFunctionPointerFuncKeyword != nil

    /// Gets the opening `[` of the type-argument list (Phase 4.3c), or `null`.
    prop TypeArgumentOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the comma-separated type-argument clauses for a constructed generic type (Phase 4.3c), or the
    /// default value.
    prop TypeArguments SeparatedSyntaxList[TypeClauseSyntax]? {
        get;
    }

    /// Gets the closing `]` of the type-argument list (Phase 4.3c), or `null`.
    prop TypeArgumentCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause carries a type-argument list `Foo[T1, T2]` (Phase 4.3c).
    /// This list attaches to the <em>last</em> (deepest) segment of the dotted name.
    prop HasTypeArguments bool -> TypeArgumentOpenBracketToken != nil

    /// Gets the number of segments in the (possibly dotted) named portion of this
    /// type clause: `1` for a simple identifier, and `1 + n` for a dotted
    /// name with `n` qualifier segments (issue #1506).
    prop SegmentCount int32 -> 1 + QualifierIdentifierTokens.Length

    /// Gets a value indicating whether any <em>outer</em> (non-last) segment of the
    /// dotted name carries its own type-argument list — e.g. `List[int32].Enumerator`
    /// or `A[T].B[U].C` (issue #1506). The last segment's type arguments are tracked
    /// separately by (cref:TypeArguments) / (cref:HasTypeArguments).
    prop HasOuterSegmentTypeArguments bool {
        get {
            if outerSegmentTypeArgumentOpenBracketTokens.IsDefaultOrEmpty {
                return false
            }
            for open_ in outerSegmentTypeArgumentOpenBracketTokens {
                if open_ != nil {
                    return true
                }
            }
            return false
        }
    }

    /// Gets the syntax children contributed by the per-segment type-argument lists of
    /// the outer (non-last) segments (issue #1506), so the reflection-based
    /// (cref:SyntaxNode.GetChildren) walks the new brackets, argument clauses, and
    /// separators (the last segment's arguments are walked via (cref:TypeArguments)).
    prop OuterSegmentTypeArgumentChildren IEnumerable[SyntaxNode] {
        get {
            if outerSegmentTypeArgumentOpenBracketTokens.IsDefaultOrEmpty {
                yield break
            }
            for var i = 0; i < outerSegmentTypeArgumentOpenBracketTokens.Length; i++ {
                let open_ SyntaxToken? = outerSegmentTypeArgumentOpenBracketTokens[i]
                if open_ == nil {
                    continue
                }
                yield open_
                let list SeparatedSyntaxList[TypeClauseSyntax]? = if i < outerSegmentTypeArgumentLists.Length {
                    outerSegmentTypeArgumentLists[i]
                } else {
                    default(SeparatedSyntaxList[TypeClauseSyntax]?)
                }
                if list != nil {
                    for node in list.GetWithSeparators() {
                        if node != nil {
                            yield node
                        }
                    }
                }
                let close SyntaxToken? = if i < outerSegmentTypeArgumentCloseBracketTokens.Length {
                    outerSegmentTypeArgumentCloseBracketTokens[i]
                } else {
                    default(SyntaxToken?)
                }
                if close != nil {
                    yield close
                }
            }
        }
    }

    /// Gets the `map` keyword for map types, or `null`.
    prop MapKeyword SyntaxToken? {
        get;
    }

    /// Gets the `[` opening the map key/value type-argument list (ADR-0104), or `null`.
    prop MapOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the map key type clause, or `null`.
    prop MapKeyType TypeClauseSyntax? {
        get;
    }

    /// Gets the `,` separating the map key type from the map value type (ADR-0104), or `null` when absent
    /// (e.g. parser recovered from a legacy `map[K]V` shape under GS0366).
    prop MapCommaToken SyntaxToken? {
        get;
    }

    /// Gets the `]` closing the map key/value type-argument list (ADR-0104), or `null`.
    prop MapCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets the map value type clause, or `null`.
    prop MapValueType TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a map type `map[K,V]` (ADR-0104).
    prop IsMap bool -> MapKeyword != nil

    /// Gets the `in`/`out` direction token of a directional channel type (ADR-0174 D2), or `null` for
    /// `chan[T]` and non-channel clauses.
    prop ChanDirectionToken SyntaxToken? {
        get;
    }

    /// Gets the `chan` keyword for channel types, or `null`.
    prop ChanKeyword SyntaxToken? {
        get;
    }

    /// Gets the `[` opening the channel element type (ADR-0174 D2), or `null` — including when the parser
    /// recovered from the legacy `chan T` shape under GS0567.
    prop ChanOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the channel element type clause, or `null`.
    prop ChanElementType TypeClauseSyntax? {
        get;
    }

    /// Gets the `]` closing the channel element type (ADR-0174 D2), or `null`.
    prop ChanCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a channel type `chan[T]` / `in chan[T]` /
    /// `out chan[T]` (ADR-0174 D2).
    prop IsChannel bool -> ChanKeyword != nil

    /// Gets a value indicating whether this channel clause was written in the retired juxtaposed spelling
    /// `chan T` (recovered under GS0567).
    prop IsLegacyChanSpelling bool -> ChanKeyword != nil && ChanOpenBracketToken == nil

    /// Gets the `*` token for pointer types, or `null` (ADR-0039).
    prop PointerStarToken SyntaxToken? {
        get;
    }

    /// Gets the pointee type clause for pointer types, or `null` (ADR-0039).
    prop PointerPointeeType TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a pointer type `*T` (ADR-0039).
    prop IsPointer bool -> PointerStarToken != nil

    /// Gets the `sequence` keyword for sequence types, or `null` (ADR-0040).
    prop SequenceKeyword SyntaxToken? {
        get;
    }

    /// Gets the `[` opening the sequence element type, or `null` (ADR-0040).
    prop SequenceOpenBracketToken SyntaxToken? {
        get;
    }

    /// Gets the sequence element type clause, or `null` (ADR-0040).
    prop SequenceElementType TypeClauseSyntax? {
        get;
    }

    /// Gets the `]` closing the sequence element type, or `null` (ADR-0040).
    prop SequenceCloseBracketToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause denotes a sequence type `sequence[T]` (ADR-0040).
    prop IsSequence bool -> SequenceKeyword != nil

    /// Gets the optional `async` modifier preceding a sequence type clause (ADR-0042), or `null`.
    prop AsyncModifier SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this clause denotes an async sequence type `async sequence[T]`
    /// (ADR-0042).
    prop IsAsyncSequence bool -> SequenceKeyword != nil && AsyncModifier != nil

    /// Gets a value indicating whether this clause denotes an async function type `async func(...) R?`
    /// (ADR-0043) or the canonical arrow form `async (...) -> R?` (ADR-0075).
    prop IsAsyncFunction bool -> IsFunction && AsyncModifier != nil

    /// Returns a value indicating whether the parameter at [`index`](paramref) carries a leading `...`
    /// marker (ADR-0102 follow-up / issue #818).
    /// @param index The parameter slot index.
    /// @returns `true` when the parameter is variadic.
    func IsParameterVariadic(index int32) bool {
        return !FunctionParameterEllipsisTokens.IsDefaultOrEmpty &&
            index >= 0 &&
            index < FunctionParameterEllipsisTokens.Length &&
            FunctionParameterEllipsisTokens[index] != nil
    }

    /// Returns the parameter slot's leading `ref`/`out`/`in` modifier token, or `null` for a by-value slot
    /// (issue #3501 A2).
    /// @param index The parameter slot index.
    /// @returns The modifier token, or `null`.
    func FunctionParameterRefKindToken(index int32) SyntaxToken? {
        return if !FunctionParameterRefKindTokens.IsDefaultOrEmpty &&
            index >= 0 &&
            index < FunctionParameterRefKindTokens.Length {
            FunctionParameterRefKindTokens[index]
        } else {
            default(SyntaxToken?)
        }
    }

    /// Gets a value indicating whether the segment at [`segmentIndex`](paramref)
    /// (0 = (cref:Identifier)) carries a type-argument list (issue #1506).
    /// @param segmentIndex The 0-based segment index.
    /// @returns Whether that segment is generic.
    func SegmentHasTypeArguments(segmentIndex int32) bool {
        if segmentIndex == SegmentCount - 1 {
            return HasTypeArguments
        }
        return !outerSegmentTypeArgumentOpenBracketTokens.IsDefaultOrEmpty &&
            segmentIndex >= 0 &&
            segmentIndex < outerSegmentTypeArgumentOpenBracketTokens.Length &&
            outerSegmentTypeArgumentOpenBracketTokens[segmentIndex] != nil
    }

    /// Gets the type-argument clauses carried by the segment at
    /// [`segmentIndex`](paramref) (0 = (cref:Identifier)), or `null`
    /// when that segment carries no type-argument list (issue #1506). The last segment's
    /// arguments are sourced from (cref:TypeArguments); all earlier (outer)
    /// segments from the per-segment lists.
    /// @param segmentIndex The 0-based segment index.
    /// @returns The type-argument list, or `null`.
    func GetSegmentTypeArguments(segmentIndex int32) SeparatedSyntaxList[TypeClauseSyntax]? {
        if segmentIndex == SegmentCount - 1 {
            return TypeArguments
        }
        if outerSegmentTypeArgumentLists.IsDefaultOrEmpty ||
            segmentIndex < 0 ||
            segmentIndex >= outerSegmentTypeArgumentLists.Length {
            return nil
        }
        return outerSegmentTypeArgumentLists[segmentIndex]
    }

    /// Issue #3315 / ADR-0159 addendum: records the `?` that followed the
    /// closing `)` of a parenthesized type clause, marking the WHOLE inner
    /// type nullable (`(chan int32)?`, `([]T)?`). Called by the
    /// parser immediately after the inner clause is built and its wrapping
    /// parens consumed — before the node is read by anyone else — so the
    /// parser-time mutation pattern (see (cref:SyntaxNode)'s span cache
    /// notes) applies; the cached span is invalidated so it re-extends over the
    /// new trailing token.
    /// @param questionToken The trailing `?` token.
    internal func SetParenthesizedQuestionToken(questionToken SyntaxToken?) {
        ParenthesizedQuestionToken = questionToken
        InvalidateCachedSpan()
    }

    /// ADR-0172: records the element name parsed before this clause inside a
    /// tuple type — `(line int32, column int32)`. Called by the parser
    /// immediately after the element clause is built, before the node is read
    /// by anyone else, so the parser-time mutation pattern applies; the cached
    /// span is invalidated so it re-extends over the leading name token.
    /// @param nameToken The element-name identifier token.
    internal func SetTupleElementNameToken(nameToken SyntaxToken) {
        TupleElementNameToken = nameToken
        InvalidateCachedSpan()
    }

    shared {
        /// Creates a pointer type clause `*T` (ADR-0039).
        /// @param syntaxTree The parent syntax tree.
        /// @param starToken The `*` prefix token.
        /// @param pointeeType The pointee type clause.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns A pointer type clause.
        func CreatePointer(
            syntaxTree SyntaxTree,
            starToken SyntaxToken,
            pointeeType TypeClauseSyntax,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(syntaxTree, starToken, pointeeType, questionToken, isPointer: true)
        }

        /// Creates an array/slice type clause `[N]T`/`[]T` whose element [`elementType`](paramref) is itself a
        /// nested type clause — enabling jagged arrays `[][]T`, arrays of pointers `[]*T`, arrays of maps
        /// `[]map[K,V]`, etc. (issue #1046).
        /// @param syntaxTree The parent syntax tree.
        /// @param openBracketToken The opening `[` token of the array/slice prefix.
        /// @param lengthToken The numeric length token for a fixed-length array, or `null` for a slice.
        /// @param closeBracketToken The closing `]` token of the array/slice prefix.
        /// @param elementType The nested element type clause.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @param arrayQuestionToken The optional `?` placed immediately after `]`, marking the whole array
        /// nullable (`[]?T`, issue #1212).
        /// @param arrayCommaTokens Commas forming a rectangular-array rank specifier.
        /// @returns An array/slice type clause carrying a nested element type clause.
        func CreateArray(
            syntaxTree SyntaxTree,
            openBracketToken SyntaxToken?,
            lengthToken SyntaxToken?,
            closeBracketToken SyntaxToken?,
            elementType TypeClauseSyntax,
            questionToken SyntaxToken?,
            arrayQuestionToken SyntaxToken? = nil,
            arrayCommaTokens ImmutableArray[SyntaxToken] = default(ImmutableArray[SyntaxToken])
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                openBracketToken,
                lengthToken,
                closeBracketToken,
                elementType,
                questionToken,
                isNestedArray: true,
                arrayQuestionToken,
                arrayCommaTokens
            )
        }

        /// Creates a sequence type clause `sequence[T]` (ADR-0040).
        /// @param syntaxTree The parent syntax tree.
        /// @param sequenceKeyword The `sequence` keyword.
        /// @param openBracketToken The `[` token.
        /// @param elementType The element type clause.
        /// @param closeBracketToken The `]` token.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns A sequence type clause.
        func CreateSequence(
            syntaxTree SyntaxTree,
            sequenceKeyword SyntaxToken,
            openBracketToken SyntaxToken?,
            elementType TypeClauseSyntax,
            closeBracketToken SyntaxToken?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier: nil,
                sequenceKeyword,
                openBracketToken,
                elementType,
                closeBracketToken,
                questionToken,
                isSequence: true
            )
        }

        /// Creates an async sequence type clause `async sequence[T]` (ADR-0042).
        /// @param syntaxTree The parent syntax tree.
        /// @param asyncModifier The `async` modifier token.
        /// @param sequenceKeyword The `sequence` keyword.
        /// @param openBracketToken The `[` token.
        /// @param elementType The element type clause.
        /// @param closeBracketToken The `]` token.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An async sequence type clause.
        func CreateAsyncSequence(
            syntaxTree SyntaxTree,
            asyncModifier SyntaxToken?,
            sequenceKeyword SyntaxToken,
            openBracketToken SyntaxToken?,
            elementType TypeClauseSyntax,
            closeBracketToken SyntaxToken?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier,
                sequenceKeyword,
                openBracketToken,
                elementType,
                closeBracketToken,
                questionToken,
                isSequence: true
            )
        }

        /// Creates an async function type clause `async func(P) R?` (ADR-0043).
        /// @param syntaxTree The parent syntax tree.
        /// @param asyncModifier The leading `async` modifier token.
        /// @param funcKeyword The `func` keyword.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param closeParenToken The closing `)` token.
        /// @param returnTypeClause The optional return-type clause; `null` for void.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An async function type clause.
        func CreateAsyncFunction(
            syntaxTree SyntaxTree,
            asyncModifier SyntaxToken?,
            funcKeyword SyntaxToken,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            closeParenToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier,
                funcKeyword,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens: default(ImmutableArray[SyntaxToken?]),
                closeParenToken,
                returnTypeClause,
                questionToken,
                isFunction: true
            )
        }

        /// Creates an async function type clause `async func(P, ...T) R?` with per-parameter variadic markers
        /// (ADR-0102 follow-up / issue #818).
        /// @param syntaxTree The parent syntax tree.
        /// @param asyncModifier The leading `async` modifier token.
        /// @param funcKeyword The `func` keyword.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param functionParameterEllipsisTokens The per-slot `...` tokens (parallel to
        /// [`functionParameterTypes`](paramref)); entries may be `null` for non-variadic slots.
        /// @param closeParenToken The closing `)` token.
        /// @param returnTypeClause The optional return-type clause; `null` for void.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An async function type clause.
        func CreateAsyncFunction(
            syntaxTree SyntaxTree,
            asyncModifier SyntaxToken?,
            funcKeyword SyntaxToken,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            functionParameterEllipsisTokens ImmutableArray[SyntaxToken?],
            closeParenToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier,
                funcKeyword,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens,
                closeParenToken,
                returnTypeClause,
                questionToken,
                isFunction: true
            )
        }

        /// Creates a legacy `func(P, ...T) R?` function type clause with per-parameter variadic markers
        /// (ADR-0102 follow-up / issue #818).
        /// @param syntaxTree The parent syntax tree.
        /// @param funcKeyword The `func` keyword.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param functionParameterEllipsisTokens The per-slot `...` tokens.
        /// @param closeParenToken The closing `)` token.
        /// @param returnTypeClause The optional return-type clause; `null` for void.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns A legacy function type clause.
        func CreateLegacyFunction(
            syntaxTree SyntaxTree,
            funcKeyword SyntaxToken,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            functionParameterEllipsisTokens ImmutableArray[SyntaxToken?],
            closeParenToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier: nil,
                funcKeyword,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens,
                closeParenToken,
                returnTypeClause,
                questionToken,
                isFunction: true
            )
        }

        /// Creates the canonical arrow-form function type clause `(T1, T2, ...) -> R?` (ADR-0075).
        /// @param syntaxTree The parent syntax tree.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param closeParenToken The closing `)` token.
        /// @param arrowToken The `->` token.
        /// @param returnTypeClause The return-type clause (use a tuple type clause for multi-return shapes).
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An arrow-form function type clause.
        func CreateArrowFunction(
            syntaxTree SyntaxTree,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            closeParenToken SyntaxToken?,
            arrowToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier: nil,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens: default(ImmutableArray[SyntaxToken?]),
                closeParenToken,
                arrowToken,
                returnTypeClause,
                questionToken,
                isArrowFunction: true
            )
        }

        /// Creates the canonical arrow-form function type clause `(T1, T2, ...Tk) -> R?` with per-parameter
        /// variadic markers (ADR-0102 follow-up / issue #818).
        /// @param syntaxTree The parent syntax tree.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param functionParameterEllipsisTokens Per-slot `...` tokens (parallel to
        /// [`functionParameterTypes`](paramref)); entries may be `null`.
        /// @param closeParenToken The closing `)` token.
        /// @param arrowToken The `->` token.
        /// @param returnTypeClause The return-type clause.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An arrow-form function type clause.
        func CreateArrowFunction(
            syntaxTree SyntaxTree,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            functionParameterEllipsisTokens ImmutableArray[SyntaxToken?],
            closeParenToken SyntaxToken?,
            arrowToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier: nil,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens,
                closeParenToken,
                arrowToken,
                returnTypeClause,
                questionToken,
                isArrowFunction: true
            )
        }

        /// Creates the canonical async arrow-form function type clause `async (T1, T2, ...) -> R?` (ADR-0075).
        /// @param syntaxTree The parent syntax tree.
        /// @param asyncModifier The leading `async` modifier token.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param closeParenToken The closing `)` token.
        /// @param arrowToken The `->` token.
        /// @param returnTypeClause The return-type clause.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An async arrow-form function type clause.
        func CreateAsyncArrowFunction(
            syntaxTree SyntaxTree,
            asyncModifier SyntaxToken?,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            closeParenToken SyntaxToken?,
            arrowToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens: default(ImmutableArray[SyntaxToken?]),
                closeParenToken,
                arrowToken,
                returnTypeClause,
                questionToken,
                isArrowFunction: true
            )
        }

        /// Creates the canonical async arrow-form function type clause `async (T1, T2, ...Tk) -> R?` with
        /// per-parameter variadic markers (ADR-0102 follow-up / issue #818).
        /// @param syntaxTree The parent syntax tree.
        /// @param asyncModifier The leading `async` modifier token.
        /// @param openParenToken The opening `(` token.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param functionParameterEllipsisTokens Per-slot `...` tokens.
        /// @param closeParenToken The closing `)` token.
        /// @param arrowToken The `->` token.
        /// @param returnTypeClause The return-type clause.
        /// @param questionToken The optional trailing `?` nullability marker.
        /// @returns An async arrow-form function type clause.
        func CreateAsyncArrowFunction(
            syntaxTree SyntaxTree,
            asyncModifier SyntaxToken?,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            functionParameterEllipsisTokens ImmutableArray[SyntaxToken?],
            closeParenToken SyntaxToken?,
            arrowToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            questionToken SyntaxToken?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                asyncModifier,
                openParenToken,
                functionParameterTypes,
                functionParameterEllipsisTokens,
                closeParenToken,
                arrowToken,
                returnTypeClause,
                questionToken,
                isArrowFunction: true
            )
        }

        /// Creates the raw function-pointer type clause `unmanaged[CC] (T1, T2, ...) -> R` (ADR-0095 / issue
        /// #761).
        /// @param syntaxTree The parent syntax tree.
        /// @param unmanagedKeyword The `unmanaged` contextual keyword token.
        /// @param callingConventionOpenBracketToken The opening `[` of the calling-convention slot.
        /// @param callingConventionIdentifierToken The calling-convention identifier (`Cdecl`, `Stdcall`,
        /// `Thiscall`, `Fastcall`).
        /// @param callingConventionCloseBracketToken The closing `]` of the calling-convention slot.
        /// @param openParenToken The opening `(` of the parameter-type list.
        /// @param functionParameterTypes The comma-separated parameter-type clauses.
        /// @param closeParenToken The closing `)` of the parameter-type list.
        /// @param arrowToken The `->` token.
        /// @param returnTypeClause The return-type clause.
        /// @param callingConventionRestTokens The slot tokens after the first convention identifier —
        /// alternating `,` separators and identifiers in source order (ADR-0095 v2 / issue #3611), or default
        /// for a single-convention or bare slot.
        /// @returns A raw function-pointer type clause.
        func CreateFunctionPointer(
            syntaxTree SyntaxTree,
            unmanagedKeyword SyntaxToken,
            callingConventionOpenBracketToken SyntaxToken?,
            callingConventionIdentifierToken SyntaxToken?,
            callingConventionCloseBracketToken SyntaxToken?,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            closeParenToken SyntaxToken?,
            arrowToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?,
            callingConventionRestTokens ImmutableArray[SyntaxToken] = default(ImmutableArray[SyntaxToken])
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                unmanagedKeyword,
                callingConventionOpenBracketToken,
                callingConventionIdentifierToken,
                callingConventionRestTokens,
                callingConventionCloseBracketToken,
                openParenToken,
                functionParameterTypes,
                closeParenToken,
                arrowToken,
                returnTypeClause,
                isFunctionPointer: true
            )
        }

        /// Creates a managed function-pointer type clause `*func(T1, T2, ...) R`
        /// (ADR-0122 §9 / issue #1035).
        /// @param syntaxTree The owning syntax tree.
        /// @param managedFunctionPointerStarToken The leading `*` token.
        /// @param managedFunctionPointerFuncKeyword The `func` keyword.
        /// @param openParenToken The opening `(`.
        /// @param functionParameterTypes The parameter type clauses.
        /// @param closeParenToken The closing `)`.
        /// @param returnTypeClause The return type clause, or `null` for void.
        /// @returns A managed function-pointer (cref:TypeClauseSyntax).
        func CreateManagedFunctionPointer(
            syntaxTree SyntaxTree,
            managedFunctionPointerStarToken SyntaxToken,
            managedFunctionPointerFuncKeyword SyntaxToken,
            openParenToken SyntaxToken?,
            functionParameterTypes SeparatedSyntaxList[TypeClauseSyntax]?,
            closeParenToken SyntaxToken?,
            returnTypeClause TypeClauseSyntax?
        ) TypeClauseSyntax {
            return TypeClauseSyntax(
                syntaxTree,
                managedFunctionPointerStarToken,
                managedFunctionPointerFuncKeyword,
                openParenToken,
                functionParameterTypes,
                closeParenToken,
                returnTypeClause
            )
        }
    }
}
