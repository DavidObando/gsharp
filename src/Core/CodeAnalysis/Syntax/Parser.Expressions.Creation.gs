// <copyright file="Parser.Expressions.Creation.cs" company="GSharp">
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
    private func ParseMapCreationExpression() ExpressionSyntax {
        // ADR-0104: map literal `map[K,V]{k1: v1, k2: v2, …}`.
        let typeClause = ParseMapTypeClause()
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let entries = ParseMapEntries()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return MapCreationExpressionSyntax(syntaxTree, typeClause, openBrace, entries, closeBrace)
    }

    private func ParseMapEntries() SeparatedSyntaxList[MapEntrySyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let key = ParseExpression()
            let colon = MatchToken(SyntaxKind.ColonToken)
            let value = ParseExpression()
            nodesAndSeparators.Add(MapEntrySyntax(syntaxTree, key, colon, value))
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[MapEntrySyntax](nodesAndSeparators.ToImmutable())
    }

    // ADR-0146 (Kotlin visibility narrowing follow-up): the same lead-in check as
    // IsAnonymousClassLiteralStart(), but probed one token past the current
    // position — used right after consuming a `->` arrow (Current is already the
    // token following the arrow) to decide whether an omitted return-type
    // expression-bodied function/method is a value-returning anonymous-class
    // literal rather than the ordinary void expression-statement shape.
    private func IsAnonymousClassLiteralStartAfterArrow() bool -> IsAnonymousClassLiteralStart(baseOffset: 1)

    private func IsAnonymousClassLiteralStart() bool -> IsAnonymousClassLiteralStart(baseOffset: 0)

    private func IsAnonymousClassLiteralStart(baseOffset int32) bool {
        // Detects the lead-in of an anonymous-object literal in any of its
        // redesigned shapes (ADR-0146 / issue #2243):
        //   object {            object : Type            (plain / inheriting)
        //   data object {       data object : Type       (data variant)
        // `data` and `object` are contextual identifiers, so this recognition
        // is intentionally narrow — every other position keeps parsing as
        // before.
        var offset = baseOffset
        if Peek(baseOffset).Kind == SyntaxKind.IdentifierToken && Peek(baseOffset).Text == "data" && Peek(
            baseOffset + 1
        ).Kind == SyntaxKind.IdentifierToken &&
            Peek(baseOffset + 1).Text == "object" {
            offset = baseOffset + 1
        }
        if !(Peek(offset).Kind == SyntaxKind.IdentifierToken && Peek(offset).Text == "object") {
            return false
        }
        let afterObject = Peek(offset + 1).Kind
        return afterObject == SyntaxKind.OpenBraceToken || afterObject == SyntaxKind.ColonToken
    }

    private func ParseAnonymousClassExpression() ExpressionSyntax {
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
        var dataKeyword SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data" {
            dataKeyword = NextToken()
        }
        let objectKeyword = NextToken()
        // Optional base/interface clause `: Base[(args)] [, IFace, ...]`,
        // parsed exactly like a class declaration's base clause.
        var baseColon SyntaxToken? = nil
        var baseTypeClause TypeClauseSyntax? = nil
        var baseCtorOpenParen SyntaxToken? = nil
        var baseCtorArguments = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        var baseCtorCloseParen SyntaxToken? = nil
        let additionalBaseNodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        if Current.Kind == SyntaxKind.ColonToken {
            baseColon = MatchToken(SyntaxKind.ColonToken)
            baseTypeClause = ParseTypeClause()
            if Current.Kind == SyntaxKind.OpenParenthesisToken {
                baseCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken)
                baseCtorArguments = ParseArguments()
                baseCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken)
            }
            while Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                additionalBaseNodesAndSeparators.Add(comma)
                additionalBaseNodesAndSeparators.Add(ParseTypeClause())
            }
        }
        let additionalBaseTypeClauses = SeparatedSyntaxList[TypeClauseSyntax](
            additionalBaseNodesAndSeparators.ToImmutable()
        )
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let members = ParseAnonymousClassMembers()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return AnonymousClassExpressionSyntax(
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
            closeBrace
        )
    }

    private func ParseAnonymousClassMembers() ImmutableArray[SyntaxNode] {
        // Members are newline/semicolon separated (like ordinary class/struct
        // bodies), never comma separated. Each sub-parser consumes its own
        // terminator, so the loop simply repeats until the closing brace.
        let members = ImmutableArray.CreateBuilder[SyntaxNode]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            // Members are newline- or semicolon-separated. Newlines are not
            // tokens (the next member's lead keyword simply follows), so only
            // explicit semicolon separators need to be consumed here.
            if Current.Kind == SyntaxKind.SemicolonToken {
                NextToken()
                continue
            }
            let startToken = Current
            // Optional `open`/`override` modifiers preceding a method.
            var memberOpenModifier SyntaxToken? = nil
            var memberOverrideModifier SyntaxToken? = nil
            while Current.Kind == SyntaxKind.OpenKeyword || Current.Kind == SyntaxKind.OverrideKeyword {
                if Current.Kind == SyntaxKind.OpenKeyword && memberOpenModifier == nil {
                    memberOpenModifier = NextToken()
                } else if Current.Kind == SyntaxKind.OverrideKeyword && memberOverrideModifier == nil {
                    memberOverrideModifier = NextToken()
                } else {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword)
                    NextToken()
                }
            }
            if Current.Kind == SyntaxKind.IdentifierToken &&
                Current.Text == "init" &&
                (Peek(1).Kind == SyntaxKind.OpenParenthesisToken) {
                // Reject `init(...)` — anonymous objects have no user ctors.
                Diagnostics.ReportInitDeinitNotAllowedInAnonymousObject(Current.Location, "init")
                ParseConstructorDeclaration(accessibilityModifier: nil, convenienceModifier: nil)
            } else if Current.Kind == SyntaxKind.FuncKeyword && Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(
                1
            ).Text == "init" &&
                Peek(2).Kind == SyntaxKind.OpenParenthesisToken {
                // Reject `func init(...)`.
                Diagnostics.ReportInitDeinitNotAllowedInAnonymousObject(Current.Location, "init")
                NextToken()
                ParseConstructorDeclaration(accessibilityModifier: nil, convenienceModifier: nil)
            } else if Current.Kind == SyntaxKind.IdentifierToken &&
                Current.Text == "deinit" &&
                (Peek(1).Kind == SyntaxKind.OpenBraceToken || Peek(1).Kind == SyntaxKind.OpenParenthesisToken) {
                // Reject `deinit { ... }`.
                Diagnostics.ReportInitDeinitNotAllowedInAnonymousObject(Current.Location, "deinit")
                ParseDeinitDeclaration()
            } else if Current.Kind == SyntaxKind.FuncKeyword {
                members.Add(
                    ParseFunctionDeclaration(accessibilityModifier: nil, memberOpenModifier, memberOverrideModifier)
                )
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event" {
                members.Add(
                    ParseEventDeclaration(accessibilityModifier: nil, memberOpenModifier, memberOverrideModifier)
                )
            } else if Current.Kind == SyntaxKind.LetKeyword || Current.Kind == SyntaxKind.VarKeyword {
                if memberOpenModifier != nil || memberOverrideModifier != nil {
                    // The enclosing `if` tests these same modifiers for non-null,
                    // so the coalesce always yields one of them.
                    let loc = (memberOpenModifier ?? memberOverrideModifier)!!.Location
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.FuncKeyword)
                }
                members.Add(ParseAnonymousClassFieldMember())
            } else {
                // Unrecognised member start — surface a diagnostic and recover.
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.LetKeyword)
            }
            if Current == startToken {
                NextToken()
            }
        }
        return members.ToImmutable()
    }

    private func ParseAnonymousClassFieldMember() AnonymousClassMemberInitializerSyntax {
        // `let/var Name [Type] = expr` — the type clause is optional and
        // inferred from the initializer when omitted, exactly like an ordinary
        // local `let` declaration.
        let letOrVarKeyword = NextToken()
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        var typeClause TypeClauseSyntax? = nil
        if Current.Kind != SyntaxKind.EqualsToken {
            typeClause = ParseTypeClause()
        }
        let equals = MatchToken(SyntaxKind.EqualsToken)
        let value = ParseExpression()
        return AnonymousClassMemberInitializerSyntax(syntaxTree, letOrVarKeyword, identifier, typeClause, equals, value)
    }

    private func ParseArrayCreationExpression() ExpressionSyntax {
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        // Parse the optional length. A lone numeric literal immediately followed
        // by `]` is captured as the literal `LengthToken` so the existing
        // constant-count literal form (`[N]T{…}`, with its GS0115 check) and the
        // count-inferred slice form (`[]T{…}`, empty brackets) are unchanged.
        // Any other (runtime) length expression — issue #1272 — is captured as a
        // full `LengthExpression`.
        var lengthToken SyntaxToken? = nil
        var lengthExpression ExpressionSyntax? = nil
        var dimensions SeparatedSyntaxList[ExpressionSyntax]? = nil
        if Current.Kind != SyntaxKind.CloseSquareBracketToken {
            if Current.Kind == SyntaxKind.NumberToken && Peek(1).Kind == SyntaxKind.CloseSquareBracketToken {
                lengthToken = MatchToken(SyntaxKind.NumberToken)
            } else {
                let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
                lengthExpression = ParseExpression()
                nodesAndSeparators.Add(lengthExpression)
                while Current.Kind == SyntaxKind.CommaToken {
                    nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                    nodesAndSeparators.Add(ParseExpression())
                }
                if nodesAndSeparators.Count > 1 {
                    dimensions = SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
                }
            }
        }
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
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
        // ADR-0174 D2: `in`/`out` are contextual identifiers, so an element type
        // headed by one (`[]in chan[T]{ … }`) must take the composite path or
        // the direction would be read as the element's type name.
        if Current.Kind != SyntaxKind.IdentifierToken || Peek(1).Kind == SyntaxKind.OpenSquareBracketToken || Peek(
            1
        ).Kind == SyntaxKind.DotToken ||
            IsReadOnlyManagedHead() ||
            IsChannelDirectionHead() {
            let nestedElementType = ParseTypeClause()
            let (nestedOpenBrace, nestedElements, nestedCloseBrace, nestedHasElements) = ParseOptionalArrayInitializer(
                allowSpread: lengthExpression == nil && lengthToken == nil
            )
            if dimensions != nil {
                return ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    dimensions,
                    closeBracket,
                    nestedElementType,
                    nestedOpenBrace,
                    nestedElements,
                    nestedCloseBrace
                )
            }
            // Issue #1272: the no-initializer (or empty-initializer) form with a
            // length yields the runtime/zero-initialised allocation `[n][]T`.
            if !nestedHasElements && (lengthExpression != nil || lengthToken != nil) {
                // The enclosing `if` requires one of lengthExpression/lengthToken, and
                // the coalesce only reaches lengthToken when lengthExpression is null.
                return ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    lengthExpression ?? LiteralExpressionSyntax(syntaxTree, lengthToken!!),
                    closeBracket,
                    nestedElementType,
                    nestedOpenBrace,
                    nestedElements,
                    nestedCloseBrace
                )
            }
            // The enclosing `if` requires one of lengthExpression/lengthToken, and
            // the coalesce only reaches lengthToken when lengthExpression is null.
            return ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                if lengthExpression == nil {
                    lengthToken
                } else {
                    ToLengthLiteralToken(lengthExpression)
                },
                closeBracket,
                nestedElementType,
                nestedOpenBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
                nestedElements ?? SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
                nestedCloseBrace ?? MatchToken(SyntaxKind.CloseBraceToken)
            )
        }
        let elementType = MatchToken(SyntaxKind.IdentifierToken)
        // Issue #1212: an element-nullable array literal `[]T?{ … }` /
        // `[N]T?{ … }`. The `?` binds to the element identifier, so route the
        // element through a nullable-suffixed type clause (the nested-element
        // path) instead of the bare-identifier fast path, yielding a
        // `Slice(Nullable(T))` / `Array(Nullable(T), N)`.
        if Current.Kind == SyntaxKind.QuestionToken {
            let questionToken = MatchToken(SyntaxKind.QuestionToken)
            let elementClause = TypeClauseSyntax(
                syntaxTree,
                openBracketToken: nil,
                lengthToken: nil,
                closeBracketToken: nil,
                elementType,
                questionToken
            )
            let (nElemOpenBrace, nElemElements, nElemCloseBrace, nElemHasElements) = ParseOptionalArrayInitializer(
                allowSpread: lengthExpression == nil && lengthToken == nil
            )
            if dimensions != nil {
                return ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    dimensions,
                    closeBracket,
                    elementClause,
                    nElemOpenBrace,
                    nElemElements,
                    nElemCloseBrace
                )
            }
            if !nElemHasElements && (lengthExpression != nil || lengthToken != nil) {
                // The enclosing `if` requires one of lengthExpression/lengthToken, and
                // the coalesce only reaches lengthToken when lengthExpression is null.
                return ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    lengthExpression ?? LiteralExpressionSyntax(syntaxTree, lengthToken!!),
                    closeBracket,
                    elementClause,
                    nElemOpenBrace,
                    nElemElements,
                    nElemCloseBrace
                )
            }
            // The enclosing `if` requires one of lengthExpression/lengthToken, and
            // the coalesce only reaches lengthToken when lengthExpression is null.
            return ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                if lengthExpression == nil {
                    lengthToken
                } else {
                    ToLengthLiteralToken(lengthExpression)
                },
                closeBracket,
                elementClause,
                nElemOpenBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
                nElemElements ?? SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
                nElemCloseBrace ?? MatchToken(SyntaxKind.CloseBraceToken)
            )
        }
        let (openBrace, elements, closeBrace, hasElements) = ParseOptionalArrayInitializer(
            allowSpread: lengthExpression == nil && lengthToken == nil
        )
        // Issue #1272: `[n]T` (no initializer) or `[n]T{}` (empty initializer)
        // with a runtime length is the zero-initialised allocation form. A lone
        // numeric literal length without a non-empty initializer (`[5]T`,
        // `[5]T{}`) is likewise a (constant-length) zero-initialised allocation.
        if !hasElements && (lengthExpression != nil || lengthToken != nil) {
            if dimensions != nil {
                return ArrayCreationExpressionSyntax(
                    syntaxTree,
                    openBracket,
                    dimensions,
                    closeBracket,
                    elementType,
                    openBrace,
                    elements,
                    closeBrace
                )
            }
            // The enclosing `if` requires one of lengthExpression/lengthToken, and
            // the coalesce only reaches lengthToken when lengthExpression is null.
            return ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                lengthExpression ?? LiteralExpressionSyntax(syntaxTree, lengthToken!!),
                closeBracket,
                elementType,
                openBrace,
                elements,
                closeBrace
            )
        }
        if dimensions != nil {
            return ArrayCreationExpressionSyntax(
                syntaxTree,
                openBracket,
                dimensions,
                closeBracket,
                elementType,
                openBrace,
                elements,
                closeBrace
            )
        }
        return ArrayCreationExpressionSyntax(
            syntaxTree,
            openBracket,
            if lengthExpression == nil {
                lengthToken
            } else {
                ToLengthLiteralToken(lengthExpression)
            },
            closeBracket,
            elementType,
            openBrace ?? MatchToken(SyntaxKind.OpenBraceToken),
            elements ?? SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
            closeBrace ?? MatchToken(SyntaxKind.CloseBraceToken)
        )
    }

    // Parses an optional brace-delimited array initializer. Returns null tokens
    // when no `{` is present (the issue #1272 no-initializer form), and reports
    // whether any element expressions were supplied (an empty `{}` counts as the
    // zero-initialised allocation form, not a literal).
    private func ParseOptionalArrayInitializer(allowSpread bool)(
        OpenBrace SyntaxToken?,
        Elements SeparatedSyntaxList[ExpressionSyntax]?,
        CloseBrace SyntaxToken?,
        HasElements bool
    ) {
        if Current.Kind != SyntaxKind.OpenBraceToken {
            return (nil, nil, nil, false)
        }
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let elements = ParseArrayInitializerElements(allowSpread)
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return (openBrace, elements, closeBrace, elements.Count > 0)
    }

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
    private func ParseStackAllocExpression() ExpressionSyntax {
        let stackAllocKeyword = MatchToken(SyntaxKind.IdentifierToken)
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        // The count is optional: the `stackalloc []T{ … }` shape infers it from
        // the initializer length, so an immediate `]` leaves CountExpression null.
        var count ExpressionSyntax? = nil
        if Current.Kind != SyntaxKind.CloseSquareBracketToken {
            count = ParseExpression()
        }
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        let elementType = MatchToken(SyntaxKind.IdentifierToken)
        // The brace-delimited initializer is optional for the count-only form
        // (`stackalloc [n]T`) and required for the count-inferred form
        // (`stackalloc []T{ … }`); the binder enforces that requirement.
        var openBrace SyntaxToken? = nil
        var elements SeparatedSyntaxList[ExpressionSyntax]? = nil
        var closeBrace SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenBraceToken {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken)
            elements = ParseArrayInitializerElements(allowSpread: false)
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        }
        return StackAllocExpressionSyntax(
            syntaxTree,
            stackAllocKeyword,
            openBracket,
            count,
            closeBracket,
            elementType,
            openBrace,
            elements,
            closeBrace
        )
    }

    // ADR-0125 / issue #1026: `fixed name *T = source { … }`. The leading
    // `fixed` is a contextual keyword; the dispatcher in ParseStatement only
    // routes here for the exact `fixed IDENT *` shape. The header mirrors G#'s
    // other paren-less statement headers (`if`/`for`/`while`/`unsafe { }`).
    private func ParseFixedStatement() StatementSyntax {
        let fixedKeyword = MatchToken(SyntaxKind.IdentifierToken)
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let typeClause = ParseTypeClause()
        let equalsToken = MatchToken(SyntaxKind.EqualsToken)
        // Suppress bare struct literals (`Ident { }`) and trailing object
        // initializers so the `{` after the source expression is parsed as the
        // pinned body block, not as part of the source — mirroring the
        // `if let` / `for` header treatment.
        suppressTrailingObjectInitializer++
        suppressStructLiteral++
        var pinnedSource ExpressionSyntax
        try {
            pinnedSource = ParseExpression()
        } finally {
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
        let body = ParseBlockStatement()
        return FixedStatementSyntax(syntaxTree, fixedKeyword, identifier, typeClause, equalsToken, pinnedSource, body)
    }

    private func ParseArrayInitializerElements(allowSpread bool) SeparatedSyntaxList[ExpressionSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            if allowSpread && Current.Kind == SyntaxKind.EllipsisToken {
                let ellipsis = MatchToken(SyntaxKind.EllipsisToken)
                nodesAndSeparators.Add(SpreadElementExpressionSyntax(syntaxTree, ellipsis, ParseExpression()))
            } else {
                nodesAndSeparators.Add(ParseExpression())
            }
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
    }

    private func TryFindMatchingCloseBracketFollowedByEquals(out offset int32) bool {
        offset = 0
        var depth = 0
        for var i = 1; i <= LookaheadMaxScan; i++ {
            let kind = Peek(i).Kind
            if kind == SyntaxKind.EndOfFileToken {
                return false
            }
            if kind == SyntaxKind.OpenSquareBracketToken {
                depth++
            } else if kind == SyntaxKind.CloseSquareBracketToken {
                depth--
                if depth == 0 {
                    if Peek(i + 1).Kind == SyntaxKind.EqualsToken {
                        offset = i + 1
                        return true
                    }
                    return false
                }
            }
        }
        return false
    }

    /// @param isMemberName Whether this parses the member name after `.`,
    /// `?.` or `->`. A member named `cast` is an ordinary member, never the
    /// reserved `cast[T](x)` intrinsic.
    private func ParseNameOrCallExpression(
        stopBeforeIndirectInvocation bool = false,
        allowContextualOperators bool = true,
        isMemberName bool = false
    ) ExpressionSyntax {
        var current ExpressionSyntax
        let isCastIntrinsic = !isMemberName && IsCastIntrinsicHead()
        if IsReadOnlyManagedHead() || IsReadOnlyManagedHead(address: true) {
            current = ParseReadOnlyManagedExpression()
        } else if IsReadOnlySliceHead() ||
            (
            Current.Kind == SyntaxKind.IdentifierToken && (Current.Text is "slice" or "array") && Peek(
                1
            ).Kind == SyntaxKind.OpenSquareBracketToken &&
                LooksLikeGenericCallSite(1)
        ) {
            current = ParseNativeBufferExpression()
        } else if allowContextualOperators &&
            Current.Kind == SyntaxKind.IdentifierToken &&
            Current.Text == "make" &&
            Peek(1).Kind == SyntaxKind.OpenParenthesisToken && Peek(2).Kind == SyntaxKind.ChanKeyword {
            // Phase 5.4 / ADR-0022: contextual `make(chan T)` / `make(chan T, capacity)`.
            current = ParseMakeChannelExpression()
        } else if allowContextualOperators &&
            Current.Kind == SyntaxKind.IdentifierToken &&
            Current.Text == "typeof" &&
            Peek(1).Kind == SyntaxKind.OpenParenthesisToken {
            // Issue #143: contextual `typeof(T)` — argument is a type clause.
            current = ParseTypeOfExpression()
        } else if allowContextualOperators &&
            Current.Kind == SyntaxKind.IdentifierToken &&
            Current.Text == "sizeof" &&
            Peek(1).Kind == SyntaxKind.OpenParenthesisToken {
            // Issue #1336: contextual `sizeof(T)` — argument is a type clause.
            current = ParseSizeOfExpression()
        } else if allowContextualOperators &&
            Current.Kind == SyntaxKind.IdentifierToken &&
            (Current.Text == "checked" || Current.Text == "unchecked") &&
            Peek(1).Kind == SyntaxKind.OpenParenthesisToken {
            // Issue #1881: contextual `checked(expr)` / `unchecked(expr)` —
            // argument is an arithmetic expression, not a type clause.
            current = ParseCheckedExpression()
        } else if allowContextualOperators &&
            Current.Kind == SyntaxKind.IdentifierToken &&
            Current.Text == "nameof" &&
            Peek(1).Kind == SyntaxKind.OpenParenthesisToken {
            // Issue #143: contextual `nameof(expr)` — argument is a name reference.
            current = ParseNameOfExpression()
        } else if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenParenthesisToken &&
            !IsTokenOnNewLineAfter(Peek(1), Current) {
            current = ParseCallExpression()
            current = MaybeWrapWithObjectInitializer(current)
        } else if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.QuestionToken && Peek(
            2
        ).Kind == SyntaxKind.OpenParenthesisToken &&
            Peek(1).Position == Current.Span.End && Peek(2).Position == Peek(1).Span.End {
            // Issue #663: `string?(expr)` — nullable-type conversion call.
            // The binder also treats this syntax as a null-conditional delegate
            // invocation when the identifier resolves to a callable value.
            current = ParseNullableTypeCallExpression()
        } else if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken &&
            LooksLikeGenericCallSite(1, pointerArgumentsAllowed: isCastIntrinsic) {
            current = ParseGenericCallExpression(castIntrinsic: isCastIntrinsic)
            current = MaybeWrapWithObjectInitializer(current)
        } else if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenBraceToken &&
            IsStructLiteralFollowingBrace(2) &&
            (suppressStructLiteral == 0 || StructLiteralAllowedInSuppressedHeader(1)) {
            current = ParseStructLiteralExpression()
        } else {
            current = ParseNameExpression()
        }
        return ParsePostfixChain(current, stopBeforeIndirectInvocation)
    }

    private func ParseReadOnlyManagedExpression() ExpressionSyntax {
        let modifier = NextToken()
        if Peek(1).Kind == SyntaxKind.OpenParenthesisToken {
            let call = ParseCallExpression()
            call.ReadOnlyManagedModifier = modifier
            return call
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let arguments = ParseTypeArgumentList()
        if Current.Kind == SyntaxKind.DotToken {
            return GenericNameExpressionSyntax(syntaxTree, identifier, arguments){ReadOnlyManagedModifier = modifier}
        }
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            NextToken()
        } else {
            default(SyntaxToken?)
        }
        let type = TypeClauseSyntax(
            syntaxTree,
            nil,
            nil,
            nil,
            identifier,
            arguments.OpenBracketToken,
            arguments.Arguments,
            arguments.CloseBracketToken,
            question
        ){ReadOnlyManagedModifier = modifier}
        let open_ = MatchToken(SyntaxKind.OpenParenthesisToken)
        let values = ParseArguments()
        let close = MatchToken(SyntaxKind.CloseParenthesisToken)
        return CallExpressionSyntax(syntaxTree, type, open_, values, close)
    }

    private func ParseNativeBufferExpression() ExpressionSyntax {
        let modifier SyntaxToken? = if IsReadOnlySliceHead() {
            NextToken()
        } else {
            default(SyntaxToken?)
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let arguments = ParseTypeArgumentList()
        if Current.Kind == SyntaxKind.DotToken {
            return GenericNameExpressionSyntax(syntaxTree, identifier, arguments){ReadOnlySliceModifier = modifier}
        }
        let question = if Current.Kind == SyntaxKind.QuestionToken {
            NextToken()
        } else {
            default(SyntaxToken?)
        }
        let type = TypeClauseSyntax(
            syntaxTree,
            nil,
            nil,
            nil,
            identifier,
            arguments.OpenBracketToken,
            arguments.Arguments,
            arguments.CloseBracketToken,
            question
        ){ReadOnlySliceModifier = modifier}
        if Current.Kind == SyntaxKind.OpenBraceToken {
            if modifier == nil && !BraceLooksLikeGenericCollectionInitializer() {
                let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
                let (spreadToken, spreadExpression, spreadSeparator, elements) = ParseStructLiteralInitializers()
                let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
                return StructLiteralExpressionSyntax(
                    syntaxTree,
                    identifier,
                    openBrace,
                    spreadToken,
                    spreadExpression,
                    spreadSeparator,
                    elements,
                    closeBrace
                ){TypeArgumentList = arguments}
            }
            let literal = cast[CollectionInitializerExpressionSyntax](ParseCollectionInitializerExpression(nil))
            literal.BufferType = type
            return literal
        }
        let open_ = MatchToken(SyntaxKind.OpenParenthesisToken)
        let values = ParseArguments()
        let close = MatchToken(SyntaxKind.CloseParenthesisToken)
        return CallExpressionSyntax(syntaxTree, type, open_, values, close)
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
    //
    // Issue #4938: `cast` is reserved in CALL position (ADR-0167), so
    // `cast[*T](x)` cannot be an indexer-then-call; the caller passes
    // `pointerArgumentsAllowed` for that name only. The permission applies
    // only when `(` follows the brackets: `cast[*p].Length` on a variable
    // named `cast` is not a call, so it is classified by the ordinary rules
    // and stays an indexer over a dereference.
    private func LooksLikeGenericCallSite(bracketOffset int32, pointerArgumentsAllowed bool = false) bool {
        if pointerArgumentsAllowed &&
            TryScanBracketedTypeArguments(bracketOffset, pointerAllowed: true, out var callPos, out _, out _) &&
            Peek(callPos).Kind == SyntaxKind.OpenParenthesisToken {
            return true
        }
        if !TryScanBracketedTypeArguments(
            bracketOffset,
            pointerAllowed: false,
            out var pos,
            out var typeArgumentCount,
            out var sawComplexTypeArgument
        ) {
            return false
        }
        // Follow-set per ADR-0020: '(' (call), '{' (composite literal), '.' (member access).
        let nextKind = Peek(pos).Kind
        if nextKind == SyntaxKind.OpenParenthesisToken {
            return true
        }
        if nextKind == SyntaxKind.OpenBraceToken {
            if IsTokenOnNewLineAfter(Peek(pos), Peek(pos - 1)) {
                return false
            }
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
            if suppressTrailingObjectInitializer > 0 {
                return false
            }
            return true
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
        if nextKind == SyntaxKind.QuestionToken && Peek(pos + 1).Kind == SyntaxKind.OpenParenthesisToken && Peek(
            pos
        ).Position == Peek(pos - 1).Span.End && Peek(pos + 1).Position == Peek(pos).Span.End {
            return true
        }
        return nextKind == SyntaxKind.DotToken && (typeArgumentCount > 1 || sawComplexTypeArgument)
    }

    /// Scans `[ T1, T2, … ]` starting at [`bracketOffset`](paramref), each
    /// item a type clause, for (cref:LooksLikeGenericCallSite).
    /// @param bracketOffset The offset of the `[` token relative to Current.
    /// @param pointerAllowed Whether a top-level `*T` item is accepted.
    /// @param endPos The offset just past the matching `]`.
    /// @param typeArgumentCount The number of items scanned.
    /// @param sawComplexTypeArgument Whether any item is unambiguously a type.
    /// @returns Whether every item scanned as a type clause.
    private func TryScanBracketedTypeArguments(
        bracketOffset int32,
        pointerAllowed bool,
        out endPos int32,
        out typeArgumentCount int32,
        out sawComplexTypeArgument bool
    ) bool {
        endPos = bracketOffset
        typeArgumentCount = 0
        sawComplexTypeArgument = false
        if Peek(bracketOffset).Kind != SyntaxKind.OpenSquareBracketToken {
            return false
        }
        var pos = bracketOffset + 1
        if Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken {
            return false
        }
        while true {
            if !TryScanTypeClause(&pos, out var argumentIsComplex, pointerAllowed) {
                return false
            }
            typeArgumentCount++
            sawComplexTypeArgument |= argumentIsComplex
            if Peek(pos).Kind == SyntaxKind.CommaToken {
                pos++
                continue
            }
            if Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken {
                endPos = pos + 1
                return true
            }
            return false
        }
    }

    private func TryScanTypeClause(ref pos int32) bool -> TryScanTypeClause(&pos, out _)

    /// ADR-0172: speculative-cursor twin of the committed parser's
    /// `LooksLikeTupleElementName` — decides whether the identifier at
    /// [`pos`](paramref) is a tuple-element NAME (followed by a token
    /// that can start a type clause) rather than the element type itself.
    private func ScanLooksLikeTupleElementNameAt(pos int32) bool {
        if IsFunctionPointerTypeHead(pos) {
            return false
        }
        // ADR-0174 D2: a directional channel head, not an element name.
        if (Peek(pos).Text == "in" || Peek(pos).Text == "out") && Peek(pos + 1).Kind == SyntaxKind.ChanKeyword {
            return false
        }
        switch Peek(pos + 1).Kind {
            case SyntaxKind.IdentifierToken,
            SyntaxKind.FuncKeyword,
            SyntaxKind.MapKeyword,
            SyntaxKind.ChanKeyword,
            SyntaxKind.SequenceKeyword,
            SyntaxKind.AsyncKeyword,
            SyntaxKind.StarToken,
            SyntaxKind.OpenParenthesisToken {
                return true
            }
            case SyntaxKind.OpenSquareBracketToken {
                return (
                    Peek(pos + 2).Kind is SyntaxKind.CloseSquareBracketToken or
                        SyntaxKind.NumberToken or
                        SyntaxKind.CommaToken
                )
            }
            default {
                return false
            }
        }
    }

    // Issue #1602: depth-guarded wrapper — TryScanTypeClause and
    // TryScanOptionalTypeArgumentList are mutually recursive during
    // speculative lookahead (`a[a[a[…` scans as a candidate type-argument
    // list). Speculation must fail GRACEFULLY at the limit: it returns false
    // without reporting, and the subsequent real parse (which takes the
    // non-generic interpretation) reports GS0417 if it also runs too deep.
    /// @param pointerAllowed Whether a plain pointer clause `*T` may start
    /// at [`pos`](paramref). It may not in a generic type-argument position,
    /// where `xs[*p](y)` must stay an indexer over a dereference (and where
    /// `ParseGenericTypeArgument` rejects a pointer anyway, GS0521). It may in
    /// the positions `ParseTypeClause` reaches with no such ambiguity: a
    /// pointer's pointee, a function-pointer signature, and the type argument
    /// of the reserved `cast[T](x)` intrinsic (issue #4938).
    private func TryScanTypeClause(ref pos int32, out isComplex bool, pointerAllowed bool = false) bool {
        if recursionDepth >= MaxRecursionDepth {
            isComplex = false
            return false
        }
        if recursionDepth >= UncheckedRecursionDepth {
            try {
                RuntimeHelpers.EnsureSufficientExecutionStack()
            } catch (InsufficientExecutionStackException) {
                isComplex = false
                return false
            }
        }
        recursionDepth++
        try {
            return TryScanTypeClauseCore(&pos, out isComplex, pointerAllowed)
        } finally {
            recursionDepth--
        }
    }

    private func TryScanTypeClauseCore(ref pos int32, out isComplex bool, pointerAllowed bool) bool {
        isComplex = false
        // Optional leading bracketed segments: '[' ']' or '[' Number ']' for
        // slice/array shapes. Issue #2830: a jagged shape stacks them
        // (`[][]int32`, `[2][]T`), so this loops — matching the real
        // `ParseTypeClause` nesting that issue #1046 introduced. Scanning only
        // one segment made `List[[][]int32]{ … }` fail to be recognised as a
        // generic composite-literal site.
        var openBracketAlreadyConsumed = false
        while openBracketAlreadyConsumed || Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken {
            // An array/slice prefix is unambiguously a type shape (Issue #1323).
            isComplex = true
            if !openBracketAlreadyConsumed {
                pos++
            }
            openBracketAlreadyConsumed = false
            if Peek(pos).Kind == SyntaxKind.NumberToken {
                pos++
            } else {
                while Peek(pos).Kind == SyntaxKind.CommaToken {
                    pos++
                }
            }
            if Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken {
                return false
            }
            pos++
            if Peek(pos).Kind == SyntaxKind.QuestionOpenBracketToken {
                pos++
                openBracketAlreadyConsumed = true
            } else if Peek(pos).Kind == SyntaxKind.QuestionToken {
                pos++
            }
        }
        if IsReadOnlySliceHead(pos) || IsReadOnlyManagedHead(pos) {
            pos++
            isComplex = true
        }
        if !CanStartTypeClause(Peek(pos)) {
            return false
        }
        // CLR generic arguments cannot be pointer types. Keep `*T` on its
        // existing rejection path in generic-argument positions, but scan the
        // distinct `*func(T) R` production accepted by ParseTypeClauseCore.
        // Where a pointer is allowed, mirror ParseTypeClauseCore's
        // `*` pointee `?` production.
        var isManagedFunctionPointer = false
        if Peek(pos).Kind == SyntaxKind.StarToken {
            isComplex = true
            pos++
            if Peek(pos).Kind != SyntaxKind.FuncKeyword {
                if !pointerAllowed || !TryScanTypeClause(&pos, out _, pointerAllowed: true) {
                    return false
                }
                if Peek(pos).Kind == SyntaxKind.QuestionToken {
                    pos++
                }
                return true
            }
            isManagedFunctionPointer = true
        }
        // ADR-0075: `async (T) -> R` and `func(T) R` start a function-type clause.
        // Handle the optional leading `async` modifier here so the next token
        // is the actual head of the function-type clause.
        var hasAsyncModifier = false
        if Peek(pos).Kind == SyntaxKind.AsyncKeyword {
            hasAsyncModifier = true
            isComplex = true
            pos++
        }
        if Peek(pos).Kind == SyntaxKind.SequenceKeyword {
            isComplex = true
            return TryScanSequenceTypeClause(&pos)
        }
        if hasAsyncModifier && Peek(pos).Kind != SyntaxKind.FuncKeyword && Peek(
            pos
        ).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        if Peek(pos).Kind == SyntaxKind.MapKeyword {
            isComplex = true
            return TryScanMapTypeClause(&pos)
        }
        // ADR-0174 D2: `[in|out] chan[T]?`, plus the retired `chan T` shape so
        // ParseTypeClause can report its span-accurate GS0567.
        if Peek(pos).Kind == SyntaxKind.IdentifierToken && (Peek(pos).Text == "in" || Peek(pos).Text == "out") && Peek(
            pos + 1
        ).Kind == SyntaxKind.ChanKeyword {
            pos++
        }
        if Peek(pos).Kind == SyntaxKind.ChanKeyword {
            isComplex = true
            pos++
            if Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken {
                pos++
                if !TryScanTypeClause(&pos) || Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken {
                    return false
                }
                pos++
            } else if !TryScanTypeClause(&pos) {
                return false
            }
            if Peek(pos).Kind == SyntaxKind.QuestionToken {
                pos++
            }
            return true
        }
        // ADR-0075: `(T1, T2, ...) -> R` arrow function-type clause, or a
        // tuple-type clause `(T1, T2, ...)`. Both start with '('.
        if Peek(pos).Kind == SyntaxKind.OpenParenthesisToken {
            // A function/tuple type clause is unambiguously a type shape.
            isComplex = true
            pos++
            var sawEllipsis = false
            if Peek(pos).Kind != SyntaxKind.CloseParenthesisToken {
                while true {
                    if Peek(pos).Kind == SyntaxKind.EllipsisToken {
                        sawEllipsis = true
                        pos++
                    }
                    // ADR-0172: an optional element NAME before the type —
                    // `(line int32, column int32)` — mirrors
                    // LooksLikeTupleElementName on the speculative cursor.
                    if Peek(pos).Kind == SyntaxKind.IdentifierToken && ScanLooksLikeTupleElementNameAt(pos) {
                        pos++
                    }
                    // A grouping or element inside an allowed position (for
                    // example `cast[unmanaged[CC] () -> (*uint8)](x)`) is
                    // not a generic argument either.
                    if !TryScanTypeClause(&pos, out _, pointerAllowed) {
                        return false
                    }
                    if Peek(pos).Kind == SyntaxKind.CommaToken {
                        pos++
                        continue
                    }
                    break
                }
            }
            if Peek(pos).Kind != SyntaxKind.CloseParenthesisToken {
                return false
            }
            pos++
            // If `->` follows, this is an arrow function-type clause; scan the return type.
            let isArrowFunction = Peek(pos).Kind == SyntaxKind.RightArrowToken
            if isArrowFunction {
                pos++
                if !TryScanTypeClause(&pos, out _, pointerAllowed) {
                    return false
                }
            } else if sawEllipsis {
                return false
            }
            // Optional trailing `?` for nullables (tuples and function types both support `?`).
            if Peek(pos).Kind == SyntaxKind.QuestionToken {
                pos++
            }
            return true
        }
        // Phase 4.7: legacy `func(T) R` function-type clause.
        if Peek(pos).Kind == SyntaxKind.FuncKeyword {
            // A legacy function-type clause is unambiguously a type shape.
            isComplex = true
            pos++
            if Peek(pos).Kind != SyntaxKind.OpenParenthesisToken {
                return false
            }
            pos++
            if Peek(pos).Kind != SyntaxKind.CloseParenthesisToken {
                while true {
                    if Peek(pos).Kind == SyntaxKind.EllipsisToken {
                        pos++
                    }
                    // A managed function pointer's signature is not a generic
                    // argument list, so it may name pointers (`*func(*int32)`).
                    if !TryScanTypeClause(&pos, out _, pointerAllowed: isManagedFunctionPointer) {
                        return false
                    }
                    if Peek(pos).Kind == SyntaxKind.CommaToken {
                        pos++
                        continue
                    }
                    break
                }
            }
            if Peek(pos).Kind != SyntaxKind.CloseParenthesisToken {
                return false
            }
            pos++
            // Optional return type for the legacy func form. A managed
            // function pointer may return a pointer (`*func() *uint8`),
            // which ParseOptionalTypeClause accepts.
            if CanStartTypeClause(Peek(pos)) && (Peek(pos).Kind != SyntaxKind.StarToken || isManagedFunctionPointer) {
                if !TryScanTypeClause(&pos, out _, pointerAllowed: isManagedFunctionPointer) {
                    return false
                }
            }
            if Peek(pos).Kind == SyntaxKind.QuestionToken {
                pos++
            }
            return true
        }
        // ADR-0095 / issue #4938: raw function-pointer type clause
        // `unmanaged[CC, …] (T, …) -> R` (or the platform-default
        // `unmanaged (T, …) -> R`). It must be recognised before the
        // named-type path below, which would otherwise consume `unmanaged[CC]`
        // as a generic name and stop at `(`, so `cast[unmanaged[Cdecl] () ->
        // int32](address)` was mis-read as an indexer on a variable `cast`.
        if IsFunctionPointerTypeHead(pos) {
            isComplex = true
            return TryScanFunctionPointerTypeClause(&pos)
        }
        if Peek(pos).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        pos++
        // Nested type-argument list, e.g. `List[int]`.
        if !TryScanOptionalTypeArgumentList(&pos, out var headHadTypeArgumentList) {
            return false
        }
        // A nested type-argument list makes this unambiguously a type shape
        // (`List[int32]`) rather than a plain index expression (Issue #1323).
        isComplex |= headHadTypeArgumentList
        // Issue #1174: a dotted tail names a (possibly nested, possibly
        // generic) type — `Container.Nested`, `A.B.C`, or `Outer.Generic[T]`.
        // Each `.Identifier` segment may carry its own type-argument list.
        // Consuming the tail here lets `List[C.E]` and `List[C.E]{...}` scan as
        // a SINGLE type clause in a generic-argument position so they are
        // recognised as a generic call / composite site. The `.` is scanned
        // INSIDE the bracket; the separate issue #942 rule about a trailing `.`
        // AFTER the `]` (indexer-then-member disambiguation in
        // LooksLikeGenericCallSite) is untouched.
        while Peek(pos).Kind == SyntaxKind.DotToken && Peek(pos + 1).Kind == SyntaxKind.IdentifierToken {
            pos += 2
            if !TryScanOptionalTypeArgumentList(&pos, out var segmentHadTypeArgumentList) {
                return false
            }
            isComplex |= segmentHadTypeArgumentList
        }
        // Optional trailing `?` for nullables.
        if Peek(pos).Kind == SyntaxKind.QuestionToken {
            // A nullable suffix is unambiguously a type shape (Issue #1323).
            isComplex = true
            pos++
        }
        return true
    }

    /// Speculative-cursor twin of `ParseFunctionPointerTypeClause`: scans
    /// `unmanaged`, an optional `[CC, …]` convention list, a parenthesised
    /// parameter-type list, `->` and the return type. The caller has already
    /// matched the head with `IsFunctionPointerTypeHead`. Like the real
    /// parser, no trailing `?` is consumed here: a `?` after the return type
    /// belongs to the return type, and a nullable function pointer is spelled
    /// `(unmanaged[CC] (…) -> R)?`.
    private func TryScanFunctionPointerTypeClause(ref pos int32) bool {
        pos++
        if Peek(pos).Kind == SyntaxKind.OpenSquareBracketToken {
            pos++
            if Peek(pos).Kind != SyntaxKind.IdentifierToken {
                return false
            }
            pos++
            while Peek(pos).Kind == SyntaxKind.CommaToken {
                pos++
                if Peek(pos).Kind != SyntaxKind.IdentifierToken {
                    return false
                }
                pos++
            }
            if Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken {
                return false
            }
            pos++
        }
        if Peek(pos).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        pos++
        // The signature is not a generic argument list: native signatures
        // routinely take and return pointers (`(nint, *uint8) -> nint`).
        while Peek(pos).Kind != SyntaxKind.CloseParenthesisToken && Peek(pos).Kind != SyntaxKind.EndOfFileToken {
            if !TryScanTypeClause(&pos, out _, pointerAllowed: true) {
                return false
            }
            if Peek(pos).Kind != SyntaxKind.CommaToken {
                break
            }
            pos++
        }
        if Peek(pos).Kind != SyntaxKind.CloseParenthesisToken {
            return false
        }
        pos++
        if Peek(pos).Kind != SyntaxKind.RightArrowToken {
            return false
        }
        pos++
        return TryScanTypeClause(&pos, out _, pointerAllowed: true)
    }

    private func TryScanSequenceTypeClause(ref pos int32) bool {
        pos++
        if Peek(pos).Kind != SyntaxKind.OpenSquareBracketToken {
            return false
        }
        pos++
        if !TryScanTypeClause(&pos) || Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken {
            return false
        }
        pos++
        if Peek(pos).Kind == SyntaxKind.QuestionToken {
            pos++
        }
        return true
    }

    private func TryScanMapTypeClause(ref pos int32) bool {
        pos++
        if Peek(pos).Kind != SyntaxKind.OpenSquareBracketToken {
            return false
        }
        pos++
        if !TryScanTypeClause(&pos) {
            return false
        }
        if Peek(pos).Kind == SyntaxKind.CommaToken {
            pos++
            if !TryScanTypeClause(&pos) || Peek(pos).Kind != SyntaxKind.CloseSquareBracketToken {
                return false
            }
            pos++
        } else if Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken {
            // Preserve legacy `map[K]V` recognition so ParseTypeClause can
            // report its existing span-accurate GS0366 migration diagnostic.
            pos++
            if !TryScanTypeClause(&pos) {
                return false
            }
        } else {
            return false
        }
        if Peek(pos).Kind == SyntaxKind.QuestionToken {
            pos++
        }
        return true
    }

    /// Issue #1174: scans an optional bracketed type-argument list
    /// (`[T1, T2, ...]`) starting at [`pos`](paramref). A missing list
    /// is a success (no-op). Used by (cref:TryScanTypeClause(ref int)) for both the
    /// head identifier and each dotted-tail segment so a nested generic type such
    /// as `Outer.Generic[T]` scans as one type clause.
    /// @param pos The scan position, advanced past the list when present.
    /// @returns `true` when there is no list or it scans cleanly.
    private func TryScanOptionalTypeArgumentList(ref pos int32) bool -> TryScanOptionalTypeArgumentList(&pos, out _)

    private func TryScanOptionalTypeArgumentList(ref pos int32, out present bool) bool {
        if Peek(pos).Kind != SyntaxKind.OpenSquareBracketToken {
            present = false
            return true
        }
        present = true
        pos++
        while true {
            if !TryScanTypeClause(&pos) {
                return false
            }
            if Peek(pos).Kind == SyntaxKind.CommaToken {
                pos++
                continue
            }
            if Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken {
                pos++
                break
            }
            return false
        }
        return true
    }

    /// ADR-0167: `cast` is reserved in call position, and `cast[T](x)` binds
    /// as the conversion intrinsic whatever `T` is. Its bracket is a
    /// conversion target, not a CLR generic instantiation, so pointer and
    /// function-pointer targets are legal there (issue #4938).
    private func IsCastIntrinsicHead() bool -> Current.Kind == SyntaxKind.IdentifierToken && Current.ValueText == "cast"

    /// @param castIntrinsic Whether this is the reserved `cast[T]` intrinsic
    /// (see (cref:IsCastIntrinsicHead)), whose target may be a pointer or a
    /// function pointer when it is called.
    private func ParseGenericCallExpression(castIntrinsic bool = false) ExpressionSyntax {
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let typeArguments = ParseTypeArgumentList(pointerArgumentsAllowed: castIntrinsic)
        if castIntrinsic && Current.Kind != SyntaxKind.OpenParenthesisToken {
            // `cast[*T]{…}` / `cast[*T].M` are not the intrinsic call; keep
            // the ordinary generic-argument rejection for them.
            for typeArgument in typeArguments.Arguments {
                ReportIfPointerGenericTypeArgument(typeArgument)
            }
        }
        // Phase 4.3 / ADR-0020: a `[…]` type-argument list followed by `{` is a
        // generic struct/class composite literal (`Result[int, string]{...}`).
        // Issue #479 / ADR-0117: the same `Type[args]{…}` shape is a collection
        // initializer (`List[int32]{1, 2, 3}`, `Dictionary[K, V]{"a": 1}`,
        // `Dictionary[K, V]{ ["a"] = 1 }`) when the brace contents are NOT a
        // `Field: value` struct-literal field list. The parser synthesizes an
        // empty-argument constructor call as the initializer's target.
        if Current.Kind == SyntaxKind.OpenBraceToken {
            if BraceLooksLikeGenericCollectionInitializer() {
                let ctorCall = SynthesizeEmptyArgConstructorCall(identifier, typeArguments)
                return ParseCollectionInitializerExpression(ctorCall)
            }
            let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
            let (spreadToken, spreadExpression, spreadSeparator, elements) = ParseStructLiteralInitializers()
            let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
            let literal = StructLiteralExpressionSyntax(
                syntaxTree,
                identifier,
                openBrace,
                spreadToken,
                spreadExpression,
                spreadSeparator,
                elements,
                closeBrace
            )
            literal.TypeArgumentList = typeArguments
            return literal
        }
        // Issue #1323: a `[…]` type-argument list followed by `.` is a member
        // access on the constructed generic *type* (`Box[int32?].Make(5)`,
        // `Pair[int, string].Default`). The committed-to-generic decision was
        // already made by LooksLikeGenericCallSite (multi-arg, or a single
        // unambiguously type-shaped argument). Emit a generic-name expression so
        // ParsePostfixChain attaches the `.Member(...)` accessor and the binder
        // resolves the closed construction as the static-access receiver.
        if Current.Kind == SyntaxKind.DotToken {
            return GenericNameExpressionSyntax(syntaxTree, identifier, typeArguments)
        }
        let nullableQuestion = if Current.Kind == SyntaxKind.QuestionToken {
            MatchToken(SyntaxKind.QuestionToken)
        } else {
            default(SyntaxToken?)
        }
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        var arguments = ParseArguments()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        arguments = MaybeAppendTrailingLambda(arguments)
        return CallExpressionSyntax(
            syntaxTree,
            identifier,
            nullableQuestion,
            typeArguments,
            openParen,
            arguments,
            closeParen
        )
    }

    // Issue #479 / ADR-0117: builds the synthetic zero-argument constructor
    // call that backs the no-parentheses collection-initializer spelling
    // (`List[int32]{…}`). The synthetic parentheses are positioned at the end
    // of the type-argument list so the node's span stays monotonic.
    private func SynthesizeEmptyArgConstructorCall(
        identifier SyntaxToken,
        typeArguments TypeArgumentListSyntax
    ) CallExpressionSyntax {
        let position = typeArguments.CloseBracketToken.Span.End
        let openParen = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.OpenParenthesisToken, position, "(")
        let closeParen = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.CloseParenthesisToken, position, ")")
        let emptyArguments = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        return CallExpressionSyntax(syntaxTree, identifier, typeArguments, openParen, emptyArguments, closeParen)
    }

    // Issue #479 / ADR-0117: in the `Type[args]{…}` generic-composite position
    // the `{` introduces a struct-literal field list when it is empty (all
    // defaults) or its first entry is `Identifier :`. Every other shape — a
    // bare element (`1`), a non-identifier-keyed entry (`"a": 1`), or an
    // indexed entry (`["a"] = 1`) — is a collection initializer.
    private func BraceLooksLikeGenericCollectionInitializer() bool {
        let k1 = Peek(1).Kind
        if k1 == SyntaxKind.CloseBraceToken {
            return false
        }
        if k1 == SyntaxKind.EllipsisToken {
            return false
        }
        if k1 == SyntaxKind.OpenSquareBracketToken {
            return true
        }
        if k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.ColonToken {
            return false
        }
        return true
    }

    // Issue #479 / ADR-0117: recognises a collection-initializer `{` after a
    // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`). An
    // arbitrary single expression is accepted when its brace and element start
    // on the call's line; a line break may instead indicate a standalone block
    // or an incomplete object initializer in editor input. Indexed, literal,
    // keyed, and multi-element forms stay unambiguous.
    private func LooksLikeCollectionInitializerBrace(target ExpressionSyntax) bool {
        let k1 = Peek(1).Kind
        if k1 == SyntaxKind.CloseBraceToken {
            return false
        }
        // A leading dot cannot begin a statement body; admit incomplete
        // member designators too so completion can recover `.Partial`.
        if k1 == SyntaxKind.DotToken {
            return true
        }
        if k1 == SyntaxKind.OpenSquareBracketToken {
            return true
        }
        if IsLiteralStartToken(k1) && Peek(2).Kind == SyntaxKind.CloseBraceToken {
            return true
        }
        var depth = 0
        for var i = 1; i <= LookaheadMaxScan; i++ {
            let kind = Peek(i).Kind
            if kind == SyntaxKind.EndOfFileToken {
                return false
            }
            if kind == SyntaxKind.OpenBraceToken ||
                kind == SyntaxKind.OpenParenthesisToken ||
                kind == SyntaxKind.OpenSquareBracketToken {
                depth++
            } else if kind == SyntaxKind.CloseParenthesisToken || kind == SyntaxKind.CloseSquareBracketToken {
                depth--
            } else if kind == SyntaxKind.CloseBraceToken {
                if depth == 0 {
                    return target is CallExpressionSyntax call &&
                        !IsTokenOnNewLineAfter(Current, call.CloseParenthesisToken) &&
                        !IsTokenOnNewLineAfter(Peek(1), Current)
                }
                depth--
            } else if depth == 0 && (kind == SyntaxKind.CommaToken || kind == SyntaxKind.ColonToken) {
                return true
            }
        }
        return false
    }

    // Issue #479 / ADR-0117: parses the `{ elements }` collection initializer
    // applied to an already-parsed constructor-call target.
    private func ParseCollectionInitializerExpression(target ExpressionSyntax?) ExpressionSyntax {
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let elements = ParseCollectionElements()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return CollectionInitializerExpressionSyntax(syntaxTree, target, openBrace, elements, closeBrace)
    }

    private func ParseCollectionElements() SeparatedSyntaxList[CollectionElementSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            nodesAndSeparators.Add(ParseCollectionElement())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[CollectionElementSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseCollectionElement() CollectionElementSyntax {
        // Element values live inside the braces — a fresh expression context
        // where trailing object/collection initializers are again allowed.
        let savedSuppress = suppressTrailingObjectInitializer
        suppressTrailingObjectInitializer = 0
        let savedStructLiteral = suppressStructLiteral
        suppressStructLiteral = 0
        try {
            if Current.Kind == SyntaxKind.DotToken {
                let dot = MatchToken(SyntaxKind.DotToken)
                return MemberCollectionElementSyntax(syntaxTree, dot, ParseFieldInitializer())
            }
            // Native spread element `...source`.
            if Current.Kind == SyntaxKind.EllipsisToken {
                let ellipsis = MatchToken(SyntaxKind.EllipsisToken)
                let spread = SpreadElementExpressionSyntax(syntaxTree, ellipsis, ParseExpression())
                return ExpressionCollectionElementSyntax(syntaxTree, spread)
            }
            // Indexed entry `[key] = value`.
            if Current.Kind == SyntaxKind.OpenSquareBracketToken && LooksLikeIndexedCollectionElement() {
                let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
                let key = ParseExpression()
                let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
                let equals = MatchToken(SyntaxKind.EqualsToken)
                let value = ParseExpression()
                return IndexedCollectionElementSyntax(syntaxTree, openBracket, key, closeBracket, equals, value)
            }
            let first = ParseExpression()
            // Key/value entry `key: value`.
            if Current.Kind == SyntaxKind.ColonToken {
                let colon = MatchToken(SyntaxKind.ColonToken)
                let value = ParseExpression()
                return KeyedCollectionElementSyntax(syntaxTree, first, colon, value)
            }
            // Bare sequence/set element.
            return ExpressionCollectionElementSyntax(syntaxTree, first)
        } finally {
            suppressTrailingObjectInitializer = savedSuppress
            suppressStructLiteral = savedStructLiteral
        }
    }

    // Issue #2830: inside a collection initializer both an indexed
    // entry (`[key] = value`) and an array-literal element (`[]T{ … }`,
    // `[N]T{ … }`) start with `[`. Scan to the bracket that closes the leading
    // `[` and commit to the indexed form only when a `=` follows it; every
    // other shape is an ordinary element expression, which lets
    // `List[[]object]{ []object{ … }, … }` parse.
    private func LooksLikeIndexedCollectionElement() bool {
        var bracketDepth = 0
        var braceDepth = 0
        for var offset = 0; ; offset++ {
            let kind = Peek(offset).Kind
            switch kind {
                case SyntaxKind.OpenSquareBracketToken {
                    bracketDepth++
                }
                case SyntaxKind.CloseSquareBracketToken {
                    bracketDepth--
                    if bracketDepth == 0 {
                        return Peek(offset + 1).Kind == SyntaxKind.EqualsToken
                    }
                }
                case SyntaxKind.OpenBraceToken {
                    braceDepth++
                }
                case SyntaxKind.CloseBraceToken {
                    // The brace that closes the enclosing collection
                    // initializer — the leading `[` was never closed.
                    if braceDepth == 0 {
                        return false
                    }
                    braceDepth--
                }
                case SyntaxKind.EndOfFileToken {
                    return false
                }
                default {
                    let _ = 0
                }
            }
        }
    }

    /// ADR-0091 / issue #757: parses an explicit-base interface call
    /// `base[IFoo].Method(args)`. Commit is decided by the caller in
    /// (cref:ParsePrimaryExpression) when the current identifier is
    /// the contextual `base` keyword and the next token is `[`.
    /// The optional generic type-argument list on the method identifier is
    /// parsed but is rejected by the binder in this PR (reserved for a
    /// future explicit-base generic-method extension).
    private func ParseBaseInterfaceCallExpression() ExpressionSyntax {
        // Consume the `base` identifier token. We synthesize a fresh token to
        // make sure the kind stays IdentifierToken (avoiding any keyword
        // re-classification down the line).
        let baseKeyword = MatchToken(SyntaxKind.IdentifierToken)
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let interfaceTypeClause = ParseTypeClause()
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        let dot = MatchToken(SyntaxKind.DotToken)
        let methodIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        var methodTypeArgumentList TypeArgumentListSyntax? = nil
        if Current.Kind == SyntaxKind.OpenSquareBracketToken && LooksLikeGenericCallSite(0) {
            methodTypeArgumentList = ParseTypeArgumentList()
        }
        // Issue #1104: the parenthesis-less PROPERTY form `base[BaseClass].Prop`
        // (no `(args)` follows the member). This mirrors plain `base.Prop` but
        // with an explicit ancestor selector. The optional `= value` write tail
        // is attached later by ParseAssignmentExpression. A `[` generic-method
        // argument list is only valid on the call form, so reject it here by
        // still requiring it to be followed by `(`.
        if methodTypeArgumentList == nil && Current.Kind != SyntaxKind.OpenParenthesisToken {
            return BaseInterfaceCallExpressionSyntax(
                syntaxTree,
                baseKeyword,
                openBracket,
                interfaceTypeClause,
                closeBracket,
                dot,
                methodIdentifier,
                equalsToken: nil,
                value: nil
            )
        }
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let arguments = ParseArguments()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return BaseInterfaceCallExpressionSyntax(
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
            closeParen
        )
    }

    private func ParseTypeArgumentList(pointerArgumentsAllowed bool = false) TypeArgumentListSyntax {
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = true
        while parseNext &&
            Current.Kind != SyntaxKind.CloseSquareBracketToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            nodesAndSeparators.Add(
                if pointerArgumentsAllowed {
                    ParseTypeClause()
                } else {
                    ParseGenericTypeArgument()
                }
            )
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        return TypeArgumentListSyntax(
            syntaxTree,
            openBracket,
            SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable()),
            closeBracket
        )
    }

    shared {
        // Extracts the literal `LengthToken` for the constant-count literal form when
        // a parsed length expression turns out to be a lone numeric literal (so the
        // existing GS0115 count check and `[N]T{…}` path keep working even when the
        // length was parsed via the general expression path). Non-literal lengths
        // combined with a non-empty initializer are not a valid shape; the binder
        // reports the mismatch.
        private func ToLengthLiteralToken(
            lengthExpression ExpressionSyntax
        ) SyntaxToken? -> if lengthExpression is LiteralExpressionSyntax{
            LiteralToken: {Kind: SyntaxKind.NumberToken} token
        } {
            token
        } else {
            default(SyntaxToken?)
        }

        private func IsLiteralStartToken(kind SyntaxKind) bool {
            return kind == SyntaxKind.NumberToken ||
                kind == SyntaxKind.StringToken ||
                kind == SyntaxKind.ByteStringToken ||
                kind == SyntaxKind.InterpolatedStringToken ||
                kind == SyntaxKind.TrueKeyword ||
                kind == SyntaxKind.FalseKeyword ||
                kind == SyntaxKind.NilKeyword
        }
    }
}
