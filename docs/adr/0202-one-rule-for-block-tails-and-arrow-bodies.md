# ADR-0202: One rule for block tails and arrow bodies

- **Status**: Accepted
- **Date**: 2026-10-17
- **Phase**: Language alignment — statement/expression parity
- **Amends**: [ADR-0064](0064-if-expression-and-block-expression.md) (the
  GS0277 rule and the `throw` addendum), [ADR-0128](0128-arrow-lambda-statement-block-parity.md)
  (scope widened to arrow members), [ADR-0131](0131-expression-bodied-members.md)
  (`-> { … }` bodies and void arrow bodies), [ADR-0151](0151-if-let-expressions.md)
  (a trailing `if let … else …` in a lambda body), [ADR-0009](0009-switch-semantics.md)
  (comma arms in both switch forms)
- **Related**: [ADR-0121](0121-throw-expressions.md) (the `never` type),
  [ADR-0069](0069-smart-cast-flow-narrowing.md) (unconditional-exit analysis);
  issues [#4963](https://github.com/DavidObando/gsharp/issues/4963),
  [#4965](https://github.com/DavidObando/gsharp/issues/4965),
  [#4966](https://github.com/DavidObando/gsharp/issues/4966), #2152, #3355, #3501

## Context

An audit of constructs that exist as both a statement and an expression found
that the *last item* of a value-capable block meant different things depending
on which kind of block it was in, and that void positions applied value rules:

- A `switch` expression could not be the trailing value of a block, although
  ADR-0064's addendum says it can (#4963 §2). A `switch` that began a block item
  always went to the statement parser, which rejects `case 1:`.
- Comma multi-pattern arms (`case 1, 2`) worked only in the statement form
  (#4963 §1).
- A value block could not end in `throw`, `return`, `break` or `continue`
  (GS0277), although `?:` and switch-expression arms accept throw expressions and
  the jumps are legal anywhere else in a block (#4965 §1, §2).
- A final nested `{ a + 1 }` was the value of a block expression but a statement
  in an arrow-lambda body (#4965 §3).
- `func f() T -> { … }` was a value-position block expression wrapped in
  `return`, so its `return` statements and void endings were rejected (GS0277),
  while the identical lambda body follows ADR-0128 (#4966 §1).
- A void arrow body rejected `if` without `else` (GS0276) and a switch with void
  arms (GS0124), although the equivalent block body accepts both (#4966 §2).

The shared root is `Parser.ParseBlockExpressionItem` and its `valueRequired`
flag, which decided what a block's last item means differently for if-branches,
general block expressions and lambda bodies, plus `ParseArrowExpressionBody`,
which parsed `-> {` as an expression. On the binder side, the GS0277 check in
`BindBlockExpressionValueCore` ignored reachability, and `BindIfExpression` /
`BindSwitchExpression` had no void path for a position whose value is discarded.

## Decision

### 1. One block-item rule (parser)

Every value-capable block — a general block expression, an if-/if-let-expression
branch, an arrow-lambda block body and an arrow-member block body — is parsed by
the same routine with the same rule. `valueRequired` is removed. The last item of
the block is its trailing value when it has an expression shape:

- an expression statement;
- an `if … else …` chain that ends in a plain `else` (ADR-0128, unchanged), and
  likewise an `if let … else …` chain (previously a statement in a lambda body);
- a final nested `{ … }` (previously a statement in a lambda body);
- a `switch` whose arms have the expression shape (see 2).

Anything else is a statement, as before.

A nested brace or trailing if/if-let chain is classified at its actual matching
closing braces, without a lookahead-token limit. Its length cannot change the
lambda's inferred type or whether a postfix/binary continuation belongs to a
nested brace expression. The if classifier parses the complete header grammar
speculatively with brace bodies skimmed, so an initializer's own if-expression
braces cannot be mistaken for the outer branch. Tokens, position and diagnostics
are restored after classification.

Promoting a trailing `if let` does not restrict its initializer to binary
expressions: it uses the regular assignment/coalescing/conditional grammar.
The expression form still reserves a top-level `&&` for its optional guard
(ADR-0151), with nested expression contexts resetting that delimiter.

### 2. `switch` is decided by its arm shape

At the start of any statement (every block, not only value blocks), `switch` is the
switch **expression**, as an expression statement, when its first arm is
`case P:` / `default:` (or the deprecated `->` separator), and the switch
**statement** when it is `case P { … }` / `default { … }` or the body is empty.
The parser parses the header once and then decides with a linear,
non-consuming token scan of the first arm (`SwitchBodyHasExpressionArms`):
parenthesized, bracketed and braced groups are skipped whole, a braced group
followed by the next arm or the end of the body was the statement arm's body,
and any other braced group belongs to a property pattern or the guard. Two
tokens are ambiguous without the grammar: `->` (the deprecated separator, or
the arrow of a function-type pattern such as `case f is (int32) -> string
{ … }`) and `?` (a nullable type such as `int32?`, or a `? :` conditional whose
`:` is not the separator). Only when the first arm contains one of them is that
one arm's pattern and guard parsed to decide, with brace bodies inside it
skimmed to their matching brace rather than parsed. No header is parsed twice
and no switch nested in a guard is parsed twice, so nesting stays linear. Like an `if` item, the
switch item ends at its closing brace.

A colon-arm switch at statement start was a parse error before, so no valid
program changes meaning. ADR-0009 and ADR-0069 already showed this form.

### 3. Comma arms in both forms

`case 1, 2` folds each comma into the `or` disjunction node in both the statement
and the expression form, through one helper (`ParseSwitchArmPattern`).

### 4. Arrow-member block bodies are block bodies

`-> { … }` on a function, operator, property, indexer or accessor is the same
block body an arrow lambda has (ADR-0128): a statement block with an optional
trailing value. It desugars to the equivalent block body — `{ stmts; return tail }`
for a value-returning member, `{ stmts; tail }` for a void one, and the block as
written when it has no tail — and is then checked exactly as
`func f() T { … }`. A brace followed by a continuation (`-> { … }.ToString()`,
`-> { … } + 1`) is still one expression. `-> expr` is unchanged.

### 5. A value block may end in a non-returning statement: it has type `never`

A block with no trailing value is accepted in value position when its end is
unreachable. Its type is then the bottom type `never` (ADR-0121), which unifies
with the sibling branch, arm, or target type exactly as a throw expression does
(C# and Swift treat a throwing branch the same way). The end is unreachable when
the block's last statement is:

- `return`, `throw` or `rethrow`;
- a direct `break`, `continue` or `goto` (it leaves the block, which ends right
  after it), also in the tail of a nested block, an if/else, or a try — which is
  how a `defer` or `using let` prefix wraps the rest of the block, so
  `{ defer log() continue }` exits too;
- a structured statement every branch of which ends in `return` / `throw`
  (`StatementBinder.EndsInUnconditionalExit` with gotos not counted inside a
  switch statement: a `break` in a switch-statement arm targets the switch's own
  exit and falls through to the end of the block). A switch counts only when it
  has an unguarded default or discard arm; `case _ when …` can fail. A tail
  `if … else …` is an if-expression and is typed by its own branches, so
  `if c { continue } else { break }` is `never` too.

The never-produced value is represented by an unreachable `throw nil` trap after
the exiting statement, so no new bound node is needed and every later pass
already handles it. A `never` value is never stored. When lowering spills an
operand list around one (`f(if c { return 1 } else { return 2 }, await g())`),
the `never` operand runs as a statement and is replaced by the `throw nil` trap
(`SpillSequenceSpiller.StoreOperand`). Nothing after it runs, and even a state
machine's resume edge into the rest of the sequence reaches only a `throw`. A `never` value keeps no result storage, also behind a
`defer` / `using let` prefix. Statements whose value is `never` are terminators
in the control-flow graph (all-paths-return analysis). Lambda return-type
inference collects `return`s inside the trailing value — and inside another
`return`'s operand (`return if c { return a } else { b }`), converting each to
the inferred type — and ignores a `never` tail; a block-bodied lambda whose every path exits — through its tail or its
returns (`() -> { { throw e } }`, `() -> { return { throw e } }`) — is void
when no delegate target supplies a return type, exactly like
`() -> { throw e }`. An expression-bodied `() -> throw e` keeps its
`() -> never` type, which adapts to any delegate signature (#2716).

A local with no type clause whose initializer's type is or contains `never`
(`let a = throw e`, `let a = if c { return 1 } else { return 2 }`,
`let t = (throw e, 0)`) reports `GS0124` ("Expression must have a value"). Before this ADR the throw-expression
form crashed the compiler (GS9998).

### 6. A void arrow body is checked exactly like the equivalent void block body

In a position whose value is discarded — an expression statement, a void arrow
body (which desugars to the expression statement `{ e }`, ADR-0131), or a lambda
body whose value may be void — there is no value to produce, so:

- a block with no trailing value is a void block;
- an `if` without `else` is the void `if`;
- an `if`, `if let` or `switch` expression any branch of which is void is the
  void construct, and the other branches' values are discarded (one helper,
  `IsVoidInDiscardedPosition`). This also fixes `() -> { if c { list.Remove(x) }
  else { list.Clear() } }` as an `Action`, which reported GS0263 although the
  identical if statement compiles;
- a void switch, like the switch statement, needs no `default`: an unmatched
  value runs no result. Definite assignment and narrowing propagate dispatch
  through pattern-failure and guard-failure paths, preserving side effects of
  evaluated guards. The unmatched state joins result states only when there
  is no unguarded irrefutable arm. Shared pattern coverage composes discard
  coverage through `and`, `or` (including comma arms) and `not`; unknown atoms
  stay unknown. A guard remains a separate condition even for an irrefutable
  pattern: it always runs but can skip its result. As in emission, `default` is considered
  after all other patterns, regardless of its textual position. Callable-state
  collection joins alternative paths rather than visiting them in sequence.
  This preserves skipped-operand states for short-circuit expressions and
  patterns, including conditional access and property/list subpatterns, while
  a conditional that replaces a callable on both paths still kills its old target;
- a bare `default` branch — also as a block's tail, a nested switch-arm result,
  or a tail behind `defer` / `using let` cleanup — has no target type to take,
  so it reports `GS0362` as any targetless `default` does. Validation happens
  before cleanup replaces the value with a result-local read; a contextual
  result type still reaches the tail before that validation.

Branches that all produce values keep their common type, so a lambda whose body
ends in such an `if … else …` still returns it (ADR-0128).

### Differences that remain, and why

These follow purely from value position:

- `GS0276`: an `if` without `else` whose value is used.
- `GS0277`: a block with no trailing value, a reachable end, and a used value.
- `GS0176`: a switch expression that is not the void switch — its value is used,
  or every arm produces a value — needs a `default` arm (or an exhaustive
  discriminant).
- `GS0124`: a void or `never` initializer for an untyped local.

## Compatibility

Measured by parsing 46,884 files with the old and the new parser and comparing a
hash of each syntax tree: all 4,375 `.gs` files in the repository, plus 42,509
G# programs extracted from test string literals and from `gsharp` code blocks in
the docs.

- **27 trees changed.** 12 are repository files holding the 14 value-returning
  `-> { … }` members (`prop P T -> { let v = … v }` and similar). They now
  desugar to the equivalent block body; every one ends in a value tail, so the
  bound meaning is unchanged, and all have 0 diagnostics before and after. The
  other 15 are extracted snippets that already had parse errors (C# fixtures
  in cs2gs tests, or doc fragments). Three of those docs examples (ADR-0009,
  ADR-0069 and the v0.2 design notes) show syntax this ADR implements, and now
  parse.
- Lambda bodies ending in a nested block: **0**. Lambda bodies ending in
  `if let … else …`: **0**. Void members with a `-> { … }` body: **0**.
- Colon-arm switches at statement start, comma arms in switch expressions, value
  blocks ending in an exit, and void arrow bodies with `if` without `else` were
  all rejected before, so no existing program can change meaning through them.

The one rule that can change an existing program is §1 for a lambda body whose
last item is a nested `{ … }` or an `if let … else …` whose branches produce
non-void values. Such a lambda used to be void and now returns that value. This
matters only where the lambda's type is *inferred* (overload resolution between
`Action` and `Func` overloads, or `let f = () -> { … }`); a lambda converted to a
void delegate discards the value as before (#889). This is the same rule that
already applies to a lambda ending in a non-void call or in `if … else …`
(ADR-0128; #2152 made an assignment tail an exception). A nested block or
`if let` whose tail is void, or whose branches mix void and non-void (see §6),
leaves the lambda void. **Migration:** to keep such a lambda void, end it with a
bare `return`.

cs2gs emits C# block lambdas as G# arrow lambdas with inferred return types and
can produce these tails: a C# `using (…) { … }` becomes a nested block, and
`if (x is {} y) … else …` becomes an `if let` statement or a nested
`{ let y = …; if … else … }`. That exposure is the same class as the existing
direct-tail one (`x => { Compute(); }` already translates to a value lambda); it
is tracked in [#4977](https://github.com/DavidObando/gsharp/issues/4977).

## Alternatives considered

- **Parse a final `throw` as the throw expression.** Fixes only `throw`; `return`,
  `break` and `continue` tails would stay rejected. Typing an unreachable end as
  `never` covers all four with one rule.
- **Keep a final nested block a statement in lambda bodies.** Keeps the #4965 §3
  divergence, and the arrow-member body (§4) would then differ either from
  value blocks or from lambdas. The measured exposure is zero in the repository,
  and the void/mixed-arm rule in §6 keeps void tails void.
- **Make void arrow bodies parse `if` / `switch` as statements.** Works for
  members, whose voidness is known at parse time, but not for lambdas, whose
  return type is inferred. The binder rule in §6 covers both with one decision.
- **Bind the void switch as a switch statement.** Would duplicate the statement
  binder's arm and narrowing handling. Instead the switch expression carries
  `void`; the emitter and spiller allocate no result slot for a void or `never`
  switch.
- **Promote colon-arm switches only inside value blocks.** Would make
  `func f() -> { switch … case 1: … }` legal and the identical
  `func f() { … }` body illegal.
