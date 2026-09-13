# ADR-0180: Mixed composite initializers — members, elements, and content spread in one ordered sequence

- **Status**: Proposed
- **Date**: 2026-09-13
- **Phase**: v0.2 — language surface (ADR-0117 follow-on)
- **Related**: ADR-0117 (collection initializers — method-directed `Add` lowering, deferred user-defined `Add` targets), ADR-0148 (safe structural projections and object-spread mapping — leading `...source` structural spread), ADR-0079 (receiver-clause methods restricted to non-owned types — `Add` on owned G# types stays in the type body), ADR-3160/#3160 (native collection spread, lexical order, exactly-once evaluation), issue #962 and ADR-0117 (method-directed collection initializers), issue #1588 (`Member: { elements }` lowering through the member collection's `Add`), issue #547 (object initializer parsing and lowering). **Issue**: [#3785](https://github.com/DavidObando/gsharp/issues/3785)

## Context

G# already has two separate initializer grammars sharing the same
`Type{ ... }` / `Type(args){ ... }` brace position, disambiguated by the
shape of the **first** element (ADR-0117 §2):

- A leading `Identifier ':' Expression` (or an empty `{}`) is a **named/struct
  literal**: an ordered list of `Member: value` field and property
  initializers.
- Anything else — a bare expression, a `[key] = value` indexer entry, a
  `"key": value` pair, or (per ADR-0148) a leading `...source` — is a
  **collection initializer**, whose bare and spread elements lower to
  `self.Add(...)` calls on the constructed receiver (ADR-0117 §3), or, for a
  leading `...source` with no preceding member, a **structural projection**
  (ADR-0148) that copies matching public members from `source` into the
  target's own construction, not an `Add` call.

These two families cannot mix. A type that has both settable members and an
`Add` method — the common shape for a declarative UI node (`Width`,
`Padding`, `FlexDirection` properties, plus an `Add(Node)` method for
children) — cannot express both in one literal. Callers work around this with
a dedicated collection-valued member and a nested initializer:

```gsharp
Container{
  Width: 320.0,
  Padding: 12.0,
  FlexDirection: FlexDirection.Column,
  Children: {
    Text{ Content: "Account" },
    Button{
      OnClick: () -> save(),
      Children: {
        Text{ Content: "Save" },
      },
    },
  },
}
```

`Children` is not a language feature here; it is an ordinary settable
property of collection type, initialized through the ADR-0117 collection
grammar nested one level down. Every declarative tree pays for this wrapper
member and its extra brace nesting, and the wrapper name and shape are
invented per framework rather than provided by the language. This mirrors
the direction the C# LDM has been exploring for the same problem (see the
[2026-07-15 LDM notes on declarative UI construction](https://github.com/dotnet/csharplang/blob/main/meetings/2026/LDM-2026-07-15.md#declarative-ui-construction)
and the [mixed-initializer proposal](https://github.com/dotnet/csharplang/issues/10185)),
and G# is free to ship it first because the grammar and lowering it needs are
already in the language.

A compiler spike against commit `ccaeb8e5` (four files, 105 additions / 11
deletions in `ExpressionBinder.Literals.cs`, `Parser.Expressions.Creation.cs`,
`Parser.Expressions.Literals.cs`, and `StructLiteralExpressionSyntax.cs`)
confirmed the mixed form parses, binds, and runs against a real tree type,
with lexical trace `padding,first,spread,last` and measured runtime parity
against the wrapper form (1,016 B/tree either way; timing medians within
0.4%, inside process noise, over seven runs). The spike is explicitly not
production-ready: it represented members, elements, and spreads as parallel
syntax lists rather than one ordered sequence, which loses relative order
between element kinds except by construction-time bookkeeping.

Two existing ADRs bound the design space and must not be reopened by this
one:

- **ADR-0117 §3** already lowers a bare element to `self.Add(e)` and a
  collection-initializer spread to "iterate once, `Add` each item," through
  the ordinary accessor-call binder — the same path a hand-written `x.Add(e)`
  takes. That lowering generalizes directly; it does not need to change.
- **ADR-0148** already defines a **leading** `...source` in `Type{ ...source
  }` (no preceding member) as a **structural projection** — copy matching
  public members of `source` into `Type`'s own construction — first and at
  most once. Nothing here may make that spelling silently mean something
  else; ADR-0148's own object-spread projection (mapping `source`'s members
  into `Type`) and this ADR's content spread (iterating `source` and calling
  `Type.Add` on each element) are different operations that must stay
  syntactically distinguishable without type information, because the parser
  classifies the initializer before binding runs.

ADR-0117 also left one gap open by policy rather than by grammar: `Add`/
indexer resolution for collection initializers targets only imported CLR
collection types (`ClrType != null`); a user-declared G# type with its own
`Add` reports GS0369 today "and can be lifted later without a grammar
change" (ADR-0117, Deferred). The motivating case for this ADR — `Container`,
`Text`, and `Button` as ordinary G# classes with an owned `Add` method
declared in the type body per ADR-0079 — is exactly that case.

## Decision

### A. One ordered element sequence, not two initializer families plus a first-element sniff

A named-target literal (`Type{ ... }` / `Type(args){ ... }` /
`Type[args]{ ... }` / `Type[args](args){ ... }`) is parsed as **one ordered
sequence** of initializer elements:

```text
CompositeInitializer  ::= ConstructionTarget '{' CompositeElementList? '}'
CompositeElementList  ::= CompositeElement (',' CompositeElement)* ','?
CompositeElement      ::= Identifier ':' Expression      (* member:  Width: 320.0        *)
                        | '...' Expression                (* content spread: ...rows      *)
                        | Expression                       (* content element: Text("x")   *)
                        | '[' Expression ']' '=' Expression (* indexed (ADR-0117, unchanged) *)
                        | Expression ':' Expression         (* keyed (ADR-0117, unchanged)   *)
```

The parser and bound tree represent this as a single node
(`CompositeInitializerExpressionSyntax`, replacing the spike's parallel
lists) holding one `SeparatedSyntaxList<InitializerElementSyntax>`, so
parents, separators, spans, and traversal order are all defined by one list
rather than reconstructed from two. `MemberInitializerElementSyntax`,
`ContentElementSyntax`, and `ContentSpreadElementSyntax` are the three
element node kinds; `IndexedElementSyntax` and `KeyedElementSyntax` from
ADR-0117 are unchanged and continue to apply only inside the collection-
initializer classification in §C below.

### B. Classification stays first-element-driven; only the member family gains new element kinds

The ADR-0117 §2 classification rule is preserved, and only extended for the
new element kinds that can now legally follow a member:

- **Empty `{}`** classifies as an empty member initializer (unchanged).
- **First element is `Identifier ':' Expression`** classifies the literal as
  a **composite (member) initializer**. Unlike today, subsequent elements may
  freely mix further `Member: value` entries, bare content elements, and
  non-leading `...source` content spreads, in any order, provided the target
  type has an applicable instance `Add` for the content elements/spreads
  present (§D). A composite initializer with no content elements or spreads
  is exactly today's struct/object literal; this ADR adds capability, it does
  not change existing programs.
- **First element is `[key] = value` or a non-identifier-keyed `expr: expr`**
  classifies as an ADR-0117 **collection initializer**, unchanged. Composite
  member syntax (`Identifier: value`) remains reserved to the member family
  (ADR-0117 §2) and is not accepted here; a `Dictionary[K,V]{...}` gains
  nothing from this ADR beyond what ADR-0117 already gives it.
- **First element is a bare expression** (not `Identifier ':'`) classifies as
  an ADR-0117 collection initializer, unchanged.
- **First element is a leading `...source` with no explicit call parentheses**
  — `Type{ ...source, ... }` or `Type[args]{ ...source, ... }` — classifies
  as **ADR-0148 structural projection**, unchanged. It remains first-and-at-
  most-once, and explicit member initializers after it continue to mean what
  ADR-0148 §B already says (override a projected member), never an `Add`
  call.
- **First element is a leading `...source` with explicit call parentheses** —
  `Type(){ ...source, ... }` or `Type[args](){ ...source, ... }` — classifies
  as a **composite initializer whose first content element is a spread**,
  following exactly the precedent ADR-0117 §1 already set for a leading
  collection-initializer spread (`List[T](){ ...source }`, chosen there for
  the same reason: an explicit, empty, syntactic construction marker
  disambiguates "spread as content" from "spread as structural projection"
  without consulting the target type's shape). This is the disambiguation
  issue #3785 asked the ADR to settle: **the marker is the explicit `()`
  actually present in source, not an inferred one**, so classification stays
  purely syntactic and never depends on whether `Type` happens to also be
  structurally projectable from `source`.

This means a caller who wants a member initializer to *start* with children
writes the explicit-parentheses form:

```gsharp
Container(){
  ...headerRows,
  Width: 320.0,
  FlexDirection: FlexDirection.Column,
}
```

while `Container{ ...headerRows, Width: 320.0 }` (no parens) keeps meaning
"structurally project `headerRows`'s matching members into `Container`, then
override `Width`" — ADR-0148, unaffected.

### C. Lexical-order execution against one synthesized receiver

A composite initializer with any content element or content spread lowers
like ADR-0117 §3's collection initializer, generalized to member elements:

1. Evaluate `ConstructionTarget` once into a fresh synthetic local
   (`$compinit«n»`), exactly as today's member and collection initializers
   already do.
2. Execute every element **in source (lexical) order** against that local:
   - `Member: value` → ordinary field/property assignment (today's behavior);
   - a bare content element `e` → `$compinit«n».Add(e)`;
   - a content spread `...source` → evaluate `source` once, iterate it once,
     and call `$compinit«n».Add(item)` for each yielded item, in place at its
     lexical position;
   - `[k] = v` / `k: v` (only reachable inside an ADR-0117 collection
     initializer, §B) — unchanged from ADR-0117 §3.
3. Yield `$compinit«n»` as the expression's value.

Interleaving is observable and intentional: `FlexDirection: FlexDirection.Column`
executes before any `Add` call that follows it lexically, and a member that
appears after a bare element or spread executes after that element's `Add`
call. This matches the issue's stated requirement and its "interleaved
member and element effects" test case, and it is why a single ordered
element list (§A) is load-bearing rather than cosmetic: two parallel lists
(members, then elements) cannot express this order without reconstructing it
from separate position bookkeeping, which is exactly what the prototype spike
did and why it is called out as not production-ready.

`source` in a content spread is evaluated exactly once and iterated exactly
once, matching the single-evaluation contract ADR-0117 §1/§3 and ADR-0148 §E
already hold collection and structural spreads to.

### D. Bare elements and content spreads bind through ordinary instance `Add` lookup — including user-declared G# types

ADR-0117's deferred restriction to `ClrType != null` receivers is lifted for
both the (now-generalized) collection-initializer bare/spread elements and
the new composite-initializer content elements/spreads. Resolution of `Add`
for a content element or content spread:

- runs through the same accessor-call binder ADR-0117 §3 already uses for a
  hand-written `x.Add(e)` — ordinary overload resolution, generic-argument
  inference, `params` expansion, and user-defined conversions apply
  identically, whether `Add` is declared on an imported CLR type or on a
  user-declared G# class/struct;
- for a user-declared receiver, only finds `Add` members declared in the
  type's own body, per ADR-0079 (an extension-style `Add` in a receiver
  clause is not eligible, exactly as ADR-0079 already restricts receiver-
  clause methods on owned types to a warning-gated, non-canonical form);
- reports **GS0369** ("Type 'X' cannot be initialized with a collection
  initializer because it has no accessible 'Add' method or settable
  indexer") — the diagnostic ADR-0117 §4 already defines — when no
  applicable `Add` exists for a content element or spread. No new
  diagnostic ID is introduced; a composite initializer with only `Member:
  value` elements never triggers this check, since it never requires `Add`.

No reflection, no generated builder API, no magic member name, and no
runtime library support participate. The compiler emits the same `Add` call
shape it already emits for `List[T]{1, 2, 3}`; a `Container` with a
hand-written `Add(Node)` method needs no attribute, interface, or base class
to participate.

### E. No new bound-node kind; interpreter and emitted IL stay identical

Lowering reuses `BoundBlockExpression`, `BoundVariableDeclaration`, ordinary
field/property assignment nodes, the native for-range/`Add`-call shape
ADR-0117 §3 already lowers a spread to, and the same accessor-call binder for
`Add` resolution. No new bound-node kind, opcode, or interpreter code path is
required; the interpreter's existing synthetic-block statement evaluator
runs the ordered element list exactly as it runs any other statement
sequence. The prototype spike's measured runtime parity (1,016 B/tree either
way, timing medians within 0.4%) is consistent with this: the mixed form and
the `Children`-wrapper form compile to the same shape of code, just without
the wrapper member and its extra nesting.

## Consequences

Positive:

- Declarative trees (UI, configuration, serialization builders) drop the
  invented `Children`-style wrapper member and its extra brace level, using
  only ordinary typed construction, member initializers, and `Add`.
- The feature is additive to ADR-0117: every existing struct/object literal
  and every existing collection initializer keeps its current grammar,
  classification, and lowering unchanged.
- ADR-0148 structural projection keeps its exact current meaning and its
  exact current spelling; the new content-spread meaning is reachable only
  through an explicit, syntactic `()` marker, never by type-directed
  inference.
- User-declared G# types are no longer second-class participants in `Add`-
  based initializers; ADR-0117's deferred CLR-only restriction is lifted
  through the same binder path that already handles CLR receivers, so no new
  resolution machinery is introduced.
- One ordered `CompositeInitializerExpressionSyntax` element list replaces
  two independently-shaped literal grammars in the parser and bound tree,
  which is a simplification for every consumer that walks these nodes
  (binder, emitter, interpreter, `gsfmt`, completion, hover), not just a
  convenience for this feature.

Negative:

- The parser, binder, emitter, interpreter, `gsfmt`, completion, and hover
  all gain a new element-list shape to handle for named-target literals;
  this is a wider blast radius than a typical grammar addition because it
  touches the representation of every existing struct/object literal, not
  only the new mixed form.
- `StructLiteralExpressionSyntax` and its consumers (including cs2gs, if it
  ever emits G# struct literals) must move from whatever parallel-list shape
  they hold today to the single ordered list; this is a mechanical but
  non-trivial migration, and the prototype spike explicitly did not attempt
  it.
- Lexical-order interleaving of member assignment and `Add` calls is a new,
  user-observable execution-order contract for the member-initializer family
  specifically because of this ADR; a member initializer with no content
  elements is unaffected (property/field assignment was already sequential
  in source order), but authors of types with both settable members and an
  `Add` method must now document or rely on that order if `Add` reads
  previously-set state (as the `FlexDirection`-before-`Add` example does).
- The explicit-parentheses disambiguation rule (§B) means `Container{
  ...source }` and `Container(){ ...source }` mean different things despite
  looking similar; this is a deliberate, precedented choice (it mirrors
  ADR-0117 §1's existing `List[T]{...}` vs. `List[T](){ ...source }` split)
  but is a rule authors must learn.

Follow-up work:

- Statement-style control-flow elements (`if`/`for` producing zero or more
  children) are an explicit non-goal here and are left to a separate
  control-flow-lowering proposal, per the issue's stated non-goals.
- Whether the explicit-parentheses requirement for a leading content spread
  can later be relaxed (e.g., once usage data shows the marker is mostly
  boilerplate) is an open question for a future ADR; nothing in this design
  forecloses revisiting it, since relaxing a syntactic requirement is not a
  breaking grammar change for programs that already supply it.
- `StructLiteralExpressionSyntax`'s migration to the single ordered element
  list, and the corresponding `gsfmt`/completion/hover updates, are
  implementation work tracked against this ADR's definition of done, not
  design decisions; they do not require ADR-level sign-off individually.

## Alternatives considered

**Keep the `Children`-wrapper convention as the idiomatic pattern; do
nothing.** Rejected. This is the status quo the issue was filed against — it
is expressible today, and the entire cost of this ADR is removing a
convention every declarative-tree author currently has to invent and repeat.

**A magic member name (e.g., `Children`) that the compiler recognizes and
routes to `Add`.** Rejected, and listed as a non-goal in the issue. It
reintroduces exactly the framework-specific, name-based special-casing the
`Children`-wrapper convention already has today, just moved into the
compiler instead of into each framework; it also does not generalize past
one collection-valued member per type.

**Reflection or a generated builder API (e.g., a source-generated tree
builder attribute).** Rejected, and listed as a non-goal in the issue. It
adds a runtime or generator dependency for a feature ADR-0117 already proves
is expressible as ordinary compile-time `Add`-call lowering with zero runtime
cost.

**Implicit string-to-node conversion for bare string content elements.**
Rejected, and listed as a non-goal in the issue. It is a separate, framework-
shaped conversion decision (what does a bare `"text"` element construct?)
orthogonal to sequencing members, elements, and spreads, and it would need
its own target-typing and diagnostic story.

**Type-directed disambiguation of a leading `...source`** (infer content
spread vs. structural projection from whether `Type` has an applicable `Add`,
an applicable projection plan, or both). Rejected. Issue #3785 explicitly
warns that a leading spread "must not silently become content spread"; make
the meaning depend on the target type's shape and the same `Type{
...source }` text means different things for different `Type`s, which is
exactly the silent reinterpretation the issue rules out. The explicit-
parentheses marker (§B) is purely syntactic — the parser decides before the
binder ever inspects `Type` — and it reuses a distinction ADR-0117 already
established for the pure-collection case, rather than inventing a new one.

**A new spread-like token for content spread, distinct from `...`.**
Rejected. `...` is already G#'s one spread spelling across structural
projection (ADR-0148), collection-initializer spread (ADR-0117), and native
collection spread (#3160); a second token would only exist to route around
the ambiguity §B already resolves syntactically, at the cost of a second
concept for authors to learn.

**Two independent, unmerged grammars — leave struct literals and collection
initializers as separate node shapes, and add a third node shape for the
mixed case.** Rejected. This is closest to what the prototype spike did
(parallel syntax lists) and is explicitly why the spike is not production-
ready: three shapes cannot express one arbitrary-order sequence without
external bookkeeping, and every consumer of initializer syntax (binder,
emitter, `gsfmt`, completion, hover) would need to special-case the mixed
shape rather than walking one list.

**Leave user-defined (non-CLR) `Add` targets deferred, and require framework
authors to expose a CLR collection member instead.** Rejected. The
motivating scenario is a user-declared G# type with its own `Add` method
(ADR-0079); forcing such a type to wrap a `List[Node]` field purely to
satisfy a `ClrType != null` compiler restriction is exactly the kind of
workaround this ADR exists to remove, and ADR-0117 §3 already binds `Add`
through the ordinary accessor-call binder, which does not distinguish CLR
from user-declared receivers once a member lookup succeeds.
