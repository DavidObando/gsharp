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
    private PatternParseContext patternParseContext;
    private int patternNestingDepth;

    private enum PatternParseContext
    {
        General,
        IsExpression,
        IsExpressionBodyHeader,
        SwitchStatement,
        SwitchExpression,
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
        var value = ParsePattern(PatternParseContext.SwitchStatement);

        // Issue #3501 A3: Go-style comma multi-pattern arms — `case 1, 2 { … }`.
        // Each comma folds into the same disjunction node the `or` combinator
        // produces (BindBinaryPattern treats any non-`and` operator as `or`),
        // so downstream binding/emit need no changes.
        while (Current.Kind == SyntaxKind.CommaToken)
        {
            var comma = NextToken();
            var next = ParsePattern(PatternParseContext.SwitchStatement);
            value = new BinaryPatternSyntax(syntaxTree, value, comma, next);
        }

        var (whenKeyword, guard) = ParseOptionalWhenGuard(bodyFollows: true);
        var caseBody = ParseBlockStatement();
        return new SwitchCaseSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard, caseBody);
    }

    // Issue #991: a contextual `when <bool-expr>` guard may follow the pattern
    // in a switch arm. `when` is not a reserved keyword in G#, so it is matched
    // contextually as an identifier whose text is "when"; this keeps existing
    // identifiers named `when` usable everywhere else. Returns (null, null) when
    // no guard is present.
    private (SyntaxToken? WhenKeyword, ExpressionSyntax? Guard) ParseOptionalWhenGuard(bool bodyFollows = false)
    {
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "when")
        {
            var whenKeyword = NextToken();
            var guard = bodyFollows ? ParseExpressionInBodyHeader() : ParseExpression();
            return (whenKeyword, guard);
        }

        return (null, null);
    }

    private PatternSyntax ParsePattern(PatternParseContext context = PatternParseContext.General)
    {
        var savedContext = patternParseContext;
        var savedNestingDepth = patternNestingDepth;
        patternParseContext = context;
        patternNestingDepth = 0;
        try
        {
            return ParseOrPattern();
        }
        finally
        {
            patternParseContext = savedContext;
            patternNestingDepth = savedNestingDepth;
        }
    }

    private PatternSyntax ParseNestedPattern()
    {
        patternNestingDepth++;
        try
        {
            return ParseOrPattern();
        }
        finally
        {
            patternNestingDepth--;
        }
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
        if (Current.Kind == SyntaxKind.VarKeyword)
        {
            var varKeyword = MatchToken(SyntaxKind.VarKeyword);
            var designation = MatchToken(SyntaxKind.IdentifierToken);
            return new VarPatternSyntax(syntaxTree, varKeyword, designation);
        }

        if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.IsKeyword)
        {
            return ParseTypePattern();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "_"
            && Peek(1).Kind != SyntaxKind.OpenParenthesisToken
            && Peek(1).Kind != SyntaxKind.DotToken)
        {
            return new DiscardPatternSyntax(syntaxTree, MatchToken(SyntaxKind.IdentifierToken));
        }

        var typePattern = TryParseBareTypePattern();
        if (typePattern != null)
        {
            return typePattern;
        }

        switch (Current.Kind)
        {
            case SyntaxKind.OpenParenthesisToken:
                return ParseParenthesizedPattern();
            case SyntaxKind.OpenSquareBracketToken:
                return ParseListPattern();
            case SyntaxKind.OpenBraceToken:
                return ParsePropertyPatternOrBody();
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
        var pattern = ParseNestedPattern();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new ParenthesizedPatternSyntax(syntaxTree, openParen, pattern, closeParen);
    }

    private PatternSyntax ParseTypePattern()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var isKeyword = MatchToken(SyntaxKind.IsKeyword);
        var type = ParseTypeClause();
        var propertyPattern = TryParseTypePropertyPattern(type);
        return new TypePatternSyntax(syntaxTree, identifier, isKeyword, type, propertyPattern);
    }

    private PatternSyntax ParseRelationalPattern()
    {
        var operatorToken = NextToken();
        var expression = ParseExpression();
        return new RelationalPatternSyntax(syntaxTree, operatorToken, expression);
    }

    // Parses `{ Name: pattern, ... }` without a trailing designation. Callers
    // that own the surrounding pattern shape (a standalone property pattern or
    // a type pattern's property suffix) attach the ADR-0166 designation.
    private PropertyPatternSyntax ParsePropertyPatternCore()
    {
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var colon = MatchToken(SyntaxKind.ColonToken);
            var pattern = ParseNestedPattern();
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

    // A standalone property pattern (`{ Length: > 0 } text`) owns its designation.
    private PropertyPatternSyntax ParsePropertyPattern()
    {
        var property = ParsePropertyPatternCore();
        return WithDesignation(property, TryParsePatternDesignation(property));
    }

    private PropertyPatternSyntax WithDesignation(PropertyPatternSyntax property, SyntaxToken? designation)
        => designation == null
            ? property
            : new PropertyPatternSyntax(syntaxTree, property.OpenBraceToken, property.Fields, property.CloseBraceToken, designation);

    // ADR-0166: a designation is an identifier that directly follows a bare
    // type pattern (`string text`), a type + property suffix
    // (`Dog { Name: "Rex" } dog`), or a property pattern (`{ Length: > 0 } text`).
    // The pattern combinators and the `when` guard keyword are contextual
    // identifiers and never designations, and the identifier must sit on the
    // same line as the pattern it names so a following statement that starts
    // with a name is not swallowed.
    private bool IsPatternDesignationCandidate(SyntaxNode precedingNode)
        => IsPatternDesignationCandidateAt(0, precedingNode);

    private bool IsPatternDesignationCandidateAt(int offset, SyntaxNode precedingNode)
    {
        var token = Peek(offset);
        if (token.Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        if (token.Text is "and" or "or" or "when")
        {
            return false;
        }

        return !IsTokenOnNewLineAfter(token, precedingNode);
    }

    private SyntaxToken? TryParsePatternDesignation(SyntaxNode precedingNode)
    {
        if (!IsPatternDesignationCandidate(precedingNode))
        {
            return null;
        }

        return NextToken();
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
                nodesAndSeparators.Add(ParseNestedPattern());
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
        SyntaxToken? captureIdentifier = null;
        PatternSyntax? pattern = null;

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
            pattern = ParseNestedPattern();
        }

        return new SlicePatternSyntax(syntaxTree, dotDot, captureIdentifier, pattern);
    }

    private PatternSyntax? TryParseBareTypePattern()
    {
        if (!CanStartTypeClause(Current))
        {
            return null;
        }

        var savedPosition = position;
        var savedTokens = tokens;
        var savedDiagnosticCount = Diagnostics.Count;
        var candidateEnd = savedPosition;
        var isCandidate = false;
        try
        {
            var trialType = ParseTypeClause();
            candidateEnd = position;

            // ADR-0166: `Type name` — an identifier that directly follows the
            // type on the same line is a designation, so a bare name is a type
            // candidate there as well.
            isCandidate = Diagnostics.Count == savedDiagnosticCount
                && (CanFollowBareTypePattern(Current)
                    || IsTokenOnNewLineAfter(Current, trialType)
                    || IsPatternDesignationCandidate(trialType));
        }
        finally
        {
            position = savedPosition;
            tokens = savedTokens;
            Diagnostics.TruncateTo(savedDiagnosticCount);
        }

        if (!isCandidate)
        {
            return null;
        }

        var candidateType = ParseTypeClause();
        candidateEnd = position;
        var candidateFollowKind = Current.Kind;
        var candidateTokens = tokens;

        // Option B disambiguation is semantic, not capitalization-based.
        // Preserve the value-shaped parse alongside the type candidate when
        // both consume exactly the same tokens. PatternBinder then gives the
        // legacy interpretation priority for its context (value in switch,
        // type after expression-level `is`).
        var expressionStart = savedPosition;
        position = expressionStart;
        var expressionDiagnosticCount = Diagnostics.Count;
        var savedStructLiteral = suppressStructLiteral;
        var savedObjectInitializer = suppressTrailingObjectInitializer;
        suppressStructLiteral++;
        suppressTrailingObjectInitializer++;
        ExpressionSyntax? expression = null;
        try
        {
            expression = ParseExpression();
        }
        finally
        {
            suppressStructLiteral = savedStructLiteral;
            suppressTrailingObjectInitializer = savedObjectInitializer;
        }

        if (position == candidateEnd && Diagnostics.Count == expressionDiagnosticCount)
        {
            var propertyPattern = TryParseTypePropertyPattern(candidateType);
            var valueDesignation = TryParsePatternDesignation((SyntaxNode?)propertyPattern ?? candidateType);
            if (valueDesignation != null)
            {
                // ADR-0166: a designation commits the name to the type
                // interpretation, exactly like a property suffix does for
                // binding purposes — `value is limit n` can only be a type test.
                return new TypePatternSyntax(
                    syntaxTree,
                    identifier: null,
                    isKeyword: null,
                    candidateType,
                    propertyPattern,
                    valueDesignation);
            }

            return new TypeOrConstantPatternSyntax(
                syntaxTree,
                expression,
                candidateType,
                propertyPattern);
        }

        if (position > candidateEnd
            && Diagnostics.Count == expressionDiagnosticCount
            && candidateFollowKind != SyntaxKind.OpenBraceToken
            && patternParseContext is PatternParseContext.General
                or PatternParseContext.SwitchStatement
                or PatternParseContext.SwitchExpression)
        {
            position = savedPosition;
            tokens = savedTokens;
            Diagnostics.TruncateTo(savedDiagnosticCount);
            return null;
        }

        position = candidateEnd;
        tokens = candidateTokens;
        Diagnostics.TruncateTo(expressionDiagnosticCount);
        var suffix = TryParseTypePropertyPattern(candidateType);
        var designation = TryParsePatternDesignation((SyntaxNode?)suffix ?? candidateType);
        return new TypePatternSyntax(
            syntaxTree,
            identifier: null,
            isKeyword: null,
            candidateType,
            suffix,
            designation);
    }

    private static bool CanFollowBareTypePattern(SyntaxToken token)
    {
        if (token.Kind.GetBinaryOperatorPrecedence() != 0)
        {
            return true;
        }

        if (token.Kind == SyntaxKind.IdentifierToken
            && (token.Text == "and" || token.Text == "or" || token.Text == "when"))
        {
            return true;
        }

        return token.Kind switch
        {
            SyntaxKind.OpenBraceToken
                or SyntaxKind.CloseBraceToken
                or SyntaxKind.CloseSquareBracketToken
                or SyntaxKind.CloseParenthesisToken
                or SyntaxKind.CommaToken
                or SyntaxKind.ColonToken
                or SyntaxKind.RightArrowToken
                or SyntaxKind.SemicolonToken
                or SyntaxKind.QuestionToken
                or SyntaxKind.EndOfFileToken
                or SyntaxKind.ElseKeyword
                or SyntaxKind.CaseKeyword
                or SyntaxKind.DefaultKeyword => true,
            _ => false,
        };
    }

    private PatternSyntax ParsePropertyPatternOrBody()
    {
        if (patternParseContext != PatternParseContext.IsExpressionBodyHeader
            || patternNestingDepth != 0)
        {
            return ParsePropertyPattern();
        }

        var savedPosition = position;
        var savedDiagnosticCount = Diagnostics.Count;
        var property = ParsePropertyPatternCore();
        if (CanCommitTypePropertyPattern(property))
        {
            return WithDesignation(property, TryParsePatternDesignation(property));
        }

        position = savedPosition;
        Diagnostics.TruncateTo(savedDiagnosticCount);

        // Leave the brace for the owning statement body. MatchToken reports the
        // missing is-pattern at the brace without consuming it.
        var missing = MatchToken(SyntaxKind.IdentifierToken);
        return new ConstantPatternSyntax(syntaxTree, new NameExpressionSyntax(syntaxTree, missing));
    }

    // Parses the optional `{ ... }` suffix of a type pattern. The suffix never
    // carries its own designation: `Dog { Name: "Rex" } dog` names the type
    // pattern, so the caller attaches the designation after this returns.
    private PropertyPatternSyntax? TryParseTypePropertyPattern(TypeClauseSyntax type)
    {
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            return null;
        }

        if (patternParseContext == PatternParseContext.IsExpressionBodyHeader
            && patternNestingDepth == 0
            && Peek(1).Kind != SyntaxKind.CloseBraceToken
            && (Peek(1).Kind != SyntaxKind.IdentifierToken || Peek(2).Kind != SyntaxKind.ColonToken))
        {
            return null;
        }

        if (patternNestingDepth > 0
            || patternParseContext is PatternParseContext.General or PatternParseContext.IsExpression)
        {
            return ParsePropertyPatternCore();
        }

        var savedPosition = position;
        var savedDiagnosticCount = Diagnostics.Count;
        var property = ParsePropertyPatternCore();
        if (CanCommitTypePropertyPattern(property))
        {
            return property;
        }

        position = savedPosition;
        Diagnostics.TruncateTo(savedDiagnosticCount);
        return null;
    }

    // Decides whether a speculatively parsed `{ ... }` is a property pattern
    // rather than the owning statement body. ADR-0166: an optional designation
    // may sit between the closing brace and the continuation, so the check
    // looks past it (`if value is { Length: > 0 } text {`).
    private bool CanCommitTypePropertyPattern(PropertyPatternSyntax property)
    {
        if (patternNestingDepth > 0)
        {
            return true;
        }

        var offset = IsPatternDesignationCandidate(property) ? 1 : 0;
        var next = Peek(offset);
        if (next.Kind == SyntaxKind.IdentifierToken
            && (next.Text == "and" || next.Text == "or"))
        {
            return true;
        }

        return patternParseContext switch
        {
            PatternParseContext.General or PatternParseContext.IsExpression => true,
            PatternParseContext.IsExpressionBodyHeader =>
                next.Kind == SyntaxKind.OpenBraceToken
                || next.Kind == SyntaxKind.CloseParenthesisToken
                || next.Kind.GetBinaryOperatorPrecedence() != 0,
            PatternParseContext.SwitchStatement =>
                next.Kind == SyntaxKind.OpenBraceToken
                || (next.Kind == SyntaxKind.IdentifierToken && next.Text == "when"),
            PatternParseContext.SwitchExpression =>
                next.Kind is SyntaxKind.ColonToken or SyntaxKind.RightArrowToken
                || (next.Kind == SyntaxKind.IdentifierToken && next.Text == "when"),
            _ => false,
        };
    }

    private StatementSyntax ParseFallthroughStatement()
    {
        // Issue #3501 A3: `fallthrough` is now a real statement (Go
        // semantics). The binder enforces placement — last statement of a
        // non-final switch arm — and reports misuse.
        var keyword = MatchToken(SyntaxKind.FallthroughKeyword);
        return new FallthroughStatementSyntax(syntaxTree, keyword);
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

        FinallyClauseSyntax? finallyClause = null;
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
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            // ADR-0174 D14: `go { body }` is the block form — sugar for spawning
            // a zero-parameter function literal and invoking it. The literal's
            // `func ( )` and the invocation's `( )` are zero-width synthesized
            // tokens anchored at the block, so the block's own tokens stay real.
            var block = ParseBlockStatement();
            var start = block.Span.Start;
            var end = block.Span.End;
            var literal = new FunctionLiteralExpressionSyntax(
                syntaxTree,
                new SyntaxToken(syntaxTree, SyntaxKind.FuncKeyword, start, string.Empty, null),
                new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, start, string.Empty, null),
                new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty),
                new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, start, string.Empty, null),
                returnTypeClause: null,
                block);
            var invocation = new CallExpressionSyntax(
                syntaxTree,
                literal,
                new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, end, string.Empty, null),
                new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
                new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, end, string.Empty, null));
            return new GoStatementSyntax(syntaxTree, keyword, invocation);
        }

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
        SyntaxToken? colonEquals = null;
        SyntaxToken? rangeKeyword = null;
        SyntaxToken? inToken = null;
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
            var channel = ParseArmOperand();
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
            var channel = ParseArmOperand();
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
            var channel = ParseArmOperand();
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
        var sendValue = ParseArmOperand();
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

    /// <summary>
    /// Parses the operand that sits immediately before a select arm's body
    /// brace. Issue #1023's defect in another position: a call- or
    /// indexer-tailed operand (<c>case ch &lt;- Pair(41) { … }</c>) would
    /// otherwise read the arm's <c>{</c> as its own object initializer and
    /// swallow the body.
    /// </summary>
    /// <returns>The parsed operand.</returns>
    private ExpressionSyntax ParseArmOperand()
    {
        suppressTrailingObjectInitializer++;
        try
        {
            return ParseExpression();
        }
        finally
        {
            suppressTrailingObjectInitializer--;
        }
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
