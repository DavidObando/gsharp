# ADR-0131: Expression-bodied members via the `->` arrow

- **Status**: Accepted
- **Date**: 2026-06-27
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0128 (arrow-lambda statement/block parity), ADR-0051 (property accessors), ADR-0118 (indexer members), ADR-0019 (receiver-clause functions), ADR-0035 (user operators), issue [#1017](https://github.com/DavidObando/gsharp/issues/1017) (conversion operators), issues [#1278](https://github.com/DavidObando/gsharp/issues/1278), [#1277](https://github.com/DavidObando/gsharp/issues/1277), [#1273](https://github.com/DavidObando/gsharp/issues/1273), [#1270](https://github.com/DavidObando/gsharp/issues/1270)

## Context

C# offers a concise *expression-bodied member* form using the fat arrow `=>`:
a member whose body is a single expression is written `=> expr` instead of a
`{ … }` block. It applies to methods, read-only properties, property
get/set/init accessors, indexers, operators, user-defined conversion operators,
constructors, finalizers, and local functions.

G# already uses the arrow `->` (`RightArrowToken`) for **arrow lambdas**
(`(x int32) -> x + 1`, ADR-0128). The C# fat arrow `=>` is **not** a G# token.
Until now G# had **no** expression-bodied member form at all:

- PR #1270 (issue #1270) briefly taught the parser to recognise and desugar
  `get => e` / `set => e` expression-bodied **accessors**, but that used the C#
  fat arrow and was a language-consistency mistake.
- PR #1277 (issue #1273) reverted it: a property accessor body became a block
  `{ }` or `;` (bare/auto accessor) only, and **any** other token after an
  accessor — notably `=>` or `->` followed by an expression — produced a loud
  `GS0005` ("expected `OpenBraceToken`"). That was the correct end-state *at the
  time*, because there was no member expression-body feature.

Issue #1278 now **introduces** that feature, using the G# arrow `->` (never the
C# fat arrow `=>`). Because a member-declaration `->` appears in a position that
is syntactically distinct from expression position (after a return type, a
property type, or an accessor keyword), it is unambiguously an expression body
and does not collide with arrow lambdas in expression position.

## Decision

### 1. Syntax — the `->` member expression body

A member whose body is a single expression may be written `-> expr` in place of
a `{ … }` block. The arrow is the existing `RightArrowToken` (`->`); the C# fat
arrow `=>` remains a `GS0005` syntax error in every member position.

The form is accepted at these parser sites (all already-existing nodes; **no new
`SyntaxKind`**):

- **Free functions / methods** — `ParseFunctionDeclaration`: after the optional
  return-type clause, `->` introduces an expression body. Because operators
  (`func (a T) operator + (b T) T`) and user-defined conversion operators
  (`func operator implicit (x T) U`) route through the same method-declaration
  path, they get the arrow form for free:
  - `func Square(x int32) int32 -> x * x`
  - `func (a V) operator + (b V) V -> V{x: a.x + b.x}`
  - `func operator implicit (c Celsius) int32 -> c.degrees`
- **Read-only properties** — `ParsePropertyDeclaration`: `prop Name T -> expr`
  is a get-only computed property.
- **Indexers** — `ParseIndexerDeclaration`: `prop this[i T] U -> expr` is a
  get-only computed indexer (ADR-0118).
- **Property accessors** — `ParsePropertyAccessors`: `get -> expr`,
  `set -> expr`, and `init -> expr` inside an accessor list. A setter/init body
  may use the implicit `value` parameter (or a named one via `set(name)`).

### 2. Desugaring — parser-synthesized block bodies

The arrow form is desugared **at parse time** into an equivalent block body so
it reuses every downstream path (binding, type-checking, lowering, async, and
emit) without a single new `BoundNodeKind`:

- A body that **yields a value** — a non-void function/method, a read-only
  property/indexer, or a `get` accessor — becomes `{ return expr }`.
- A **value-less** body — a void function/method (no return type clause), or a
  `set`/`init` accessor — becomes `{ expr }` (an expression statement),
  mirroring C#'s expression-bodied void methods.

`ParseArrowExpressionBody(asReturn)` consumes the `->` and the expression and
synthesizes the brace/`return` tokens at the arrow's source position so
diagnostics and spans stay anchored at the member. A property/indexer arrow is
synthesized into a single get-only `PropertyAccessorSyntax`
(`SynthesizeArrowGetAccessorList`). The discriminator between `return expr` and a
bare expression statement is the **presence of a return type** (functions) or
**getter vs setter** (accessors) — exactly the C# rule.

No new `SyntaxKind` or `BoundNodeKind` is introduced; the coverage matrix and
the `BoundNodeKind` exhaustiveness allowlists are unaffected.

### 3. Member kinds — what is implemented, and what is consciously excluded

The full C# expression-bodied member set, and G#'s decision for each:

| C# member kind | G# `->` form | Status |
| --- | --- | --- |
| Method | `func F(...) T -> expr` | **Implemented** |
| Free function | `func F(...) T -> expr` | **Implemented** |
| Read-only property | `prop P T -> expr` | **Implemented** |
| `get` accessor | `get -> expr` | **Implemented** |
| `set` accessor | `set -> expr` | **Implemented** |
| `init` accessor | `init -> expr` | **Implemented** |
| Indexer | `prop this[i T] U -> expr` | **Implemented** |
| Indexer accessor | `get -> expr` / `set -> expr` | **Implemented** |
| Operator | `func (a T) operator + (b T) T -> expr` | **Implemented** |
| Conversion operator | `func operator implicit (x T) U -> expr` | **Implemented** |
| Constructor | — | **Excluded** (see below) |
| Finalizer | — | **Excluded** (see below) |
| Local function | — | **Excluded** (see below) |

Consciously excluded, with reasons (not silent gaps):

- **Constructors** (`init(...)`, ADR-0065). A constructor returns no value, so a
  C# expression-bodied constructor `Ctor(x) => this.x = x;` is a single void
  statement. G#'s constructor grammar (`init(params) [: base(args)] { … }`)
  always takes a brace block, and a constructor body is frequently more than one
  assignment, so a one-expression arrow buys little. The grammar would need a
  dedicated `init(...) -> expr` production with no expressive gain over
  `init(...) { expr }`. Excluded to keep the constructor grammar single-form;
  `cs2gs` continues to translate C# expression-bodied constructors to the brace
  form.
- **Finalizers / destructors** (`deinit { … }`, ADR-0068). A finalizer is rare,
  always void, and its body is a cleanup block; G# spells it `deinit { … }` with
  no name or parameters. An arrow form adds surface area for a member that is
  discouraged in idiomatic G#. Excluded.
- **Local functions.** A local function inside a body already has the arrow
  *lambda* form available (`let f = (x int32) -> x + 1`, ADR-0128), which is the
  idiomatic G# spelling for a one-expression local callable. A second,
  declaration-style `func f(x int32) int32 -> …` local form would duplicate it.
  Excluded in favour of the existing arrow lambda.

These exclusions are grammar/ergonomics decisions, not desugaring limitations:
each excluded kind already has a natural brace (or lambda) spelling, and adding
an arrow form would create redundant syntax.

### 4. `cs2gs` translation

The translator (`CSharpToGSharpTranslator`) maps C# expression-bodied members to
the idiomatic G# arrow form instead of the block bodies it previously emitted. A
C# `=> expr` member is translated through the existing body seam and then
**folded** to an arrow when the result is a single inline-renderable statement
(`TryFoldArrowBody`):

- A value-returning body (`{ return expr }`) folds to `-> expr`.
- A void body that is a single expression or assignment statement folds to
  `-> expr` / `-> target = value`.
- Bodies that needed extra statements — parameter shadows (a reassigned value
  parameter, ADR-0115 §B), hoisted temporaries, a bare `=> throw e`, or an
  `unsafe { }` wrap — do **not** fold and keep their block body, so the emitted
  G# stays correct.

Read-only properties and indexers fold to the **member-level** arrow
(`prop Name T -> expr`); accessors fold per-accessor (`get -> e` / `set -> e`).
The code-model nodes `MethodDeclaration`, `PropertyDeclaration`, and
`PropertyAccessor` each gain an optional `GStatement ExpressionBody`, and
`GSharpPrinter` renders it as `-> …`. A missing `IndexerDeclarationSyntax`
expression-body case in the body seam was filled in as part of this change so
expression-bodied indexers translate correctly.

## Consequences

- `func Square(x int32) int32 -> x * x`, `prop Name String -> "…"`,
  `get -> field`, `set -> field = value`, expression-bodied indexers, operators,
  and conversion operators all compile and run, desugaring to the block bodies
  they would otherwise spell.
- The issue #1273 / PR #1277 "loud rejection" is narrowed: a `->` after an
  accessor (or after a return/property type) is now a valid expression body; the
  C# fat arrow `=>` is **still** a `GS0005` syntax error in every member
  position, and block `{ }`, `;`, and bare accessors keep working.
- Arrow lambdas in expression position (`(x int32) -> x + 1`,
  `func (x int32) { … }`) are unaffected — the member-declaration arrow lives in
  a distinct syntactic position.
- `cs2gs` emits idiomatic `->` members, replacing the block bodies it previously
  produced for C# `=>` members (the deliverable of issue #1278).
- No new `SyntaxKind`/`BoundNodeKind` was added; the coverage matrix and the
  exhaustiveness allowlists are unaffected.
