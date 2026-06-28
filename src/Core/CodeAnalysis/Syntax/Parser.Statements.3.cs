// <copyright file="Parser.Statements.3.cs" company="GSharp">
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

    // Issue #932: parses the single-identifier arrow-lambda shorthand
    // `x -> body`, equivalent to the parenthesised `(x) -> body`. The opening
    // and closing parentheses are absent (the corresponding tokens are left
    // null and are skipped by SyntaxNode child enumeration / span computation),
    // and the sole parameter carries no type clause, so the binder infers its
    // type from the target delegate exactly as it does for `(x) -> body` (or
    // reports GS0304 when no target type is in scope).
    private LambdaExpressionSyntax ParseSingleIdentifierLambdaExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var parameter = new ParameterSyntax(syntaxTree, identifier, ellipsisToken: null, type: null);
        var parameters = new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray.Create<SyntaxNode>(parameter));
        var arrow = MatchToken(SyntaxKind.RightArrowToken);
        var body = Current.Kind == SyntaxKind.OpenBraceToken
            ? ParseBlockExpression()
            : ParseExpression();
        return new LambdaExpressionSyntax(syntaxTree, asyncModifier: null, openParenToken: null, parameters, closeParenToken: null, arrow, body);
    }

    private ExpressionSyntax ParseSwitchExpression()
    {
        var switchKeyword = MatchToken(SyntaxKind.SwitchKeyword);
        var expression = ParseExpressionInBodyHeader();
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var arms = ImmutableArray.CreateBuilder<SwitchExpressionArmSyntax>();
        while (Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;
            arms.Add(ParseSwitchExpressionArm());

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new SwitchExpressionSyntax(syntaxTree, switchKeyword, expression, openBrace, arms.ToImmutable(), closeBrace);
    }

    private SwitchExpressionArmSyntax ParseSwitchExpressionArm()
    {
        if (Current.Kind == SyntaxKind.DefaultKeyword)
        {
            var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
            var defaultArrow = MatchSwitchExpressionArmSeparator();
            var defaultResult = ParseExpression();
            return new SwitchExpressionArmSyntax(syntaxTree, defaultKeyword, value: null, whenKeyword: null, guard: null, defaultArrow, defaultResult);
        }

        var caseKeyword = MatchToken(SyntaxKind.CaseKeyword);
        var value = ParsePattern();
        var (whenKeyword, guard) = ParseOptionalWhenGuard();
        var arrow = MatchSwitchExpressionArmSeparator();
        var result = ParseExpression();
        return new SwitchExpressionArmSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard, arrow, result);
    }

    // ADR-0074 / issue #714: switch-expression arms accept either `:` (new) or
    // `->` (deprecated). On `->` the parser records GS0302 and continues —
    // both forms produce the same SwitchExpressionArmSyntax node and the
    // separator token's Kind tells callers which form was used.
    private SyntaxToken MatchSwitchExpressionArmSeparator()
    {
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            return MatchToken(SyntaxKind.ColonToken);
        }

        if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            var arrow = MatchToken(SyntaxKind.RightArrowToken);
            Diagnostics.ReportSwitchExpressionArmArrowDeprecated(arrow.Location);
            return arrow;
        }

        return MatchToken(SyntaxKind.ColonToken);
    }

    // ADR-0125 / issue #1026: `fixed name *T = source { … }`. The leading
    // `fixed` is a contextual keyword; the dispatcher in ParseStatement only
    // routes here for the exact `fixed IDENT *` shape. The header mirrors G#'s
    // other paren-less statement headers (`if`/`for`/`while`/`unsafe { }`).
    private StatementSyntax ParseFixedStatement()
    {
        var fixedKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseTypeClause();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress bare struct literals (`Ident { }`) and trailing object
        // initializers so the `{` after the source expression is parsed as the
        // pinned body block, not as part of the source — mirroring the
        // `if let` / `for` header treatment.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax pinnedSource;
        try
        {
            pinnedSource = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        var body = ParseBlockStatement();
        return new FixedStatementSyntax(
            syntaxTree,
            fixedKeyword,
            identifier,
            typeClause,
            equalsToken,
            pinnedSource,
            body);
    }

    // ADR-0061: parse an optional inner `ref`/`in`/`out` modifier on a branch
    // of a conditional ref-argument. Returns the consumed token or null.
    private SyntaxToken TryConsumeInnerRefModifier()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var text = Current.Text;
        if (text != "ref" && text != "in" && text != "out")
        {
            return null;
        }

        var nextKind = Peek(1).Kind;

        // Only treat as a modifier if the next token starts a legal lvalue
        // payload (identifier or `(`). Otherwise leave it as a plain identifier.
        if (!(nextKind == SyntaxKind.IdentifierToken || nextKind == SyntaxKind.OpenParenthesisToken))
        {
            return null;
        }

        return NextToken();
    }

    // Issue #669: parse an if-expression of the form
    // `if cond { expr }`, `if cond { expr } else { expr }`,
    // or `if cond { expr } else if ... { expr } else { expr }`.
    private IfExpressionSyntax ParseIfExpression()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax condition;
        try
        {
            condition = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        var thenBlock = ParseBlockExpression();

        SyntaxToken elseKeyword = null;
        ExpressionSyntax elseExpression = null;
        if (Current.Kind == SyntaxKind.ElseKeyword)
        {
            elseKeyword = NextToken();
            if (Current.Kind == SyntaxKind.IfKeyword)
            {
                elseExpression = ParseIfExpression();
            }
            else
            {
                elseExpression = ParseBlockExpression();
            }
        }

        return new IfExpressionSyntax(syntaxTree, ifKeyword, condition, thenBlock, elseKeyword, elseExpression);
    }

    // Issue #669: parse a block expression `{ stmt*; expr? }`.
    // The last item in the block, if it is an expression statement, becomes
    // the trailing value-producing expression of the block.
    private BlockExpressionSyntax ParseBlockExpression()
    {
        var statements = ImmutableArray.CreateBuilder<StatementSyntax>();
        ExpressionSyntax trailingExpression = null;

        var openBraceToken = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.EndOfFileToken &&
               Current.Kind != SyntaxKind.CloseBraceToken)
        {
            var startToken = Current;

            var statement = ParseBlockExpressionItem();
            statements.Add(statement);

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken);

        // If the last statement is an expression statement, treat its
        // expression as the block's trailing value-producing expression.
        if (statements.Count > 0 && statements[^1] is ExpressionStatementSyntax exprStmt)
        {
            statements.RemoveAt(statements.Count - 1);
            trailingExpression = exprStmt.Expression;
        }

        return new BlockExpressionSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), trailingExpression, closeBraceToken);
    }

    // Issue #669: parse a single item inside a block expression. This is
    // similar to ParseStatement() but recognizes `if` as potentially
    // an if-expression (when followed by the block-expression shape).
    private StatementSyntax ParseBlockExpressionItem()
    {
        // If the current token is `if` and this could be an if-expression
        // (value-producing), parse it as an expression statement wrapping
        // an IfExpressionSyntax. This handles nested `if` in block position.
        if (Current.Kind == SyntaxKind.IfKeyword && LooksLikeIfExpression())
        {
            var ifExpr = ParseIfExpression();
            return new ExpressionStatementSyntax(syntaxTree, ifExpr);
        }

        return ParseStatement();
    }

    // Issue #669 / ADR-0128 / issue #1172: lookahead to determine whether an
    // `if` at the current position is a value-producing if-EXPRESSION rather
    // than a void if-STATEMENT inside a block expression (e.g. an arrow-lambda
    // `-> { ... }` body, an if-expression then/else block, or a standalone
    // block expression).
    //
    // The disambiguation rule (ADR-0128 / issue #1172): an `if`/`else if`
    // chain is a value-producing if-expression ONLY when the chain terminates
    // in a plain `else { ... }` branch — only then does every code path yield
    // a value (matching the binder's BindIfExpression, which requires a
    // non-null ElseExpression). A chain that ends without a plain final `else`
    // (no `else` at all, or a trailing `else if` with nothing after) has a
    // path with no value and is therefore parsed as a void if-statement. This
    // brings block-bodied arrow lambdas to parity with func literals: a
    // non-trailing `if`/`else if` chain without a final `else` becomes a void
    // statement, and a trailing one yields a void (Action-like) lambda instead
    // of being rejected with GS0276/GS0124.
    //
    // We perform look-ahead only (no token consumption): we walk every link of
    // the `if`/`else if` chain. For each link we scan forward to its then-block
    // opening brace (the first `{` at paren/bracket depth zero after the `if`
    // keyword), then to its matching close brace (tracking brace depth, which
    // handles nested blocks). After the matching `}` we inspect what follows:
    //   * not `else`                -> void if-statement (return false);
    //   * `else if`                 -> continue walking from that inner `if`;
    //   * plain `else { ... }`      -> value-producing if-expression (return true).
    private bool LooksLikeIfExpression()
    {
        // `i` is the offset of the `if` keyword for the current chain link.
        // Peek(0) is the current token (the leading `if`).
        var i = 0;
        while (true)
        {
            // Locate this link's then-block opening brace: the first `{` at
            // paren and bracket depth zero after the `if` keyword at offset i.
            var parenDepth = 0;
            var bracketDepth = 0;
            var j = i + 1;
            while (true)
            {
                var k = Peek(j).Kind;
                if (k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }

                if (parenDepth == 0 && bracketDepth == 0 && k == SyntaxKind.OpenBraceToken)
                {
                    break;
                }

                switch (k)
                {
                    case SyntaxKind.OpenParenthesisToken:
                        parenDepth++;
                        break;
                    case SyntaxKind.CloseParenthesisToken:
                        if (parenDepth > 0)
                        {
                            parenDepth--;
                        }

                        break;
                    case SyntaxKind.OpenSquareBracketToken:
                        bracketDepth++;
                        break;
                    case SyntaxKind.CloseSquareBracketToken:
                        if (bracketDepth > 0)
                        {
                            bracketDepth--;
                        }

                        break;
                }

                j++;
            }

            // Scan from the then-block's opening brace to its matching close brace.
            var braceDepth = 0;
            while (true)
            {
                var k = Peek(j).Kind;
                if (k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }

                if (k == SyntaxKind.OpenBraceToken)
                {
                    braceDepth++;
                }
                else if (k == SyntaxKind.CloseBraceToken)
                {
                    braceDepth--;
                    if (braceDepth == 0)
                    {
                        break;
                    }
                }

                j++;
            }

            // `j` is now at this link's matching close brace. Inspect what
            // follows to decide whether the chain continues or terminates.
            if (Peek(j + 1).Kind != SyntaxKind.ElseKeyword)
            {
                // No `else`: this link has a path with no value, so the whole
                // chain is a void if-statement.
                return false;
            }

            if (Peek(j + 2).Kind == SyntaxKind.IfKeyword)
            {
                // `else if`: continue walking the chain from the inner `if`.
                i = j + 2;
                continue;
            }

            // Plain final `else { ... }`: the chain terminates in an else, so
            // every path yields a value -> value-producing if-expression.
            return true;
        }
    }
}
