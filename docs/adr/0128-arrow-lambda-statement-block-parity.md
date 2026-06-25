# ADR-0128: Arrow-lambda / func-literal parity — statement-block arrow bodies

- **Status**: Accepted
- **Date**: 2026-06-25
- **Phase**: Phase 9 — language depth / lambda ergonomics
- **Related**: issue [#1172](https://github.com/DavidObando/gsharp/issues/1172) (this ADR), issue #1160 (the cs2gs func-literal workaround this supersedes), [ADR-0074](0074-arrow-lambda-and-colon-switch-arms.md) (arrow lambda & `:` switch arms), [ADR-0075](0075-arrow-function-type-clause.md) (arrow function-type clause), [ADR-0076](0076-lambda-binding-type-inference.md) (lambda binding type inference), [ADR-0119](0119-canonical-arrow-lambda-inference.md) (canonical arrow lambda), [ADR-0064](0064-if-expression-and-block-expression.md) (`if` as expression), [ADR-0050](0050-trailing-arrow-lambda.md) (superseded trailing arrow lambda)

## Context

G# has two ways to write an inline function:

- The **func literal** `func (p T) R { … }` (ADR-0075 type-clause family). Its body
  is a genuine **statement block** — it handles arbitrary control flow (`if`
  without `else`, `for`, early `return`, …) and maps to an explicit `Action[T]` /
  `Func[T]` shape via its declared return type.
- The **arrow lambda** `(p) -> body` (ADR-0074), the **canonical** value-producing
  form (ADR-0119). Parameter and return types are inferred from the target
  delegate (ADR-0076/0119). Its brace-delimited body `(p) -> { … }` was, until this
  ADR, an **expression-block**: only the *trailing* expression (or a `return`)
  supplies the value, and every other item is treated as being in **value
  position**.

This asymmetry is the gap issue #1172 asks us to close. Concretely, a non-`else`
`if` (and other void control-flow) inside an arrow `-> { }` block was rejected:

```gsharp
// FAILED with GS0276 before this ADR:
let f = (x int32) -> { if x > 0 { Console.WriteLine("a") }
                       return x * 2 }
```

### Mechanics of the gap

Two sites conspired:

1. **Parser.** `ParseBlockExpression` parses an arrow `-> { }` body by repeatedly
   calling `ParseBlockExpressionItem`, which asked `LooksLikeIfExpression()`
   whether an `if` should be parsed as a value-producing **if-expression**
   (`IfExpressionSyntax`, ADR-0064) or a void **if-statement**. That helper
   **unconditionally returned `true`**, so *every* `if` inside a block expression —
   including a non-trailing `if`-without-`else` — became an if-expression wrapped
   in an `ExpressionStatementSyntax`.

2. **Binder.** `ExpressionBinder.BindIfExpression` **unconditionally** reports
   **GS0276** (`ReportIfExpressionMissingElse`) when an `IfExpressionSyntax` has no
   `else`, regardless of statement vs. value position. So the parser's "always an
   if-expression" decision turned an innocent void `if` into a hard error.

The arrow-lambda body is bound by `BindLambdaBodyExpression`, which already supports
a **void** block body (a block with no trailing value lowers to a void-returning
lambda) and binds prefix statements via `bindStatement`. The return type is then
inferred by `LambdaBinder.InferLambdaReturnType` from any `return` statements and/or
the trailing value (ADR-0076/0119). All the machinery to make a statement-block
arrow body work already existed — the **only** thing standing in the way was the
parser classifying `if`-without-`else` as a value if-expression and the binder
rejecting it.

### The #1160 workaround

Because of this gap, PR #1160 changed cs2gs to render every **block-bodied** C#
lambda `x => { … }` as the G# **func-literal** form `func (x) R { … }` (computing an
explicit return type), keeping only expression-bodied `x => expr` as the arrow form
`(x) -> expr`. This sidesteps the gap but makes cs2gs **non-idiomatic**: a C# lambda
(written with `=>`) should map to a G# arrow lambda, not a func literal.

### Empirical surface (current `main`)

Rejected with GS0276 before this ADR — all now valid:

- `(x int32) -> { if x > 0 { Console.WriteLine("a") } \n return x*2 }` (non-trailing void `if`)
- `(x int32) -> { if x > 0 { Console.WriteLine("a") } }` (trailing void `if` → void Action)
- `(x int32) -> { if x < 0 { return 0 } \n return x*2 }` (early `return` in a void `if`)
- `(x int32) -> { if x>0 {…} \n let z = x*2 \n z }` (non-trailing void `if`, trailing value)
- `let g Func[int32,int32] = (x int32) -> { if x>0 { return x } \n return 0 }` (explicit target type)

Already valid and must stay valid (backward compat):

- `(x int32) -> x*2` (expression body, canonical)
- `(x int32) -> { let y = x+1 \n y*2 }` (block with trailing value)
- `(x int32) -> { Console.WriteLine("hi") \n x*2 }` (non-trailing void call + trailing value)
- `(x int32) -> { let y = if x>0 {1} else {2} \n y }` (`if`-with-`else` as a value)
- `(x int32) -> { return x*2 }` (explicit `return` only)
- all `func (p) R { … }` literal forms.

## Decision

A block-bodied arrow lambda `(p) -> { … }` is a **statement block with an optional
trailing value expression**. This gives full func-literal parity **plus** the
concise trailing-value form.

