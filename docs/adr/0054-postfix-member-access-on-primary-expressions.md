# ADR-0054: Postfix member/index access on primary expressions

- **Status**: Accepted
- **Date**: 2026-06-01
- **Phase**: Phase 8 — primitive coverage
- **Related**: ADR-0009 (switch semantics), ADR-0016 (slice storage), ADR-0034 (imported CLR interop), PR #363 (value-type boxing on rvalue receivers)

## Context

G#'s published grammar (`website/docs/ref/spec.md`) defines a `PrimaryExpression` followed by an arbitrary chain of postfix operators — member access (`.`), null-conditional access (`?.`), call, and index (`[]`) — over *any* primary, including a parenthesized expression `'(' Expression ')'` and literals. The binder already supported general expression receivers (`BindAccessorExpression` binds an arbitrary `LeftPart`), and after PR #363 the emitter correctly materializes value-type rvalue receivers via boxing.

The parser, however, only chained postfix operators in the name/call path (`ParseNameOrCallExpression`). Primaries returned by the other `ParsePrimaryExpression` arms — parenthesized expressions, string/char/bool/nil literals, array/map/func/switch literals — skipped chaining entirely. As a result, `(a + b).GetType()`, `"s".Length`, `(nums)[0]`, and `switch v { … }.ToString()` all failed to parse with `GS0005: Unexpected token <DotToken>`, even though the rest of the pipeline could handle them. The implementation lagged the documented grammar.

A naive fix — chaining postfix operators after *every* primary — collides with numeric-literal lexing: `42.GetType()` is ambiguous with the float literal `42.` followed by `GetType`. Disambiguating that in the lexer/parser is disproportionate to its value when `(42).GetType()` already expresses the intent unambiguously.

A second, related gap lived in the language server: completion (`CompletionComputer`) only resolved member completions for simple-name receivers via a token→symbol lookup. It could not infer the type of an arbitrary receiver expression, so `(a + b).`, `foo().`, `arr[0].`, and even chained `a.b.` offered no members.

## Decision

The parser chains postfix member/index/call operators after **every** primary expression **except a bare numeric literal**.

- `ParseNameOrCallExpression`'s trailing postfix loop is extracted into a shared helper `ParsePostfixChain(ExpressionSyntax)` that consumes `.`/`?.` (with a name-or-call right-hand side) and `[ Expression ]`.
- `ParsePrimaryExpression` routes the result of every arm through `ParsePostfixChain`, with one carve-out: the `NumberToken` arm is returned without chaining, because `42.Member` is ambiguous with float-literal lexing. The canonical spelling is the parenthesized form `(42).Member`.

```
PrimaryExpression  = ( Literal
                     | '(' Expression ')'
                     | CompositeLiteral
                     | FunctionLiteral
                     | SwitchExpression
                     | OperandName
                     | … ) PostfixChain? ;

PostfixChain       = { '.' NameOrCall
                     | '?.' NameOrCall
                     | '[' Expression ']' } ;
```

The carve-out is purely syntactic: a numeric literal is never a postfix receiver. Wrapping it in parentheses (`(42).Member`) makes it the `'(' Expression ')'` primary, which chains normally.

For tooling, completion now reconstructs the full receiver expression at the caret (member-access chains parse right-nested, so the trailing dot's accessor covers only the final segment) and speculatively binds it with a throwaway diagnostics bag to infer the receiver type. The inferred type's instance members are offered. This covers `(a + b).`, `foo().`, `arr[0].`, and chained `a.b.` while leaving simple type/enum/static-name receivers on their existing fast paths.

## Consequences

- **Positive**: The implementation matches the published grammar. Parenthesized and literal receivers (`(a + b).GetType()`, `"s".Length`, `(nums)[0]`, `switch … {}.ToString()`) compile, run, and interpret. Completion works for arbitrary receiver expressions, closing a long-standing `a.b.` gap.
- **Negative**: Numeric literals remain a special case (`42.Member` is unsupported); users must write `(42).Member`. This is documented in the spec and the guide.
- **Neutral**: No new `SyntaxKind`, `BoundNodeKind`, or operator is introduced, so the coverage matrix is unchanged. Speculative completion binding must isolate diagnostics so they never leak into the document.

## Alternatives considered

- **Disambiguate `42.Member` in the lexer/parser**: rejected. Resolving the float-literal ambiguity (lookahead to decide whether `.` starts a fraction or a member access) adds lexer/parser complexity that the unambiguous `(42).Member` spelling already avoids.
- **Leave the parser as-is and only document the limitation**: rejected. It permanently diverges the implementation from the published grammar and blocks legitimate parenthesized/literal receivers that the binder and emitter already support.
- **Surface-only completion (no type inference)**: rejected. Without speculative binding the language server cannot offer members for `(a + b).`, `foo().`, or chained `a.b.`, which are exactly the cases users reach for after writing a compound receiver.
