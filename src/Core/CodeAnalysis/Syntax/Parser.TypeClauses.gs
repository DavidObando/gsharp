// <copyright file="Parser.TypeClauses.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices

open partial class Parser {
    private func IsReadOnlySpanHead(offset int32 = 0) bool -> Peek(offset).Kind == SyntaxKind.IdentifierToken && Peek(
        offset
    ).Text == "readonly" &&
        Peek(offset + 1).Kind == SyntaxKind.IdentifierToken && Peek(offset + 1).Text == "span" && Peek(
        offset + 2
    ).Kind == SyntaxKind.OpenSquareBracketToken

    private func IsReadOnlySliceHead(offset int32 = 0) bool -> Peek(offset).Kind == SyntaxKind.IdentifierToken && Peek(
        offset
    ).Text == "readonly" &&
        Peek(offset + 1).Kind == SyntaxKind.IdentifierToken && Peek(offset + 1).Text == "slice" && Peek(
        offset + 2
    ).Kind == SyntaxKind.OpenSquareBracketToken

    private func IsReadOnlyManagedHead(offset int32 = 0, address bool = false) bool -> Peek(
        offset
    ).Kind == SyntaxKind.IdentifierToken &&
        Peek(offset).Text == "readonly" && Peek(offset + 1).Kind == SyntaxKind.IdentifierToken && Peek(
        offset + 1
    ).Text == "managed" &&
        Peek(offset + 2).Kind == (
        if address {
            SyntaxKind.OpenParenthesisToken
        } else {
            SyntaxKind.OpenSquareBracketToken
        }
    )

    // Issue #1602: depth-guarded wrapper — type clauses self-nest through
    // pointers (`*T`), arrays (`[]T`), tuples, function types, and generic
    // type-argument lists (`List[List[…]]`).
    private func ParseTypeClause() TypeClauseSyntax {
        EnsureNestedParseAllowed()
        recursionDepth++
        try {
            return ParseTypeClauseCore()
        } finally {
            recursionDepth--
        }
    }

