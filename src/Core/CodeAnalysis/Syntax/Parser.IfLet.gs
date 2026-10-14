// <copyright file="Parser.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices

/// ```xmldoc
/// <content>
/// ADR-0071 / issue #708, ADR-0151, and ADR-0163 / issue #3352: the shared
/// <c>let</c>-binding header grammar used by the <c>if let</c>,
/// <c>guard let</c>, and <c>while let</c> statement forms and by the
/// <c>if let</c> expression form, plus the expression form itself. Keeping
/// the binding-list/clause helpers in one part means the surfaces cannot drift.
/// </content>
/// ```
open partial class Parser {
    // ──────────────────────────────────────────────────────────────────────
    //  Shared binding header: `let name [T] = expr (, let …)*`
    // ──────────────────────────────────────────────────────────────────────
    /// Parses the comma-separated binding list shared by `if let`,
    /// `guard let`, and `while let` statements and the
    /// `if let` expression.
    /// @param stopAtTopLevelLogicalAnd When `true` (the ADR-0151 expression form) a top-level
    /// `&&` terminates the initializer so it can introduce the
    /// optional guard; a logical-and that genuinely belongs to the initializer
    /// must then be parenthesized. When `false` (the ADR-0071
    /// statement forms) the initializer keeps consuming `&&`
    /// exactly as before.
    private func ParseIfLetBindingList(stopAtTopLevelLogicalAnd bool = false) SeparatedSyntaxList[
        IfLetBindingClauseSyntax
    ] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while true {
            nodesAndSeparators.Add(ParseIfLetBindingClause(stopAtTopLevelLogicalAnd))
            if Current.Kind != SyntaxKind.CommaToken {
                break
            }
            // Only treat a comma as a binding separator if it is followed by
            // another `let` keyword. Anything else (a trailing comma, a list
            // expression) is left to the outer parser to flag.
            if Peek(1).Kind != SyntaxKind.LetKeyword {
                break
            }
            nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
        }
        return SeparatedSyntaxList[IfLetBindingClauseSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseIfLetBindingClause(stopAtTopLevelLogicalAnd bool = false) IfLetBindingClauseSyntax {
        let letKeyword = MatchToken(SyntaxKind.LetKeyword)
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let typeClause = ParseOptionalTypeClauseBeforeEquals()
        let equalsToken = MatchToken(SyntaxKind.EqualsToken)
        // Suppress both trailing object initializers (`Foo() { X = 1 }`) AND
        // bare struct literals (`Ident { }`) so the enclosing `{` is the body
        // of the `if let` / `guard let` / `while let`, not the initializer's shape.
        suppressTrailingObjectInitializer++
        suppressStructLiteral++
        var initializer ExpressionSyntax
        try {
            // An empty brace pair cannot produce a block-expression value.
            // Keep it available as the enclosing if/guard/while-let body so
            // a missing initializer reports once and recovery does not absorb
            // the following statement as the body.
            if Current.Kind == SyntaxKind.OpenBraceToken && Peek(1).Kind == SyntaxKind.CloseBraceToken {
                initializer = ParseNameOrCallExpression()
            } else {
                initializer = if stopAtTopLevelLogicalAnd {
                    ParseIfLetGuardedInitializer()
                } else {
                    ParseExpression()
                }
            }
        } finally {
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
        return IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer)
    }

    /// ADR-0151: parses an `if let` EXPRESSION binding initializer, which
    /// stops before a top-level `&&` so the delimiter can start
    /// the optional guard. The binary loop is entered at the logical-and
    /// precedence tier (which also terminates at a top-level `||`, a
    /// shape that could never be a nullable initializer anyway), while the
    /// right-associative `??` tail — the one realistic nullable
    /// initializer that sits below that tier — is still accepted. A logical
    /// operator that genuinely belongs to the initializer is written
    /// parenthesized.
    private func ParseIfLetGuardedInitializer() ExpressionSyntax {
        let left = ParseBinaryExpression(SyntaxKind.AmpersandAmpersandToken.GetBinaryOperatorPrecedence())
        if Current.Kind == SyntaxKind.QuestionQuestionToken {
            let operatorToken = NextToken()
            let right = ParseIfLetGuardedInitializer()
            return BinaryExpressionSyntax(syntaxTree, left, operatorToken, right)
        }
        return left
    }

    private func ParseOptionalTypeClauseBeforeEquals() TypeClauseSyntax? {
        // A binding clause is always followed by `=`; if we see `=` directly
        // there is no type annotation. Otherwise reuse the regular optional
        // type-clause parser (which already handles `[]T`, `map[K,V]`, `T?`,
        // `chan T`, etc.).
        if Current.Kind == SyntaxKind.EqualsToken {
            return nil
        }
        return ParseOptionalTypeClause()
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0151: `if let` in value position.
    // ──────────────────────────────────────────────────────────────────────
    /// True when the `if` at the current position starts an `if let`
    /// header (`if let …`) rather than an ordinary condition.
    private func IsIfLetStart() bool -> Current.Kind == SyntaxKind.IfKeyword && Peek(1).Kind == SyntaxKind.LetKeyword

    /// ADR-0151: parses `if let name = expr [, let n2 = e2]* [&&
    /// guard] { value } else { value }`. Depth-guarded (issue #1602) like
    /// (cref:ParseIfExpression), because the form self-recurses through
    /// `else if` chains and through block expressions.
    private func ParseIfLetExpression() IfLetExpressionSyntax {
        EnsureNestedParseAllowed()
        recursionDepth++
        try {
            return ParseIfLetExpressionCore()
        } finally {
            recursionDepth--
        }
    }

    private func ParseIfLetExpressionCore() IfLetExpressionSyntax {
        let ifKeyword = MatchToken(SyntaxKind.IfKeyword)
        let bindings = ParseIfLetBindingList(stopAtTopLevelLogicalAnd: true)
        var ampersandAmpersandToken SyntaxToken? = nil
        var guard_ ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.AmpersandAmpersandToken {
            ampersandAmpersandToken = NextToken()
            // The guard is an ordinary boolean expression (it may itself use
            // `&&`/`||`), parsed with the same struct-literal / object-
            // initializer suppression the initializers use so the following
            // `{` opens the then-block.
            suppressTrailingObjectInitializer++
            suppressStructLiteral++
            try {
                guard_ = ParseExpression()
            } finally {
                suppressStructLiteral--
                suppressTrailingObjectInitializer--
            }
        }
        let thenBlock = ParseBlockExpression(valueRequired: true)
        // The `else` branch is mandatory in value position. A missing one is
        // NOT manufactured here (that would cascade into a bogus block parse);
        // the binder reports GS0276 for a null else, exactly as it does for the
        // ADR-0064 if-expression.
        var elseKeyword SyntaxToken? = nil
        var elseExpression ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.ElseKeyword {
            elseKeyword = NextToken()
            elseExpression = ParseIfLetElseBranch()
        }
        return IfLetExpressionSyntax(
            syntaxTree,
            ifKeyword,
            bindings,
            ampersandAmpersandToken,
            guard_,
            thenBlock,
            elseKeyword,
            elseExpression
        )
    }

    /// Parses the branch after `else`: a chained `else if` /
    /// `else if let`, or a plain block expression.
    private func ParseIfLetElseBranch() ExpressionSyntax {
        if IsIfLetStart() {
            return ParseIfLetExpression()
        }
        if Current.Kind == SyntaxKind.IfKeyword {
            return ParseIfExpression()
        }
        return ParseBlockExpression(valueRequired: true)
    }
}
