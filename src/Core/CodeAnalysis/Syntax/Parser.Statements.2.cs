// <copyright file="Parser.Statements.2.cs" company="GSharp">
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


    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    // ──────────────────────────────────────────────────────────────────────
    private IfLetStatementSyntax ParseIfLetStatement()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        var bindings = ParseIfLetBindingList();
        var thenStatement = ParseStatement();
        var elseClause = ParseElseClause();
        return new IfLetStatementSyntax(syntaxTree, ifKeyword, bindings, thenStatement, elseClause);
    }

    private GuardLetStatementSyntax ParseGuardLetStatement()
    {
        var guardKeyword = MatchToken(SyntaxKind.GuardKeyword);
        var bindings = ParseIfLetBindingList();
        var elseKeyword = MatchToken(SyntaxKind.ElseKeyword);
        var elseStatement = ParseStatement();
        return new GuardLetStatementSyntax(syntaxTree, guardKeyword, bindings, elseKeyword, elseStatement);
    }

    private SeparatedSyntaxList<IfLetBindingClauseSyntax> ParseIfLetBindingList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            nodesAndSeparators.Add(ParseIfLetBindingClause());
            if (Current.Kind != SyntaxKind.CommaToken)
            {
                break;
            }

            // Only treat a comma as a binding separator if it is followed by
            // another `let` keyword. Anything else (a trailing comma, a list
            // expression) is left to the outer parser to flag.
            if (Peek(1).Kind != SyntaxKind.LetKeyword)
            {
                break;
            }

            nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
        }

        return new SeparatedSyntaxList<IfLetBindingClauseSyntax>(nodesAndSeparators.ToImmutable());
    }

    private IfLetBindingClauseSyntax ParseIfLetBindingClause()
    {
        var letKeyword = MatchToken(SyntaxKind.LetKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClauseBeforeEquals();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress both trailing object initializers (`Foo() { X = 1 }`) AND
        // bare struct literals (`Ident { }`) so the enclosing `{` is the body
        // of the `if let` / `guard let`, not the initializer's shape.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax initializer;
        try
        {
            initializer = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        return new IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer);
    }

    private TypeClauseSyntax ParseOptionalTypeClauseBeforeEquals()
    {
        // A binding clause is always followed by `=`; if we see `=` directly
        // there is no type annotation. Otherwise reuse the regular optional
        // type-clause parser (which already handles `[]T`, `map[K,V]`, `T?`,
        // `chan T`, etc.).
        if (Current.Kind == SyntaxKind.EqualsToken)
        {
            return null;
        }

        return ParseOptionalTypeClause();
    }

    private StatementSyntax ParseForStatement()
    {
        if (Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            return ParseForInfiniteStatement();
        }

        if (LooksLikeForRange())
        {
            return ParseForRangeStatement();
        }

        if (LooksLikeForEllipsis())
        {
            return ParseForEllipsisStatement();
        }

        if (LooksLikeForClause())
        {
            return ParseForClauseStatement();
        }

        return ParseForConditionStatement();
    }

    private bool LooksLikeForRange()
    {
        // `for <ident> := range <expr> { ... }`
        // `for <ident>, <ident> := range <expr> { ... }`
        // `for <ident> in <expr> { ... }`
        // `for <ident>, <ident> in <expr> { ... }`
        //
        // NB: `for <ident> in <lo> ... <hi> { ... }` is the integer-range
        // (ellipsis) form (ADR-0077). The shared `in` token means we must
        // peek past the collection / lower-bound expression to see whether
        // an ellipsis follows — if so, this is *not* the range form.
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        int o = 2;
        bool hasCommaSecondId = false;
        if (Peek(o).Kind == SyntaxKind.CommaToken)
        {
            if (Peek(o + 1).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            hasCommaSecondId = true;
            o += 2;
        }

        if (Peek(o).Kind == SyntaxKind.IdentifierToken && Peek(o).Text == "in")
        {
            // A `k, v in dict` form never collides with the ellipsis form
            // (ellipsis is single-identifier only) — accept immediately.
            if (hasCommaSecondId)
            {
                return true;
            }

            // Single-identifier `in`: distinguish from `for i in lo ... hi`
            // by scanning ahead for an ellipsis at depth zero before the
            // body's open brace.
            return !HasEllipsisBeforeBrace(o + 1);
        }

        if (Peek(o).Kind != SyntaxKind.ColonEqualsToken)
        {
            return false;
        }

        return Peek(o + 1).Kind == SyntaxKind.RangeKeyword;
    }

    private bool HasEllipsisBeforeBrace(int startOffset)
    {
        int depth = 0;
        for (int i = startOffset; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.EllipsisToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.SemicolonToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private bool LooksLikeForEllipsis()
    {
        // Canonical: `for <ident> in <expr> ... <expr> { ... }`
        // Legacy (removed by ADR-0077 / issue #717, but still recognised by
        // the parser so it can emit GS0305 instead of a parse cascade):
        //   `for <ident> := <expr> ... <expr> { ... }`
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var separator = Peek(2);
        var hasSeparator = separator.Kind == SyntaxKind.ColonEqualsToken
            || (separator.Kind == SyntaxKind.IdentifierToken && separator.Text == "in");
        if (!hasSeparator)
        {
            return false;
        }

        int depth = 0;
        for (int i = 3; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.EllipsisToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.SemicolonToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private bool LooksLikeForClause()
    {
        // `for [init]; [cond]; [post] { ... }` — a semicolon at depth zero
        // before the opening brace marks the C-style clause form.
        if (Peek(1).Kind == SyntaxKind.SemicolonToken)
        {
            return true;
        }

        int depth = 0;
        for (int i = 1; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.SemicolonToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private StatementSyntax ParseForConditionStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var condition = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForConditionStatementSyntax(syntaxTree, keyword, condition, body);
    }

    private StatementSyntax ParseForClauseStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);

        StatementSyntax initializer = null;
        if (Current.Kind != SyntaxKind.SemicolonToken)
        {
            initializer = ParseSimpleStatement();
        }

        var firstSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        ExpressionSyntax condition = null;
        if (Current.Kind != SyntaxKind.SemicolonToken)
        {
            condition = ParseExpressionInBodyHeader();
        }

        var secondSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        StatementSyntax post = null;
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            // Issue #1023: the post statement sits immediately before the body
            // `{`. Suppress trailing object-initializer wrapping so an indexer-
            // or call-tailed post (`s += arr[s] { … }`) does not consume the
            // loop body's opening brace as a composite literal.
            suppressTrailingObjectInitializer++;
            try
            {
                post = ParseSimpleStatement();
            }
            finally
            {
                suppressTrailingObjectInitializer--;
            }
        }

        var body = ParseStatement();
        return new ForClauseStatementSyntax(syntaxTree, keyword, initializer, firstSemicolon, condition, secondSemicolon, post, body);
    }

    private StatementSyntax ParseSimpleStatement()
    {
        // A "simple statement" in the for-header / if-init context is one of:
        //   variable declaration      `var x = expr` / `let x = expr` (ADR-0077)
        //   legacy short var decl     `x := expr`    — GS0305, removed
        //   increment/decrement       `x++` / `x--`
        //   assignment                `x = expr`, `x += expr`, ...
        //   expression statement      `f()`
        if (Current.Kind == SyntaxKind.VarKeyword || Current.Kind == SyntaxKind.LetKeyword)
        {
            return ParseVariableDeclaration();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.ColonEqualsToken)
        {
            return ParseSingleShortVariableDeclaration();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken &&
            (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken))
        {
            return ParseIncrementDecrementStatement();
        }

        return ParseExpressionStatement();
    }

    private StatementSyntax ParseForInfiniteStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var body = ParseStatement();
        return new ForInfiniteStatementSyntax(syntaxTree, keyword, body);
    }

    private StatementSyntax ParseForRangeStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var firstIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken commaToken = null;
        SyntaxToken secondIdentifier = null;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            commaToken = MatchToken(SyntaxKind.CommaToken);
            secondIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        }

        SyntaxToken colonEqualsToken = null;
        SyntaxToken rangeKeyword = null;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            inToken = NextToken();
        }
        else
        {
            // ADR-0077 / issue #717: `for v := range coll` (and its `for k, v :=
            // range dict` sibling) is removed. The canonical `for v in coll`
            // form already exists (ADR-0031); emit GS0305 and recover by
            // synthesising an `in` token so binding still produces a
            // `BoundForRangeStatement` and downstream diagnostics are clean.
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword);
            var snippet = secondIdentifier == null
                ? $"for {firstIdentifier.Text} in …"
                : $"for {firstIdentifier.Text}, {secondIdentifier.Text} in …";
            Diagnostics.ReportColonEqualsRemoved(colonEqualsToken.Location, snippet);
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", null);
            colonEqualsToken = null;
            rangeKeyword = null;
        }

        var collection = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForRangeStatementSyntax(syntaxTree, keyword, firstIdentifier, commaToken, secondIdentifier, colonEqualsToken, rangeKeyword, inToken, collection, body);
    }

    private StatementSyntax ParseForEllipsisStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken colonEqualsToken;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            // ADR-0077 / issue #717: `for i in lo ... hi` is the canonical
            // integer-range form. The legacy `:=` spelling is removed below.
            inToken = NextToken();
            colonEqualsToken = null;
        }
        else
        {
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            Diagnostics.ReportColonEqualsRemoved(
                colonEqualsToken.Location,
                $"for {identifier.Text} in lo ... hi");
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", null);
        }

        var lowerBound = ParseExpressionInBodyHeader();
        var toKeyword = MatchToken(SyntaxKind.EllipsisToken);
        var upperBound = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForEllipsisStatementSyntax(syntaxTree, keyword, identifier, inToken, lowerBound, toKeyword, upperBound, body);
    }

    private StatementSyntax ParseBreakStatement()
    {
        var keyword = MatchToken(SyntaxKind.BreakKeyword);
        var label = TryParseLoopTargetLabel(keyword);
        return new BreakStatementSyntax(syntaxTree, keyword, label);
    }

    private StatementSyntax ParseContinueStatement()
    {
        var keyword = MatchToken(SyntaxKind.ContinueKeyword);
        var label = TryParseLoopTargetLabel(keyword);
        return new ContinueStatementSyntax(syntaxTree, keyword, label);
    }

    private StatementSyntax ParseLabeledLoopStatement()
    {
        var label = MatchToken(SyntaxKind.IdentifierToken);
        var colon = MatchToken(SyntaxKind.ColonToken);
        var inner = ParseStatement();
        return new LabeledStatementSyntax(syntaxTree, label, colon, inner);
    }

    private StatementSyntax ParseWhileStatement()
    {
        // ADR-0070: `while cond { body }` — same lowering as `for cond { body }`.
        var keyword = MatchToken(SyntaxKind.WhileKeyword);
        var condition = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new WhileStatementSyntax(syntaxTree, keyword, condition, body);
    }

    private StatementSyntax ParseDoWhileStatement()
    {
        // ADR-0070: `do { body } while cond` — post-test loop. The trailing
        // `while` keyword reuses SyntaxKind.WhileKeyword so the lexer is
        // unchanged; the parser disambiguates by remembering it saw `do`.
        var doKeyword = MatchToken(SyntaxKind.DoKeyword);
        var body = ParseStatement();
        var whileKeyword = MatchToken(SyntaxKind.WhileKeyword);
        var condition = ParseExpression();
        return new DoWhileStatementSyntax(syntaxTree, doKeyword, body, whileKeyword, condition);
    }

    private StatementSyntax ParseReturnStatement()
    {
        var keyword = MatchToken(SyntaxKind.ReturnKeyword);
        var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);
        var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);
        var isEof = Current.Kind == SyntaxKind.EndOfFileToken;
        var sameLine = !isEof && keywordLine == currentLine;
        SyntaxToken refKeyword = null;
        ExpressionSyntax expression = null;
        if (sameLine)
        {
            // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier directly
            // following `return` marks this as a ref-return: `return ref <lvalue>`. The
            // modifier is consumed only when an expression-starting token follows on the
            // same line, preserving backward compatibility for `return ref` where `ref` is
            // itself the identifier being returned (the binder rejects `return ref` with
            // no operand on a ref-returning function).
            if (Current.Kind == SyntaxKind.IdentifierToken
                && Current.Text == "ref"
                && CanStartExpression(Peek(1))
                && syntaxTree.Text.GetLineIndex(Peek(1).Span.Start) == keywordLine)
            {
                refKeyword = NextToken();
            }

            expression = ParseExpression();

            // Phase 4.6: multi-return support. `return e1, e2, ...` lowers to
            // returning a tuple literal so callers can deconstruct or bind it
            // through the standard tuple machinery.
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
                nodesAndSeparators.Add(expression);
                var syntheticOpen = new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, keyword.Position, null, null);
                while (Current.Kind == SyntaxKind.CommaToken)
                {
                    nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                    nodesAndSeparators.Add(ParseExpression());
                }

                var syntheticClose = new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, Current.Position, null, null);
                var elements = new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
                expression = new TupleLiteralExpressionSyntax(syntaxTree, syntheticOpen, elements, syntheticClose);
            }
        }

        return new ReturnStatementSyntax(syntaxTree, keyword, refKeyword, expression);
    }

    private StatementSyntax ParseYieldStatement()
    {
        // ADR-0040: `yield <expr>` statement. The `yield` token is a contextual
        // identifier (not a reserved keyword) to preserve source compatibility.
        var yieldToken = MatchToken(SyntaxKind.IdentifierToken);
        var expression = ParseExpression();
        return new YieldStatementSyntax(syntaxTree, yieldToken, expression);
    }

    private StatementSyntax ParseSwitchStatement()
    {
        var switchKeyword = MatchToken(SyntaxKind.SwitchKeyword);
        var expression = ParseExpressionInBodyHeader();
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var cases = ImmutableArray.CreateBuilder<SwitchCaseSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;
            cases.Add(ParseSwitchCase());

            // Defensive: if ParseSwitchCase failed to consume any token, break to
            // avoid an infinite loop.
            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SwitchStatementSyntax(syntaxTree, switchKeyword, expression, openBrace, cases.ToImmutable(), closeBrace);
    }

    private SwitchCaseSyntax ParseSwitchCase()
    {
        if (Current.Kind == SyntaxKind.DefaultKeyword)
        {
            var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
            var body = ParseBlockStatement();
            return new SwitchCaseSyntax(syntaxTree, defaultKeyword, value: null, whenKeyword: null, guard: null, body);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);
        var value = ParsePattern();
        var (whenKeyword, guard) = ParseOptionalWhenGuard();
        var caseBody = ParseBlockStatement();
        return new SwitchCaseSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard, caseBody);
    }

    // Issue #991: a contextual `when <bool-expr>` guard may follow the pattern
    // in a switch arm. `when` is not a reserved keyword in G#, so it is matched
    // contextually as an identifier whose text is "when"; this keeps existing
    // identifiers named `when` usable everywhere else. Returns (null, null) when
    // no guard is present.
    private (SyntaxToken WhenKeyword, ExpressionSyntax Guard) ParseOptionalWhenGuard()
    {
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "when")
        {
            var whenKeyword = NextToken();
            var guard = ParseExpression();
            return (whenKeyword, guard);
        }

        return (null, null);
    }

    private StatementSyntax ParseFallthroughStatement()
    {
        // ADR-0013: `fallthrough` is reserved but unsupported. Consume the token and
        // emit a diagnostic so user code surfaces a clear error.
        var keyword = MatchToken(SyntaxKind.FallthroughKeyword);
        Diagnostics.ReportFallthroughNotSupported(keyword.Location);
        return new ExpressionStatementSyntax(syntaxTree, new LiteralExpressionSyntax(syntaxTree, keyword, value: 0));
    }

    private StatementSyntax ParseTryStatement()
    {
        var tryKeyword = MatchToken(SyntaxKind.TryKeyword);
        var tryBlock = ParseBlockStatement();

        var catchClauses = ImmutableArray.CreateBuilder<CatchClauseSyntax>();
        while (Current.Kind == SyntaxKind.CatchKeyword)
        {
            catchClauses.Add(ParseCatchClause());
        }

        FinallyClauseSyntax finallyClause = null;
        if (Current.Kind == SyntaxKind.FinallyKeyword)
        {
            var finallyKeyword = NextToken();
            var body = ParseBlockStatement();
            finallyClause = new FinallyClauseSyntax(syntaxTree, finallyKeyword, body);
        }

        return new TryStatementSyntax(syntaxTree, tryKeyword, tryBlock, catchClauses.ToImmutable(), finallyClause);
    }

    private StatementSyntax ParseThrowStatement()
    {
        var keyword = MatchToken(SyntaxKind.ThrowKeyword);
        var expression = ParseExpression();
        return new ThrowStatementSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseUsingStatement()
    {
        var keyword = MatchToken(SyntaxKind.UsingKeyword);
        if (Current.Kind != SyntaxKind.LetKeyword &&
            Current.Kind != SyntaxKind.VarKeyword &&
            Current.Kind != SyntaxKind.ConstKeyword)
        {
            // Force the expected keyword diagnostic by matching `let`.
            MatchToken(SyntaxKind.LetKeyword);
        }

        var decl = (VariableDeclarationSyntax)ParseVariableDeclaration();
        return new UsingStatementSyntax(syntaxTree, keyword, decl);
    }

    private StatementSyntax ParseAwaitUsingStatement()
    {
        var awaitKeyword = MatchToken(SyntaxKind.AwaitKeyword);
        var usingKeyword = MatchToken(SyntaxKind.UsingKeyword);
        if (Current.Kind != SyntaxKind.LetKeyword &&
            Current.Kind != SyntaxKind.VarKeyword &&
            Current.Kind != SyntaxKind.ConstKeyword)
        {
            MatchToken(SyntaxKind.LetKeyword);
        }

        var decl = (VariableDeclarationSyntax)ParseVariableDeclaration();
        return new AwaitUsingStatementSyntax(syntaxTree, awaitKeyword, usingKeyword, decl);
    }

    private StatementSyntax ParseGoStatement()
    {
        var keyword = MatchToken(SyntaxKind.GoKeyword);
        var expression = ParseExpression();
        return new GoStatementSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseDeferStatement()
    {
        var keyword = MatchToken(SyntaxKind.DeferKeyword);
        var expression = ParseExpression();
        return new DeferStatementSyntax(syntaxTree, keyword, expression);
    }

    private StatementSyntax ParseScopeStatement()
    {
        // Phase 5.7 / ADR-0022: `scope { … }` opens a structured-concurrency region.
        var scopeKeyword = MatchToken(SyntaxKind.ScopeKeyword);
        var body = ParseBlockStatement();
        return new ScopeStatementSyntax(syntaxTree, scopeKeyword, body);
    }

    private StatementSyntax ParseAwaitForRangeStatement()
    {
        // Canonical: `await for v in stream { … }` (ADR-0031).
        // Legacy `:=` spelling removed by ADR-0077 / issue #717 — emit GS0305
        // when the parser still encounters it.
        var awaitKeyword = MatchToken(SyntaxKind.AwaitKeyword);
        var forKeyword = MatchToken(SyntaxKind.ForKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken colonEquals = null;
        SyntaxToken rangeKeyword = null;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            inToken = NextToken();
        }
        else
        {
            colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword);
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                $"await for {identifier.Text} in …");
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEquals.Position, "in", null);
            colonEquals = null;
            rangeKeyword = null;
        }

        var stream = ParseExpressionInBodyHeader();
        var body = ParseBlockStatement();
        return new AwaitForRangeStatementSyntax(
            syntaxTree, awaitKeyword, forKeyword, identifier, colonEquals, rangeKeyword, inToken, stream, body);
    }

    private StatementSyntax ParseSelectStatement()
    {
        // Phase 5.6 / ADR-0022: `select { case <-ch { … } case ch <- v { … }
        //                                  case v := <-ch { … } default { … } }`.
        var selectKeyword = MatchToken(SyntaxKind.SelectKeyword);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var cases = ImmutableArray.CreateBuilder<SelectCaseSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;
            cases.Add(ParseSelectCase());

            // Defensive: avoid infinite loops if ParseSelectCase failed to advance.
            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SelectStatementSyntax(syntaxTree, selectKeyword, openBrace, cases.ToImmutable(), closeBrace);
    }
}