    private func ParseTypeClauseCore() TypeClauseSyntax {
        if IsReadOnlySpanHead() {
            let modifier = NextToken()
            let type = ParseTypeClause()
            type.ReadOnlySpanModifier = modifier
            return type
        }
        if IsReadOnlyManagedHead() {
            let modifier = NextToken()
            let type = ParseTypeClause()
            type.ReadOnlyManagedModifier = modifier
            return type
        }
        if IsReadOnlySliceHead() {
            let modifier = NextToken()
            let type = ParseTypeClause()
            type.ReadOnlySliceModifier = modifier
            return type
        }
        if Current.Kind == SyntaxKind.FuncKeyword {
            return ParseFunctionTypeClause()
        }
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            if tupleTypeBeforeArrowBodyPosition == Current.Position {
                return ParseTupleTypeClause()
            }
            // ADR-0075 / issue #715: the canonical function-type clause is
            // `(T1, T2, ...) -> R`. Disambiguated from a tuple type clause by
            // bounded look-ahead — if the matching `)` is immediately followed
            // by `->`, we commit to the arrow function form; otherwise fall
            // back to the long-standing tuple-type parse.
            if LooksLikeArrowFunctionTypeClauseStart() {
                return ParseArrowFunctionTypeClause(asyncModifier: nil)
            }
            if LooksLikeParenthesizedArrowFunctionTypeClauseStart() {
                return ParseParenthesizedArrowFunctionTypeClause(asyncModifier: nil)
            }
            return ParseTupleTypeClause()
        }
        if Current.Kind == SyntaxKind.MapKeyword {
            return ParseMapTypeClause()
        }
        if Current.Kind == SyntaxKind.ChanKeyword {
            return ParseChanTypeClause(directionToken: nil, legacyMakeOperand: false)
        }
        // ADR-0174 D2: `in chan[T]` / `out chan[T]`. `in` and `out` are the
        // existing variance keywords (ADR-0021), contextual identifiers here;
        // a channel direction appears only in type position, where neither
        // the type-parameter form nor `for … in` can.
        if IsChannelDirectionHead() {
            let directionToken = NextToken()
            return ParseChanTypeClause(directionToken, legacyMakeOperand: false)
        }
        // ADR-0040: sequence type `sequence[T]` — alias for IEnumerable[T].
        if Current.Kind == SyntaxKind.SequenceKeyword {
            return ParseSequenceTypeClause()
        }
        // ADR-0042 / ADR-0043: `async` as a type-clause prefix is reserved for
        // `async sequence[T]` (alias for IAsyncEnumerable[T]) and
        // `async func(P) R` (alias for func(P) Task[R]). All other forms are
        // rejected with a diagnostic.
        if Current.Kind == SyntaxKind.AsyncKeyword {
            return ParseAsyncPrefixedTypeClause()
        }
        // ADR-0095 / issue #761: raw function-pointer type clause
        // `unmanaged[CC] (T1, T2, ...) -> R`. `unmanaged` is a contextual
        // keyword — we only commit to this shape when it appears at the
        // start of a type-clause position followed by `[` or `(`. Plain
        // identifiers named `unmanaged` (e.g. a struct member or local)
        // are unaffected because they never reach this parser entry.
        if IsFunctionPointerTypeHead() {
            return ParseFunctionPointerTypeClause()
        }
        // ADR-0039: pointer type `*T` in type-annotation position.
        if Current.Kind == SyntaxKind.StarToken {
            // ADR-0122 §9 / issue #1035: a *managed* function pointer is
            // spelled `*func(T1, T2) R` — the `*` pointer prefix followed by
            // the `func(...) R` signature. It is consistent with the `*T`
            // pointer syntax and is callable directly via `calli`. We commit
            // to this shape only when `*` is immediately followed by `func`.
            if Peek(1).Kind == SyntaxKind.FuncKeyword {
                return ParseManagedFunctionPointerTypeClause()
            }
            let star = NextToken()
            let pointee = ParseTypeClause()
            let ptrQuestion = if Current.Kind == SyntaxKind.QuestionToken {
                MatchToken(SyntaxKind.QuestionToken)
            } else {
                default(SyntaxToken?)
            }
            return TypeClauseSyntax.CreatePointer(syntaxTree, star, pointee, ptrQuestion)
        }
        if Current.Kind == SyntaxKind.OpenSquareBracketToken {
            let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
            var length SyntaxToken? = nil
            let rankCommas = ImmutableArray.CreateBuilder[SyntaxToken]()
            if Current.Kind != SyntaxKind.CloseSquareBracketToken {
                if Current.Kind == SyntaxKind.CommaToken {
                    while Current.Kind == SyntaxKind.CommaToken {
                        rankCommas.Add(MatchToken(SyntaxKind.CommaToken))
                    }
                } else {
                    length = MatchToken(SyntaxKind.NumberToken)
                }
            }
            let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
            // Issue #1351: a nullable array whose element type is itself an
            // array spells the element with a leading `[`. The lexer greedily
            // fuses the nullability `?` and that `[` into a single
            // `?[` (`QuestionOpenBracketToken`). Split it back into `?` + `[`
            // so the nullable marker is consumed below and the recursive
            // element parse sees the nested array's open bracket.
            if Current.Kind == SyntaxKind.QuestionOpenBracketToken {
                SplitQuestionOpenBracketToken()
            }
            // Issue #1212: a `?` placed immediately after the `]` (before the
            // element type) marks the *whole array reference* nullable —
            // `[]?T` / `[N]?T` is `([]T)?`. This is distinct from a trailing
            // `?` after the element (`[]T?`), which binds to the element type.
            let arrayNullableQuestion = if Current.Kind == SyntaxKind.QuestionToken {
                MatchToken(SyntaxKind.QuestionToken)
            } else {
                default(SyntaxToken?)
            }
            // Issue #1046: a jagged/nested array element — the element type is
            // itself a non-identifier type clause (`[][]T`, `[]*T`, `[]map[K,V]`,
            // `[]chan T`, `[]func(...) R`, `[](T1, T2)`, …). When the token after
            // `]` does not begin a plain (possibly dotted/generic) identifier
            // element, parse the element recursively and store it as a nested
            // type clause via `TypeClauseSyntax.CreateArray`. The common
            // `[]Identifier`/`[]Foo.Bar`/`[]List[int32]` forms keep the existing
            // flat representation so nothing regresses.
            // ADR-0174 D2 adds one element shape that *does* begin with an
            // identifier: `in`/`out` are contextual, so `[]in chan[T]` would
            // otherwise take the flat path and read `in` as the element's type
            // name.
            // Issue #4938: the raw function-pointer head `unmanaged[CC] (…) -> R`
            // is also an identifier, so `[]unmanaged[Cdecl] () -> int32` used
            // to take the flat path and read `unmanaged` as the element's name.
            if Current.Kind != SyntaxKind.IdentifierToken ||
                IsChannelDirectionHead() ||
                IsReadOnlySliceHead() ||
                IsReadOnlySpanHead() ||
                IsReadOnlyManagedHead() ||
                IsFunctionPointerTypeHead() {
                let nestedElement = ParseTypeClause()
                let nestedQuestion = if Current.Kind == SyntaxKind.QuestionToken {
                    MatchToken(SyntaxKind.QuestionToken)
                } else {
                    default(SyntaxToken?)
                }
                return TypeClauseSyntax.CreateArray(
                    syntaxTree,
                    openBracket,
                    length,
                    closeBracket,
                    nestedElement,
                    nestedQuestion,
                    arrayNullableQuestion,
                    rankCommas.ToImmutable()
                )
            }
            let elementIdentifier = MatchToken(SyntaxKind.IdentifierToken)
            // Issue #526 / #1506: an array/slice of a (possibly nested, possibly
            // per-segment generic) named type — `[]Outer.Inner`, `[]List[int32]`,
            // `[]List[int32].Enumerator`. The dotted-name tail records a
            // type-argument list per segment so an outer segment can be generic
            // and still dot into a nested type.
            let arrayTail = ParseDottedTypeNameTail()
            let arrayQuestion = if Current.Kind == SyntaxKind.QuestionToken {
                MatchToken(SyntaxKind.QuestionToken)
            } else {
                default(SyntaxToken?)
            }
            return TypeClauseSyntax(
                syntaxTree,
                openBracket,
                length,
                closeBracket,
                elementIdentifier,
                arrayTail.Dots,
                arrayTail.Identifiers,
                arrayTail.TrailingTypeArgumentOpen,
                arrayTail.TrailingTypeArguments,
                arrayTail.TrailingTypeArgumentClose,
                arrayQuestion,
                arrayNullableQuestion,
                arrayTail.OuterSegmentTypeArgumentOpens,
                arrayTail.OuterSegmentTypeArgumentLists,
                arrayTail.OuterSegmentTypeArgumentCloses,
                rankCommas.ToImmutable()
            )
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        // Issue #526 / #1506: a dotted-qualifier chain `Outer.Inner` (or `A.B.C`)
        // names a nested type. Each segment may carry its own type-argument list
        // so an OUTER segment can be generic and then dot into a nested type
        // (`List[int32].Enumerator`, `A[T].B[U].C`); the list on the LAST segment
        // continues to be tracked by `TypeArguments` for backwards compatibility.
        let tail = ParseDottedTypeNameTail()
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        return TypeClauseSyntax(
            syntaxTree,
            openBracketToken: nil,
            lengthToken: nil,
            closeBracketToken: nil,
            identifier,
            tail.Dots,
            tail.Identifiers,
            tail.TrailingTypeArgumentOpen,
            tail.TrailingTypeArguments,
            tail.TrailingTypeArgumentClose,
            question,
            arrayQuestionToken: nil,
            tail.OuterSegmentTypeArgumentOpens,
            tail.OuterSegmentTypeArgumentLists,
            tail.OuterSegmentTypeArgumentCloses
        )
    }

