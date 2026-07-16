// <copyright file="Parser.Expressions.Literals.cs" company="GSharp">
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

    private ExpressionSyntax ParseCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, openParenthesisToken, arguments, closeParenthesisToken);
    }

    // Issue #663: `string?(expr)` — nullable-type conversion call form.
    // Consumes `Identifier ? ( args )` and builds a CallExpressionSyntax
    // carrying the `?` token so the binder can wrap the resolved type in
    // NullableTypeSymbol.
    private ExpressionSyntax ParseNullableTypeCallExpression()
    {
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var questionToken = MatchToken(SyntaxKind.QuestionToken);
        var openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken);
        var arguments = ParseArguments();
        var closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken);
        arguments = MaybeAppendTrailingLambda(arguments);
        return new CallExpressionSyntax(syntaxTree, identifier, questionToken, typeArgumentList: null, openParenthesisToken, arguments, closeParenthesisToken);
    }

    // Issue #522: when the token following a constructor call's `)` is `{`
    // and the brace contents look like an object initializer (`Identifier =`
    // or empty `}`), wrap the call in an ObjectCreationExpressionSyntax. We
    // peek with the same surgical lookahead used by IsStructLiteralFollowingBrace
    // so unrelated trailing braces (e.g. an `if Cond() { body }` statement
    // body) are not mis-eaten.
    private ExpressionSyntax MaybeWrapWithObjectInitializer(ExpressionSyntax target)
    {
        if (Current.Kind != SyntaxKind.OpenBraceToken)
        {
            return target;
        }

        // Body-header contexts (if/for/while/switch condition) suppress the
        // wrap so the following `{` is recognised as the statement body.
        if (suppressTrailingObjectInitializer > 0)
        {
            return target;
        }

        if (!LooksLikeObjectInitializerBrace())
        {
            // Issue #479 / ADR-0117: a collection initializer applied to a
            // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`).
            if (LooksLikeCollectionInitializerBrace())
            {
                return ParseCollectionInitializerExpression(target);
            }

            return target;
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var initializers = ParseObjectInitializerList();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new ObjectCreationExpressionSyntax(syntaxTree, target, openBrace, initializers, closeBrace);
    }

    // Recognises an object-initializer `{` after a constructor call. To avoid
    // colliding with statement-bodied constructs of the form `if Cond() { ... }`
    // we require either `{}` (empty) or `{ Identifier =` so a `{ Identifier .`
    // (member access in a body) is not absorbed.
    private bool LooksLikeObjectInitializerBrace()
    {
        var k1 = Peek(1).Kind;
        if (k1 == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        return k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.EqualsToken;
    }

    private SeparatedSyntaxList<PropertyInitializerSyntax> ParseObjectInitializerList()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext
               && Current.Kind != SyntaxKind.CloseBraceToken
               && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var propertyId = MatchToken(SyntaxKind.IdentifierToken);
            var equals = MatchToken(SyntaxKind.EqualsToken);

            // Initializer values live inside the braces — a fresh expression
            // context where trailing object initializers are again allowed
            // (so a nested `Inner = U() { X = 1 }` works even when the outer
            // object initializer was parsed inside a body-header context).
            ExpressionSyntax value;
            var savedSuppress = suppressTrailingObjectInitializer;
            suppressTrailingObjectInitializer = 0;
            var savedStructLiteral = suppressStructLiteral;
            suppressStructLiteral = 0;
            try
            {
                // Issue #1858: `Prop = { a, b }` mirrors the struct-literal
                // target-less collection-initializer carve-out (issue #1567,
                // `ParseFieldInitializerValue`) — a brace can never start a
                // normal expression in value position, so its presence
                // unambiguously selects the member collection-initializer form
                // rather than an ordinary assignment value. This lets the
                // construction-with-initializer-suffix form (issue #522) carry
                // a nested collection member alongside constructor arguments.
                value = Current.Kind == SyntaxKind.OpenBraceToken
                    ? ParseCollectionInitializerExpression(target: null)
                    : ParseExpression();
            }
            finally
            {
                suppressTrailingObjectInitializer = savedSuppress;
                suppressStructLiteral = savedStructLiteral;
            }

            nodesAndSeparators.Add(new PropertyInitializerSyntax(syntaxTree, propertyId, equals, value));

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<PropertyInitializerSyntax>(nodesAndSeparators.ToImmutable());
    }

    // Parses an expression in a body-header context (the condition of an `if`,
    // the collection of a `for-range`, etc.) — trailing `Call() { ... }`
    // object initializers AND bare `Ident { }` struct literals are suppressed so
    // the following `{` is recognised as the body of the surrounding statement.
    // Suppressing the bare struct-literal form matters for an empty body: an
    // `if disposing { }` condition would otherwise commit `disposing { }` as an
    // empty struct literal (GS0157), because the struct-literal lookahead accepts
    // `{}` (a non-empty body already backtracks). Mirrors the if-expression
    // (#669), `if let`, and `fixed` headers, which suppress both forms.
    private ExpressionSyntax ParseExpressionInBodyHeader(bool allowEmptyStructLiteralCollection = false)
    {
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        var savedAllowEmptyStructLiteral = allowEmptyStructLiteralInHeader;
        allowEmptyStructLiteralInHeader = allowEmptyStructLiteralCollection;
        try
        {
            return ParseExpression();
        }
        finally
        {
            allowEmptyStructLiteralInHeader = savedAllowEmptyStructLiteral;
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }
    }

    private ExpressionSyntax ParseMakeChannelExpression()
    {
        // Phase 5.4 / ADR-0022: `make(chan T)` / `make(chan T, capacity)`.
        var makeIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var channelType = ParseChanTypeClause();
        SyntaxToken comma = null;
        ExpressionSyntax capacity = null;
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            comma = MatchToken(SyntaxKind.CommaToken);
            capacity = ParseExpression();
        }

        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new MakeChannelExpressionSyntax(syntaxTree, makeIdentifier, openParen, channelType, comma, capacity, closeParen);
    }

    private ExpressionSyntax ParseTypeOfExpression()
    {
        // Issue #143: `typeof(T)` — the argument is a type clause, not an expression.
        var typeOfIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var typeClause = ParseTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new TypeOfExpressionSyntax(syntaxTree, typeOfIdentifier, openParen, typeClause, closeParen);
    }

    private ExpressionSyntax ParseSizeOfExpression()
    {
        // Issue #1336: `sizeof(T)` — the argument is a type clause, not an expression.
        var sizeOfIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var typeClause = ParseTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new SizeOfExpressionSyntax(syntaxTree, sizeOfIdentifier, openParen, typeClause, closeParen);
    }

    private ExpressionSyntax ParseCheckedExpression()
    {
        // Issue #1881: `checked(expr)` / `unchecked(expr)` — the argument is
        // an ordinary expression evaluated in the named overflow context.
        var isChecked = Current.Text == "checked";
        var keyword = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var expression = ParseExpression();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new CheckedExpressionSyntax(syntaxTree, keyword, openParen, expression, closeParen, isChecked);
    }

    private DefaultExpressionSyntax ParseDefaultExpression()
    {
        // ADR-0100 / issue #795: `default(T)` and bare `default` expression.
        // Both shapes start with the `default` keyword. The optional
        // `(TypeClause)` makes the form explicit; the bare form leaves the
        // type to be supplied by the surrounding target-type context
        // (let/var initializer with explicit type, `return`, typed call
        // argument, sibling branch of `?:`). Bare-form bind-time errors
        // are surfaced as GS0362.
        var defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword);
        if (Current.Kind != SyntaxKind.OpenParenthesisToken)
        {
            return new DefaultExpressionSyntax(syntaxTree, defaultKeyword, openParenthesis: null, typeClause: null, closeParenthesis: null);
        }

        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var typeClause = ParseTypeClause();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new DefaultExpressionSyntax(syntaxTree, defaultKeyword, openParen, typeClause, closeParen);
    }

    private ExpressionSyntax ParseNameOfExpression()
    {
        // Issue #143: `nameof(expr)` — the argument is a name reference. We
        // parse it as a general expression; the binder validates that it
        // reduces to a name (identifier / member access / generic name) and
        // emits a diagnostic otherwise.
        var nameOfIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var argument = ParseNameOfArgument();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new NameOfExpressionSyntax(syntaxTree, nameOfIdentifier, openParen, argument, closeParen);
    }

    // Issue #1329: parse the argument of `nameof(...)`, recognising a
    // constructed-generic *type* reference (`IAppleData[TData]`, `List[int32]`,
    // `Dictionary[string, int32]`) as a GenericNameExpression. Such an argument
    // is closed by the nameof `)` rather than by one of the ADR-0020 generic
    // follow-set markers (`(`, `{`, `.`), so the ordinary postfix parser would
    // otherwise treat the bracketed type-argument list as an indexer (and a
    // multi-argument list would not parse at all). When the leading
    // `Identifier[…]` scans as a type-argument list closed immediately by `)`,
    // emit a GenericNameExpression so the binder folds it to the unqualified
    // type name (matching C# `nameof(List<int>)` -> "List").
    private ExpressionSyntax ParseNameOfArgument()
    {
        if (Current.Kind == SyntaxKind.IdentifierToken
            && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken
            && NameOfGenericArgumentScansToCloseParen(1))
        {
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var typeArguments = ParseTypeArgumentList();
            return new GenericNameExpressionSyntax(syntaxTree, identifier, typeArguments);
        }

        return ParseExpression();
    }

    // Issue #1329: bounded-lookahead test for a generic-type nameof argument.
    // Like <see cref="LooksLikeGenericCallSite"/>, but the accepted follow-set
    // marker after the matching `]` is the nameof closing `)` (any arity).
    private bool NameOfGenericArgumentScansToCloseParen(int bracketOffset)
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

        return Peek(pos).Kind == SyntaxKind.CloseParenthesisToken;
    }

    // Phase 4.9: Kotlin-style trailing-lambda call syntax. When a call's
    // closing paren is immediately followed by a `func(...) {...}` literal,
    // the literal is desugared into an additional last positional argument.
    // Useful for DSL-flavoured call sites like `runBlocking() func() { ... }`
    // and `xs.forEach() func(x int) { ... }`. The bare-parens form
    // (`f func(...) {...}` with no `()`) is intentionally out of scope for
    // v0 to keep the call grammar unambiguous with statement-level function
    // literals.
    private SeparatedSyntaxList<ExpressionSyntax> MaybeAppendTrailingLambda(
        SeparatedSyntaxList<ExpressionSyntax> arguments)
    {
        // Only `func(...) {...}` or `async func(...) {...}` (function LITERALS)
        // attach as a trailing lambda; `func Name(...)` (a function DECLARATION)
        // must stay as the following statement-level declaration.
        var isSyncLiteral = Current.Kind == SyntaxKind.FuncKeyword
                            && Peek(1).Kind == SyntaxKind.OpenParenthesisToken;
        var isAsyncLiteral = Current.Kind == SyntaxKind.AsyncKeyword
                             && Peek(1).Kind == SyntaxKind.FuncKeyword
                             && Peek(2).Kind == SyntaxKind.OpenParenthesisToken;
        if (!isSyncLiteral && !isAsyncLiteral)
        {
            return arguments;
        }

        // Issue #1294: the `func (` lookahead above also matches a RECEIVER-form
        // method declaration `func (recv Type) Name(...)`, whose leading
        // `(recv Type)` is a receiver clause rather than a function-literal
        // parameter list. This collides with expression-bodied members from
        // issue #1278: an arrow body that ends in a call (`-> Q(b)`) followed by
        // a receiver-form declaration on the next line would otherwise gobble
        // that declaration's `func (recv Type)` as a trailing lambda. A function
        // LITERAL never has a method name after its parameter list (its `)` is
        // followed by `{` or a return-type clause, then `{`); a receiver-form
        // declaration is uniquely `func (recv Type) Identifier (` — an
        // identifier (the method name) immediately followed by its own `(`. When
        // we see that shape, the following `func` is a declaration: leave it for
        // the declaration parser and do not attach it as a trailing lambda.
        var funcOffset = isAsyncLiteral ? 1 : 0;
        if (LooksLikeReceiverMethodDeclaration(funcOffset))
        {
            return arguments;
        }

        var lambda = ParseFunctionLiteralExpression();
        var existing = arguments.GetWithSeparators();
        var builder = ImmutableArray.CreateBuilder<SyntaxNode>(existing.Length + 2);
        builder.AddRange(existing);
        if (existing.Length > 0 && existing[existing.Length - 1] is not SyntaxToken)
        {
            var syntheticComma = new SyntaxToken(
                syntaxTree,
                SyntaxKind.CommaToken,
                lambda.Span.Start,
                null,
                null);
            builder.Add(syntheticComma);
        }

        builder.Add(lambda);
        return new SeparatedSyntaxList<ExpressionSyntax>(builder.ToImmutable());
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
        var scanBound = openParenOffset + LookaheadMaxScan;
        for (var i = openParenOffset; i <= scanBound; i++)
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

        return false;
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArguments()
    {
        // Issue #522: arguments are fresh expression contexts — even when the
        // surrounding statement is a body-header (`if`/`for`/`switch`), a
        // call argument such as `Foo(T() { X = 1 })` should still admit a
        // trailing object initializer.
        var savedSuppress = suppressTrailingObjectInitializer;
        suppressTrailingObjectInitializer = 0;

        // A call argument is likewise a fresh context for the bare `Ident { }`
        // struct-literal form, so `Foo(Pt{X: 1})` is recognised even inside a
        // body-header condition (#1575).
        var savedStructLiteral = suppressStructLiteral;
        suppressStructLiteral = 0;

        // Issue #1038: an argument list is a fresh context, so a standalone
        // range argument (`f(1..3)`) is recognised even inside an index bound.
        var savedRange = suppressRangeOperator;
        suppressRangeOperator = 0;
        try
        {
            return ParseArgumentsCore();
        }
        finally
        {
            suppressTrailingObjectInitializer = savedSuppress;
            suppressStructLiteral = savedStructLiteral;
            suppressRangeOperator = savedRange;
        }
    }

    private SeparatedSyntaxList<ExpressionSyntax> ParseArgumentsCore()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();

        var parseNextArgument = true;
        while (parseNextArgument &&
               Current.Kind != SyntaxKind.CloseParenthesisToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            ExpressionSyntax expression;
            if (Current.Kind == SyntaxKind.IdentifierToken
                && (Peek(1).Kind == SyntaxKind.EqualsToken || Peek(1).Kind == SyntaxKind.ColonToken))
            {
                var name = MatchToken(SyntaxKind.IdentifierToken);

                // Issue #343: a call-site named argument uses `name: value`.
                // The pre-existing `name = value` form remains accepted for
                // back-compat (used by `.copy(...)` sugar and attribute args).
                // ADR-0080 / issue #720: the `=` form is deprecated and emits
                // a one-release warning (GS0315) before removal.
                SyntaxToken separator;
                if (Current.Kind == SyntaxKind.ColonToken)
                {
                    separator = MatchToken(SyntaxKind.ColonToken);
                }
                else
                {
                    separator = MatchToken(SyntaxKind.EqualsToken);
                    Diagnostics.ReportNamedArgumentEqualsSeparatorDeprecated(separator.Location, name.Text);
                }

                // ADR-0060: a named argument may carry a ref-kind modifier in
                // its value position (e.g. `name = ref x`). V1 rejects this
                // shape at bind time per ADR §4 / §8 (composition with named
                // arguments is a follow-up); the parser still accepts it so
                // the diagnostic carries a precise location.
                ExpressionSyntax value;
                if (TryParseRefArgument(out var refValue))
                {
                    value = refValue;
                }
                else
                {
                    value = ParseExpression();
                }

                expression = new NamedArgumentExpressionSyntax(syntaxTree, name, separator, value);
            }
            else if (TryParseRefArgument(out var refArg))
            {
                expression = refArg;
            }
            else
            {
                expression = ParseExpression();
            }

            nodesAndSeparators.Add(expression);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                nodesAndSeparators.Add(comma);
            }
            else
            {
                parseNextArgument = false;
            }
        }

        return new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable());
    }

    // ADR-0060: at the start of each argument position, recognise the
    // contextual ref-kind modifiers `ref`/`out`/`in` and wrap the payload
    // in a `RefArgumentExpressionSyntax`. Disambiguation rules per ADR §1:
    //   ref/in <ident> | (              -> ref-kind argument
    //   out var <ident>                 -> out inline-var
    //   out let <ident>                 -> out inline-let
    //   out _                           -> out discard
    //   out <ident>                     -> out lvalue
    // Otherwise the identifier `ref`/`out`/`in` is left as a plain expression
    // (e.g. a user-defined parameter actually named `out`).
    private bool TryParseRefArgument(out RefArgumentExpressionSyntax result)
    {
        result = null;
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        var text = Current.Text;
        if (text != "ref" && text != "out" && text != "in")
        {
            return false;
        }

        var nextKind = Peek(1).Kind;
        var nextText = Peek(1).Text;

        if (text == "out")
        {
            // `out var <ident>`, `out let <ident>`, `out _`, `out <ident>`,
            // or `out (`. Reject the `out` if the next token isn't a legal
            // payload start (so a parameter actually named `out` still binds).
            bool payloadIsDecl = (nextKind == SyntaxKind.VarKeyword || nextKind == SyntaxKind.LetKeyword)
                && Peek(2).Kind == SyntaxKind.IdentifierToken;
            bool payloadIsDiscard = nextKind == SyntaxKind.IdentifierToken && nextText == "_";
            bool payloadIsLvalueStart = nextKind == SyntaxKind.IdentifierToken || nextKind == SyntaxKind.OpenParenthesisToken;

            // ADR-0061: `out` may also be followed by a conditional-ref
            // condition expression — relax the disambiguation for literal
            // keywords and number/unary tokens that can never be an
            // out-parameter target. A `?` later turns these into the
            // conditional form; without `?` the binder reports the standard
            // non-lvalue diagnostic.
            bool payloadIsConditionalConditionStart = nextKind == SyntaxKind.TrueKeyword
                || nextKind == SyntaxKind.FalseKeyword
                || nextKind == SyntaxKind.NumberToken
                || nextKind == SyntaxKind.BangToken
                || nextKind == SyntaxKind.MinusToken;

            // A bare identifier follower could be the parameter name (use `out`).
            // It is treated as `out lvalue` only when the lookahead is unambiguous.
            // We follow the ADR's rule: if the modifier is followed by an
            // identifier (not the named-argument `=` form), recognise it as
            // a ref-kind argument. A trailing `=` (named argument) is already
            // handled above; anything else with an ident lookahead is `out`.
            if (!(payloadIsDecl || payloadIsDiscard || payloadIsLvalueStart || payloadIsConditionalConditionStart))
            {
                return false;
            }

            var outToken = NextToken();
            if (payloadIsDecl)
            {
                var keyword = NextToken();
                var ident = MatchToken(SyntaxKind.IdentifierToken);
                TypeClauseSyntax declType = null;
                if (CurrentTokenStartsTypeClause())
                {
                    declType = ParseTypeClause();
                }

                result = new RefArgumentExpressionSyntax(syntaxTree, outToken, keyword, ident, discardToken: null, declType);
                return true;
            }

            if (payloadIsDiscard)
            {
                var underscore = NextToken();
                TypeClauseSyntax declType = null;
                if (CurrentTokenStartsTypeClause())
                {
                    declType = ParseTypeClause();
                }

                result = new RefArgumentExpressionSyntax(syntaxTree, outToken, declarationKeyword: null, declarationIdentifier: null, discardToken: underscore, declType);
                return true;
            }

            var lvalue = ParseExpression();
            lvalue = MaybeParseConditionalRefArgumentTail(lvalue, outToken);
            result = new RefArgumentExpressionSyntax(syntaxTree, outToken, lvalue);
            return true;
        }

        // `ref` / `in` — legal followers are an identifier (lvalue), a
        // parenthesised lvalue, or (ADR-0061) any token that can start a
        // conditional ref-argument's condition expression — literal keywords,
        // number tokens, or unary operators that combine to form a bool
        // condition. The conditional form requires a `?` later on the line;
        // when one is absent these cases are rejected at bind time as
        // expected ("cannot take address of non-lvalue").
        if (!(nextKind == SyntaxKind.IdentifierToken
              || nextKind == SyntaxKind.OpenParenthesisToken
              || nextKind == SyntaxKind.TrueKeyword
              || nextKind == SyntaxKind.FalseKeyword
              || nextKind == SyntaxKind.NumberToken
              || nextKind == SyntaxKind.BangToken
              || nextKind == SyntaxKind.MinusToken))
        {
            return false;
        }

        var modifier = NextToken();
        var inner = ParseExpression();
        inner = MaybeParseConditionalRefArgumentTail(inner, modifier);
        result = new RefArgumentExpressionSyntax(syntaxTree, modifier, inner);
        return true;
    }

    // ADR-0062: parse a ternary tail `? a : b` starting at the current `?`
    // token, given the already-parsed condition expression. Right-associative.
    // When the inner branches use legacy ADR-0061 inner ref-kind modifiers,
    // returns a ConditionalRefArgumentExpressionSyntax (for back-compat) so
    // the binder can reject mismatches; otherwise returns the general
    // ConditionalExpressionSyntax (ADR-0062).
    private ExpressionSyntax ParseConditionalTail(ExpressionSyntax condition)
    {
        var questionToken = NextToken();
        var whenTrueMod = TryConsumeInnerRefModifier();
        var whenTrue = ParseAssignmentExpression();
        var colonToken = MatchToken(SyntaxKind.ColonToken);
        var whenFalseMod = TryConsumeInnerRefModifier();
        var whenFalse = ParseAssignmentExpression();

        if (whenTrueMod != null || whenFalseMod != null)
        {
            // Legacy ADR-0061 inner-modifier shape: keep producing the
            // dedicated ref-arg node so the binder retains GS0262 etc.
            return new ConditionalRefArgumentExpressionSyntax(
                syntaxTree,
                condition,
                questionToken,
                whenTrueMod,
                whenTrue,
                colonToken,
                whenFalseMod,
                whenFalse);
        }

        return new ConditionalExpressionSyntax(
            syntaxTree,
            condition,
            questionToken,
            whenTrue,
            colonToken,
            whenFalse);
    }

    // ADR-0061 transitional: kept only to avoid touching the few callers
    // that still want the legacy ref-only node when the `?` follows
    // certain ref-context shapes. Forwards to ParseConditionalTail.
    private ExpressionSyntax MaybeParseConditionalRefArgumentTail(ExpressionSyntax condition, SyntaxToken outerModifier)
    {
        if (Current.Kind != SyntaxKind.QuestionToken)
        {
            return condition;
        }

        _ = outerModifier; // bind-time check uses outer modifier; parser only records.
        return ParseConditionalTail(condition);
    }

    // ADR-0061: parse an optional inner `ref`/`in`/`out` modifier on a branch
    // of a conditional ref-argument. Returns the consumed token or null.
    private SyntaxToken TryConsumeInnerRefModifier()
    {
        if (Current.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var text = Current.Text;
        if (text != "ref" && text != "in" && text != "out")
        {
            return null;
        }

        var nextKind = Peek(1).Kind;

        // Only treat as a modifier if the next token starts a legal lvalue
        // payload (identifier or `(`). Otherwise leave it as a plain identifier.
        if (!(nextKind == SyntaxKind.IdentifierToken || nextKind == SyntaxKind.OpenParenthesisToken))
        {
            return null;
        }

        return NextToken();
    }

    // Issue #669: parse an if-expression of the form
    // `if cond { expr }`, `if cond { expr } else { expr }`,
    // or `if cond { expr } else if ... { expr } else { expr }`.
    // Issue #1602: depth-guarded wrapper — if-expressions self-recurse through
    // `else if` chains and through ParseBlockExpression/ParseBlockExpressionItem
    // (which dispatch back here without passing the expression pipeline).
    private IfExpressionSyntax ParseIfExpression()
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseIfExpressionCore();
        }
        finally
        {
            recursionDepth--;
        }
    }

    private IfExpressionSyntax ParseIfExpressionCore()
    {
        var ifKeyword = MatchToken(SyntaxKind.IfKeyword);
        suppressTrailingObjectInitializer++;
        suppressStructLiteral++;
        ExpressionSyntax condition;
        try
        {
            condition = ParseExpression();
        }
        finally
        {
            suppressStructLiteral--;
            suppressTrailingObjectInitializer--;
        }

        var thenBlock = ParseBlockExpression();

        SyntaxToken elseKeyword = null;
        ExpressionSyntax elseExpression = null;
        if (Current.Kind == SyntaxKind.ElseKeyword)
        {
            elseKeyword = NextToken();
            if (Current.Kind == SyntaxKind.IfKeyword)
            {
                elseExpression = ParseIfExpression();
            }
            else
            {
                elseExpression = ParseBlockExpression();
            }
        }

        return new IfExpressionSyntax(syntaxTree, ifKeyword, condition, thenBlock, elseKeyword, elseExpression);
    }

    // Issue #669: parse a block expression `{ stmt*; expr? }`.
    // The last item in the block, if it is an expression statement, becomes
    // the trailing value-producing expression of the block.
    private BlockExpressionSyntax ParseBlockExpression()
    {
        var statements = ImmutableArray.CreateBuilder<StatementSyntax>();
        ExpressionSyntax trailingExpression = null;

        var openBraceToken = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.EndOfFileToken &&
               Current.Kind != SyntaxKind.CloseBraceToken)
        {
            var startToken = Current;

            var statement = ParseBlockExpressionItem();
            statements.Add(statement);

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken);

        // If the last statement is an expression statement, treat its
        // expression as the block's trailing value-producing expression.
        if (statements.Count > 0 && statements[^1] is ExpressionStatementSyntax exprStmt)
        {
            statements.RemoveAt(statements.Count - 1);
            trailingExpression = exprStmt.Expression;
        }

        return new BlockExpressionSyntax(syntaxTree, openBraceToken, statements.ToImmutable(), trailingExpression, closeBraceToken);
    }

    // Issue #669: parse a single item inside a block expression. This is
    // similar to ParseStatement() but recognizes `if` as potentially
    // an if-expression (when followed by the block-expression shape).
    private StatementSyntax ParseBlockExpressionItem()
    {
        // If the current token is `if` and this could be an if-expression
        // (value-producing), parse it as an expression statement wrapping
        // an IfExpressionSyntax. This handles nested `if` in block position.
        // `if let` (ADR-0071) is always a statement, never a value-producing
        // if-expression, even when it ends in a plain `else { … }` — without
        // this check `LooksLikeIfExpression` would misparse `if let x = y {
        // … } else { … }` as an if-expression, since it only inspects the
        // shape of the trailing else, not the `let` after `if`.
        if (Current.Kind == SyntaxKind.IfKeyword && Peek(1).Kind != SyntaxKind.LetKeyword && LooksLikeIfExpression())
        {
            var ifExpr = ParseIfExpression();
            return new ExpressionStatementSyntax(syntaxTree, ifExpr);
        }

        return ParseStatement();
    }

    // Issue #669 / ADR-0128 / issue #1172 / issue #2349: lookahead to
    // determine whether an `if` at the current position is a value-producing
    // if-EXPRESSION rather than a void if-STATEMENT inside a block expression
    // (e.g. an arrow-lambda `-> { ... }` body, an if-expression then/else
    // block, or a standalone block expression).
    //
    // The disambiguation rule (ADR-0128 / issue #1172, refined by issue
    // #2349) has TWO independent requirements — both must hold for the `if`
    // to be treated as a value-producing if-expression:
    //
    //   1. SHAPE: the `if`/`else if` chain terminates in a plain
    //      `else { ... }` branch — only then does every code path yield a
    //      value (matching the binder's BindIfExpression, which requires a
    //      non-null ElseExpression). A chain that ends without a plain final
    //      `else` (no `else` at all, or a trailing `else if` with nothing
    //      after) has a path with no value.
    //
    //   2. POSITION: the chain is the LAST item in its enclosing block
    //      expression (i.e. immediately followed by that block's closing
    //      `}`), so it is actually eligible to become the block's trailing
    //      value-producing expression. Issue #2349: a mid-body `if`/`else`
    //      (more statements follow inside the same block) can never be used
    //      as a value — its result, if any, is always discarded — so it must
    //      be parsed as a void if-STATEMENT regardless of shape. Requiring
    //      value-producing THEN/ELSE arms for such an `if` was wrong: the
    //      arms are free to end in ordinary void statements (a method call,
    //      an assignment, …), and forcing them through the value-requiring
    //      block-expression binder produced a spurious GS0124 ("Expression
    //      must have a value") even though the `if` was never used as a
    //      value in the first place.
    //
    // This brings block-bodied arrow lambdas to parity with func literals: a
    // non-trailing `if`/`else if` chain (with or without a final `else`)
    // becomes a void statement, and only a trailing, else-terminated one
    // yields a value (or, for a void-typed lambda body, a void (Action-like)
    // lambda) instead of being rejected with GS0276/GS0124.
    //
    // We perform look-ahead only (no token consumption): we walk every link of
    // the `if`/`else if` chain. For each link we scan forward to its then-block
    // opening brace (the first `{` at paren/bracket depth zero after the `if`
    // keyword), then to its matching close brace (tracking brace depth, which
    // handles nested blocks). After the matching `}` we inspect what follows:
    //   * not `else`                -> void if-statement (return false);
    //   * `else if`                 -> continue walking from that inner `if`;
    //   * plain `else { ... }`      -> scan that final else-block to its own
    //                                  matching close brace, then require
    //                                  requirement 2 (tail position) above.
    private bool LooksLikeIfExpression()
    {
        // `i` is the offset of the `if` keyword for the current chain link.
        // Peek(0) is the current token (the leading `if`).
        var i = 0;
        while (true)
        {
            // Locate this link's then-block opening brace: the first `{` at
            // paren and bracket depth zero after the `if` keyword at offset i.
            var parenDepth = 0;
            var bracketDepth = 0;
            var j = i + 1;
            while (true)
            {
                if (j > LookaheadMaxScan)
                {
                    return false;
                }

                var k = Peek(j).Kind;
                if (k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }

                if (parenDepth == 0 && bracketDepth == 0 && k == SyntaxKind.OpenBraceToken)
                {
                    break;
                }

                switch (k)
                {
                    case SyntaxKind.OpenParenthesisToken:
                        parenDepth++;
                        break;
                    case SyntaxKind.CloseParenthesisToken:
                        if (parenDepth > 0)
                        {
                            parenDepth--;
                        }

                        break;
                    case SyntaxKind.OpenSquareBracketToken:
                        bracketDepth++;
                        break;
                    case SyntaxKind.CloseSquareBracketToken:
                        if (bracketDepth > 0)
                        {
                            bracketDepth--;
                        }

                        break;
                }

                j++;
            }

            // Scan from the then-block's opening brace to its matching close brace.
            var braceDepth = 0;
            while (true)
            {
                if (j > LookaheadMaxScan)
                {
                    return false;
                }

                var k = Peek(j).Kind;
                if (k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }

                if (k == SyntaxKind.OpenBraceToken)
                {
                    braceDepth++;
                }
                else if (k == SyntaxKind.CloseBraceToken)
                {
                    braceDepth--;
                    if (braceDepth == 0)
                    {
                        break;
                    }
                }

                j++;
            }

            // `j` is now at this link's matching close brace. Inspect what
            // follows to decide whether the chain continues or terminates.
            if (Peek(j + 1).Kind != SyntaxKind.ElseKeyword)
            {
                // No `else`: this link has a path with no value, so the whole
                // chain is a void if-statement.
                return false;
            }

            if (Peek(j + 2).Kind == SyntaxKind.IfKeyword)
            {
                // `else if`: continue walking the chain from the inner `if`.
                i = j + 2;
                continue;
            }

            // Plain final `else { ... }`: shape requirement satisfied (every
            // path yields a value). Issue #2349: also require the POSITION
            // requirement — this chain must be the last item in its
            // enclosing block expression, i.e. immediately followed by that
            // block's closing `}`, or it can never actually be used as a
            // value and must be a void if-statement instead. Scan the final
            // else-block to its own matching close brace to find that
            // position.
            var elseBraceDepth = 0;
            var m = j + 2;
            while (true)
            {
                if (m > LookaheadMaxScan)
                {
                    return false;
                }

                var k = Peek(m).Kind;
                if (k == SyntaxKind.EndOfFileToken)
                {
                    return false;
                }

                if (k == SyntaxKind.OpenBraceToken)
                {
                    elseBraceDepth++;
                }
                else if (k == SyntaxKind.CloseBraceToken)
                {
                    elseBraceDepth--;
                    if (elseBraceDepth == 0)
                    {
                        break;
                    }
                }

                m++;
            }

            // `m` is now at the final else-block's matching close brace.
            // Value-producing only when immediately followed by the
            // enclosing block expression's own closing brace (tail position).
            return Peek(m + 1).Kind == SyntaxKind.CloseBraceToken;
        }
    }

    // ADR-0060 helper for the optional `out var name T` / `out let name T` /
    // `out name T` type-clause: returns true when the current token is an
    // identifier that could start a G# type clause (excluding `,` / `)`).
    private bool CurrentTokenStartsTypeClause()
    {
        switch (Current.Kind)
        {
            case SyntaxKind.FuncKeyword:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.MapKeyword:
            case SyntaxKind.ChanKeyword:
            case SyntaxKind.SequenceKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.StarToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.IdentifierToken:
                return true;
            default:
                return false;
        }
    }

    private ExpressionSyntax ParseNameExpression()
    {
        var identifierToken = MatchToken(SyntaxKind.IdentifierToken);
        return new NameExpressionSyntax(syntaxTree, identifierToken);
    }

    private bool IsStructLiteralFollowingBrace(int braceOffsetPlusOne)
    {
        // braceOffsetPlusOne is the offset of the token AFTER the '{'. A struct
        // literal is empty (`}`), starts with a spread, or starts with `Identifier :`.
        var k0 = Peek(braceOffsetPlusOne).Kind;
        if (k0 == SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        if (k0 == SyntaxKind.EllipsisToken)
        {
            return true;
        }

        if (k0 == SyntaxKind.IdentifierToken && Peek(braceOffsetPlusOne + 1).Kind == SyntaxKind.ColonToken)
        {
            return true;
        }

        return false;
    }

    // In a body-header controlling expression (`if`/`while`/`for` clauses, a
    // `for-in` collection, …) bare struct literals are suppressed so a trailing
    // `{` opens the statement body (issue #1575). A NON-empty struct literal
    // (`Pt{X: 1}`) is unambiguous — `{ Ident : … }` cannot open a body — so it is
    // still admitted (`if Pt{X: 1} == p { }`). Only an EMPTY `Ident{}` collides
    // with an empty body: it is a struct literal solely when a real body `{`
    // follows it (`for v in Numbers{} { … }`); otherwise the identifier is the
    // controlling expression and the `{}` is the empty body (`if disposing { }`),
    // which previously mis-parsed as an empty struct literal (GS0157).
    // <paramref name="braceOffset"/> is the offset of the opening `{`.
    private bool StructLiteralAllowedInSuppressedHeader(int braceOffset)
    {
        if (Peek(braceOffset + 1).Kind != SyntaxKind.CloseBraceToken)
        {
            return true;
        }

        // Empty `Ident{}`: only a for-in collection may treat an empty struct
        // literal immediately followed by a body `{` as a struct literal.
        // In boolean if/while conditions the identifier is the condition and
        // `{}` is the empty body (`if disposing {} { .. }`).
        return allowEmptyStructLiteralInHeader
            && Peek(braceOffset + 2).Kind == SyntaxKind.OpenBraceToken;
    }

    private ExpressionSyntax ParseStructLiteralExpression()
    {
        var typeIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var (spreadToken, spreadExpression, spreadSeparator, initializers) = ParseStructLiteralInitializers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        return new StructLiteralExpressionSyntax(
            syntaxTree,
            typeIdentifier,
            openBrace,
            spreadToken,
            spreadExpression,
            spreadSeparator,
            initializers,
            closeBrace);
    }

    private (
        SyntaxToken SpreadToken,
        ExpressionSyntax SpreadExpression,
        SyntaxToken SpreadSeparator,
        SeparatedSyntaxList<FieldInitializerSyntax> Initializers)
        ParseStructLiteralInitializers()
    {
        SyntaxToken spreadToken = null;
        ExpressionSyntax spreadExpression = null;
        SyntaxToken spreadSeparator = null;
        if (Current.Kind == SyntaxKind.EllipsisToken)
        {
            spreadToken = MatchToken(SyntaxKind.EllipsisToken);
            spreadExpression = ParseExpression();
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                spreadSeparator = MatchToken(SyntaxKind.CommaToken);
            }
        }

        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            nodesAndSeparators.Add(ParseFieldInitializer());
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return (
            spreadToken,
            spreadExpression,
            spreadSeparator,
            new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable()));
    }

    private FieldInitializerSyntax ParseFieldInitializer()
    {
        var fieldId = MatchToken(SyntaxKind.IdentifierToken);
        var colon = MatchToken(SyntaxKind.ColonToken);
        var value = ParseFieldInitializerValue();
        return new FieldInitializerSyntax(syntaxTree, fieldId, colon, value);
    }

    // Issue #1567: a composite/object-initializer member value may be a braced
    // `{ elements }` collection initializer that populates a get-only collection
    // property by lowering to `.Add(...)` calls (the C# collection-initializer-
    // in-object-initializer pattern `Prop = { a, b }`). A brace can never start a
    // normal expression in value position, so its presence unambiguously selects
    // the target-less collection-initializer form; anything else is an ordinary
    // assignment value.
    private ExpressionSyntax ParseFieldInitializerValue()
    {
        if (Current.Kind == SyntaxKind.OpenBraceToken)
        {
            return ParseCollectionInitializerExpression(target: null);
        }

        return ParseExpression();
    }

    private SeparatedSyntaxList<FieldInitializerSyntax> ParseFieldEqualsInitializers()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var fieldId = MatchToken(SyntaxKind.IdentifierToken);
            var equals = MatchToken(SyntaxKind.EqualsToken);
            var value = ParseFieldInitializerValue();
            nodesAndSeparators.Add(new FieldInitializerSyntax(syntaxTree, fieldId, equals, value));
            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<FieldInitializerSyntax>(nodesAndSeparators.ToImmutable());
    }

    private ExpressionSyntax ParseParenthesizedExpression()
    {
        var left = MatchToken(SyntaxKind.OpenParenthesisToken);

        // Issue #522: a parenthesised expression is a fresh inner context —
        // even inside an `if (T() { X = 1 }) { body }` style header, the
        // inner call should still admit a trailing object initializer.
        ExpressionSyntax expression;
        var savedSuppress = suppressTrailingObjectInitializer;
        suppressTrailingObjectInitializer = 0;

        // A parenthesised expression is likewise a fresh context for the bare
        // `Ident { }` struct-literal form, so `(Pt{X: 1})` is recognised even
        // inside a body-header condition (`if p == (Pt{X: 1}) { }`, #1575).
        var savedStructLiteral = suppressStructLiteral;
        suppressStructLiteral = 0;

        // Issue #1038: a parenthesised expression is a fresh context, so a
        // parenthesised range (`a[(1..3)]`) is recognised as a standalone
        // `System.Range` value even inside an index bound.
        var savedRange = suppressRangeOperator;
        suppressRangeOperator = 0;
        try
        {
            expression = ParseExpression();
        }
        finally
        {
            suppressTrailingObjectInitializer = savedSuppress;
            suppressStructLiteral = savedStructLiteral;
            suppressRangeOperator = savedRange;
        }

        // ADR-0061: `(cond ? lvalue : lvalue)` parses as a conditional ref-arg
        // expression when a `?` immediately follows the inner expression. The
        // resulting node is only legal in ref-argument / `&` operand contexts;
        // the binder rejects it otherwise.
        if (Current.Kind == SyntaxKind.QuestionToken)
        {
            expression = MaybeParseConditionalRefArgumentTail(expression, outerModifier: null);
        }

        // Phase 4.5: `(a, b, ...)` is a tuple literal. Detection is purely
        // post-fix: parse the first expression, then if a comma follows we
        // collect the remaining tuple elements; otherwise this is a regular
        // parenthesized expression.
        if (Current.Kind == SyntaxKind.CommaToken)
        {
            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
            nodesAndSeparators.Add(expression);
            while (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
                nodesAndSeparators.Add(ParseExpression());
            }

            var rightParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            return new TupleLiteralExpressionSyntax(
                syntaxTree,
                left,
                new SeparatedSyntaxList<ExpressionSyntax>(nodesAndSeparators.ToImmutable()),
                rightParen);
        }

        var right = MatchToken(SyntaxKind.CloseParenthesisToken);
        return new ParenthesizedExpressionSyntax(syntaxTree, left, expression, right);
    }

    private ExpressionSyntax ParseBooleanLiteral()
    {
        var isTrue = Current.Kind == SyntaxKind.TrueKeyword;
        var keywordToken = isTrue ? MatchToken(SyntaxKind.TrueKeyword) : MatchToken(SyntaxKind.FalseKeyword);
        return new LiteralExpressionSyntax(syntaxTree, keywordToken, isTrue);
    }

    private ExpressionSyntax ParseNilLiteral()
    {
        var keywordToken = MatchToken(SyntaxKind.NilKeyword);
        return new LiteralExpressionSyntax(syntaxTree, keywordToken, null);
    }

    private ExpressionSyntax ParseNumberLiteral()
    {
        var numberToken = MatchToken(SyntaxKind.NumberToken);
        return new LiteralExpressionSyntax(syntaxTree, numberToken);
    }

    private ExpressionSyntax ParseCharacterLiteral()
    {
        var charToken = MatchToken(SyntaxKind.CharacterToken);
        return new LiteralExpressionSyntax(syntaxTree, charToken);
    }

    private ExpressionSyntax ParseStringLiteral()
    {
        var stringToken = MatchToken(SyntaxKind.StringToken);
        return new LiteralExpressionSyntax(syntaxTree, stringToken);
    }

    private ExpressionSyntax ParseInterpolatedStringLiteral()
    {
        var token = MatchToken(SyntaxKind.InterpolatedStringToken);
        var fragments = (ImmutableArray<InterpolationFragment>)token.Value;
        var segments = ImmutableArray.CreateBuilder<InterpolatedStringSegment>(fragments.Length);
        foreach (var fragment in fragments)
        {
            if (!fragment.IsExpression)
            {
                segments.Add(InterpolatedStringSegment.FromText(fragment.Text));
                continue;
            }

            // ADR-0055: a hole is `expr [ , alignment ] [ : format ]`. Split
            // the captured hole text into its expression / alignment / format
            // clauses with a delimiter-aware scanner that ignores `,`/`:`
            // nested inside (), [], {}, or string/char literals so that
            // `a.GetType()`, `dict["k"]`, and `cond ? "a" : "b"` (parenthesized)
            // are not mis-split.
            SplitHole(fragment.Text, out var exprText, out var alignmentText, out var formatText);

            // ADR-0055 §C: anchor diagnostics on the hole itself (using the
            // hole's true source offset) rather than the whole string token.
            var holeSpan = new TextSpan(fragment.Position, System.Math.Max(1, fragment.Text.Length));
            var holeLocation = new TextLocation(syntaxTree.Text, holeSpan);
            if (string.IsNullOrWhiteSpace(exprText))
            {
                Diagnostics.ReportEmptyInterpolationHole(holeLocation);
            }

            if (formatText != null && formatText.Length == 0)
            {
                Diagnostics.ReportEmptyInterpolationFormat(holeLocation);
            }

            int? alignment = null;
            if (alignmentText != null)
            {
                if (int.TryParse(alignmentText.Trim(), System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var a))
                {
                    alignment = a;
                }
                else
                {
                    Diagnostics.ReportInvalidInterpolationAlignment(holeLocation, alignmentText);
                }
            }

            // ADR-0055 §C / issue #1605: parse the captured expression directly out of
            // the outer syntax tree's own text, bounded to [fragment.Position,
            // fragment.Position + exprText.Length). Every inner token/node is built
            // against the SAME outer SyntaxTree, so its Position is already the true
            // absolute offset in the outer file — no padded-copy allocation or re-lex
            // of the file prefix is needed (that was O(fileSize) per hole).
            var innerParser = new Parser(syntaxTree, fragment.Position, fragment.Position + exprText.Length);
            var innerRoot = innerParser.ParseCompilationUnit();
            Diagnostics.AddRange(innerParser.Diagnostics);
            var innerExpression = ExtractFirstExpression(innerRoot);
            if (innerExpression == null)
            {
                // Fall back to a synthetic missing-name node anchored on the
                // hole (at its true offset) so binders still see a valid
                // (error-producing) expression syntax.
                var synthetic = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, fragment.Position, exprText, null);
                innerExpression = new NameExpressionSyntax(syntaxTree, synthetic);
            }

            segments.Add(InterpolatedStringSegment.FromExpression(innerExpression, alignment, formatText));
        }

        return new InterpolatedStringExpressionSyntax(syntaxTree, token, segments.ToImmutable());
    }

    // ADR-0055 delimiter-aware hole splitter. Finds the first top-level `,`
    // (alignment) and first top-level `:` (format), tracking ()/[]/{} depth
    // and skipping nested "…"/'…' literals. The expression clause is the text
    // before whichever delimiter appears first.
    private static void SplitHole(string hole, out string expr, out string alignment, out string format)
    {
        var depth = 0;
        var commaIndex = -1;
        var colonIndex = -1;
        for (var i = 0; i < hole.Length; i++)
        {
            var c = hole[i];
            if (c == '"' || c == '\'')
            {
                // Skip the nested literal, honoring `""`/`\` escapes loosely.
                var quote = c;
                i++;
                while (i < hole.Length && hole[i] != quote)
                {
                    if (hole[i] == '\\' && i + 1 < hole.Length)
                    {
                        i++;
                    }

                    i++;
                }

                continue;
            }

            if (c == '(' || c == '[' || c == '{')
            {
                depth++;
            }
            else if (c == ')' || c == ']' || c == '}')
            {
                depth--;
            }
            else if (depth == 0 && c == ',' && commaIndex < 0 && colonIndex < 0)
            {
                commaIndex = i;
            }
            else if (depth == 0 && c == ':' && colonIndex < 0)
            {
                colonIndex = i;
                break;
            }
        }

        alignment = null;
        format = null;
        if (commaIndex < 0 && colonIndex < 0)
        {
            expr = hole;
            return;
        }

        var exprEnd = commaIndex >= 0 ? commaIndex : colonIndex;
        expr = hole.Substring(0, exprEnd);
        if (commaIndex >= 0)
        {
            var alignEnd = colonIndex >= 0 ? colonIndex : hole.Length;
            alignment = hole.Substring(commaIndex + 1, alignEnd - commaIndex - 1);
        }

        if (colonIndex >= 0)
        {
            format = hole.Substring(colonIndex + 1);
        }
    }

    private static ExpressionSyntax ExtractFirstExpression(CompilationUnitSyntax innerRoot)
    {
        foreach (var member in innerRoot.Members)
        {
            if (member is GlobalStatementSyntax gs && gs.Statement is ExpressionStatementSyntax es)
            {
                return es.Expression;
            }
        }

        return null;
    }
}
