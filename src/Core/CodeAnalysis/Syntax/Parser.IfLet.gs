// <copyright file="Parser.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import System.Collections.Immutable

/// Shared binding headers and the value-position `if let` form.
open partial class Parser {
    /// ADR-0201: every binding form uses the ordinary expression grammar with
    /// a top-level logical-operator boundary for each initializer.
    /// @param unsupportedGuardForm The form to name in GS0625, or null for `if let`.
    /// @returns The bindings, optional guard operator and guard.
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

    private func ParseIfLetBindingList() SeparatedSyntaxList[IfLetBindingClauseSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while true {
            nodesAndSeparators.Add(ParseIfLetBindingClause())
            if Current.Kind != SyntaxKind.CommaToken || Peek(1).Kind != SyntaxKind.LetKeyword {
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
        suppressTrailingObjectInitializer++
        suppressStructLiteral++
        var initializer ExpressionSyntax
        try {
            // Leave an empty body available for missing-initializer recovery.
            if Current.Kind == SyntaxKind.OpenBraceToken && Peek(1).Kind == SyntaxKind.CloseBraceToken {
                initializer = ParseNameOrCallExpression()
            } else {
                initializer = ParseExpression(stopAtTopLevelLogical: true)
            }
        } finally {
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
        return IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer)
    }

    private func ParseOptionalTypeClauseBeforeEquals() TypeClauseSyntax? {
        if Current.Kind == SyntaxKind.EqualsToken {
            return nil
        }
        return ParseOptionalTypeClause()
    }

    private func IsIfLetStart() bool -> Current.Kind == SyntaxKind.IfKeyword && Peek(1).Kind == SyntaxKind.LetKeyword

    /// Parses the depth-guarded value-position form (ADR-0151 / ADR-0201).
    /// @returns The complete expression, retaining a missing else for GS0276.
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
