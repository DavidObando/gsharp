// <copyright file="Parser.Expressions.Lambdas.cs" company="GSharp">
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
    private func ParseFunctionLiteralExpression() ExpressionSyntax {
        // Phase 4.7 + 5.1: function literal `[async] func(p1 T1, p2 T2) R { body }`.
        var asyncModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword {
            asyncModifier = NextToken()
        }
        let funcKeyword = MatchToken(SyntaxKind.FuncKeyword)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseParameterList()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        // Issue #4219 (umbrella remainder): optional `ref`/`ref readonly`
        // return modifier on a function LITERAL, mirroring the named-function
        // form (`func Name(...) ref T { ... }`, Parser.Members.cs). Consumed
        // only when a type clause can start at the next token, so a literal
        // whose declared return type is literally named `ref` is unaffected.
        var returnRefModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" && CanStartTypeClause(Peek(1)) {
            returnRefModifier = NextToken()
        }
        let returnReadOnlyModifier = ParseOptionalReadOnlyRefModifier(returnRefModifier)
        let returnType = ParseOptionalTypeClause()
        let body = ParseBlockStatement()
        return FunctionLiteralExpressionSyntax(
            syntaxTree,
            asyncModifier,
            funcKeyword,
            openParen,
            parameters,
            closeParen,
            returnType,
            body,
            returnRefModifier,
            returnReadOnlyModifier
        )
    }

    // ADR-0074 / issue #714: bounded look-ahead for a lambda expression
    // starting at a `(`. Returns true if the token stream looks like
    // `() -> …`, `(ident type, …) -> …`, or (ADR-0076 / issue #716)
    // `(ident, …) -> …` (untyped — the binder fills the types from the
    // target). The disambiguator commits to a lambda whenever the matching
    // `)` is followed by `->` AND the interior either is empty or starts
    // with a parameter-name identifier; the lone trailing `->` after `)`
    // is unambiguously a lambda operator (it cannot be a binary expression
    // operator outside switch-arm position).
    //
    // ADR-0076 / issue #716: a leading `async` keyword is recognised by
    // the dispatcher in <see cref="ParsePrimaryExpression"/> as
    // `AsyncKeyword + OpenParenthesisToken + LooksLikeLambdaStart(offset:1)`,
    // so this helper takes an optional <paramref name="startOffset"/>.
    private func LooksLikeLambdaStart(startOffset int32 = 0) bool {
        if Peek(startOffset).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        // Walk forward counting nested grouping tokens until we find the
        // matching `)` for the opening `(`. Bail out if we cannot match.
        var parenDepth = 1
        var bracketDepth = 0
        var braceDepth = 0
        var offset = startOffset + 1
        const maxScan = 4096
        while offset - startOffset < maxScan {
            let k = Peek(offset).Kind
            if k == SyntaxKind.EndOfFileToken {
                return false
            }
            if k == SyntaxKind.OpenParenthesisToken {
                parenDepth++
            } else if k == SyntaxKind.CloseParenthesisToken {
                if bracketDepth == 0 && braceDepth == 0 {
                    parenDepth--
                    if parenDepth == 0 {
                        break
                    }
                } else {
                    parenDepth--
                }
            } else if k == SyntaxKind.OpenSquareBracketToken {
                bracketDepth++
            } else if k == SyntaxKind.CloseSquareBracketToken {
                if bracketDepth > 0 {
                    bracketDepth--
                }
            } else if k == SyntaxKind.OpenBraceToken {
                braceDepth++
            } else if k == SyntaxKind.CloseBraceToken {
                if braceDepth > 0 {
                    braceDepth--
                }
            }
            offset++
        }
        if parenDepth != 0 {
            return false
        }
        // Peek(offset) is the closing `)`. The lambda commit requires `->` to
        // immediately follow at the next non-trivia token slot.
        if Peek(offset + 1).Kind != SyntaxKind.RightArrowToken {
            return false
        }
        // Empty parameter list `()`: definitively a zero-param lambda.
        if offset == startOffset + 1 {
            return true
        }
        // Non-empty parameter list: the first interior token must look like a
        // parameter — i.e. an identifier (possibly preceded by `@` annotations
        // or the contextual `scoped`/`ref`/`out`/`in` modifiers used by
        // ParseParameter). ADR-0076 / issue #716: the type clause is OPTIONAL
        // on a lambda parameter, so the token AFTER the identifier may be
        // `,`, `)`, `=`, or anything else — the matching `)` is already
        // known to be followed by `->`, so the parse is unambiguously a
        // lambda once we see an identifier-shaped first slot.
        var j = startOffset + 1
        // Optional `@Annot[(args)]` annotations before the first parameter.
        while Peek(j).Kind == SyntaxKind.AtToken {
            j++
            if Peek(j).Kind == SyntaxKind.IdentifierToken {
                j++
                while Peek(j).Kind == SyntaxKind.DotToken && Peek(j + 1).Kind == SyntaxKind.IdentifierToken {
                    j += 2
                }
                if Peek(j).Kind == SyntaxKind.OpenParenthesisToken {
                    var innerDepth = 1
                    j++
                    while j < offset && innerDepth > 0 {
                        let kk = Peek(j).Kind
                        if kk == SyntaxKind.OpenParenthesisToken {
                            innerDepth++
                        } else if kk == SyntaxKind.CloseParenthesisToken {
                            innerDepth--
                        }
                        j++
                    }
                }
            }
        }
        // Optional `scoped` / `ref` / `out` / `in` contextual modifier.
        if Peek(j).Kind == SyntaxKind.IdentifierToken &&
            (Peek(j).Text == "scoped" || Peek(j).Text == "ref" || Peek(j).Text == "out" || Peek(j).Text == "in") &&
            Peek(j + 1).Kind == SyntaxKind.IdentifierToken {
            j++
        }
        // The first parameter slot must be an identifier (the parameter name)
        // OR — ADR-0185 — `(`, the opener of a tuple-destructuring parameter
        // pattern `(x T1, y T2, ...)`. There is no real ambiguity to resolve
        // between the TWO SHAPES here: an ORDINARY parameter's own grammar
        // never starts with `(` (its first token is always the name), so `(`
        // at this position can only be an attempt at a destructuring pattern
        // — the otherwise-similar-looking `(pair (string, int))` shape (one
        // parameter named `pair`, of parenthesized tuple TYPE) has `pair`,
        // an identifier, as ITS first interior token, so it never reaches
        // this branch at all.
        //
        // But `(` is also the opener of an ordinary parenthesized (or
        // doubly-parenthesized) EXPRESSION, e.g. `((1 + 2)) -> foo` — not a
        // lambda at all, just already-invalid code (`->` has no meaning
        // there outside a lambda or, in an unsafe context, pointer-arrow
        // access). Require the FIRST element slot of the candidate pattern
        // to itself look identifier-shaped — `Peek(j + 1)`, one token past
        // the pattern's own `(` — before committing, at exactly the same
        // one-token depth of scrutiny this check already applies to an
        // ORDINARY parameter's own first token just below; a numeric/
        // operator-first interior like `(1 + 2)` fails this and falls back
        // to the expression path for its original, clearer diagnostic.
        //
        // A full bounded trial-parse of the pattern (mirroring this
        // function's `unsafeDepth > 0` trial-parse block below) was tried
        // and rejected: it rejects on ANY diagnostic from the trial, which
        // wrongly also rejects a merely-untyped pattern like the C#-habit
        // `((x, y)) -> x + y` — that shape must still commit to the
        // destructuring-pattern path and surface
        // ParseTupleDeconstructionPattern's own "expected a type" diagnostic
        // (deliberate, and pinned by
        // MalformedDestructuringPattern_MissingElementType_ProducesDiagnostic),
        // not be silently misrouted to the expression path. This one-token
        // check accepts both `((x, y))` and `((x string, y int))` while
        // still rejecting `((1 + 2))`; it does not (and is not intended to)
        // catch every malformed shape — `((x + y)) -> foo` still commits and
        // gets a less-than-ideal diagnostic, exactly as the pre-existing,
        // un-flagged single-parameter case `(x + y) -> foo` already does
        // today (same one-token scrutiny level, applied uniformly).
        if Peek(j).Kind == SyntaxKind.OpenParenthesisToken {
            if Peek(j + 1).Kind != SyntaxKind.IdentifierToken {
                return false
            }
        } else if Peek(j).Kind != SyntaxKind.IdentifierToken {
            // Anything else (e.g. `(42)`, `(x + y)`) is treated as a
            // parenthesized expression / tuple even though `->` follows —
            // the parser surfaces a better diagnostic from the expression
            // path than from the parameter path.
            return false
        }
        // ADR-0122 §4 / issue #2002: `(<receiver>)->member = value` is
        // ambiguous with a lambda whenever the receiver's leading token looks
        // like a parameter name — grammatically, some receivers (e.g. a bare
        // identifier `(p)`, or even a call `(getPtr())` — a call's argument
        // list is *also* a valid lambda-parameter type-clause shape, see
        // `getPtr ()` parsed as "parameter getPtr of tuple type ()" — both
        // commit cleanly as a lambda parameter list, so grammar-only
        // trial-parsing (below) cannot disambiguate them from a genuine
        // pointer-arrow receiver. Break the tie using the tokens immediately
        // following the arrow: a lambda whose entire body is a bare
        // `member = value` (or compound-assignment) is vanishingly rare,
        // while this exact shape is the whole point of a parenthesized
        // arrow-assignment target — and mirrors the unparenthesized form,
        // where `unsafeDepth > 0` already commits `IDENT -> member` to
        // pointer-arrow access unconditionally (see the bare-identifier
        // dispatch case above in ParsePrimaryExpression). Bias towards
        // arrow-member ASSIGNMENT whenever the arrow is immediately followed
        // by `IDENT =` / `IDENT <compound-op>=`, for ANY receiver shape.
        // ponytail: this narrowly misclassifies the rare unsafe-context
        // multi-param lambda whose body happens to start with exactly that
        // shape (e.g. `(a, b) -> total = a + b`); upgrade to a fuller
        // parameter-count-aware check if that pattern is ever needed.
        if this.unsafeDepth > 0 && Peek(offset + 2).Kind == SyntaxKind.IdentifierToken &&
            (
            Peek(offset + 3).Kind == SyntaxKind.EqualsToken || SyntaxFacts.TryGetCompoundAssignmentBaseOperator(
                Peek(offset + 3).Kind,
                out _
            )
        ) {
            return false
        }
        // ADR-0122 §4 / issue #2002: inside an unsafe context, `->` after a
        // PARENTHESIZED receiver is ambiguous with a parenthesized lambda —
        // both `(p) -> body` (lambda) and `(p)->member` (pointer-arrow member
        // access on receiver `p`, desugared to `(*p).member` by
        // ParsePostfixChainCore) share the exact same leading shape (an
        // identifier-first interior followed by a matching `)` then `->`).
        // The cheap heuristic above (first interior token looks like a
        // parameter name) is exact for a genuine parameter list but
        // over-commits for a parenthesized arrow-receiver whose interior
        // continues with anything a parameter list can never contain — e.g.
        // `(a.b)->X`, or the double-indirection assignment target
        // `(*pp)->X = v` (already excluded above since `*` isn't an
        // identifier).
        //
        // Disambiguate precisely, but only where the ambiguity exists
        // (unsafeDepth > 0): speculatively trial-parse the interior as a
        // lambda parameter list. Only commit to the lambda if the trial
        // parse both consumes the interior without reporting any diagnostic
        // AND lands exactly on the closing `)` already located above —
        // otherwise the interior is not a valid parameter list, so this is a
        // parenthesized arrow-receiver instead and we fall through to the
        // normal expression/postfix-chain path (which handles arrow-member
        // access — and, transitively via TryLiftTrailingMemberAccess, arrow
        // assignment targets — for any receiver shape, including double
        // indirection). The trial parse never mutates externally-visible
        // parser state: position and diagnostics are unconditionally rolled
        // back.
        if this.unsafeDepth > 0 {
            let savedPosition = this.position
            let savedDiagnosticCount = Diagnostics.Count
            try {
                this.position = savedPosition + startOffset + 1
                ParseLambdaParameterList()
                return Current.Kind == SyntaxKind.CloseParenthesisToken && Diagnostics.Count == savedDiagnosticCount
            } finally {
                this.position = savedPosition
                Diagnostics.TruncateTo(savedDiagnosticCount)
            }
        }
        return true
    }

    private func ParseLambdaExpression() LambdaExpressionSyntax {
        // ADR-0074 / issue #714: `(p1 T1, p2 T2) -> body` lambda expression.
        // The opening `(` is required; an empty parameter list is permitted.
        // ADR-0076 / issue #716: an optional leading `async` modifier marks
        // an async arrow lambda, and parameter type clauses are optional
        // when a target type is available to infer them (the binder reports
        // GS0304 when no target type is in scope).
        var asyncModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.OpenParenthesisToken {
            asyncModifier = NextToken()
        }
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseLambdaParameterList()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        let arrow = MatchToken(SyntaxKind.RightArrowToken)
        let body = if Current.Kind == SyntaxKind.OpenBraceToken {
            cast[ExpressionSyntax](ParseBlockExpression())
        } else {
            ParseExpression()
        }
        return LambdaExpressionSyntax(syntaxTree, asyncModifier, openParen, parameters, closeParen, arrow, body)
    }

    // Issue #932: parses the single-identifier arrow-lambda shorthand
    // `x -> body`, equivalent to the parenthesised `(x) -> body`. The opening
    // and closing parentheses are absent (the corresponding tokens are left
    // null and are skipped by SyntaxNode child enumeration / span computation),
    // and the sole parameter carries no type clause, so the binder infers its
    // type from the target delegate exactly as it does for `(x) -> body` (or
    // reports GS0304 when no target type is in scope).
    private func ParseSingleIdentifierLambdaExpression() LambdaExpressionSyntax {
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let parameter = ParameterSyntax(syntaxTree, identifier, ellipsisToken: nil, type: nil)
        let parameters = SeparatedSyntaxList[ParameterSyntax](ImmutableArray.Create[SyntaxNode](parameter))
        let arrow = MatchToken(SyntaxKind.RightArrowToken)
        let body = if Current.Kind == SyntaxKind.OpenBraceToken {
            cast[ExpressionSyntax](ParseBlockExpression())
        } else {
            ParseExpression()
        }
        return LambdaExpressionSyntax(
            syntaxTree,
            asyncModifier: nil,
            openParenToken: nil,
            parameters,
            closeParenToken: nil,
            arrow,
            body
        )
    }

    // ADR-0076 / issue #716: arrow-lambda parameter lists allow each parameter's
    // type clause to be omitted (`(x) -> body` / `(x, y) -> body`). When the
    // binding supplies a target function type, the binder infers each missing
    // parameter type from the target. Otherwise, GS0304 fires. Parameter
    // default values and annotations remain supported by delegating to the
    // shared ParseLambdaParameter helper.
    private func ParseLambdaParameterList() SeparatedSyntaxList[ParameterSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNextParameter = true
        while parseNextParameter &&
            Current.Kind != SyntaxKind.CloseParenthesisToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            let parameter = ParseLambdaParameter()
            nodesAndSeparators.Add(parameter)
            if Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                nodesAndSeparators.Add(comma)
            } else {
                parseNextParameter = false
            }
        }
        return SeparatedSyntaxList[ParameterSyntax](nodesAndSeparators.ToImmutable())
    }

    // ADR-0076 / issue #716: a lambda parameter is structurally identical to
    // an ordinary parameter except that the type clause is optional. When the
    // type clause is absent (e.g. the parameter is `(x)`), the binder relies
    // on the target type to fill it in; with no target type, GS0304 fires.
    private func ParseLambdaParameter() ParameterSyntax {
        // ADR-0047: parameter-level annotations precede the identifier.
        let annotations = ParseAnnotations()
        // ADR-0185: a tuple-destructuring parameter `(x T1, y T2, ...)`.
        // Unambiguous at this point — see LooksLikeLambdaStart's matching
        // comment — so no scoped/ref/ellipsis/default-value handling
        // applies to this shape; those modifiers are ordinary-parameter-only
        // and a destructured parameter's own tuple type is never optional or
        // variadic.
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            let pattern = ParseTupleDeconstructionPattern()
            return ParameterSyntax(syntaxTree, pattern).WithAnnotations(annotations)
        }
        // ADR-0058 / issue #376: optional `scoped` contextual modifier.
        var scopedModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped" && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken {
            scopedModifier = NextToken()
        }
        // ADR-0060: optional `ref`/`out`/`in` contextual modifier.
        var refKindModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken &&
            (Current.Text == "ref" || Current.Text == "out" || Current.Text == "in") &&
            Peek(1).Kind == SyntaxKind.IdentifierToken {
            refKindModifier = NextToken()
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        var ellipsis SyntaxToken? = nil
        if Current.Kind == SyntaxKind.EllipsisToken {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken)
        }
        // ADR-0076 / issue #716: the type clause is OPTIONAL on a lambda
        // parameter; with no type, the binder uses the target type's
        // corresponding slot, or reports GS0304 when no target is in scope.
        let type = ParseOptionalTypeClause()
        // ADR-0063: optional default-value clause.
        var equalsToken SyntaxToken? = nil
        var defaultValue ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.EqualsToken {
            equalsToken = NextToken()
            defaultValue = ParseExpression()
        }
        let parameter = ParameterSyntax(syntaxTree, identifier, ellipsis, type).WithAnnotations(annotations)
        parameter.ScopedModifier = scopedModifier
        parameter.RefKindModifier = refKindModifier
        parameter.EqualsToken = equalsToken
        parameter.DefaultValue = defaultValue
        return parameter
    }

    // ADR-0185: `(name1 T1, name2 T2, ...)` — a flat tuple-destructuring
    // pattern in arrow-lambda parameter position, extending the existing
    // statement-position mechanism (`let (a, b) = e`, ADR-0032/ADR-0168)
    // into parameter position. Each element requires an explicit type (this
    // proposal deliberately does not extend target-typed parameter
    // inference, ADR-0076/issue #716, to a destructured element — see
    // ADR-0185's Decision) — a missing type surfaces its own diagnostic from
    // ParseTypeClause rather than silently falling back to inference, which
    // also means a malformed pattern (e.g. a C#-habit untyped
    // `((x, y)) -> x + y`) still commits to the lambda/parameter path and
    // gets a real "expected type" diagnostic instead of a confusing
    // tuple-expression error from the parenthesized-expression fallback.
    // Flat only (open question 3): an element can never itself be another
    // destructuring pattern — the grammar simply never offers that
    // production, so a stray `(` in element position fails as "expected
    // identifier" rather than opening a nested pattern.
    //
    // A pattern with fewer than two elements (e.g. `(x string)`) parses
    // cleanly here — G# has no 1-tuples, but that is a BINDER-time
    // rejection (mirroring ParseTupleTypeClause's existing `(T)` grouping /
    // stray-name handling for the tuple TYPE grammar), not a parse error;
    // rejecting it here would make the LooksLikeLambdaStart lookahead's
    // trial-parse (used only in the pre-existing unsafeDepth > 0 ambiguity)
    // reject an otherwise well-formed destructuring attempt outright.
    private func ParseTupleDeconstructionPattern() TupleDeconstructionPatternSyntax {
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNextElement = true
        while parseNextElement &&
            Current.Kind != SyntaxKind.CloseParenthesisToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            let elementIdentifier = MatchToken(SyntaxKind.IdentifierToken)
            let elementType = ParseTypeClause()
            nodesAndSeparators.Add(ParameterSyntax(syntaxTree, elementIdentifier, ellipsisToken: nil, elementType))
            if Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                nodesAndSeparators.Add(comma)
            } else {
                parseNextElement = false
            }
        }
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return TupleDeconstructionPatternSyntax(
            syntaxTree,
            openParen,
            SeparatedSyntaxList[ParameterSyntax](nodesAndSeparators.ToImmutable()),
            closeParen
        )
    }

    private func ParseSwitchExpression() ExpressionSyntax {
        let switchKeyword = MatchToken(SyntaxKind.SwitchKeyword)
        let expression = ParseExpressionInBodyHeader()
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let arms = ImmutableArray.CreateBuilder[SwitchExpressionArmSyntax]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            arms.Add(ParseSwitchExpressionArm())
            if Current == startToken {
                NextToken()
            }
        }
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        return SwitchExpressionSyntax(syntaxTree, switchKeyword, expression, openBrace, arms.ToImmutable(), closeBrace)
    }

    private func ParseSwitchExpressionArm() SwitchExpressionArmSyntax {
        if Current.Kind == SyntaxKind.DefaultKeyword {
            let defaultKeyword = MatchToken(SyntaxKind.DefaultKeyword)
            let defaultArrow = MatchSwitchExpressionArmSeparator()
            let defaultResult = ParseExpression()
            return SwitchExpressionArmSyntax(
                syntaxTree,
                defaultKeyword,
                value: nil,
                whenKeyword: nil,
                $guard: nil,
                defaultArrow,
                defaultResult
            )
        }
        let caseKeyword = MatchToken(SyntaxKind.CaseKeyword)
        let value = ParsePattern(PatternParseContext.SwitchExpression)
        let (whenKeyword, guard_) = ParseOptionalWhenGuard()
        let arrow = MatchSwitchExpressionArmSeparator()
        let result = ParseExpression()
        return SwitchExpressionArmSyntax(syntaxTree, caseKeyword, value, whenKeyword, guard_, arrow, result)
    }

    // ADR-0074 / issue #714: switch-expression arms accept either `:` (new) or
    // `->` (deprecated). On `->` the parser records GS0302 and continues —
    // both forms produce the same SwitchExpressionArmSyntax node and the
    // separator token's Kind tells callers which form was used.
    private func MatchSwitchExpressionArmSeparator() SyntaxToken {
        if Current.Kind == SyntaxKind.ColonToken {
            return MatchToken(SyntaxKind.ColonToken)
        }
        if Current.Kind == SyntaxKind.RightArrowToken {
            let arrow = MatchToken(SyntaxKind.RightArrowToken)
            Diagnostics.ReportSwitchExpressionArmArrowDeprecated(arrow.Location)
            return arrow
        }
        return MatchToken(SyntaxKind.ColonToken)
    }
}
