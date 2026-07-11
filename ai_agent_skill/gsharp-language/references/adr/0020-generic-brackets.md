# ADR-0020: Generic type-parameter brackets — Go-style `[T]`

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 4 (lock before 4.1)
- **Related**: ADR-0004 (generics scope); execution plan §0 D11, §4.1; gaps doc §3.2.5

## Context

GSharp ships generics in Phase 4 — both definition and consumption. The first locking decision is the surface syntax for type parameters and type arguments. The choices are:

| Form | Definition | Instantiation | Familiar from |
| --- | --- | --- | --- |
| **A. Square brackets** | `func Map[T, U any](xs []T, f func(T) U) []U` | `Map[int, string](xs, f)` | Go, Scala |
| **B. Angle brackets** | `func Map<T, U>(…)` | `Map<int, string>(xs, f)` | C#, Java, Rust, TypeScript |

GSharp draws its surface syntax from Go (per the design doc) and Go itself chose `[T]` after the original `<T>` Generics proposal hit insurmountable parser ambiguities (`a < b, c > (d)` — comparison or instantiation?). Roslyn solves the same problem for C# with a contextual heuristic that is widely regarded as one of the messier corners of the C# parser. GSharp can avoid that complexity entirely.

Decision D11 in the execution plan locks the surface form to **`[T]`**. This ADR documents the **parse-time disambiguation rule** that makes `[T]` workable alongside slice types `[]T`, fixed-length arrays `[N]T`, indexing `a[i]`, and generic instantiation `Map[int, string](xs, f)`.

## Decision

Adopt **Go-style square brackets** for both type-parameter lists in declarations and type-argument lists at use sites. The four syntactic neighbours that share `[`/`]` are kept apart by **local lookahead** in the parser, not by semantic context.

### Syntactic positions of `[`

1. **Slice type** — `[]T`. After a type position (after `:` in `let x: []int`, after `func` parameter type, etc.), an immediate `]` means slice.
2. **Fixed-length array type** — `[N]T`. After a type position, `[` followed by an integer literal and `]` is an array shape.
3. **Indexing expression** — `a[i]`. In an expression position, `[` after a primary expression introduces a single index expression.
4. **Type-parameter list (declaration)** — `func F[T, U any](…)`, `data struct Pair[A, B](…)`, `class List[T](…)`, `interface Iter[out T] { … }`. **Only** appears immediately after the *name* of a `func`/`class`/`struct`/`data struct`/`interface` declaration.
5. **Type-argument list (instantiation)** — `List[int]`, `Map[string, int](xs, f)`. In an expression or type position, `[` after an *identifier* whose binding could be generic.

Positions (1)–(3) and (4) are unambiguous in the parser by **token of the preceding production**:

- (4) is recognised at the declaration-header level: after the `func`/`class`/`struct`/`data struct`/`interface` keyword + name, `[` is **always** a type-parameter list.
- (1) and (2) only occur in type positions, never after a primary expression.
- (3) only occurs after a primary expression, never in a type position.

The ambiguity that remains is (3) vs (5) in expression position: `Map[T]` — index into a variable `Map` with key `T`, or instantiation of generic function `Map` with type argument `T`?

### The disambiguation rule for instantiation

GSharp uses **bounded lookahead** (no semantic information needed) at the parser. Starting at a `[` in an expression position immediately after a primary expression:

> Tentatively scan tokens treating the contents as a comma-separated list of **type clauses** (see grammar below). If scanning reaches a `]`, and the **token after** `]` is one of:
>
> - `(` — call (`Map[int](xs)`)
> - `{` — composite literal (`List[int]{1, 2, 3}` once it lands)
> - `.` — member access on the constructed type (`Pair[int, string].zero`)
>
> then commit to a **type-argument list**. Otherwise (or if scanning fails to recognise a type clause), backtrack and parse as an **indexing expression**.

This is the same rule Go's parser uses for instantiations and is purely lexical/structural — no symbol table lookup. The follow-set `{(, {, .}` keeps `a[i]` (no follow) and `a[i] + b` parsing as indexing without any cost.

