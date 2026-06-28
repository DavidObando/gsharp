// <copyright file="Parser.Types.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language parser.
/// </summary>

public partial class Parser
{


    private static string RenderTypeParameterList(TypeParameterListSyntax list)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append('[');
        var first = true;
        foreach (var p in list.Parameters)
        {
            if (!first)
            {
                sb.Append(", ");
            }

            sb.Append(p.Identifier.Text);
            if (p.Constraint != null)
            {
                sb.Append(' ');
                sb.Append(p.Constraint.Text);
            }

            first = false;
        }

        sb.Append(']');
        return sb.ToString();
    }

    /// <summary>
    /// Returns true when <paramref name="token"/> can start a TypeClauseSyntax.
    /// Used by the delegate declaration parser to decide whether the optional
    /// return type clause is present.
    /// </summary>
    private static bool CanStartTypeClause(SyntaxToken token)
    {
        switch (token.Kind)
        {
            case SyntaxKind.IdentifierToken:
            case SyntaxKind.FuncKeyword:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.MapKeyword:
            case SyntaxKind.ChanKeyword:
            case SyntaxKind.SequenceKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.StarToken:
                return true;
            default:
                return false;
        }
    }

    private TypeParameterListSyntax ParseOptionalTypeParameterList()
    {
        // Phase 4.1 / ADR-0020: a generic type-parameter list `[T any, U any]`
        // appears immediately after the declared name of func/class/struct/
        // data struct/interface. The token following the name is unambiguously
        // either `[` (TPs) or `(` / `{` / type clause (no TPs).
        if (Current.Kind != SyntaxKind.OpenSquareBracketToken || !LooksLikeTypeParameterList())
        {
            return null;
        }

        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNext = true;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseSquareBracketToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeParameter());

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new TypeParameterListSyntax(syntaxTree, openBracket, new SeparatedSyntaxList<TypeParameterSyntax>(nodesAndSeparators.ToImmutable()), closeBracket);
    }

    private bool LooksLikeTypeParameterList()
    {
        // We are positioned at `[`. A type parameter list looks like
        // `[ Ident (Ident|class|struct|init())? ( , ... )* ]`. Crucially the *first*
        // token after `[` is an identifier (not a number, ']', or another '['). That
        // alone is enough to disambiguate against `[]T` (slice) and `[N]T` (array shape)
        // which appear in type positions, not after declaration names anyway.
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        // Also reject the corner case `[ Ident ]` where the bracketed segment
        // is followed by a token that would make it look like a type clause
        // (e.g. `[ Ident ] Ident` -> slice/array shape used somewhere we
        // shouldn't be). At a declaration header the follow-set after the TP
        // list is `(`, so we just look for that.
        //
        // ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
        // issue #997): also skip `class`, `struct`, and `init()` constraint
        // tokens that may appear after the type-parameter name.
        var ahead = 2;
        while (true)
        {
            var k = Peek(ahead).Kind;
            if (k == SyntaxKind.IdentifierToken || k == SyntaxKind.ClassKeyword || k == SyntaxKind.StructKeyword)
            {
                // `init` is lexed as an identifier; consume an optional `()` pair
                // when this identifier is the contextual `init` constraint keyword.
                if (k == SyntaxKind.IdentifierToken
                    && Peek(ahead).Text == "init"
                    && Peek(ahead + 1).Kind == SyntaxKind.OpenParenthesisToken
                    && Peek(ahead + 2).Kind == SyntaxKind.CloseParenthesisToken)
                {
                    ahead += 3;
                    continue;
                }

                ahead++;
                continue;
            }

            // ADR-0089 / issue #943: a constraint identifier may carry a generic
            // type-argument list (e.g. the curiously-recurring `[T IComparable[T]]`).
            // Skip the balanced `[ ... ]` segment so the disambiguation following
            // it (a `,` between type parameters or the closing `]` of the whole
            // type-parameter list) is examined against the right token.
            if (k == SyntaxKind.OpenSquareBracketToken)
            {
                var depth = 0;
                while (true)
                {
                    var inner = Peek(ahead).Kind;
                    if (inner == SyntaxKind.EndOfFileToken)
                    {
                        return false;
                    }

                    if (inner == SyntaxKind.OpenSquareBracketToken)
                    {
                        depth++;
                    }
                    else if (inner == SyntaxKind.CloseSquareBracketToken)
                    {
                        depth--;
                        if (depth == 0)
                        {
                            ahead++;
                            break;
                        }
                    }

                    ahead++;
                }

                continue;
            }

            break;
        }

        if (Peek(ahead).Kind == SyntaxKind.CommaToken)
        {
            return true;
        }

        if (Peek(ahead).Kind == SyntaxKind.CloseSquareBracketToken)
        {
            // Phase 4.1: function declarations follow `[T any]` with `(`.
            // Phase 4.3 / ADR-0020: type declarations follow `[T any]` with
            // `data`/`struct`/`class`/`interface` (contextual `data` lexes as
            // an identifier; the lookahead also covers the not-yet-supported
            // `interface` case for forward compatibility).
            var follow = Peek(ahead + 1);
            if (follow.Kind == SyntaxKind.OpenParenthesisToken
                || follow.Kind == SyntaxKind.StructKeyword
                || follow.Kind == SyntaxKind.EnumKeyword
                || follow.Kind == SyntaxKind.ClassKeyword
                || follow.Kind == SyntaxKind.InterfaceKeyword
                || follow.Kind == SyntaxKind.SealedKeyword
                || follow.Kind == SyntaxKind.OpenKeyword
                || follow.Kind == SyntaxKind.EqualsToken // ADR-0059: `type X[T any] = delegate func(...)` (rejected by binder as GS0234).
                || follow.Kind == SyntaxKind.OpenBraceToken // ADR-0078: `class Name[T any] { ... }`.
                || follow.Kind == SyntaxKind.ColonToken // ADR-0078: `class Name[T any] : Base { ... }`.
                || (follow.Kind == SyntaxKind.IdentifierToken && (follow.Text == "data" || follow.Text == "record")))
            {
                return true;
            }
        }

        return false;
    }

    private TypeParameterSyntax ParseTypeParameter()
    {
        SyntaxToken variance = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && (Current.Text == "in" || Current.Text == "out") && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            variance = NextToken();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken constraint = null;
        SyntaxToken openBracket = null;
        SeparatedSyntaxList<TypeClauseSyntax> constraintTypeArgs = default;
        SyntaxToken closeBracket = null;

        if (Current.Kind == SyntaxKind.IdentifierToken)
        {
            // Reserve the `class`/`struct`/`init` constraints (handled below
            // as their own keyword tokens / `init`-contextual identifier) so
            // that we don't accidentally bind them as the legacy
            // any/comparable/interface-name slot.
            if (!IsAdditionalConstraintStart(Current))
            {
                constraint = NextToken();

                // ADR-0089 / issue #755: a constraint identifier may be followed by
                // a generic type-argument list (the curiously-recurring pattern
                // `[T IAdd[T]]` is the canonical generic-math shape required for
                // static-virtual interface members). Parse `[ TypeClause (, TypeClause)* ]`
                // when present; the binder constructs the closed interface from the
                // resulting argument list.
                if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
                {
                    openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
                    var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
                    var parseNext = true;
                    while (parseNext &&
                           Current.Kind != SyntaxKind.CloseSquareBracketToken &&
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

                    closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                    constraintTypeArgs = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
                }
            }
        }

        // ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
        // issue #997): consume any of `class`, `struct`, `init()` constraints
        // in any order. The binder validates illegal combinations (e.g.
        // `class struct`).
        SyntaxToken classKw = null;
        SyntaxToken structKw = null;
        SyntaxToken initKw = null;
        SyntaxToken initOpenParen = null;
        SyntaxToken initCloseParen = null;
        while (true)
        {
            if (Current.Kind == SyntaxKind.ClassKeyword)
            {
                if (classKw == null)
                {
                    classKw = NextToken();
                }
                else
                {
                    break;
                }
            }
            else if (Current.Kind == SyntaxKind.StructKeyword)
            {
                if (structKw == null)
                {
                    structKw = NextToken();
                }
                else
                {
                    break;
                }
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken
                     && Current.Text == "init"
                     && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
                     && Peek(2).Kind == SyntaxKind.CloseParenthesisToken)
            {
                if (initKw == null)
                {
                    initKw = NextToken();
                    initOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                    initCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
                }
                else
                {
                    break;
                }
            }
            else
            {
                break;
            }
        }

        return new TypeParameterSyntax(
            syntaxTree,
            variance,
            identifier,
            constraint,
            openBracket,
            constraintTypeArgs,
            closeBracket,
            classKw,
            structKw,
            initKw,
            initOpenParen,
            initCloseParen);
    }

    private TypeClauseSyntax ParseTypeClause()
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

            // Issue #526: an array/slice of a nested CLR type — `[]Outer.Inner`.
            var (arrayDots, arrayQualifiers) = ParseQualifierSegments();

            // Phase 4.3c: an array/slice of a constructed generic type —
            // `[]List[int32]`. The optional type-argument list attaches to the
            // (last) element identifier, mirroring the non-array path below.
            SyntaxToken arrayTypeArgOpen = null;
            SeparatedSyntaxList<TypeClauseSyntax> arrayTypeArgs = default;
            SyntaxToken arrayTypeArgClose = null;
            if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
            {
                arrayTypeArgOpen = MatchToken(SyntaxKind.OpenSquareBracketToken);
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

                arrayTypeArgs = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
                arrayTypeArgClose = MatchToken(SyntaxKind.CloseSquareBracketToken);
            }

            var arrayQuestion = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
            return new TypeClauseSyntax(
                syntaxTree,
                openBracket,
                length,
                closeBracket,
                elementIdentifier,
                arrayDots,
                arrayQualifiers,
                arrayTypeArgOpen,
                arrayTypeArgs,
                arrayTypeArgClose,
                arrayQuestion,
                arrayNullableQuestion);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #526: a dotted-qualifier chain `Outer.Inner` (or `A.B.C`) names a
        // nested CLR type. Consume the `.IDENT` segments greedily — the trailing
        // type-argument list `[T1, ...]` (Phase 4.3c) attaches to the LAST segment,
        // matching how nested generic types are written in source.
        var (qualifierDots, qualifierIdents) = ParseQualifierSegments();

        // Phase 4.3c: optional type-argument list `Foo[T1, T2]` in type position.
        SyntaxToken typeArgOpen = null;
        SeparatedSyntaxList<TypeClauseSyntax> typeArgs = default;
        SyntaxToken typeArgClose = null;
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
        {
            typeArgOpen = MatchToken(SyntaxKind.OpenSquareBracketToken);
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

            typeArgs = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
            typeArgClose = MatchToken(SyntaxKind.CloseSquareBracketToken);
        }

        var question = Current.Kind == SyntaxKind.QuestionToken ? MatchToken(SyntaxKind.QuestionToken) : null;
        return new TypeClauseSyntax(
            syntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier,
            qualifierDots,
            qualifierIdents,
            typeArgOpen,
            typeArgs,
            typeArgClose,
            question);
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
}
