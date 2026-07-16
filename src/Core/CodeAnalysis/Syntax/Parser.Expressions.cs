// <copyright file="Parser.Expressions.cs" company="GSharp">
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
    private ExpressionSyntax ParseExpression()
    {
        // Recursion safety: ParseAssignmentExpression (the immediate delegate)
        // carries the issue #1602 recursion-depth guard for the whole
        // expression pipeline.
        return ParseAssignmentExpression();
    }

    // Issue #1602: depth-guarded wrapper — see MaxRecursionDepth. Covers every
    // expression nesting cycle that funnels through ParseExpression as well as
    // the direct right-hand-side self-recursion of assignment forms.
    private ExpressionSyntax ParseAssignmentExpression()
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseAssignmentExpressionCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private ExpressionSyntax ParseAssignmentExpressionCore()
    {
        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.OpenSquareBracketToken &&
            TryFindMatchingCloseBracketFollowedByEquals(out var equalsOffset))
        {
            var identifierToken = NextToken();
            var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
            var index = ParseExpression();
            var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
            var equalsToken = MatchToken(SyntaxKind.EqualsToken);
            var value = ParseAssignmentExpression();
            _ = equalsOffset;
            return new IndexAssignmentExpressionSyntax(
                syntaxTree,
                identifierToken,
                openBracket,
                index,
                closeBracket,
                equalsToken,
                value);
        }

        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.DotToken &&
            Peek(2).Kind == SyntaxKind.IdentifierToken &&
            Peek(3).Kind == SyntaxKind.EqualsToken)
        {
            var identifierToken = NextToken();
            var dotToken = MatchToken(SyntaxKind.DotToken);
            var fieldIdentifier = MatchToken(SyntaxKind.IdentifierToken);
            var equalsToken = MatchToken(SyntaxKind.EqualsToken);
            var value = ParseAssignmentExpression();
            return new FieldAssignmentExpressionSyntax(syntaxTree, identifierToken, dotToken, fieldIdentifier, equalsToken, value);
        }

        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.EqualsToken)
        {
            var identifierToken = NextToken();
            var operatorToken = NextToken();
            var right = ParseAssignmentExpression();
            return new AssignmentExpressionSyntax(syntaxTree, identifierToken, operatorToken, right);
        }

        if (Peek(0).Kind == SyntaxKind.IdentifierToken &&
            SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Peek(1).Kind, out var baseOpKind))
        {
            // For `+=` and `-=` on a bare identifier, emit an
            // EventSubscriptionExpressionSyntax so the binder can distinguish
            // event subscription (`EventName += handler`) from compound
            // arithmetic assignment (`x += 1`). The binder falls back to
            // compound assignment if the name is not an event.
            if (Peek(1).Kind == SyntaxKind.PlusEqualsToken || Peek(1).Kind == SyntaxKind.MinusEqualsToken)
            {
                var identifierToken = NextToken();
                var opToken = NextToken();
                var rhs = ParseAssignmentExpression();
                var leftName = new NameExpressionSyntax(syntaxTree, identifierToken);
                return new EventSubscriptionExpressionSyntax(syntaxTree, leftName, opToken, rhs);
            }

            var identifierToken2 = NextToken();
            var compoundToken = NextToken();
            var right = ParseAssignmentExpression();

            var leftName2 = new NameExpressionSyntax(syntaxTree, identifierToken2);
            var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, compoundToken.Position, SyntaxFacts.GetText(baseOpKind), null);
            var binary = new BinaryExpressionSyntax(syntaxTree, leftName2, baseOpToken, right);
            var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, compoundToken.Position, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);
            return new AssignmentExpressionSyntax(syntaxTree, identifierToken2, equalsToken, binary);
        }

        var expression = ParseRangeExpression();

        // Issue #507: indexer assignment whose target is an arbitrary expression
        // (e.g. `obj.Member[k] = v`, `a.b.c[k] = v`, `(GetThing())[i] = v`). The
        // bare-identifier form `id[k] = v` is already handled above as
        // IndexAssignmentExpressionSyntax; this branch handles any other LHS shape
        // whose trailing primary is an index access. Because ParsePostfixChain
        // recursively folds `[...]` into the right-hand side of the most recent
        // `.`, the parsed tree for `obj.Member[k]` is
        // `AccessorExpression(obj, ., IndexExpression(Member, [k]))` — not a
        // top-level IndexExpression. TryLiftTrailingIndexer reshapes such chains
        // into the canonical `IndexExpression(<receiver-chain>, [k])` form before
        // wrapping in MemberIndexAssignmentExpressionSyntax.
        if (Current.Kind == SyntaxKind.EqualsToken
            && TryLiftTrailingIndexer(expression, out var indexedLhs))
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new MemberIndexAssignmentExpressionSyntax(syntaxTree, indexedLhs, equalsToken, value);
        }

        // Issue #648: chained member-access assignment whose target is an
        // arbitrary expression (e.g. `a.B.C = v`, `GetObj().Field = v`). The
        // bare-identifier form `id.field = v` is handled above as
        // FieldAssignmentExpressionSyntax; this branch handles any deeper chain
        // where the last segment is a plain member name (NameExpressionSyntax).
        if (Current.Kind == SyntaxKind.EqualsToken
            && TryLiftTrailingMemberAccess(expression, out var memberReceiver, out var memberDot, out var memberField))
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new MemberFieldAssignmentExpressionSyntax(syntaxTree, memberReceiver, memberDot, memberField, equalsToken, value);
        }

        // Issue #507 follow-up: compound indexer assignment
        // (`d[k] += v`, `obj.Map[k] -= 1`, ...). Mirrors the bare `=` lift above
        // but routes through CompoundIndexAssignmentExpressionSyntax so the
        // binder can evaluate the receiver chain exactly once via a synthesized
        // temp local before desugaring to `tmp[k] = tmp[k] op v`. The
        // bare-identifier form `id[k] op= v` also lands here (TryLift returns
        // the IndexExpression directly when the expression already IS one).
        if (SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Current.Kind, out _)
            && TryLiftTrailingIndexer(expression, out var compoundIndexedLhs))
        {
            var compoundOpToken = NextToken();
            var compoundRhs = ParseAssignmentExpression();
            return new CompoundIndexAssignmentExpressionSyntax(syntaxTree, compoundIndexedLhs, compoundOpToken, compoundRhs);
        }

        // ADR-0062: general two-arm conditional (ternary) expression
        // `cond ? a : b`. Right-associative; lower precedence than
        // logical-or and higher than assignment. When the `?` tail
        // matches the legacy ADR-0061 inner-modifier form
        // (`cond ? ref a : ref b`), produce a ConditionalRefArgumentExpression
        // for backward compatibility; otherwise produce the general
        // ConditionalExpressionSyntax.
        if (Current.Kind == SyntaxKind.QuestionToken)
        {
            expression = ParseConditionalTail(expression);
        }

        // ADR-0060 §13: indirect assignment `*p = expr`. Detected when the
        // parsed primary is a unary `*` dereference followed by `=`. The
        // binder produces a `BoundIndirectAssignmentExpression` which the
        // emitter lowers to `<load-address> <value> stind.*`.
        if (expression is UnaryExpressionSyntax unaryDeref
            && unaryDeref.OperatorToken.Kind == SyntaxKind.StarToken
            && Current.Kind == SyntaxKind.EqualsToken)
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new IndirectAssignmentExpressionSyntax(syntaxTree, unaryDeref, equalsToken, value);
        }

        // Issue #1925: compound indirect assignment `*p op= expr` (e.g.
        // `*(p + i) += 1`), for ANY compound operator (`+=`, `-=`, `*=`, ...).
        // Mirrors the plain `=` case above; the binder single-evaluates the
        // pointer expression via a synthesized temp local (see
        // CompoundIndexAssignmentExpressionSyntax for the analogous indexer
        // pattern) before desugaring to `*tmp = *tmp op value`.
        if (expression is UnaryExpressionSyntax unaryDerefCompound
            && unaryDerefCompound.OperatorToken.Kind == SyntaxKind.StarToken
            && SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Current.Kind, out _))
        {
            var compoundOpToken = NextToken();
            var value = ParseAssignmentExpression();
            return new IndirectCompoundAssignmentExpressionSyntax(syntaxTree, unaryDerefCompound, compoundOpToken, value);
        }

        // Stream B′: `receiver.Event += handler` / `receiver.Event -= handler`
        // is captured as an EventSubscriptionExpressionSyntax once the LHS has
        // been parsed as a member-access chain. The binder later validates that
        // the LHS resolves to a CLR EventInfo.
        //
        // Issue #2154: any OTHER compound operator (`*=`, `/=`, `%=`, `^=`,
        // `&=`, `|=`, ...) on the same member-access LHS can never denote an
        // event (events only support `+=`/`-=`), but it MAY denote a compound
        // assignment through a user-defined `operator` overload (e.g.
        // `obj.Field *= 2` where Field's type declares `operator *`). Route it
        // through the same EventSubscriptionExpressionSyntax node — the binder
        // dispatches on the actual operator token kind, skipping event lookup
        // entirely for non-`+=`/`-=` operators and going straight to compound
        // assignment.
        if (expression is AccessorExpressionSyntax accessor
            && SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Current.Kind, out _))
        {
            var opToken = NextToken();
            var rhs = ParseAssignmentExpression();
            return new EventSubscriptionExpressionSyntax(syntaxTree, accessor, opToken, rhs);
        }

        // Issue #1104: base-selector property assignment
        // `base[BaseClass].Prop = value`. The LHS parses to a parenthesis-less
        // property-form BaseInterfaceCallExpressionSyntax; attach the `= value`
        // tail so the binder routes it through the base-class property WRITE
        // path. Mirrors the indirect-assignment detection above.
        if (expression is BaseInterfaceCallExpressionSyntax basePropForm
            && basePropForm.IsPropertyAccess
            && !basePropForm.IsPropertyWrite
            && Current.Kind == SyntaxKind.EqualsToken)
        {
            var equalsToken = NextToken();
            var value = ParseAssignmentExpression();
            return new BaseInterfaceCallExpressionSyntax(
                syntaxTree,
                basePropForm.BaseKeyword,
                basePropForm.OpenBracketToken,
                basePropForm.InterfaceTypeClause,
                basePropForm.CloseBracketToken,
                basePropForm.DotToken,
                basePropForm.MethodIdentifier,
                equalsToken,
                value);
        }

        return expression;
    }

    // Issue #1038: parse a standalone range expression `lo..hi` (and the open
    // forms `..hi`, `lo..`, `..`) producing a `System.Range` value. The `..`
    // operator binds looser than every binary operator, so `1+2..3+4` parses as
    // `(1+2)..(3+4)`: each bound is a full null-coalescing expression. A from-end
    // `^n` marker is recognised only in the *upper* bound (immediately after
    // `..`), where it is unambiguous with one's-complement; a leading `^` at the
    // very start keeps its one's-complement meaning and the binder rejects such a
    // standalone lower bound with GS0410 (use `arr[^a..]` or parenthesise).
    //
    // While parsing an index bound the range layer is suppressed (see
    // <see cref="suppressRangeOperator"/>) so `a[lo..hi]` / `a[^2..]` stay owned
    // by <see cref="ParseIndexArgument"/>.
    private ExpressionSyntax ParseRangeExpression()
    {
        if (suppressRangeOperator > 0)
        {
            return ParseNullCoalescingExpression();
        }

        ExpressionSyntax lower = null;
        if (Current.Kind != SyntaxKind.DotDotToken)
        {
            lower = ParseNullCoalescingExpression();
        }

        if (Current.Kind != SyntaxKind.DotDotToken)
        {
            // No `..` follows — an ordinary expression (`lower` is non-null here
            // because the open-lower `..` form is handled by the branch above).
            return lower;
        }

        var dotDotToken = NextToken();

        ExpressionSyntax upper = null;
        if (RangeUpperBoundFollows(dotDotToken))
        {
            upper = ParseRangeUpperBound();
        }

        return new RangeExpressionSyntax(syntaxTree, lower, dotDotToken, upper);
    }

    // Issue #1038: decide whether an upper bound follows a standalone `lo..`. The
    // open-ended form `lo..` ends at a closing delimiter, a separator, or a
    // newline (G# treats a line break after `..` as terminating the open range,
    // so `let r = 1..\nfoo()` is `1..` followed by a fresh statement rather than
    // `1..foo()`).
    private bool RangeUpperBoundFollows(SyntaxToken dotDotToken)
    {
        if (IsCurrentOnNewLineAfter(dotDotToken))
        {
            return false;
        }

        switch (Current.Kind)
        {
            case SyntaxKind.CloseParenthesisToken:
            case SyntaxKind.CloseBraceToken:
            case SyntaxKind.CloseSquareBracketToken:
            case SyntaxKind.CommaToken:
            case SyntaxKind.SemicolonToken:
            case SyntaxKind.ColonToken:
            case SyntaxKind.EqualsToken:
            case SyntaxKind.EndOfFileToken:
            case SyntaxKind.DotDotToken:
                return false;
            default:
                return true;
        }
    }

    // Issue #1038: parse the upper bound of a standalone range. A leading `^`
    // here (immediately after `..`) is the from-end marker (`lo..^hi`, `..^3`),
    // reusing the #1022 `FromEndIndexExpressionSyntax`; otherwise the bound is an
    // ordinary null-coalescing expression.
    private ExpressionSyntax ParseRangeUpperBound()
    {
        if (Current.Kind == SyntaxKind.HatToken)
        {
            var hatToken = NextToken();
            var operand = ParseNullCoalescingExpression();
            return new FromEndIndexExpressionSyntax(syntaxTree, hatToken, operand);
        }

        return ParseNullCoalescingExpression();
    }

    // Issue #941: `a ?? b` binary null-coalescing operator. Parsed as its own
    // layer between the binary-operator loop and the assignment/ternary tail so
    // that it (a) binds at a precedence strictly below `||` (the lowest binary
    // operator), and (b) is right-associative, so `a ?? b ?? c` parses as
    // `a ?? (b ?? c)` — matching C#'s `??`. The produced node is an ordinary
    // BinaryExpressionSyntax with a QuestionQuestionToken operator, so the
    // binder/emitter reuse the existing NullCoalesce machinery.
    private ExpressionSyntax ParseNullCoalescingExpression()
    {
        // Issue #1602: depth-guarded — the right-associative `??` tail below
        // self-recurses once per operator, so the guard must tick here (not
        // only in ParseAssignmentExpression) for `a ?? a ?? …` chains to be
        // bounded.
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseNullCoalescingExpressionCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private ExpressionSyntax ParseNullCoalescingExpressionCore()
    {
        var left = ParseBinaryExpression();

        if (Current.Kind == SyntaxKind.QuestionQuestionToken)
        {
            var operatorToken = NextToken();
            var right = ParseNullCoalescingExpression();
            return new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    // Issue #1602: depth-guarded wrapper — prefix unary operators (`-`, `!`,
    // `*`, `&`, `++`, `await`, …) recurse directly into ParseBinaryExpression
    // without passing through ParseAssignmentExpression, so deep unary chains
    // need their own tick.
    private ExpressionSyntax ParseBinaryExpression(int parentPrecedence = 0)
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseBinaryExpressionCore(parentPrecedence);
        }
        finally
        {
            recursionDepth--;
        }
    }

    private ExpressionSyntax ParseBinaryExpressionCore(int parentPrecedence)
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

            case SyntaxKind.IdentifierToken
                when IsAnonymousClassLiteralStart():
                // Issue #2243 (ADR-0146): an anonymous-object literal
                // expression in one of the redesigned shapes:
                //   object { let Name = value ... }
                //   object : IFace { func f() { ... } }
                //   object : Base(args) { override func f() ... }
                //   data object { let Name = value ... }
                // `object` (and the leading `data`) are contextual identifiers
                // (used elsewhere as the universal reference-type name and the
                // `data class`/`data struct` modifier), recognized as this
                // literal's lead-in only in these precise shapes — every other
                // position continues to lex and parse exactly as before.
                return ParsePostfixChain(ParseAnonymousClassExpression());

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
    // Issue #1602: depth-guarded wrapper — the postfix loop itself is
    // iterative, but an index argument re-enters the full expression grammar
    // (`a[a[a[…`), so the chain participates in the recursion cycle and ticks
    // the guard while an index (or accessor) argument parse is in flight.
    private ExpressionSyntax ParsePostfixChain(ExpressionSyntax current)
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParsePostfixChainCore(current);
        }
        finally
        {
            recursionDepth--;
        }
    }

    private ExpressionSyntax ParsePostfixChainCore(ExpressionSyntax current)
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
                var savedStructLiteral = suppressStructLiteral;
                suppressStructLiteral = 0;
                ExpressionSyntax index;
                try
                {
                    index = ParseIndexArgument();
                }
                finally
                {
                    suppressTrailingObjectInitializer = savedSuppress;
                    suppressStructLiteral = savedStructLiteral;
                }

                var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                current = new IndexExpressionSyntax(syntaxTree, current, openBracket, index, closeBracket);
            }
            else if (Current.Kind == SyntaxKind.OpenParenthesisToken
                && !IsCurrentOnNewLineAfter(current))
            {
                // Issue #2185: a same-line `(args)` following an arbitrary
                // postfix expression is an *indirect* invocation of that
                // expression's (function-typed) value — e.g. `(h)(value)`,
                // `handler!!(value)`, or a curried `f()(x)`. Bare-identifier and
                // `.member` callees never reach here (their `(args)` is consumed
                // by ParseNameOrCallExpression), so this handles exactly the
                // non-name callee shapes. The newline guard preserves the
                // pre-existing reading of a parenthesised expression on the next
                // line as a separate statement (G# is otherwise
                // newline-insensitive, but a leading-`(` continuation is never
                // written). The binder validates the callee is function-typed.
                var openParen = NextToken();

                var savedInvokeSuppress = suppressTrailingObjectInitializer;
                suppressTrailingObjectInitializer = 0;
                var savedInvokeStructLiteral = suppressStructLiteral;
                suppressStructLiteral = 0;
                var savedInvokeRange = suppressRangeOperator;
                suppressRangeOperator = 0;
                SeparatedSyntaxList<ExpressionSyntax> arguments;
                try
                {
                    arguments = ParseArguments();
                }
                finally
                {
                    suppressTrailingObjectInitializer = savedInvokeSuppress;
                    suppressStructLiteral = savedInvokeStructLiteral;
                    suppressRangeOperator = savedInvokeRange;
                }

                var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
                arguments = MaybeAppendTrailingLambda(arguments);
                current = new CallExpressionSyntax(syntaxTree, current, openParen, arguments, closeParen);
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

    // be reused as the LHS of an indexer assignment. Returns true and yields a
    // canonical `IndexExpression(<receiver-chain>, [k])` when the expression's
    // rightmost primary is an index access; returns false otherwise.
    //
    // Shapes handled (rebuilt accessor chain shown after `=>`):
    //   IndexExpression(t, [k])                                 => itself
    //   AccessorExpression(L, ., IndexExpression(t, [k]))       => IndexExpression(AccessorExpression(L, ., t), [k])
    //   AccessorExpression(L, ., AccessorExpression(M, ., IndexExpression(t, [k])))
    //                                                            => IndexExpression(AccessorExpression(L, ., AccessorExpression(M, ., t)), [k])
    //
    // Issue #507 follow-up: null-conditional accessors (`?.`) are lifted too
    // so `obj.A?.B[k] = v` becomes a valid LHS. The binder
    // (BindMemberIndexAssignmentExpression) splits the receiver chain at the
    // leftmost `?.` and emits a null-conditional write that no-ops when the
    // captured intermediate is `nil`.
    private bool TryLiftTrailingIndexer(ExpressionSyntax expression, out IndexExpressionSyntax canonical)
    {
        if (expression is IndexExpressionSyntax direct)
        {
            canonical = direct;
            return true;
        }

        if (expression is AccessorExpressionSyntax accessor
            && TryLiftTrailingIndexer(accessor.RightPart, out var inner))
        {
            var rebuiltReceiver = new AccessorExpressionSyntax(
                syntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                inner.Target);
            canonical = new IndexExpressionSyntax(
                syntaxTree,
                rebuiltReceiver,
                inner.OpenBracketToken,
                inner.Index,
                inner.CloseBracketToken);
            return true;
        }

        canonical = null;
        return false;
    }

    /// <summary>
    /// Issue #648: decomposes an <see cref="AccessorExpressionSyntax"/> whose
    /// trailing segment is a plain <see cref="NameExpressionSyntax"/> into the
    /// receiver chain, the dot token, and the terminal field identifier. Used to
    /// parse chained member-access assignment (<c>a.B.C = v</c>).
    /// </summary>
    /// <remarks>
    /// The accessor tree right-nests: <c>a.B.C</c> parses as
    /// <c>Accessor(a, ., Accessor(B, ., C))</c>. This method recursively peels
    /// the last <see cref="NameExpressionSyntax"/> off the deepest right-hand
    /// side and rebuilds the remaining chain as the receiver.
    /// </remarks>
    private bool TryLiftTrailingMemberAccess(
        ExpressionSyntax expression,
        out ExpressionSyntax receiver,
        out SyntaxToken dotToken,
        out SyntaxToken fieldIdentifier)
    {
        if (expression is AccessorExpressionSyntax accessor)
        {
            if (accessor.RightPart is NameExpressionSyntax name)
            {
                receiver = accessor.LeftPart;
                dotToken = accessor.DotToken;
                fieldIdentifier = name.IdentifierToken;
                return true;
            }

            if (accessor.RightPart is AccessorExpressionSyntax
                && TryLiftTrailingMemberAccess(accessor.RightPart, out var innerReceiver, out dotToken, out fieldIdentifier))
            {
                receiver = new AccessorExpressionSyntax(
                    syntaxTree,
                    accessor.LeftPart,
                    accessor.DotToken,
                    innerReceiver);
                return true;
            }
        }

        receiver = null;
        dotToken = default;
        fieldIdentifier = default;
        return false;
    }
}