### Type-clause grammar (informal)

```
TypeClause   := SliceType | ArrayType | NullableType | NamedType
NamedType    := IDENT TypeArgs?
TypeArgs     := '[' TypeClause (',' TypeClause)* ']'
SliceType    := '[' ']' TypeClause
ArrayType    := '[' INT_LIT ']' TypeClause
NullableType := NamedType '?' | SliceType '?' | ArrayType '?'
```

`TypeArgs` itself uses `[`/`]`, so a type clause like `Dictionary[string, List[int]]` is parsed by recursion — each `[` opens a fresh type-argument list, each `]` closes the innermost. The lookahead rule above only governs the *outermost* `[` in an expression context.

### Examples that motivate the rule

| Source | Parse |
| --- | --- |
| `xs[0]` | Index |
| `xs[0] + 1` | Index |
| `Map[string, int]` | Index? No — `string` and `int` are not legal expressions for the index slot (a single expression). The lookahead's tentative type-clause scan succeeds and the token after `]` is end-of-statement, so… **diagnostic**: `Map` is generic and must be instantiated with a follow-set marker (`(`, `{`, `.`). The user must write `Map[string, int](xs, f)`. |
| `Map[string, int](xs, f)` | Type-argument list + call |
| `Pair[int, string].zero` | Type-argument list + member access |
| `make(chan T)` | `T` is a single ident in type position — unambiguous |
| `make([]int, 10)` | Slice type in type position — unambiguous |
| `arr[i+1]` | Index — the contents `i+1` are not a type clause; tentative scan fails |

The "diagnostic" row above is the one edge case where users will see a parser error rather than a binder error: a bare reference to a generic name without an instantiation follow-set is **not** a stand-alone expression. This matches Go's behaviour (`Map[int]` in a value position is rejected) and is preferable to ambiguity.

### Why not require a leading marker like `Map.[T]` (F#) or `Map::<T>` (Rust)?

Both forms are unambiguous without lookahead but feel foreign in a Go-flavoured language and bloat call sites for the common case (`xs.filter[int](f)` is noisier than `xs.filter(f)` when the type argument is inferable). With type inference at call sites (Phase 4.1 acceptance criterion), most user code will simply write `Map(xs, f)` and never see the disambiguation rule at all.

### Why not adopt C#-style `<T>` despite ambiguity?

The Roslyn heuristic ("treat `<` after an identifier as a possible type-argument list and try both parses") is well-tested but pulls a meaningful amount of complexity into both parser and IDE. With `[T]` GSharp gets the same expressive power at a fraction of the parser cost, at the price of one stylistic deviation from C#.

## Consequences

- The parser's expression-statement entry point gains a single bounded-lookahead probe for `[` after a primary.
- The lexer is unchanged; `[`, `]`, `,`, `]`, identifiers, and integer literals are the only tokens involved.
- `IsGenericInstantiation` is **not** a binder property — the parse tree distinguishes `BoundIndexExpression` from `BoundGenericInstantiationExpression` (or a `TypeArgumentListSyntax` node that subsequent binding folds into the receiver name).
- LSP and formatter changes are mechanical (treat `[` after an ident in expression position with non-empty type-clause tentative scan as a TypeArgs region).
- The forms `Map[T]` (bare) and `Map[T] + 1` are parser errors with the message "generic name `Map` must be instantiated with `(`, `{`, or `.`". A code-fix can suggest inserting `(...)`.

## Alternatives considered

- **Angle brackets `<T>` (rejected)** — adds Roslyn-style ambiguity heuristic; clashes with Go heritage.
- **Required leading marker `Map.[T]` (rejected)** — verbose; no language in the design space uses this for the common path.
- **Whitespace-sensitive disambiguation (rejected)** — fragile; clashes with formatter freedom.

## Open follow-ups

- ADR-0021: variance modifiers (`in`/`out`) inside the same `[`/`]` brackets — covered separately.
- Type-inference rules for generic function calls: separate design note in Phase 4 implementation, not blocking this ADR.
