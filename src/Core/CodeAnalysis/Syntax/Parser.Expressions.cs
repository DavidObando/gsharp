// <copyright file="Parser.Expressions.cs" company="GSharp">
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


    // Issue #522: depth counter that suppresses trailing object-initializer
    // wrapping (`Call(args) { Prop = value }`). The default of zero allows
    // wrapping in regular expression contexts (variable declarations, return
    // statements, etc.). Body-header parsers (`if Cond { … }`, `for x := range
    // Coll { … }`, `switch Expr { … }`, etc.) push the counter via
    // <see cref="WithSuppressedObjectInitializer"/> so the following `{` is
    // recognised as the body, not as an initializer.
    //
    // Nested expression contexts (parens, brackets, argument lists) call
    // <see cref="WithAllowedObjectInitializer"/> to save+clear the counter so
    // an inner `T() { … }` still works inside `if Foo(T() { X = 1 }) { … }`.
    private int suppressTrailingObjectInitializer;

    // Separate counter that suppresses `Ident {` struct-literal parsing.
    // Only incremented by ParseIfExpression to prevent the condition from
    // consuming the then-block's opening brace as a struct literal.
    // For-range and other body-header contexts must NOT suppress struct
    // literals — e.g. `for v in Numbers{} { body }` is valid.
    private int suppressStructLiteral;

    // ADR-0122 §4 / issue #1034: tracks the unsafe-context nesting depth while
    // parsing. Inside an unsafe context (`unsafe func`/`unsafe {}`/unsafe
    // type), a single-identifier `p->member` is parsed as pointer member
    // access `(*p).member` rather than a single-identifier arrow lambda
    // `p -> body`; outside unsafe, the lambda interpretation is unchanged. A
    // parenthesised lambda `(x) -> body` remains available in unsafe contexts.
    private int unsafeDepth;

    // Issue #1038: depth counter that suppresses the standalone range operator
    // (`lo..hi`) while parsing the bound of an index expression. Inside `[...]`
    // the `..` token is owned by the index-argument parser
    // (<see cref="ParseIndexArgument"/>), so the general-expression range layer
    // (<see cref="ParseRangeExpression"/>) must stand down there to keep the
    // #1016/#1022 index-range/from-end behaviour byte-for-byte unchanged.
    // Nested grouping contexts (parentheses, argument lists) save+clear the
    // counter so a parenthesised or argument-position range (`a[(1..3)]`,
    // `a[f(1..3)]`) is still recognised as a standalone `System.Range` value.
    private int suppressRangeOperator;

    /// <summary>
    /// Gets tiagnostic bag associated to this parser.
    /// </summary>
    public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

    /// <summary>
    /// Issue #490: returns true when <paramref name="token"/> can plausibly begin an expression
    /// — used by <see cref="ParseReturnStatement"/> to disambiguate the contextual <c>ref</c>
    /// modifier from an identifier expression named <c>ref</c>.
    /// </summary>
    private static bool CanStartExpression(SyntaxToken token)
    {
        switch (token.Kind)
        {
            case SyntaxKind.IdentifierToken:
            case SyntaxKind.NumberToken:
            case SyntaxKind.StringToken:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.AmpersandToken:
            case SyntaxKind.StarToken:
            case SyntaxKind.MinusToken:
            case SyntaxKind.PlusToken:
            case SyntaxKind.BangToken:
            case SyntaxKind.TrueKeyword:
            case SyntaxKind.FalseKeyword:
            case SyntaxKind.NilKeyword:
            case SyntaxKind.FuncKeyword:
                return true;
            default:
                return false;
        }
    }

    private ImmutableArray<EventAccessorSyntax> ParseEventAccessors()
    {
        var accessors = ImmutableArray.CreateBuilder<EventAccessorSyntax>();

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            if (Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text == "add" || Current.Text == "remove" || Current.Text == "raise"))
            {
                var accessorKeyword = NextToken();

                BlockStatementSyntax body = null;
                SyntaxToken semicolon = null;
                if (Current.Kind == SyntaxKind.OpenBraceToken)
                {
                    body = ParseBlockStatement();
                }
                else if (Current.Kind == SyntaxKind.SemicolonToken)
                {
                    semicolon = NextToken();
                }

                accessors.Add(new EventAccessorSyntax(syntaxTree, accessorKeyword, body, semicolon));
            }
            else
            {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                NextToken();
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return accessors.ToImmutable();
    }

    private ImmutableArray<PropertyAccessorSyntax> ParsePropertyAccessors()
    {
        var accessors = ImmutableArray.CreateBuilder<PropertyAccessorSyntax>();

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            if (Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text == "get" || Current.Text == "set" || Current.Text == "init"))
            {
                var accessorKeyword = NextToken();

                // For set/init, optionally parse (paramName)
                SyntaxToken openParen = null;
                SyntaxToken paramIdentifier = null;
                SyntaxToken closeParen = null;
                if ((accessorKeyword.Text == "set" || accessorKeyword.Text == "init") && Current.Kind == SyntaxKind.OpenParenthesisToken)
                {
                    openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                    paramIdentifier = MatchToken(SyntaxKind.IdentifierToken);
                    closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
                }

                // Optional body or semicolon
                BlockStatementSyntax body = null;
                SyntaxToken semicolon = null;
                if (Current.Kind == SyntaxKind.OpenBraceToken)
                {
                    body = ParseBlockStatement();
                }
                else if (Current.Kind == SyntaxKind.RightArrowToken)
                {
                    // Issue #1278 / ADR-0131: an expression-bodied accessor
                    // `get -> expr` / `set -> expr` / `init -> expr`. Desugar
                    // into an equivalent block body so binding and emit reuse
                    // the existing accessor-body path: a getter lowers to
                    // `{ return expr }` and a setter/init lowers to `{ expr }`
                    // (an expression statement, typically an assignment using
                    // the `set(name)` value parameter). Note: G# uses the `->`
                    // arrow, never the C# fat arrow `=>`, which remains a
                    // syntax error below.
                    body = ParseArrowExpressionBody(asReturn: accessorKeyword.Text == "get");
                }
                else if (Current.Kind == SyntaxKind.SemicolonToken)
                {
                    semicolon = NextToken();
                }
                else if (!IsAccessorListTerminator())
                {
                    // Issue #1273: a G# property accessor body is a block `{ }`,
                    // a `->` expression body (issue #1278), or `;` (bare/auto
                    // accessor). Unlike C#, G# has no fat-arrow `=>`
                    // expression-bodied accessor form. Anything else here (e.g.
                    // `get => e`) is a syntax error: report it loudly rather
                    // than silently skipping the tokens, which previously left a
                    // body-less accessor returning the type's default value.
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.OpenBraceToken);
                    SkipMalformedAccessorBody();
                }

                // else: bare accessor (no body, no semicolon) — valid in interfaces
                accessors.Add(new PropertyAccessorSyntax(
                    syntaxTree,
                    accessorKeyword,
                    openParen,
                    paramIdentifier,
                    closeParen,
                    body,
                    semicolon));
            }
            else
            {
                // Unknown token in accessor list — skip to avoid infinite loop.
                NextToken();
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return accessors.ToImmutable();
    }

    // Issue #1278 / ADR-0131: parse the `-> expr` tail of an expression-bodied
    // member (free function, method, operator, conversion operator, property,
    // indexer, or property accessor) and synthesize an equivalent block body so
    // binding, lowering, async, and emit reuse the existing block-body path. A
    // body that yields a value (a getter, or a non-void function/property)
    // lowers to `{ return expr }` (asReturn == true); a value-less body (a void
    // function/method, or a set/init accessor) lowers to `{ expr }`, an
    // expression statement (asReturn == false). The synthesized braces reuse the
    // arrow's source position so diagnostics and spans stay anchored at the
    // member. G# spells this arrow `->` (RightArrowToken); the C# fat arrow `=>`
    // is never accepted.
    private BlockStatementSyntax ParseArrowExpressionBody(bool asReturn)
    {
        var arrowToken = MatchToken(SyntaxKind.RightArrowToken);
        var arrowPosition = arrowToken.Position;

        var expression = ParseExpression();

        var openBrace = new SyntaxToken(syntaxTree, SyntaxKind.OpenBraceToken, arrowPosition, "{", null);
        var closeBrace = new SyntaxToken(syntaxTree, SyntaxKind.CloseBraceToken, arrowPosition, "}", null);

        StatementSyntax statement;
        if (asReturn)
        {
            var returnKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ReturnKeyword, arrowPosition, "return", null);
            statement = new ReturnStatementSyntax(syntaxTree, returnKeyword, expression);
        }
        else
        {
            statement = new ExpressionStatementSyntax(syntaxTree, expression);
        }

        return new BlockStatementSyntax(
            syntaxTree,
            openBrace,
            ImmutableArray.Create(statement),
            closeBrace);
    }

    private bool LooksLikeReceiverClause()
    {
        // Issue #751 (ADR-0084 L2): a receiver clause has the shape
        //   '(' ident <type-clause> ')' (ident | operator) ( '(' | '[' )
        // The original implementation hard-coded a tiny subset of type-clause
        // spellings (bare identifier, `[N]T` / `[]T`). That excluded common
        // shapes like `T?`, `sequence[T]`, `map[K,V]`, `(int, T)`, and
        // combinations thereof, silently demoting an extension-method
        // declaration to a malformed regular function. Rather than mirror
        // the entire type grammar here we scan the candidate receiver as a
        // balanced bracket region: find the matching `)` of the outer
        // parenthesis (bailing on a top-level `,` which would mean a
        // multi-parameter regular parameter list, never a receiver), and
        // then verify the trailing-token shape that distinguishes a
        // receiver clause from a regular parameter list. The actual type
        // grammar is validated when the receiver is parsed for real by
        // `ParseParameter` → `ParseTypeClause` — keeping the type grammar
        // in one place.
        if (Peek(0).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var parenDepth = 1;
        var bracketDepth = 0;
        var ahead = 2;
        var closeParenAhead = -1;
        while (true)
        {
            var kind = Peek(ahead).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            // A top-level `,` means we have a multi-parameter regular
            // parameter list, not a single-parameter receiver clause.
            // Brackets (`[...]`) and inner parens nest freely; only
            // commas at the outer level disqualify.
            if (parenDepth == 1 && bracketDepth == 0 && kind == SyntaxKind.CommaToken)
            {
                return false;
            }

            switch (kind)
            {
                case SyntaxKind.OpenParenthesisToken:
                    parenDepth++;
                    break;
                case SyntaxKind.CloseParenthesisToken:
                    parenDepth--;
                    if (parenDepth == 0)
                    {
                        closeParenAhead = ahead;
                    }

                    break;
                case SyntaxKind.OpenSquareBracketToken:
                    bracketDepth++;
                    break;
                case SyntaxKind.CloseSquareBracketToken:
                    bracketDepth--;
                    if (bracketDepth < 0)
                    {
                        return false;
                    }

                    break;
            }

            if (closeParenAhead >= 0)
            {
                break;
            }

            ahead++;
        }

        // After the closing `)` we must see a function name (identifier or
        // the contextual `operator` keyword for operator-overload streams).
        ahead = closeParenAhead + 1;
        var afterCloseKind = Peek(ahead).Kind;
        if (afterCloseKind != SyntaxKind.IdentifierToken && afterCloseKind != SyntaxKind.OperatorKeyword)
        {
            return false;
        }

        // Stream D: `operator <op>(` follows the receiver clause for operator
        // overloads. Accept any non-EOF token after `operator` here — the
        // operator-token validation happens in MatchOperatorOrIdentifier.
        if (afterCloseKind == SyntaxKind.OperatorKeyword)
        {
            return Peek(ahead + 1).Kind != SyntaxKind.EndOfFileToken
                && Peek(ahead + 2).Kind == SyntaxKind.OpenParenthesisToken;
        }

        // The parameter list opens with `(`, or — for a generic extension
        // function — a type-parameter list `[T]` precedes it (Phase 4.1).
        var afterNameKind = Peek(ahead + 1).Kind;
        return afterNameKind == SyntaxKind.OpenParenthesisToken
            || afterNameKind == SyntaxKind.OpenSquareBracketToken;
    }

    /// <summary>
    /// ADR-0126 / issue #1027: desugars a prefix (<c>++x</c> / <c>--x</c>) or
    /// postfix (<c>x++</c> / <c>x--</c>) increment/decrement <em>expression</em>
    /// into existing value-producing assignment syntax, mirroring the
    /// statement-level desugar in <see cref="ParseIncrementDecrementStatement"/>
    /// and the compound-assignment desugar in
    /// <see cref="ParseAssignmentExpression"/>.
    /// <para>
    /// The write reuses the read-modify-write nodes that already yield the
    /// mutated (new) value: a bare variable lowers to
    /// <c>operand = operand ± 1</c>, an array element / indexer lowers to the
    /// single-evaluating <see cref="CompoundIndexAssignmentExpressionSyntax"/>
    /// (<c>operand ±= 1</c>), and a field lowers to a
    /// <see cref="MemberFieldAssignmentExpressionSyntax"/>.
    /// </para>
    /// <para>
    /// A <em>prefix</em> form yields that new value directly. A <em>postfix</em>
    /// form must yield the value <em>before</em> mutation, so it wraps the write
    /// in <c>(write) ∓ 1</c> — exact for the integer operand types G# accepts
    /// for <c>++</c>/<c>--</c> (the literal <c>1</c> is <c>int32</c>; floating
    /// point operands are rejected by the binder, so no rounding gap exists).
    /// </para>
    /// </summary>
    /// <param name="operand">The already-parsed lvalue operand.</param>
    /// <param name="op">The <c>++</c> or <c>--</c> operator token.</param>
    /// <param name="isPrefix"><see langword="true"/> for the prefix form.</param>
    /// <returns>The desugared value-producing expression.</returns>
    private ExpressionSyntax BuildIncrementDecrementExpression(ExpressionSyntax operand, SyntaxToken op, bool isPrefix)
    {
        var isIncrement = op.Kind == SyntaxKind.PlusPlusToken;
        var baseOpKind = isIncrement ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var inverseOpKind = isIncrement ? SyntaxKind.MinusToken : SyntaxKind.PlusToken;
        var compoundOpKind = isIncrement ? SyntaxKind.PlusEqualsToken : SyntaxKind.MinusEqualsToken;
        var pos = op.Position;

        LiteralExpressionSyntax OneLiteral() =>
            new LiteralExpressionSyntax(syntaxTree, new SyntaxToken(syntaxTree, SyntaxKind.NumberToken, pos, "1", 1), 1);

        ExpressionSyntax write;
        if (TryLiftTrailingIndexer(operand, out var indexed))
        {
            // Array element / indexer: route through the single-evaluating
            // compound-index assignment so the receiver chain is computed once.
            var compoundToken = new SyntaxToken(syntaxTree, compoundOpKind, pos, SyntaxFacts.GetText(compoundOpKind), null);
            write = new CompoundIndexAssignmentExpressionSyntax(syntaxTree, indexed, compoundToken, OneLiteral());
        }
        else
        {
            var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, pos, SyntaxFacts.GetText(baseOpKind), null);
            var newValue = new BinaryExpressionSyntax(syntaxTree, operand, baseOpToken, OneLiteral());
            var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, pos, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);

            if (operand is NameExpressionSyntax name)
            {
                write = new AssignmentExpressionSyntax(syntaxTree, name.IdentifierToken, equalsToken, newValue);
            }
            else if (TryLiftTrailingMemberAccess(operand, out var receiver, out var dotToken, out var fieldIdentifier))
            {
                // Prefer the simple `id.field = value` form when the receiver is
                // a bare name: it binds through the field-assignment path that
                // correctly takes the address of a struct-local receiver in
                // value position (the chained member form copies a value-type
                // receiver by value, which would drop the mutation).
                write = receiver is NameExpressionSyntax simpleReceiver
                    ? new FieldAssignmentExpressionSyntax(syntaxTree, simpleReceiver.IdentifierToken, dotToken, fieldIdentifier, equalsToken, newValue)
                    : new MemberFieldAssignmentExpressionSyntax(syntaxTree, receiver, dotToken, fieldIdentifier, equalsToken, newValue);
            }
            else
            {
                Diagnostics.ReportInvalidIncrementDecrementTarget(operand.Location, op.Text);
                return operand;
            }
        }

        if (isPrefix)
        {
            return write;
        }

        // Postfix yields the value before mutation: (write) ∓ 1.
        var inverseOpToken = new SyntaxToken(syntaxTree, inverseOpKind, pos, SyntaxFacts.GetText(inverseOpKind), null);
        return new BinaryExpressionSyntax(syntaxTree, write, inverseOpToken, OneLiteral());
    }

    private bool LooksLikeMultiAssignment()
    {
        // Pattern: ident, ident (, ident)* (= | :=) ...
        if (Current.Kind != SyntaxKind.IdentifierToken ||
            Peek(1).Kind != SyntaxKind.CommaToken)
        {
            return false;
        }

        int i = 2;
        while (i < 256)
        {
            if (Peek(i).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            var next = Peek(i + 1).Kind;
            if (next == SyntaxKind.CommaToken)
            {
                i += 2;
                continue;
            }

            return next == SyntaxKind.EqualsToken || next == SyntaxKind.ColonEqualsToken;
        }

        return false;
    }

    /// <summary>
    /// Issue #813: lookahead helper for the contextual <c>yield</c> at statement
    /// start. Returns <see langword="true"/> when the token at <paramref name="parenOffset"/>
    /// is a <c>(</c> that opens a value-tuple literal (i.e. its matching
    /// <c>)</c> follows a top-level <c>,</c>). A tuple-literal yield like
    /// <c>yield (a, b)</c> must be parsed as a yield-statement; without this
    /// disambiguation the existing rule rejected every <c>yield (</c> form
    /// because it treats parens as the start of a function-call expression.
    /// </summary>
    private bool LooksLikeYieldTupleLiteral(int parenOffset)
    {
        if (Peek(parenOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var depth = 0;
        var bracketDepth = 0;
        var braceDepth = 0;
        for (var i = parenOffset; i < tokens.Length; i++)
        {
            var t = Peek(i);
            switch (t.Kind)
            {
                case SyntaxKind.OpenParenthesisToken:
                    depth++;
                    break;
                case SyntaxKind.CloseParenthesisToken:
                    depth--;
                    if (depth == 0)
                    {
                        return false;
                    }

                    break;
                case SyntaxKind.OpenSquareBracketToken:
                    bracketDepth++;
                    break;
                case SyntaxKind.CloseSquareBracketToken:
                    bracketDepth--;
                    break;
                case SyntaxKind.OpenBraceToken:
                    braceDepth++;
                    break;
                case SyntaxKind.CloseBraceToken:
                    braceDepth--;
                    break;
                case SyntaxKind.CommaToken:
                    if (depth == 1 && bracketDepth == 0 && braceDepth == 0)
                    {
                        return true;
                    }

                    break;
                case SyntaxKind.EndOfFileToken:
                    return false;
            }
        }

        return false;
    }

    // Issue #1018: parses a throw-expression `throw <expr>` in value position.
    // The operand is parsed at full-expression precedence (greedy), matching
    // C#'s rule that `a ?? throw b ?? c` throws `(b ?? c)`. The throw-expression
    // itself is produced as a primary expression so it composes as the RHS of
    // `??`, a conditional branch, a returned operand, an argument, or an arrow
    // body.
    private ExpressionSyntax ParseThrowExpression()
    {
        var keyword = MatchToken(SyntaxKind.ThrowKeyword);
        var expression = ParseExpression();
        return new ThrowExpressionSyntax(syntaxTree, keyword, expression);
    }

    private ExpressionSyntax ParseExpression()
    {
        return ParseAssignmentExpression();
    }

    private ExpressionSyntax ParseAssignmentExpression()
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

        // Stream B′: `receiver.Event += handler` / `receiver.Event -= handler`
        // is captured as an EventSubscriptionExpressionSyntax once the LHS has
        // been parsed as a member-access chain. The binder later validates that
        // the LHS resolves to a CLR EventInfo.
        if (expression is AccessorExpressionSyntax accessor
            && (Current.Kind == SyntaxKind.PlusEqualsToken || Current.Kind == SyntaxKind.MinusEqualsToken))
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
        var left = ParseBinaryExpression();

        if (Current.Kind == SyntaxKind.QuestionQuestionToken)
        {
            var operatorToken = NextToken();
            var right = ParseNullCoalescingExpression();
            return new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }
}
