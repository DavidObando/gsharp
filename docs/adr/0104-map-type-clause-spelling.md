# ADR-0104: Map type clause — canonical spelling `map[K,V]`

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: v0.2 — breaking-change sweep
- **Related**: ADR-0020 (Generic type-parameter brackets — Go-style `[T]`), ADR-0040 (`sequence[T]` type alias), ADR-0042 (`async sequence[T]` type clause), ADR-0043 (`async func(...) R` type clause), ADR-0073 (null-conditional indexing), ADR-0074 (arrow-lambda and colon switch arms), ADR-0083 (G# extensions — Go built-ins gate), ADR-0084 (G# extensions — optional sequence APIs)
- **Issue**: [#805](https://github.com/DavidObando/gsharp/issues/805)
- **Supersedes**: the legacy Go-flavored `map[K]V` type-clause shape originally introduced in Phase 3.A.4 (no dedicated ADR — informally documented in ADR-0040 by analogy)

## Context

G# inherited the Go-flavored map type-clause spelling `map[K]V` from its
"mini-Go for the .NET CLR" origins. Over the v0.1 cycle the language has
evolved into a fully-fledged modern programming language and the rest of
the type grammar has converged on a uniform shape: **a contextual
keyword (`sequence`, `func`, `chan`, `map`, …) followed by its
type arguments inside a single bracket / parenthesis pair**, e.g.
`sequence[T]`, `func(P) R`, `chan T`, `Foo[T1, T2]`. The map shape was
the only remaining outlier — its key was bracketed but its value floated
outside the brackets, requiring a bespoke parsing path and a
special-case mental model.

Specifically, the legacy shape causes the following friction:

1. **Grammar inconsistency.** Every other type clause that takes multiple
   type arguments lists them inside a single bracket pair separated by
   commas (`Dictionary[K, V]`, `Foo[T1, T2]`, `func(P1, P2) R`,
   `(K, V)` tuple). `map[K]V` is the lone exception, leaking the closing
   `]` between the key and the value.
2. **Parser composability with prefixed type clauses.** The trailing
   value type that lives *outside* the brackets requires the
   type-clause parser to greedily accept a *second* adjacent
   type-clause whenever it sees `map[K]`. That breaks composability
   with nullable suffixes, receiver-clause boundaries, and the slice
   element-type slot.
3. **Reader-side cognitive load.** Newcomers from any modern language
   (C#, Kotlin, Rust, Swift, TypeScript, F#, Scala, …) read
   `Dictionary[K, V]`, `Map<K, V>`, or `HashMap<K, V>` — *both type
   arguments together inside the type-argument list*. The G# spelling is
   uniquely surprising and gives no offsetting payoff.
4. **Source-of-truth for the type symbol.** `MapTypeSymbol`'s `Name`
   property already wants to read as a single bracketed pair when shown
   in diagnostics; the source-text form should match.

We are landing this change in v0.2 alongside the rest of the
v0.2-window breaking sweep. There is **no deprecation window** for
`map[K]V`: it is rejected outright with a clear migration diagnostic.

## Decision

### 1. Canonical spelling

The one and only G# map type clause is

```text
map[K , V] ?
```

i.e. the `map` contextual keyword, followed by `[`, the **key** type
clause, a `,`, the **value** type clause, `]`, with an optional
trailing `?` nullability marker. Whitespace around the `,` and the
brackets is permissive, identical to other comma-separated type
argument lists.

Example uses:

```gsharp
var m1 = map[string,int32]{"a": 1, "b": 2}
func makeIndex() map[string,Person] { … }
func [K, V] (self map[K,V]) CountKeys() int32 { … }
let cache map[string,async sequence[int32]] = …
let optionalScores map[string,int32]? = nil
```

The literal form is unchanged in shape — only the type-clause spelling
in front of the `{` is updated:

```gsharp
let counts = map[string,int32]{"a": 1, "b": 2}
```

### 2. Hard removal of `map[K]V`

The legacy Go-flavored `map[K]V` shape (key inside the brackets, value
outside) is **rejected** by the parser. There is no deprecation warning
window — the parser produces an error diagnostic and the program does
not compile.

This is a breaking change for v0.2. Existing source must be migrated
mechanically:

```diff
- var m = map[string]int32{"a": 1}
+ var m = map[string,int32]{"a": 1}
```

The migration is purely syntactic; symbol identity, binding, lowering,
and emit are unaffected. `MapTypeSymbol` continues to canonicalize per
`(K, V)` pair, and the runtime backing type remains
`System.Collections.Generic.Dictionary<K, V>`.

### 3. Diagnostic

The parser continues to **recognize** the legacy shape long enough to
emit a span-accurate diagnostic that suggests the migration:

- **Code**: `GS0366`
- **Severity**: Error
- **Message**: `The 'map[K]V' type-clause spelling has been removed; use 'map[{key},{value}]' instead (ADR-0104).`
  - `{key}` is the verbatim source text of the offending key type clause.
  - `{value}` is the verbatim source text of the offending value type clause.
- **Span**: covers the entire shape, from the `map` keyword through the
  end of the value type clause, so editor tooling and IDE quick-fixes
  can replace the whole construct in one edit.

The diagnostic fires once per offending occurrence. Mixed-form files
(some legacy, some canonical) produce one diagnostic per legacy
spelling with **no cascade errors** — the parser still binds the
recovered shape to the correct `MapTypeSymbol` so downstream binding
proceeds as if the canonical form had been written.

### 4. Lexer / parser strategy

The lexer is **unchanged** — `map` remains a contextual keyword,
`OpenSquareBracketToken`, `CommaToken`, and `CloseSquareBracketToken`
all exist already. The change is local to `ParseMapTypeClause`:

```text
map          (MapKeyword)
[            (MapOpenBracketToken)
<type>       (MapKeyType)
,            (MapCommaToken)         ← new, canonical
<type>       (MapValueType)
]            (MapCloseBracketToken)
?            (QuestionToken, optional)
```

Recovery path for the legacy shape (`map[K]V`):

1. After consuming `map`, `[`, and the key type clause, peek the next
   token.
2. If it is `,`, take the canonical path: consume the comma, parse the
   value type, consume the closing `]`, return.
3. Otherwise it must be `]` (the legacy shape): consume the `]`, parse
   the value type, compute the legacy span (`map` … end-of-value), and
   report `GS0366` at that span. Build the `TypeClauseSyntax` with
   `MapCommaToken = null`; downstream code only cares about
   `MapKeyType` and `MapValueType` and is therefore unaffected.

`TypeClauseSyntax` gains a new `MapCommaToken` property; the existing
`MapOpenBracketToken` now denotes the opening `[` of the *whole*
key/value pair and `MapCloseBracketToken` now denotes the closing `]`
of the whole pair (rather than only the key). No new
`BoundNodeKind` is introduced — the bound tree is unaffected.

### 5. Symbol display name

`MapTypeSymbol.Name` now renders as `map[K,V]` (with the comma) so
binder diagnostics and IDE hover info match the new source spelling.

## Surface syntax — coverage matrix

The canonical form `map[K,V]` must work in **every** type-clause slot,
identical to the slots the legacy form occupied:

| Slot                                              | Example                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| `var` / `let` field & local declaration           | `var m map[string,int32] = …`                        |
| Inferred local from map literal                   | `var m = map[string,int32]{"a": 1}`                  |
| Function return type                              | `func makeIndex() map[string,Person] { … }`          |
| Function parameter type                           | `func sum(m map[string,int32]) int32 { … }`          |
| Lambda parameter & return                         | `(m map[string,int32]) -> int32 { … }`               |
| Type argument to a generic instantiation          | `Box[map[string,int32]]`                             |
| Tuple element                                     | `(string, map[string,int32])`                        |
| Slice / array element                             | (matching the existing parser limitation — `[]<keyword>T` slices accept identifier element types only and are out of scope for this ADR) |
| Nullable wrap                                     | `map[string,int32]?`                                 |
| Receiver clause                                   | `func (self map[K,V]) CountKeys() int32 { … }`       |
| Type alias (e.g. inside `sequence[T]` element)    | `sequence[map[string,int32]]`                        |
| Pointer pointee                                   | `*map[string,int32]`                                 |
| `async sequence[T]` element                       | `async sequence[map[string,int32]]`                  |
| Map literal type prefix                           | `map[string,int32]{"a": 1, "b": 2}`                  |

The map literal itself (`{k: v, …}` with `:` between key and value and
`,` between entries) is unchanged.

## Migration cost

A one-time mechanical sweep replaces every legacy occurrence in this
repository (samples, tests, docs, ADRs, website). The migration is
purely textual and trivially scriptable. Downstream consumers can run
the same pattern:

```text
map\[<key-type>\]<value-type>    →    map[<key-type>,<value-type>]
```

## Consequences

- **Pros**
  - Uniformly modern type grammar — all multi-argument type clauses are
    bracketed comma-separated lists.
  - Eliminates the bespoke "type clause whose tail floats outside the
    brackets" parsing path and the composability edge cases that come
    with it (array of map, slice of map, receiver-clause boundary).
  - Reader cognitive load drops for anyone arriving from any modern
    typed language.
  - `MapTypeSymbol.Name` now matches its source spelling, simplifying
    diagnostic and IDE hover text.

- **Cons / mitigations**
  - Hard break for any v0.1 source that uses `map[K]V`. **Mitigated** by
    `GS0366`, which fires once per occurrence with the exact
    canonical-form replacement in the message (IDE quick-fix candidate).
  - One last Go-flavored holdover is gone — readers fluent in Go must
    learn `map[K,V]`. **Mitigated** by the fact that every other modern
    typed language they may be coming from already spells it this way.

## Alternatives considered

### A. Deprecation window — accept both forms with a warning for one release

Rejected. The v0.2 release is already the place where breaking-change
sweeps land; adding a deprecation window would carry a parsing-path
fork into a future release with no offsetting benefit. `GS0366` already
gives users the exact migration target on the offending line.

### B. Pick a different bracket style (`Map[K,V]`, `Map<K,V>`, `map<K,V>`)

Rejected.

- `Map[K,V]` would shadow user-facing identifiers and abandon the
  contextual-keyword precedent set by `sequence[T]`, `chan T`, etc.
- `Map<K,V>` / `map<K,V>` would resurrect the C#/Java angle-bracket
  shape which G# has consciously rejected since ADR-0020 — there is no
  appetite to reintroduce angle brackets as a type-argument delimiter
  for one type and one type only.

### C. Keep `map[K]V` indefinitely

Rejected. The shape was always a heritage item; v0.2 is the moment to
land breaking grammar cleanups. Issue #805 is explicit that this is a
hard removal.

## Implementation notes

- `ParseMapTypeClause` updated as described in *4. Lexer / parser
  strategy* above. The legacy-shape recovery still produces a
  well-formed `TypeClauseSyntax` so the binder and downstream stages
  see the same surface they always did — just with a single error
  diagnostic attached.
- `TypeClauseSyntax` gains `MapCommaToken` (nullable when recovering
  from the legacy shape). The reflection-based
  `SyntaxNode.GetChildren` enumeration picks the new token up without
  changes.
- `MapTypeSymbol.Name` updated to render `map[K,V]`.
- `DiagnosticBag.ReportLegacyMapTypeClauseSyntax` reports `GS0366`.
- No new `BoundNodeKind`. Bound tree exhaustiveness gold files are
  unaffected.
- Every legacy occurrence under `samples/`, `test/`, `docs/`,
  `website/docs/`, and the top-level `README.md` is rewritten to the
  canonical form.
- Documentation updated: spec (Built-in types / Collections), tour,
  bridges (Go-developers guide), tutorials (data and types). New
  diagnostic added to `website/docs/ref/diagnostics.md`.
