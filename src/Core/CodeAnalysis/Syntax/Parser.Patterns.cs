// <copyright file="Parser.Patterns.cs" company="GSharp">
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

    private PatternSyntax ParsePattern()
    {
        return ParseOrPattern();
    }

    // Combinator precedence (matches C#): `not` binds tightest, then `and`,
    // then `or`. `and` / `or` / `not` are contextual keywords matched as
    // identifiers in pattern position so they remain usable as ordinary
    // identifiers elsewhere.
    private PatternSyntax ParseOrPattern()
    {
        var left = ParseAndPattern();
        while (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "or")
        {
            var operatorToken = NextToken();
            var right = ParseAndPattern();
            left = new BinaryPatternSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    private PatternSyntax ParseAndPattern()
    {
        var left = ParseUnaryPattern();
        while (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "and")
        {
            var operatorToken = NextToken();
            var right = ParseUnaryPattern();
            left = new BinaryPatternSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    // Issue #1602: depth-guarded wrapper — every pattern nesting cycle
    // (parenthesized, list, property, and `not` chains) passes through
    // ParseUnaryPattern, so a single tick here bounds the whole pattern
    // grammar.
    private PatternSyntax ParseUnaryPattern()
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseUnaryPatternCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private PatternSyntax ParseUnaryPatternCore()
    {
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "not")
        {
            var notKeyword = NextToken();
            var operand = ParseUnaryPattern();
            return new NotPatternSyntax(syntaxTree, notKeyword, operand);
        }

        return ParsePrimaryPattern();
    }

    private PatternSyntax ParsePrimaryPattern()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.OpenParenthesisToken:
                return ParseParenthesizedPattern();
            case SyntaxKind.OpenSquareBracketToken:
                return ParseListPattern();
            case SyntaxKind.OpenBraceToken:
                return ParsePropertyPattern();
            case SyntaxKind.IdentifierToken when Peek(1).Kind == SyntaxKind.IsKeyword:
                return ParseTypePattern();
            case SyntaxKind.IdentifierToken when Current.Text == "_" && Peek(1).Kind != SyntaxKind.OpenParenthesisToken && Peek(1).Kind != SyntaxKind.DotToken:
                return new DiscardPatternSyntax(syntaxTree, MatchToken(SyntaxKind.IdentifierToken));
            case SyntaxKind.LessToken:
            case SyntaxKind.LessOrEqualsToken:
            case SyntaxKind.GreaterToken:
            case SyntaxKind.GreaterOrEqualsToken:
            case SyntaxKind.EqualsEqualsToken:
            case SyntaxKind.BangEqualsToken:
                return ParseRelationalPattern();
            default:
                return new ConstantPatternSyntax(syntaxTree, ParseExpression());
        }
    }

    private PatternSyntax ParseParenthesizedPattern()
    {
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var pattern = ParsePattern();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new ParenthesizedPatternSyntax(syntaxTree, openParen, pattern, closeParen);
    }

    private PatternSyntax ParseTypePattern()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var isKeyword = MatchToken(SyntaxKind.IsKeyword);
        var type = ParseTypeClause();
        return new TypePatternSyntax(syntaxTree, identifier, isKeyword, type);
    }

    private PatternSyntax ParseRelationalPattern()
    {
        var operatorToken = NextToken();
        var expression = ParseExpression();
        return new RelationalPatternSyntax(syntaxTree, operatorToken, expression);
    }

    private PatternSyntax ParsePropertyPattern()
    {
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colon = MatchToken(SyntaxKind.ColonToken);
            var pattern = ParsePattern();
            nodesAndSeparators.Add(new PropertyPatternFieldSyntax(syntaxTree, identifier, colon, pattern));
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var fields = new SeparatedSyntaxList<PropertyPatternFieldSyntax>(nodesAndSeparators.ToImmutable());
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new PropertyPatternSyntax(syntaxTree, openBrace, fields, closeBrace);
    }

    private PatternSyntax ParseListPattern()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseSquareBracketToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // Issue #1505: a leading `..` is a slice ("rest") subpattern, not a
            // range expression. Without this production it would be consumed by
            // ParsePattern() as a System.Range constant pattern.
            if (Current.Kind == SyntaxKind.DotDotToken)
            {
                nodesAndSeparators.Add(ParseSlicePattern());
            }
            else
            {
                nodesAndSeparators.Add(ParsePattern());
            }

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                break;
            }
        }

        var elements = new SeparatedSyntaxList<PatternSyntax>(nodesAndSeparators.ToImmutable());
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new ListPatternSyntax(syntaxTree, openBracket, elements, closeBracket);
    }

    // Issue #1505: a slice subpattern is `..` optionally followed by a capture
    // identifier (`..rest`) or a sub-pattern (`..[> 0]`). A bare identifier that
    // is not `_`, not part of a type pattern (`id is T`), and immediately
    // followed by `,` or `]` is treated as a capture binding the middle slice to
    // a `[]T` variable. Everything else after `..` is parsed as a sub-pattern
    // matched against the middle slice.
    private PatternSyntax ParseSlicePattern()
    {
        var dotDot = MatchToken(SyntaxKind.DotDotToken);
        SyntaxToken captureIdentifier = null;
        PatternSyntax pattern = null;

        var isBareIdentifier = Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind != SyntaxKind.IsKeyword
            && (Peek(1).Kind == SyntaxKind.CommaToken || Peek(1).Kind == SyntaxKind.CloseSquareBracketToken);

        if (isBareIdentifier && Current.Text != "_")
        {
            captureIdentifier = NextToken();
        }
        else if (isBareIdentifier)
        {
            // `.._` — an explicit discard of the slice; consume the `_` and
            // leave it as a plain discard slice (no capture, no sub-pattern).
            NextToken();
        }
        else if (Current.Kind != SyntaxKind.CommaToken
            && Current.Kind != SyntaxKind.CloseSquareBracketToken
            && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            pattern = ParsePattern();
        }

        return new SlicePatternSyntax(syntaxTree, dotDot, captureIdentifier, pattern);
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

    private CatchClauseSyntax ParseCatchClause()
    {
        var catchKeyword = MatchToken(SyntaxKind.CatchKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var body = ParseBlockStatement();
        return new CatchClauseSyntax(syntaxTree, catchKeyword, openParen, identifier, typeClause, closeParen, body);
    }

    private StatementSyntax ParseThrowStatement()
    {
        var keyword = MatchToken(SyntaxKind.ThrowKeyword);
        var expression = ParseExpression();
        return new ThrowStatementSyntax(syntaxTree, keyword, expression);
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

        var decl = ParseVariableDeclaration();
        if (decl is not VariableDeclarationSyntax variableDecl)
        {
            // Issue #1603: `let (a, b) = …` / `let { … } = …` deconstructions
            // aren't a single variable declaration, so `using` can't wrap
            // them. Report and recover with the deconstruction statement
            // itself (no disposal), instead of an InvalidCastException.
            Diagnostics.ReportUsingRequiresSingleVariableDeclaration(decl.Location);
            return decl;
        }

        return new UsingStatementSyntax(syntaxTree, keyword, variableDecl);
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

        var decl = ParseVariableDeclaration();
        if (decl is not VariableDeclarationSyntax variableDecl)
        {
            Diagnostics.ReportUsingRequiresSingleVariableDeclaration(decl.Location);
            return decl;
        }

        return new AwaitUsingStatementSyntax(syntaxTree, awaitKeyword, usingKeyword, variableDecl);
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

    private SelectCaseSyntax ParseSelectCase()
    {
        if (Current.Kind == SyntaxKind.DefaultKeyword)
        {
            var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                defaultKeyword,
                SelectCaseKind.Default,
                identifier: null,
                channel: null,
                value: null,
                body);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);

        // case <-ch { ... } — receive, discard.
        if (Current.Kind == SyntaxKind.LeftArrowToken)
        {
            NextToken(); // consume `<-`
            var channel = ParseExpression();
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveDiscard,
                identifier: null,
                channel,
                value: null,
                body);
        }

        // case let v = <-ch { ... } — receive, bind (ADR-0077).
        if (Current.Kind == SyntaxKind.LetKeyword &&
            Peek(1).Kind == SyntaxKind.IdentifierToken &&
            Peek(2).Kind == SyntaxKind.EqualsToken &&
            Peek(3).Kind == SyntaxKind.LeftArrowToken)
        {
            NextToken(); // consume `let`
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            MatchToken(SyntaxKind.EqualsToken);
            MatchToken(SyntaxKind.LeftArrowToken);
            var channel = ParseExpression();
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveBind,
                identifier,
                channel,
                value: null,
                body);
        }

        // case v := <-ch { ... } — legacy receive-bind. ADR-0077 / issue #717
        // removes `:=`; emit GS0305 and recover by binding the identifier as
        // a `case let v = <-ch` would.
        if (Current.Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.ColonEqualsToken &&
            Peek(2).Kind == SyntaxKind.LeftArrowToken)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                $"case let {identifier.Text} = <-ch");
            MatchToken(SyntaxKind.LeftArrowToken);
            var channel = ParseExpression();
            var body = ParseBlockStatement();
            return new SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveBind,
                identifier,
                channel,
                value: null,
                body);
        }

        // case ch <- v { ... } — send.
        var sendChannel = ParseExpression();
        MatchToken(SyntaxKind.LeftArrowToken);
        var sendValue = ParseExpression();
        var sendBody = ParseBlockStatement();
        return new SelectCaseSyntax(
            syntaxTree,
            caseKeyword,
            SelectCaseKind.Send,
            identifier: null,
            sendChannel,
            sendValue,
            sendBody);
    }

    private StatementSyntax ParseExpressionStatement()
    {
        var expression = ParseExpression();

        if (Current.Kind == SyntaxKind.QuestionQuestionEqualsToken)
        {
            // ADR-0072 / issue #709: `target ??= value` is also valid as a
            // simple statement inside for-headers and other simple-statement
            // contexts.
            var opToken = NextToken();
            var rhs = ParseExpression();
            return new NullCoalescingAssignmentStatementSyntax(syntaxTree, expression, opToken, rhs);
        }

        return new ExpressionStatementSyntax(syntaxTree, expression);
    }

    private StatementSyntax ParseExpressionOrChannelSendStatement()
    {
        var expression = ParseExpression();
        if (Current.Kind == SyntaxKind.LeftArrowToken)
        {
            // Phase 5.5 / ADR-0022: `ch <- v` is a statement, not an expression.
            var arrow = NextToken();
            var value = ParseExpression();
            return new ChannelSendStatementSyntax(syntaxTree, expression, arrow, value);
        }

        if (Current.Kind == SyntaxKind.QuestionQuestionEqualsToken)
        {
            // ADR-0072 / issue #709: `target ??= value`. The target must be a
            // nullable lvalue. We don't desugar here — the binder validates
            // assignability + nullability and emits a lowered if/assign form.
            var opToken = NextToken();
            var rhs = ParseExpression();
            return new NullCoalescingAssignmentStatementSyntax(syntaxTree, expression, opToken, rhs);
        }

        return new ExpressionStatementSyntax(syntaxTree, expression);
    }
}
