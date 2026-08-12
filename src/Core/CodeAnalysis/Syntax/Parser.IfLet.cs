// <copyright file="Parser.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <content>
/// ADR-0071 / issue #708, ADR-0151, and ADR-0163 / issue #3352: the shared
/// <c>let</c>-binding header grammar used by the <c>if let</c>,
/// <c>guard let</c>, and <c>while let</c> statement forms and by the
/// <c>if let</c> expression form, plus the expression form itself. Keeping
/// the binding-list/clause helpers in one part means the surfaces cannot drift.
/// </content>
public partial class Parser
{
    // ──────────────────────────────────────────────────────────────────────
    //  Shared binding header: `let name [T] = expr (, let …)*`
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Parses the comma-separated binding list shared by <c>if let</c>,
    /// <c>guard let</c>, and <c>while let</c> statements and the
    /// <c>if let</c> expression.
    /// </summary>
    /// <param name="stopAtTopLevelLogicalAnd">
    /// When <see langword="true"/> (the ADR-0151 expression form) a top-level
    /// <c>&amp;&amp;</c> terminates the initializer so it can introduce the
    /// optional guard; a logical-and that genuinely belongs to the initializer
    /// must then be parenthesized. When <see langword="false"/> (the ADR-0071
    /// statement forms) the initializer keeps consuming <c>&amp;&amp;</c>
    /// exactly as before.
    /// </param>
    private SeparatedSyntaxList<IfLetBindingClauseSyntax> ParseIfLetBindingList(bool stopAtTopLevelLogicalAnd = false)
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            nodesAndSeparators.Add(ParseIfLetBindingClause(stopAtTopLevelLogicalAnd));
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

    private IfLetBindingClauseSyntax ParseIfLetBindingClause(bool stopAtTopLevelLogicalAnd = false)
    {
        var letKeyword = MatchToken(SyntaxKind.LetKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClauseBeforeEquals();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress both trailing object initializers (`Foo() { X = 1 }`) AND
        // bare struct literals (`Ident { }`) so the enclosing `{` is the body
        // of the `if let` / `guard let` / `while let`, not the initializer's shape.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax initializer;
        try
        {
            initializer = stopAtTopLevelLogicalAnd
                ? ParseIfLetGuardedInitializer()
                : ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        return new IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer);
    }

    /// <summary>
    /// ADR-0151: parses an <c>if let</c> EXPRESSION binding initializer, which
    /// stops before a top-level <c>&amp;&amp;</c> so the delimiter can start
    /// the optional guard. The binary loop is entered at the logical-and
    /// precedence tier (which also terminates at a top-level <c>||</c>, a
    /// shape that could never be a nullable initializer anyway), while the
    /// right-associative <c>??</c> tail — the one realistic nullable
    /// initializer that sits below that tier — is still accepted. A logical
    /// operator that genuinely belongs to the initializer is written
    /// parenthesized.
    /// </summary>
    private ExpressionSyntax ParseIfLetGuardedInitializer()
    {
        var left = ParseBinaryExpression(SyntaxFacts.GetBinaryOperatorPrecedence(SyntaxKind.AmpersandAmpersandToken));

        if (Current.Kind == SyntaxKind.QuestionQuestionToken)
        {
            var operatorToken = NextToken();
            var right = ParseIfLetGuardedInitializer();
            return new BinaryExpressionSyntax(syntaxTree, left, operatorToken, right);
        }

        return left;
    }

    private TypeClauseSyntax? ParseOptionalTypeClauseBeforeEquals()
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

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0151: `if let` in value position.
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// True when the `if` at the current position starts an <c>if let</c>
    /// header (`if let …`) rather than an ordinary condition.
    /// </summary>
    private bool IsIfLetStart() =>
        Current.Kind == SyntaxKind.IfKeyword && Peek(1).Kind == SyntaxKind.LetKeyword;

    /// <summary>
    /// ADR-0151: parses <c>if let name = expr [, let n2 = e2]* [&amp;&amp;
    /// guard] { value } else { value }</c>. Depth-guarded (issue #1602) like
    /// <see cref="ParseIfExpression"/>, because the form self-recurses through
    /// <c>else if</c> chains and through block expressions.
    /// </summary>
    private IfLetExpressionSyntax ParseIfLetExpression()
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseIfLetExpressionCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private IfLetExpressionSyntax ParseIfLetExpressionCore()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        var bindings = ParseIfLetBindingList(stopAtTopLevelLogicalAnd: true);

        SyntaxToken? ampersandAmpersandToken = null;
        ExpressionSyntax? guard = null;
        if (Current.Kind == SyntaxKind.AmpersandAmpersandToken)
        {
            ampersandAmpersandToken = NextToken();

            // The guard is an ordinary boolean expression (it may itself use
            // `&&`/`||`), parsed with the same struct-literal / object-
            // initializer suppression the initializers use so the following
            // `{` opens the then-block.
            suppressTrailingObjectInitializer++;
            suppressStructLiteral++;
            try
            {
                guard = ParseExpression();
            }
            finally
            {
                suppressStructLiteral--;
                suppressTrailingObjectInitializer--;
            }
        }

        var thenBlock = ParseBlockExpression(valueRequired: true);

        // The `else` branch is mandatory in value position. A missing one is
        // NOT manufactured here (that would cascade into a bogus block parse);
        // the binder reports GS0276 for a null else, exactly as it does for the
        // ADR-0064 if-expression.
        SyntaxToken? elseKeyword = null;
        ExpressionSyntax? elseExpression = null;
        if (Current.Kind == SyntaxKind.ElseKeyword)
        {
            elseKeyword = NextToken();
            elseExpression = ParseIfLetElseBranch();
        }

        return new IfLetExpressionSyntax(
            syntaxTree,
            ifKeyword,
            bindings,
            ampersandAmpersandToken,
            guard,
            thenBlock,
            elseKeyword,
            elseExpression);
    }

    /// <summary>
    /// Parses the branch after <c>else</c>: a chained <c>else if</c> /
    /// <c>else if let</c>, or a plain block expression.
    /// </summary>
    private ExpressionSyntax ParseIfLetElseBranch()
    {
        if (IsIfLetStart())
        {
            return ParseIfLetExpression();
        }

        if (Current.Kind == SyntaxKind.IfKeyword)
        {
            return ParseIfExpression();
        }

        return ParseBlockExpression(valueRequired: true);
    }
}