    /// Issue #526 / #1506: consumes the tail of a dotted type-clause name, starting
    /// immediately after the first (already-consumed) identifier. Each segment may
    /// carry its own optional `[ T1, ... ]` type-argument list, generalizing
    /// `Outer[T].Inner`, `A[T].B[U].C`, and the legacy single-trailing-list
    /// forms. The last segment's type-argument list is returned via the
    /// `Trailing*` fields (matching the historical (cref:TypeClauseSyntax.TypeArguments)
    /// representation); every earlier (outer) segment's list is returned via the
    /// `OuterSegment*` arrays, aligned to the segment sequence. Lookahead-only on
    /// `. IDENT` so a member access on a value-typed identifier is never miscounted
    /// as a qualifier.
    /// @returns The decomposed dotted-name tail.
    private func ParseDottedTypeNameTail() DottedTypeNameTail {
        let dots = ImmutableArray.CreateBuilder[SyntaxToken]()
        let identifiers = ImmutableArray.CreateBuilder[SyntaxToken]()
        let segmentOpens = List[SyntaxToken?]()
        let segmentLists = List[SeparatedSyntaxList[TypeClauseSyntax]?]()
        let segmentCloses = List[SyntaxToken?]()
        // Segment 0 (the already-consumed first identifier): optional `[ ... ]`.
        ParseOptionalSegmentTypeArguments(out var firstOpen, out var firstList, out var firstClose)
        segmentOpens.Add(firstOpen)
        segmentLists.Add(firstList)
        segmentCloses.Add(firstClose)
        while Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken {
            dots.Add(NextToken())
            identifiers.Add(NextToken())
            ParseOptionalSegmentTypeArguments(out var segOpen, out var segList, out var segClose)
            segmentOpens.Add(segOpen)
            segmentLists.Add(segList)
            segmentCloses.Add(segClose)
        }
        let lastIndex = segmentOpens.Count - 1
        let outerOpens = ImmutableArray.CreateBuilder[SyntaxToken?](lastIndex)
        let outerLists = ImmutableArray.CreateBuilder[SeparatedSyntaxList[TypeClauseSyntax]?](lastIndex)
        let outerCloses = ImmutableArray.CreateBuilder[SyntaxToken?](lastIndex)
        for var i = 0; i < lastIndex; i++ {
            outerOpens.Add(segmentOpens[i])
            outerLists.Add(segmentLists[i])
            outerCloses.Add(segmentCloses[i])
        }
        return DottedTypeNameTail(
            dots.ToImmutable(),
            identifiers.ToImmutable(),
            segmentOpens[lastIndex],
            segmentLists[lastIndex],
            segmentCloses[lastIndex],
            outerOpens.ToImmutable(),
            outerLists.ToImmutable(),
            outerCloses.ToImmutable()
        )
    }

    /// Parses an optional type-argument list `[ T1, T2, ... ]` in type position
    /// (issue #1506). Leaves the parser unchanged and emits all-`null` outputs when
    /// the current token does not open a list.
    /// @param open The opening `[`, or `null`.
    /// @param list The argument list, or `null`.
    /// @param close The closing `]`, or `null`.
    private func ParseOptionalSegmentTypeArguments(
        out $open SyntaxToken?,
        out list SeparatedSyntaxList[TypeClauseSyntax]?,
        out close SyntaxToken?
    ) {
        $open = nil
        list = nil
        close = nil
        if Current.Kind != SyntaxKind.OpenSquareBracketToken {
            return
        }
        $open = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while Current.Kind != SyntaxKind.CloseSquareBracketToken && Current.Kind != SyntaxKind.EndOfFileToken {
            nodesAndSeparators.Add(ParseGenericTypeArgument())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        list = SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable())
        close = MatchToken(SyntaxKind.CloseSquareBracketToken)
    }

    private func ParseGenericTypeArgument() TypeClauseSyntax {
        let typeArgument = ParseTypeClause()
        ReportIfPointerGenericTypeArgument(typeArgument)
        return typeArgument
    }

    private func ReportIfPointerGenericTypeArgument(typeArgument TypeClauseSyntax) {
        if typeArgument.IsPointer || typeArgument.IsFunctionPointer {
            Diagnostics.ReportPointerGenericTypeArgument(typeArgument.Location)
        }
    }

    private func ParseTupleTypeClause() TypeClauseSyntax {
        // Phase 4.5: tuple type clause `(T1, T2, ...)` with optional trailing `?`.
        //
        // Issue #3315 / ADR-0159 addendum: a parenthesized SINGLE type clause
        // with no comma — `(T)` — is not a 1-tuple (the binder has always
        // rejected those with "unexpected token") but GROUPING: it parses to
        // the inner clause itself. Its trailing `?` marks the WHOLE inner type
        // nullable, which finally gives the composite types whose own trailing
        // `?` binds tighter (per the suffix family rule: `[]T?` element-
        // nullable per #1212, `(T) -> R?` return-nullable per ADR-0075) an
        // explicit whole-type spelling: `(chan int32)?` is a nullable channel
        // of int32, `([]T)?` equals `[]?T`, mirroring the parenthesized
        // arrow-function form `((T) -> R)?` (issue #1399 / ADR-0137).
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = true
        var sawComma = false
        while parseNext &&
            Current.Kind != SyntaxKind.CloseParenthesisToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            // ADR-0172: an element may declare a name before its type —
            // `(line int32, column int32)` — mirroring the parameter form
            // `identifier TypeClause`. Committed only when the identifier is
            // followed by a token that can start a type clause, so plain
            // element types (`(int32, string)`, qualified `(System.Int32, …)`,
            // generic `(List[int32], …)`) parse exactly as before.
            var elementNameToken SyntaxToken? = nil
            if Current.Kind == SyntaxKind.IdentifierToken && LooksLikeTupleElementName() {
                elementNameToken = MatchToken(SyntaxKind.IdentifierToken)
            }
            let elementClause = ParseTypeClause()
            if elementNameToken != nil {
                elementClause.SetTupleElementNameToken(elementNameToken)
            }
            nodesAndSeparators.Add(elementClause)
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                sawComma = true
            } else {
                parseNext = false
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let question SyntaxToken? = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        if !sawComma && nodesAndSeparators.Count == 1 && nodesAndSeparators[0] is TypeClauseSyntax parenthesizedInner {
            // Grouping (issue #3315): `(T)` is `T`; `(T)?` is whole-`T`
            // nullable. The parens themselves are dropped, exactly like the
            // parenthesized arrow-function form's outer parens (#1399).
            // ADR-0172: a name on the single element — `(line int32)` — is an
            // error (there are no 1-tuples); recover as grouping.
            if parenthesizedInner.TupleElementNameToken is {} strayName {
                Diagnostics.ReportTupleElementNameOutsideTuple(strayName.Location)
            }
            if question != nil {
                parenthesizedInner.SetParenthesizedQuestionToken(question)
            }
            return parenthesizedInner
        }
        return TypeClauseSyntax(
            syntaxTree,
            openParen,
            SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
            closeParen,
            question
        )
    }

