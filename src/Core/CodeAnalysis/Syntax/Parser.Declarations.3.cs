// <copyright file="Parser.Declarations.3.cs" company="GSharp">
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


    private PropertyDeclarationSyntax ParsePropertyDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier)
    {
        var propKeyword = MatchToken(SyntaxKind.IdentifierToken); // consumes "prop"

        // ADR-0118: indexer member — `prop this[<params>] T { get; set }`.
        // The property name is replaced by the contextual `this` keyword
        // followed by a bracketed index-parameter list.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "this"
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            return ParseIndexerDeclaration(accessibilityModifier, openModifier, overrideModifier, propKeyword);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var type = ParseTypeClause();

        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var accessors = ParsePropertyAccessors();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            return new PropertyDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword,
                identifier,
                type,
                openBrace,
                accessors,
                closeBrace);
        }

        if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            // Issue #1278 / ADR-0131: an expression-bodied read-only property
            // `prop Name T -> expr`. Desugar into a single get-only accessor
            // whose body returns the expression (`{ get { return expr } }`).
            var (synthOpenBrace, getAccessor, synthCloseBrace) = SynthesizeArrowGetAccessorList();
            return new PropertyDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword,
                identifier,
                type,
                synthOpenBrace,
                ImmutableArray.Create(getAccessor),
                synthCloseBrace);
        }

        // Bare auto-property: prop Name Type
        return new PropertyDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            propKeyword,
            identifier,
            type,
            openBraceToken: null,
            accessors: ImmutableArray<PropertyAccessorSyntax>.Empty,
            closeBraceToken: null);
    }

    // ADR-0118: parse the indexer member form `prop this[<params>] T { get; set }`.
    // The leading `prop` keyword has already been consumed. The `this` token is
    // current. The resulting PropertyDeclarationSyntax carries IsIndexer = true.
    private PropertyDeclarationSyntax ParseIndexerDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier,
        SyntaxToken propKeyword)
    {
        var thisKeyword = MatchToken(SyntaxKind.IdentifierToken); // consumes "this"
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var parameters = ParseIndexerParameterList();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var type = ParseTypeClause();

        SyntaxToken openBrace = null;
        var accessors = ImmutableArray<PropertyAccessorSyntax>.Empty;
        SyntaxToken closeBrace = null;
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            accessors = ParsePropertyAccessors();
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        }
        else if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            // Issue #1278 / ADR-0131: an expression-bodied read-only indexer
            // `prop this[i T] U -> expr`, desugared into a get-only accessor.
            (openBrace, var getAccessor, closeBrace) = SynthesizeArrowGetAccessorList();
            accessors = ImmutableArray.Create(getAccessor);
        }

        return new PropertyDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            propKeyword,
            identifier: thisKeyword,
            type,
            openBrace,
            accessors,
            closeBrace)
            .WithIndexer(thisKeyword, openBracket, parameters, closeBracket);
    }

    // ADR-0118: parse the bracketed index-parameter list of an indexer member.
    // Mirrors ParseParameterList but terminates at the closing square bracket.
    private SeparatedSyntaxList<ParameterSyntax> ParseIndexerParameterList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextParameter = true;
        while (parseNextParameter &&
               Current.Kind != SyntaxKind.CloseSquareBracketToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var parameter = ParseParameter();
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

    private EventDeclarationSyntax ParseEventDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier)
    {
        var eventKeyword = MatchToken(SyntaxKind.IdentifierToken); // consumes "event"
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var type = ParseTypeClause();

        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var accessors = ParseEventAccessors();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            return new EventDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                eventKeyword,
                identifier,
                type,
                openBrace,
                accessors,
                closeBrace);
        }

        // Field-like event: event Name Type
        return new EventDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            eventKeyword,
            identifier,
            type,
            openBraceToken: null,
            accessors: ImmutableArray<EventAccessorSyntax>.Empty,
            closeBraceToken: null);
    }

    private FieldDeclarationSyntax ParseFieldDeclaration()
    {
        SyntaxToken fieldAccessibility = null;
        if (Current.Kind == SyntaxKind.PublicKeyword ||
            Current.Kind == SyntaxKind.InternalKeyword ||
            Current.Kind == SyntaxKind.PrivateKeyword ||
            Current.Kind == SyntaxKind.ProtectedKeyword)
        {
            fieldAccessibility = NextToken();
        }

        // ADR-0122 §10 / issue #1035: a fixed-size buffer field
        // `fixed name [N]T` inside an (unsafe) struct. `fixed` is a contextual
        // keyword here (it is also the `fixed` pinning statement keyword in a
        // function body — disambiguated by the field position inside a struct
        // body). The element type and count are captured as the `[N]T` array
        // type clause; the field decays to a `*T` to the first element.
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "fixed"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            var fixedKeyword = NextToken();
            var fbIdentifier = MatchToken(SyntaxKind.IdentifierToken);
            var fbType = ParseTypeClause();
            return new FieldDeclarationSyntax(syntaxTree, fieldAccessibility, varOrLetKeyword: null, fbIdentifier, fbType)
                .WithFixedBuffer(fixedKeyword);
        }

        // ADR-0067: field declarations must be introduced with `var` (mutable)
        // or `let` (read-only). Issue #948 adds `const` for compile-time
        // constant fields (implicitly static and read-only). The keyword is
        // captured on the syntax node so the binder can set
        // FieldSymbol.IsReadOnly / IsConst accordingly. If the user omits the
        // keyword, surface a precise diagnostic and try to recover by treating
        // the next identifier as the field name.
        SyntaxToken varOrLetKeyword = null;
        if (Current.Kind == SyntaxKind.VarKeyword
            || Current.Kind == SyntaxKind.LetKeyword
            || Current.Kind == SyntaxKind.ConstKeyword)
        {
            varOrLetKeyword = NextToken();
        }
        else
        {
            Diagnostics.ReportFieldDeclarationRequiresVarOrLet(Current.Location);
        }

        var fieldIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var fieldType = ParseTypeClause();

        // Issue #262: optional initializer for static field declarations.
        SyntaxToken equalsToken = null;
        ExpressionSyntax initializer = null;
        if (Current.Kind == SyntaxKind.EqualsToken)
        {
            equalsToken = NextToken();
            initializer = ParseExpression();
        }

        return new FieldDeclarationSyntax(syntaxTree, fieldAccessibility, varOrLetKeyword, fieldIdentifier, fieldType, equalsToken, initializer);
    }

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier, SyntaxToken openModifier, SyntaxToken overrideModifier, SyntaxToken asyncModifier)
    {
        var functionKeyword = MatchToken(SyntaxKind.FuncKeyword);

        SyntaxToken receiverOpenParen = null;
        ParameterSyntax receiver = null;
        SyntaxToken receiverCloseParen = null;

        // Phase 3.B.6 / ADR-0019: optional Go-style receiver clause
        // `func ( recv RecvType ) Name(...)`. We only consume it when the
        // tokens unambiguously look like a receiver: open paren, identifier,
        // a type clause, close paren, followed by an identifier (the name).
        if (Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeReceiverClause())
        {
            receiverOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            receiver = ParseParameter();
            receiverCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        var identifier = MatchOperatorOrIdentifier(receiver != null, out var isConversionOperator, out var conversionIsExplicit);
        var typeParameterList = ParseOptionalTypeParameterList();
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);

        // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier preceding
        // the return type clause turns this function into a ref-returning function:
        //   func max(ref a int32, ref b int32) ref int32 { return ref (a > b ? a : b) }
        // The keyword is consumed only when followed by a type-starting token, so a
        // top-level function literally named after the `ref` token is unaffected.
        SyntaxToken returnRefModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" && CanStartTypeClause(Peek(1)))
        {
            returnRefModifier = NextToken();
        }

        var type = ParseOptionalTypeClause();

        // ADR-0086 / issue #727: a `;` in place of a `{ ... }` body marks the
        // declaration as a P/Invoke stub (`@DllImport`-annotated function with
        // no managed body). The binder validates that the annotation is
        // present and well-formed; an unannotated `;` body produces GS0325.
        BlockStatementSyntax body;
        SyntaxToken semicolonBody = null;
        if (Current.Kind == SyntaxKind.SemicolonToken)
        {
            semicolonBody = NextToken();
            body = null;
        }
        else if (Current.Kind == SyntaxKind.RightArrowToken)
        {
            // Issue #1278 / ADR-0131: an expression-bodied function/method
            // `func F(...) T -> expr`. Desugar at parse time into an equivalent
            // block body so binding, lowering, async, and emit reuse the
            // existing block-body path. A non-void function (return type
            // present) lowers to `{ return expr }`; a void function (no return
            // type clause) lowers to `{ expr }` (an expression statement),
            // mirroring C#'s expression-bodied void methods. This single path
            // also covers methods, operators (`func operator + ...`), and
            // user-defined conversion operators (`func operator implicit ...`).
            body = ParseArrowExpressionBody(asReturn: type != null);
        }
        else
        {
            body = ParseBlockStatement();
        }

        var decl = new FunctionDeclarationSyntax(syntaxTree, accessibilityModifier, openModifier, overrideModifier, asyncModifier, functionKeyword, receiverOpenParen, receiver, receiverCloseParen, identifier, typeParameterList, openParenthesisToken, parameters, closeParenthesisToken, type, body);
        decl.ReturnRefModifier = returnRefModifier;
        decl.SemicolonBodyToken = semicolonBody;
        decl.IsConversionOperator = isConversionOperator;
        decl.ConversionIsExplicit = conversionIsExplicit;
        return decl;
    }

    private SeparatedSyntaxList<ParameterSyntax> ParseParameterList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextParameter = true;
        while (parseNextParameter &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var parameter = ParseParameter();
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

    private ParameterSyntax ParseParameter()
    {
        // ADR-0047: parameter-level annotations precede the identifier.
        var annotations = ParseAnnotations();

        // ADR-0058 / issue #376: optional `scoped` contextual modifier precedes the identifier.
        // Disambiguate: `scoped` is only a modifier when followed by another identifier (the
        // parameter name). If the current token IS the parameter name (no following identifier),
        // treat it as the identifier, not as a modifier.
        SyntaxToken scopedModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            scopedModifier = NextToken();
        }

        // ADR-0060: optional `ref`/`out`/`in` contextual modifier immediately precedes the
        // parameter identifier (after the optional `scoped`). Disambiguation rule: the
        // modifier is only consumed when the next token is an identifier (the parameter
        // name). If `ref` / `out` / `in` IS the parameter name (no following identifier),
        // treat it as the identifier itself.
        SyntaxToken refKindModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && (Current.Text == "ref" || Current.Text == "out" || Current.Text == "in")
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            refKindModifier = NextToken();
        }

        // ADR-0101 / issue #799: the C# `params` keyword is intentionally NOT
        // part of the G# parameter grammar — the canonical variadic spelling
        // is `name ...T` (Go-style). Detect the C# pattern `params <ident>`
        // and emit a focused diagnostic (GS0363) before recovering by
        // skipping the keyword and continuing to parse the rest as a regular
        // parameter. This stops the user from hitting a cryptic "expected
        // identifier" error and points them at the canonical spelling.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "params"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            var paramsToken = NextToken();
            Diagnostics.ReportParamsKeywordNotSupported(paramsToken.Location);
        }

        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        SyntaxToken ellipsis = null;
        if (Current.Kind == SyntaxKind.EllipsisToken)
        {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken);
        }

        var type = ParseTypeClause();

        // ADR-0063: optional default-value clause. Parsed as a general expression here;
        // the binder enforces the "compile-time constant representable in CLR parameter
        // metadata" rule and emits diagnostics on misuse.
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

    private static bool IsContextualMemberKeyword(string text)
    {
        return text == "event"
            || text == "prop"
            || text == "init"
            || text == "convenience"
            || text == "shared";
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
            return decl;
        }

        var equals = MatchToken(SyntaxKind.EqualsToken);
        var initializer = ParseExpression();
        var result = new VariableDeclarationSyntax(syntaxTree, accessibilityModifier, keyword, identifier, typeClause, equals, initializer);
        result.ScopedModifier = scopedModifier;
        result.RefKindModifier = refKindModifier;
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

    // Issue #479 / ADR-0117: builds the synthetic zero-argument constructor
    // call that backs the no-parentheses collection-initializer spelling
    // (`List[int32]{…}`). The synthetic parentheses are positioned at the end
    // of the type-argument list so the node's span stays monotonic.
    private CallExpressionSyntax SynthesizeEmptyArgConstructorCall(SyntaxToken identifier, TypeArgumentListSyntax typeArguments)
    {
        var position = typeArguments.CloseBracketToken.Span.End;
        var openParen = new SyntaxToken(syntaxTree, SyntaxKind.OpenParenthesisToken, position, "(", null);
        var closeParen = new SyntaxToken(syntaxTree, SyntaxKind.CloseParenthesisToken, position, ")", null);
        var emptyArguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        return new CallExpressionSyntax(syntaxTree, identifier, typeArguments, openParen, emptyArguments, closeParen);
    }

    /// <summary>
    /// ADR-0091 / issue #757: parses an explicit-base interface call
    /// <c>base[IFoo].Method(args)</c>. Commit is decided by the caller in
    /// <see cref="ParsePrimaryExpression"/> when the current identifier is
    /// the contextual <c>base</c> keyword and the next token is <c>[</c>.
    /// The optional generic type-argument list on the method identifier is
    /// parsed but is rejected by the binder in this PR (reserved for a
    /// future explicit-base generic-method extension).
    /// </summary>
    private ExpressionSyntax ParseBaseInterfaceCallExpression()
    {
        // Consume the `base` identifier token. We synthesize a fresh token to
        // make sure the kind stays IdentifierToken (avoiding any keyword
        // re-classification down the line).
        var baseKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var interfaceTypeClause = ParseTypeClause();
        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var dot = MatchToken(SyntaxKind.DotToken);
        var methodIdentifier = MatchToken(SyntaxKind.IdentifierToken);

        TypeArgumentListSyntax methodTypeArgumentList = null;
        if (Current.Kind == SyntaxKind.OpenSquareBracketToken && LooksLikeGenericCallSite(0))
        {
            methodTypeArgumentList = ParseTypeArgumentList();
        }

        // Issue #1104: the parenthesis-less PROPERTY form `base[BaseClass].Prop`
        // (no `(args)` follows the member). This mirrors plain `base.Prop` but
        // with an explicit ancestor selector. The optional `= value` write tail
        // is attached later by ParseAssignmentExpression. A `[` generic-method
        // argument list is only valid on the call form, so reject it here by
        // still requiring it to be followed by `(`.
        if (methodTypeArgumentList == null && Current.Kind != SyntaxKind.OpenParenthesisToken)
        {
            return new BaseInterfaceCallExpressionSyntax(
                syntaxTree,
                baseKeyword,
                openBracket,
                interfaceTypeClause,
                closeBracket,
                dot,
                methodIdentifier,
                equalsToken: null,
                value: null);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new BaseInterfaceCallExpressionSyntax(
            syntaxTree,
            baseKeyword,
            openBracket,
            interfaceTypeClause,
            closeBracket,
            dot,
            methodIdentifier,
            methodTypeArgumentList,
            openParen,
            arguments,
            closeParen);
    }

    // Issue #1294: disambiguate a function LITERAL `func (params) ...` from a
    // RECEIVER-form method DECLARATION `func (recv Type) Name(...)` that happens
    // to follow a call's closing `)` (e.g. an expression-bodied member from
    // issue #1278 whose arrow body ends in a call). Both begin `func (`, so the
    // single-token lookahead used by the trailing-lambda heuristic cannot tell
    // them apart. This scans the balanced parens immediately after the `func`
    // keyword (whose offset relative to <see cref="Current"/> is
    // <paramref name="funcOffset"/>) and reports whether the token after the
    // matching `)` is an identifier followed by its own `(` — the method-name +
    // parameter-list shape unique to a receiver-form declaration. A function
    // literal's parameter `)` is instead followed by `{` (a body) or a
    // return-type clause that opens with a type token, never an
    // `Identifier (` pair, so this never misclassifies a genuine trailing
    // lambda.
    private bool LooksLikeReceiverMethodDeclaration(int funcOffset)
    {
        var openParenOffset = funcOffset + 1;
        if (Peek(openParenOffset).Kind != SyntaxKind.OpenParenthesisToken)
        {
            return false;
        }

        var depth = 0;
        for (var i = openParenOffset; ; i++)
        {
            var kind = Peek(i).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (kind == SyntaxKind.OpenParenthesisToken)
            {
                depth++;
            }
            else if (kind == SyntaxKind.CloseParenthesisToken)
            {
                depth--;
                if (depth == 0)
                {
                    // After the receiver clause a method declaration continues
                    // with its name followed by either a value-parameter list
                    // `Name(` or a type-parameter list `Name[` (generic method).
                    return Peek(i + 1).Kind == SyntaxKind.IdentifierToken
                        && (Peek(i + 2).Kind == SyntaxKind.OpenParenthesisToken
                            || Peek(i + 2).Kind == SyntaxKind.OpenSquareBracketToken);
                }
            }
        }
    }

    private bool IsStructLiteralFollowingBrace(int braceOffsetPlusOne)
    {
        // braceOffsetPlusOne is the offset of the token AFTER the '{'. A struct
        // literal is either empty (`}`) or starts with `Identifier :` (a field init).
        var k0 = Peek(braceOffsetPlusOne).Kind;
        if (k0 == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        if (k0 == SyntaxKind.IdentifierToken && Peek(braceOffsetPlusOne + 1).Kind == SyntaxKind.ColonToken)
        {
            return true;
        }

        return false;
    }

    private ExpressionSyntax ParseStructLiteralExpression()
    {
        var typeIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var initializers = ParseStructLiteralInitializers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new StructLiteralExpressionSyntax(syntaxTree, typeIdentifier, openBrace, initializers, closeBrace);
    }
}
