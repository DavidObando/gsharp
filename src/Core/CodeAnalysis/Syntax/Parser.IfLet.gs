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
    //  Shared binding header: `let name [T] = expr (, let …)* [&& guard]`
    // ──────────────────────────────────────────────────────────────────────
    /// Issue #4961 / ADR-0201: parses the binding header shared by EVERY
    /// `let`-binding form — the `if let` statement and expression, `guard let`,
    /// and `while let` — so the initializer-termination and guard decision is
    /// made in exactly one place. Each initializer stops before a top-level
    /// `&&` or `||` (see (cref:ParseIfLetGuardedInitializer)); a following
    /// `&&` introduces the optional `bool` guard. A top-level `||` there can
    /// never start a guard, so it is reported (GS0626) and kept in the guard
    /// slot purely so the tree stays full-fidelity and recovery is local. The
    /// forms that do not support a guard (`guard let`, `while let`) still
    /// parse it here, so it never leaks into an initializer, and it is
    /// reported (GS0625).
    /// @param unsupportedGuardForm The form's spelling when it does not accept a guard
    /// (`guard let`, `while let`); `null` for `if let`.
    /// @returns The binding list plus the optional guard operator and guard.
    private func ParseIfLetHeader(unsupportedGuardForm string? = nil)(
        Bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        GuardOperator SyntaxToken?,
        Guard ExpressionSyntax?
    ) {
        let bindings = ParseIfLetBindingList()
        if Current.Kind != SyntaxKind.AmpersandAmpersandToken && Current.Kind != SyntaxKind.PipePipeToken {
            return (bindings, nil, nil)
        }
        let guardOperator = NextToken()
        if guardOperator.Kind == SyntaxKind.PipePipeToken {
            Diagnostics.ReportLetBindingLogicalOr(guardOperator.Location)
        } else if unsupportedGuardForm != nil {
            Diagnostics.ReportLetBindingGuardNotSupported(guardOperator.Location, unsupportedGuardForm)
        }
        // The guard is an ordinary boolean expression (it may itself use
        // `&&`/`||`), parsed with the same struct-literal / object-
        // initializer suppression the initializers use so the following
        // `{` opens the then-block.
        suppressTrailingObjectInitializer++
        suppressStructLiteral++
        var guard_ ExpressionSyntax
        try {
            guard_ = ParseExpression()
        } finally {
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
        return (bindings, guardOperator, guard_)
    }

    /// Parses the comma-separated binding list of a `let`-binding header.
    /// Callers go through (cref:ParseIfLetHeader), which owns the guard.
    private func ParseIfLetBindingList() SeparatedSyntaxList[IfLetBindingClauseSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while true {
            nodesAndSeparators.Add(ParseIfLetBindingClause())
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

    private func ParseIfLetBindingClause() IfLetBindingClauseSyntax {
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
                initializer = ParseIfLetGuardedInitializer()
            }
        } finally {
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
        return IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer)
    }

    /// ADR-0151 / ADR-0201: parses a binding initializer of any `let`-binding
    /// header. It is the FULL expression grammar, except that the first
    /// TOP-LEVEL `&&` or `||` ends it, so the delimiter can start the
    /// optional guard. A logical operator that genuinely belongs to the
    /// initializer is written parenthesized.
    ///
    /// The grammar is never re-implemented here: the initializer is first
    /// parsed speculatively with (cref:ParseExpression), and
    /// (cref:FindTopLevelLogicalOperator) locates the first logical operator
    /// that is not nested inside any operand (parentheses, arguments, a `?:`
    /// true arm, a lambda, ...). Without one, the speculative result is the
    /// initializer. Otherwise the initializer is re-parsed with the same
    /// grammar, the token stream ending just before that operator. A shape
    /// the finder does not recognize keeps its logical operators inside the
    /// initializer, which is the pre-ADR-0201 statement-form parse, so the
    /// rule can only ever fail safe.
    private func ParseIfLetGuardedInitializer() ExpressionSyntax {
        let savedPosition = position
        let savedTokens = tokens
        let savedDiagnosticCount = Diagnostics.Count
        let speculative = ParseExpression()
        let delimiter = FindTopLevelLogicalOperator(speculative)
        if delimiter == nil {
            return speculative
        }
        position = savedPosition
        tokens = savedTokens
        Diagnostics.TruncateTo(savedDiagnosticCount)
        let outerLimit = tokenLimitPosition
        tokenLimitPosition = delimiter.Position
        try {
            return ParseExpression()
        } finally {
            tokenLimitPosition = outerLimit
        }
    }

    /// Issue #4961 / ADR-0201: the first `&&` / `||` token of
    /// [`expression`](paramref) that is a top-level operator of a `let`
    /// initializer, or `null`. Only the operands that continue the
    /// initializer at its own level are searched: both operands of a binary
    /// operator (`??`, comparisons, the logical operators themselves), a
    /// `?:` condition and false arm, range bounds, a `with` receiver, and an
    /// assignment's value. Everything else (parenthesized expressions, calls,
    /// lambdas, a `?:` true arm, ...) is nested and keeps its operators.
    private func FindTopLevelLogicalOperator(expression ExpressionSyntax?) SyntaxToken? {
        switch expression {
            case binary is BinaryExpressionSyntax {
                let left = FindTopLevelLogicalOperator(binary.Left)
                if left != nil {
                    return left
                }
                if binary
                    .OperatorToken
                    .Kind == SyntaxKind.AmpersandAmpersandToken ||
                    binary
                    .OperatorToken
                    .Kind == SyntaxKind.PipePipeToken {
                    return binary.OperatorToken
                }
                return FindTopLevelLogicalOperator(binary.Right)
            }
            case conditional is ConditionalExpressionSyntax {
                return FindTopLevelLogicalOperator(conditional.Condition) ??
                    FindTopLevelLogicalOperator(conditional.WhenFalse)
            }
            case rangeExpression is RangeExpressionSyntax {
                return FindTopLevelLogicalOperator(rangeExpression.LowerBound) ??
                    FindTopLevelLogicalOperator(rangeExpression.UpperBound)
            }
            case with_ is WithExpressionSyntax {
                return FindTopLevelLogicalOperator(with_.Receiver)
            }
            case assignment is AssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(assignment.Expression)
            }
            case field is FieldAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(field.Value)
            }
            case memberField is MemberFieldAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(memberField.Value)
            }
            case index is IndexAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(index.Value)
            }
            case memberIndex is MemberIndexAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(memberIndex.Value)
            }
            case compoundIndex is CompoundIndexAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(compoundIndex.Value)
            }
            case indirect is IndirectAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(indirect.Value)
            }
            case indirectCompound is IndirectCompoundAssignmentExpressionSyntax {
                return FindTopLevelLogicalOperator(indirectCompound.Value)
            }
            case subscription is EventSubscriptionExpressionSyntax {
                return FindTopLevelLogicalOperator(subscription.Value)
            }
            default {
                return nil
            }
        }
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
        let (bindings, guardOperator, guard_) = ParseIfLetHeader()
        let thenBlock = ParseBlockExpression()
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
            guardOperator,
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
        return ParseBlockExpression()
    }
}