    /// ADR-0172: decides whether the identifier at the current position is a
    /// tuple-element NAME (followed by a token that can start a type clause)
    /// rather than the element type itself. `identifier identifier` is always
    /// name + type (two consecutive identifiers never form a type), and the
    /// `[` case distinguishes an array/slice/rectangular element type
    /// (`name []T`, `name [3]T`, `name [,]T`) from a generic type-argument
    /// list on the identifier itself (`List[int32]`). The `unmanaged`
    /// function-pointer head keeps its ADR-0095 meaning.
    private func LooksLikeTupleElementName(offset int32 = 0) bool {
        if IsReadOnlySliceHead(offset) || IsReadOnlySpanHead(offset) || IsReadOnlyManagedHead(offset) {
            return false
        }
        // `unmanaged[CC] (…) -> R` / `unmanaged (…) -> R` is a raw
        // function-pointer TYPE head, never an element name.
        if IsFunctionPointerTypeHead(offset) {
            return false
        }
        // ADR-0174 D2: `in chan[T]` / `out chan[T]` is a directional channel
        // TYPE head, never an element named `in`/`out` (those are reserved
        // identifiers in parameter position anyway).
        if IsChannelDirectionHead(offset) {
            return false
        }
        switch Peek(offset + 1).Kind {
            case SyntaxKind.IdentifierToken,
            SyntaxKind.FuncKeyword,
            SyntaxKind.MapKeyword,
            SyntaxKind.ChanKeyword,
            SyntaxKind.SequenceKeyword,
            SyntaxKind.AsyncKeyword,
            SyntaxKind.StarToken,
            SyntaxKind.OpenParenthesisToken {
                return true
            }
            case SyntaxKind.OpenSquareBracketToken {
                // `name []T` / `name [3]T` / `name [,]T` vs generic
                // `Ident[TypeArgs]` — an array shape opens with `]`, a
                // number, or a rank comma; a type-argument list never does.
                return (
                    Peek(offset + 2).Kind is SyntaxKind.CloseSquareBracketToken or
                        SyntaxKind.NumberToken or
                        SyntaxKind.CommaToken
                )
            }
            default {
                return false
            }
        }
    }

    private func ParseMapTypeClause() TypeClauseSyntax {
        // ADR-0104 / issue #805: canonical map type clause `map[K,V]` with optional trailing `?`.
        // For one release we still *recognize* the legacy Go-flavored shape
        // `map[K]V` so we can emit GS0366 with a span-accurate "did you mean
        // 'map[K,V]'?" diagnostic, then bind it as if the new spelling had
        // been written. No deprecation window — this is the breaking change
        // for v0.2 called out in ADR-0104.
        let mapKeyword = MatchToken(SyntaxKind.MapKeyword)
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let keyType = ParseTypeClause()
        var commaToken SyntaxToken? = nil
        var closeBracket SyntaxToken
        var valueType TypeClauseSyntax
        if Current.Kind == SyntaxKind.CommaToken {
            commaToken = MatchToken(SyntaxKind.CommaToken)
            valueType = ParseTypeClause()
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        } else {
            // Legacy `map[K]V` shape: consume the close-bracket, then the
            // value type that follows, then point GS0366 at the whole span.
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
            valueType = ParseTypeClause()
            let legacySpan = TextSpan.FromBounds(mapKeyword.Span.Start, valueType.Span.End)
            let legacyLocation = TextLocation(syntaxTree.Text, legacySpan)
            let keyText = syntaxTree.Text.ToString(keyType.Span)
            let valueText = syntaxTree.Text.ToString(valueType.Span)
            Diagnostics.ReportLegacyMapTypeClauseSyntax(legacyLocation, keyText, valueText)
        }
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        return TypeClauseSyntax(
            syntaxTree,
            mapKeyword,
            openBracket,
            keyType,
            commaToken,
            valueType,
            closeBracket,
            question
        )
    }

    /// ADR-0095 §6: `unmanaged` is a contextual keyword that heads a raw
    /// function-pointer type clause (`unmanaged[CC, …] (T, …) -> R`, or the
    /// platform-default `unmanaged (T, …) -> R`) only when the next token is
    /// `[` or `(`. This is the single head test for that production: the real
    /// type-clause parser, its array-element dispatch, the tuple-element-name
    /// look-aheads and the speculative scanner
    /// (`TryScanTypeClauseCore`) all ask it, so they cannot disagree about
    /// where a function-pointer type starts (issue #4938).
    /// @param offset The token offset, relative to `Current`, of the
    /// candidate `unmanaged` token.
    private func IsFunctionPointerTypeHead(offset int32 = 0) bool -> Peek(offset).Kind == SyntaxKind.IdentifierToken &&
        Peek(offset).Text == "unmanaged" &&
        (
        Peek(offset + 1).Kind == SyntaxKind.OpenSquareBracketToken || Peek(
            offset + 1
        ).Kind == SyntaxKind.OpenParenthesisToken
    )

