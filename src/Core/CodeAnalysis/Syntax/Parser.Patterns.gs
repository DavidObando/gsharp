// <copyright file="Parser.Patterns.cs" company="GSharp">
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
    private var patternParseContext PatternParseContext
    private var patternNestingDepth int32
    private enum PatternParseContext {
        General,
        IsExpression,
        IsExpressionBodyHeader,
        SwitchStatement,
        SwitchExpression
    }

    private func ParseSwitchStatement() StatementSyntax {
        let switchKeyword = MatchToken(SyntaxKind.SwitchKeyword)
        let expression = ParseExpressionInBodyHeader()
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let cases = ImmutableArray.CreateBuilder[SwitchCaseSyntax]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            cases.Add(ParseSwitchCase())
            // Defensive: if ParseSwitchCase failed to consume any token, break to
            // avoid an infinite loop.
            if Current == startToken {
                NextToken()
            }
        }
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return SwitchStatementSyntax(syntaxTree, switchKeyword, expression, openBrace, cases.ToImmutable(), closeBrace)
    }

    private func ParseSwitchCase() SwitchCaseSyntax {
        if Current.Kind == SyntaxKind.DefaultKeyword {
            let defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword)
            let body = ParseBlockStatement()
            return SwitchCaseSyntax(syntaxTree, defaultKeyword, value: nil, whenKeyword: nil, $guard: nil, body)
        }
        let caseKeyword = MatchToken(SyntaxKind.CaseKeyword)
        let value = ParseSwitchArmPattern(PatternParseContext.SwitchStatement)
        let (whenKeyword, guard_) = ParseOptionalWhenGuard(bodyFollows: true)
        let caseBody = ParseBlockStatement()
        return SwitchCaseSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard_, caseBody)
    }

    // Issue #3501 A3 / issue #4963: the pattern list of a switch arm, shared by
    // the statement form (`case 1, 2 { … }`) and the expression form
    // (`case 1, 2: …`). Go-style comma multi-pattern arms fold each comma into
    // the same disjunction node the `or` combinator produces
    // (BindBinaryPattern treats any non-`and` operator as `or`), so downstream
    // binding/emit need no changes and both forms mean the same thing.
    private func ParseSwitchArmPattern(context PatternParseContext) PatternSyntax {
        var value = ParsePattern(context)
        while Current.Kind == SyntaxKind.CommaToken {
            let comma = NextToken()
            let next = ParsePattern(context)
            value = BinaryPatternSyntax(syntaxTree, value, comma, next)
        }
        return value
    }

    // Issue #991: a contextual `when <bool-expr>` guard may follow the pattern
    // in a switch arm. `when` is not a reserved keyword in G#, so it is matched
    // contextually as an identifier whose text is "when"; this keeps existing
    // identifiers named `when` usable everywhere else. Returns (null, null) when
    // no guard is present.
    private func ParseOptionalWhenGuard(bodyFollows bool = false)(WhenKeyword SyntaxToken?, Guard ExpressionSyntax?) {
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "when" {
            let whenKeyword = NextToken()
            let guard_ = if bodyFollows {
                ParseExpressionInBodyHeader()
            } else {
                ParseExpression()
            }
            return (whenKeyword, guard_)
        }
        return (nil, nil)
    }

    private func ParsePattern(context PatternParseContext = PatternParseContext.General) PatternSyntax {
        let savedContext = patternParseContext
        let savedNestingDepth = patternNestingDepth
        patternParseContext = context
        patternNestingDepth = 0
        try {
            return ParseOrPattern()
        } finally {
            patternParseContext = savedContext
            patternNestingDepth = savedNestingDepth
        }
    }

    private func ParseNestedPattern() PatternSyntax {
        patternNestingDepth++
        try {
            return ParseOrPattern()
        } finally {
            patternNestingDepth--
        }
    }

    // Combinator precedence (matches C#): `not` binds tightest, then `and`,
    // then `or`. `and` / `or` / `not` are contextual keywords matched as
    // identifiers in pattern position so they remain usable as ordinary
    // identifiers elsewhere.
    private func ParseOrPattern() PatternSyntax {
        var left = ParseAndPattern()
        while Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "or" {
            let operatorToken = NextToken()
            let right = ParseAndPattern()
            left = BinaryPatternSyntax(syntaxTree, left, operatorToken, right)
        }
        return left
    }

    private func ParseAndPattern() PatternSyntax {
        var left = ParseUnaryPattern()
        while Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "and" {
            let operatorToken = NextToken()
            let right = ParseUnaryPattern()
            left = BinaryPatternSyntax(syntaxTree, left, operatorToken, right)
        }
        return left
    }

    // Issue #1602: depth-guarded wrapper — every pattern nesting cycle
    // (parenthesized, list, property, and `not` chains) passes through
    // ParseUnaryPattern, so a single tick here bounds the whole pattern
    // grammar.
    private func ParseUnaryPattern() PatternSyntax {
        EnsureNestedParseAllowed()
        recursionDepth++
        try {
            return ParseUnaryPatternCore()
        } finally {
            recursionDepth--
        }
    }

    private func ParseUnaryPatternCore() PatternSyntax {
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "not" {
            let notKeyword = NextToken()
            let operand = ParseUnaryPattern()
            return NotPatternSyntax(syntaxTree, notKeyword, operand)
        }
        return ParsePrimaryPattern()
    }

    private func ParsePrimaryPattern() PatternSyntax {
        if Current.Kind == SyntaxKind.VarKeyword {
            let varKeyword = MatchToken(SyntaxKind.VarKeyword)
            let designation = MatchToken(SyntaxKind.IdentifierToken)
            return VarPatternSyntax(syntaxTree, varKeyword, designation)
        }
        if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.IsKeyword {
            return ParseTypePattern()
        }
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "_" && Peek(
            1
        ).Kind != SyntaxKind.OpenParenthesisToken &&
            Peek(1).Kind != SyntaxKind.DotToken {
            return DiscardPatternSyntax(syntaxTree, MatchToken(SyntaxKind.IdentifierToken))
        }
        let typePattern PatternSyntax? = TryParseBareTypePattern()
        if typePattern != nil {
            return typePattern
        }
        switch Current.Kind {
            case SyntaxKind.OpenParenthesisToken {
                return ParseParenthesizedPattern()
            }
            case SyntaxKind.OpenSquareBracketToken {
                return ParseListPattern()
            }
            case SyntaxKind.OpenBraceToken {
                return ParsePropertyPatternOrBody()
            }
            case SyntaxKind.LessToken,
            SyntaxKind.LessOrEqualsToken,
            SyntaxKind.GreaterToken,
            SyntaxKind.GreaterOrEqualsToken,
            SyntaxKind.EqualsEqualsToken,
            SyntaxKind.BangEqualsToken {
                return ParseRelationalPattern()
            }
            default {
                return ConstantPatternSyntax(syntaxTree, ParseExpression())
            }
        }
    }

    private func ParseParenthesizedPattern() PatternSyntax {
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let pattern = ParseNestedPattern()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return ParenthesizedPatternSyntax(syntaxTree, openParen, pattern, closeParen)
    }

    private func ParseTypePattern() PatternSyntax {
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let isKeyword = MatchToken(SyntaxKind.IsKeyword)
        let type = ParseTypeClause()
        let propertyPattern = TryParseTypePropertyPattern(type)
        return TypePatternSyntax(syntaxTree, identifier, isKeyword, type, propertyPattern)
    }

    private func ParseRelationalPattern() PatternSyntax {
        let operatorToken = NextToken()
        let expression = ParseExpression()
        return RelationalPatternSyntax(syntaxTree, operatorToken, expression)
    }

    // Parses `{ Name: pattern, ... }` without a trailing designation. Callers
    // that own the surrounding pattern shape (a standalone property pattern or
    // a type pattern's property suffix) attach the ADR-0166 designation.
    private func ParsePropertyPatternCore() PropertyPatternSyntax {
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let identifier = MatchToken(SyntaxKind.IdentifierToken)
            let colon = MatchToken(SyntaxKind.ColonToken)
            let pattern = ParseNestedPattern()
            nodesAndSeparators.Add(PropertyPatternFieldSyntax(syntaxTree, identifier, colon, pattern))
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let fields = SeparatedSyntaxList[PropertyPatternFieldSyntax](nodesAndSeparators.ToImmutable())
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return PropertyPatternSyntax(syntaxTree, openBrace, fields, closeBrace)
    }

    // A standalone property pattern (`{ Length: > 0 } text`) owns its designation.
    private func ParsePropertyPattern() PropertyPatternSyntax {
        let property = ParsePropertyPatternCore()
        return WithDesignation(property, TryParsePatternDesignation(property))
    }

    private func WithDesignation(
        property PropertyPatternSyntax,
        designation SyntaxToken?
    ) PropertyPatternSyntax -> if designation == nil {
        property
    } else {
        PropertyPatternSyntax(
            syntaxTree,
            property.OpenBraceToken,
            property.Fields,
            property.CloseBraceToken,
            designation
        )
    }

    // ADR-0166: a designation is an identifier that directly follows a bare
    // type pattern (`string text`), a type + property suffix
    // (`Dog { Name: "Rex" } dog`), or a property pattern (`{ Length: > 0 } text`).
    // The pattern combinators and the `when` guard keyword are contextual
    // identifiers and never designations, and the identifier must sit on the
    // same line as the pattern it names so a following statement that starts
    // with a name is not swallowed.
    private func IsPatternDesignationCandidate(precedingNode SyntaxNode) bool -> IsPatternDesignationCandidateAt(
        0,
        precedingNode
    )

    private func IsPatternDesignationCandidateAt(offset int32, precedingNode SyntaxNode) bool {
        let token = Peek(offset)
        if token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        if (token.Text is "and" or "or" or "when") {
            return false
        }
        return !IsTokenOnNewLineAfter(token, precedingNode)
    }

    private func TryParsePatternDesignation(precedingNode SyntaxNode) SyntaxToken? {
        if !IsPatternDesignationCandidate(precedingNode) {
            return nil
        }
        return NextToken()
    }

    private func ParseListPattern() PatternSyntax {
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        while Current.Kind != SyntaxKind.CloseSquareBracketToken && Current.Kind != SyntaxKind.EndOfFileToken {
            // Issue #1505: a leading `..` is a slice ("rest") subpattern, not a
            // range expression. Without this production it would be consumed by
            // ParsePattern() as a System.Range constant pattern.
            if Current.Kind == SyntaxKind.DotDotToken {
                nodesAndSeparators.Add(ParseSlicePattern())
            } else {
                nodesAndSeparators.Add(ParseNestedPattern())
            }
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                break
            }
        }
        let elements = SeparatedSyntaxList[PatternSyntax](nodesAndSeparators.ToImmutable())
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        return ListPatternSyntax(syntaxTree, openBracket, elements, closeBracket)
    }

    // Issue #1505: a slice subpattern is `..` optionally followed by a capture
    // identifier (`..rest`) or a sub-pattern (`..[> 0]`). A bare identifier that
    // is not `_`, not part of a type pattern (`id is T`), and immediately
    // followed by `,` or `]` is treated as a capture binding the middle slice to
    // a `[]T` variable. Everything else after `..` is parsed as a sub-pattern
    // matched against the middle slice.
    private func ParseSlicePattern() PatternSyntax {
        let dotDot = MatchToken(SyntaxKind.DotDotToken)
        var captureIdentifier SyntaxToken? = nil
        var pattern PatternSyntax? = nil
        let isBareIdentifier = Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind != SyntaxKind.IsKeyword &&
            (Peek(1).Kind == SyntaxKind.CommaToken || Peek(1).Kind == SyntaxKind.CloseSquareBracketToken)
        if isBareIdentifier && Current.Text != "_" {
            captureIdentifier = NextToken()
        } else if isBareIdentifier {
            // `.._` — an explicit discard of the slice; consume the `_` and
            // leave it as a plain discard slice (no capture, no sub-pattern).
            NextToken()
        } else if Current.Kind != SyntaxKind.CommaToken &&
            Current.Kind != SyntaxKind.CloseSquareBracketToken &&
            Current.Kind != SyntaxKind.EndOfFileToken {
            pattern = ParseNestedPattern()
        }
        return SlicePatternSyntax(syntaxTree, dotDot, captureIdentifier, pattern)
    }

    private func TryParseBareTypePattern() PatternSyntax? {
        if !CanStartTypeClause(Current) {
            return nil
        }
        let savedPosition = position
        let savedTokens = tokens
        let savedDiagnosticCount = Diagnostics.Count
        var candidateEnd = savedPosition
        var isCandidate = false
        try {
            let trialType = ParseTypeClause()
            candidateEnd = position
            // ADR-0166: `Type name` — an identifier that directly follows the
            // type on the same line is a designation, so a bare name is a type
            // candidate there as well.
            isCandidate = Diagnostics.Count == savedDiagnosticCount &&
                (
                CanFollowBareTypePattern(Current) ||
                    IsTokenOnNewLineAfter(Current, trialType) ||
                    IsPatternDesignationCandidate(trialType)
            )
        } finally {
            position = savedPosition
            tokens = savedTokens
            Diagnostics.TruncateTo(savedDiagnosticCount)
        }
        if !isCandidate {
            return nil
        }
        let candidateType = ParseTypeClause()
        candidateEnd = position
        let candidateFollowKind = Current.Kind
        let candidateTokens = tokens
        // Option B disambiguation is semantic, not capitalization-based.
        // Preserve the value-shaped parse alongside the type candidate when
        // both consume exactly the same tokens. PatternBinder then gives the
        // legacy interpretation priority for its context (value in switch,
        // type after expression-level `is`).
        let expressionStart = savedPosition
        position = expressionStart
        let expressionDiagnosticCount = Diagnostics.Count
        let savedStructLiteral = suppressStructLiteral
        let savedObjectInitializer = suppressTrailingObjectInitializer
        suppressStructLiteral++
        suppressTrailingObjectInitializer++
        var expression ExpressionSyntax? = nil
        try {
            expression = ParseExpression()
        } finally {
            suppressStructLiteral = savedStructLiteral
            suppressTrailingObjectInitializer = savedObjectInitializer
        }
        if position == candidateEnd && Diagnostics.Count == expressionDiagnosticCount {
            let propertyPattern = TryParseTypePropertyPattern(candidateType)
            let valueDesignation SyntaxToken? = TryParsePatternDesignation(
                cast[SyntaxNode?](propertyPattern) ?? candidateType
            )
            if valueDesignation != nil {
                // ADR-0166: a designation commits the name to the type
                // interpretation, exactly like a property suffix does for
                // binding purposes — `value is limit n` can only be a type test.
                return TypePatternSyntax(
                    syntaxTree,
                    identifier: nil,
                    isKeyword: nil,
                    candidateType,
                    propertyPattern,
                    valueDesignation
                )
            }
            return TypeOrConstantPatternSyntax(syntaxTree, expression!!, candidateType, propertyPattern)
        }
        if position > candidateEnd &&
            Diagnostics.Count == expressionDiagnosticCount &&
            candidateFollowKind != SyntaxKind.OpenBraceToken &&
            (
            patternParseContext is PatternParseContext.General or
                PatternParseContext.SwitchStatement or
                PatternParseContext.SwitchExpression
        ) {
            position = savedPosition
            tokens = savedTokens
            Diagnostics.TruncateTo(savedDiagnosticCount)
            return nil
        }
        position = candidateEnd
        tokens = candidateTokens
        Diagnostics.TruncateTo(expressionDiagnosticCount)
        let suffix = TryParseTypePropertyPattern(candidateType)
        let designation = TryParsePatternDesignation(cast[SyntaxNode?](suffix) ?? candidateType)
        return TypePatternSyntax(syntaxTree, identifier: nil, isKeyword: nil, candidateType, suffix, designation)
    }

    private func ParsePropertyPatternOrBody() PatternSyntax {
        if patternParseContext != PatternParseContext.IsExpressionBodyHeader || patternNestingDepth != 0 {
            return ParsePropertyPattern()
        }
        let savedPosition = position
        let savedDiagnosticCount = Diagnostics.Count
        let property = ParsePropertyPatternCore()
        if CanCommitTypePropertyPattern(property) {
            return WithDesignation(property, TryParsePatternDesignation(property))
        }
        position = savedPosition
        Diagnostics.TruncateTo(savedDiagnosticCount)
        // Leave the brace for the owning statement body. MatchToken reports the
        // missing is-pattern at the brace without consuming it.
        let missing = MatchToken(SyntaxKind.IdentifierToken)
        return ConstantPatternSyntax(syntaxTree, NameExpressionSyntax(syntaxTree, missing))
    }

    // Parses the optional `{ ... }` suffix of a type pattern. The suffix never
    // carries its own designation: `Dog { Name: "Rex" } dog` names the type
    // pattern, so the caller attaches the designation after this returns.
    private func TryParseTypePropertyPattern(type TypeClauseSyntax) PropertyPatternSyntax? {
        if Current.Kind != SyntaxKind.OpenBraceToken {
            return nil
        }
        if patternParseContext == PatternParseContext.IsExpressionBodyHeader && patternNestingDepth == 0 && Peek(
            1
        ).Kind != SyntaxKind.CloseBraceToken &&
            (Peek(1).Kind != SyntaxKind.IdentifierToken || Peek(2).Kind != SyntaxKind.ColonToken) {
            return nil
        }
        if patternNestingDepth > 0 ||
            (patternParseContext is PatternParseContext.General or PatternParseContext.IsExpression) {
            return ParsePropertyPatternCore()
        }
        let savedPosition = position
        let savedDiagnosticCount = Diagnostics.Count
        let property = ParsePropertyPatternCore()
        if CanCommitTypePropertyPattern(property) {
            return property
        }
        position = savedPosition
        Diagnostics.TruncateTo(savedDiagnosticCount)
        return nil
    }

    // Decides whether a speculatively parsed `{ ... }` is a property pattern
    // rather than the owning statement body. ADR-0166: an optional designation
    // may sit between the closing brace and the continuation, so the check
    // looks past it (`if value is { Length: > 0 } text {`).
    private func CanCommitTypePropertyPattern(property PropertyPatternSyntax) bool {
        if patternNestingDepth > 0 {
            return true
        }
        let offset = if IsPatternDesignationCandidate(property) {
            1
        } else {
            0
        }
        let next = Peek(offset)
        if next.Kind == SyntaxKind.IdentifierToken && (next.Text == "and" || next.Text == "or") {
            return true
        }
        return switch patternParseContext {
            case PatternParseContext.General or PatternParseContext.IsExpression: true
            case PatternParseContext.IsExpressionBodyHeader: next.Kind == SyntaxKind.OpenBraceToken ||
                next.Kind == SyntaxKind.CloseParenthesisToken ||
                next
                .Kind
                .GetBinaryOperatorPrecedence() != 0
            case PatternParseContext.SwitchStatement: next.Kind == SyntaxKind.OpenBraceToken ||
                (next.Kind == SyntaxKind.IdentifierToken && next.Text == "when")
            case PatternParseContext.SwitchExpression: (
                next.Kind is SyntaxKind.ColonToken or SyntaxKind.RightArrowToken
            ) ||
                (next.Kind == SyntaxKind.IdentifierToken && next.Text == "when")
            default: false
        }
    }

    private func ParseFallthroughStatement() StatementSyntax {
        // Issue #3501 A3: `fallthrough` is now a real statement (Go
        // semantics). The binder enforces placement — last statement of a
        // non-final switch arm — and reports misuse.
        let keyword = MatchToken(SyntaxKind.FallthroughKeyword)
        return FallthroughStatementSyntax(syntaxTree, keyword)
    }

    private func ParseTryStatement() StatementSyntax {
        let tryKeyword = MatchToken(SyntaxKind.TryKeyword)
        let tryBlock = ParseBlockStatement()
        let catchClauses = ImmutableArray.CreateBuilder[CatchClauseSyntax]()
        while Current.Kind == SyntaxKind.CatchKeyword {
            catchClauses.Add(ParseCatchClause())
        }
        var finallyClause FinallyClauseSyntax? = nil
        if Current.Kind == SyntaxKind.FinallyKeyword {
            let finallyKeyword = NextToken()
            let body = ParseBlockStatement()
            finallyClause = FinallyClauseSyntax(syntaxTree, finallyKeyword, body)
        }
        return TryStatementSyntax(syntaxTree, tryKeyword, tryBlock, catchClauses.ToImmutable(), finallyClause)
    }

    // ADR-0177: catch clauses have C# parity. Four shapes are legal:
    //
    //   catch (e Type)   typed and bound
    //   catch (Type)     typed, unbound
    //   catch            catch-all, unbound (System.Exception)
    //   ... when <expr>  any of the above with a first-pass filter
    //
    // The parenthesized forms are told apart by lookahead: an identifier
    // followed by something that can start a type clause is a binder, and
    // anything else in the parentheses is a type. That retires the pre-ADR-0177
    // untyped `catch (name)` form, which made `catch (IOException)` bind a
    // variable named `IOException` and silently catch everything. A single
    // identifier now resolves as a type, so the old spelling fails loudly with
    // an undefined-type error instead of changing meaning in silence.
    private func ParseCatchClause() CatchClauseSyntax {
        let catchKeyword = MatchToken(SyntaxKind.CatchKeyword)
        var openParen SyntaxToken? = nil
        var identifier SyntaxToken? = nil
        var typeClause TypeClauseSyntax? = nil
        var closeParen SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
            if Current.Kind == SyntaxKind.IdentifierToken && CanStartTypeClause(Peek(1)) {
                identifier = MatchToken(SyntaxKind.IdentifierToken)
            }
            typeClause = ParseTypeClause()
            closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        }
        // The guard is parsed in body-header mode so that the `{` opening the
        // handler terminates the filter expression rather than being taken for
        // an object-creation brace — the same rule switch arms use (issue #991).
        let (whenKeyword, filter) = ParseOptionalWhenGuard(bodyFollows: true)
        let body = ParseBlockStatement()
        return CatchClauseSyntax(
            syntaxTree,
            catchKeyword,
            openParen,
            identifier,
            typeClause,
            closeParen,
            whenKeyword,
            filter,
            body
        )
    }

    private func ParseThrowStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.ThrowKeyword)
        let expression = ParseExpression()
        return ThrowStatementSyntax(syntaxTree, keyword, expression)
    }

    // ADR-0176 / issue #3897: `rethrow` takes no operand. It is a statement
    // only — there is no rethrow-expression, because a rethrow never produces
    // a value and C# has no `throw;` in expression position either.
    private func ParseRethrowStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.RethrowKeyword)
        return RethrowStatementSyntax(syntaxTree, keyword)
    }

    // Issue #1018: parses a throw-expression `throw <expr>` in value position.
    // The operand is parsed at full-expression precedence (greedy), matching
    // C#'s rule that `a ?? throw b ?? c` throws `(b ?? c)`. The throw-expression
    // itself is produced as a primary expression so it composes as the RHS of
    // `??`, a conditional branch, a returned operand, an argument, or an arrow
    // body.
    private func ParseThrowExpression() ExpressionSyntax {
        let keyword = MatchToken(SyntaxKind.ThrowKeyword)
        let expression = ParseExpression()
        return ThrowExpressionSyntax(syntaxTree, keyword, expression)
    }

    private func ParseUsingStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.UsingKeyword)
        if Current.Kind != SyntaxKind.LetKeyword &&
            Current.Kind != SyntaxKind.VarKeyword &&
            Current.Kind != SyntaxKind.ConstKeyword {
            // Force the expected keyword diagnostic by matching `let`.
            MatchToken(SyntaxKind.LetKeyword)
        }
        let decl = ParseVariableDeclaration()
        if decl is not VariableDeclarationSyntax variableDecl {
            // Issue #1603: `let (a, b) = …` / `let { … } = …` deconstructions
            // aren't a single variable declaration, so `using` can't wrap
            // them. Report and recover with the deconstruction statement
            // itself (no disposal), instead of an InvalidCastException.
            Diagnostics.ReportUsingRequiresSingleVariableDeclaration(decl.Location)
            return decl
        }
        return UsingStatementSyntax(syntaxTree, keyword, variableDecl)
    }

    private func ParseAwaitUsingStatement() StatementSyntax {
        let awaitKeyword = MatchToken(SyntaxKind.AwaitKeyword)
        let usingKeyword = MatchToken(SyntaxKind.UsingKeyword)
        if Current.Kind != SyntaxKind.LetKeyword &&
            Current.Kind != SyntaxKind.VarKeyword &&
            Current.Kind != SyntaxKind.ConstKeyword {
            MatchToken(SyntaxKind.LetKeyword)
        }
        let decl = ParseVariableDeclaration()
        if decl is not VariableDeclarationSyntax variableDecl {
            Diagnostics.ReportUsingRequiresSingleVariableDeclaration(decl.Location)
            return decl
        }
        return AwaitUsingStatementSyntax(syntaxTree, awaitKeyword, usingKeyword, variableDecl)
    }

    private func ParseGoStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.GoKeyword)
        if Current.Kind == SyntaxKind.OpenBraceToken {
            // ADR-0174 D14: `go { body }` is the block form — sugar for spawning
            // a zero-parameter function literal and invoking it. The literal's
            // `func ( )` and the invocation's `( )` are zero-width synthesized
            // tokens anchored at the block, so the block's own tokens stay real.
            let block = ParseBlockStatement()
            let start = block.Span.Start
            let end = block.Span.End
            let literal = FunctionLiteralExpressionSyntax(
                syntaxTree,
                SyntaxToken(syntaxTree, SyntaxKind.FuncKeyword, start, string.Empty, nil),
                SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, start, string.Empty, nil),
                SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty),
                SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, start, string.Empty, nil),
                returnTypeClause: nil,
                block
            )
            let invocation = CallExpressionSyntax(
                syntaxTree,
                literal,
                SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, end, string.Empty, nil),
                SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
                SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, end, string.Empty, nil)
            )
            return GoStatementSyntax(syntaxTree, keyword, invocation)
        }
        let expression = ParseExpression()
        return GoStatementSyntax(syntaxTree, keyword, expression)
    }

    private func ParseDeferStatement() StatementSyntax {
        let keyword = MatchToken(SyntaxKind.DeferKeyword)
        let expression = ParseExpression()
        return DeferStatementSyntax(syntaxTree, keyword, expression)
    }

    private func ParseScopeStatement() StatementSyntax {
        // Phase 5.7 / ADR-0022: `scope { … }` opens a structured-concurrency region.
        let scopeKeyword = MatchToken(SyntaxKind.ScopeKeyword)
        let body = ParseBlockStatement()
        return ScopeStatementSyntax(syntaxTree, scopeKeyword, body)
    }

    private func ParseAwaitForRangeStatement() StatementSyntax {
        // Canonical: `await for v in stream { … }` (ADR-0031).
        // Legacy `:=` spelling removed by ADR-0077 / issue #717 — emit GS0305
        // when the parser still encounters it.
        let awaitKeyword = MatchToken(SyntaxKind.AwaitKeyword)
        let forKeyword = MatchToken(SyntaxKind.ForKeyword)
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        var typeClause TypeClauseSyntax? = nil
        if !(Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in") &&
            Current.Kind != SyntaxKind.ColonEqualsToken {
            typeClause = ParseTypeClause()
        }
        var colonEquals SyntaxToken? = nil
        var rangeKeyword SyntaxToken? = nil
        var inToken SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in" {
            inToken = NextToken()
        } else {
            colonEquals = MatchToken(SyntaxKind.ColonEqualsToken)
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword)
            Diagnostics.ReportColonEqualsRemoved(colonEquals.Location, "await for ${identifier.Text} in …")
            inToken = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEquals.Position, "in", nil)
            colonEquals = nil
            rangeKeyword = nil
        }
        let stream = ParseExpressionInBodyHeader()
        let body = ParseBlockStatement()
        return AwaitForRangeStatementSyntax(
            syntaxTree,
            awaitKeyword,
            forKeyword,
            identifier,
            typeClause,
            colonEquals,
            rangeKeyword,
            inToken,
            stream,
            body
        )
    }

    private func ParseSelectStatement() StatementSyntax {
        // Phase 5.6 / ADR-0022: `select { case <-ch { … } case ch <- v { … }
        //                                  case v := <-ch { … } default { … } }`.
        let selectKeyword = MatchToken(SyntaxKind.SelectKeyword)
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let cases = ImmutableArray.CreateBuilder[SelectCaseSyntax]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            cases.Add(ParseSelectCase())
            // Defensive: avoid infinite loops if ParseSelectCase failed to advance.
            if Current == startToken {
                NextToken()
            }
        }
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return SelectStatementSyntax(syntaxTree, selectKeyword, openBrace, cases.ToImmutable(), closeBrace)
    }

    private func ParseSelectCase() SelectCaseSyntax {
        if Current.Kind == SyntaxKind.DefaultKeyword {
            let defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword)
            let body = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                defaultKeyword,
                SelectCaseKind.Default,
                identifier: nil,
                channel: nil,
                value: nil,
                body
            )
        }
        let caseKeyword = MatchToken(SyntaxKind.CaseKeyword)
        // case cancelled { ... } — the ambient context's cancellation
        // (ADR-0174 D8). `cancelled` is contextual: an arm over a channel of
        // that name still parses as a channel arm.
        if Current.Kind == SyntaxKind.IdentifierToken &&
            Current.Text == "cancelled" &&
            (
            Peek(1).Kind == SyntaxKind.OpenBraceToken ||
                (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "when")
        ) {
            NextToken() // consume `cancelled`
            let (cancelledWhen, cancelledGuard) = ParseOptionalWhenGuard(bodyFollows: true)
            let cancelledBody = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.Cancelled,
                identifier: nil,
                channel: nil,
                value: nil,
                cancelledWhen,
                cancelledGuard,
                cancelledBody
            )
        }
        // case await task { ... } — a Task arm whose result is discarded.
        if Current.Kind == SyntaxKind.AwaitKeyword {
            NextToken() // consume `await`
            let task = ParseArmOperand()
            let (awaitWhen, awaitGuard) = ParseOptionalWhenGuard(bodyFollows: true)
            let awaitBody = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.AwaitDiscard,
                identifier: nil,
                task,
                value: nil,
                awaitWhen,
                awaitGuard,
                awaitBody
            )
        }
        // case let v = await task { ... } — a Task[T] arm.
        if Current.Kind == SyntaxKind.LetKeyword && Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(
            2
        ).Kind == SyntaxKind.EqualsToken &&
            Peek(3).Kind == SyntaxKind.AwaitKeyword {
            NextToken() // consume `let`
            let awaitIdentifier = MatchToken(SyntaxKind.IdentifierToken)
            MatchToken(SyntaxKind.EqualsToken)
            MatchToken(SyntaxKind.AwaitKeyword)
            let task = ParseArmOperand()
            let (awaitWhen, awaitGuard) = ParseOptionalWhenGuard(bodyFollows: true)
            let awaitBody = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.AwaitBind,
                awaitIdentifier,
                task,
                value: nil,
                awaitWhen,
                awaitGuard,
                awaitBody
            )
        }
        // case <-ch { ... } — receive, discard.
        if Current.Kind == SyntaxKind.LeftArrowToken {
            NextToken() // consume `<-`
            let channel = ParseArmOperand()
            let (discardWhen, discardGuard) = ParseOptionalWhenGuard(bodyFollows: true)
            let body = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveDiscard,
                identifier: nil,
                channel,
                value: nil,
                discardWhen,
                discardGuard,
                body
            )
        }
        // case let v = <-ch { ... } — receive, bind (ADR-0077).
        if Current.Kind == SyntaxKind.LetKeyword && Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(
            2
        ).Kind == SyntaxKind.EqualsToken &&
            Peek(3).Kind == SyntaxKind.LeftArrowToken {
            NextToken() // consume `let`
            let identifier = MatchToken(SyntaxKind.IdentifierToken)
            MatchToken(SyntaxKind.EqualsToken)
            MatchToken(SyntaxKind.LeftArrowToken)
            let channel = ParseArmOperand()
            let (bindWhen, bindGuard) = ParseOptionalWhenGuard(bodyFollows: true)
            let body = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveBind,
                identifier,
                channel,
                value: nil,
                bindWhen,
                bindGuard,
                body
            )
        }
        // case v := <-ch { ... } — legacy receive-bind. ADR-0077 / issue #717
        // removes `:=`; emit GS0305 and recover by binding the identifier as
        // a `case let v = <-ch` would.
        if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonEqualsToken && Peek(
            2
        ).Kind == SyntaxKind
            .LeftArrowToken {
            let identifier = MatchToken(SyntaxKind.IdentifierToken)
            let colonEquals = MatchToken(SyntaxKind.ColonEqualsToken)
            Diagnostics.ReportColonEqualsRemoved(colonEquals.Location, "case let ${identifier.Text} = <-ch")
            MatchToken(SyntaxKind.LeftArrowToken)
            let channel = ParseArmOperand()
            let body = ParseBlockStatement()
            return SelectCaseSyntax(
                syntaxTree,
                caseKeyword,
                SelectCaseKind.ReceiveBind,
                identifier,
                channel,
                value: nil,
                body
            )
        }
        // case ch <- v { ... } — send.
        let sendChannel = ParseExpression()
        MatchToken(SyntaxKind.LeftArrowToken)
        let sendValue = ParseArmOperand()
        let (sendWhen, sendGuard) = ParseOptionalWhenGuard(bodyFollows: true)
        let sendBody = ParseBlockStatement()
        return SelectCaseSyntax(
            syntaxTree,
            caseKeyword,
            SelectCaseKind.Send,
            identifier: nil,
            sendChannel,
            sendValue,
            sendWhen,
            sendGuard,
            sendBody
        )
    }

    /// Parses the operand that sits immediately before a select arm's body
    /// brace. Issue #1023's defect in another position: a call- or
    /// indexer-tailed operand (`case ch <- Pair(41) { … }`) would
    /// otherwise read the arm's `{` as its own object initializer and
    /// swallow the body. Bare struct literals are suppressed for the same
    /// reason and by the same rule as a statement header's (issue #1575): an
    /// empty `{ }` body after a name operand — `case <-ch { }` —
    /// is a body, not an empty struct literal.
    /// @returns The parsed operand.
    private func ParseArmOperand() ExpressionSyntax {
        suppressTrailingObjectInitializer++
        suppressStructLiteral++
        try {
            return ParseExpression()
        } finally {
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
    }

    private func ParseExpressionStatement() StatementSyntax {
        let expression = ParseExpression()
        if Current.Kind == SyntaxKind.QuestionQuestionEqualsToken {
            // ADR-0072 / issue #709: `target ??= value` is also valid as a
            // simple statement inside for-headers and other simple-statement
            // contexts.
            let opToken = NextToken()
            let rhs = ParseExpression()
            return NullCoalescingAssignmentStatementSyntax(syntaxTree, expression, opToken, rhs)
        }
        return ExpressionStatementSyntax(syntaxTree, expression)
    }

    private func ParseExpressionOrChannelSendStatement() StatementSyntax {
        let expression = ParseExpression()
        if Current.Kind == SyntaxKind.LeftArrowToken {
            // Phase 5.5 / ADR-0022: `ch <- v` is a statement, not an expression.
            let arrow = NextToken()
            let value = ParseExpression()
            return ChannelSendStatementSyntax(syntaxTree, expression, arrow, value)
        }
        if Current.Kind == SyntaxKind.QuestionQuestionEqualsToken {
            // ADR-0072 / issue #709: `target ??= value`. The target must be a
            // nullable lvalue. We don't desugar here — the binder validates
            // assignability + nullability and emits a lowered if/assign form.
            let opToken = NextToken()
            let rhs = ParseExpression()
            return NullCoalescingAssignmentStatementSyntax(syntaxTree, expression, opToken, rhs)
        }
        return ExpressionStatementSyntax(syntaxTree, expression)
    }

    shared {
        private func CanFollowBareTypePattern(token SyntaxToken) bool {
            if token.Kind.GetBinaryOperatorPrecedence() != 0 {
                return true
            }
            if token.Kind == SyntaxKind.IdentifierToken &&
                (token.Text == "and" || token.Text == "or" || token.Text == "when") {
                return true
            }
            return switch token.Kind {
                case SyntaxKind.OpenBraceToken or
                    SyntaxKind.CloseBraceToken or
                    SyntaxKind.CloseSquareBracketToken or
                    SyntaxKind.CloseParenthesisToken or
                    SyntaxKind.CommaToken or
                    SyntaxKind.ColonToken or
                    SyntaxKind.RightArrowToken or
                    SyntaxKind.SemicolonToken or
                    SyntaxKind.QuestionToken or
                    SyntaxKind.EndOfFileToken or
                    SyntaxKind.ElseKeyword or
                    SyntaxKind.CaseKeyword or
                    SyntaxKind.DefaultKeyword: true
                default: false
            }
        }
    }
}
