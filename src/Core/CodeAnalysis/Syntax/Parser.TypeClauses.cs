// <copyright file="Parser.TypeClauses.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

public partial class Parser
{
    // Issue #1602: depth-guarded wrapper — type clauses self-nest through
    // pointers (`*T`), arrays (`[]T`), tuples, function types, and generic
    // type-argument lists (`List[List[…]]`).
    private TypeClauseSyntax ParseTypeClause()
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseTypeClauseCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private TypeClauseSyntax ParseTypeClauseCore()
    {
        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseFunctionTypeClause();
        }

        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            // ADR-0075 / issue #715: the canonical function-type clause is
            // `(T1, T2, ...) -> R`. Disambiguated from a tuple type clause by
            // bounded look-ahead — if the matching `)` is immediately followed
            // by `->`, we commit to the arrow function form; otherwise fall
            // back to the long-standing tuple-type parse.
            if (LooksLikeArrowFunctionTypeClauseStart())
            {
                return ParseArrowFunctionTypeClause(asyncModifier: null);
            }

            if (LooksLikeParenthesizedArrowFunctionTypeClauseStart())
            {
                return ParseParenthesizedArrowFunctionTypeClause(asyncModifier: null);
            }

            return ParseTupleTypeClause();
        }

        if (Current.Kind == SyntaxKind.MapKeyword)
        {
            return ParseMapTypeClause();
        }

        if (Current.Kind == SyntaxKind.ChanKeyword)
        {
            return ParseChanTypeClause();
        }

        // ADR-0040: sequence type `sequence[T]` — alias for IEnumerable[T].
        if (Current.Kind == SyntaxKind.SequenceKeyword)
        {
            return ParseSequenceTypeClause();
        }

        // ADR-0042 / ADR-0043: `async` as a type-clause prefix is reserved for
        // `async sequence[T]` (alias for IAsyncEnumerable[T]) and
        // `async func(P) R` (alias for func(P) Task[R]). All other forms are
        // rejected with a diagnostic.
        if (Current.Kind == SyntaxKind.AsyncKeyword)
        {
            return ParseAsyncPrefixedTypeClause();
        }

        // ADR-0095 / issue #761: raw function-pointer type clause
        // `unmanaged[CC] (T1, T2, ...) -> R`. `unmanaged` is a contextual
        // keyword — we only commit to this shape when it appears at the
        // start of a type-clause position followed by `[` or `(`. Plain
        // identifiers named `unmanaged` (e.g. a struct member or local)
        // are unaffected because they never reach this parser entry.
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "unmanaged"
            && (Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
                || Peek(1).Kind == SyntaxKind.OpenParenthesisToken))
        {
            return ParseFunctionPointerTypeClause();
        }

        // ADR-0039: pointer type `*T` in type-annotation position.
        if (Current.Kind == SyntaxKind.StarToken)
        {
            // ADR-0122 §9 / issue #1035: a *managed* function pointer is
            // spelled `*func(T1, T2) R` — the `*` pointer prefix followed by
            // the `func(...) R` signature. It is consistent with the `*T`
            // pointer syntax and is callable directly via `calli`. We commit
            // to this shape only when `*` is immediately followed by `func`.
            if (Peek(1).Kind == SyntaxKind.FuncKeyword)
            {
                return ParseManagedFunctionPointerTypeClause();
            }

            var star = NextToken();
            var pointee = ParseTypeClause();
            var ptrQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
            return TypeClauseSyntax.CreatePointer(syntaxTree, star, pointee, ptrQuestion);
        }

        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            SyntaxToken length = null;
            if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
            {
                length = MatchToken(SyntaxKind.NumberToken);
            }

            var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);

            // Issue #1351: a nullable array whose element type is itself an
            // array spells the element with a leading `[`. The lexer greedily
            // fuses the nullability `?` and that `[` into a single
            // `?[` (`QuestionOpenBracketToken`). Split it back into `?` + `[`
            // so the nullable marker is consumed below and the recursive
            // element parse sees the nested array's open bracket.
            if (Current.Kind == SyntaxKind.QuestionOpenBracketToken)
            {
                SplitQuestionOpenBracketToken();
            }

            // Issue #1212: a `?` placed immediately after the `]` (before the
            // element type) marks the *whole array reference* nullable —
            // `[]?T` / `[N]?T` is `([]T)?`. This is distinct from a trailing
            // `?` after the element (`[]T?`), which binds to the element type.
            var arrayNullableQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;

            // Issue #1046: a jagged/nested array element — the element type is
            // itself a non-identifier type clause (`[][]T`, `[]*T`, `[]map[K,V]`,
            // `[]chan T`, `[]func(...) R`, `[](T1, T2)`, …). When the token after
            // `]` does not begin a plain (possibly dotted/generic) identifier
            // element, parse the element recursively and store it as a nested
            // type clause via `TypeClauseSyntax.CreateArray`. The common
            // `[]Identifier`/`[]Foo.Bar`/`[]List[int32]` forms keep the existing
            // flat representation so nothing regresses.
            if (Current.Kind != SyntaxKind.IdentifierToken)
            {
                var nestedElement = ParseTypeClause();
                var nestedQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
                return TypeClauseSyntax.CreateArray(
                    syntaxTree,
                    openBracket,
                    length,
                    closeBracket,
                    nestedElement,
                    nestedQuestion,
                    arrayNullableQuestion);
            }

            var elementIdentifier = MatchToken(SyntaxKind.IdentifierToken);

            // Issue #526 / #1506: an array/slice of a (possibly nested, possibly
            // per-segment generic) named type — `[]Outer.Inner`, `[]List[int32]`,
            // `[]List[int32].Enumerator`. The dotted-name tail records a
            // type-argument list per segment so an outer segment can be generic
            // and still dot into a nested type.
            var arrayTail = ParseDottedTypeNameTail();

            var arrayQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
            return new TypeClauseSyntax(
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
                arrayTail.OuterSegmentTypeArgumentCloses);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #526 / #1506: a dotted-qualifier chain `Outer.Inner` (or `A.B.C`)
        // names a nested type. Each segment may carry its own type-argument list
        // so an OUTER segment can be generic and then dot into a nested type
        // (`List[int32].Enumerator`, `A[T].B[U].C`); the list on the LAST segment
        // continues to be tracked by `TypeArguments` for backwards compatibility.
        var tail = ParseDottedTypeNameTail();

        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier,
            tail.Dots,
            tail.Identifiers,
            tail.TrailingTypeArgumentOpen,
            tail.TrailingTypeArguments,
            tail.TrailingTypeArgumentClose,
            question,
            arrayQuestionToken: null,
            tail.OuterSegmentTypeArgumentOpens,
            tail.OuterSegmentTypeArgumentLists,
            tail.OuterSegmentTypeArgumentCloses);
    }

    /// <summary>
    /// Issue #526 / #1506: consumes the tail of a dotted type-clause name, starting
    /// immediately after the first (already-consumed) identifier. Each segment may
    /// carry its own optional <c>[ T1, ... ]</c> type-argument list, generalizing
    /// <c>Outer[T].Inner</c>, <c>A[T].B[U].C</c>, and the legacy single-trailing-list
    /// forms. The last segment's type-argument list is returned via the
    /// <c>Trailing*</c> fields (matching the historical <see cref="TypeClauseSyntax.TypeArguments"/>
    /// representation); every earlier (outer) segment's list is returned via the
    /// <c>OuterSegment*</c> arrays, aligned to the segment sequence. Lookahead-only on
    /// <c>. IDENT</c> so a member access on a value-typed identifier is never miscounted
    /// as a qualifier.
    /// </summary>
    /// <returns>The decomposed dotted-name tail.</returns>
    private DottedTypeNameTail ParseDottedTypeNameTail()
    {
        var dots = ImmutableArray.CreateBuilder<SyntaxToken>();
        var identifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
        var segmentOpens = new System.Collections.Generic.List<SyntaxToken>();
        var segmentLists = new System.Collections.Generic.List<SeparatedSyntaxList<TypeClauseSyntax>>();
        var segmentCloses = new System.Collections.Generic.List<SyntaxToken>();

        // Segment 0 (the already-consumed first identifier): optional `[ ... ]`.
        ParseOptionalSegmentTypeArguments(out var firstOpen, out var firstList, out var firstClose);
        segmentOpens.Add(firstOpen);
        segmentLists.Add(firstList);
        segmentCloses.Add(firstClose);

        while (Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            dots.Add(NextToken());
            identifiers.Add(NextToken());
            ParseOptionalSegmentTypeArguments(out var segOpen, out var segList, out var segClose);
            segmentOpens.Add(segOpen);
            segmentLists.Add(segList);
            segmentCloses.Add(segClose);
        }

        var lastIndex = segmentOpens.Count - 1;
        var outerOpens = ImmutableArray.CreateBuilder<SyntaxToken>(lastIndex);
        var outerLists = ImmutableArray.CreateBuilder<SeparatedSyntaxList<TypeClauseSyntax>>(lastIndex);
        var outerCloses = ImmutableArray.CreateBuilder<SyntaxToken>(lastIndex);
        for (var i = 0; i < lastIndex; i++)
        {
            outerOpens.Add(segmentOpens[i]);
            outerLists.Add(segmentLists[i]);
            outerCloses.Add(segmentCloses[i]);
        }

        return new DottedTypeNameTail(
            dots.ToImmutable(),
            identifiers.ToImmutable(),
            segmentOpens[lastIndex],
            segmentLists[lastIndex],
            segmentCloses[lastIndex],
            outerOpens.ToImmutable(),
            outerLists.ToImmutable(),
            outerCloses.ToImmutable());
    }

    /// <summary>
    /// Parses an optional type-argument list <c>[ T1, T2, ... ]</c> in type position
    /// (issue #1506). Leaves the parser unchanged and emits all-<c>null</c> outputs when
    /// the current token does not open a list.
    /// </summary>
    /// <param name="open">The opening <c>[</c>, or <c>null</c>.</param>
    /// <param name="list">The argument list, or <c>null</c>.</param>
    /// <param name="close">The closing <c>]</c>, or <c>null</c>.</param>
    private void ParseOptionalSegmentTypeArguments(
        out SyntaxToken open,
        out SeparatedSyntaxList<TypeClauseSyntax> list,
        out SyntaxToken close)
    {
        open = null;
        list = null;
        close = null;
        if (Current.Kind != SyntaxKind.OpenSquareBracketToken)
        {
            return;
        }

        open = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseSquareBracketToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        list = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
        close = MatchToken(SyntaxKind.CloseSquareBracketToken);
    }

    private TypeClauseSyntax ParseTupleTypeClause()
    {
        // Phase 4.5: tuple type clause `(T1, T2, ...)` with optional trailing `?`.
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNext = true;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            question);
    }

    private TypeClauseSyntax ParseMapTypeClause()
    {
        // ADR-0104 / issue #805: canonical map type clause `map[K,V]` with optional trailing `?`.
        // For one release we still *recognize* the legacy Go-flavored shape
        // `map[K]V` so we can emit GS0366 with a span-accurate "did you mean
        // 'map[K,V]'?" diagnostic, then bind it as if the new spelling had
        // been written. No deprecation window — this is the breaking change
        // for v0.2 called out in ADR-0104.
        var mapKeyword = MatchToken(SyntaxKind.MapKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var keyType = ParseTypeClause();

        SyntaxToken commaToken = null;
        SyntaxToken closeBracket;
        TypeClauseSyntax valueType;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            commaToken = MatchToken(SyntaxKind.CommaToken);
            valueType = ParseTypeClause();
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        }
        else
        {
            // Legacy `map[K]V` shape: consume the close-bracket, then the
            // value type that follows, then point GS0366 at the whole span.
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
            valueType = ParseTypeClause();

            var legacySpan = TextSpan.FromBounds(mapKeyword.Span.Start, valueType.Span.End);
            var legacyLocation = new TextLocation(syntaxTree.Text, legacySpan);
            var keyText = syntaxTree.Text.ToString(keyType.Span);
            var valueText = syntaxTree.Text.ToString(valueType.Span);
            Diagnostics.ReportLegacyMapTypeClauseSyntax(legacyLocation, keyText, valueText);
        }

        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            mapKeyword,
            openBracket,
            keyType,
            commaToken,
            valueType,
            closeBracket,
            question);
    }

    private TypeClauseSyntax ParseChanTypeClause()
    {
        // Phase 5.4 / ADR-0022: channel type clause `chan T` with optional trailing `?`.
        var chanKeyword = MatchToken(SyntaxKind.ChanKeyword);
        var elementType = ParseTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(syntaxTree, chanKeyword, elementType, question);
    }

    private TypeClauseSyntax ParseSequenceTypeClause()
    {
        // ADR-0040: sequence type clause `sequence[T]` with optional trailing `?`.
        var sequenceKeyword = MatchToken(SyntaxKind.SequenceKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var elementType = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateSequence(syntaxTree, sequenceKeyword, openBracket, elementType, closeBracket, question);
    }

    private TypeClauseSyntax ParseAsyncPrefixedTypeClause()
    {
        // ADR-0042: `async sequence[T]` — alias for IAsyncEnumerable[T].
        // ADR-0043: `async func(P) R` — alias for func(P) Task[R] (deprecated, ADR-0075).
        // ADR-0075: `async (P) -> R` — canonical arrow-form async function type clause.
        // No other form is legal as an `async`-prefixed type clause.
        var asyncModifier = MatchToken(SyntaxKind.AsyncKeyword);

        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            return ParseAsyncFunctionTypeClause(asyncModifier);
        }

        // ADR-0075: arrow-form async function type clause `async (T) -> R`.
        if (Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeArrowFunctionTypeClauseStart())
        {
            return ParseArrowFunctionTypeClause(asyncModifier);
        }

        if (Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeParenthesizedArrowFunctionTypeClauseStart())
        {
            return ParseParenthesizedArrowFunctionTypeClause(asyncModifier);
        }

        if (Current.Kind != SyntaxKind.SequenceKeyword)
        {
            Diagnostics.ReportAsyncModifierInTypeClauseRequiresSequenceOrFunc(asyncModifier.Location, Current.Kind);
        }

        var sequenceKeyword = MatchToken(SyntaxKind.SequenceKeyword);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var elementType = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateAsyncSequence(syntaxTree, asyncModifier, sequenceKeyword, openBracket, elementType, closeBracket, question);
    }

    private TypeClauseSyntax ParseAsyncFunctionTypeClause(SyntaxToken asyncModifier)
    {
        // ADR-0043: `async func(P) R` is a synonym for `func(P) Task[R]`
        // (with carve-outs for void → Task and IAsyncEnumerable[T] → unchanged).
        // ADR-0075 / issue #715: the `func(...)` spelling is deprecated in
        // type position — emit GS0303 so the migrate-to-arrow-form signal
        // surfaces uniformly.
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        Diagnostics.ReportFunctionTypeClauseFuncKeywordDeprecated(funcKeyword.Location);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var ellipsisTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // ADR-0102 follow-up / issue #818: per-parameter `...` marker
            // for a variadic parameter in an anonymous function-type clause.
            SyntaxToken ellipsis = null;
            if (Current.Kind == SyntaxKind.EllipsisToken)
            {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken);
            }

            nodesAndSeparators.Add(ParseTypeClause());
            ellipsisTokens.Add(ellipsis);
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateAsyncFunction(
            syntaxTree,
            asyncModifier,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            returnTypeClause,
            question);
    }

    private TypeClauseSyntax ParseFunctionTypeClause()
    {
        // Phase 4.7: function type clause `func(T1, T2, ...) R?`. The return
        // type is optional; if absent the function returns void.
        // ADR-0075 / issue #715: the `func(...) R` spelling is the legacy form
        // and is being replaced by the arrow form `(T1, T2, ...) -> R`. The
        // legacy form is still accepted during this release with a deprecation
        // warning (GS0303).
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        Diagnostics.ReportFunctionTypeClauseFuncKeywordDeprecated(funcKeyword.Location);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var ellipsisTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // ADR-0102 follow-up / issue #818: per-parameter `...` marker.
            SyntaxToken ellipsis = null;
            if (Current.Kind == SyntaxKind.EllipsisToken)
            {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken);
            }

            nodesAndSeparators.Add(ParseTypeClause());
            ellipsisTokens.Add(ellipsis);
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return TypeClauseSyntax.CreateLegacyFunction(
            syntaxTree,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            returnTypeClause,
            question);
    }

    private TypeClauseSyntax ParseArrowFunctionTypeClause(SyntaxToken asyncModifier)
    {
        // ADR-0075 / issue #715: canonical arrow-form function type clause
        // `[async] (T1, T2, ...) -> R [?]`. The parameter list is always
        // parenthesised (empty is OK); the arrow is mandatory; the return
        // type clause is required (use `void` or the legacy `func(...)`
        // shape for void-returning function types).
        // ADR-0102 follow-up / issue #818: any single parameter slot may
        // be prefixed with `...` to mark it as variadic. Structural rules
        // (at most one, must be last, must be `[]T`) are enforced by the
        // binder so this site only records the per-slot marker tokens.
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var ellipsisTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        while (Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            SyntaxToken ellipsis = null;
            if (Current.Kind == SyntaxKind.EllipsisToken)
            {
                ellipsis = MatchToken(SyntaxKind.EllipsisToken);
            }

            nodesAndSeparators.Add(ParseTypeClause());
            ellipsisTokens.Add(ellipsis);
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var returnTypeClause = ParseTypeClause();
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        if (asyncModifier != null)
        {
            return TypeClauseSyntax.CreateAsyncArrowFunction(
                syntaxTree,
                asyncModifier,
                openParen,
                new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
                ellipsisTokens.ToImmutable(),
                closeParen,
                arrow,
                returnTypeClause,
                question);
        }

        return TypeClauseSyntax.CreateArrowFunction(
            syntaxTree,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            ellipsisTokens.ToImmutable(),
            closeParen,
            arrow,
            returnTypeClause,
            question);
    }

    private TypeClauseSyntax ParseParenthesizedArrowFunctionTypeClause(SyntaxToken asyncModifier)
    {
        // Issue #1399 / ADR-0137: a nullable function type is spelled by
        // parenthesizing the whole arrow function type, then applying `?`:
        // `((T) -> R)?`. Without these outer parens, `(T) -> R?` keeps the
        // nullable marker on the return type.
        _ = MatchToken(SyntaxKind.OpenParenthesisToken);
        var inner = ParseArrowFunctionTypeClause(asyncModifier);
        _ = MatchToken(SyntaxKind.CloseParenthesisToken);
        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;

        if (inner.AsyncModifier != null)
        {
            return TypeClauseSyntax.CreateAsyncArrowFunction(
                syntaxTree,
                inner.AsyncModifier,
                inner.OpenParenToken,
                inner.FunctionParameterTypes,
                inner.FunctionParameterEllipsisTokens,
                inner.CloseParenToken,
                inner.ArrowToken,
                inner.ReturnTypeClause,
                question);
        }

        return TypeClauseSyntax.CreateArrowFunction(
            syntaxTree,
            inner.OpenParenToken,
            inner.FunctionParameterTypes,
            inner.FunctionParameterEllipsisTokens,
            inner.CloseParenToken,
            inner.ArrowToken,
            inner.ReturnTypeClause,
            question);
    }

    /// <summary>
    /// ADR-0095 / issue #761: parses the raw function-pointer type clause
    /// <c>unmanaged[CC] (T1, T2, ...) -&gt; R</c>. The leading
    /// <c>unmanaged</c> identifier is the contextual keyword; the
    /// <c>[CC]</c> slot is required (omitting it produces GS0356 and the
    /// parser fabricates a missing identifier so recovery continues on
    /// the inner signature). The parameter and return type-clause grammar
    /// is the same as the arrow-form function type clause (ADR-0075).
    /// </summary>
    private TypeClauseSyntax ParseFunctionPointerTypeClause()
    {
        // Consume the `unmanaged` identifier as the keyword token. We
        // leave its Kind as IdentifierToken (contextual keyword); the
        // parser's role is to record the role through the dedicated
        // UnmanagedKeyword property on TypeClauseSyntax.
        var unmanagedKeyword = MatchToken(SyntaxKind.IdentifierToken);

        SyntaxToken openBracket = null;
        SyntaxToken callingConvention = null;
        SyntaxToken closeBracket = null;
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            callingConvention = MatchToken(SyntaxKind.IdentifierToken);
            closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        }
        else
        {
            // ADR-0095 §5 — GS0356: the calling-convention slot is
            // required. Report at the `unmanaged` keyword location so the
            // user sees both the keyword and the proposed remediation.
            Diagnostics.ReportFunctionPointerMissingCallingConvention(unmanagedKeyword.Location);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseParenthesisToken
            && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var returnTypeClause = ParseTypeClause();

        return TypeClauseSyntax.CreateFunctionPointer(
            syntaxTree,
            unmanagedKeyword,
            openBracket,
            callingConvention,
            closeBracket,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            arrow,
            returnTypeClause);
    }

    /// <summary>
    /// ADR-0122 §9 / issue #1035: parses the *managed* function-pointer type
    /// clause <c>*func(T1, T2, ...) R</c>. The leading <c>*</c> mirrors the
    /// <c>*T</c> pointer prefix and the <c>func(...) R</c> body mirrors the
    /// named function-type spelling; the return type is optional (void when
    /// absent). The result is a managed function pointer callable directly via
    /// <c>calli</c> with the default managed calling convention.
    /// </summary>
    private TypeClauseSyntax ParseManagedFunctionPointerTypeClause()
    {
        var starToken = MatchToken(SyntaxKind.StarToken);
        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseParenthesisToken
            && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnTypeClause = ParseOptionalTypeClause();

        return TypeClauseSyntax.CreateManagedFunctionPointer(
            syntaxTree,
            starToken,
            funcKeyword,
            openParen,
            new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()),
            closeParen,
            returnTypeClause);
    }

    // ADR-0075 / issue #715: bounded look-ahead used in type-clause slots to
    // distinguish the arrow-form function type `(T1, T2) -> R` from a tuple
    // type `(T1, T2)`. The scan never consumes tokens — it only inspects the
    // shape of the parenthesised list to decide which grammar to apply.
    private bool LooksLikeArrowFunctionTypeClauseStart()
    {
        return LooksLikeArrowFunctionTypeClauseStart(0);
    }

    private bool LooksLikeParenthesizedArrowFunctionTypeClauseStart()
    {
        return Current.Kind == SyntaxKind.OpenParenthesisToken
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
            && LooksLikeArrowFunctionTypeClauseStart(1);
    }

    private bool LooksLikeArrowFunctionTypeClauseStart(int startOffset)
    {
        if (Peek(startOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var parenDepth = 1;
        var bracketDepth = 0;
        var braceDepth = 0;
        var offset = startOffset + 1;
        const int maxScan = 4096;
        while (offset < maxScan)
        {
            var k = Peek(offset).Kind;
            if (k == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                parenDepth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken)
            {
                if (bracketDepth == 0 && braceDepth == 0)
                {
                    parenDepth--;
                    if (parenDepth == 0)
                    {
                        break;
                    }
                }
                else
                {
                    parenDepth--;
                }
            }
            else if (k == SyntaxKind.OpenSquareBracketToken)
            {
                bracketDepth++;
            }
            else if (k == SyntaxKind.CloseSquareBracketToken)
            {
                if (bracketDepth > 0)
                {
                    bracketDepth--;
                }
            }
            else if (k == SyntaxKind.OpenBraceToken)
            {
                braceDepth++;
            }
            else if (k == SyntaxKind.CloseBraceToken)
            {
                if (braceDepth > 0)
                {
                    braceDepth--;
                }
            }

            offset++;
        }

        if (parenDepth != 0)
        {
            return false;
        }

        // Peek(offset) is the closing `)`. Commit to the arrow-form function
        // type clause iff the next token is `->`.
        return Peek(offset + 1).Kind == SyntaxKind.RightArrowToken;
    }

    private TypeClauseSyntax ParseOptionalTypeClause()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken &&
            Current.Kind != SyntaxKind.OpenSquareBracketToken &&
            Current.Kind != SyntaxKind.OpenParenthesisToken &&
            Current.Kind != SyntaxKind.FuncKeyword &&
            Current.Kind != SyntaxKind.MapKeyword &&
            Current.Kind != SyntaxKind.ChanKeyword &&
            Current.Kind != SyntaxKind.SequenceKeyword &&
            Current.Kind != SyntaxKind.AsyncKeyword &&
            Current.Kind != SyntaxKind.StarToken)
        {
            return null;
        }

        // ADR-0067 / issue #694: when an identifier in return-type position is a
        // contextual member-position keyword (`event`, `prop`, `init`,
        // `convenience`, `shared`), it actually starts the NEXT member of the
        // enclosing type body — not a return type for the current `func(...)`
        // clause. Bail out so the enclosing struct/class parser can dispatch on
        // the contextual keyword.
        if (Current.Kind == SyntaxKind.IdentifierToken && IsContextualMemberKeyword(Current.Text))
        {
            return null;
        }

        return ParseTypeClause();
    }

    private static bool IsContextualMemberKeyword(string text)
    {
        return text == "event"
            || text == "prop"
            || text == "init"
            || text == "convenience"
            || text == "shared";
    }

    /// <summary>
    /// Issue #526 / #1506: the decomposed tail of a dotted type-clause name (everything
    /// after the first identifier). The last segment's type-argument list is stored in the
    /// <c>Trailing*</c> fields (the historical single-trailing representation); the per-segment
    /// lists of every earlier (outer) segment are stored in the <c>OuterSegment*</c> arrays,
    /// aligned to the segment sequence (index 0 = the first identifier).
    /// </summary>
    private readonly struct DottedTypeNameTail
    {
        public DottedTypeNameTail(
            ImmutableArray<SyntaxToken> dots,
            ImmutableArray<SyntaxToken> identifiers,
            SyntaxToken trailingTypeArgumentOpen,
            SeparatedSyntaxList<TypeClauseSyntax> trailingTypeArguments,
            SyntaxToken trailingTypeArgumentClose,
            ImmutableArray<SyntaxToken> outerSegmentTypeArgumentOpens,
            ImmutableArray<SeparatedSyntaxList<TypeClauseSyntax>> outerSegmentTypeArgumentLists,
            ImmutableArray<SyntaxToken> outerSegmentTypeArgumentCloses)
        {
            Dots = dots;
            Identifiers = identifiers;
            TrailingTypeArgumentOpen = trailingTypeArgumentOpen;
            TrailingTypeArguments = trailingTypeArguments;
            TrailingTypeArgumentClose = trailingTypeArgumentClose;
            OuterSegmentTypeArgumentOpens = outerSegmentTypeArgumentOpens;
            OuterSegmentTypeArgumentLists = outerSegmentTypeArgumentLists;
            OuterSegmentTypeArgumentCloses = outerSegmentTypeArgumentCloses;
        }

        public ImmutableArray<SyntaxToken> Dots { get; }

        public ImmutableArray<SyntaxToken> Identifiers { get; }

        public SyntaxToken TrailingTypeArgumentOpen { get; }

        public SeparatedSyntaxList<TypeClauseSyntax> TrailingTypeArguments { get; }

        public SyntaxToken TrailingTypeArgumentClose { get; }

        public ImmutableArray<SyntaxToken> OuterSegmentTypeArgumentOpens { get; }

        public ImmutableArray<SeparatedSyntaxList<TypeClauseSyntax>> OuterSegmentTypeArgumentLists { get; }

        public ImmutableArray<SyntaxToken> OuterSegmentTypeArgumentCloses { get; }
    }
}
