// <copyright file="Parser.Expressions.Creation.cs" company="GSharp">
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
    private ExpressionSyntax ParseMapCreationExpression()
    {
        // ADR-0104: map literal `map[K,V]{k1: v1, k2: v2, …}`.
        var typeClause = ParseMapTypeClause();
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var entries = ParseMapEntries();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new MapCreationExpressionSyntax(syntaxTree, typeClause, openBrace, entries, closeBrace);
    }

    private SeparatedSyntaxList<MapEntrySyntax> ParseMapEntries()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var key = ParseExpression();
            var colon = MatchToken(SyntaxKind.ColonToken);
            var value = ParseExpression();
            nodesAndSeparators.Add(new MapEntrySyntax(syntaxTree, key, colon, value));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<MapEntrySyntax>(nodesAndSeparators.ToImmutable());
    }

    // ADR-0146 (Kotlin visibility narrowing follow-up): the same lead-in check as
    // IsAnonymousClassLiteralStart(), but probed one token past the current
    // position — used right after consuming a `->` arrow (Current is already the
    // token following the arrow) to decide whether an omitted return-type
    // expression-bodied function/method is a value-returning anonymous-class
    // literal rather than the ordinary void expression-statement shape.
    private bool IsAnonymousClassLiteralStartAfterArrow() => IsAnonymousClassLiteralStart(baseOffset: 1);

    private bool IsAnonymousClassLiteralStart() => IsAnonymousClassLiteralStart(baseOffset: 0);

    private bool IsAnonymousClassLiteralStart(int baseOffset)
    {
        // Detects the lead-in of an anonymous-object literal in any of its
        // redesigned shapes (ADR-0146 / issue #2243):
        //   object {            object : Type            (plain / inheriting)
        //   data object {       data object : Type       (data variant)
        // `data` and `object` are contextual identifiers, so this recognition
        // is intentionally narrow — every other position keeps parsing as
        // before.
        var offset = baseOffset;
        if (Peek(baseOffset).Kind == SyntaxKind.IdentifierToken && Peek(baseOffset).Text == "data"
            && Peek(baseOffset + 1).Kind == SyntaxKind.IdentifierToken && Peek(baseOffset + 1).Text == "object")
        {
            offset = baseOffset + 1;
        }

        if (!(Peek(offset).Kind == SyntaxKind.IdentifierToken && Peek(offset).Text == "object"))
        {
            return false;
        }

        var afterObject = Peek(offset + 1).Kind;
        return afterObject == SyntaxKind.OpenBraceToken || afterObject == SyntaxKind.ColonToken;
    }

    private ExpressionSyntax ParseAnonymousClassExpression()
    {
        // ADR-0146 / issue #2243: the redesigned, Kotlin-flavoured
        // anonymous-object literal. Grammar:
        //   [data] object [: Base[(args)] [, IFace...]] {
        //       <member>            (newline / semicolon separated)
        //       ...
        //   }
        // where <member> is one of:
        //   let/var Name [Type] = expr        (field; type optional/inferred)
        //   [open] [override] func Name(...)  (method)
        //   event Name Type                   (event)
        // `init`/`deinit` members are rejected with GS0485.
        SyntaxToken dataKeyword = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data")
        {
            dataKeyword = NextToken();
        }

        var objectKeyword = NextToken();

        // Optional base/interface clause `: Base[(args)] [, IFace, ...]`,
        // parsed exactly like a class declaration's base clause.
        SyntaxToken baseColon = null;
        TypeClauseSyntax baseTypeClause = null;
        SyntaxToken baseCtorOpenParen = null;
        var baseCtorArguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        SyntaxToken baseCtorCloseParen = null;
        var additionalBaseNodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            baseColon = MatchToken(SyntaxKind.ColonToken);
            baseTypeClause = ParseTypeClause();

            if (Current.Kind == SyntaxKind.OpenParenthesisToken)
            {
                baseCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                baseCtorArguments = ParseArguments();
                baseCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            }

            while (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                additionalBaseNodesAndSeparators.Add(comma);
                additionalBaseNodesAndSeparators.Add(ParseTypeClause());
            }
        }

        var additionalBaseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(additionalBaseNodesAndSeparators.ToImmutable());

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var members = ParseAnonymousClassMembers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new AnonymousClassExpressionSyntax(
            syntaxTree,
            dataKeyword,
            objectKeyword,
            baseColon,
            baseTypeClause,
            baseCtorOpenParen,
            baseCtorArguments,
            baseCtorCloseParen,
            additionalBaseTypeClauses,
            openBrace,
            members,
            closeBrace);
    }

    private ImmutableArray<SyntaxNode> ParseAnonymousClassMembers()
    {
        // Members are newline/semicolon separated (like ordinary class/struct
        // bodies), never comma separated. Each sub-parser consumes its own
        // terminator, so the loop simply repeats until the closing brace.
        var members = ImmutableArray.CreateBuilder<SyntaxNode>();
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // Members are newline- or semicolon-separated. Newlines are not
            // tokens (the next member's lead keyword simply follows), so only
            // explicit semicolon separators need to be consumed here.
            if (Current.Kind == SyntaxKind.SemicolonToken)
            {
                NextToken();
                continue;
            }

            var startToken = Current;

            // Optional `open`/`override` modifiers preceding a method.
            SyntaxToken memberOpenModifier = null;
            SyntaxToken memberOverrideModifier = null;
            while (Current.Kind == SyntaxKind.OpenKeyword || Current.Kind == SyntaxKind.OverrideKeyword)
            {
                if (Current.Kind == SyntaxKind.OpenKeyword && memberOpenModifier == null)
                {
                    memberOpenModifier = NextToken();
                }
                else if (Current.Kind == SyntaxKind.OverrideKeyword && memberOverrideModifier == null)
                {
                    memberOverrideModifier = NextToken();
                }
                else
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword);
                    NextToken();
                }
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init"
                && (Peek(1).Kind == SyntaxKind.OpenParenthesisToken))
            {
                // Reject `init(...)` — anonymous objects have no user ctors.
                Diagnostics.ReportInitDeinitNotAllowedInAnonymousObject(Current.Location, "init");
                ParseConstructorDeclaration(accessibilityModifier: null, convenienceModifier: null);
            }
            else if (Current.Kind == SyntaxKind.FuncKeyword
                     && Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init"
                     && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
            {
                // Reject `func init(...)`.
                Diagnostics.ReportInitDeinitNotAllowedInAnonymousObject(Current.Location, "init");
                NextToken();
                ParseConstructorDeclaration(accessibilityModifier: null, convenienceModifier: null);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "deinit"
                     && (Peek(1).Kind == SyntaxKind.OpenBraceToken
                         || Peek(1).Kind == SyntaxKind.OpenParenthesisToken))
            {
                // Reject `deinit { ... }`.
                Diagnostics.ReportInitDeinitNotAllowedInAnonymousObject(Current.Location, "deinit");
                ParseDeinitDeclaration();
            }
            else if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                members.Add(ParseFunctionDeclaration(accessibilityModifier: null, memberOpenModifier, memberOverrideModifier));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                members.Add(ParseEventDeclaration(accessibilityModifier: null, memberOpenModifier, memberOverrideModifier));
            }
            else if (Current.Kind == SyntaxKind.LetKeyword || Current.Kind == SyntaxKind.VarKeyword)
            {
                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.FuncKeyword);
                }

                members.Add(ParseAnonymousClassFieldMember());
            }
            else
            {
                // Unrecognised member start — surface a diagnostic and recover.
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.LetKeyword);
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return members.ToImmutable();
    }

    private AnonymousClassMemberInitializerSyntax ParseAnonymousClassFieldMember()
    {
        // `let/var Name [Type] = expr` — the type clause is optional and
        // inferred from the initializer when omitted, exactly like an ordinary
        // local `let` declaration.
        var letOrVarKeyword = NextToken();
        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        TypeClauseSyntax typeClause = null;
        if (Current.Kind != SyntaxKind.EqualsToken)
        {
            typeClause = ParseTypeClause();
        }

        var equals = MatchToken(SyntaxKind.EqualsToken);
        var value = ParseExpression();
        return new AnonymousClassMemberInitializerSyntax(syntaxTree, letOrVarKeyword, identifier, typeClause, equals, value);
    }

    private ExpressionSyntax ParseArrayCreationExpression()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);

        // Parse the optional length. A lone numeric literal immediately followed
        // by `]` is captured as the literal `LengthToken` so the existing
        // constant-count literal form (`[N]T{…}`, with its GS0115 check) and the
        // count-inferred slice form (`[]T{…}`, empty brackets) are unchanged.
        // Any other (runtime) length expression — issue #1272 — is captured as a
        // full `LengthExpression`.
        SyntaxToken lengthToken = null;
        ExpressionSyntax lengthExpression = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            if (Current.Kind == SyntaxKind.NumberToken && Peek(1).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                lengthToken = MatchToken(SyntaxKind.NumberToken);
            }
            else
            {
                lengthExpression = ParseExpression();
            }
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);

        // Issue #1046: a jagged-array literal whose element is itself a
        // non-identifier type clause (`[][]int32{ … }`, `[]*int32{ … }`, …).
        // Parse the element recursively when the token after `]` does not begin
        // a plain identifier element; otherwise keep the flat identifier form.
        //
        // Issue #1924: an array-of-generic literal (`[]Task[int32]{ … }`) or an
        // array of a dotted/qualified named type (`[]Outer.Inner{ … }`) also
        // needs the recursive `ParseTypeClause()` route — the flat identifier
        // fast path below has no way to consume a trailing `[T, ...]`
        // type-argument list or a `.Member` qualifier tail. `TryScanTypeClause`
        // (used by the expression-position generic-call/index disambiguation)
        // already parses these composite shapes in TYPE position, so the same
        // `[` / `.` lookahead used there disambiguates here too — a `[` or `.`
        // right after the element identifier can only start a type-argument
        // list or dotted-name tail in this array-element-type position, never
        // an index or member-access expression.
        if (Current.Kind != SyntaxKind.IdentifierToken
            || Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
            || Peek(1).Kind == SyntaxKind.DotToken)
        {
            var nestedElementType = ParseTypeClause();
            var (nestedOpenBrace, nestedElements, nestedCloseBrace, nestedHasElements) = ParseOptionalArrayInitializer();

            // Issue #1272: the no-initializer (or empty-initializer) form with a
            // length yields the runtime/zero-initialised allocation `[n][]T`.
            if (!nestedHasElements && (lengthExpression != null || lengthToken != null))
            {
                return new ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    lengthExpression ?? new LiteralExpressionSyntax(syntaxTree, lengthToken),
                    closeBracket,
                    nestedElementType,
                    nestedOpenBrace,
                    nestedElements,
                    nestedCloseBrace);
            }

            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression == null ? lengthToken : ToLengthLiteralToken(lengthExpression),
                closeBracket,
                nestedElementType,
                nestedOpenBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
                nestedElements ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
                nestedCloseBrace ?? MatchToken(SyntaxKind.CloseBraceToken));
        }

        var elementType = MatchToken(SyntaxKind.IdentifierToken);

        // Issue #1212: an element-nullable array literal `[]T?{ … }` /
        // `[N]T?{ … }`. The `?` binds to the element identifier, so route the
        // element through a nullable-suffixed type clause (the nested-element
        // path) instead of the bare-identifier fast path, yielding a
        // `Slice(Nullable(T))` / `Array(Nullable(T), N)`.
        if (Current.Kind == SyntaxKind.QuestionToken)
        {
            var questionToken = MatchToken(SyntaxKind.QuestionToken);
            var elementClause = new TypeClauseSyntax(syntaxTree, openBracketToken: null, lengthToken: null, closeBracketToken: null, elementType, questionToken);
            var (nElemOpenBrace, nElemElements, nElemCloseBrace, nElemHasElements) = ParseOptionalArrayInitializer();

            if (!nElemHasElements && (lengthExpression != null || lengthToken != null))
            {
                return new ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    lengthExpression ?? new LiteralExpressionSyntax(syntaxTree, lengthToken),
                    closeBracket,
                    elementClause,
                    nElemOpenBrace,
                    nElemElements,
                    nElemCloseBrace);
            }

            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression == null ? lengthToken : ToLengthLiteralToken(lengthExpression),
                closeBracket,
                elementClause,
                nElemOpenBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
                nElemElements ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
                nElemCloseBrace ?? MatchToken(SyntaxKind.CloseBraceToken));
        }

        var (openBrace, elements, closeBrace, hasElements) = ParseOptionalArrayInitializer();

        // Issue #1272: `[n]T` (no initializer) or `[n]T{}` (empty initializer)
        // with a runtime length is the zero-initialised allocation form. A lone
        // numeric literal length without a non-empty initializer (`[5]T`,
        // `[5]T{}`) is likewise a (constant-length) zero-initialised allocation.
        if (!hasElements && (lengthExpression != null || lengthToken != null))
        {
            return new ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression ?? new LiteralExpressionSyntax(syntaxTree, lengthToken),
                closeBracket,
                elementType,
                openBrace,
                elements,
                closeBrace);
        }

        return new ArrayCreationExpressionSyntax(
            syntaxTree,
            openBracket,
            lengthExpression == null ? lengthToken : ToLengthLiteralToken(lengthExpression),
            closeBracket,
            elementType,
            openBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
            elements ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
            closeBrace ?? MatchToken(SyntaxKind.CloseBraceToken));
    }

    // Parses an optional brace-delimited array initializer. Returns null tokens
    // when no `{` is present (the issue #1272 no-initializer form), and reports
    // whether any element expressions were supplied (an empty `{}` counts as the
    // zero-initialised allocation form, not a literal).
    private (SyntaxToken OpenBrace, SeparatedSyntaxList<ExpressionSyntax> Elements, SyntaxToken CloseBrace, bool HasElements) ParseOptionalArrayInitializer()
    {
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            return (null, null, null, false);
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var elements = ParseArrayInitializerElements();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return (openBrace, elements, closeBrace, elements.Count > 0);
    }

    // Extracts the literal `LengthToken` for the constant-count literal form when
    // a parsed length expression turns out to be a lone numeric literal (so the
    // existing GS0115 count check and `[N]T{…}` path keep working even when the
    // length was parsed via the general expression path). Non-literal lengths
    // combined with a non-empty initializer are not a valid shape; the binder
    // reports the mismatch.
    private static SyntaxToken ToLengthLiteralToken(ExpressionSyntax lengthExpression)
        => lengthExpression is LiteralExpressionSyntax { LiteralToken: { Kind: SyntaxKind.NumberToken } token } ? token : null;

    // ADR-0124 / issues #1024, #1057, #1041: parses a stack-allocation
    // expression in G#-style array grammar `stackalloc [n]T` (bracketed count
    // first, then the element type). The leading `stackalloc` is a contextual
    // keyword and the dispatcher in ParsePrimaryExpression only routes here for
    // the exact `stackalloc [` shape. The count is a full expression (so a
    // runtime length such as `stackalloc [count]uint8` is accepted, mirroring
    // the runtime-length array form). An optional brace-delimited initializer
    // (`stackalloc [n]T{ … }`) supplies the element values; the count-inferred
    // shape (`stackalloc []T{ … }`, empty brackets) takes the count from the
    // initializer length (issue #1041).
    private ExpressionSyntax ParseStackAllocExpression()
    {
        var stackAllocKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);

        // The count is optional: the `stackalloc []T{ … }` shape infers it from
        // the initializer length, so an immediate `]` leaves CountExpression null.
        ExpressionSyntax count = null;
        if (Current.Kind != SyntaxKind.CloseSquareBracketToken)
        {
            count = ParseExpression();
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        var elementType = MatchToken(SyntaxKind.IdentifierToken);

        // The brace-delimited initializer is optional for the count-only form
        // (`stackalloc [n]T`) and required for the count-inferred form
        // (`stackalloc []T{ … }`); the binder enforces that requirement.
        SyntaxToken openBrace = null;
        SeparatedSyntaxList<ExpressionSyntax> elements = null;
        SyntaxToken closeBrace = null;
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            elements = ParseArrayInitializerElements();
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        }

        return new StackAllocExpressionSyntax(
            syntaxTree,
            stackAllocKeyword,
            openBracket,
            count,
            closeBracket,
            elementType,
            openBrace,
            elements,
            closeBrace);
    }

    // ADR-0125 / issue #1026: `fixed name *T = source { … }`. The leading
    // `fixed` is a contextual keyword; the dispatcher in ParseStatement only
    // routes here for the exact `fixed IDENT *` shape. The header mirrors G#'s
    // other paren-less statement headers (`if`/`for`/`while`/`unsafe { }`).
    private StatementSyntax ParseFixedStatement()
    {
        var fixedKeyword = MatchToken(SyntaxKind.IdentifierToken);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeClause = ParseTypeClause();
        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // Suppress bare struct literals (`Ident { }`) and trailing object
        // initializers so the `{` after the source expression is parsed as the
        // pinned body block, not as part of the source — mirroring the
        // `if let` / `for` header treatment.
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax pinnedSource;
        try
        {
            pinnedSource = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        var body = ParseBlockStatement();
        return new FixedStatementSyntax(
            syntaxTree,
            fixedKeyword,
            identifier,
            typeClause,
            equalsToken,
            pinnedSource,
            body);
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArrayInitializerElements()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseExpression());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    private bool TryFindMatchingCloseBracketFollowedByEquals(out int offset)
    {
        offset = 0;
        var depth = 0;
        for (var i = 1; i <= LookaheadMaxScan; i++)
        {
            var kind = Peek(i).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (kind == SyntaxKind.OpenSquareBracketToken)
            {
                depth++;
            }
            else if (kind == SyntaxKind.CloseSquareBracketToken)
            {
                depth--;
                if (depth == 0)
                {
                    if (Peek(i + 1).Kind == SyntaxKind.EqualsToken)
                    {
                        offset = i + 1;
                        return true;
                    }

                    return false;
                }
            }
        }

        return false;
    }

    private ExpressionSyntax ParseNameOrCallExpression()
    {
        ExpressionSyntax current;
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "make"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
            && Peek(2).Kind == SyntaxKind.ChanKeyword)
        {
            // Phase 5.4 / ADR-0022: contextual `make(chan T)` / `make(chan T, capacity)`.
            current = ParseMakeChannelExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "typeof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #143: contextual `typeof(T)` — argument is a type clause.
            current = ParseTypeOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "sizeof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #1336: contextual `sizeof(T)` — argument is a type clause.
            current = ParseSizeOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && (Current.Text == "checked" || Current.Text == "unchecked")
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #1881: contextual `checked(expr)` / `unchecked(expr)` —
            // argument is an arithmetic expression, not a type clause.
            current = ParseCheckedExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Current.Text == "nameof"
            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #143: contextual `nameof(expr)` — argument is a name reference.
            current = ParseNameOfExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
        {
            current = ParseCallExpression();
            current = MaybeWrapWithObjectInitializer(current);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.QuestionToken
            && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // Issue #663: `string?(expr)` — nullable-type conversion call.
            current = ParseNullableTypeCallExpression();
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
            && LooksLikeGenericCallSite(1))
        {
            current = ParseGenericCallExpression();
            current = MaybeWrapWithObjectInitializer(current);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenBraceToken
            && (suppressStructLiteral == 0 || StructLiteralAllowedInSuppressedHeader(1))
            && IsStructLiteralFollowingBrace(2))
        {
            current = ParseStructLiteralExpression();
        }
        else
        {
            current = ParseNameExpression();
        }

        return ParsePostfixChain(current);
    }

    // Phase 4.1 / ADR-0020: bounded-lookahead disambiguation between
    // `name [ expr ]` (indexing) and `name [ TypeClause, ... ] ( args )`
    // (generic instantiation followed by call). `bracketOffset` is the
    // offset of the `[` token relative to Current.
    //
    // The comma-loop below intentionally supports any arity, including the
    // multi-type-arg shape `Dictionary[K, V]()` / `Dictionary[K, V, W]()`,
    // so the parser commits to a generic call site as long as every
    // comma-separated item inside the brackets parses as a type clause
    // (via `TryScanTypeClause`) and the token after the matching `]` is
    // one of the ADR-0020 follow-set markers (`(`, `{`, `.`). Regression
    // coverage lives in test/Core.Tests/CodeAnalysis/Syntax/Issue693MultiTypeArgGenericCallParserTests.cs
    // and end-to-end emit coverage in
    // test/Compiler.Tests/Emit/Issue693DictionaryConstructionEmitTests.cs.
    //
    // Issue #942: the `.` follow-set marker is genuinely ambiguous with
    // indexer-then-member access. A single bracketed argument that is also a
    // legal expression (e.g. `xs[i]`, `xs[i].ToString()`) scans as a lone
    // type clause and would otherwise be mis-committed to a generic
    // type-argument list, so the trailing `.Member` mis-binds. An indexer can
    // only ever hold a *single* index expression, never a comma-separated
    // list, so we restrict the `.` follow-set to the unambiguous multi-arg
    // shape (`Pair[int, string].zero`). A single bracketed argument followed
    // by `.` is parsed as an indexer-then-member access, matching the
    // literal-index behaviour (`xs[0].ToString()`). The `(`/`{` markers stay
    // arity-agnostic: `Map[int](xs)` and `List[int]{...}` remain generic
    // instantiations regardless of arity.
    private bool LooksLikeGenericCallSite(int bracketOffset)
    {
        if (Peek(bracketOffset).Kind != SyntaxKind.OpenSquareBracketToken)
        {
            return false;
        }

        var pos = bracketOffset + 1;
        if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
        {
            return false;
        }

        var typeArgumentCount = 0;
        var sawComplexTypeArgument = false;
        while (true)
        {
            if (!TryScanTypeClause(ref pos, out var argumentIsComplex))
            {
                return false;
            }

            typeArgumentCount++;
            sawComplexTypeArgument |= argumentIsComplex;

            if (Peek(pos).Kind == SyntaxKind.CommaToken)
            {
                pos++;
                continue;
            }

            if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                pos++;
                break;
            }

            return false;
        }

        // Follow-set per ADR-0020: '(' (call), '{' (composite literal), '.' (member access).
        var nextKind = Peek(pos).Kind;
        if (nextKind == SyntaxKind.OpenParenthesisToken)
        {
            return true;
        }

        if (nextKind == SyntaxKind.OpenBraceToken)
        {
            // Issue #1023: in a statement-header controlling expression
            // (`if`/`while`/`for` clauses, `switch`/`match` subject, …) the
            // trailing `{` opens the statement body, not a composite literal.
            // The same Go-style suppression that blocks `Type { … }` /
            // `Call() { … }` here must also block the generic-composite
            // `name[args] { … }` shape, so an indexer-tailed header such as
            // `for …; s += arr[s] { … }` binds `[s]` as an indexer and lets
            // `{` open the loop body. Nested contexts (parens, brackets,
            // argument lists) clear the counter, so `List[int]{…}` still
            // parses inside those.
            if (suppressTrailingObjectInitializer > 0)
            {
                return false;
            }

            return true;
        }

        // Issue #942 / Issue #1323: a multi-type-argument list (which cannot be
        // an indexer) always commits to a generic call site on a trailing `.`.
        // A single bracketed argument followed by `.` is normally treated as an
        // indexer-then-member access (`dict[key].Prop`, `Box[int32].Make` — the
        // latter resolves later in the binder). But a single argument whose
        // shape is unambiguously a TYPE — it carries a nullable suffix (`T?`),
        // an array/slice prefix (`[]T`), or its own nested type-argument list
        // (`List[T]`) — cannot be a legal index expression, so it must be a
        // generic call site (`Box[int32?].Make`, `Box[[]int32].Make`,
        // `Box[List[int32]].Make`).
        return nextKind == SyntaxKind.DotToken
            && (typeArgumentCount > 1 || sawComplexTypeArgument);
    }

    private bool TryScanTypeClause(ref int pos) => TryScanTypeClause(ref pos, out _);

    // Issue #1602: depth-guarded wrapper — TryScanTypeClause and
    // TryScanOptionalTypeArgumentList are mutually recursive during
    // speculative lookahead (`a[a[a[…` scans as a candidate type-argument
    // list). Speculation must fail GRACEFULLY at the limit: it returns false
    // without reporting, and the subsequent real parse (which takes the
    // non-generic interpretation) reports GS0417 if it also runs too deep.
    private bool TryScanTypeClause(ref int pos, out bool isComplex)
    {
        if (recursionDepth >= MaxRecursionDepth)
        {
            isComplex = false;
            return false;
        }

        if (recursionDepth >= UncheckedRecursionDepth)
        {
            try
            {
                RuntimeHelpers.EnsureSufficientExecutionStack();
            }
            catch (InsufficientExecutionStackException)
            {
                isComplex = false;
                return false;
            }
        }

        recursionDepth++;
        try
        {
            return TryScanTypeClauseCore(ref pos, out isComplex);
        }
        finally
        {
            recursionDepth--;
        }
    }

    private bool TryScanTypeClauseCore(ref int pos, out bool isComplex)
    {
        isComplex = false;

        // Optional leading bracketed segment: '[' ']' or '[' Number ']' for slice/array shapes.
        if (Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken)
        {
            // An array/slice prefix is unambiguously a type shape (Issue #1323).
            isComplex = true;
            pos++;
            if (Peek(pos).Kind == SyntaxKind.NumberToken)
            {
                pos++;
            }

            if (Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken)
            {
                return false;
            }

            pos++;
        }

        // ADR-0075: `async (T) -> R` and `func(T) R` start a function-type clause.
        // Handle the optional leading `async` modifier here so the next token
        // is the actual head of the function-type clause.
        if (Peek(pos).Kind == SyntaxKind.AsyncKeyword)
        {
            pos++;
        }

        // ADR-0075: `(T1, T2, ...) -> R` arrow function-type clause, or a
        // tuple-type clause `(T1, T2, ...)`. Both start with '('.
        if (Peek(pos).Kind == SyntaxKind.OpenParenthesisToken)
        {
            // A function/tuple type clause is unambiguously a type shape.
            isComplex = true;
            pos++;
            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                while (true)
                {
                    if (!TryScanTypeClause(ref pos))
                    {
                        return false;
                    }

                    if (Peek(pos).Kind == SyntaxKind.CommaToken)
                    {
                        pos++;
                        continue;
                    }

                    break;
                }
            }

            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                return false;
            }

            pos++;

            // If `->` follows, this is an arrow function-type clause; scan the return type.
            if (Peek(pos).Kind == SyntaxKind.RightArrowToken)
            {
                pos++;
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }
            }

            // Optional trailing `?` for nullables (tuples and function types both support `?`).
            if (Peek(pos).Kind == SyntaxKind.QuestionToken)
            {
                pos++;
            }

            return true;
        }

        // Phase 4.7: legacy `func(T) R` function-type clause.
        if (Peek(pos).Kind == SyntaxKind.FuncKeyword)
        {
            // A legacy function-type clause is unambiguously a type shape.
            isComplex = true;
            pos++;
            if (Peek(pos).Kind != SyntaxKind.OpenParenthesisToken)
            {
                return false;
            }

            pos++;
            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                while (true)
                {
                    if (!TryScanTypeClause(ref pos))
                    {
                        return false;
                    }

                    if (Peek(pos).Kind == SyntaxKind.CommaToken)
                    {
                        pos++;
                        continue;
                    }

                    break;
                }
            }

            if (Peek(pos).Kind != SyntaxKind.CloseParenthesisToken)
            {
                return false;
            }

            pos++;

            // Optional return type for the legacy func form.
            if (Peek(pos).Kind == SyntaxKind.IdentifierToken
                || Peek(pos).Kind == SyntaxKind.OpenParenthesisToken)
            {
                if (!TryScanTypeClause(ref pos))
                {
                    return false;
                }
            }

            if (Peek(pos).Kind == SyntaxKind.QuestionToken)
            {
                pos++;
            }

            return true;
        }

        if (Peek(pos).Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        pos++;

        // Nested type-argument list, e.g. `List[int]`.
        if (!TryScanOptionalTypeArgumentList(ref pos, out var headHadTypeArgumentList))
        {
            return false;
        }

        // A nested type-argument list makes this unambiguously a type shape
        // (`List[int32]`) rather than a plain index expression (Issue #1323).
        isComplex |= headHadTypeArgumentList;

        // Issue #1174: a dotted tail names a (possibly nested, possibly
        // generic) type — `Container.Nested`, `A.B.C`, or `Outer.Generic[T]`.
        // Each `.Identifier` segment may carry its own type-argument list.
        // Consuming the tail here lets `List[C.E]` and `List[C.E]{...}` scan as
        // a SINGLE type clause in a generic-argument position so they are
        // recognised as a generic call / composite site. The `.` is scanned
        // INSIDE the bracket; the separate issue #942 rule about a trailing `.`
        // AFTER the `]` (indexer-then-member disambiguation in
        // LooksLikeGenericCallSite) is untouched.
        while (Peek(pos).Kind == SyntaxKind.DotToken
            && Peek(pos + 1).Kind == SyntaxKind.IdentifierToken)
        {
            pos += 2;
            if (!TryScanOptionalTypeArgumentList(ref pos, out var segmentHadTypeArgumentList))
            {
                return false;
            }

            isComplex |= segmentHadTypeArgumentList;
        }

        // Optional trailing `?` for nullables.
        if (Peek(pos).Kind == SyntaxKind.QuestionToken)
        {
            // A nullable suffix is unambiguously a type shape (Issue #1323).
            isComplex = true;
            pos++;
        }

        return true;
    }

    /// <summary>
    /// Issue #1174: scans an optional bracketed type-argument list
    /// (<c>[T1, T2, ...]</c>) starting at <paramref name="pos"/>. A missing list
    /// is a success (no-op). Used by <see cref="TryScanTypeClause(ref int)"/> for both the
    /// head identifier and each dotted-tail segment so a nested generic type such
    /// as <c>Outer.Generic[T]</c> scans as one type clause.
    /// </summary>
    /// <param name="pos">The scan position, advanced past the list when present.</param>
    /// <returns><see langword="true"/> when there is no list or it scans cleanly.</returns>
    private bool TryScanOptionalTypeArgumentList(ref int pos)
        => TryScanOptionalTypeArgumentList(ref pos, out _);

    private bool TryScanOptionalTypeArgumentList(ref int pos, out bool present)
    {
        if (Peek(pos).Kind != SyntaxKind.OpenSquareBracketToken)
        {
            present = false;
            return true;
        }

        present = true;
        pos++;
        while (true)
        {
            if (!TryScanTypeClause(ref pos))
            {
                return false;
            }

            if (Peek(pos).Kind == SyntaxKind.CommaToken)
            {
                pos++;
                continue;
            }

            if (Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken)
            {
                pos++;
                break;
            }

            return false;
        }

        return true;
    }

    private ExpressionSyntax ParseGenericCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeArguments = ParseTypeArgumentList();

        // Phase 4.3 / ADR-0020: a `[…]` type-argument list followed by `{` is a
        // generic struct/class composite literal (`Result[int, string]{...}`).
        // Issue #479 / ADR-0117: the same `Type[args]{…}` shape is a collection
        // initializer (`List[int32]{1, 2, 3}`, `Dictionary[K, V]{"a": 1}`,
        // `Dictionary[K, V]{ ["a"] = 1 }`) when the brace contents are NOT a
        // `Field: value` struct-literal field list. The parser synthesizes an
        // empty-argument constructor call as the initializer's target.
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            if (BraceLooksLikeGenericCollectionInitializer())
            {
                var ctorCall = SynthesizeEmptyArgConstructorCall(identifier, typeArguments);
                return ParseCollectionInitializerExpression(ctorCall);
            }

            var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
            var (spreadToken, spreadExpression, spreadSeparator, initializers) = ParseStructLiteralInitializers();
            var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
            var literal = new StructLiteralExpressionSyntax(
                syntaxTree,
                identifier,
                openBrace,
                spreadToken,
                spreadExpression,
                spreadSeparator,
                initializers,
                closeBrace);
            literal.TypeArgumentList = typeArguments;
            return literal;
        }

        // Issue #1323: a `[…]` type-argument list followed by `.` is a member
        // access on the constructed generic *type* (`Box[int32?].Make(5)`,
        // `Pair[int, string].Default`). The committed-to-generic decision was
        // already made by LooksLikeGenericCallSite (multi-arg, or a single
        // unambiguously type-shaped argument). Emit a generic-name expression so
        // ParsePostfixChain attaches the `.Member(...)` accessor and the binder
        // resolves the closed construction as the static-access receiver.
        if (Current.Kind == SyntaxKind.DotToken)
        {
            return new GenericNameExpressionSyntax(syntaxTree, identifier, typeArguments);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, typeArguments, openParen, arguments, closeParen);
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

    // Issue #479 / ADR-0117: in the `Type[args]{…}` generic-composite position
    // the `{` introduces a struct-literal field list when it is empty (all
    // defaults) or its first entry is `Identifier :`. Every other shape — a
    // bare element (`1`), a non-identifier-keyed entry (`"a": 1`), or an
    // indexed entry (`["a"] = 1`) — is a collection initializer.
    private bool BraceLooksLikeGenericCollectionInitializer()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return false;
        }

        if (k1 == SyntaxKind.EllipsisToken)
        {
            return false;
        }

        if (k1 == SyntaxKind.OpenSquareBracketToken)
        {
            return true;
        }

        if (k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.ColonToken)
        {
            return false;
        }

        return true;
    }

    // Issue #479 / ADR-0117: recognises a collection-initializer `{` after a
    // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`). To
    // avoid colliding with a statement body (`foo() { stmt }`) we require an
    // unambiguous collection marker: an indexed-entry `[`, a single literal
    // element, or a top-level `,`/`:` separator inside the braces.
    private bool LooksLikeCollectionInitializerBrace()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return false;
        }

        if (k1 == SyntaxKind.OpenSquareBracketToken)
        {
            return true;
        }

        if (IsLiteralStartToken(k1) && Peek(2).Kind == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        var depth = 0;
        for (var i = 1; i <= LookaheadMaxScan; i++)
        {
            var kind = Peek(i).Kind;
            if (kind == SyntaxKind.EndOfFileToken)
            {
                return false;
            }

            if (kind == SyntaxKind.OpenBraceToken
                || kind == SyntaxKind.OpenParenthesisToken
                || kind == SyntaxKind.OpenSquareBracketToken)
            {
                depth++;
            }
            else if (kind == SyntaxKind.CloseParenthesisToken
                || kind == SyntaxKind.CloseSquareBracketToken)
            {
                depth--;
            }
            else if (kind == SyntaxKind.CloseBraceToken)
            {
                if (depth == 0)
                {
                    return false;
                }

                depth--;
            }
            else if (depth == 0 && (kind == SyntaxKind.CommaToken || kind == SyntaxKind.ColonToken))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsLiteralStartToken(SyntaxKind kind)
    {
        return kind == SyntaxKind.NumberToken
            || kind == SyntaxKind.StringToken
            || kind == SyntaxKind.InterpolatedStringToken
            || kind == SyntaxKind.TrueKeyword
            || kind == SyntaxKind.FalseKeyword
            || kind == SyntaxKind.NilKeyword;
    }

    // Issue #479 / ADR-0117: parses the `{ elements }` collection initializer
    // applied to an already-parsed constructor-call target.
    private ExpressionSyntax ParseCollectionInitializerExpression(ExpressionSyntax target)
    {
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var elements = ParseCollectionElements();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new CollectionInitializerExpressionSyntax(syntaxTree, target, openBrace, elements, closeBrace);
    }

    private SeparatedSyntaxList<CollectionElementSyntax> ParseCollectionElements()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext
               && Current.Kind != SyntaxKind.CloseBraceToken
               && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseCollectionElement());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<CollectionElementSyntax>(nodesAndSeparators.ToImmutable());
    }

    private CollectionElementSyntax ParseCollectionElement()
    {
        // Element values live inside the braces — a fresh expression context
        // where trailing object/collection initializers are again allowed.
        var savedSuppress = suppressTrailingObjectInitializer;
        suppressTrailingObjectInitializer = 0;
        var savedStructLiteral = suppressStructLiteral;
        suppressStructLiteral = 0;
        try
        {
            // Indexed entry `[key] = value`.
            if (Current.Kind == SyntaxKind.OpenSquareBracketToken)
            {
                var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
                var key = ParseExpression();
                var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
                var equals = MatchToken(SyntaxKind.EqualsToken);
                var value = ParseExpression();
                return new IndexedCollectionElementSyntax(syntaxTree, openBracket, key, closeBracket, equals, value);
            }

            var first = ParseExpression();

            // Key/value entry `key: value`.
            if (Current.Kind == SyntaxKind.ColonToken)
            {
                var colon = MatchToken(SyntaxKind.ColonToken);
                var value = ParseExpression();
                return new KeyedCollectionElementSyntax(syntaxTree, first, colon, value);
            }

            // Bare sequence/set element.
            return new ExpressionCollectionElementSyntax(syntaxTree, first);
        }
        finally
        {
            suppressTrailingObjectInitializer = savedSuppress;
            suppressStructLiteral = savedStructLiteral;
        }
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

    private TypeArgumentListSyntax ParseTypeArgumentList()
    {
        var openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken);
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNext = true;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseSquareBracketToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseTypeClause());

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        var closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken);
        return new TypeArgumentListSyntax(syntaxTree, openBracket, new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable()), closeBracket);
    }
}
