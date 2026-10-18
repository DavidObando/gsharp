// <copyright file="Parser.Expressions.Literals.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Runtime.CompilerServices
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Globalization

open partial class Parser {
    private func ParseCallExpression() CallExpressionSyntax {
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken)
        var arguments = ParseArguments()
        let closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken)
        arguments = MaybeAppendTrailingLambda(arguments)
        return CallExpressionSyntax(syntaxTree, identifier, openParenthesisToken, arguments, closeParenthesisToken)
    }

    // Issue #663: `string?(expr)` — nullable-type conversion call form.
    // Consumes adjacent `Identifier?(args)` and builds a CallExpressionSyntax
    // carrying the `?` token so the binder can wrap the resolved type in
    // NullableTypeSymbol.
    private func ParseNullableTypeCallExpression() ExpressionSyntax {
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let questionToken = MatchToken(SyntaxKind.QuestionToken)
        let openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken)
        var arguments = ParseArguments()
        let closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken)
        arguments = MaybeAppendTrailingLambda(arguments)
        return CallExpressionSyntax(
            syntaxTree,
            identifier,
            questionToken,
            typeArgumentList: nil,
            openParenthesisToken,
            arguments,
            closeParenthesisToken
        )
    }

    // Issue #3421: canonical conversion calls also accept composite targets,
    // notably slice/array casts emitted by cs2gs (`[]object(value)`).
    private func LooksLikeCompositeTypeConversionCall() bool {
        var elementOffset = 0
        while Peek(elementOffset).Kind == SyntaxKind.OpenSquareBracketToken {
            elementOffset++
            while (Peek(elementOffset).Kind is SyntaxKind.NumberToken or SyntaxKind.CommaToken) {
                elementOffset++
            }
            if Peek(elementOffset).Kind != SyntaxKind.CloseSquareBracketToken {
                return false
            }
            elementOffset++
            if Peek(elementOffset).Kind == SyntaxKind.QuestionToken {
                elementOffset++
            }
        }
        // `unmanaged[CC] (P...) -> R` is a single function-pointer type whose
        // signature `(` must not be read as the operand of an array
        // conversion call. Since issue #4938 the scanner reads the whole
        // function-pointer clause, but `[]unmanaged[CC] () -> R(x)` would then
        // scan the return type `R` and take `(x)` as the conversion operand;
        // keep the array-of-function-pointer element off this path.
        if Peek(elementOffset).Kind == SyntaxKind.IdentifierToken && Peek(elementOffset).Text == "unmanaged" {
            return false
        }
        var offset = 0
        return TryScanTypeClause(&offset, out var isComplex) && isComplex && Peek(
            offset
        ).Kind == SyntaxKind.OpenParenthesisToken
    }

    private func ParseCompositeTypeConversionCall() ExpressionSyntax {
        let targetType = ParseTypeClause()
        let openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken)
        let arguments = ParseArguments()
        let closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken)
        return CallExpressionSyntax(syntaxTree, targetType, openParenthesisToken, arguments, closeParenthesisToken)
    }

    // Issue #522: when the token following a constructor call's `)` is `{`
    // and the brace contents look like an object initializer (`Identifier =`
    // or empty `}`), wrap the call in an ObjectCreationExpressionSyntax. We
    // peek with the same surgical lookahead used by IsStructLiteralFollowingBrace
    // so unrelated trailing braces (e.g. an `if Cond() { body }` statement
    // body) are not mis-eaten.
    private func MaybeWrapWithObjectInitializer(target ExpressionSyntax) ExpressionSyntax {
        if Current.Kind != SyntaxKind.OpenBraceToken {
            return target
        }
        // Body-header contexts (if/for/while/switch condition) suppress the
        // wrap so the following `{` is recognised as the statement body.
        if suppressTrailingObjectInitializer > 0 {
            return target
        }
        if !LooksLikeObjectInitializerBrace() {
            // Issue #479 / ADR-0117: a collection initializer applied to a
            // constructor call (`List[int32](){…}`, `Dictionary[K, V](cmp){…}`).
            if LooksLikeCollectionInitializerBrace(target) {
                return ParseCollectionInitializerExpression(target)
            }
            return target
        }
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let initializers = ParseObjectInitializerList()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return ObjectCreationExpressionSyntax(syntaxTree, target, openBrace, initializers, closeBrace)
    }

    // Recognises an object-initializer `{` after a constructor call. To avoid
    // colliding with statement-bodied constructs of the form `if Cond() { ... }`
    // we require either `{}` (empty) or `{ Identifier =` so a `{ Identifier .`
    // (member access in a body) is not absorbed.
    private func LooksLikeObjectInitializerBrace() bool {
        let k1 = Peek(1).Kind
        if k1 == SyntaxKind.CloseBraceToken {
            return true
        }
        return k1 == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.EqualsToken
    }

    private func ParseObjectInitializerList() SeparatedSyntaxList[PropertyInitializerSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let propertyId = MatchToken(SyntaxKind.IdentifierToken)
            let equals = MatchToken(SyntaxKind.EqualsToken)
            // Initializer values live inside the braces — a fresh expression
            // context where trailing object initializers are again allowed
            // (so a nested `Inner = U() { X = 1 }` works even when the outer
            // object initializer was parsed inside a body-header context).
            var value ExpressionSyntax
            let savedSuppress = suppressTrailingObjectInitializer
            suppressTrailingObjectInitializer = 0
            let savedStructLiteral = suppressStructLiteral
            suppressStructLiteral = 0
            try {
                // Issue #1858: `Prop = { a, b }` mirrors the struct-literal
                // target-less collection-initializer carve-out (issue #1567,
                // `ParseFieldInitializerValue`) — a brace can never start a
                // normal expression in value position, so its presence
                // unambiguously selects the member collection-initializer form
                // rather than an ordinary assignment value. This lets the
                // construction-with-initializer-suffix form (issue #522) carry
                // a nested collection member alongside constructor arguments.
                value = if Current.Kind == SyntaxKind.OpenBraceToken {
                    ParseCollectionInitializerExpression(target: nil)
                } else {
                    ParseExpression()
                }
            } finally {
                suppressTrailingObjectInitializer = savedSuppress
                suppressStructLiteral = savedStructLiteral
            }
            nodesAndSeparators.Add(PropertyInitializerSyntax(syntaxTree, propertyId, equals, value))
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[PropertyInitializerSyntax](nodesAndSeparators.ToImmutable())
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
    private func ParseExpressionInBodyHeader(allowEmptyStructLiteralCollection bool = false) ExpressionSyntax {
        suppressTrailingObjectInitializer++
        suppressStructLiteral++
        let savedAllowEmptyStructLiteral = allowEmptyStructLiteralInHeader
        allowEmptyStructLiteralInHeader = allowEmptyStructLiteralCollection
        try {
            return ParseExpression()
        } finally {
            allowEmptyStructLiteralInHeader = savedAllowEmptyStructLiteral
            suppressStructLiteral--
            suppressTrailingObjectInitializer--
        }
    }

    private func ParseChannelCreationExpression() ExpressionSyntax {
        // ADR-0174 D12: `chan[T]()` (rendezvous) / `chan[T](n)` (buffered).
        // The type clause is parsed canonically — a legacy `chan T(…)` shape
        // reports GS0567 from inside ParseChanTypeClause — and the argument
        // list follows exactly as for `List[int32](…)`.
        let typeClause = ParseChanTypeClause(directionToken: nil, legacyMakeOperand: false)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let arguments = ParseArguments()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return ChannelCreationExpressionSyntax(syntaxTree, typeClause, openParen, arguments, closeParen)
    }

    private func ParseMakeChannelExpression() ExpressionSyntax {
        // ADR-0174 D12 / GS0566: `make(chan T[, capacity])` is retired in
        // favour of `chan[T](…)`. The shape is still recognized so the
        // diagnostic can name the exact replacement for THIS site and the
        // expression still binds (as a construction) — no cascade. The inner
        // clause is parsed as a legacy-make operand so it does not also
        // report GS0567: one diagnostic per retired site.
        let makeIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let channelType = ParseChanTypeClause(directionToken: nil, legacyMakeOperand: true)
        var comma SyntaxToken? = nil
        var capacity ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.CommaToken {
            comma = MatchToken(SyntaxKind.CommaToken)
            capacity = ParseExpression()
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let elementText = if channelType.ChanElementType is {} element {
            syntaxTree.Text.ToString(element.Span)
        } else {
            "T"
        }
        let retiredSpan = TextSpan.FromBounds(makeIdentifier.Span.Start, closeParen.Span.End)
        let retiredText = syntaxTree.Text.ToString(retiredSpan)
        let guidance = if capacity == nil {
            "use 'chan[$elementText]()' for a rendezvous channel (a send completes only when a receiver takes the value), or 'Chan.Unbounded[$elementText]()' to keep the unbounded buffer wave 1 gave 'make(chan T)'."
        } else {
            "use 'chan[$elementText](${syntaxTree.Text.ToString(capacity.Span)})' instead."
        }
        Diagnostics.ReportRetiredBuiltin(TextLocation(syntaxTree.Text, retiredSpan), retiredText, guidance)
        return MakeChannelExpressionSyntax(
            syntaxTree,
            makeIdentifier,
            openParen,
            channelType,
            comma,
            capacity,
            closeParen
        )
    }

    private func ParseTypeOfExpression() ExpressionSyntax {
        // Issue #143: `typeof(T)` — the argument is a type clause, not an expression.
        let typeOfIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let typeClause = ParseTypeClause()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return TypeOfExpressionSyntax(syntaxTree, typeOfIdentifier, openParen, typeClause, closeParen)
    }

    private func ParseSizeOfExpression() ExpressionSyntax {
        // Issue #1336: `sizeof(T)` — the argument is a type clause, not an expression.
        let sizeOfIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let typeClause = ParseTypeClause()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return SizeOfExpressionSyntax(syntaxTree, sizeOfIdentifier, openParen, typeClause, closeParen)
    }

    private func ParseCheckedExpression() ExpressionSyntax {
        // Issue #1881: `checked(expr)` / `unchecked(expr)` — the argument is
        // an ordinary expression evaluated in the named overflow context.
        let isChecked = Current.Text == "checked"
        let keyword = MatchToken(SyntaxKind.IdentifierToken)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let expression = ParseExpression()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return CheckedExpressionSyntax(syntaxTree, keyword, openParen, expression, closeParen, isChecked)
    }

    private func ParseDefaultExpression() DefaultExpressionSyntax {
        // ADR-0100 / issue #795: `default(T)` and bare `default` expression.
        // Both shapes start with the `default` keyword. The optional
        // `(TypeClause)` makes the form explicit; the bare form leaves the
        // type to be supplied by the surrounding target-type context
        // (let/var initializer with explicit type, `return`, typed call
        // argument, sibling branch of `?:`). Bare-form bind-time errors
        // are surfaced as GS0362.
        let defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword)
        if Current.Kind != SyntaxKind.OpenParenthesisToken {
            return DefaultExpressionSyntax(
                syntaxTree,
                defaultKeyword,
                openParenthesis: nil,
                typeClause: nil,
                closeParenthesis: nil
            )
        }
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let typeClause = ParseTypeClause()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return DefaultExpressionSyntax(syntaxTree, defaultKeyword, openParen, typeClause, closeParen)
    }

    private func ParseNameOfExpression() ExpressionSyntax {
        // Issue #143: `nameof(expr)` — the argument is a name reference. We
        // parse it as a general expression; the binder validates that it
        // reduces to a name (identifier / member access / generic name) and
        // emits a diagnostic otherwise.
        let nameOfIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let argument = ParseNameOfArgument()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return NameOfExpressionSyntax(syntaxTree, nameOfIdentifier, openParen, argument, closeParen)
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
    private func ParseNameOfArgument() ExpressionSyntax {
        if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.OpenSquareBracketToken &&
            NameOfGenericArgumentScansToCloseParen(1) {
            let identifier = MatchToken(SyntaxKind.IdentifierToken)
            let typeArguments = ParseTypeArgumentList()
            return GenericNameExpressionSyntax(syntaxTree, identifier, typeArguments)
        }
        return ParseExpression()
    }

    // Issue #1329: bounded-lookahead test for a generic-type nameof argument.
    // Like <see cref="LooksLikeGenericCallSite"/>, but the accepted follow-set
    // marker after the matching `]` is the nameof closing `)` (any arity).
    private func NameOfGenericArgumentScansToCloseParen(bracketOffset int32) bool {
        if Peek(bracketOffset).Kind != SyntaxKind.OpenSquareBracketToken {
            return false
        }
        var pos = bracketOffset + 1
        if Peek(pos).Kind == SyntaxKind.CloseSquareBracketToken {
            return false
        }
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
        return Peek(pos).Kind == SyntaxKind.CloseParenthesisToken
    }

    // Phase 4.9: Kotlin-style trailing-lambda call syntax. When a call's
    // closing paren is immediately followed by a `func(...) {...}` literal,
    // the literal is desugared into an additional last positional argument.
    // Useful for DSL-flavoured call sites like `runBlocking() func() { ... }`
    // and `xs.forEach() func(x int) { ... }`. The bare-parens form
    // (`f func(...) {...}` with no `()`) is intentionally out of scope for
    // v0 to keep the call grammar unambiguous with statement-level function
    // literals.
    private func MaybeAppendTrailingLambda(arguments SeparatedSyntaxList[ExpressionSyntax]) SeparatedSyntaxList[
        ExpressionSyntax
    ] {
        // Only `func(...) {...}` or `async func(...) {...}` (function LITERALS)
        // attach as a trailing lambda; `func Name(...)` (a function DECLARATION)
        // must stay as the following statement-level declaration.
        let isSyncLiteral = Current.Kind == SyntaxKind.FuncKeyword && Peek(1).Kind == SyntaxKind.OpenParenthesisToken
        let isAsyncLiteral = Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword && Peek(
            2
        ).Kind == SyntaxKind.OpenParenthesisToken
        if !isSyncLiteral && !isAsyncLiteral {
            return arguments
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
        let funcOffset = if isAsyncLiteral {
            1
        } else {
            0
        }
        if LooksLikeReceiverMethodDeclaration(funcOffset) {
            return arguments
        }
        let lambda = ParseFunctionLiteralExpression()
        let existing = arguments.GetWithSeparators()
        let builder = ImmutableArray.CreateBuilder[SyntaxNode](existing.Length + 2)
        builder.AddRange(existing)
        if existing.Length > 0 && !(existing[existing.Length - 1] is SyntaxToken) {
            let syntheticComma = SyntaxToken.Missing(syntaxTree, SyntaxKind.CommaToken, lambda.Span.Start)
            builder.Add(syntheticComma)
        }
        builder.Add(lambda)
        return SeparatedSyntaxList[ExpressionSyntax](builder.ToImmutable())
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
    private func LooksLikeReceiverMethodDeclaration(funcOffset int32) bool {
        let openParenOffset = funcOffset + 1
        if Peek(openParenOffset).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        var depth = 0
        let scanBound = openParenOffset + LookaheadMaxScan
        for var i = openParenOffset; i <= scanBound; i++ {
            let kind = Peek(i).Kind
            if kind == SyntaxKind.EndOfFileToken {
                return false
            }
            if kind == SyntaxKind.OpenParenthesisToken {
                depth++
            } else if kind == SyntaxKind.CloseParenthesisToken {
                depth--
                if depth == 0 {
                    // After the receiver clause a method declaration continues
                    // with its name followed by either a value-parameter list
                    // `Name(` or a type-parameter list `Name[` (generic method).
                    if Peek(i + 1).Kind == SyntaxKind.IdentifierToken {
                        return (
                            Peek(i + 2).Kind is SyntaxKind.OpenParenthesisToken or SyntaxKind.OpenSquareBracketToken
                        )
                    }
                    return Peek(i + 1).Kind == SyntaxKind.OperatorKeyword && Peek(
                        i + 2
                    ).Kind != SyntaxKind.EndOfFileToken &&
                        Peek(i + 3).Kind == SyntaxKind.OpenParenthesisToken
                }
            }
        }
        return false
    }

    private func ParseArguments(attributeArguments bool = false) SeparatedSyntaxList[ExpressionSyntax] {
        // Issue #522: arguments are fresh expression contexts — even when the
        // surrounding statement is a body-header (`if`/`for`/`switch`), a
        // call argument such as `Foo(T() { X = 1 })` should still admit a
        // trailing object initializer.
        let savedSuppress = suppressTrailingObjectInitializer
        suppressTrailingObjectInitializer = 0
        // A call argument is likewise a fresh context for the bare `Ident { }`
        // struct-literal form, so `Foo(Pt{X: 1})` is recognised even inside a
        // body-header condition (#1575).
        let savedStructLiteral = suppressStructLiteral
        suppressStructLiteral = 0
        // Issue #1038: an argument list is a fresh context, so a standalone
        // range argument (`f(1..3)`) is recognised even inside an index bound.
        let savedRange = suppressRangeOperator
        suppressRangeOperator = 0
        try {
            return ParseArgumentsCore(attributeArguments)
        } finally {
            suppressTrailingObjectInitializer = savedSuppress
            suppressStructLiteral = savedStructLiteral
            suppressRangeOperator = savedRange
        }
    }

    private func ParseArgumentsCore(attributeArguments bool) SeparatedSyntaxList[ExpressionSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNextArgument = true
        while parseNextArgument &&
            Current.Kind != SyntaxKind.CloseParenthesisToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            var expression ExpressionSyntax
            // Issue #343: a call-site named argument is `name: value`.
            // Issue #4503: attribute lists also preserve C#'s `Name = value`
            // spelling for property/field assignments; ordinary calls still
            // parse `=` as assignment per ADR-0161.
            // ADR-0161: outside attribute lists, the legacy `name = value` spelling — deprecated by
            // ADR-0080 with the one-release GS0315 warning — is retired here, so
            // `=` after an identifier in argument position is no longer a
            // separator. It falls through to ordinary expression parsing and is
            // an assignment, exactly as `=` is in every other expression
            // position. That is what makes `f(x = v)` legal; the ambiguous case
            // (the target also naming a parameter of the callee) is diagnosed at
            // bind time rather than silently reinterpreted.
            if Current.Kind == SyntaxKind.IdentifierToken &&
                (
                Peek(1).Kind == SyntaxKind.ColonToken || (attributeArguments && Peek(1).Kind == SyntaxKind.EqualsToken)
            ) {
                let name = MatchToken(SyntaxKind.IdentifierToken)
                let separator = NextToken()
                // ADR-0060: a named argument may carry a ref-kind modifier in
                // its value position (e.g. `name = ref x`). V1 rejects this
                // shape at bind time per ADR §4 / §8 (composition with named
                // arguments is a follow-up); the parser still accepts it so
                // the diagnostic carries a precise location.
                var value ExpressionSyntax
                if TryParseRefArgument(out var refValue) {
                    value = refValue!!
                } else {
                    value = ParseExpression()
                }
                expression = NamedArgumentExpressionSyntax(syntaxTree, name, separator, value)
            } else if TryParseRefArgument(out var refArg) {
                expression = refArg!!
            } else {
                expression = ParseExpression()
                // ADR-0161: `name = value` in argument position was a named
                // argument until this release; it is now an assignment whose
                // value is passed positionally. The two readings differ SILENTLY
                // when `name` is both assignable here and a parameter of the
                // callee, so the transitional shape warns. Only a bare
                // identifier target is flagged — `(name = value)` arrives as a
                // ParenthesizedExpression and states the intent unambiguously,
                // which is the spelling cs2gs emits.
                if expression is AssignmentExpressionSyntax{IdentifierToken: {} target} {
                    Diagnostics.ReportAssignmentArgumentWasNamedArgumentSpelling(expression.Location, target.Text)
                }
            }
            nodesAndSeparators.Add(expression)
            if Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                nodesAndSeparators.Add(comma)
            } else {
                parseNextArgument = false
            }
        }
        return SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable())
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
    private func TryParseRefArgument(@MaybeNullWhen(false) out result RefArgumentExpressionSyntax?) bool {
        result = nil
        if Current.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        let text = Current.Text
        if text != "ref" && text != "out" && text != "in" {
            return false
        }
        let nextKind = Peek(1).Kind
        let nextText = Peek(1).Text
        if text == "out" {
            // `out var <ident>`, `out let <ident>`, `out _`, `out <ident>`,
            // or `out (`. Reject the `out` if the next token isn't a legal
            // payload start (so a parameter actually named `out` still binds).
            let payloadIsDecl = (nextKind == SyntaxKind.VarKeyword || nextKind == SyntaxKind.LetKeyword) && Peek(
                2
            ).Kind == SyntaxKind.IdentifierToken
            let payloadIsDiscard = nextKind == SyntaxKind.IdentifierToken && nextText == "_"
            let payloadIsLvalueStart = nextKind == SyntaxKind.IdentifierToken ||
                nextKind == SyntaxKind.OpenParenthesisToken
            // ADR-0061: `out` may also be followed by a conditional-ref
            // condition expression — relax the disambiguation for literal
            // keywords and number/unary tokens that can never be an
            // out-parameter target. A `?` later turns these into the
            // conditional form; without `?` the binder reports the standard
            // non-lvalue diagnostic.
            let payloadIsConditionalConditionStart = nextKind == SyntaxKind.TrueKeyword ||
                nextKind == SyntaxKind.FalseKeyword ||
                nextKind == SyntaxKind.NumberToken ||
                nextKind == SyntaxKind.BangToken ||
                nextKind == SyntaxKind.MinusToken
            // A bare identifier follower could be the parameter name (use `out`).
            // It is treated as `out lvalue` only when the lookahead is unambiguous.
            // We follow the ADR's rule: if the modifier is followed by an
            // identifier (not the named-argument `=` form), recognise it as
            // a ref-kind argument. A trailing `=` (named argument) is already
            // handled above; anything else with an ident lookahead is `out`.
            if !(payloadIsDecl || payloadIsDiscard || payloadIsLvalueStart || payloadIsConditionalConditionStart) {
                return false
            }
            let outToken = NextToken()
            if payloadIsDecl {
                let keyword = NextToken()
                let ident = MatchToken(SyntaxKind.IdentifierToken)
                var declType TypeClauseSyntax? = nil
                if CanStartTypeClause(Current) {
                    declType = ParseTypeClause()
                }
                result = RefArgumentExpressionSyntax(syntaxTree, outToken, keyword, ident, discardToken: nil, declType)
                return true
            }
            if payloadIsDiscard {
                let underscore = NextToken()
                var declType TypeClauseSyntax? = nil
                if CanStartTypeClause(Current) {
                    declType = ParseTypeClause()
                }
                result = RefArgumentExpressionSyntax(
                    syntaxTree,
                    outToken,
                    declarationKeyword: nil,
                    declarationIdentifier: nil,
                    discardToken: underscore,
                    declType
                )
                return true
            }
            var lvalue = ParseExpression()
            lvalue = MaybeParseConditionalRefArgumentTail(lvalue, outToken)
            result = RefArgumentExpressionSyntax(syntaxTree, outToken, lvalue)
            return true
        }
        // `ref` / `in` — legal followers are an identifier (lvalue), a
        // parenthesised lvalue, or (ADR-0061) any token that can start a
        // conditional ref-argument's condition expression — literal keywords,
        // number tokens, or unary operators that combine to form a bool
        // condition. The conditional form requires a `?` later on the line;
        // when one is absent these cases are rejected at bind time as
        // expected ("cannot take address of non-lvalue").
        if !(
            nextKind == SyntaxKind.IdentifierToken ||
                nextKind == SyntaxKind.OpenParenthesisToken ||
                nextKind == SyntaxKind.TrueKeyword ||
                nextKind == SyntaxKind.FalseKeyword ||
                nextKind == SyntaxKind.NumberToken ||
                nextKind == SyntaxKind.BangToken ||
                nextKind == SyntaxKind.MinusToken
        ) {
            return false
        }
        let modifier = NextToken()
        var inner = ParseExpression()
        inner = MaybeParseConditionalRefArgumentTail(inner, modifier)
        result = RefArgumentExpressionSyntax(syntaxTree, modifier, inner)
        return true
    }

    // ADR-0062: parse a ternary tail `? a : b` starting at the current `?`
    // token, given the already-parsed condition expression. Right-associative.
    // When the inner branches use legacy ADR-0061 inner ref-kind modifiers,
    // returns a ConditionalRefArgumentExpressionSyntax (for back-compat) so
    // the binder can reject mismatches; otherwise returns the general
    // ConditionalExpressionSyntax (ADR-0062).
    private func ParseConditionalTail(condition ExpressionSyntax) ExpressionSyntax {
        let questionToken = NextToken()
        let whenTrueMod SyntaxToken? = TryConsumeInnerRefModifier()
        let whenTrue = ParseAssignmentExpression()
        let colonToken = MatchToken(SyntaxKind.ColonToken)
        let whenFalseMod SyntaxToken? = TryConsumeInnerRefModifier()
        let whenFalse = ParseAssignmentExpression()
        if whenTrueMod != nil || whenFalseMod != nil {
            // Legacy ADR-0061 inner-modifier shape: keep producing the
            // dedicated ref-arg node so the binder retains GS0262 etc.
            return ConditionalRefArgumentExpressionSyntax(
                syntaxTree,
                condition,
                questionToken,
                whenTrueMod,
                whenTrue,
                colonToken,
                whenFalseMod,
                whenFalse
            )
        }
        return ConditionalExpressionSyntax(syntaxTree, condition, questionToken, whenTrue, colonToken, whenFalse)
    }

    // ADR-0061 transitional: kept only to avoid touching the few callers
    // that still want the legacy ref-only node when the `?` follows
    // certain ref-context shapes. Forwards to ParseConditionalTail.
    private func MaybeParseConditionalRefArgumentTail(
        condition ExpressionSyntax,
        outerModifier SyntaxToken?
    ) ExpressionSyntax {
        if Current.Kind != SyntaxKind.QuestionToken {
            return condition
        }
        return ParseConditionalTail(condition)
    }

    // ADR-0061: parse an optional inner `ref`/`in`/`out` modifier on a branch
    // of a conditional ref-argument. Returns the consumed token or null.
    private func TryConsumeInnerRefModifier() SyntaxToken? {
        if Current.Kind != SyntaxKind.IdentifierToken {
            return nil
        }
        let text = Current.Text
        if text != "ref" && text != "in" && text != "out" {
            return nil
        }
        let nextKind = Peek(1).Kind
        // Only treat as a modifier if the next token starts a legal lvalue
        // payload (identifier or `(`). Otherwise leave it as a plain identifier.
        if !(nextKind == SyntaxKind.IdentifierToken || nextKind == SyntaxKind.OpenParenthesisToken) {
            return nil
        }
        return NextToken()
    }

    // Issue #669: parse an if-expression of the form
    // `if cond { expr }`, `if cond { expr } else { expr }`,
    // or `if cond { expr } else if ... { expr } else { expr }`.
    // Issue #4962: each link may start with an initializer,
    // `if init; cond { expr } else { expr }`, as in the statement form.
    // Issue #1602: depth-guarded wrapper — if-expressions self-recurse through
    // `else if` chains and through ParseBlockExpression/ParseBlockExpressionItem
    // (which dispatch back here without passing the expression pipeline).
    private func ParseIfExpression() IfExpressionSyntax {
        EnsureNestedParseAllowed()
        recursionDepth++
        try {
            return ParseIfExpressionCore()
        } finally {
            recursionDepth--
        }
    }

    private func ParseIfExpressionCore() IfExpressionSyntax {
        let ifKeyword = MatchToken(SyntaxKind.IfKeyword)
        // Issue #4962: the same header routine as the if-statement, so the
        // optional `init;` initializer is accepted here too.
        let (initializer, semicolon, condition) = ParseIfHeader()
        let thenBlock = ParseBlockExpression()
        var elseKeyword SyntaxToken? = nil
        var elseExpression ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.ElseKeyword {
            elseKeyword = NextToken()
            if IsIfLetStart() {
                // ADR-0151: `else if let …` chains into the binding form.
                elseExpression = ParseIfLetExpression()
            } else if Current.Kind == SyntaxKind.IfKeyword {
                elseExpression = ParseIfExpression()
            } else {
                elseExpression = ParseBlockExpression()
            }
        }
        return IfExpressionSyntax(
            syntaxTree,
            ifKeyword,
            initializer,
            semicolon,
            condition,
            thenBlock,
            elseKeyword,
            elseExpression
        )
    }

    // Issue #669: parse a block expression `{ stmt*; expr? }`.
    // The last item in the block, if it is an expression statement, becomes
    // the trailing value-producing expression of the block.
    // ADR-0202: every value-capable block — a general block expression, an
    // if-/if-let-expression branch, an arrow-lambda body and an arrow-member
    // body — is parsed the same way; whether a missing tail is an error
    // (GS0277), a void block, or a `never` block is the binder's decision.
    private func ParseBlockExpression() BlockExpressionSyntax {
        if skimBraceBodies > 0 && Current.Kind == SyntaxKind.OpenBraceToken {
            let (skimmedOpen, skimmedClose) = SkimBraceBody()
            return BlockExpressionSyntax(
                syntaxTree,
                skimmedOpen,
                ImmutableArray[StatementSyntax].Empty,
                nil,
                skimmedClose
            )
        }
        let statements = ImmutableArray.CreateBuilder[StatementSyntax]()
        var trailingExpression ExpressionSyntax? = nil
        let openBraceToken = MatchToken(SyntaxKind.OpenBraceToken)
        while Current.Kind != SyntaxKind.EndOfFileToken && Current.Kind != SyntaxKind.CloseBraceToken {
            let startToken = Current
            let statement = ParseBlockExpressionItem()
            statements.Add(statement)
            if Current == startToken {
                NextToken()
            }
        }
        let closeBraceToken = MatchToken(SyntaxKind.CloseBraceToken)
        // If the last statement is an expression statement, treat its
        // expression as the block's trailing value-producing expression.
        if statements.Count > 0 && statements[^1] is ExpressionStatementSyntax exprStmt {
            statements.RemoveAt(statements.Count - 1)
            trailingExpression = exprStmt.Expression
        }
        return BlockExpressionSyntax(
            syntaxTree,
            openBraceToken,
            statements.ToImmutable(),
            trailingExpression,
            closeBraceToken
        )
    }

    // Issue #669: parse a single item inside a block expression. This is
    // similar to ParseStatement() but recognizes the constructs that have both
    // a statement and an expression form (`if`, `switch`, a nested `{ … }`)
    // and picks the expression form when the item has the expression shape.
    //
    // Issue #4963 / #4965 / #4966 (ADR-0202): this is the ONE place that
    // decides what the last item of a value-capable block means — a general
    // block expression, an if-/if-let-expression branch, an arrow-lambda block
    // body and an arrow-member block body (`func f() T -> { … }`, which
    // ParseArrowExpressionBody parses through ParseBlockExpression too). Every
    // one of those blocks applies the same rule, so the same item means the
    // same thing in all of them.
    private func ParseBlockExpressionItem() StatementSyntax {
        // Issue #3355 / #4965 §3: a final nested brace block is itself the
        // trailing expression, not a standalone statement block — in every
        // value-capable block, including lambda and arrow-member bodies (the
        // last-position test is NestedBraceCanBeTrailingExpression). A brace
        // followed by a postfix/binary continuation is likewise unambiguously
        // expression-shaped. A nested block whose own tail is void leaves the
        // enclosing body void, so only a nested block that ends in a value can
        // change a body's type.
        if Current.Kind == SyntaxKind.OpenBraceToken && NestedBraceCanBeTrailingExpression() {
            return ExpressionStatementSyntax(syntaxTree, ParseExpression())
        }
        // Issue #4963 §2: a `switch` item is decided by ParseStatement, which
        // makes a switch with expression-shaped arms the switch expression, so
        // it is the block's trailing value the same way a trailing
        // `if … else …` is.
        // If the current token is `if` and this could be an if-expression
        // (value-producing), parse it as an expression statement wrapping
        // an IfExpressionSyntax. This handles nested `if` in block position.
        //
        // ADR-0151 / ADR-0202: an `if let … else …` chain ending in a plain
        // `else` is likewise the value-producing binding form, in every
        // value-capable block. (It used to stay the ADR-0071 statement in an
        // arrow-lambda body; a body ending in
        // `if let x = y { return … } else { return … }` is now an if-let
        // expression whose exiting branches have the `never` type, and one
        // whose branches are void is the void if-let, so both keep their
        // meaning.)
        if Current.Kind == SyntaxKind.IfKeyword && LooksLikeIfExpression() {
            return if Peek(1).Kind == SyntaxKind.LetKeyword {
                ExpressionStatementSyntax(syntaxTree, ParseIfLetExpression())
            } else {
                ExpressionStatementSyntax(syntaxTree, ParseIfExpression())
            }
        }
        return ParseStatement()
    }

    private func NestedBraceCanBeTrailingExpression() bool {
        let nextOffset = SkipBalancedGroup(0)
        return Peek(nextOffset).Kind == SyntaxKind.CloseBraceToken ||
            IsExpressionContinuationAfterBraceAt(nextOffset, Peek(nextOffset - 1))
    }

    private func NestedBraceStartsContinuedExpression() bool {
        let nextOffset = SkipBalancedGroup(0)
        return IsExpressionContinuationAfterBraceAt(nextOffset, Peek(nextOffset - 1))
    }

    private func IsExpressionContinuationAfterBraceAt(offset int32, closeBrace SyntaxToken) bool {
        let continuation = Peek(offset)
        if (continuation.Kind == SyntaxKind.PlusPlusToken || continuation.Kind == SyntaxKind.MinusMinusToken) &&
            IsTokenOnNewLineAfter(continuation, closeBrace) {
            return false
        }
        return IsExpressionContinuationAt(offset)
    }

    private func IsExpressionContinuationAt(offset int32) bool -> IsExpressionContinuation(Peek(offset).Kind) ||
        (
        Peek(offset).Kind == SyntaxKind.IdentifierToken && Peek(offset).Text == "with" && Peek(
            offset + 1
        ).Kind == SyntaxKind.OpenBraceToken
    )

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
    private func LooksLikeIfExpression() bool {
        // `i` is the offset of the `if` keyword for the current chain link.
        // Peek(0) is the current token (the leading `if`).
        var i = 0
        while true {
            // Locate this link's then-block opening brace: the first `{` at
            // paren and bracket depth zero after the `if` keyword at offset i.
            var j = i + 1
            while true {
                let k = Peek(j).Kind
                if k == SyntaxKind.EndOfFileToken {
                    return false
                }
                if k == SyntaxKind.OpenBraceToken {
                    break
                }
                if k == SyntaxKind.OpenParenthesisToken ||
                    k == SyntaxKind.OpenSquareBracketToken ||
                    k == SyntaxKind.QuestionOpenBracketToken {
                    j = SkipBalancedGroup(j)
                } else {
                    j++
                }
            }
            j = SkipBalancedGroup(j)
            // `j` is now just past this link's matching close brace. Inspect what
            // follows to decide whether the chain continues or terminates.
            if Peek(j).Kind != SyntaxKind.ElseKeyword {
                // No `else`: this link has a path with no value, so the whole
                // chain is a void if-statement.
                return false
            }
            if Peek(j + 1).Kind == SyntaxKind.IfKeyword {
                // `else if`: continue walking the chain from the inner `if`.
                i = j + 1
                continue
            }
            // Plain final `else { ... }`: shape requirement satisfied (every
            // path yields a value). Issue #2349: also require the POSITION
            // requirement — this chain must be the last item in its
            // enclosing block expression, i.e. immediately followed by that
            // block's closing `}`, or it can never actually be used as a
            // value and must be a void if-statement instead. Scan the final
            // else-block to its own matching close brace to find that
            // position.
            if Peek(j + 1).Kind != SyntaxKind.OpenBraceToken {
                return false
            }
            let m = SkipBalancedGroup(j + 1)
            // `m` is now just past the final else-block's matching close brace.
            // Value-producing only when immediately followed by the
            // enclosing block expression's own closing brace (tail position).
            return Peek(m).Kind == SyntaxKind.CloseBraceToken
        }
    }

    private func ParseNameExpression() ExpressionSyntax {
        let identifierToken = MatchToken(SyntaxKind.IdentifierToken)
        return NameExpressionSyntax(syntaxTree, identifierToken)
    }

    private func IsStructLiteralFollowingBrace(braceOffsetPlusOne int32) bool {
        // braceOffsetPlusOne is the offset of the token AFTER the '{'. A struct
        // literal is empty (`}`), starts with a spread, or starts with `Identifier :`.
        let k0 = Peek(braceOffsetPlusOne).Kind
        if k0 == SyntaxKind.CloseBraceToken {
            return true
        }
        if k0 == SyntaxKind.EllipsisToken {
            return true
        }
        if k0 == SyntaxKind.IdentifierToken && Peek(braceOffsetPlusOne + 1).Kind == SyntaxKind.ColonToken {
            return true
        }
        return false
    }

    // In a body-header controlling expression (`if`/`while`/`for` clauses, a
    // `for-in` collection, an `if let` initializer/guard, a `fixed` source, a
    // `select` arm operand, …) bare struct literals are suppressed so a
    // trailing `{` opens the statement body (issue #1575). The caller only
    // reaches this method after `IsStructLiteralFollowingBrace` has already
    // admitted the brace's content, i.e. only for content that is empty,
    // spread-led (`...`), or starts `Identifier :` — and THAT last shape is
    // exactly a label's spelling too (`retry: break`), so "the brace holds a
    // struct-literal field list" cannot be decided from the first token
    // alone. Issue #4189: an empty body already needed the same
    // disambiguation (below); a non-empty one does too, generalized the same
    // way — look at what follows the CANDIDATE brace's matching close:
    //   * a further `{`            -> this brace was the struct literal, that
    //                                 `{` is the real body (two-brace shape,
    //                                 e.g. `for v in Numbers{X: 1} { … }`);
    //   * an operator/`,`/`:` that lets the surrounding expression legitimately
    //                                 continue (e.g. `Pt{X: 1} == p`, an
    //                                 `if let` binding list's `,`, a ternary's
    //                                 `:`) -> also a struct literal, just not
    //                                 the WHOLE header;
    //   * anything else            -> the header's own required body brace
    //                                 would otherwise have nothing left to
    //                                 open it, so THIS `{ … }` must be that
    //                                 body instead (`if flag { retry: break }`,
    //                                 where the label's shape previously got
    //                                 mistaken for a struct-literal field and
    //                                 swallowed the body, per #4189).
    // A spread-led brace (`Ident{...expr}`) reaches the same check, but no G#
    // statement can begin with a bare `...` (see ParseStatement's dispatch),
    // so it can never actually collide with a body — the check still applies
    // uniformly and simply always resolves in the struct literal's favor for
    // that shape, exactly as before #4189.
    // <paramref name="braceOffset"/> is the offset of the opening `{`.
    private func StructLiteralAllowedInSuppressedHeader(braceOffset int32) bool {
        if Peek(braceOffset + 1).Kind == SyntaxKind.CloseBraceToken {
            // Empty `Ident{}`: only a for-in / for-tuple-range collection and
            // a C-style `for`'s post clause (the callers that pass
            // allowEmptyStructLiteralCollection: true) may treat an empty
            // struct literal immediately followed by a body `{` as a struct
            // literal. Every other suppressed header (if/while conditions,
            // `if let`, `fixed`, a `select` arm) never does: the identifier is
            // the condition/operand and `{}` is the empty body
            // (`if disposing {} { .. }`).
            return allowEmptyStructLiteralInHeader && Peek(braceOffset + 2).Kind == SyntaxKind.OpenBraceToken
        }
        if StartsWithUnambiguousLabel(braceOffset) {
            // See StartsWithUnambiguousLabel: a jump-keyword label can never
            // be a struct-literal field or property-pattern entry, so this
            // is unconditionally the header's own body regardless of brace
            // count or what follows it.
            return false
        }
        if !TryFindMatchingCloseBraceOffset(braceOffset, out var closeBraceOffset) {
            // Bounded lookahead exhausted without finding the matching `}`
            // (a pathologically large brace body). Preserve the pre-#4189
            // permissive default rather than risk misclassifying a
            // legitimate struct literal as a statement body on a guess.
            return true
        }
        return IsSafeStructLiteralContinuationAfterBrace(closeBraceOffset)
    }

    // Issue #4189: bounded-lookahead companion to the empty-brace check above,
    // used only for the non-empty case. Scans forward from the CANDIDATE
    // struct literal's opening `{` (at <paramref name="openBraceOffset"/>) to
    // its own matching `}`, tracking brace depth so a nested block/collection
    // literal inside the content does not end the scan early. Token-level
    // scanning (rather than a text-based brace count) means a `{`/`}` inside a
    // string or interpolated-string token is never mistaken for a real brace,
    // since the lexer emits those as a single token.
    private func TryFindMatchingCloseBraceOffset(openBraceOffset int32, out closeBraceOffset int32) bool {
        var depth = 0
        let scanBound = openBraceOffset + LookaheadMaxScan
        for var i = openBraceOffset; i <= scanBound; i++ {
            let kind = Peek(i).Kind
            if kind == SyntaxKind.EndOfFileToken {
                break
            }
            if kind == SyntaxKind.OpenBraceToken {
                depth++
            } else if kind == SyntaxKind.CloseBraceToken {
                depth--
                if depth == 0 {
                    closeBraceOffset = i
                    return true
                }
            }
        }
        closeBraceOffset = 0
        return false
    }

    // Issue #4189: whether the token immediately after a candidate struct
    // literal's matching close brace (at <paramref name="closeBraceOffset"/>)
    // still lets the struct-literal reading stand — either a genuine second
    // body brace (the two-brace shape) or a token under which the surrounding
    // suppressed expression legitimately keeps going rather than having
    // already ended. `,` and `:` are accepted alongside
    // <see cref="IsExpressionContinuationAfterBraceAt"/>'s operators because
    // they terminate a struct-literal sub-expression in call sites this
    // helper also serves — an `if let` binding list's `,` between bindings,
    // and a ternary's `:` between arms (`for v in flag ? Pt{X: 1} : other { … }`)
    // — neither of which is itself a binary/postfix operator.
    // Reusing IsExpressionContinuationAfterBraceAt (rather than the plain
    // token-kind check) also keeps this in sync with the file's other
    // brace-continuation callers on two edges: `with { … }` (a continuation
    // its sibling <see cref="IsExpressionContinuation"/> alone does not know
    // about) and a `++`/`--` on its own following line (never a continuation
    // of what the brace just closed).
    private func IsSafeStructLiteralContinuationAfterBrace(closeBraceOffset int32) bool {
        let afterOffset = closeBraceOffset + 1
        let kind = Peek(afterOffset).Kind
        return kind == SyntaxKind.OpenBraceToken ||
            kind == SyntaxKind.CommaToken ||
            kind == SyntaxKind.ColonToken ||
            IsExpressionContinuationAfterBraceAt(afterOffset, Peek(closeBraceOffset))
    }

    // Issue #4189 follow-up (Copilot review of PR #4203): a following `{`
    // after the candidate's matching close is NOT on its own proof of a
    // two-brace struct-literal-then-body shape — a genuinely LABELED body
    // (`retry: break`) immediately followed by an unrelated second block
    // (`if flag { retry: break } { var y = 1 }`, itself legal G# — two
    // consecutive block statements) hits that exact branch and was
    // misclassified as a struct literal, reproducing #4189's original bug.
    // But the two-brace branch is equally load-bearing for a genuine
    // field/property-pattern whose first field's spelling only coincides
    // with a label (`if value is string { Length: > 0 } { }` — a type
    // pattern's property-pattern content, unrelated to #4189, pinned by
    // Issue3351IsPatternParserTests and Adr0174SelectArmOperandParserTests):
    // gating the branch broadly (e.g. by suppressed-header kind) breaks
    // those, since they share the exact same if-condition context as the
    // label case.
    //
    // The two shapes differ only in what follows the label-shaped colon: a
    // label's target is a STATEMENT (`break`/`continue`/`goto`/`return` are
    // the jump keywords this fix's own repro and issue text use, and none of
    // them can ever open a struct-literal field's VALUE or a property
    // pattern's own pattern), while a field/property-pattern's value is an
    // EXPRESSION or nested PATTERN, which never starts with one of those
    // keywords. So this check runs BEFORE the matching-close scan even
    // starts, unconditionally overriding it as soon as the candidate's very
    // first token is unambiguously a label rather than a field: neither
    // brace count nor what follows the close matters once this is true.
    private func StartsWithUnambiguousLabel(braceOffset int32) bool -> Peek(
        braceOffset + 1
    ).Kind == SyntaxKind.IdentifierToken &&
        Peek(braceOffset + 2).Kind == SyntaxKind.ColonToken &&
        (
        Peek(braceOffset + 3).Kind is SyntaxKind.BreakKeyword or
            SyntaxKind.ContinueKeyword or
            SyntaxKind.GotoKeyword or
            SyntaxKind.ReturnKeyword
    )

    private func ParseStructLiteralExpression() ExpressionSyntax {
        let typeIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let (spreadToken, spreadExpression, spreadSeparator, elements) = ParseStructLiteralInitializers()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return StructLiteralExpressionSyntax(
            syntaxTree,
            typeIdentifier,
            openBrace,
            spreadToken,
            spreadExpression,
            spreadSeparator,
            elements,
            closeBrace
        )
    }

    private func ParseStructLiteralInitializers()(
        SpreadToken SyntaxToken?,
        SpreadExpression ExpressionSyntax?,
        SpreadSeparator SyntaxToken?,
        Elements SeparatedSyntaxList[StructLiteralElementSyntax]
    ) {
        var spreadToken SyntaxToken? = nil
        var spreadExpression ExpressionSyntax? = nil
        var spreadSeparator SyntaxToken? = nil
        if Current.Kind == SyntaxKind.EllipsisToken {
            spreadToken = MatchToken(SyntaxKind.EllipsisToken)
            spreadExpression = ParseExpression()
            if Current.Kind == SyntaxKind.CommaToken {
                spreadSeparator = MatchToken(SyntaxKind.CommaToken)
            }
        }
        // ADR-0180: once a leading structural spread (ADR-0148) has claimed
        // the first slot, every remaining entry stays a plain
        // `Identifier: value` member, exactly as before this ADR — mixing a
        // bare/`...` content element in there would blur an explicit member
        // override with an Add-call element, which ADR-0148 §B does not
        // allow. Content elements are only legal when there is no leading
        // structural spread.
        let allowContentElements = spreadToken == nil
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            nodesAndSeparators.Add(ParseStructLiteralElement(allowContentElements))
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return (
            spreadToken,
            spreadExpression,
            spreadSeparator,
            SeparatedSyntaxList[StructLiteralElementSyntax](nodesAndSeparators.ToImmutable())
        )
    }

    // ADR-0180: an ordered struct-literal element is a `Identifier: value`
    // member (always), or — when no leading ADR-0148 structural spread is in
    // effect — a bare content element or a `...source` content spread, both
    // of which lower to Add(...) on the constructed receiver, mirroring
    // ADR-0117's collection-element shapes. `allowContentElements` is false
    // only for the entries following a leading structural spread, where
    // ParseFieldInitializer's own MatchToken error recovery reports an
    // unexpected token exactly as it did before this ADR.
    private func ParseStructLiteralElement(allowContentElements bool) StructLiteralElementSyntax {
        if !allowContentElements ||
            (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonToken) {
            return ParseFieldInitializer()
        }
        // Element values live inside the braces — a fresh expression context
        // where trailing object/collection initializers are again allowed,
        // mirroring ParseCollectionElement.
        let savedSuppress = suppressTrailingObjectInitializer
        suppressTrailingObjectInitializer = 0
        let savedStructLiteral = suppressStructLiteral
        suppressStructLiteral = 0
        try {
            if Current.Kind == SyntaxKind.EllipsisToken {
                let ellipsis = MatchToken(SyntaxKind.EllipsisToken)
                let spread = SpreadElementExpressionSyntax(syntaxTree, ellipsis, ParseExpression())
                return StructLiteralContentElementSyntax(syntaxTree, spread)
            }
            let expression = ParseExpression()
            return StructLiteralContentElementSyntax(syntaxTree, expression)
        } finally {
            suppressTrailingObjectInitializer = savedSuppress
            suppressStructLiteral = savedStructLiteral
        }
    }

    private func ParseFieldInitializer() FieldInitializerSyntax {
        let fieldId = MatchToken(SyntaxKind.IdentifierToken)
        let colon = MatchToken(SyntaxKind.ColonToken)
        let value = ParseFieldInitializerValue()
        return FieldInitializerSyntax(syntaxTree, fieldId, colon, value)
    }

    // Issue #1567: a composite/object-initializer member value may be a braced
    // `{ elements }` collection initializer that populates a get-only collection
    // property by lowering to `.Add(...)` calls (the C# collection-initializer-
    // in-object-initializer pattern `Prop = { a, b }`). A brace can never start a
    // normal expression in value position, so its presence unambiguously selects
    // the target-less collection-initializer form; anything else is an ordinary
    // assignment value.
    private func ParseFieldInitializerValue() ExpressionSyntax {
        if Current.Kind == SyntaxKind.OpenBraceToken {
            return ParseCollectionInitializerExpression(target: nil)
        }
        return ParseExpression()
    }

    private func ParseFieldEqualsInitializers() SeparatedSyntaxList[FieldInitializerSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let fieldId = MatchToken(SyntaxKind.IdentifierToken)
            let equals = MatchToken(SyntaxKind.EqualsToken)
            let value = ParseFieldInitializerValue()
            nodesAndSeparators.Add(FieldInitializerSyntax(syntaxTree, fieldId, equals, value))
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[FieldInitializerSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseParenthesizedExpression() ExpressionSyntax {
        let left = MatchToken(SyntaxKind.OpenParenthesisToken)
        // ADR-0172: a leading `identifier :` commits to a labeled tuple
        // literal — `(line: 1, column: 2)`. The only other colon directly
        // inside plain parens is the ADR-0061 conditional-ref form
        // `(cond ? a : b)`, whose colon never immediately follows the first
        // identifier, so one token of lookahead disambiguates.
        if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonToken {
            return ParseLabeledTupleLiteral(left)
        }
        // Issue #522: a parenthesised expression is a fresh inner context —
        // even inside an `if (T() { X = 1 }) { body }` style header, the
        // inner call should still admit a trailing object initializer.
        var expression ExpressionSyntax
        let savedSuppress = suppressTrailingObjectInitializer
        suppressTrailingObjectInitializer = 0
        // A parenthesised expression is likewise a fresh context for the bare
        // `Ident { }` struct-literal form, so `(Pt{X: 1})` is recognised even
        // inside a body-header condition (`if p == (Pt{X: 1}) { }`, #1575).
        let savedStructLiteral = suppressStructLiteral
        suppressStructLiteral = 0
        // Issue #1038: a parenthesised expression is a fresh context, so a
        // parenthesised range (`a[(1..3)]`) is recognised as a standalone
        // `System.Range` value even inside an index bound.
        let savedRange = suppressRangeOperator
        suppressRangeOperator = 0
        try {
            expression = ParseExpression()
        } finally {
            suppressTrailingObjectInitializer = savedSuppress
            suppressStructLiteral = savedStructLiteral
            suppressRangeOperator = savedRange
        }
        // ADR-0061: `(cond ? lvalue : lvalue)` parses as a conditional ref-arg
        // expression when a `?` immediately follows the inner expression. The
        // resulting node is only legal in ref-argument / `&` operand contexts;
        // the binder rejects it otherwise.
        if Current.Kind == SyntaxKind.QuestionToken {
            expression = MaybeParseConditionalRefArgumentTail(expression, outerModifier: nil)
        }
        // Phase 4.5: `(a, b, ...)` is a tuple literal. Detection is purely
        // post-fix: parse the first expression, then if a comma follows we
        // collect the remaining tuple elements; otherwise this is a regular
        // parenthesized expression.
        if Current.Kind == SyntaxKind.CommaToken {
            let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
            nodesAndSeparators.Add(expression)
            while Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                nodesAndSeparators.Add(ParseTupleLiteralElement())
            }
            let rightParen = MatchToken(SyntaxKind.CloseParenthesisToken)
            return TupleLiteralExpressionSyntax(
                syntaxTree,
                left,
                SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable()),
                rightParen
            )
        }
        let right = MatchToken(SyntaxKind.CloseParenthesisToken)
        return ParenthesizedExpressionSyntax(syntaxTree, left, expression, right)
    }

    /// ADR-0172: parses one tuple-literal element — an optional
    /// `name :` label followed by the element expression.
    private func ParseTupleLiteralElement() ExpressionSyntax {
        if Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.ColonToken {
            let nameToken = MatchToken(SyntaxKind.IdentifierToken)
            let colonToken = MatchToken(SyntaxKind.ColonToken)
            let value = ParseExpression()
            return NamedTupleElementSyntax(syntaxTree, nameToken, colonToken, value)
        }
        return ParseExpression()
    }

    /// ADR-0172: parses a tuple literal whose FIRST element is labeled —
    /// `(line: 1, column: 2)` — reached when the token after the opening
    /// paren is `identifier :`. A lone labeled element `(x: 1)` is an error
    /// (grouping parens take no label, and there are no 1-tuples); it reports
    /// GS0543 and recovers as a plain parenthesized expression.
    private func ParseLabeledTupleLiteral(left SyntaxToken) ExpressionSyntax {
        // Same fresh inner context the plain parenthesized path establishes
        // (issues #522/#1575/#1038).
        let savedSuppress = suppressTrailingObjectInitializer
        let savedStructLiteral = suppressStructLiteral
        let savedRange = suppressRangeOperator
        suppressTrailingObjectInitializer = 0
        suppressStructLiteral = 0
        suppressRangeOperator = 0
        try {
            let firstElement = ParseTupleLiteralElement()
            if Current.Kind != SyntaxKind.CommaToken {
                let right = MatchToken(SyntaxKind.CloseParenthesisToken)
                if firstElement is NamedTupleElementSyntax lonelyLabeled {
                    Diagnostics.ReportTupleElementNameOutsideTuple(lonelyLabeled.NameToken.Location)
                    return ParenthesizedExpressionSyntax(syntaxTree, left, lonelyLabeled.Expression, right)
                }
                return ParenthesizedExpressionSyntax(syntaxTree, left, firstElement, right)
            }
            let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
            nodesAndSeparators.Add(firstElement)
            while Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                nodesAndSeparators.Add(ParseTupleLiteralElement())
            }
            let rightParen = MatchToken(SyntaxKind.CloseParenthesisToken)
            return TupleLiteralExpressionSyntax(
                syntaxTree,
                left,
                SeparatedSyntaxList[ExpressionSyntax](nodesAndSeparators.ToImmutable()),
                rightParen
            )
        } finally {
            suppressTrailingObjectInitializer = savedSuppress
            suppressStructLiteral = savedStructLiteral
            suppressRangeOperator = savedRange
        }
    }

    private func ParseBooleanLiteral() ExpressionSyntax {
        let isTrue = Current.Kind == SyntaxKind.TrueKeyword
        let keywordToken = if isTrue {
            MatchToken(SyntaxKind.TrueKeyword)
        } else {
            MatchToken(SyntaxKind.FalseKeyword)
        }
        return LiteralExpressionSyntax(syntaxTree, keywordToken, isTrue)
    }

    private func ParseNilLiteral() ExpressionSyntax {
        let keywordToken = MatchToken(SyntaxKind.NilKeyword)
        return LiteralExpressionSyntax(syntaxTree, keywordToken, nil)
    }

    private func ParseNumberLiteral() ExpressionSyntax {
        let numberToken = MatchToken(SyntaxKind.NumberToken)
        return LiteralExpressionSyntax(syntaxTree, numberToken)
    }

    private func ParseCharacterLiteral() ExpressionSyntax {
        let charToken = MatchToken(SyntaxKind.CharacterToken)
        return LiteralExpressionSyntax(syntaxTree, charToken)
    }

    private func ParseStringLiteral() ExpressionSyntax {
        let stringToken = MatchToken(SyntaxKind.StringToken)
        return LiteralExpressionSyntax(syntaxTree, stringToken)
    }

    private func ParseInterpolatedStringLiteral() ExpressionSyntax {
        let token = MatchToken(SyntaxKind.InterpolatedStringToken)
        // MatchToken(InterpolatedStringToken) guarantees the lexer attached the
        // fragment array as the token's value.
        let fragments = Invariant.Required(
            token.Value as InterpolationFragments,
            "an interpolated-string token carries its lexer fragment wrapper",
            expression: "token.Value as InterpolationFragments"
        )
            .Items
        let segments = ImmutableArray.CreateBuilder[InterpolatedStringSegment](fragments.Length)
        for fragment in fragments {
            if !fragment.IsExpression {
                segments.Add(InterpolatedStringSegment.FromText(fragment.Text))
                continue
            }
            // ADR-0055: let the real expression parser find where the
            // expression ends, then split the simple alignment/format tail.
            // This keeps hole disambiguation in sync with every expression
            // form, including ternaries and nullable-element array literals.
            var expressionLength = fragment.Text.Length
            // No separator character means the expression necessarily fills the hole.
            if fragment.Text.IndexOf(',') >= 0 || fragment.Text.IndexOf(':') >= 0 {
                let probeParser = Parser(syntaxTree, fragment.Position, fragment.Position + fragment.Text.Length)
                let _ = probeParser.ParseExpression()
                expressionLength = if probeParser
                    .Current
                    .Kind == SyntaxKind.CommaToken ||
                    probeParser
                    .Current
                    .Kind == SyntaxKind.ColonToken {
                    probeParser.Current.Position - fragment.Position
                } else {
                    fragment.Text.Length
                }
            }
            SplitTail(fragment.Text, expressionLength, out var exprText, out var alignmentText, out var formatText)
            // ADR-0055 §C: anchor diagnostics on the hole itself (using the
            // hole's true source offset) rather than the whole string token.
            let holeSpan = TextSpan(fragment.Position, Math.Max(1, fragment.Text.Length))
            let holeLocation = TextLocation(syntaxTree.Text, holeSpan)
            if string.IsNullOrWhiteSpace(exprText) {
                Diagnostics.ReportEmptyInterpolationHole(holeLocation)
            }
            if formatText != nil && formatText.Length == 0 {
                Diagnostics.ReportEmptyInterpolationFormat(holeLocation)
            }
            var alignment int32? = nil
            if alignmentText != nil {
                if int32.TryParse(
                    alignmentText.Trim(),
                    NumberStyles.AllowLeadingSign,
                    CultureInfo.InvariantCulture,
                    out var a
                ) {
                    alignment = a
                } else {
                    Diagnostics.ReportInvalidInterpolationAlignment(holeLocation, alignmentText)
                }
            }
            // ADR-0055 §C / issue #1605: parse the captured expression directly out of
            // the outer syntax tree's own text, bounded to [fragment.Position,
            // fragment.Position + exprText.Length). Every inner token/node is built
            // against the SAME outer SyntaxTree, so its Position is already the true
            // absolute offset in the outer file — no padded-copy allocation or re-lex
            // of the file prefix is needed (that was O(fileSize) per hole).
            // Do not reuse the probe tree: its window includes alignment/format text
            // lexed as code, so filtering its diagnostics would change malformed-hole
            // recovery. Reparse only the bounded expression instead.
            let innerParser = Parser(syntaxTree, fragment.Position, fragment.Position + exprText.Length)
            // A hole is a value position: statement parsing makes `ordinal++`
            // yield its updated value instead of the original one.
            var innerExpression ExpressionSyntax? = if innerParser.Current.Kind == SyntaxKind.EndOfFileToken {
                default(ExpressionSyntax?)
            } else {
                innerParser.ParseExpression()
            }
            innerParser.MatchToken(SyntaxKind.EndOfFileToken)
            Diagnostics.AddRange(innerParser.Diagnostics)
            if innerExpression == nil {
                // Fall back to a synthetic missing-name node anchored on the
                // hole (at its true offset) so binders still see a valid
                // (error-producing) expression syntax.
                let synthetic = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, fragment.Position, exprText, nil)
                innerExpression = NameExpressionSyntax(syntaxTree, synthetic)
            }
            segments.Add(InterpolatedStringSegment.FromExpression(innerExpression, alignment, formatText))
        }
        return InterpolatedStringExpressionSyntax(syntaxTree, token, segments.ToImmutable())
    }

    shared {
        private func IsExpressionContinuation(kind SyntaxKind) bool -> kind == SyntaxKind.DotToken ||
            kind == SyntaxKind.QuestionDotToken ||
            kind == SyntaxKind.RightArrowToken ||
            kind == SyntaxKind.LeftArrowToken ||
            kind == SyntaxKind.OpenSquareBracketToken ||
            kind == SyntaxKind.QuestionOpenBracketToken ||
            kind == SyntaxKind.OpenParenthesisToken ||
            kind == SyntaxKind.BangBangToken ||
            kind == SyntaxKind.PlusPlusToken ||
            kind == SyntaxKind.MinusMinusToken ||
            kind == SyntaxKind.PlusToken ||
            kind == SyntaxKind.PlusEqualsToken ||
            kind == SyntaxKind.MinusToken ||
            kind == SyntaxKind.MinusEqualsToken ||
            kind == SyntaxKind.StarToken ||
            kind == SyntaxKind.StarEqualsToken ||
            kind == SyntaxKind.SlashToken ||
            kind == SyntaxKind.SlashEqualsToken ||
            kind == SyntaxKind.PercentToken ||
            kind == SyntaxKind.PercentEqualsToken ||
            kind == SyntaxKind.AmpersandToken ||
            kind == SyntaxKind.AmpersandAmpersandToken ||
            kind == SyntaxKind.AmpersandEqualsToken ||
            kind == SyntaxKind.AmpersandHatToken ||
            kind == SyntaxKind.AmpersandHatEqualsToken ||
            kind == SyntaxKind.PipeToken ||
            kind == SyntaxKind.PipePipeToken ||
            kind == SyntaxKind.PipeEqualsToken ||
            kind == SyntaxKind.HatToken ||
            kind == SyntaxKind.HatEqualsToken ||
            kind == SyntaxKind.EqualsEqualsToken ||
            kind == SyntaxKind.EqualsToken ||
            kind == SyntaxKind.BangEqualsToken ||
            kind == SyntaxKind.LessToken ||
            kind == SyntaxKind.LessOrEqualsToken ||
            kind == SyntaxKind.ShiftLeftToken ||
            kind == SyntaxKind.ShiftLeftEqualsToken ||
            kind == SyntaxKind.GreaterToken ||
            kind == SyntaxKind.GreaterOrEqualsToken ||
            kind == SyntaxKind.ShiftRightToken ||
            kind == SyntaxKind.ShiftRightEqualsToken ||
            kind == SyntaxKind.UnsignedShiftRightToken ||
            kind == SyntaxKind.UnsignedShiftRightEqualsToken ||
            kind == SyntaxKind.QuestionToken ||
            kind == SyntaxKind.QuestionQuestionToken ||
            kind == SyntaxKind.QuestionQuestionEqualsToken ||
            kind == SyntaxKind.DotDotToken ||
            kind == SyntaxKind.IsKeyword ||
            kind == SyntaxKind.AsKeyword

        private func SplitTail(
            hole string,
            expressionLength int32,
            out expr string,
            out alignment string?,
            out format string?
        ) {
            expr = hole.Substring(0, expressionLength)
            alignment = nil
            format = nil
            if expressionLength >= hole.Length {
                return
            }
            if hole[expressionLength] == ',' {
                let colonIndex = hole.IndexOf(':', expressionLength + 1)
                let alignmentEnd = if colonIndex >= 0 {
                    colonIndex
                } else {
                    hole.Length
                }
                alignment = hole.Substring(expressionLength + 1, alignmentEnd - expressionLength - 1)
                if colonIndex >= 0 {
                    format = hole.Substring(colonIndex + 1)
                }
            } else {
                format = hole.Substring(expressionLength + 1)
            }
        }
    }
}
