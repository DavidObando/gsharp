// <copyright file="Parser.Expressions.Lambdas.cs" company="GSharp">
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
    private ExpressionSyntax ParseFunctionLiteralExpression()
    {
        // Phase 4.7 + 5.1: function literal `[async] func(p1 T1, p2 T2) R { body }`.
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            asyncModifier = NextToken();
        }

        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var returnType = ParseOptionalTypeClause();
        var body = ParseBlockStatement();
        return new FunctionLiteralExpressionSyntax(syntaxTree, asyncModifier, funcKeyword, openParen, parameters, closeParen, returnType, body);
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

        // ADR-0122 §4 / issue #2002: `(<receiver>)->member = value` is
        // ambiguous with a lambda whenever the receiver's leading token looks
        // like a parameter name — grammatically, some receivers (e.g. a bare
        // identifier `(p)`, or even a call `(getPtr())` — a call's argument
        // list is *also* a valid lambda-parameter type-clause shape, see
        // `getPtr ()` parsed as "parameter getPtr of tuple type ()" — both
        // commit cleanly as a lambda parameter list, so grammar-only
        // trial-parsing (below) cannot disambiguate them from a genuine
        // pointer-arrow receiver. Break the tie using the tokens immediately
        // following the arrow: a lambda whose entire body is a bare
        // `member = value` (or compound-assignment) is vanishingly rare,
        // while this exact shape is the whole point of a parenthesized
        // arrow-assignment target — and mirrors the unparenthesized form,
        // where `unsafeDepth > 0` already commits `IDENT -> member` to
        // pointer-arrow access unconditionally (see the bare-identifier
        // dispatch case above in ParsePrimaryExpression). Bias towards
        // arrow-member ASSIGNMENT whenever the arrow is immediately followed
        // by `IDENT =` / `IDENT <compound-op>=`, for ANY receiver shape.
        // ponytail: this narrowly misclassifies the rare unsafe-context
        // multi-param lambda whose body happens to start with exactly that
        // shape (e.g. `(a, b) -> total = a + b`); upgrade to a fuller
        // parameter-count-aware check if that pattern is ever needed.
        if (this.unsafeDepth > 0
            && Peek(offset + 2).Kind == SyntaxKind.IdentifierToken
            && (Peek(offset + 3).Kind == SyntaxKind.EqualsToken
                || SyntaxFacts.TryGetCompoundAssignmentBaseOperator(Peek(offset + 3).Kind, out _)))
        {
            return false;
        }

        // ADR-0122 §4 / issue #2002: inside an unsafe context, `->` after a
        // PARENTHESIZED receiver is ambiguous with a parenthesized lambda —
        // both `(p) -> body` (lambda) and `(p)->member` (pointer-arrow member
        // access on receiver `p`, desugared to `(*p).member` by
        // ParsePostfixChainCore) share the exact same leading shape (an
        // identifier-first interior followed by a matching `)` then `->`).
        // The cheap heuristic above (first interior token looks like a
        // parameter name) is exact for a genuine parameter list but
        // over-commits for a parenthesized arrow-receiver whose interior
        // continues with anything a parameter list can never contain — e.g.
        // `(a.b)->X`, or the double-indirection assignment target
        // `(*pp)->X = v` (already excluded above since `*` isn't an
        // identifier).
        //
        // Disambiguate precisely, but only where the ambiguity exists
        // (unsafeDepth > 0): speculatively trial-parse the interior as a
        // lambda parameter list. Only commit to the lambda if the trial
        // parse both consumes the interior without reporting any diagnostic
        // AND lands exactly on the closing `)` already located above —
        // otherwise the interior is not a valid parameter list, so this is a
        // parenthesized arrow-receiver instead and we fall through to the
        // normal expression/postfix-chain path (which handles arrow-member
        // access — and, transitively via TryLiftTrailingMemberAccess, arrow
        // assignment targets — for any receiver shape, including double
        // indirection). The trial parse never mutates externally-visible
        // parser state: position and diagnostics are unconditionally rolled
        // back.
        if (this.unsafeDepth > 0)
        {
            var savedPosition = this.position;
            var savedDiagnosticCount = Diagnostics.Count;
            try
            {
                this.position = savedPosition + startOffset + 1;
                ParseLambdaParameterList();
                return Current.Kind == SyntaxKind.CloseParenthesisToken
                    && Diagnostics.Count == savedDiagnosticCount;
            }
            finally
            {
                this.position = savedPosition;
                Diagnostics.TruncateTo(savedDiagnosticCount);
            }
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

    // ADR-0076 / issue #716: arrow-lambda parameter lists allow each parameter's
    // type clause to be omitted (`(x) -> body` / `(x, y) -> body`). When the
    // binding supplies a target function type, the binder infers each missing
    // parameter type from the target. Otherwise, GS0304 fires. Parameter
    // default values and annotations remain supported by delegating to the
    // shared ParseLambdaParameter helper.
    private SeparatedSyntaxList<ParameterSyntax> ParseLambdaParameterList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextParameter = true;
        while (parseNextParameter &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var parameter = ParseLambdaParameter();
            nodesAndSeparators.Add(parameter);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                nodesAndSeparators.Add(comma);
            }
            else
            {
                parseNextParameter = false;
            }
        }

        return new SeparatedSyntaxList<ParameterSyntax>(nodesAndSeparators.ToImmutable());
    }

    // ADR-0076 / issue #716: a lambda parameter is structurally identical to
    // an ordinary parameter except that the type clause is optional. When the
    // type clause is absent (e.g. the parameter is `(x)`), the binder relies
    // on the target type to fill it in; with no target type, GS0304 fires.
    private ParameterSyntax ParseLambdaParameter()
    {
        // ADR-0047: parameter-level annotations precede the identifier.
        var annotations = ParseAnnotations();

        // ADR-0058 / issue #376: optional `scoped` contextual modifier.
        SyntaxToken scopedModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            scopedModifier = NextToken();
        }

        // ADR-0060: optional `ref`/`out`/`in` contextual modifier.
        SyntaxToken refKindModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && (Current.Text == "ref" || Current.Text == "out" || Current.Text == "in")
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            refKindModifier = NextToken();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken ellipsis = null;
        if (Current.Kind == SyntaxKind.EllipsisToken)
        {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken);
        }

        // ADR-0076 / issue #716: the type clause is OPTIONAL on a lambda
        // parameter; with no type, the binder uses the target type's
        // corresponding slot, or reports GS0304 when no target is in scope.
        var type = ParseOptionalTypeClause();

        // ADR-0063: optional default-value clause.
        SyntaxToken equalsToken = null;
        ExpressionSyntax defaultValue = null;
        if (Current.Kind == SyntaxKind.EqualsToken)
        {
            equalsToken = NextToken();
            defaultValue = ParseExpression();
        }

        var parameter = new ParameterSyntax(syntaxTree, identifier, ellipsis, type).WithAnnotations(annotations);
        parameter.ScopedModifier = scopedModifier;
        parameter.RefKindModifier = refKindModifier;
        parameter.EqualsToken = equalsToken;
        parameter.DefaultValue = defaultValue;
        return parameter;
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
}
