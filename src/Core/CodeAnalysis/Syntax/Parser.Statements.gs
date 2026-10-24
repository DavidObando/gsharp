// <copyright file="Parser.Statements.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices

open partial class Parser {
    private func ParseBlockStatement() BlockStatementSyntax {
        if skimBraceBodies > 0 && Current.Kind == SyntaxKind.OpenBraceToken {
            // See skimBraceBodies (Parser.gs).
            let (skimmedOpen, skimmedClose) = SkimBraceBody()
            return BlockStatementSyntax(syntaxTree, skimmedOpen, ImmutableArray[StatementSyntax].Empty, skimmedClose)
        }
        let statements = ImmutableArray.CreateBuilder[StatementSyntax]()
        let openBraceToken = MatchToken(SyntaxKind.OpenBraceToken)
        while Current.Kind != SyntaxKind.EndOfFileToken && Current.Kind != SyntaxKind.CloseBraceToken {
            let startToken = Current
            let statement = ParseStatement()
            statements.Add(statement)
            if Current == startToken {
                NextToken()
            }
        }
        let closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken)
        return BlockStatementSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), closeBraceToken)
    }

    private func ParseGlobalStatement() MemberSyntax {
        let statement = ParseStatement()
        return GlobalStatementSyntax(syntaxTree, statement)
    }

    // Issue #1602: depth-guarded wrapper — statements self-nest through blocks
    // (`{{{{…`), if/for/while bodies, switch cases, etc.
    private func ParseStatement() StatementSyntax {
        EnsureNestedParseAllowed()
        recursionDepth++
        try {
            return ParseStatementCore()
        } finally {
            recursionDepth--
        }
    }

    private func ParseStatementCore() StatementSyntax {
        // Issue #187 / ADR-0047 §2: a local `var`/`let`/`const` can be
        // preceded by Kotlin-style `@` annotations (default target `field`).
        // Other statement kinds do not accept annotations — for those we
        // still parse the leading `@...` (to drive a normal binder
        // diagnostic against the synthesized declaration) but fall through
        // to the regular dispatch and drop the annotations on the floor
        // after reporting via ReportAnnotationsNotAllowedOnStatement.
        var leadingAnnotations = ImmutableArray[AnnotationSyntax].Empty
        if Current.Kind == SyntaxKind.AtToken {
            leadingAnnotations = ParseAnnotations()
            // ADR-0175 / issue #3824: `@Ann { … }` is the annotated-block
            // statement form, which gives `@SuppressDiagnostic` a scope
            // narrower than a whole declaration. One token of lookahead is
            // enough and there is no ambiguity: an `@` in statement position
            // previously admitted only `const`/`let`/`var`, so a following `{`
            // was always an error. Annotations also commit the brace to a
            // block — the `{ … } + x` expression-continuation shape (#3355) is
            // never reachable through an annotation.
            if Current.Kind == SyntaxKind.OpenBraceToken {
                let annotatedBlock = ParseBlockStatement()
                annotatedBlock.WithAnnotations(leadingAnnotations)
                return annotatedBlock
            }
            if Current.Kind != SyntaxKind.ConstKeyword &&
                Current.Kind != SyntaxKind.LetKeyword &&
                Current.Kind != SyntaxKind
                .VarKeyword {
                if leadingAnnotations.Length > 0 {
                    Diagnostics.ReportAnnotationsNotAllowedOnStatement(leadingAnnotations[0].AtToken.Location)
                }
                leadingAnnotations = ImmutableArray[AnnotationSyntax].Empty
            }
        }
        // ADR-0122 / issue #1014: an `unsafe { … }` block introduces an unsafe
        // context for its statements. `unsafe` is a contextual keyword — only
        // an `unsafe` immediately followed by `{` is treated as the block form.
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe" && Peek(1).Kind == SyntaxKind
            .OpenBraceToken {
            let unsafeKeyword = NextToken()
            this.unsafeDepth++
            var unsafeBlock BlockStatementSyntax
            try {
                unsafeBlock = ParseBlockStatement()
            } finally {
                this.unsafeDepth--
            }
            unsafeBlock.UnsafeKeyword = unsafeKeyword
            return unsafeBlock
        }
        // Issue #1881: a `checked { … }` / `unchecked { … }` block establishes
        // the named overflow context for the statements inside it. Both are
        // contextual keywords — only immediately followed by `{` are they
        // treated as the block form (a bare identifier named `checked` used
        // as an ordinary value is unaffected).
        if Current.Kind == SyntaxKind.IdentifierToken &&
            (Current.Text == "checked" || Current.Text == "unchecked") &&
            Peek(1).Kind == SyntaxKind.OpenBraceToken {
            let isCheckedBlock = Current.Text == "checked"
            let checkedKeyword = NextToken()
            let checkedBlock = ParseBlockStatement()
            if isCheckedBlock {
                checkedBlock.CheckedKeyword = checkedKeyword
            } else {
                checkedBlock.UncheckedKeyword = checkedKeyword
            }
            return checkedBlock
        }
        // ADR-0125 / issue #1026: a `fixed name *T = source { … }` pinning
        // statement. `fixed` is a contextual keyword — only the precise
        // `fixed IDENT *` shape (the binding name followed by a pointer type)
        // commits here, so existing identifiers named `fixed` are unaffected.
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "fixed" && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken &&
            Peek(2).Kind == SyntaxKind.StarToken {
            return ParseFixedStatement()
        }
        switch Current.Kind {
            case SyntaxKind.OpenBraceToken {
                // Issue #3355: a leading brace remains an ordinary statement
                // block unless its matching close brace is followed by an
                // expression continuation. Shapes such as `{ ... } + value`,
                // `{ ... } with { ... }`, and `{ ... } <- value` are
                // unambiguously expression-led statements.
                if NestedBraceStartsContinuedExpression() {
                    return ParseExpressionOrChannelSendStatement()
                }
                return ParseBlockStatement()
            }
            case SyntaxKind.AsyncKeyword when Peek(1).Kind == SyntaxKind.LetKeyword {
                // ADR-0174 D15: `async let name = expr` starts `expr` as a child
                // of the enclosing scope and binds `name` to its eventual result.
                return ParseAsyncLetStatement()
            }
            case SyntaxKind.ConstKeyword, SyntaxKind.LetKeyword, SyntaxKind.VarKeyword {
                if Current.Kind != SyntaxKind.ConstKeyword && LooksLikeMultiAssignment() {
                    return ParseMultiAssignmentStatement()
                }
                let declaration = ParseVariableDeclaration()
                if declaration is VariableDeclarationSyntax variableDeclaration &&
                    !leadingAnnotations.IsDefaultOrEmpty {
                    variableDeclaration.WithAnnotations(leadingAnnotations)
                }
                return declaration
            }
            case SyntaxKind.IfKeyword {
                if Peek(1).Kind == SyntaxKind.LetKeyword {
                    return ParseIfLetStatement()
                }
                return ParseIfStatement()
            }
            case SyntaxKind.GuardKeyword {
                return ParseGuardLetStatement()
            }
            case SyntaxKind.ForKeyword {
                return ParseForStatement()
            }
            case SyntaxKind.WhileKeyword {
                if Peek(1).Kind == SyntaxKind.LetKeyword {
                    return ParseWhileLetStatement()
                }
                return ParseWhileStatement()
            }
            case SyntaxKind.DoKeyword {
                return ParseDoWhileStatement()
            }
            case SyntaxKind.LockKeyword {
                return ParseLockStatement()
            }
            case SyntaxKind.BreakKeyword {
                return ParseBreakStatement()
            }
            case SyntaxKind.ContinueKeyword {
                return ParseContinueStatement()
            }
            case SyntaxKind.ReturnKeyword {
                return ParseReturnStatement()
            }
            case SyntaxKind.SwitchKeyword {
                // Issue #4963 (ADR-0202): a `switch` whose arms have the
                // expression shape (`case P:` / `default:`) is the switch
                // EXPRESSION as an expression statement — the trailing value
                // when it ends a value-capable block, the void switch when its
                // value is discarded. Arms with the statement shape
                // (`case P { … }`) keep the switch statement. Like the `if`
                // item, it ends at its closing brace. The header is parsed
                // once; SwitchBodyHasExpressionArms then scans the first arm.
                let switchKeyword = MatchToken(SyntaxKind.SwitchKeyword)
                let header = ParseExpressionInBodyHeader()
                if SwitchBodyHasExpressionArms() {
                    return ExpressionStatementSyntax(syntaxTree, ParseSwitchExpressionBody(switchKeyword, header))
                }
                return ParseSwitchStatementBody(switchKeyword, header)
            }
            case SyntaxKind.FallthroughKeyword {
                return ParseFallthroughStatement()
            }
            case SyntaxKind.TryKeyword {
                return ParseTryStatement()
            }
            case SyntaxKind.ThrowKeyword {
                return ParseThrowStatement()
            }
            case SyntaxKind.RethrowKeyword {
                return ParseRethrowStatement()
            }
            case SyntaxKind.UsingKeyword {
                return ParseUsingStatement()
            }
            case SyntaxKind.DeferKeyword {
                return ParseDeferStatement()
            }
            case SyntaxKind.GotoKeyword {
                return ParseGotoStatement()
            }
            case SyntaxKind.GoKeyword {
                return ParseGoStatement()
            }
            case SyntaxKind.SelectKeyword {
                return ParseSelectStatement()
            }
            case SyntaxKind.ScopeKeyword {
                return ParseScopeStatement()
            }
            case SyntaxKind.AwaitKeyword {
                if Peek(1).Kind == SyntaxKind.ForKeyword {
                    return ParseAwaitForRangeStatement()
                }
                if Peek(1).Kind == SyntaxKind.UsingKeyword {
                    return ParseAwaitUsingStatement()
                }
                fallthrough
            }
            default {
                // ADR-0040: contextual `yield` keyword — parse as yield statement
                // when `yield` appears at statement start and is not followed by
                // an assignment operator or other identifier-consuming syntax.
                if Current.Kind == SyntaxKind.SequenceKeyword && Peek(1).Kind != SyntaxKind.ColonEqualsToken && Peek(
                    1
                ).Kind != SyntaxKind.PlusPlusToken &&
                    Peek(1).Kind != SyntaxKind.MinusMinusToken && Peek(1).Kind != SyntaxKind.CommaToken && Peek(
                    1
                ).Kind != SyntaxKind.DotToken &&
                    Peek(1).Kind != SyntaxKind.OpenParenthesisToken && Peek(1).Kind != SyntaxKind.EqualsToken {
                    // "sequence" at statement start is not a yield — fall through.

                }
                if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "yield" && Peek(
                    1
                ).Kind != SyntaxKind.ColonEqualsToken &&
                    Peek(1).Kind != SyntaxKind.PlusPlusToken && Peek(1).Kind != SyntaxKind.MinusMinusToken && Peek(
                    1
                ).Kind != SyntaxKind.CommaToken &&
                    Peek(1).Kind != SyntaxKind.DotToken && Peek(1).Kind != SyntaxKind.EqualsToken &&
                    (
                    Peek(1).Kind != SyntaxKind.OpenSquareBracketToken || Peek(
                        2
                    ).Kind == SyntaxKind.CloseSquareBracketToken
                ) &&
                    (Peek(1).Kind != SyntaxKind.OpenParenthesisToken || LooksLikeYieldTupleLiteral(1)) {
                    // Issue #813: `yield (a, b)` is a yield-statement that
                    // yields a value-tuple literal — required for iterators
                    // whose element type is `(T1, T2, …)` (e.g. the
                    // dogfooded `Indexed` / `Pairwise` ports). Without the
                    // tuple-literal lookahead, `yield (` was uniformly
                    // forwarded to expression-statement parsing where it
                    // became the call `yield(args)` and reported GS0130.
                    //
                    // Issue #3501: `yield [` is indexing a variable named
                    // `yield` — except when the bracket pair is empty, since
                    // `[]` can only begin an array-literal type
                    // (`yield []T{…}`).
                    return ParseYieldStatement()
                }
                if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonToken {
                    // ADR-0070 / issue #1884: `label: statement`. A label on a
                    // loop names it for `break`/`continue`; a label on any
                    // other statement is a `goto` target. The binder tells
                    // the two apart.
                    return ParseLabeledStatement()
                }
                if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonEqualsToken {
                    // We do this outside of "ParseExpressionStatement" because
                    // short variable declarations aren't expressions but
                    // statements.
                    return ParseSingleShortVariableDeclaration()
                }
                if Current.Kind == SyntaxKind.IdentifierToken &&
                    (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken) {
                    return ParseIncrementDecrementStatement()
                }
                if LooksLikeMultiAssignment() {
                    return ParseMultiAssignmentStatement()
                }
                return ParseExpressionOrChannelSendStatement()
            }
        }
    }

    private func ParseSingleShortVariableDeclaration() StatementSyntax {
        // ADR-0077 / issue #717: the legacy short variable-declaration
        // operator `:=` is removed. Emit GS0305 against the `:=` token and
        // recover by synthesising a `var` declaration so downstream binding
        // produces no cascade.
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let colonEquals = MatchToken(SyntaxKind.ColonEqualsToken)
        Diagnostics.ReportColonEqualsRemoved(
            colonEquals.Location,
            "let ${identifier.Text} = …  or  var ${identifier.Text} = …"
        )
        let initializer = ParseExpression()
        let equalsToken = SynthesiseEqualsToken(colonEquals)
        return VariableDeclarationSyntax(
            syntaxTree: syntaxTree,
            keyword: nil,
            identifier: identifier,
            typeClause: nil,
            equalsToken: equalsToken,
            initializer: initializer
        )
    }

    private func SynthesiseEqualsToken(colonEquals SyntaxToken) SyntaxToken {
        return SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, colonEquals.Position, "=", nil)
    }

    private func ParseIncrementDecrementStatement() StatementSyntax {
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let op = NextToken()
        let leftName = NameExpressionSyntax(syntaxTree, identifier)
        return ExpressionStatementSyntax(syntaxTree, BuildIncrementDecrementExpression(leftName, op, isPrefix: true))
    }

    /// ADR-0126 / issue #1027 / #4350: pointer dereferences and ref-returning
    /// calls use the indirect compound path. Bare names and setter-based
    /// members/indexers/maps retain their established compound paths, whose
    /// binders distinguish storage from properties and capture the exact
    /// postfix value.
    /// @param operand The already-parsed lvalue operand.
    /// @param op The `++` or `--` operator token.
    /// @param isPrefix `true` for the prefix form.
    /// @returns The desugared value-producing expression.
    private func BuildIncrementDecrementExpression(
        operand ExpressionSyntax,
        op SyntaxToken,
        isPrefix bool
    ) ExpressionSyntax {
        let isIncrement = op.Kind == SyntaxKind.PlusPlusToken
        let compoundOpKind = if isIncrement {
            SyntaxKind.PlusEqualsToken
        } else {
            SyntaxKind.MinusEqualsToken
        }
        let pos = op.Position
        // The written `++`/`--` stays a real token of the same width (a `+=` is as wide as `++`), so
        // the span of the expression still covers it. Only the literal `1` is synthesized: it is
        // zero-width at the end of the operator.
        let OneLiteral = func () LiteralExpressionSyntax {
            return LiteralExpressionSyntax(
                syntaxTree,
                SyntaxToken.Synthesized(syntaxTree, SyntaxKind.NumberToken, op.Span.End, "1", 1),
                1
            )
        }
        let compoundToken = SyntaxToken(
            syntaxTree,
            compoundOpKind,
            pos,
            SyntaxFacts.GetTextOrEmpty(compoundOpKind),
            nil
        )
        var write ExpressionSyntax
        let unwrappedOperand = AssignmentTargetSyntaxFacts.UnwrapParentheses(operand)
        let exactPostfix = unwrappedOperand is UnaryExpressionSyntax &&
            unwrappedOperand
            .OperatorToken
            .Kind == SyntaxKind.StarToken ||
            AssignmentTargetSyntaxFacts.IsCallResult(unwrappedOperand)
        if exactPostfix {
            return IndirectCompoundAssignmentExpressionSyntax(
                syntaxTree,
                unwrappedOperand,
                compoundToken,
                OneLiteral(),
                returnsPreviousValue: !isPrefix,
                isIncrementDecrement: true
            )
        }
        if unwrappedOperand is NameExpressionSyntax {
            write = EventSubscriptionExpressionSyntax(
                syntaxTree,
                unwrappedOperand,
                compoundToken,
                OneLiteral(),
                returnsPreviousValue: !isPrefix,
                isIncrementDecrement: true
            )
        } else if AssignmentTargetSyntaxFacts.TryLiftTrailingIndexer(unwrappedOperand, out var indexed) {
            write = CompoundIndexAssignmentExpressionSyntax(
                syntaxTree,
                indexed,
                compoundToken,
                OneLiteral(),
                returnsPreviousValue: !isPrefix,
                isIncrementDecrement: true
            )
        } else if AssignmentTargetSyntaxFacts.TryLiftTrailingMemberAccess(unwrappedOperand, out _, out _, out _) {
            write = EventSubscriptionExpressionSyntax(
                syntaxTree,
                unwrappedOperand,
                compoundToken,
                OneLiteral(),
                returnsPreviousValue: !isPrefix,
                isIncrementDecrement: true
            )
        } else {
            Diagnostics.ReportInvalidIncrementDecrementTarget(operand.Location, op.Text)
            return operand
        }
        return write
    }

    private func LooksLikeMultiAssignment() bool {
        if !HasTopLevelCommaBeforeAssignment() {
            return false
        }
        let savedPosition = position
        let savedTokens = tokens
        let savedDiagnosticCount = Diagnostics.Count
        try {
            let _ = ParseMultiAssignmentTarget()
            if Current.Kind != SyntaxKind.CommaToken {
                return false
            }
            do {
                let _ = MatchToken(SyntaxKind.CommaToken)
                let _ = ParseMultiAssignmentTarget()
            } while Current.Kind == SyntaxKind.CommaToken
            return (Current.Kind is SyntaxKind.EqualsToken or SyntaxKind.ColonEqualsToken)
        } finally {
            position = savedPosition
            tokens = savedTokens
            Diagnostics.TruncateTo(savedDiagnosticCount)
        }
    }

    private func HasTopLevelCommaBeforeAssignment() bool {
        var parenthesisDepth = 0
        var bracketDepth = 0
        var braceDepth = 0
        for var offset = 0; offset <= LookaheadMaxScan; offset++ {
            let kind = Peek(offset).Kind
            switch kind {
                case SyntaxKind.OpenParenthesisToken {
                    parenthesisDepth++
                }
                case SyntaxKind.CloseParenthesisToken {
                    if parenthesisDepth == 0 {
                        return false
                    }
                    parenthesisDepth--
                }
                case SyntaxKind.OpenSquareBracketToken, SyntaxKind.QuestionOpenBracketToken {
                    bracketDepth++
                }
                case SyntaxKind.CloseSquareBracketToken {
                    if bracketDepth == 0 {
                        return false
                    }
                    bracketDepth--
                }
                case SyntaxKind.OpenBraceToken {
                    braceDepth++
                }
                case SyntaxKind.CloseBraceToken {
                    if braceDepth == 0 {
                        return false
                    }
                    braceDepth--
                }
                default {
                    let _ = 0
                }
            }
            if parenthesisDepth != 0 || bracketDepth != 0 || braceDepth != 0 {
                continue
            }
            if kind == SyntaxKind.CommaToken {
                return true
            }
            if kind == SyntaxKind.EqualsToken ||
                kind == SyntaxKind.ColonEqualsToken ||
                kind == SyntaxKind.SemicolonToken ||
                kind == SyntaxKind.EndOfFileToken {
                return false
            }
        }
        return false
    }

    private func ParseMultiAssignmentStatement() StatementSyntax {
        let targets = ParseMultiTargetList()
        var op SyntaxToken
        if Current.Kind == SyntaxKind.ColonEqualsToken {
            // ADR-0077 / issue #717: the legacy multi-target short variable-
            // declaration `a, b := e1, e2` is removed. Emit GS0305 and recover
            // by treating the operator as `=`; the binder still routes through
            // BindMultiAssignmentStatement and reports any follow-on errors
            // (e.g. undeclared targets) without spurious cascades.
            let colonEquals = MatchToken(SyntaxKind.ColonEqualsToken)
            let targetSnippet = BuildMultiTargetSnippet(targets)
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                "var ${targetSnippet[0]} = …  // one declaration per identifier"
            )
            op = SynthesiseEqualsToken(colonEquals)
        } else {
            op = MatchToken(SyntaxKind.EqualsToken)
        }
        let values = ParseMultiValueList()
        return MultiAssignmentStatementSyntax(syntaxTree, targets, op, values)
    }

    private func ParseMultiTargetList() SeparatedSyntaxList[ExpressionSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while true {
            nodesAndSeparators.Add(ParseMultiAssignmentTarget())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                continue
            }
            break
        }
        return SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseMultiAssignmentTarget() ExpressionSyntax {
        if (Current.Kind is SyntaxKind.LetKeyword or SyntaxKind.VarKeyword) {
            let keyword = NextToken()
            let identifier = MatchToken(SyntaxKind.IdentifierToken)
            return MultiAssignmentDeclarationExpressionSyntax(syntaxTree, keyword, identifier)
        }
        return ParseRangeExpression()
    }

    private func ParseMultiValueList() SeparatedSyntaxList[ExpressionSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while true {
            nodesAndSeparators.Add(ParseExpression())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                continue
            }
            break
        }
        return SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseVariableDeclaration() StatementSyntax {
        return ParseVariableDeclaration(accessibilityModifier: nil)
    }

    // ADR-0174 D15: `async let name = expr`. The declaration is an ordinary
    // `let` carrying the `async` modifier, so every existing shape — a type
    // clause, an annotation, the span and child-order rules — keeps working;
    // the binder is what turns it into a spawn.
    private func ParseAsyncLetStatement() StatementSyntax {
        let asyncKeyword = MatchToken(SyntaxKind.AsyncKeyword)
        let declaration = ParseVariableDeclaration()
        if declaration is VariableDeclarationSyntax variable {
            variable.AsyncModifier = asyncKeyword
        }
        return declaration
    }

    private func ParseVariableDeclaration(accessibilityModifier SyntaxToken?) StatementSyntax {
        var expected SyntaxKind
        switch Current.Kind {
            case SyntaxKind.ConstKeyword {
                expected = SyntaxKind.ConstKeyword
            }
            case SyntaxKind.LetKeyword {
                expected = SyntaxKind.LetKeyword
            }
            default {
                expected = SyntaxKind.VarKeyword
            }
        }
        let keyword = MatchToken(expected)
        // Phase 4.5: `let (a, b, ...) = expr` deconstructs a tuple-typed
        // initializer; ADR-0168 adds mutable `var (...)`. The opening paren
        // must come directly after the keyword: an explicit type clause or
        // identifier always starts with an identifier, so this is unambiguous.
        if (expected == SyntaxKind.LetKeyword || expected == SyntaxKind.VarKeyword) &&
            Current.Kind == SyntaxKind
            .OpenParenthesisToken {
            let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
            let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
            nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken))
            while Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken))
            }
            let idents = SeparatedSyntaxList[SyntaxToken](nodesAndSeparators.ToImmutable())
            let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
            let equalsTok = MatchToken(SyntaxKind.EqualsToken)
            let init = ParseExpression()
            return TupleDeconstructionStatementSyntax(
                syntaxTree,
                keyword,
                openParen,
                idents,
                closeParen,
                equalsTok,
                init
            )
        }
        if expected == SyntaxKind.LetKeyword && Current.Kind == SyntaxKind.OpenBraceToken {
            let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
            let fields = ParseNamedDeconstructionFields()
            let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
            let equalsTok = MatchToken(SyntaxKind.EqualsToken)
            let init = ParseExpression()
            return NamedDeconstructionStatementSyntax(
                syntaxTree,
                keyword,
                openBrace,
                fields,
                closeBrace,
                equalsTok,
                init
            )
        }
        // ADR-0058 / issue #376: optional `scoped` contextual modifier between the
        // keyword and the identifier. Disambiguate: `scoped` is only a modifier when
        // followed by another identifier (the variable name).
        var scopedModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped" && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken {
            scopedModifier = NextToken()
        }
        // Issue #491 (ADR-0060 follow-up): optional `ref` contextual modifier on
        // `let`/`var` declarations introduces a ref-aliasing local
        // (`let ref m = lvalue` / `var ref m = lvalue`). Disambiguate: `ref` is
        // only a modifier when followed by another identifier (the variable
        // name). If `ref` IS the variable name (no following identifier), treat
        // it as the identifier itself. Rejected on `const` after binding.
        var refKindModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken {
            refKindModifier = NextToken()
        }
        let readOnlyRefModifier = ParseOptionalReadOnlyRefModifier(refKindModifier)
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        // Issue #1886: `let Name[T] = func (...) ... { ... }` attaches a generic
        // type-parameter list to a let-bound function literal, since the literal
        // itself (being anonymous) has nowhere to carry one. Only meaningful on
        // `let` bindings; `var`/`const` simply never see a `[` here in practice.
        let typeParameterList = ParseOptionalTypeParameterList()
        let typeClause TypeClauseSyntax? = ParseOptionalTypeClause()
        // A `var` declaration may omit its initializer when an explicit type
        // clause is present (e.g. `var x int32`), in which case the variable
        // takes that type's default value. `let`/`const` remain immutable, so
        // an initializer stays mandatory for them; and without a type clause
        // there is nothing to infer from, so an initializer is still required.
        // Issue #491: a ref-aliasing local always requires an initializer (it
        // must alias an lvalue) — fall through to MatchToken below if absent.
        if expected == SyntaxKind.VarKeyword &&
            refKindModifier == nil &&
            typeClause != nil &&
            Current.Kind != SyntaxKind
            .EqualsToken {
            let decl = VariableDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                keyword,
                identifier,
                typeClause,
                equalsToken: nil,
                initializer: nil
            )
            decl.ScopedModifier = scopedModifier
            decl.TypeParameterList = typeParameterList
            return decl
        }
        let equals = MatchToken(SyntaxKind.EqualsToken)
        let initializer = ParseExpression()
        let result = VariableDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            keyword,
            identifier,
            typeClause,
            equals,
            initializer
        )
        result.ScopedModifier = scopedModifier
        result.RefKindModifier = refKindModifier
        result.ReadOnlyRefModifier = readOnlyRefModifier
        result.TypeParameterList = typeParameterList
        return result
    }

    private func ParseNamedDeconstructionFields() SeparatedSyntaxList[NamedDeconstructionFieldSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let field = MatchToken(SyntaxKind.IdentifierToken)
            let equals = MatchToken(SyntaxKind.EqualsToken)
            let local = MatchToken(SyntaxKind.IdentifierToken)
            nodesAndSeparators.Add(NamedDeconstructionFieldSyntax(syntaxTree, field, equals, local))
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[NamedDeconstructionFieldSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseIfStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.IfKeyword)
        let (initializer, semicolon, condition) = ParseIfHeader()
        let statement = ParseStatement()
        let elseClause = ParseElseClause()
        return IfStatementSyntax(syntaxTree, keyword, initializer, semicolon, condition, statement, elseClause)
    }

    /// Parses the header after `if`, `( SimpleStmt ";" )? Expression`.
    /// The if-statement and the if-expression both call it (issue #4962,
    /// ADR-0064), so the two forms accept the same initializer and parse the
    /// condition the same way.
    /// @returns The optional initializer, the `;` that ends it, and the condition.
    private func ParseIfHeader()(Initializer StatementSyntax?, Semicolon SyntaxToken?, Condition ExpressionSyntax) {
        var initializer StatementSyntax? = nil
        var semicolon SyntaxToken? = nil
        if HasIfInitClause() {
            initializer = ParseSimpleStatement()
            semicolon = MatchToken(SyntaxKind.SemicolonToken)
        }
        let condition = ParseExpressionInBodyHeader()
        return (initializer, semicolon, condition)
    }

    private func HasIfInitClause() bool {
        // Mirrors LooksLikeForClause: scan ahead from the position
        // after `if` looking for a semicolon at parenthesis and bracket
        // depth zero before the opening brace of the then-block.
        //
        // Issue #4962: an if-expression nested in the header has its own
        // `if init; cond` header, so a nested `if` at depth zero ends the
        // scan: the `;` that follows belongs to it. An initializer cannot
        // itself hold a depth-zero `if`, because that if-expression's
        // then-block `{` would end the scan first. A `;` inside brackets
        // (`flags[if var i = 0; i > 0 { 1 } else { 0 }]`) is skipped the
        // same way as one inside parentheses.
        var depth = 0
        for var i = 0; i < 256; i++ {
            let k = Peek(i).Kind
            if depth == 0 {
                if k == SyntaxKind.SemicolonToken {
                    return true
                }
                if k == SyntaxKind.OpenBraceToken || k == SyntaxKind.EndOfFileToken || k == SyntaxKind.IfKeyword {
                    return false
                }
            }
            if k == SyntaxKind.OpenParenthesisToken ||
                k == SyntaxKind.OpenSquareBracketToken ||
                k == SyntaxKind.QuestionOpenBracketToken {
                depth++
            } else if (k == SyntaxKind.CloseParenthesisToken || k == SyntaxKind.CloseSquareBracketToken) && depth > 0 {
                depth--
            }
        }
        return false
    }

    private func ParseElseClause() ElseClauseSyntax? {
        if Current.Kind != SyntaxKind.ElseKeyword {
            return nil
        }
        let keyword = NextToken()
        let statement = ParseStatement()
        return ElseClauseSyntax(syntaxTree, keyword, statement)
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    // ──────────────────────────────────────────────────────────────────────
    private func ParseIfLetStatement() IfLetStatementSyntax {
        let ifKeyword = MatchToken(SyntaxKind.IfKeyword)
        // Issue #4961 / ADR-0201: the same header routine as the expression
        // form, so a top-level `&&` after the final binding starts the guard.
        let (bindings, guardOperator, guard_) = ParseIfLetHeader()
        let thenStatement = ParseStatement()
        let elseClause = ParseElseClause()
        return IfLetStatementSyntax(syntaxTree, ifKeyword, bindings, guardOperator, guard_, thenStatement, elseClause)
    }

    private func ParseGuardLetStatement() GuardLetStatementSyntax {
        let guardKeyword = MatchToken(SyntaxKind.GuardKeyword)
        let (bindings, guardOperator, guard_) = ParseIfLetHeader(unsupportedGuardForm: "guard let")
        let elseKeyword = MatchToken(SyntaxKind.ElseKeyword)
        let elseStatement = ParseStatement()
        return GuardLetStatementSyntax(
            syntaxTree,
            guardKeyword,
            bindings,
            guardOperator,
            guard_,
            elseKeyword,
            elseStatement
        )
    }

    private func ParseForStatement() StatementSyntax {
        if Peek(1).Kind == SyntaxKind.OpenBraceToken {
            return ParseForInfiniteStatement()
        }
        // Issue #1922: `for (a, b, ...) in coll { ... }` — checked before
        // `LooksLikeForRange` (which requires an identifier right after
        // `for`, so it never matches here) and before `LooksLikeForClause`
        // (whose plain semicolon scan would otherwise misparse the `(a, b)`
        // header as a parenthesized C-style-for expression).
        if LooksLikeForTupleRange() {
            return ParseForTupleRangeStatement()
        }
        if LooksLikeForRange() {
            return ParseForRangeStatement()
        }
        if LooksLikeForEllipsis() {
            return ParseForEllipsisStatement()
        }
        if LooksLikeForClause() {
            return ParseForClauseStatement()
        }
        return ParseForConditionStatement()
    }

    private func LooksLikeForTupleRange() bool {
        // `for ( <ident> (, <ident>)+ ) in <expr> { ... }` — at least two
        // identifiers (arity ≥ 2, matching TupleTypeSymbol's minimum) so this
        // never collides with a parenthesized boolean condition such as
        // `for (x > 0) { ... }` (no comma) or a single-name grouped
        // expression `for (x) in xs { ... }` isn't legal G# anyway, but the
        // 2+ identifier requirement keeps this check unambiguous and cheap.
        if Peek(1).Kind != SyntaxKind.OpenParenthesisToken || Peek(2).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        var o = 3
        var sawComma = false
        while Peek(o).Kind == SyntaxKind.CommaToken && Peek(o + 1).Kind == SyntaxKind.IdentifierToken {
            sawComma = true
            o += 2
        }
        if !sawComma || Peek(o).Kind != SyntaxKind.CloseParenthesisToken {
            return false
        }
        return Peek(o + 1).Kind == SyntaxKind.IdentifierToken && Peek(o + 1).Text == "in"
    }

    private func ParseForTupleRangeStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ForKeyword)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken))
        while Current.Kind == SyntaxKind.CommaToken {
            nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken))
        }
        let identifiers = SeparatedSyntaxList[SyntaxToken](nodesAndSeparators.ToImmutable())
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let inToken = MatchToken(SyntaxKind.IdentifierToken) // contextual `in`, guarded by LooksLikeForTupleRange
        let collection = ParseExpressionInBodyHeader(allowEmptyStructLiteralCollection: true)
        let body = ParseStatement()
        return ForTupleRangeStatementSyntax(
            syntaxTree,
            keyword,
            openParen,
            identifiers,
            closeParen,
            inToken,
            collection,
            body
        )
    }

    private func LooksLikeForRange() bool {
        // `for <ident> := range <expr> { ... }`
        // `for <ident>, <ident> := range <expr> { ... }`
        // `for <ident> in <expr> { ... }`
        // `for <ident>, <ident> in <expr> { ... }`
        //
        // NB: `for <ident> in <lo> ... <hi> { ... }` is the integer-range
        // (ellipsis) form (ADR-0077). The shared `in` token means we must
        // peek past the collection / lower-bound expression to see whether
        // an ellipsis follows — if so, this is *not* the range form.
        if Peek(1).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        var o = 2
        var hasCommaSecondId = false
        if Peek(o).Kind == SyntaxKind.CommaToken {
            if Peek(o + 1).Kind != SyntaxKind.IdentifierToken {
                return false
            }
            hasCommaSecondId = true
            o += 2
        }
        if Peek(o).Kind == SyntaxKind.IdentifierToken && Peek(o).Text == "in" {
            // A `k, v in dict` form never collides with the ellipsis form
            // (ellipsis is single-identifier only) — accept immediately.
            if hasCommaSecondId {
                return true
            }
            // Single-identifier `in`: distinguish from `for i in lo ... hi`
            // by scanning ahead for an ellipsis at depth zero before the
            // body's open brace.
            return !HasEllipsisBeforeBrace(o + 1)
        }
        if !hasCommaSecondId && LooksLikeTypedForRange(o, out var inOffset) {
            return !HasEllipsisBeforeBrace(inOffset + 1)
        }
        if Peek(o).Kind != SyntaxKind.ColonEqualsToken {
            return false
        }
        return Peek(o + 1).Kind == SyntaxKind.RangeKeyword
    }

    private func LooksLikeTypedForRange(typeOffset int32, out inOffset int32) bool {
        inOffset = -1
        if !CanStartTypeClause(Peek(typeOffset)) {
            return false
        }
        let savedPosition = position
        let savedTokens = tokens
        let savedDiagnosticCount = Diagnostics.Count
        try {
            position += typeOffset
            let _ = ParseTypeClause()
            if Diagnostics.Count != savedDiagnosticCount ||
                Current.Kind != SyntaxKind.IdentifierToken ||
                Current.Text != "in" {
                return false
            }
            inOffset = position - savedPosition
            return true
        } finally {
            position = savedPosition
            tokens = savedTokens
            Diagnostics.TruncateTo(savedDiagnosticCount)
        }
    }

    private func HasEllipsisBeforeBrace(startOffset int32) bool {
        var depth = 0
        for var i = startOffset; i < 256; i++ {
            let k = Peek(i).Kind
            if depth == 0 {
                if k == SyntaxKind.EllipsisToken {
                    return true
                }
                if k == SyntaxKind.OpenBraceToken || k == SyntaxKind.SemicolonToken || k == SyntaxKind.EndOfFileToken {
                    return false
                }
            }
            if k == SyntaxKind.OpenParenthesisToken {
                depth++
            } else if k == SyntaxKind.CloseParenthesisToken && depth > 0 {
                depth--
            }
        }
        return false
    }

    private func LooksLikeForEllipsis() bool {
        // Canonical: `for <ident> in <expr> ... <expr> { ... }`
        // Legacy (removed by ADR-0077 / issue #717, but still recognised by
        // the parser so it can emit GS0305 instead of a parse cascade):
        //   `for <ident> := <expr> ... <expr> { ... }`
        if Peek(1).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        let separator = Peek(2)
        let hasSeparator = separator.Kind == SyntaxKind.ColonEqualsToken ||
            (separator.Kind == SyntaxKind.IdentifierToken && separator.Text == "in")
        if !hasSeparator {
            return false
        }
        var depth = 0
        for var i = 3; i < 256; i++ {
            let k = Peek(i).Kind
            if depth == 0 {
                if k == SyntaxKind.EllipsisToken {
                    return true
                }
                if k == SyntaxKind.OpenBraceToken || k == SyntaxKind.SemicolonToken || k == SyntaxKind.EndOfFileToken {
                    return false
                }
            }
            if k == SyntaxKind.OpenParenthesisToken {
                depth++
            } else if k == SyntaxKind.CloseParenthesisToken && depth > 0 {
                depth--
            }
        }
        return false
    }

    private func LooksLikeForClause() bool {
        // `for [init]; [cond]; [post] { ... }` — a semicolon at depth zero
        // before the opening brace marks the C-style clause form.
        if Peek(1).Kind == SyntaxKind.SemicolonToken {
            return true
        }
        var depth = 0
        for var i = 1; i < 256; i++ {
            let k = Peek(i).Kind
            if depth == 0 {
                if k == SyntaxKind.SemicolonToken {
                    return true
                }
                if k == SyntaxKind.OpenBraceToken || k == SyntaxKind.EndOfFileToken {
                    return false
                }
            }
            if k == SyntaxKind.OpenParenthesisToken {
                depth++
            } else if k == SyntaxKind.CloseParenthesisToken && depth > 0 {
                depth--
            }
        }
        return false
    }

    private func ParseForConditionStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ForKeyword)
        let condition = ParseExpressionInBodyHeader()
        let body = ParseStatement()
        return ForConditionStatementSyntax(syntaxTree, keyword, condition, body)
    }

    private func ParseForClauseStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ForKeyword)
        var initializer StatementSyntax? = nil
        if Current.Kind != SyntaxKind.SemicolonToken {
            initializer = ParseSimpleStatement()
        }
        let firstSemicolon = MatchToken(SyntaxKind.SemicolonToken)
        var condition ExpressionSyntax? = nil
        if Current.Kind != SyntaxKind.SemicolonToken {
            // Unlike a condition-only loop, this expression ends at `;`, so
            // brace-carrying expressions cannot consume the loop body.
            condition = ParseExpression()
        }
        let secondSemicolon = MatchToken(SyntaxKind.SemicolonToken)
        var post StatementSyntax? = nil
        if Current.Kind != SyntaxKind.OpenBraceToken {
            // Issue #1023: the post statement sits immediately before the body
            // `{`. Suppress trailing object-initializer wrapping so an indexer-
            // or call-tailed post (`s += arr[s] { … }`) does not consume the
            // loop body's opening brace as a composite literal.
            //
            // Issue #4177: also suppress the BARE struct-literal form (mirrors
            // ParseExpressionInBodyHeader's #1575 fix for if/while/for-range
            // headers). Without this, an assignment-expression post whose RHS
            // ends in a plain member name immediately followed by an EMPTY loop
            // body (`c = c.Next { }`) misparses `Next { }` as an empty struct
            // literal applied to `Next`, swallowing the loop's own body brace
            // and desyncing the parser on whatever follows. A NON-empty struct
            // literal post (`result = Pt{X: i} { … }`) stays unaffected —
            // StructLiteralAllowedInSuppressedHeader still admits it.
            //
            // A for-clause post sits in the same "collection vs body" position
            // as a for-range collection, not an if/while condition: an EMPTY
            // struct literal immediately followed by a genuine body `{` should
            // still be recognized as a struct literal (`result = Pt{} { }`), so
            // allowEmptyStructLiteralInHeader is set here too (mirrors
            // ParseExpressionInBodyHeader's save/set/restore for for-range
            // callers, which pass allowEmptyStructLiteralCollection: true).
            suppressTrailingObjectInitializer++
            suppressStructLiteral++
            let savedAllowEmptyStructLiteral = allowEmptyStructLiteralInHeader
            allowEmptyStructLiteralInHeader = true
            try {
                post = ParseSimpleStatement()
            } finally {
                allowEmptyStructLiteralInHeader = savedAllowEmptyStructLiteral
                suppressTrailingObjectInitializer--
                suppressStructLiteral--
            }
        }
        let body = ParseStatement()
        return ForClauseStatementSyntax(
            syntaxTree,
            keyword,
            initializer,
            firstSemicolon,
            condition,
            secondSemicolon,
            post,
            body
        )
    }

    private func ParseSimpleStatement() StatementSyntax {
        // A "simple statement" in the for-header / if-init context is one of:
        //   variable declaration      `var x = expr` / `let x = expr` (ADR-0077)
        //   legacy short var decl     `x := expr`    — GS0305, removed
        //   increment/decrement       `x++` / `x--`
        //   assignment                `x = expr`, `x += expr`, ...
        //   expression statement      `f()`
        if Current.Kind == SyntaxKind.VarKeyword || Current.Kind == SyntaxKind.LetKeyword {
            return ParseVariableDeclaration()
        }
        if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonEqualsToken {
            return ParseSingleShortVariableDeclaration()
        }
        if Current.Kind == SyntaxKind.IdentifierToken &&
            (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken) {
            return ParseIncrementDecrementStatement()
        }
        return ParseExpressionStatement()
    }

    private func ParseForInfiniteStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ForKeyword)
        let body = ParseStatement()
        return ForInfiniteStatementSyntax(syntaxTree, keyword, body)
    }

    private func ParseForRangeStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ForKeyword)
        let firstIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        var typeClause TypeClauseSyntax? = nil
        var commaToken SyntaxToken? = nil
        var secondIdentifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.CommaToken {
            commaToken = MatchToken(SyntaxKind.CommaToken)
            secondIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        } else if !(Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in") &&
            Current.Kind != SyntaxKind.ColonEqualsToken {
            typeClause = ParseTypeClause()
        }
        var colonEqualsToken SyntaxToken? = nil
        var rangeKeyword SyntaxToken? = nil
        var inToken SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in" {
            inToken = NextToken()
        } else {
            // ADR-0077 / issue #717: `for v := range coll` (and its `for k, v :=
            // range dict` sibling) is removed. The canonical `for v in coll`
            // form already exists (ADR-0031); emit GS0305 and recover by
            // synthesising an `in` token so binding still produces a
            // `BoundForRangeStatement` and downstream diagnostics are clean.
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken)
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword)
            let snippet = if secondIdentifier == nil {
                "for ${firstIdentifier.Text} in …"
            } else {
                "for ${firstIdentifier.Text}, ${secondIdentifier.Text} in …"
            }
            Diagnostics.ReportColonEqualsRemoved(colonEqualsToken.Location, snippet)
            inToken = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", nil)
            colonEqualsToken = nil
            rangeKeyword = nil
        }
        let collection = ParseExpressionInBodyHeader(allowEmptyStructLiteralCollection: true)
        let body = ParseStatement()
        return ForRangeStatementSyntax(
            syntaxTree,
            keyword,
            firstIdentifier,
            typeClause,
            commaToken,
            secondIdentifier,
            colonEqualsToken,
            rangeKeyword,
            inToken,
            collection,
            body
        )
    }

    private func ParseForEllipsisStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ForKeyword)
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        var colonEqualsToken SyntaxToken?
        var inToken SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in" {
            // ADR-0077 / issue #717: `for i in lo ... hi` is the canonical
            // integer-range form. The legacy `:=` spelling is removed below.
            inToken = NextToken()
            colonEqualsToken = nil
        } else {
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken)
            Diagnostics.ReportColonEqualsRemoved(colonEqualsToken.Location, "for ${identifier.Text} in lo ... hi")
            inToken = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", nil)
        }
        let lowerBound = ParseExpressionInBodyHeader()
        let toKeyword = MatchToken(SyntaxKind.EllipsisToken)
        let upperBound = ParseExpressionInBodyHeader()
        let body = ParseStatement()
        return ForEllipsisStatementSyntax(
            syntaxTree,
            keyword,
            identifier,
            inToken,
            lowerBound,
            toKeyword,
            upperBound,
            body
        )
    }

    private func ParseBreakStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.BreakKeyword)
        let label = TryParseLoopTargetLabel(keyword)
        return BreakStatementSyntax(syntaxTree, keyword, label)
    }

    private func ParseContinueStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ContinueKeyword)
        let label = TryParseLoopTargetLabel(keyword)
        return ContinueStatementSyntax(syntaxTree, keyword, label)
    }

    private func ParseGotoStatement() StatementSyntax {
        // Issue #1884: `goto label` — an unconditional jump to a `label:`
        // statement elsewhere in the enclosing function. The target
        // identifier is mandatory (unlike the optional labeled
        // `break`/`continue` target), so no same-line restriction is needed.
        let keyword = MatchToken(SyntaxKind.GotoKeyword)
        let label = MatchToken(SyntaxKind.IdentifierToken)
        return GotoStatementSyntax(syntaxTree, keyword, label)
    }

    private func TryParseLoopTargetLabel(keyword SyntaxToken) SyntaxToken? {
        // ADR-0070: an optional bare identifier on the same source line names
        // a labeled enclosing loop. Restricting the label to the same line
        // avoids accidentally swallowing the next statement.
        if Current.Kind != SyntaxKind.IdentifierToken {
            return nil
        }
        let keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start)
        let currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start)
        if keywordLine != currentLine {
            return nil
        }
        return NextToken()
    }

    private func ParseLabeledStatement() StatementSyntax {
        let label = MatchToken(SyntaxKind.IdentifierToken)
        let colon = MatchToken(SyntaxKind.ColonToken)
        let inner = ParseStatement()
        return LabeledStatementSyntax(syntaxTree, label, colon, inner)
    }

    private func ParseWhileStatement() StatementSyntax {
        // ADR-0070: `while cond { body }` — same lowering as `for cond { body }`.
        let keyword = MatchToken(SyntaxKind.WhileKeyword)
        let condition = ParseExpressionInBodyHeader()
        let body = ParseStatement()
        return WhileStatementSyntax(syntaxTree, keyword, condition, body)
    }

    private func ParseWhileLetStatement() WhileLetStatementSyntax {
        // ADR-0163 / issue #3352: the binding header reuses ADR-0071's
        // clause grammar so typing, recovery, and body-brace disambiguation
        // stay identical across if/guard/while let.
        let keyword = MatchToken(SyntaxKind.WhileKeyword)
        let (bindings, guardOperator, guard_) = ParseIfLetHeader(unsupportedGuardForm: "while let")
        let body = ParseStatement()
        return WhileLetStatementSyntax(syntaxTree, keyword, bindings, guardOperator, guard_, body)
    }

    private func ParseLockStatement() StatementSyntax {
        // Issue #1885: `lock expr { body }` — mutual exclusion around body,
        // lowered by the binder to the classic Monitor Enter/try/finally/Exit
        // pattern.
        let keyword = MatchToken(SyntaxKind.LockKeyword)
        let expression = ParseExpressionInBodyHeader()
        let body = ParseStatement()
        return LockStatementSyntax(syntaxTree, keyword, expression, body)
    }

    private func ParseDoWhileStatement() StatementSyntax {
        // ADR-0070: `do { body } while cond` — post-test loop. The trailing
        // `while` keyword reuses SyntaxKind.WhileKeyword so the lexer is
        // unchanged; the parser disambiguates by remembering it saw `do`.
        let doKeyword = MatchToken(SyntaxKind.DoKeyword)
        let body = ParseStatement()
        let whileKeyword = MatchToken(SyntaxKind.WhileKeyword)
        let condition = ParseExpression()
        return DoWhileStatementSyntax(syntaxTree, doKeyword, body, whileKeyword, condition)
    }

    private func ParseReturnStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ReturnKeyword)
        let keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start)
        let currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start)
        let hasExpression = Current.Kind != SyntaxKind.EndOfFileToken &&
            Current.Kind != SyntaxKind.CloseBraceToken &&
            keywordLine == currentLine
        var refKeyword SyntaxToken? = nil
        var expression ExpressionSyntax? = nil
        if hasExpression {
            // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier directly
            // following `return` marks this as a ref-return: `return ref <lvalue>`. The
            // modifier is consumed only when an expression-starting token follows on the
            // same line, preserving backward compatibility for `return ref` where `ref` is
            // itself the identifier being returned (the binder rejects `return ref` with
            // no operand on a ref-returning function).
            if Current.Kind == SyntaxKind.IdentifierToken &&
                Current.Text == "ref" &&
                CanStartExpression(Peek(1)) &&
                syntaxTree
                .Text
                .GetLineIndex(Peek(1).Span.Start) == keywordLine {
                refKeyword = NextToken()
            }
            expression = ParseExpression()
            // Phase 4.6: multi-return support. `return e1, e2, ...` lowers to
            // returning a tuple literal so callers can deconstruct or bind it
            // through the standard tuple machinery.
            if Current.Kind == SyntaxKind.CommaToken {
                let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
                nodesAndSeparators.Add(expression)
                let syntheticOpen = SyntaxToken.Missing(syntaxTree, SyntaxKind.OpenParenthesisToken, keyword.Position)
                while Current.Kind == SyntaxKind.CommaToken {
                    nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                    nodesAndSeparators.Add(ParseExpression())
                }
                let syntheticClose = SyntaxToken.Missing(syntaxTree, SyntaxKind.CloseParenthesisToken, Current.Position)
                let elements = SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
                expression = TupleLiteralExpressionSyntax(syntaxTree, syntheticOpen, elements, syntheticClose)
            }
        }
        return ReturnStatementSyntax(syntaxTree, keyword, refKeyword, expression)
    }

    private func ParseYieldStatement() StatementSyntax {
        // ADR-0040: `yield <expr>` statement. The `yield` token is a contextual
        // identifier (not a reserved keyword) to preserve source compatibility.
        let yieldToken = MatchToken(SyntaxKind.IdentifierToken)
        // Issue #3501: `yield break` terminates the iterator from any nesting
        // depth (C# alignment); plain `break` keeps its loop binding.
        if Current.Kind == SyntaxKind.BreakKeyword {
            let breakToken = MatchToken(SyntaxKind.BreakKeyword)
            return YieldStatementSyntax(syntaxTree, yieldToken, expression: nil, breakToken)
        }
        let expression = ParseExpression()
        return YieldStatementSyntax(syntaxTree, yieldToken, expression)
    }

    /// Issue #813: lookahead helper for the contextual `yield` at statement
    /// start. Returns `true` when the token at [`parenOffset`](paramref)
    /// is a `(` that opens a value-tuple literal (i.e. its matching
    /// `)` follows a top-level `,`). A tuple-literal yield like
    /// `yield (a, b)` must be parsed as a yield-statement; without this
    /// disambiguation the existing rule rejected every `yield (` form
    /// because it treats parens as the start of a function-call expression.
    private func LooksLikeYieldTupleLiteral(parenOffset int32) bool {
        if Peek(parenOffset).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        var depth = 0
        var bracketDepth = 0
        var braceDepth = 0
        let scanBound = Math.Min(tokens.Length, parenOffset + LookaheadMaxScan)
        for var i = parenOffset; i < scanBound; i++ {
            let t = Peek(i)
            switch t.Kind {
                case SyntaxKind.OpenParenthesisToken {
                    depth++
                }
                case SyntaxKind.CloseParenthesisToken {
                    depth--
                    if depth == 0 {
                        return false
                    }
                }
                case SyntaxKind.OpenSquareBracketToken {
                    bracketDepth++
                }
                case SyntaxKind.CloseSquareBracketToken {
                    bracketDepth--
                }
                case SyntaxKind.OpenBraceToken {
                    braceDepth++
                }
                case SyntaxKind.CloseBraceToken {
                    braceDepth--
                }
                case SyntaxKind.CommaToken {
                    if depth == 1 && bracketDepth == 0 && braceDepth == 0 {
                        return true
                    }
                }
                case SyntaxKind.EndOfFileToken {
                    return false
                }
                default {
                    let _ = 0
                }
            }
        }
        return false
    }

    shared {
        private func BuildMultiTargetSnippet(targets SeparatedSyntaxList[ExpressionSyntax])[]string {
            let names = [Math.Max(1, targets.Count)]string
            for var i = 0; i < targets.Count; i++ {
                if targets[i] is NameExpressionSyntax name {
                    names[i] = name.IdentifierToken.Text
                } else {
                    names[i] = "x"
                }
            }
            return names
        }
    }
}