    private func IsChannelDirectionHead(offset int32 = 0) bool -> Peek(offset).Kind == SyntaxKind.IdentifierToken &&
        (Peek(offset).Text == "in" || Peek(offset).Text == "out") &&
        Peek(offset + 1).Kind == SyntaxKind.ChanKeyword

    private func ParseChanTypeClause(directionToken SyntaxToken?, legacyMakeOperand bool) TypeClauseSyntax {
        // ADR-0174 D2: canonical channel type clause `chan[T]` with the
        // element type INSIDE brackets, like `sequence[T]` and `map[K, V]`,
        // optionally headed by `in`/`out`. A trailing `?` now unambiguously
        // marks the whole channel nullable — `chan[int32]?` — while a nullable
        // element is `chan[int32?]`; the `(chan T)?` grouping carve-out is gone.
        //
        // The retired juxtaposed shape `chan T` is still *recognized* so the
        // parser can report a span-accurate GS0567 ("use 'chan[T]'") and bind
        // it as if the canonical spelling had been written (ADR-0104's GS0366
        // recovery pattern) — the file must not cascade. In a legacy
        // `make(chan T…)` operand the enclosing `make` already reports GS0566,
        // so the inner clause stays silent: one diagnostic per site.
        let chanKeyword = MatchToken(SyntaxKind.ChanKeyword)
        if Current.Kind == SyntaxKind.OpenSquareBracketToken {
            let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
            let elementType = ParseTypeClause()
            let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
            let question = if Current.Kind == SyntaxKind.QuestionToken {
                MatchToken(SyntaxKind.QuestionToken)
            } else {
                default(SyntaxToken?)
            }
            return TypeClauseSyntax(
                syntaxTree,
                directionToken,
                chanKeyword,
                openBracket,
                elementType,
                closeBracket,
                question
            )
        }
        // Legacy `chan T`: the greedy element parse consumes a trailing `?`
        // (that was `chan (int32?)`), so the recovered clause is `chan[T?]`.
        let legacyElement = ParseTypeClause()
        if !legacyMakeOperand {
            let start = directionToken?.Span.Start ?? chanKeyword.Span.Start
            let legacySpan = TextSpan.FromBounds(start, legacyElement.Span.End)
            let elementText = syntaxTree.Text.ToString(legacyElement.Span)
            Diagnostics.ReportLegacyChanTypeClauseSyntax(TextLocation(syntaxTree.Text, legacySpan), elementText)
        }
        return TypeClauseSyntax(
            syntaxTree,
            directionToken,
            chanKeyword,
            chanOpenBracketToken: nil,
            legacyElement,
            chanCloseBracketToken: nil,
            questionToken: nil
        )
    }

    private func ParseSequenceTypeClause() TypeClauseSyntax {
        // ADR-0040: sequence type clause `sequence[T]` with optional trailing `?`.
        let sequenceKeyword = MatchToken(SyntaxKind.SequenceKeyword)
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let elementType = ParseTypeClause()
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        return TypeClauseSyntax.CreateSequence(
            syntaxTree,
            sequenceKeyword,
            openBracket,
            elementType,
            closeBracket,
            question
        )
    }

    private func ParseAsyncPrefixedTypeClause() TypeClauseSyntax {
        // ADR-0042: `async sequence[T]` — alias for IAsyncEnumerable[T].
        // ADR-0043: `async func(P) R` — alias for func(P) Task[R] (deprecated, ADR-0075).
        // ADR-0075: `async (P) -> R` — canonical arrow-form async function type clause.
        // No other form is legal as an `async`-prefixed type clause.
        let asyncModifier = MatchToken(SyntaxKind.AsyncKeyword)
        if Current.Kind == SyntaxKind.FuncKeyword {
            return ParseAsyncFunctionTypeClause(asyncModifier)
        }
        // ADR-0075: arrow-form async function type clause `async (T) -> R`.
        if Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeArrowFunctionTypeClauseStart() {
            return ParseArrowFunctionTypeClause(asyncModifier)
        }
        if Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeParenthesizedArrowFunctionTypeClauseStart() {
            return ParseParenthesizedArrowFunctionTypeClause(asyncModifier)
        }
        if Current.Kind != SyntaxKind.SequenceKeyword {
            Diagnostics.ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc(asyncModifier.Location, Current.Kind)
        }
        let sequenceKeyword = MatchToken(SyntaxKind.SequenceKeyword)
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let elementType = ParseTypeClause()
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        return TypeClauseSyntax.CreateAsyncSequence(
            syntaxTree,
            asyncModifier,
            sequenceKeyword,
            openBracket,
            elementType,
            closeBracket,
            question
        )
    }

    private func ParseAsyncFunctionTypeClause(asyncModifier SyntaxToken?) TypeClauseSyntax {
        // ADR-0043: `async func(P) R` is a synonym for `func(P) Task[R]`
        // (with carve-outs for void → Task and IAsyncEnumerable[T] → unchanged).
        // ADR-0075 / issue #715: the `func(...)` spelling is deprecated in
        // type position — emit GS0303 so the migrate-to-arrow-form signal
        // surfaces uniformly.
        let funcKeyword = MatchToken(SyntaxKind.FuncKeyword)
        Diagnostics.ReportFunctionTypeClauseFuncKeywordDeprecated(funcKeyword.Location)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        let ellipsisTokens = ImmutableArray.CreateBuilder[SyntaxToken?]()
        while Current.Kind != SyntaxKind.CloseParenthesisToken && Current.Kind != SyntaxKind.EndOfFileToken {
            // ADR-0102 follow-up / issue #818: per-parameter `...` marker
            // for a variadic parameter in an anonymous function-type clause.
            var ellipsis SyntaxToken? = nil
            if Current.Kind == SyntaxKind.EllipsisToken {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken)
            }
            nodesAndSeparators.Add(ParseTypeClause())
            ellipsisTokens.Add(ellipsis)
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let returnTypeClause = ParseOptionalTypeClause()
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        return TypeClauseSyntax.CreateAsyncFunction(
            syntaxTree,
            asyncModifier,
            funcKeyword,
            openParen,
            SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            returnTypeClause,
            question
        )
    }

