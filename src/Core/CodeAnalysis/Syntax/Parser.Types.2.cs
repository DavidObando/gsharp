// <copyright file="Parser.Types.2.cs" company="GSharp">
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
        if (Current.Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var parenDepth = 1;
        var bracketDepth = 0;
        var braceDepth = 0;
        var offset = 1;
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

    // Phase 4.1 / ADR-0020: bounded-lookahead disambiguation between
    // `name [ expr ]` (indexing) and `name [ TypeClause, ... ] ( args )`
    // (generic instantiation followed by call). `bracketOffset` is the
    // offset of the `[` token relative to Current.
    //
    // The comma-loop below intentionally supports any arity, including the
    // multi-type-arg shape `Dictionary[K, V]()` / `Dictionary[K, V, W]()`,
    // so the parser commits to a generic call site as long as every
    // comma-separated item inside the brackets parses as a type clause
    // (via `TryScanTypeClause`) and the token after the matching `]` is
    // one of the ADR-0020 follow-set markers (`(`, `{`, `.`). Regression
    // coverage lives in test/Core.Tests/CodeAnalysis/Syntax/Issue693MultiTypeArgGenericCallParserTests.cs
    // and end-to-end emit coverage in
    // test/Compiler.Tests/Emit/Issue693DictionaryConstructionEmitTests.cs.
    //
    // Issue #942: the `.` follow-set marker is genuinely ambiguous with
    // indexer-then-member access. A single bracketed argument that is also a
    // legal expression (e.g. `xs[i]`, `xs[i].ToString()`) scans as a lone
    // type clause and would otherwise be mis-committed to a generic
    // type-argument list, so the trailing `.Member` mis-binds. An indexer can
    // only ever hold a *single* index expression, never a comma-separated
    // list, so we restrict the `.` follow-set to the unambiguous multi-arg
    // shape (`Pair[int, string].zero`). A single bracketed argument followed
    // by `.` is parsed as an indexer-then-member access, matching the
    // literal-index behaviour (`xs[0].ToString()`). The `(`/`{` markers stay
    // arity-agnostic: `Map[int](xs)` and `List[int]{...}` remain generic
    // instantiations regardless of arity.
    private bool LooksLikeGenericCallSite(int bracketOffset)
    {
        if (Peek(bracketOffset).Kind != SyntaxKind.OpenSquareBracketToken)
        {
            return false;
        }

        var pos = bracketOffset + 1;
        if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
        {
            return false;
        }

        var typeArgumentCount = 0;
        var sawComplexTypeArgument = false;
        while (true)
        {
            if (!TryScanTypeClause(ref pos, out var argumentIsComplex))
            {
                return false;
            }

            typeArgumentCount++;
            sawComplexTypeArgument |= argumentIsComplex;

            if (Peek(pos).Kind == SyntaxKind.CommaToken)
            {
                pos++;
                continue;
            }

            if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                pos++;
                break;
            }

            return false;
        }

        // Follow-set per ADR-0020: '(' (call), '{' (composite literal), '.' (member access).
        var nextKind = Peek(pos).Kind;
        if (nextKind == SyntaxKind.OpenParenthesisToken)
        {
            return true;
        }

        if (nextKind == SyntaxKind.OpenBraceToken)
        {
            // Issue #1023: in a statement-header controlling expression
            // (`if`/`while`/`for` clauses, `switch`/`match` subject, …) the
            // trailing `{` opens the statement body, not a composite literal.
            // The same Go-style suppression that blocks `Type { … }` /
            // `Call() { … }` here must also block the generic-composite
            // `name[args] { … }` shape, so an indexer-tailed header such as
            // `for …; s += arr[s] { … }` binds `[s]` as an indexer and lets
            // `{` open the loop body. Nested contexts (parens, brackets,
            // argument lists) clear the counter, so `List[int]{…}` still
            // parses inside those.
            if (suppressTrailingObjectInitializer > 0)
            {
                return false;
            }

            return true;
        }

        // Issue #942 / Issue #1323: a multi-type-argument list (which cannot be
        // an indexer) always commits to a generic call site on a trailing `.`.
        // A single bracketed argument followed by `.` is normally treated as an
        // indexer-then-member access (`dict[key].Prop`, `Box[int32].Make` — the
        // latter resolves later in the binder). But a single argument whose
        // shape is unambiguously a TYPE — it carries a nullable suffix (`T?`),
        // an array/slice prefix (`[]T`), or its own nested type-argument list
        // (`List[T]`) — cannot be a legal index expression, so it must be a
        // generic call site (`Box[int32?].Make`, `Box[[]int32].Make`,
        // `Box[List[int32]].Make`).
        return nextKind == SyntaxKind.DotToken
            && (typeArgumentCount > 1 || sawComplexTypeArgument);
    }

    private bool TryScanTypeClause(ref int pos, out bool isComplex)
    {
        isComplex = false;

        // Optional leading bracketed segment: '[' ']' or '[' Number ']' for slice/array shapes.
        if (Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            // An array/slice prefix is unambiguously a type shape (Issue #1323).
            isComplex = true;
            pos++;
            if (Peek(pos).Kind == SyntaxKind.NumberToken)
            {
                pos++;
            }

            if (Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken)
            {
                return false;
            }

            pos++;
        }

        // ADR-0075: `async (T) -> R` and `func(T) R` start a function-type clause.
        // Handle the optional leading `async` modifier here so the next token
        // is the actual head of the function-type clause.
        if (Peek(pos).Kind == SyntaxKind.AsyncKeyword)
        {
            pos++;
        }

        // ADR-0075: `(T1, T2, ...) -> R` arrow function-type clause, or a
        // tuple-type clause `(T1, T2, ...)`. Both start with '('.
        if (Peek(pos).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // A function/tuple type clause is unambiguously a type shape.
            isComplex = true;
            pos++;
            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                while (true)
                {
                    if (!TryScanTypeClause(ref pos))
                    {
                        return false;
                    }

                    if (Peek(pos).Kind == SyntaxKind.CommaToken)
                    {
                        pos++;
                        continue;
                    }

                    break;
                }
            }

            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                return false;
            }

            pos++;

            // If `->` follows, this is an arrow function-type clause; scan the return type.
            if (Peek(pos).Kind == SyntaxKind.RightArrowToken)
            {
                pos++;
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }
            }

            // Optional trailing `?` for nullables (tuples and function types both support `?`).
            if (Peek(pos).Kind == SyntaxKind.QuestionToken)
            {
                pos++;
            }

            return true;
        }

        // Phase 4.7: legacy `func(T) R` function-type clause.
        if (Peek(pos).Kind == SyntaxKind.FuncKeyword)
        {
            // A legacy function-type clause is unambiguously a type shape.
            isComplex = true;
            pos++;
            if (Peek(pos).Kind != SyntaxKind.OpenParenthesisToken)
            {
                return false;
            }

            pos++;
            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                while (true)
                {
                    if (!TryScanTypeClause(ref pos))
                    {
                        return false;
                    }

                    if (Peek(pos).Kind == SyntaxKind.CommaToken)
                    {
                        pos++;
                        continue;
                    }

                    break;
                }
            }

            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                return false;
            }

            pos++;

            // Optional return type for the legacy func form.
            if (Peek(pos).Kind == SyntaxKind.IdentifierToken
                || Peek(pos).Kind == SyntaxKind.OpenParenthesisToken)
            {
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }
            }

            if (Peek(pos).Kind == SyntaxKind.QuestionToken)
            {
                pos++;
            }

            return true;
        }

        if (Peek(pos).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        pos++;

        // Nested type-argument list, e.g. `List[int]`.
        if (!TryScanOptionalTypeArgumentList(ref pos, out var headHadTypeArgumentList))
        {
            return false;
        }

        // A nested type-argument list makes this unambiguously a type shape
        // (`List[int32]`) rather than a plain index expression (Issue #1323).
        isComplex |= headHadTypeArgumentList;

        // Issue #1174: a dotted tail names a (possibly nested, possibly
        // generic) type — `Container.Nested`, `A.B.C`, or `Outer.Generic[T]`.
        // Each `.Identifier` segment may carry its own type-argument list.
        // Consuming the tail here lets `List[C.E]` and `List[C.E]{...}` scan as
        // a SINGLE type clause in a generic-argument position so they are
        // recognised as a generic call / composite site. The `.` is scanned
        // INSIDE the bracket; the separate issue #942 rule about a trailing `.`
        // AFTER the `]` (indexer-then-member disambiguation in
        // LooksLikeGenericCallSite) is untouched.
        while (Peek(pos).Kind == SyntaxKind.DotToken
            && Peek(pos + 1).Kind == SyntaxKind.IdentifierToken)
        {
            pos += 2;
            if (!TryScanOptionalTypeArgumentList(ref pos, out var segmentHadTypeArgumentList))
            {
                return false;
            }

            isComplex |= segmentHadTypeArgumentList;
        }

        // Optional trailing `?` for nullables.
        if (Peek(pos).Kind == SyntaxKind.QuestionToken)
        {
            // A nullable suffix is unambiguously a type shape (Issue #1323).
            isComplex = true;
            pos++;
        }

        return true;
    }

    /// <summary>
    /// Issue #1174: scans an optional bracketed type-argument list
    /// (<c>[T1, T2, ...]</c>) starting at <paramref name="pos"/>. A missing list
    /// is a success (no-op). Used by <see cref="TryScanTypeClause(ref int)"/> for both the
    /// head identifier and each dotted-tail segment so a nested generic type such
    /// as <c>Outer.Generic[T]</c> scans as one type clause.
    /// </summary>
    /// <param name="pos">The scan position, advanced past the list when present.</param>
    /// <returns><see langword="true"/> when there is no list or it scans cleanly.</returns>
    private bool TryScanOptionalTypeArgumentList(ref int pos)
        => TryScanOptionalTypeArgumentList(ref pos, out _);

    private bool TryScanOptionalTypeArgumentList(ref int pos, out bool present)
    {
        if (Peek(pos).Kind != SyntaxKind.OpenSquareBracketToken)
        {
            present = false;
            return true;
        }

        present = true;
        pos++;
        while (true)
        {
            if (!TryScanTypeClause(ref pos))
            {
                return false;
            }

            if (Peek(pos).Kind == SyntaxKind.CommaToken)
            {
                pos++;
                continue;
            }

            if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                pos++;
                break;
            }

            return false;
        }

        return true;
    }

    private ExpressionSyntax ParseGenericCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeArguments = ParseTypeArgumentList();

        // Phase 4.3 / ADR-0020: a `[…]` type-argument list followed by `{` is a
        // generic struct/class composite literal (`Result[int, string]{...}`).
        // Issue #479 / ADR-0117: the same `Type[args]{…}` shape is a collection
        // initializer (`List[int32]{1, 2, 3}`, `Dictionary[K, V]{"a": 1}`,
        // `Dictionary[K, V]{ ["a"] = 1 }`) when the brace contents are NOT a
        // `Field: value` struct-literal field list. The parser synthesizes an
        // empty-argument constructor call as the initializer's target.
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            if (BraceLooksLikeGenericCollectionInitializer())
            {
                var ctorCall = SynthesizeEmptyArgConstructorCall(identifier, typeArguments);
                return ParseCollectionInitializerExpression(ctorCall);
            }

            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var initializers = ParseStructLiteralInitializers();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            var literal = new StructLiteralExpressionSyntax(syntaxTree, identifier, openBrace, initializers, closeBrace);
            literal.TypeArgumentList = typeArguments;
            return literal;
        }

        // Issue #1323: a `[…]` type-argument list followed by `.` is a member
        // access on the constructed generic *type* (`Box[int32?].Make(5)`,
        // `Pair[int, string].Default`). The committed-to-generic decision was
        // already made by LooksLikeGenericCallSite (multi-arg, or a single
        // unambiguously type-shaped argument). Emit a generic-name expression so
        // ParsePostfixChain attaches the `.Member(...)` accessor and the binder
        // resolves the closed construction as the static-access receiver.
        if (Current.Kind == SyntaxKind.DotToken)
        {
            return new GenericNameExpressionSyntax(syntaxTree, identifier, typeArguments);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, typeArguments, openParen, arguments, closeParen);
    }

    // Issue #479 / ADR-0117: in the `Type[args]{…}` generic-composite position
    // the `{` introduces a struct-literal field list when it is empty (all
    // defaults) or its first entry is `Identifier :`. Every other shape — a
    // bare element (`1`), a non-identifier-keyed entry (`"a": 1`), or an
    // indexed entry (`["a"] = 1`) — is a collection initializer.
    private bool BraceLooksLikeGenericCollectionInitializer()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return false;
        }

        if (k1 == SyntaxKind.OpenSquareBracketToken)
        {
            return true;
        }

        if (k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.ColonToken)
        {
            return false;
        }

        return true;
    }

    private TypeArgumentListSyntax ParseTypeArgumentList()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
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

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new TypeArgumentListSyntax(syntaxTree, openBracket, new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()), closeBracket);
    }

    // Issue #663: `string?(expr)` — nullable-type conversion call form.
    // Consumes `Identifier ? ( args )` and builds a CallExpressionSyntax
    // carrying the `?` token so the binder can wrap the resolved type in
    // NullableTypeSymbol.
    private ExpressionSyntax ParseNullableTypeCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var questionToken = MatchToken(SyntaxKind.QuestionToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, questionToken, typeArgumentList: null, openParenthesisToken, arguments, closeParenthesisToken);
    }

    // ADR-0060 helper for the optional `out var name T` / `out let name T` /
    // `out name T` type-clause: returns true when the current token is an
    // identifier that could start a G# type clause (excluding `,` / `)`).
    private bool CurrentTokenStartsTypeClause()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.FuncKeyword:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.MapKeyword:
            case SyntaxKind.ChanKeyword:
            case SyntaxKind.SequenceKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.StarToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.IdentifierToken:
                return true;
            default:
                return false;
        }
    }
}