1. **`if` classification (parser).** Inside a block expression, an `if` is parsed as
   a value-producing **if-expression** *only* when it has a matching `else`; an `if`
   **without** `else` is parsed as a void **if-statement**. `LooksLikeIfExpression()`
   now performs a bounded, **non-consuming** look-ahead: it scans from the `if`
   keyword to the then-block's opening brace (the first `{` at paren/bracket depth
   zero), then to that block's **matching** close brace (tracking brace depth, which
   correctly skips nested blocks and `else if` chains), and returns `true` iff the
   token immediately after the close brace is `else`. This makes:

   - non-trailing `if`-without-`else` → void if-statement;
   - trailing `if`-without-`else` → void if-statement → block has no trailing value
     → **void** (Action) lambda (the #1160 case);
   - `if`-with-`else` in trailing position → if-expression → the lambda's value;
   - explicit `return` anywhere → unchanged.

   This is **strictly more permissive**: every previously-rejected GS0276 case
   becomes valid void-statement semantics, and no previously-valid program changes
   meaning. The change is scoped to `ParseBlockExpressionItem` (the block-expression
   item parser), so an `if` used directly as a value elsewhere (e.g. `let x = if c
   { 1 }`, a let-init / call argument / return operand) is still a value-position
   if-expression and still requires `else` (GS0276) — only the *block-expression*
   context reclassifies.

2. **Return-type inference (binder).** Unchanged in spirit (ADR-0076/0119): the
   lambda's return type is the common type of the trailing value (when present) and
   all `return` statements; it is **void** when neither yields a value. Because the
   body may now contain un-lowered control-flow statements, the issue #891
   "body never completes normally" probe in `InferLambdaReturnType` **lowers** the
   body (`Lowerer.Lower`) before running `ControlFlowGraph.AllPathsReturn`, exactly
   as the func-literal path in `Binder` already does — the CFG builder expects the
   goto/label form. Async unwrap is unchanged.

3. **No new node kinds.** The change reuses the existing `IfStatementSyntax` /
   `BoundIfStatement`; no new `SyntaxKind` or `BoundNodeKind` is introduced, so the
   coverage matrix and emit-collection invariants are untouched.

4. **cs2gs becomes idiomatic again.** Now that the language supports statement-block
   arrow bodies, cs2gs reverts the #1160 workaround: a block-bodied C# lambda
   `x => { stmts }` renders as the idiomatic arrow form `(x) -> { stmts }` (return
   type inferred — no explicit return-type clause), and expression-bodied `x => expr`
   stays `(x) -> expr`. A C# **local function** is *not* an arrow lambda — it may be
   recursive and needs an explicit return type — so it keeps the func-literal form
   `func (p) R { … }` (a new `LambdaExpression.IsFunctionLiteral` flag in the cs2gs
   code model selects the rendering).

## Consequences

- Block-bodied arrow lambdas reach full parity with func literals: void control
  flow, early `return`, and trailing-value bodies all work, with the return type
  inferred. The previously-rejected GS0276 cases are now valid.
- A value-position block that is **not** a lambda body (a standalone block
  expression or an `if`-expression then/else branch) that ends in a void `if`
  statement now has no trailing value, so it reports the existing "missing trailing
  expression" diagnostic (GS0277) rather than GS0276 — a clearer, more accurate
  message for "this block produces no value."
- cs2gs output is idiomatic: C# lambdas map to G# arrow lambdas, C# local functions
  map to G# func literals. The #1160 translator/printer return-type plumbing for the
  lambda path is removed.
- No new node kinds, no coverage-matrix or refactoring-baseline churn, no change to
  unrelated `BoundBlockExpression` consumers (range / from-end-index / etc.).
- Backward compatible: the look-ahead only *relaxes* a previously-rejected form;
  existing programs and the value-position `if`-expression rules (ADR-0064) are
  unchanged.

## Alternatives considered

- **Keep the #1160 func-literal workaround in cs2gs and close nothing in the
  language.** Rejected: it leaves the arrow lambda permanently weaker than the func
  literal and makes the canonical (ADR-0119) form unusable for any C# block lambda
  with control flow — exactly the gap #1172 names.
- **Bind a non-trailing `if`-without-`else` as a value if-expression but special-case
  it to "void" in lambda position (no parser change).** Rejected: the value/void
  distinction is fundamentally syntactic (does the block item produce the lambda's
  value?), and overloading the if-*expression* node to sometimes mean a void
  statement muddies `BindIfExpression`, the if-expression result-type machinery, and
  every other `BoundBlockExpression` consumer. Classifying at parse time keeps each
  node honest and confines the change to one helper.
- **Require an explicit `return` for every value path in a block arrow body (drop the
  trailing-value form).** Rejected: it would break the existing, widely-used
  trailing-value lambdas (`(x) -> { let y = x+1 \n y*2 }`) and remove a concise,
  canonical form that ADR-0074/0119 deliberately provide.
- **Classify `if` as an expression whenever the block is in value position and as a
  statement otherwise (context flag threaded through the parser).** Rejected: the
  same block can mix value and void items (a non-trailing void `if` followed by a
  trailing value), so a single per-block flag is insufficient; the per-`if`
  "has matching `else`" rule is both simpler and exactly captures "is this `if`
  value-producing?"

## Deferred

None. The change is implemented end-to-end: parser classification, binder
lowering-before-CFG, return-type inference, emit, and the cs2gs idiomatic arrow
output, with binder + emit + translator tests.