    private func ParseFunctionTypeClause() TypeClauseSyntax {
        // Phase 4.7: function type clause `func(T1, T2, ...) R?`. The return
        // type is optional; if absent the function returns void.
        // ADR-0075 / issue #715: the `func(...) R` spelling is the legacy form
        // and is being replaced by the arrow form `(T1, T2, ...) -> R`. The
        // legacy form is still accepted during this release with a deprecation
        // warning (GS0303).
        let funcKeyword = MatchToken(SyntaxKind.FuncKeyword)
        Diagnostics.ReportFunctionTypeClauseFuncKeywordDeprecated(funcKeyword.Location)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        let ellipsisTokens = ImmutableArray.CreateBuilder[SyntaxToken?]()
        while Current.Kind != SyntaxKind.CloseParenthesisToken && Current.Kind != SyntaxKind.EndOfFileToken {
            // ADR-0102 follow-up / issue #818: per-parameter `...` marker.
            var ellipsis SyntaxToken? = nil
            if Current.Kind == SyntaxKind.EllipsisToken {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken)
            }
            nodesAndSeparators.Add(ParseTypeClause())
            ellipsisTokens.Add(ellipsis)
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let returnTypeClause = ParseOptionalTypeClause()
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        return TypeClauseSyntax.CreateLegacyFunction(
            syntaxTree,
            funcKeyword,
            openParen,
            SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            returnTypeClause,
            question
        )
    }

