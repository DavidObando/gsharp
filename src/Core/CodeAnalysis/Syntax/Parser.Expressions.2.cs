// <copyright file="Parser.Expressions.2.cs" company="GSharp">
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


    private ExpressionSyntax ParseBinaryExpression(int parentPrecedence = 0)
    {
        ExpressionSyntax left;
        var unaryOperatorPrecedence = Current.Kind.GetUnaryOperatorPrecedence();
        if (Current.Kind == SyntaxKind.PlusPlusToken || Current.Kind == SyntaxKind.MinusMinusToken)
        {
            // ADR-0126 / issue #1027: prefix increment/decrement `++x` / `--x`.
            // Binds at the unary precedence tier so `++a.b[c]` targets the whole
            // lvalue and `++a + b` parses as `(++a) + b`.
            var prefixOp = NextToken();
            var prefixOperand = ParseBinaryExpression(6);
            left = BuildIncrementDecrementExpression(prefixOperand, prefixOp, isPrefix: true);
        }
        else if (unaryOperatorPrecedence != 0 && unaryOperatorPrecedence >= parentPrecedence)
        {
            var operatorToken = NextToken();
            var operand = ParseBinaryExpression(unaryOperatorPrecedence);

            // ADR-0061: support `&<cond> ? <lvalue> : <lvalue>` as a bare
            // address-of of a conditional lvalue. Without this special case,
            // a stray `?` after `&x` would otherwise be unparseable (there is
            // no general ternary in G#).
            if (operatorToken.Kind == SyntaxKind.AmpersandToken
                && Current.Kind == SyntaxKind.QuestionToken)
            {
                operand = MaybeParseConditionalRefArgumentTail(operand, operatorToken);
            }

            left = new UnaryExpressionSyntax(syntaxTree, operatorToken, operand);
        }
        else if (Current.Kind == SyntaxKind.AwaitKeyword)
        {
            // Phase 5.1 / ADR-0023: `await e` is a prefix expression. Bind at
            // the same precedence as the established unary slot so it composes
            // identically with member access and call: `await f()` parses as
            // `await (f())` and `(await x).Member` requires parens.
            var awaitKeyword = NextToken();
            var operand = ParseBinaryExpression(6);
            left = new AwaitExpressionSyntax(syntaxTree, awaitKeyword, operand);
        }
        else
        {
            left = ParsePrimaryExpression();
        }

        // Phase 3.C.3 / ADR-0001 + Issue #518: postfix null-assertion `!!`.
        // `!!` is a true postfix operator that composes with the other primary
        // continuations (`.`, `?.`, `[`). After consuming `!!` we re-enter the
        // postfix chain so subsequent member access / null-conditional access /
        // indexing all hang off the `!!`-wrapped expression — i.e.
        // `dir.Parent!!.Name` parses as `((dir.Parent)!!).Name` (the binder
        // sees an AccessorExpression whose LeftPart is the `!!` UnaryExpression
        // and falls through to the generic `BindExpression(leftPart)` path).
        // Mixing `!!` with `+`, `==`, ternary etc. just falls out of the
        // outer binary loop because `!!` itself has no precedence — it binds
        // tighter than every binary operator, same as before this fix.
        while (Current.Kind == SyntaxKind.BangBangToken)
        {
            var bangBangToken = NextToken();
            left = new UnaryExpressionSyntax(syntaxTree, bangBangToken, left);
            left = ParsePostfixChain(left);
        }

        // ADR-0126 / issue #1027: postfix increment/decrement `x++` / `x--`.
        // A bare `identifier ++` in statement position is intercepted earlier by
        // ParseIncrementDecrementStatement, so this expression form fires for
        // value positions (`var j = i--`, `while i-- > 0`) and complex targets
        // (`a[i]++`, `obj.f--`). Only a single trailing operator is accepted
        // (C# likewise rejects `i++++`).
        if (Current.Kind == SyntaxKind.PlusPlusToken || Current.Kind == SyntaxKind.MinusMinusToken)
        {
            var postfixOp = NextToken();
            left = BuildIncrementDecrementExpression(left, postfixOp, isPrefix: false);
        }

        while (true)
        {
            // ADR-0122 / issue #1014: a `*` that begins a new source line is a
            // pointer-dereference statement (`*p = v` / `*p`), not a
            // continuation of the previous expression as multiplication. G#
            // is otherwise newline-insensitive, but a leading-`*` continuation
            // is never written (binary operators are placed at line end), so
            // stopping the binary loop here is safe and lets deref-write
            // statements parse after any preceding expression statement.
            if (Current.Kind == SyntaxKind.StarToken && IsCurrentOnNewLineAfter(left))
            {
                break;
            }

            var precedence = Current.Kind.GetBinaryOperatorPrecedence();
            if (precedence == 0 || precedence <= parentPrecedence)
            {
                // Issue #575: expression-level `is`/`as` operators bind at the
                // relational tier (precedence 3, same as <, <=, >, >=). They have
                // a Type RHS instead of an Expression RHS, so they're parsed
                // separately from the standard binary-operator path.
                if (parentPrecedence < 3 && (Current.Kind == SyntaxKind.IsKeyword || Current.Kind == SyntaxKind.AsKeyword))
                {
                    var keyword = NextToken();
                    var typeClause = ParseTypeClause();
                    if (keyword.Kind == SyntaxKind.IsKeyword)
                    {
                        left = new IsExpressionSyntax(syntaxTree, left, keyword, typeClause);
                    }
                    else
                    {
                        left = new AsExpressionSyntax(syntaxTree, left, keyword, typeClause);
                    }

                    continue;
                }

                // ADR-0069 / issue #700: `!is` is recognised as the two-token
                // sequence `!` immediately followed by `is`. It lowers to
                // `!(left is T)` — the same bound tree the binder would produce
                // for the parenthesised form — so every downstream pass
                // (classification, narrowing, emit) handles it identically.
                if (parentPrecedence < 3 && Current.Kind == SyntaxKind.BangToken && Peek(1).Kind == SyntaxKind.IsKeyword)
                {
                    var bangToken = NextToken();
                    var isKeyword = NextToken();
                    var typeClause = ParseTypeClause();
                    var inner = new IsExpressionSyntax(syntaxTree, left, isKeyword, typeClause);
                    left = new UnaryExpressionSyntax(syntaxTree, bangToken, inner);
                    continue;
                }

                break;
            }

            var operatorToken = NextToken();
            var right = ParseBinaryExpression(precedence);
            left = new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
        }

        if (parentPrecedence == 0)
        {
            while (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "with" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                var withToken = MatchToken(SyntaxKind.IdentifierToken);
                var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
                var initializers = ParseFieldEqualsInitializers();
                var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
                left = new WithExpressionSyntax(left, withToken, openBrace, initializers, closeBrace);
            }
        }

        return left;
    }

    private ExpressionSyntax ParsePrimaryExpression()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.OpenParenthesisToken:
                // ADR-0074 / issue #714: `(p1 T1, p2 T2) -> body` is a lambda
                // expression. Disambiguated by bounded look-ahead — see
                // LooksLikeLambdaStart — so a parenthesised expression or
                // tuple literal that is not followed by `->` continues to
                // parse via the existing path.
                if (LooksLikeLambdaStart())
                {
                    return ParseLambdaExpression();
                }

                return ParsePostfixChain(ParseParenthesizedExpression());

            case SyntaxKind.FalseKeyword:
            case SyntaxKind.TrueKeyword:
                return ParsePostfixChain(ParseBooleanLiteral());

            case SyntaxKind.NilKeyword:
                return ParsePostfixChain(ParseNilLiteral());

            // ADR-0054: postfix member/index access does NOT apply directly to a
            // numeric literal (collides with float-literal lexing, e.g. `42.x`).
            // Users write `(42).Member` instead.
            case SyntaxKind.NumberToken:
                return ParseNumberLiteral();

            case SyntaxKind.CharacterToken:
                return ParsePostfixChain(ParseCharacterLiteral());

            case SyntaxKind.StringToken:
                return ParsePostfixChain(ParseStringLiteral());

            case SyntaxKind.InterpolatedStringToken:
                return ParsePostfixChain(ParseInterpolatedStringLiteral());

            case SyntaxKind.OpenSquareBracketToken:
                return ParsePostfixChain(ParseArrayCreationExpression());

            case SyntaxKind.MapKeyword:
                return ParsePostfixChain(ParseMapCreationExpression());

            case SyntaxKind.FuncKeyword:
                return ParsePostfixChain(ParseFunctionLiteralExpression());

            case SyntaxKind.AsyncKeyword when Peek(1).Kind == SyntaxKind.FuncKeyword:
                return ParsePostfixChain(ParseFunctionLiteralExpression());

            case SyntaxKind.AsyncKeyword when LooksLikeLambdaStart(startOffset: 1):
                // ADR-0076 / issue #716: `async (...) -> body` is an async
                // arrow lambda. The parser commits when the post-`async`
                // tokens match a lambda shape.
                return ParseLambdaExpression();

            case SyntaxKind.IdentifierToken when Peek(1).Kind == SyntaxKind.RightArrowToken && this.unsafeDepth == 0:
                // Issue #932: a single-identifier arrow lambda `x -> body` is
                // accepted as shorthand for the parenthesised single-parameter
                // form `(x) -> body`. Disambiguation is unconditional here: in
                // an expression position `IDENT ->` cannot begin any other
                // construct (function-type clauses `(T) -> R` and the
                // deprecated switch-arm `case v -> r` are parsed in their own
                // type/pattern contexts, never via primary-expression
                // dispatch), so committing to a lambda is always correct.
                //
                // ADR-0122 §4 / issue #1034: EXCEPT inside an unsafe context,
                // where `p->member` is pointer member access `(*p).member`. The
                // `unsafeDepth == 0` guard routes `IDENT ->` to the lambda only
                // outside unsafe code; inside unsafe it falls through to the
                // name/postfix path which desugars `->` to a dereference member
                // access. A single-identifier lambda is still expressible inside
                // unsafe code via the parenthesised form `(x) -> body`.
                return ParseSingleIdentifierLambdaExpression();

            case SyntaxKind.SwitchKeyword:
                return ParsePostfixChain(ParseSwitchExpression());

            case SyntaxKind.IfKeyword:
                return ParsePostfixChain(ParseIfExpression());

            case SyntaxKind.ThrowKeyword:
                // Issue #1018: throw-expression in value position
                // (`x ?? throw e`, `cond ? a : throw e`, `return throw e`,
                // arrow bodies, arguments). A `throw` at statement start is
                // intercepted earlier by ParseStatement → ParseThrowStatement,
                // so reaching here always means an expression context.
                return ParseThrowExpression();

            case SyntaxKind.IdentifierToken
                when Current.Text == "stackalloc"
                     && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken:
                // ADR-0124 / issues #1024, #1057: `stackalloc [n]T` is a
                // stack-allocation expression in G#-style array grammar (the
                // bracketed count first, then the element type). `stackalloc`
                // is a contextual keyword recognised only in the precise
                // `stackalloc [` shape, so any existing identifier named
                // `stackalloc` in any other position continues to lex as a
                // plain identifier.
                return ParsePostfixChain(ParseStackAllocExpression());

            case SyntaxKind.IdentifierToken
                when Current.Text == "base" && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken:
                // ADR-0091 / issue #757: explicit-base interface call
                // `base[IFoo].M(args)`. `base` is recognized as a contextual
                // keyword only when followed by `[`; every other position
                // continues to lex it as a plain identifier (so existing
                // shapes like `init(x) : base(x)` and `var base = 5` are
                // unaffected).
                return ParsePostfixChain(ParseBaseInterfaceCallExpression());

            case SyntaxKind.DefaultKeyword:
                // ADR-0100 / issue #795: `default(T)` and bare `default`
                // expressions. The arm-leading `default` of a switch/select
                // case is matched earlier in ParseSwitchCase /
                // ParseSelectCase / ParseSwitchExpressionArm before reaching
                // primary-expression dispatch, so by the time we land here
                // the keyword is in a value position.
                return ParsePostfixChain(ParseDefaultExpression());

            case SyntaxKind.IdentifierToken:
            default:
                return ParseNameOrCallExpression();
        }
    }

    // ADR-0054: chains postfix member access (`.` / `?.`) and indexing
    // (`[]` / `?[]`) onto an already-parsed primary expression. Used by both
    // the name/call path and the other primary-expression cases so accessors
    // work uniformly on parenthesized expressions, literals, and other primaries.
    // ADR-0073 / issue #710: the `?[` token is the prefix of a null-conditional
    // index access and is treated symmetrically to `[`, with the resulting
    // IndexExpressionSyntax carrying IsNullConditional = true.
    private ExpressionSyntax ParsePostfixChain(ExpressionSyntax current)
    {
        while (true)
        {
            if (Current.Kind == SyntaxKind.DotToken || Current.Kind == SyntaxKind.QuestionDotToken)
            {
                var dotToken = NextToken();
                var rightSide = ParseNameOrCallExpression();
                current = new AccessorExpressionSyntax(syntaxTree, current, dotToken, rightSide);
            }
            else if (Current.Kind == SyntaxKind.RightArrowToken)
            {
                // ADR-0122 §4 / issue #1034: the pointer member-access arrow
                // `p->m` is sugar for `(*p).m`. Desugar at parse time into a
                // dereference (`*p`) accessed by a member name, so the binder and
                // emitter reuse the existing `(*p).field` / `(*p).method(...)`
                // bound shape without any new bound-node kinds.
                var arrowToken = NextToken();
                var rightSide = ParseNameOrCallExpression();
                var starToken = new SyntaxToken(syntaxTree, SyntaxKind.StarToken, arrowToken.Position, "*", null);
                var deref = new UnaryExpressionSyntax(syntaxTree, starToken, current);
                current = new AccessorExpressionSyntax(syntaxTree, deref, arrowToken, rightSide);
            }
            else if (Current.Kind == SyntaxKind.OpenSquareBracketToken
                || Current.Kind == SyntaxKind.QuestionOpenBracketToken)
            {
                var openBracket = NextToken();

                // Issue #522: an indexer is a fresh inner expression context.
                var savedSuppress = suppressTrailingObjectInitializer;
                suppressTrailingObjectInitializer = 0;
                ExpressionSyntax index;
                try
                {
                    index = ParseIndexArgument();
                }
                finally
                {
                    suppressTrailingObjectInitializer = savedSuppress;
                }

                var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                current = new IndexExpressionSyntax(syntaxTree, current, openBracket, index, closeBracket);
            }
            else
            {
                break;
            }
        }

        return current;
    }

    // Issue #1016: parse the argument of an index expression, allowing a
    // range/slice operand (`lo..hi`, `..hi`, `lo..`, `..`) in addition to an
    // ordinary single index. The `..` token is only meaningful in this
    // position, so range parsing is scoped here rather than to the general
    // expression grammar (keeping `.` member-access and float literals
    // unambiguous everywhere else).
    private ExpressionSyntax ParseIndexArgument()
    {
        ExpressionSyntax lower = null;
        if (Current.Kind != SyntaxKind.DotDotToken
            && Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            lower = ParseIndexBound();
        }

        if (Current.Kind != SyntaxKind.DotDotToken)
        {
            // No `..` — an ordinary index. `lower` is necessarily non-null here
            // (an empty `[]` falls through to MatchToken's error recovery).
            return lower ?? ParseExpression();
        }

        var dotDotToken = NextToken();

        ExpressionSyntax upper = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken
            && Current.Kind != SyntaxKind.DotDotToken)
        {
            upper = ParseIndexBound();
        }

        return new RangeExpressionSyntax(syntaxTree, lower, dotDotToken, upper);
    }

    // Issue #1022: parse a single index/range bound, recognising a leading `^`
    // as the C# "from-end" index marker (`a[^1]`, `a[1..^1]`) rather than the
    // one's-complement unary operator. The disambiguation is intentionally
    // scoped to this leading position: a `^` anywhere else (including inside the
    // offset expression itself, e.g. `a[^(x ^ y)]`) keeps its ordinary
    // one's-complement / bitwise-XOR meaning.
    //
    // Issue #1038: the bound is parsed with the standalone range layer
    // suppressed, so the `..` between bounds (and the trailing `..` of `a[^2..]`)
    // is owned by <see cref="ParseIndexArgument"/> rather than being absorbed
    // into the bound's own expression. A parenthesised or argument-position
    // range nested inside the bound re-enables the layer at its grouping
    // boundary (`a[(1..3)]`).
    private ExpressionSyntax ParseIndexBound()
    {
        suppressRangeOperator++;
        try
        {
            if (Current.Kind == SyntaxKind.HatToken)
            {
                var hatToken = NextToken();
                var operand = ParseExpression();
                return new FromEndIndexExpressionSyntax(syntaxTree, hatToken, operand);
            }

            return ParseExpression();
        }
        finally
        {
            suppressRangeOperator--;
        }
    }

    // ADR-0074 / issue #714: bounded look-ahead for a lambda expression
    // starting at a `(`. Returns true if the token stream looks like
    // `() -> …`, `(ident type, …) -> …`, or (ADR-0076 / issue #716)
    // `(ident, …) -> …` (untyped — the binder fills the types from the
    // target). The disambiguator commits to a lambda whenever the matching
    // `)` is followed by `->` AND the interior either is empty or starts
    // with a parameter-name identifier; the lone trailing `->` after `)`
    // is unambiguously a lambda operator (it cannot be a binary expression
    // operator outside switch-arm position).
    //
    // ADR-0076 / issue #716: a leading `async` keyword is recognised by
    // the dispatcher in <see cref="ParsePrimaryExpression"/> as
    // `AsyncKeyword + OpenParenthesisToken + LooksLikeLambdaStart(offset:1)`,
    // so this helper takes an optional <paramref name="startOffset"/>.
    private bool LooksLikeLambdaStart(int startOffset = 0)
    {
        if (Peek(startOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        // Walk forward counting nested grouping tokens until we find the
        // matching `)` for the opening `(`. Bail out if we cannot match.
        var parenDepth = 1;
        var bracketDepth = 0;
        var braceDepth = 0;
        var offset = startOffset + 1;
        const int maxScan = 4096;
        while (offset - startOffset < maxScan)
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

        // Peek(offset) is the closing `)`. The lambda commit requires `->` to
        // immediately follow at the next non-trivia token slot.
        if (Peek(offset + 1).Kind != SyntaxKind.RightArrowToken)
        {
            return false;
        }

        // Empty parameter list `()`: definitively a zero-param lambda.
        if (offset == startOffset + 1)
        {
            return true;
        }

        // Non-empty parameter list: the first interior token must look like a
        // parameter — i.e. an identifier (possibly preceded by `@` annotations
        // or the contextual `scoped`/`ref`/`out`/`in` modifiers used by
        // ParseParameter). ADR-0076 / issue #716: the type clause is OPTIONAL
        // on a lambda parameter, so the token AFTER the identifier may be
        // `,`, `)`, `=`, or anything else — the matching `)` is already
        // known to be followed by `->`, so the parse is unambiguously a
        // lambda once we see an identifier-shaped first slot.
        var j = startOffset + 1;

        // Optional `@Annot[(args)]` annotations before the first parameter.
        while (Peek(j).Kind == SyntaxKind.AtToken)
        {
            j++;
            if (Peek(j).Kind == SyntaxKind.IdentifierToken)
            {
                j++;
                while (Peek(j).Kind == SyntaxKind.DotToken && Peek(j + 1).Kind == SyntaxKind.IdentifierToken)
                {
                    j += 2;
                }

                if (Peek(j).Kind == SyntaxKind.OpenParenthesisToken)
                {
                    var innerDepth = 1;
                    j++;
                    while (j < offset && innerDepth > 0)
                    {
                        var kk = Peek(j).Kind;
                        if (kk == SyntaxKind.OpenParenthesisToken)
                        {
                            innerDepth++;
                        }
                        else if (kk == SyntaxKind.CloseParenthesisToken)
                        {
                            innerDepth--;
                        }

                        j++;
                    }
                }
            }
        }

        // Optional `scoped` / `ref` / `out` / `in` contextual modifier.
        if (Peek(j).Kind == SyntaxKind.IdentifierToken
            && (Peek(j).Text == "scoped" || Peek(j).Text == "ref" || Peek(j).Text == "out" || Peek(j).Text == "in")
            && Peek(j + 1).Kind == SyntaxKind.IdentifierToken)
        {
            j++;
        }

        // The first parameter slot must be an identifier (the parameter name).
        // Anything else (e.g. `(42)`, `(x + y)`) is treated as a parenthesized
        // expression / tuple even though `->` follows — the parser surfaces a
        // better diagnostic from the expression path than from the parameter
        // path.
        if (Peek(j).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        return true;
    }

    private LambdaExpressionSyntax ParseLambdaExpression()
    {
        // ADR-0074 / issue #714: `(p1 T1, p2 T2) -> body` lambda expression.
        // The opening `(` is required; an empty parameter list is permitted.
        // ADR-0076 / issue #716: an optional leading `async` modifier marks
        // an async arrow lambda, and parameter type clauses are optional
        // when a target type is available to infer them (the binder reports
        // GS0304 when no target type is in scope).
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            asyncModifier = NextToken();
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseLambdaParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var body = Current.Kind == SyntaxKind.OpenBraceToken
            ? ParseBlockExpression()
            : ParseExpression();
        return new LambdaExpressionSyntax(syntaxTree, asyncModifier, openParen, parameters, closeParen, arrow, body);
    }

    private SeparatedSyntaxList<MapEntrySyntax> ParseMapEntries()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var key = ParseExpression();
            var colon = MatchToken(SyntaxKind.ColonToken);
            var value = ParseExpression();
            nodesAndSeparators.Add(new MapEntrySyntax(syntaxTree, key, colon, value));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<MapEntrySyntax>(nodesAndSeparators.ToImmutable());
    }

    // Parses an optional brace-delimited array initializer. Returns null tokens
    // when no `{` is present (the issue #1272 no-initializer form), and reports
    // whether any element expressions were supplied (an empty `{}` counts as the
    // zero-initialised allocation form, not a literal).
    private (SyntaxToken OpenBrace, SeparatedSyntaxList<ExpressionSyntax> Elements, SyntaxToken CloseBrace, bool HasElements) ParseOptionalArrayInitializer()
    {
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            return (null, null, null, false);
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var elements = ParseArrayInitializerElements();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return (openBrace, elements, closeBrace, elements.Count > 0);
    }

    // ADR-0124 / issues #1024, #1057, #1041: parses a stack-allocation
    // expression in G#-style array grammar `stackalloc [n]T` (bracketed count
    // first, then the element type). The leading `stackalloc` is a contextual
    // keyword and the dispatcher in ParsePrimaryExpression only routes here for
    // the exact `stackalloc [` shape. The count is a full expression (so a
    // runtime length such as `stackalloc [count]uint8` is accepted, mirroring
    // the runtime-length array form). An optional brace-delimited initializer
    // (`stackalloc [n]T{ … }`) supplies the element values; the count-inferred
    // shape (`stackalloc []T{ … }`, empty brackets) takes the count from the
    // initializer length (issue #1041).
    private ExpressionSyntax ParseStackAllocExpression()
    {
        var stackAllocKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);

        // The count is optional: the `stackalloc []T{ … }` shape infers it from
        // the initializer length, so an immediate `]` leaves CountExpression null.
        ExpressionSyntax count = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            count = ParseExpression();
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var elementType = MatchToken(SyntaxKind.IdentifierToken);

        // The brace-delimited initializer is optional for the count-only form
        // (`stackalloc [n]T`) and required for the count-inferred form
        // (`stackalloc []T{ … }`); the binder enforces that requirement.
        SyntaxToken openBrace = null;
        SeparatedSyntaxList<ExpressionSyntax> elements = null;
        SyntaxToken closeBrace = null;
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            elements = ParseArrayInitializerElements();
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        }

        return new StackAllocExpressionSyntax(
            syntaxTree,
            stackAllocKeyword,
            openBracket,
            count,
            closeBracket,
            elementType,
            openBrace,
            elements,
            closeBrace);
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArrayInitializerElements()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseExpression());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    private ExpressionSyntax ParseNameOrCallExpression()
    {
        ExpressionSyntax current;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "make"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
            && Peek(2).Kind == SyntaxKind.ChanKeyword)
        {
            // Phase 5.4 / ADR-0022: contextual `make(chan T)` / `make(chan T, capacity)`.
            current = ParseMakeChannelExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "typeof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #143: contextual `typeof(T)` — argument is a type clause.
            current = ParseTypeOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "nameof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #143: contextual `nameof(expr)` — argument is a name reference.
            current = ParseNameOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            current = ParseCallExpression();
            current = MaybeWrapWithObjectInitializer(current);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.QuestionToken
            && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #663: `string?(expr)` — nullable-type conversion call.
            current = ParseNullableTypeCallExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
            && LooksLikeGenericCallSite(1))
        {
            current = ParseGenericCallExpression();
            current = MaybeWrapWithObjectInitializer(current);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenBraceToken
            && suppressStructLiteral == 0
            && IsStructLiteralFollowingBrace(2))
        {
            current = ParseStructLiteralExpression();
        }
        else
        {
            current = ParseNameExpression();
        }

        return ParsePostfixChain(current);
    }

    // Issue #479 / ADR-0117: recognises a collection-initializer `{` after a
    // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`). To
    // avoid colliding with a statement body (`foo() { stmt }`) we require an
    // unambiguous collection marker: an indexed-entry `[`, a single literal
    // element, or a top-level `,`/`:` separator inside the braces.
    private bool LooksLikeCollectionInitializerBrace()
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

        if (IsLiteralStartToken(k1) && Peek(2).Kind == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        var depth = 0;
        for (var i = 1; ; i++)
        {
            var kind = Peek(i).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (kind == SyntaxKind.OpenBraceToken
                || kind == SyntaxKind.OpenParenthesisToken
                || kind == SyntaxKind.OpenSquareBracketToken)
            {
                depth++;
            }
            else if (kind == SyntaxKind.CloseParenthesisToken
                || kind == SyntaxKind.CloseSquareBracketToken)
            {
                depth--;
            }
            else if (kind == SyntaxKind.CloseBraceToken)
            {
                if (depth == 0)
                {
                    return false;
                }

                depth--;
            }
            else if (depth == 0 && (kind == SyntaxKind.CommaToken || kind == SyntaxKind.ColonToken))
            {
                return true;
            }
        }
    }

    // Issue #479 / ADR-0117: parses the `{ elements }` collection initializer
    // applied to an already-parsed constructor-call target.
    private ExpressionSyntax ParseCollectionInitializerExpression(ExpressionSyntax target)
    {
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var elements = ParseCollectionElements();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new CollectionInitializerExpressionSyntax(syntaxTree, target, openBrace, elements, closeBrace);
    }

    private SeparatedSyntaxList<CollectionElementSyntax> ParseCollectionElements()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext
               && Current.Kind != SyntaxKind.CloseBraceToken
               && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseCollectionElement());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<CollectionElementSyntax>(nodesAndSeparators.ToImmutable());
    }
}
