# ADR-0025: `record` keyword alias for `data struct`

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 6
- **Related**: ADR-0029 (data struct synthesized members); execution plan §6.7

## Context

Phase 6.7 asked whether GSharp should add a `record` keyword as an optional spelling for developers familiar with C# records. The existing `data struct` declaration already covers the semantic need: a value aggregate whose equality and synthesized members follow the data-aggregate rules from ADR-0029. The language therefore needs only a familiarity-oriented surface form, not a new kind of type.

## Decision

Accept `record` as pure parse-time syntactic sugar for `data struct`.

```gsharp
type Point record { X int; Y int }
```

is equivalent to:

```gsharp
type Point data struct { X int; Y int }
```

The equivalence is total at parse time: the bound tree, symbols, emit, equality semantics, and synthesized members are identical to the `data struct` form. Generic records use the same type-parameter syntax as generic data structs, for example `type Pair[A any, B any] record { First A; Second B }`.

`record` is a contextual keyword. It is special only in a type-declaration header position where `struct`, `class`, `enum`, or `data struct` would be expected, and only when followed by `{`. Elsewhere it remains an ordinary identifier, so `let record = 42`, a field named `record`, or a parameter type name `record` continue through the normal identifier paths.

Out of scope:

- `record class` is not part of GSharp's data-aggregate story; the language has `data struct` for structural value aggregates.
- Positional-record primary constructor syntax such as `record Point(X int, Y int)` is deferred to Phase 7.3 data-struct ergonomics polish.
- `with` expressions are also deferred to Phase 7.3.
- `open record` and `sealed record` are not allowed, mirroring `data struct` constraints.

## Consequences

Positive:

- C#-familiar users get a recognizable spelling without creating a second semantic model.
- Parser support is small and localized.
- Runtime, binding, symbol, equality, and emit behavior stay unchanged because the parser produces the same data-struct syntax shape.
- The non-aspirational `samples/Records.gs` sample mirrors `samples/DataStruct.gs` and should have identical observable output.

Neutral:

- Diagnostics for data-struct restrictions still apply through the existing data-struct path.
- Tooling may display the parsed declaration as a data struct because no distinct syntax kind is introduced for `record`.

Negative:

- One more contextual keyword increases the surface vocabulary slightly.

## Alternatives considered

Rejecting the alias would avoid keyword proliferation and keep `data struct` as the only canonical spelling, but would forgo a low-cost familiarity bridge for C# developers.

A positional constructor form such as `type Point record(X int, Y int)` was considered, but that changes data-struct ergonomics rather than providing an alias and is deferred to Phase 7.3.