    private func ParseArrowFunctionTypeClause(asyncModifier SyntaxToken?) TypeClauseSyntax {
        // ADR-0075 / issue #715: canonical arrow-form function type clause
        // `[async] (T1, T2, ...) -> R [?]`. The parameter list is always
        // parenthesised (empty is OK); the arrow is mandatory; the return
        // type clause is required (use `void` or the legacy `func(...)`
        // shape for void-returning function types).
        // ADR-0102 follow-up / issue #818: any single parameter slot may
        // be prefixed with `...` to mark it as variadic. Structural rules
        // (at most one, must be last, must be `[]T`) are enforced by the
        // binder so this site only records the per-slot marker tokens.
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        let ellipsisTokens = ImmutableArray.CreateBuilder[SyntaxToken?]()
        let refKindTokens = ImmutableArray.CreateBuilder[SyntaxToken?]()
        while Current.Kind != SyntaxKind.CloseParenthesisToken && Current.Kind != SyntaxKind.EndOfFileToken {
            // Issue #3501 A2: a parameter slot may lead with the ADR-0060
            // contextual `ref`/`out`/`in` modifier — `(ref int32) -> void`.
            // The modifier is consumed only when the next token can start a
            // type clause, so a plain type named `ref`/`out`/`in` (followed
            // by `,` or `)`) still binds as the slot's type.
            var refKind SyntaxToken? = nil
            if Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text is "ref" or "out" or "in") &&
                CanStartTypeClause(Peek(1)) {
                refKind = NextToken()
            }
            var ellipsis SyntaxToken? = nil
            if Current.Kind == SyntaxKind.EllipsisToken {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken)
            }
            nodesAndSeparators.Add(ParseTypeClause())
            ellipsisTokens.Add(ellipsis)
            refKindTokens.Add(refKind)
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let arrow = MatchToken(SyntaxKind.RightArrowToken)
        let returnTypeClause = ParseTypeClause()
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        var clause TypeClauseSyntax
        if asyncModifier != nil {
            clause = TypeClauseSyntax.CreateAsyncArrowFunction(
                syntaxTree,
                asyncModifier,
                openParen,
                SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
                ellipsisTokens.ToImmutable(),
                closeParen,
                arrow,
                returnTypeClause,
                question
            )
        } else {
            clause = TypeClauseSyntax.CreateArrowFunction(
                syntaxTree,
                openParen,
                SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
                ellipsisTokens.ToImmutable(),
                closeParen,
                arrow,
                returnTypeClause,
                question
            )
        }
        // Issue #3501 A2: attach the per-slot ref-kind modifier tokens when
        // any slot carried one.
        if refKindTokens.Any((token SyntaxToken?) -> token != nil) {
            clause.FunctionParameterRefKindTokens = refKindTokens.ToImmutable()
        }
        return clause
    }

    private func ParseParenthesizedArrowFunctionTypeClause(asyncModifier SyntaxToken?) TypeClauseSyntax {
        // Issue #1399 / ADR-0137: a nullable function type is spelled by
        // parenthesizing the whole arrow function type, then applying `?`:
        // `((T) -> R)?`. Without these outer parens, `(T) -> R?` keeps the
        // nullable marker on the return type.
        let _ = MatchToken(SyntaxKind.OpenParenthesisToken)
        let inner = ParseArrowFunctionTypeClause(asyncModifier)
        let _ = MatchToken(SyntaxKind.CloseParenthesisToken)
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        var rebuilt TypeClauseSyntax
        if inner.AsyncModifier != nil {
            rebuilt = TypeClauseSyntax.CreateAsyncArrowFunction(
                syntaxTree,
                inner.AsyncModifier,
                inner.OpenParenToken,
                inner.FunctionParameterTypes,
                inner.FunctionParameterEllipsisTokens,
                inner.CloseParenToken,
                inner.ArrowToken,
                inner.ReturnTypeClause,
                question
            )
        } else {
            rebuilt = TypeClauseSyntax.CreateArrowFunction(
                syntaxTree,
                inner.OpenParenToken,
                inner.FunctionParameterTypes,
                inner.FunctionParameterEllipsisTokens,
                inner.CloseParenToken,
                inner.ArrowToken,
                inner.ReturnTypeClause,
                question
            )
        }
        // Issue #3501 A2: the rebuild must carry the inner clause's per-slot
        // ref-kind modifiers — `((ref int32) -> void)?` keeps its ref slot.
        rebuilt.FunctionParameterRefKindTokens = inner.FunctionParameterRefKindTokens
        return rebuilt
    }

    /// ADR-0095 / issue #761: parses the raw function-pointer type clause
    /// `unmanaged[CC, ...] (T1, T2, ...) -> R`. The leading
    /// `unmanaged` identifier is the contextual keyword; the
    /// `[CC]` slot is optional (ADR-0095 v2 / issue #3611 — bare
    /// `unmanaged (T) -> R` is the platform-default unmanaged
    /// convention) and accepts a comma-separated convention list. The
    /// parameter and return type-clause grammar is the same as the
    /// arrow-form function type clause (ADR-0075).
    private func ParseFunctionPointerTypeClause() TypeClauseSyntax {
        // Consume the `unmanaged` identifier as the keyword token. We
        // leave its Kind as IdentifierToken (contextual keyword); the
        // parser's role is to record the role through the dedicated
        // UnmanagedKeyword property on TypeClauseSyntax.
        let unmanagedKeyword = MatchToken(SyntaxKind.IdentifierToken)
        // ADR-0095 v2 / issue #3611: the calling-convention slot is
        // optional (bare `unmanaged (T) -> R` is the platform-default
        // unmanaged convention; GS0356 is retired) and accepts a
        // comma-separated list of convention identifiers
        // (`unmanaged[Cdecl, SuppressGCTransition] (T) -> R`). The first
        // identifier stays on the dedicated token slot; the `, identifier`
        // tail is collected in source order for the binder and printers.
        var openBracket SyntaxToken? = nil
        var callingConvention SyntaxToken? = nil
        var callingConventionRest = ImmutableArray[SyntaxToken].Empty
        var closeBracket SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenSquareBracketToken {
            openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
            callingConvention = MatchToken(SyntaxKind.IdentifierToken)
            if Current.Kind == SyntaxKind.CommaToken {
                let rest = ImmutableArray.CreateBuilder[SyntaxToken]()
                while Current.Kind == SyntaxKind.CommaToken {
                    rest.Add(MatchToken(SyntaxKind.CommaToken))
                    rest.Add(MatchToken(SyntaxKind.IdentifierToken))
                }
                callingConventionRest = rest.ToImmutable()
            }
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        }
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while Current.Kind != SyntaxKind.CloseParenthesisToken && Current.Kind != SyntaxKind.EndOfFileToken {
            nodesAndSeparators.Add(ParseTypeClause())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let arrow = MatchToken(SyntaxKind.RightArrowToken)
        let returnTypeClause = ParseTypeClause()
        return TypeClauseSyntax.CreateFunctionPointer(
            syntaxTree,
            unmanagedKeyword,
            openBracket,
            callingConvention,
            closeBracket,
            openParen,
            SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
            closeParen,
            arrow,
            returnTypeClause,
            callingConventionRest
        )
    }

    /// ADR-0122 §9 / issue #1035: parses the *managed* function-pointer type
    /// clause `*func(T1, T2, ...) R`. The leading `*` mirrors the
    /// `*T` pointer prefix and the `func(...) R` body mirrors the
    /// named function-type spelling; the return type is optional (void when
    /// absent). The result is a managed function pointer callable directly via
    /// `calli` with the default managed calling convention.
    private func ParseManagedFunctionPointerTypeClause() TypeClauseSyntax {
        let starToken = MatchToken(SyntaxKind.StarToken)
        let funcKeyword = MatchToken(SyntaxKind.FuncKeyword)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while Current.Kind != SyntaxKind.CloseParenthesisToken && Current.Kind != SyntaxKind.EndOfFileToken {
            nodesAndSeparators.Add(ParseTypeClause())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let returnTypeClause = ParseOptionalTypeClause()
        return TypeClauseSyntax.CreateManagedFunctionPointer(
            syntaxTree,
            starToken,
            funcKeyword,
            openParen,
            SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
            closeParen,
            returnTypeClause
        )
    }

    // ADR-0075 / issue #715: bounded look-ahead used in type-clause slots to
    // distinguish the arrow-form function type `(T1, T2) -> R` from a tuple
    // type `(T1, T2)`. The scan never consumes tokens — it only inspects the
    // shape of the parenthesised list to decide which grammar to apply.
    private func LooksLikeArrowFunctionTypeClauseStart() bool {
        return LooksLikeArrowFunctionTypeClauseStart(0)
    }

    private func LooksLikeParenthesizedArrowFunctionTypeClauseStart() bool {
        if Current.Kind != SyntaxKind.OpenParenthesisToken || Peek(1).Kind != SyntaxKind.OpenParenthesisToken ||
            !LooksLikeArrowFunctionTypeClauseStart(1) {
            return false
        }
        // Issue #3639: the ADR-0137 parenthesized form `((T) -> R)?` wraps
        // EXACTLY ONE arrow type — the outer group never contains a top-level
        // comma. When it does, the outer parens are a TUPLE type whose first
        // element happens to be a parenthesized arrow type
        // (`((int32) -> int32, (int32) -> int32)`), so fall through to the
        // tuple-type parse, whose element parses re-dispatch on the arrow
        // look-ahead per element. Only the comma flag matters here — the
        // scan's arrow verdict is about the token AFTER the outer group.
        let _ = LooksLikeArrowFunctionTypeClauseStart(0, out var outerHasTopLevelComma)
        return !outerHasTopLevelComma
    }

    private func LooksLikeArrowFunctionTypeClauseStart(startOffset int32) bool {
        return LooksLikeArrowFunctionTypeClauseStart(startOffset, out _)
    }

    private func LooksLikeArrowFunctionTypeClauseStart(startOffset int32, out hasTopLevelComma bool) bool {
        hasTopLevelComma = false
        if Peek(startOffset).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        var parenDepth = 1
        var bracketDepth = 0
        var braceDepth = 0
        var offset = startOffset + 1
        var atElementStart = true
        var sawNamedElement = false
        const maxScan = 4096
        while offset < maxScan {
            let k = Peek(offset).Kind
            if k == SyntaxKind.EndOfFileToken {
                return false
            }
            // Issue #5191 / ADR-0172: an arrow function type lists bare
            // parameter types, so an element written `name Type` can only be
            // a named tuple element. The `ref`/`out`/`in` parameter modifiers
            // also lead with an identifier and stay function-type slots.
            if atElementStart &&
                parenDepth == 1 &&
                bracketDepth == 0 &&
                braceDepth == 0 &&
                k == SyntaxKind.IdentifierToken &&
                LooksLikeTupleElementName(offset) &&
                !((Peek(offset).Text is "ref" or "out" or "in") && CanStartTypeClause(Peek(offset + 1))) {
                sawNamedElement = true
            }
            atElementStart = false
            if k == SyntaxKind.OpenParenthesisToken {
                parenDepth++
            } else if k == SyntaxKind.CloseParenthesisToken {
                if bracketDepth == 0 && braceDepth == 0 {
                    parenDepth--
                    if parenDepth == 0 {
                        break
                    }
                } else {
                    parenDepth--
                }
            } else if k == SyntaxKind.OpenSquareBracketToken {
                bracketDepth++
            } else if k == SyntaxKind.CloseSquareBracketToken {
                if bracketDepth > 0 {
                    bracketDepth--
                }
            } else if k == SyntaxKind.OpenBraceToken {
                braceDepth++
            } else if k == SyntaxKind.CloseBraceToken {
                if braceDepth > 0 {
                    braceDepth--
                }
            } else if k == SyntaxKind.CommaToken && parenDepth == 1 && bracketDepth == 0 && braceDepth == 0 {
                hasTopLevelComma = true
                atElementStart = true
            }
            offset++
        }
        if parenDepth != 0 || sawNamedElement {
            return false
        }
        // Peek(offset) is the closing `)`. Commit to the arrow-form function
        // type clause iff the next token is `->`.
        return Peek(offset + 1).Kind == SyntaxKind.RightArrowToken
    }

    private func ParseOptionalTypeClause() TypeClauseSyntax? {
        if !CanStartTypeClause(Current) {
            return nil
        }
        // ADR-0067 / issue #694: when an identifier in return-type position is a
        // contextual member-position keyword (`event`, `prop`, `init`,
        // `convenience`, `shared`), it actually starts the NEXT member of the
        // enclosing type body — not a return type for the current `func(...)`
        // clause. Bail out so the enclosing struct/class parser can dispatch on
        // the contextual keyword.
        if Current.Kind == SyntaxKind.IdentifierToken && IsContextualMemberKeyword(Current.Text) {
            return nil
        }
        return ParseTypeClause()
    }

    /// Issue #526 / #1506: the decomposed tail of a dotted type-clause name (everything
    /// after the first identifier). The last segment's type-argument list is stored in the
    /// `Trailing*` fields (the historical single-trailing representation); the per-segment
    /// lists of every earlier (outer) segment are stored in the `OuterSegment*` arrays,
    /// aligned to the segment sequence (index 0 = the first identifier).
    private struct DottedTypeNameTail {
        init(
            dots ImmutableArray[SyntaxToken],
            identifiers ImmutableArray[SyntaxToken],
            trailingTypeArgumentOpen SyntaxToken?,
            trailingTypeArguments SeparatedSyntaxList[TypeClauseSyntax]?,
            trailingTypeArgumentClose SyntaxToken?,
            outerSegmentTypeArgumentOpens ImmutableArray[SyntaxToken?],
            outerSegmentTypeArgumentLists ImmutableArray[SeparatedSyntaxList[TypeClauseSyntax]?],
            outerSegmentTypeArgumentCloses ImmutableArray[SyntaxToken?]
        ) {
            Dots = dots
            Identifiers = identifiers
            TrailingTypeArgumentOpen = trailingTypeArgumentOpen
            TrailingTypeArguments = trailingTypeArguments
            TrailingTypeArgumentClose = trailingTypeArgumentClose
            OuterSegmentTypeArgumentOpens = outerSegmentTypeArgumentOpens
            OuterSegmentTypeArgumentLists = outerSegmentTypeArgumentLists
            OuterSegmentTypeArgumentCloses = outerSegmentTypeArgumentCloses
        }

        prop Dots ImmutableArray[SyntaxToken] {
            get;
        }

        prop Identifiers ImmutableArray[SyntaxToken] {
            get;
        }

        prop TrailingTypeArgumentOpen SyntaxToken? {
            get;
        }

        prop TrailingTypeArguments SeparatedSyntaxList[TypeClauseSyntax]? {
            get;
        }

        prop TrailingTypeArgumentClose SyntaxToken? {
            get;
        }

        prop OuterSegmentTypeArgumentOpens ImmutableArray[SyntaxToken?] {
            get;
        }

        prop OuterSegmentTypeArgumentLists ImmutableArray[SeparatedSyntaxList[TypeClauseSyntax]?] {
            get;
        }

        prop OuterSegmentTypeArgumentCloses ImmutableArray[SyntaxToken?] {
            get;
        }
    }

    shared {
        private func IsContextualMemberKeyword(text string) bool {
            return text == "event" || text == "prop" || text == "init" || text == "convenience" || text == "shared"
        }
    }
}
