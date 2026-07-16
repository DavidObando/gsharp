// <copyright file="Parser.Statements.cs" company="GSharp">
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
    private BlockStatementSyntax ParseBlockStatement()
    {
        var statements = ImmutableArray.CreateBuilder<StatementSyntax>();

        var openBraceToken = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.EndOfFileToken &&
               Current.Kind != SyntaxKind.CloseBraceToken)
        {
            var startToken = Current;

            var statement = ParseStatement();
            statements.Add(statement);

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken);

        return new BlockStatementSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), closeBraceToken);
    }

    private MemberSyntax ParseGlobalStatement()
    {
        var statement = ParseStatement();
        return new GlobalStatementSyntax(syntaxTree, statement);
    }

    // Issue #1602: depth-guarded wrapper — statements self-nest through blocks
    // (`{{{{…`), if/for/while bodies, switch cases, etc.
    private StatementSyntax ParseStatement()
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseStatementCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private StatementSyntax ParseStatementCore()
    {
        // Issue #187 / ADR-0047 §2: a local `var`/`let`/`const` can be
        // preceded by Kotlin-style `@` annotations (default target `field`).
        // Other statement kinds do not accept annotations — for those we
        // still parse the leading `@...` (to drive a normal binder
        // diagnostic against the synthesized declaration) but fall through
        // to the regular dispatch and drop the annotations on the floor
        // after reporting via ReportAnnotationsNotAllowedOnStatement.
        ImmutableArray<AnnotationSyntax> leadingAnnotations = ImmutableArray<AnnotationSyntax>.Empty;
        if (Current.Kind == SyntaxKind.AtToken)
        {
            leadingAnnotations = ParseAnnotations();
            if (Current.Kind != SyntaxKind.ConstKeyword &&
                Current.Kind != SyntaxKind.LetKeyword &&
                Current.Kind != SyntaxKind.VarKeyword)
            {
                if (leadingAnnotations.Length > 0)
                {
                    Diagnostics.ReportAnnotationsNotAllowedOnStatement(leadingAnnotations[0].AtToken.Location);
                }

                leadingAnnotations = ImmutableArray<AnnotationSyntax>.Empty;
            }
        }

        // ADR-0122 / issue #1014: an `unsafe { … }` block introduces an unsafe
        // context for its statements. `unsafe` is a contextual keyword — only
        // an `unsafe` immediately followed by `{` is treated as the block form.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
            && Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            var unsafeKeyword = NextToken();
            this.unsafeDepth++;
            BlockStatementSyntax unsafeBlock;
            try
            {
                unsafeBlock = ParseBlockStatement();
            }
            finally
            {
                this.unsafeDepth--;
            }

            unsafeBlock.UnsafeKeyword = unsafeKeyword;
            return unsafeBlock;
        }

        // Issue #1881: a `checked { … }` / `unchecked { … }` block establishes
        // the named overflow context for the statements inside it. Both are
        // contextual keywords — only immediately followed by `{` are they
        // treated as the block form (a bare identifier named `checked` used
        // as an ordinary value is unaffected).
        if (Current.Kind == SyntaxKind.IdentifierToken
            && (Current.Text == "checked" || Current.Text == "unchecked")
            && Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            var isCheckedBlock = Current.Text == "checked";
            var checkedKeyword = NextToken();
            var checkedBlock = ParseBlockStatement();
            if (isCheckedBlock)
            {
                checkedBlock.CheckedKeyword = checkedKeyword;
            }
            else
            {
                checkedBlock.UncheckedKeyword = checkedKeyword;
            }

            return checkedBlock;
        }

        // ADR-0125 / issue #1026: a `fixed name *T = source { … }` pinning
        // statement. `fixed` is a contextual keyword — only the precise
        // `fixed IDENT *` shape (the binding name followed by a pointer type)
        // commits here, so existing identifiers named `fixed` are unaffected.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "fixed"
            && Peek(1).Kind == SyntaxKind.IdentifierToken
            && Peek(2).Kind == SyntaxKind.StarToken)
        {
            return ParseFixedStatement();
        }

        switch (Current.Kind)
        {
            case SyntaxKind.OpenBraceToken:
                return ParseBlockStatement();
            case SyntaxKind.ConstKeyword:
            case SyntaxKind.LetKeyword:
            case SyntaxKind.VarKeyword:
                var declaration = ParseVariableDeclaration();
                if (declaration is VariableDeclarationSyntax variableDeclaration &&
                    !leadingAnnotations.IsDefaultOrEmpty)
                {
                    variableDeclaration.WithAnnotations(leadingAnnotations);
                }

                return declaration;
            case SyntaxKind.IfKeyword:
                if (Peek(1).Kind == SyntaxKind.LetKeyword)
                {
                    return ParseIfLetStatement();
                }

                return ParseIfStatement();
            case SyntaxKind.GuardKeyword:
                return ParseGuardLetStatement();
            case SyntaxKind.ForKeyword:
                return ParseForStatement();
            case SyntaxKind.WhileKeyword:
                return ParseWhileStatement();
            case SyntaxKind.DoKeyword:
                return ParseDoWhileStatement();
            case SyntaxKind.LockKeyword:
                return ParseLockStatement();
            case SyntaxKind.BreakKeyword:
                return ParseBreakStatement();
            case SyntaxKind.ContinueKeyword:
                return ParseContinueStatement();
            case SyntaxKind.ReturnKeyword:
                return ParseReturnStatement();
            case SyntaxKind.SwitchKeyword:
                return ParseSwitchStatement();
            case SyntaxKind.FallthroughKeyword:
                return ParseFallthroughStatement();
            case SyntaxKind.TryKeyword:
                return ParseTryStatement();
            case SyntaxKind.ThrowKeyword:
                return ParseThrowStatement();
            case SyntaxKind.UsingKeyword:
                return ParseUsingStatement();
            case SyntaxKind.DeferKeyword:
                return ParseDeferStatement();
            case SyntaxKind.GotoKeyword:
                return ParseGotoStatement();
            case SyntaxKind.GoKeyword:
                return ParseGoStatement();
            case SyntaxKind.SelectKeyword:
                return ParseSelectStatement();
            case SyntaxKind.ScopeKeyword:
                return ParseScopeStatement();
            case SyntaxKind.AwaitKeyword:
                if (Peek(1).Kind == SyntaxKind.ForKeyword)
                {
                    return ParseAwaitForRangeStatement();
                }

                if (Peek(1).Kind == SyntaxKind.UsingKeyword)
                {
                    return ParseAwaitUsingStatement();
                }

                goto default;
            default:
                // ADR-0040: contextual `yield` keyword — parse as yield statement
                // when `yield` appears at statement start and is not followed by
                // an assignment operator or other identifier-consuming syntax.
                if (Current.Kind == SyntaxKind.SequenceKeyword &&
                    Peek(1).Kind != SyntaxKind.ColonEqualsToken &&
                    Peek(1).Kind != SyntaxKind.PlusPlusToken &&
                    Peek(1).Kind != SyntaxKind.MinusMinusToken &&
                    Peek(1).Kind != SyntaxKind.CommaToken &&
                    Peek(1).Kind != SyntaxKind.DotToken &&
                    Peek(1).Kind != SyntaxKind.OpenParenthesisToken &&
                    Peek(1).Kind != SyntaxKind.EqualsToken)
                {
                    // "sequence" at statement start is not a yield — fall through.
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    Current.Text == "yield" &&
                    Peek(1).Kind != SyntaxKind.ColonEqualsToken &&
                    Peek(1).Kind != SyntaxKind.PlusPlusToken &&
                    Peek(1).Kind != SyntaxKind.MinusMinusToken &&
                    Peek(1).Kind != SyntaxKind.CommaToken &&
                    Peek(1).Kind != SyntaxKind.DotToken &&
                    Peek(1).Kind != SyntaxKind.EqualsToken &&
                    Peek(1).Kind != SyntaxKind.OpenSquareBracketToken &&
                    (Peek(1).Kind != SyntaxKind.OpenParenthesisToken || LooksLikeYieldTupleLiteral(1)))
                {
                    // Issue #813: `yield (a, b)` is a yield-statement that
                    // yields a value-tuple literal — required for iterators
                    // whose element type is `(T1, T2, …)` (e.g. the
                    // dogfooded `Indexed` / `Pairwise` ports). Without the
                    // tuple-literal lookahead, `yield (` was uniformly
                    // forwarded to expression-statement parsing where it
                    // became the call `yield(args)` and reported GS0130.
                    return ParseYieldStatement();
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    Peek(1).Kind == SyntaxKind.ColonToken)
                {
                    // ADR-0070 / issue #1884: `label: statement`. A label on a
                    // loop names it for `break`/`continue`; a label on any
                    // other statement is a `goto` target. The binder tells
                    // the two apart.
                    return ParseLabeledStatement();
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    Peek(1).Kind == SyntaxKind.ColonEqualsToken)
                {
                    // We do this outside of "ParseExpressionStatement" because
                    // short variable declarations aren't expressions but
                    // statements.
                    return ParseSingleShortVariableDeclaration();
                }

                if (Current.Kind == SyntaxKind.IdentifierToken &&
                    (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken))
                {
                    return ParseIncrementDecrementStatement();
                }

                if (LooksLikeMultiAssignment())
                {
                    return ParseMultiAssignmentStatement();
                }

                return ParseExpressionOrChannelSendStatement();
        }
    }

    private StatementSyntax ParseSingleShortVariableDeclaration()
    {
        // ADR-0077 / issue #717: the legacy short variable-declaration
        // operator `:=` is removed. Emit GS0305 against the `:=` token and
        // recover by synthesising a `var` declaration so downstream binding
        // produces no cascade.
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
        Diagnostics.ReportColonEqualsRemoved(
            colonEquals.Location,
            $"let {identifier.Text} = …  or  var {identifier.Text} = …");
        var initializer = ParseExpression();
        var equalsToken = SynthesiseEqualsToken(colonEquals);
        return new VariableDeclarationSyntax(
            syntaxTree: syntaxTree,
            keyword: null,
            identifier: identifier,
            typeClause: null,
            equalsToken: equalsToken,
            initializer: initializer);
    }

    private SyntaxToken SynthesiseEqualsToken(SyntaxToken colonEquals)
    {
        return new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, colonEquals.Position, "=", null);
    }

    private StatementSyntax ParseIncrementDecrementStatement()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var op = NextToken();
        var baseOpKind = op.Kind == SyntaxKind.PlusPlusToken ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;

        var leftName = new NameExpressionSyntax(syntaxTree, identifier);
        var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, op.Position, SyntaxFacts.GetText(baseOpKind), null);
        var oneToken = new SyntaxToken(syntaxTree, SyntaxKind.NumberToken, op.Position, "1", 1);
        var oneLiteral = new LiteralExpressionSyntax(syntaxTree, oneToken, 1);
        var binary = new BinaryExpressionSyntax(syntaxTree, leftName, baseOpToken, oneLiteral);
        var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, op.Position, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);
        var assignment = new AssignmentExpressionSyntax(syntaxTree, identifier, equalsToken, binary);
        return new ExpressionStatementSyntax(syntaxTree, assignment);
    }

    /// <summary>
    /// ADR-0126 / issue #1027: desugars a prefix (<c>++x</c> / <c>--x</c>) or
    /// postfix (<c>x++</c> / <c>x--</c>) increment/decrement <em>expression</em>
    /// into existing value-producing assignment syntax, mirroring the
    /// statement-level desugar in <see cref="ParseIncrementDecrementStatement"/>
    /// and the compound-assignment desugar in
    /// <see cref="ParseAssignmentExpression"/>.
    /// <para>
    /// The write reuses the read-modify-write nodes that already yield the
    /// mutated (new) value: a bare variable lowers to
    /// <c>operand = operand ± 1</c>, an array element / indexer lowers to the
    /// single-evaluating <see cref="CompoundIndexAssignmentExpressionSyntax"/>
    /// (<c>operand ±= 1</c>), and a field lowers to a
    /// <see cref="MemberFieldAssignmentExpressionSyntax"/>.
    /// </para>
    /// <para>
    /// A <em>prefix</em> form yields that new value directly. A <em>postfix</em>
    /// form must yield the value <em>before</em> mutation, so it wraps the write
    /// in <c>(write) ∓ 1</c> — exact for the integer operand types G# accepts
    /// for <c>++</c>/<c>--</c> (the literal <c>1</c> is <c>int32</c>; floating
    /// point operands are rejected by the binder, so no rounding gap exists).
    /// </para>
    /// </summary>
    /// <param name="operand">The already-parsed lvalue operand.</param>
    /// <param name="op">The <c>++</c> or <c>--</c> operator token.</param>
    /// <param name="isPrefix"><see langword="true"/> for the prefix form.</param>
    /// <returns>The desugared value-producing expression.</returns>
    private ExpressionSyntax BuildIncrementDecrementExpression(ExpressionSyntax operand, SyntaxToken op, bool isPrefix)
    {
        var isIncrement = op.Kind == SyntaxKind.PlusPlusToken;
        var baseOpKind = isIncrement ? SyntaxKind.PlusToken : SyntaxKind.MinusToken;
        var inverseOpKind = isIncrement ? SyntaxKind.MinusToken : SyntaxKind.PlusToken;
        var compoundOpKind = isIncrement ? SyntaxKind.PlusEqualsToken : SyntaxKind.MinusEqualsToken;
        var pos = op.Position;

        LiteralExpressionSyntax OneLiteral() =>
            new LiteralExpressionSyntax(syntaxTree, new SyntaxToken(syntaxTree, SyntaxKind.NumberToken, pos, "1", 1), 1);

        ExpressionSyntax write;
        if (TryLiftTrailingIndexer(operand, out var indexed))
        {
            // Array element / indexer: route through the single-evaluating
            // compound-index assignment so the receiver chain is computed once.
            var compoundToken = new SyntaxToken(syntaxTree, compoundOpKind, pos, SyntaxFacts.GetText(compoundOpKind), null);
            write = new CompoundIndexAssignmentExpressionSyntax(syntaxTree, indexed, compoundToken, OneLiteral());
        }
        else
        {
            var baseOpToken = new SyntaxToken(syntaxTree, baseOpKind, pos, SyntaxFacts.GetText(baseOpKind), null);
            var newValue = new BinaryExpressionSyntax(syntaxTree, operand, baseOpToken, OneLiteral());
            var equalsToken = new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, pos, SyntaxFacts.GetText(SyntaxKind.EqualsToken), null);

            if (operand is NameExpressionSyntax name)
            {
                write = new AssignmentExpressionSyntax(syntaxTree, name.IdentifierToken, equalsToken, newValue);
            }
            else if (TryLiftTrailingMemberAccess(operand, out var receiver, out var dotToken, out var fieldIdentifier))
            {
                // Prefer the simple `id.field = value` form when the receiver is
                // a bare name: it binds through the field-assignment path that
                // correctly takes the address of a struct-local receiver in
                // value position (the chained member form copies a value-type
                // receiver by value, which would drop the mutation).
                write = receiver is NameExpressionSyntax simpleReceiver
                    ? new FieldAssignmentExpressionSyntax(syntaxTree, simpleReceiver.IdentifierToken, dotToken, fieldIdentifier, equalsToken, newValue)
                    : new MemberFieldAssignmentExpressionSyntax(syntaxTree, receiver, dotToken, fieldIdentifier, equalsToken, newValue);
            }
            else
            {
                Diagnostics.ReportInvalidIncrementDecrementTarget(operand.Location, op.Text);
                return operand;
            }
        }

        if (isPrefix)
        {
            return write;
        }

        // Postfix yields the value before mutation: (write) ∓ 1.
        var inverseOpToken = new SyntaxToken(syntaxTree, inverseOpKind, pos, SyntaxFacts.GetText(inverseOpKind), null);
        return new BinaryExpressionSyntax(syntaxTree, write, inverseOpToken, OneLiteral());
    }

    private bool LooksLikeMultiAssignment()
    {
        // Pattern: ident, ident (, ident)* (= | :=) ...
        if (Current.Kind != SyntaxKind.IdentifierToken ||
            Peek(1).Kind != SyntaxKind.CommaToken)
        {
            return false;
        }

        int i = 2;
        while (i < 256)
        {
            if (Peek(i).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            var next = Peek(i + 1).Kind;
            if (next == SyntaxKind.CommaToken)
            {
                i += 2;
                continue;
            }

            return next == SyntaxKind.EqualsToken || next == SyntaxKind.ColonEqualsToken;
        }

        return false;
    }

    private StatementSyntax ParseMultiAssignmentStatement()
    {
        var targets = ParseMultiTargetList();
        SyntaxToken op;
        if (Current.Kind == SyntaxKind.ColonEqualsToken)
        {
            // ADR-0077 / issue #717: the legacy multi-target short variable-
            // declaration `a, b := e1, e2` is removed. Emit GS0305 and recover
            // by treating the operator as `=`; the binder still routes through
            // BindMultiAssignmentStatement and reports any follow-on errors
            // (e.g. undeclared targets) without spurious cascades.
            var colonEquals = MatchToken(SyntaxKind.ColonEqualsToken);
            var targetSnippet = BuildMultiTargetSnippet(targets);
            Diagnostics.ReportColonEqualsRemoved(
                colonEquals.Location,
                $"var {targetSnippet[0]} = …  // one declaration per identifier");
            op = SynthesiseEqualsToken(colonEquals);
        }
        else
        {
            op = MatchToken(SyntaxKind.EqualsToken);
        }

        var values = ParseMultiValueList();
        return new MultiAssignmentStatementSyntax(syntaxTree, targets, op, values);
    }

    private static string[] BuildMultiTargetSnippet(SeparatedSyntaxList<ExpressionSyntax> targets)
    {
        var names = new string[Math.Max(1, targets.Count)];
        for (var i = 0; i < targets.Count; i++)
        {
            if (targets[i] is NameExpressionSyntax name)
            {
                names[i] = name.IdentifierToken.Text;
            }
            else
            {
                names[i] = "x";
            }
        }

        return names;
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseMultiTargetList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            nodesAndSeparators.Add(new NameExpressionSyntax(syntaxTree, identifier));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                continue;
            }

            break;
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseMultiValueList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            nodesAndSeparators.Add(ParseExpression());

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                continue;
            }

            break;
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    private StatementSyntax ParseVariableDeclaration()
    {
        return ParseVariableDeclaration(accessibilityModifier: null);
    }

    private StatementSyntax ParseVariableDeclaration(SyntaxToken accessibilityModifier)
    {
        SyntaxKind expected;
        switch (Current.Kind)
        {
            case SyntaxKind.ConstKeyword:
                expected = SyntaxKind.ConstKeyword;
                break;
            case SyntaxKind.LetKeyword:
                expected = SyntaxKind.LetKeyword;
                break;
            default:
                expected = SyntaxKind.VarKeyword;
                break;
        }

        var keyword = MatchToken(expected);

        // Phase 4.5: `let (a, b, ...) = expr` deconstructs a tuple-typed
        // initializer. The opening paren must come *directly* after the
        // keyword: an explicit type clause or identifier always starts with
        // an identifier, so this is unambiguous.
        if (expected == SyntaxKind.LetKeyword && Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
            nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken));
            while (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken));
            }

            var idents = new SeparatedSyntaxList<SyntaxToken>(nodesAndSeparators.ToImmutable());
            var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            var equalsTok = MatchToken(SyntaxKind.EqualsToken);
            var init = ParseExpression();
            return new TupleDeconstructionStatementSyntax(syntaxTree, keyword, openParen, idents, closeParen, equalsTok, init);
        }

        if (expected == SyntaxKind.LetKeyword && Current.Kind == SyntaxKind.OpenBraceToken)
        {
            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var fields = ParseNamedDeconstructionFields();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            var equalsTok = MatchToken(SyntaxKind.EqualsToken);
            var init = ParseExpression();
            return new NamedDeconstructionStatementSyntax(syntaxTree, keyword, openBrace, fields, closeBrace, equalsTok, init);
        }

        // ADR-0058 / issue #376: optional `scoped` contextual modifier between the
        // keyword and the identifier. Disambiguate: `scoped` is only a modifier when
        // followed by another identifier (the variable name).
        SyntaxToken scopedModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            scopedModifier = NextToken();
        }

        // Issue #491 (ADR-0060 follow-up): optional `ref` contextual modifier on
        // `let`/`var` declarations introduces a ref-aliasing local
        // (`let ref m = lvalue` / `var ref m = lvalue`). Disambiguate: `ref` is
        // only a modifier when followed by another identifier (the variable
        // name). If `ref` IS the variable name (no following identifier), treat
        // it as the identifier itself. Rejected on `const` after binding.
        SyntaxToken refKindModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            refKindModifier = NextToken();
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #1886: `let Name[T] = func (...) ... { ... }` attaches a generic
        // type-parameter list to a let-bound function literal, since the literal
        // itself (being anonymous) has nowhere to carry one. Only meaningful on
        // `let` bindings; `var`/`const` simply never see a `[` here in practice.
        var typeParameterList = ParseOptionalTypeParameterList();
        var typeClause = ParseOptionalTypeClause();

        // A `var` declaration may omit its initializer when an explicit type
        // clause is present (e.g. `var x int32`), in which case the variable
        // takes that type's default value. `let`/`const` remain immutable, so
        // an initializer stays mandatory for them; and without a type clause
        // there is nothing to infer from, so an initializer is still required.
        // Issue #491: a ref-aliasing local always requires an initializer (it
        // must alias an lvalue) — fall through to MatchToken below if absent.
        if (expected == SyntaxKind.VarKeyword
            && refKindModifier == null
            && typeClause != null
            && Current.Kind != SyntaxKind.EqualsToken)
        {
            var decl = new VariableDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                keyword,
                identifier,
                typeClause,
                equalsToken: null,
                initializer: null);
            decl.ScopedModifier = scopedModifier;
            decl.TypeParameterList = typeParameterList;
            return decl;
        }

        var equals = MatchToken(SyntaxKind.EqualsToken);
        var initializer = ParseExpression();
        var result = new VariableDeclarationSyntax(syntaxTree, accessibilityModifier, keyword, identifier, typeClause, equals, initializer);
        result.ScopedModifier = scopedModifier;
        result.RefKindModifier = refKindModifier;
        result.TypeParameterList = typeParameterList;
        return result;
    }

    private SeparatedSyntaxList<NamedDeconstructionFieldSyntax> ParseNamedDeconstructionFields()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var field = MatchToken(SyntaxKind.IdentifierToken);
            var equals = MatchToken(SyntaxKind.EqualsToken);
            var local = MatchToken(SyntaxKind.IdentifierToken);
            nodesAndSeparators.Add(new NamedDeconstructionFieldSyntax(syntaxTree, field, equals, local));
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<NamedDeconstructionFieldSyntax>(nodesAndSeparators.ToImmutable());
    }

    private StatementSyntax ParseIfStatement()
    {
        var keyword = MatchToken(SyntaxKind.IfKeyword);

        StatementSyntax initializer = null;
        SyntaxToken semicolon = null;
        if (HasIfInitClause())
        {
            initializer = ParseSimpleStatement();
            semicolon = MatchToken(SyntaxKind.SemicolonToken);
        }

        var condition = ParseExpressionInBodyHeader();
        var statement = ParseStatement();
        var elseClause = ParseElseClause();
        return new IfStatementSyntax(syntaxTree, keyword, initializer, semicolon, condition, statement, elseClause);
    }

    private bool HasIfInitClause()
    {
        // Mirrors LooksLikeForClause: scan ahead from the position
        // after `if` looking for a depth-zero semicolon before the
        // opening brace of the then-block.
        int depth = 0;
        for (int i = 0; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.SemicolonToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private ElseClauseSyntax ParseElseClause()
    {
        if (Current.Kind != SyntaxKind.ElseKeyword)
        {
            return null;
        }

        var keyword = NextToken();
        var statement = ParseStatement();
        return new ElseClauseSyntax(syntaxTree, keyword, statement);
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    // ──────────────────────────────────────────────────────────────────────
    private IfLetStatementSyntax ParseIfLetStatement()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        var bindings = ParseIfLetBindingList();
        var thenStatement = ParseStatement();
        var elseClause = ParseElseClause();
        return new IfLetStatementSyntax(syntaxTree, ifKeyword, bindings, thenStatement, elseClause);
    }

    private GuardLetStatementSyntax ParseGuardLetStatement()
    {
        var guardKeyword = MatchToken(SyntaxKind.GuardKeyword);
        var bindings = ParseIfLetBindingList();
        var elseKeyword = MatchToken(SyntaxKind.ElseKeyword);
        var elseStatement = ParseStatement();
        return new GuardLetStatementSyntax(syntaxTree, guardKeyword, bindings, elseKeyword, elseStatement);
    }

    private SeparatedSyntaxList<IfLetBindingClauseSyntax> ParseIfLetBindingList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (true)
        {
            nodesAndSeparators.Add(ParseIfLetBindingClause());
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

    private IfLetBindingClauseSyntax ParseIfLetBindingClause()
    {
        var letKeyword = MatchToken(SyntaxKind.LetKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseOptionalTypeClauseBeforeEquals();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress both trailing object initializers (`Foo() { X = 1 }`) AND
        // bare struct literals (`Ident { }`) so the enclosing `{` is the body
        // of the `if let` / `guard let`, not the initializer's shape.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax initializer;
        try
        {
            initializer = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        return new IfLetBindingClauseSyntax(syntaxTree, letKeyword, identifier, typeClause, equalsToken, initializer);
    }

    private TypeClauseSyntax ParseOptionalTypeClauseBeforeEquals()
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

    private StatementSyntax ParseForStatement()
    {
        if (Peek(1).Kind == SyntaxKind.OpenBraceToken)
        {
            return ParseForInfiniteStatement();
        }

        // Issue #1922: `for (a, b, ...) in coll { ... }` — checked before
        // `LooksLikeForRange` (which requires an identifier right after
        // `for`, so it never matches here) and before `LooksLikeForClause`
        // (whose plain semicolon scan would otherwise misparse the `(a, b)`
        // header as a parenthesized C-style-for expression).
        if (LooksLikeForTupleRange())
        {
            return ParseForTupleRangeStatement();
        }

        if (LooksLikeForRange())
        {
            return ParseForRangeStatement();
        }

        if (LooksLikeForEllipsis())
        {
            return ParseForEllipsisStatement();
        }

        if (LooksLikeForClause())
        {
            return ParseForClauseStatement();
        }

        return ParseForConditionStatement();
    }

    private bool LooksLikeForTupleRange()
    {
        // `for ( <ident> (, <ident>)+ ) in <expr> { ... }` — at least two
        // identifiers (arity ≥ 2, matching TupleTypeSymbol's minimum) so this
        // never collides with a parenthesized boolean condition such as
        // `for (x > 0) { ... }` (no comma) or a single-name grouped
        // expression `for (x) in xs { ... }` isn't legal G# anyway, but the
        // 2+ identifier requirement keeps this check unambiguous and cheap.
        if (Peek(1).Kind != SyntaxKind.OpenParenthesisToken || Peek(2).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        int o = 3;
        var sawComma = false;
        while (Peek(o).Kind == SyntaxKind.CommaToken && Peek(o + 1).Kind == SyntaxKind.IdentifierToken)
        {
            sawComma = true;
            o += 2;
        }

        if (!sawComma || Peek(o).Kind != SyntaxKind.CloseParenthesisToken)
        {
            return false;
        }

        return Peek(o + 1).Kind == SyntaxKind.IdentifierToken && Peek(o + 1).Text == "in";
    }

    private StatementSyntax ParseForTupleRangeStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken));
        while (Current.Kind == SyntaxKind.CommaToken)
        {
            nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            nodesAndSeparators.Add(MatchToken(SyntaxKind.IdentifierToken));
        }

        var identifiers = new SeparatedSyntaxList<SyntaxToken>(nodesAndSeparators.ToImmutable());
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        var inToken = MatchToken(SyntaxKind.IdentifierToken); // contextual `in`, guarded by LooksLikeForTupleRange
        var collection = ParseExpressionInBodyHeader(allowEmptyStructLiteralCollection: true);
        var body = ParseStatement();
        return new ForTupleRangeStatementSyntax(syntaxTree, keyword, openParen, identifiers, closeParen, inToken, collection, body);
    }

    private bool LooksLikeForRange()
    {
        // `for <ident> := range <expr> { ... }`
        // `for <ident>, <ident> := range <expr> { ... }`
        // `for <ident> in <expr> { ... }`
        // `for <ident>, <ident> in <expr> { ... }`
        //
        // NB: `for <ident> in <lo> ... <hi> { ... }` is the integer-range
        // (ellipsis) form (ADR-0077). The shared `in` token means we must
        // peek past the collection / lower-bound expression to see whether
        // an ellipsis follows — if so, this is *not* the range form.
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        int o = 2;
        bool hasCommaSecondId = false;
        if (Peek(o).Kind == SyntaxKind.CommaToken)
        {
            if (Peek(o + 1).Kind != SyntaxKind.IdentifierToken)
            {
                return false;
            }

            hasCommaSecondId = true;
            o += 2;
        }

        if (Peek(o).Kind == SyntaxKind.IdentifierToken && Peek(o).Text == "in")
        {
            // A `k, v in dict` form never collides with the ellipsis form
            // (ellipsis is single-identifier only) — accept immediately.
            if (hasCommaSecondId)
            {
                return true;
            }

            // Single-identifier `in`: distinguish from `for i in lo ... hi`
            // by scanning ahead for an ellipsis at depth zero before the
            // body's open brace.
            return !HasEllipsisBeforeBrace(o + 1);
        }

        if (Peek(o).Kind != SyntaxKind.ColonEqualsToken)
        {
            return false;
        }

        return Peek(o + 1).Kind == SyntaxKind.RangeKeyword;
    }

    private bool HasEllipsisBeforeBrace(int startOffset)
    {
        int depth = 0;
        for (int i = startOffset; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.EllipsisToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.SemicolonToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private bool LooksLikeForEllipsis()
    {
        // Canonical: `for <ident> in <expr> ... <expr> { ... }`
        // Legacy (removed by ADR-0077 / issue #717, but still recognised by
        // the parser so it can emit GS0305 instead of a parse cascade):
        //   `for <ident> := <expr> ... <expr> { ... }`
        if (Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var separator = Peek(2);
        var hasSeparator = separator.Kind == SyntaxKind.ColonEqualsToken
            || (separator.Kind == SyntaxKind.IdentifierToken && separator.Text == "in");
        if (!hasSeparator)
        {
            return false;
        }

        int depth = 0;
        for (int i = 3; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.EllipsisToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.SemicolonToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private bool LooksLikeForClause()
    {
        // `for [init]; [cond]; [post] { ... }` — a semicolon at depth zero
        // before the opening brace marks the C-style clause form.
        if (Peek(1).Kind == SyntaxKind.SemicolonToken)
        {
            return true;
        }

        int depth = 0;
        for (int i = 1; i < 256; i++)
        {
            var k = Peek(i).Kind;
            if (depth == 0)
            {
                if (k == SyntaxKind.SemicolonToken)
                {
                    return true;
                }

                if (k == SyntaxKind.OpenBraceToken ||
                    k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }
            }

            if (k == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (k == SyntaxKind.CloseParenthesisToken && depth > 0)
            {
                depth--;
            }
        }

        return false;
    }

    private StatementSyntax ParseForConditionStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var condition = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForConditionStatementSyntax(syntaxTree, keyword, condition, body);
    }

    private StatementSyntax ParseForClauseStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);

        StatementSyntax initializer = null;
        if (Current.Kind != SyntaxKind.SemicolonToken)
        {
            initializer = ParseSimpleStatement();
        }

        var firstSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        ExpressionSyntax condition = null;
        if (Current.Kind != SyntaxKind.SemicolonToken)
        {
            condition = ParseExpressionInBodyHeader();
        }

        var secondSemicolon = MatchToken(SyntaxKind.SemicolonToken);

        StatementSyntax post = null;
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            // Issue #1023: the post statement sits immediately before the body
            // `{`. Suppress trailing object-initializer wrapping so an indexer-
            // or call-tailed post (`s += arr[s] { … }`) does not consume the
            // loop body's opening brace as a composite literal.
            suppressTrailingObjectInitializer++;
            try
            {
                post = ParseSimpleStatement();
            }
            finally
            {
                suppressTrailingObjectInitializer--;
            }
        }

        var body = ParseStatement();
        return new ForClauseStatementSyntax(syntaxTree, keyword, initializer, firstSemicolon, condition, secondSemicolon, post, body);
    }

    private StatementSyntax ParseSimpleStatement()
    {
        // A "simple statement" in the for-header / if-init context is one of:
        //   variable declaration      `var x = expr` / `let x = expr` (ADR-0077)
        //   legacy short var decl     `x := expr`    — GS0305, removed
        //   increment/decrement       `x++` / `x--`
        //   assignment                `x = expr`, `x += expr`, ...
        //   expression statement      `f()`
        if (Current.Kind == SyntaxKind.VarKeyword || Current.Kind == SyntaxKind.LetKeyword)
        {
            return ParseVariableDeclaration();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken &&
            Peek(1).Kind == SyntaxKind.ColonEqualsToken)
        {
            return ParseSingleShortVariableDeclaration();
        }

        if (Current.Kind == SyntaxKind.IdentifierToken &&
            (Peek(1).Kind == SyntaxKind.PlusPlusToken || Peek(1).Kind == SyntaxKind.MinusMinusToken))
        {
            return ParseIncrementDecrementStatement();
        }

        return ParseExpressionStatement();
    }

    private StatementSyntax ParseForInfiniteStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var body = ParseStatement();
        return new ForInfiniteStatementSyntax(syntaxTree, keyword, body);
    }

    private StatementSyntax ParseForRangeStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var firstIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken commaToken = null;
        SyntaxToken secondIdentifier = null;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            commaToken = MatchToken(SyntaxKind.CommaToken);
            secondIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        }

        SyntaxToken colonEqualsToken = null;
        SyntaxToken rangeKeyword = null;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            inToken = NextToken();
        }
        else
        {
            // ADR-0077 / issue #717: `for v := range coll` (and its `for k, v :=
            // range dict` sibling) is removed. The canonical `for v in coll`
            // form already exists (ADR-0031); emit GS0305 and recover by
            // synthesising an `in` token so binding still produces a
            // `BoundForRangeStatement` and downstream diagnostics are clean.
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            rangeKeyword = MatchToken(SyntaxKind.RangeKeyword);
            var snippet = secondIdentifier == null
                ? $"for {firstIdentifier.Text} in …"
                : $"for {firstIdentifier.Text}, {secondIdentifier.Text} in …";
            Diagnostics.ReportColonEqualsRemoved(colonEqualsToken.Location, snippet);
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", null);
            colonEqualsToken = null;
            rangeKeyword = null;
        }

        var collection = ParseExpressionInBodyHeader(allowEmptyStructLiteralCollection: true);
        var body = ParseStatement();
        return new ForRangeStatementSyntax(syntaxTree, keyword, firstIdentifier, commaToken, secondIdentifier, colonEqualsToken, rangeKeyword, inToken, collection, body);
    }

    private StatementSyntax ParseForEllipsisStatement()
    {
        var keyword = MatchToken(SyntaxKind.ForKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken colonEqualsToken;
        SyntaxToken inToken = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "in")
        {
            // ADR-0077 / issue #717: `for i in lo ... hi` is the canonical
            // integer-range form. The legacy `:=` spelling is removed below.
            inToken = NextToken();
            colonEqualsToken = null;
        }
        else
        {
            colonEqualsToken = MatchToken(SyntaxKind.ColonEqualsToken);
            Diagnostics.ReportColonEqualsRemoved(
                colonEqualsToken.Location,
                $"for {identifier.Text} in lo ... hi");
            inToken = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, colonEqualsToken.Position, "in", null);
        }

        var lowerBound = ParseExpressionInBodyHeader();
        var toKeyword = MatchToken(SyntaxKind.EllipsisToken);
        var upperBound = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new ForEllipsisStatementSyntax(syntaxTree, keyword, identifier, inToken, lowerBound, toKeyword, upperBound, body);
    }

    private StatementSyntax ParseBreakStatement()
    {
        var keyword = MatchToken(SyntaxKind.BreakKeyword);
        var label = TryParseLoopTargetLabel(keyword);
        return new BreakStatementSyntax(syntaxTree, keyword, label);
    }

    private StatementSyntax ParseContinueStatement()
    {
        var keyword = MatchToken(SyntaxKind.ContinueKeyword);
        var label = TryParseLoopTargetLabel(keyword);
        return new ContinueStatementSyntax(syntaxTree, keyword, label);
    }

    private StatementSyntax ParseGotoStatement()
    {
        // Issue #1884: `goto label` — an unconditional jump to a `label:`
        // statement elsewhere in the enclosing function. The target
        // identifier is mandatory (unlike the optional labeled
        // `break`/`continue` target), so no same-line restriction is needed.
        var keyword = MatchToken(SyntaxKind.GotoKeyword);
        var label = MatchToken(SyntaxKind.IdentifierToken);
        return new GotoStatementSyntax(syntaxTree, keyword, label);
    }

    private SyntaxToken TryParseLoopTargetLabel(SyntaxToken keyword)
    {
        // ADR-0070: an optional bare identifier on the same source line names
        // a labeled enclosing loop. Restricting the label to the same line
        // avoids accidentally swallowing the next statement.
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);
        var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);
        if (keywordLine != currentLine)
        {
            return null;
        }

        return NextToken();
    }

    private StatementSyntax ParseLabeledStatement()
    {
        var label = MatchToken(SyntaxKind.IdentifierToken);
        var colon = MatchToken(SyntaxKind.ColonToken);
        var inner = ParseStatement();
        return new LabeledStatementSyntax(syntaxTree, label, colon, inner);
    }

    private StatementSyntax ParseWhileStatement()
    {
        // ADR-0070: `while cond { body }` — same lowering as `for cond { body }`.
        var keyword = MatchToken(SyntaxKind.WhileKeyword);
        var condition = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new WhileStatementSyntax(syntaxTree, keyword, condition, body);
    }

    private StatementSyntax ParseLockStatement()
    {
        // Issue #1885: `lock expr { body }` — mutual exclusion around body,
        // lowered by the binder to the classic Monitor Enter/try/finally/Exit
        // pattern.
        var keyword = MatchToken(SyntaxKind.LockKeyword);
        var expression = ParseExpressionInBodyHeader();
        var body = ParseStatement();
        return new LockStatementSyntax(syntaxTree, keyword, expression, body);
    }

    private StatementSyntax ParseDoWhileStatement()
    {
        // ADR-0070: `do { body } while cond` — post-test loop. The trailing
        // `while` keyword reuses SyntaxKind.WhileKeyword so the lexer is
        // unchanged; the parser disambiguates by remembering it saw `do`.
        var doKeyword = MatchToken(SyntaxKind.DoKeyword);
        var body = ParseStatement();
        var whileKeyword = MatchToken(SyntaxKind.WhileKeyword);
        var condition = ParseExpression();
        return new DoWhileStatementSyntax(syntaxTree, doKeyword, body, whileKeyword, condition);
    }

    private StatementSyntax ParseReturnStatement()
    {
        var keyword = MatchToken(SyntaxKind.ReturnKeyword);
        var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);
        var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);
        var isEof = Current.Kind == SyntaxKind.EndOfFileToken;
        var sameLine = !isEof && keywordLine == currentLine;
        SyntaxToken refKeyword = null;
        ExpressionSyntax expression = null;
        if (sameLine)
        {
            // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier directly
            // following `return` marks this as a ref-return: `return ref <lvalue>`. The
            // modifier is consumed only when an expression-starting token follows on the
            // same line, preserving backward compatibility for `return ref` where `ref` is
            // itself the identifier being returned (the binder rejects `return ref` with
            // no operand on a ref-returning function).
            if (Current.Kind == SyntaxKind.IdentifierToken
                && Current.Text == "ref"
                && CanStartExpression(Peek(1))
                && syntaxTree.Text.GetLineIndex(Peek(1).Span.Start) == keywordLine)
            {
                refKeyword = NextToken();
            }

            expression = ParseExpression();

            // Phase 4.6: multi-return support. `return e1, e2, ...` lowers to
            // returning a tuple literal so callers can deconstruct or bind it
            // through the standard tuple machinery.
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
                nodesAndSeparators.Add(expression);
                var syntheticOpen = new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, keyword.Position, null, null);
                while (Current.Kind == SyntaxKind.CommaToken)
                {
                    nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                    nodesAndSeparators.Add(ParseExpression());
                }

                var syntheticClose = new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, Current.Position, null, null);
                var elements = new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
                expression = new TupleLiteralExpressionSyntax(syntaxTree, syntheticOpen, elements, syntheticClose);
            }
        }

        return new ReturnStatementSyntax(syntaxTree, keyword, refKeyword, expression);
    }

    private StatementSyntax ParseYieldStatement()
    {
        // ADR-0040: `yield <expr>` statement. The `yield` token is a contextual
        // identifier (not a reserved keyword) to preserve source compatibility.
        var yieldToken = MatchToken(SyntaxKind.IdentifierToken);
        var expression = ParseExpression();
        return new YieldStatementSyntax(syntaxTree, yieldToken, expression);
    }

    /// <summary>
    /// Issue #813: lookahead helper for the contextual <c>yield</c> at statement
    /// start. Returns <see langword="true"/> when the token at <paramref name="parenOffset"/>
    /// is a <c>(</c> that opens a value-tuple literal (i.e. its matching
    /// <c>)</c> follows a top-level <c>,</c>). A tuple-literal yield like
    /// <c>yield (a, b)</c> must be parsed as a yield-statement; without this
    /// disambiguation the existing rule rejected every <c>yield (</c> form
    /// because it treats parens as the start of a function-call expression.
    /// </summary>
    private bool LooksLikeYieldTupleLiteral(int parenOffset)
    {
        if (Peek(parenOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var depth = 0;
        var bracketDepth = 0;
        var braceDepth = 0;
        var scanBound = Math.Min(tokens.Length, parenOffset + LookaheadMaxScan);
        for (var i = parenOffset; i < scanBound; i++)
        {
            var t = Peek(i);
            switch (t.Kind)
            {
                case SyntaxKind.OpenParenthesisToken:
                    depth++;
                    break;
                case SyntaxKind.CloseParenthesisToken:
                    depth--;
                    if (depth == 0)
                    {
                        return false;
                    }

                    break;
                case SyntaxKind.OpenSquareBracketToken:
                    bracketDepth++;
                    break;
                case SyntaxKind.CloseSquareBracketToken:
                    bracketDepth--;
                    break;
                case SyntaxKind.OpenBraceToken:
                    braceDepth++;
                    break;
                case SyntaxKind.CloseBraceToken:
                    braceDepth--;
                    break;
                case SyntaxKind.CommaToken:
                    if (depth == 1 && bracketDepth == 0 && braceDepth == 0)
                    {
                        return true;
                    }

                    break;
                case SyntaxKind.EndOfFileToken:
                    return false;
            }
        }

        return false;
    }
}
