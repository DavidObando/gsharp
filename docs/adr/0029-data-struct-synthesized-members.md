# ADR-0029: `data struct` synthesized members

- **Status**: Proposed
- **Date**: 2026-05-22
- **Phase**: Phase 3 (lock before 3.B.2)
- **Related**: ADR-0003 (OO surface); ADR-0017 (method virtuality); ADR-0026 (copy syntax, Phase 7); execution plan §3.B.2; gaps doc §3.2.1

## Context

Phase 3.B.2 introduces `data struct` — Kotlin-flavoured data class, but built on the `struct` foundation laid by Phase 3.B.1. ADR-0003 sketches the surface: "compiler synthesizes structural equality, hash, `ToString`, `copy(field = newValue)`, and positional destructuring." This ADR fixes the *exact* member contract so Phase 3.B.2 implementation, conformance tests, and C# interop expectations are unambiguous.

The synthesized contract has knock-on choices:

- **Whose equality is "structural"?** All fields, in declaration order, via the field's own `Equals`.
- **Is `GetHashCode` stable across runs?** Yes — derived from the fields via `HashCode.Combine`.
- **What does `ToString()` look like?** Two precedents: C# records (`Point { X = 3, Y = 4 }`), Kotlin data classes (`Point(X=3, Y=4)`). Pick one; lock it.
- **Do operators `==` / `!=` come for free?** For value types in CLR, the language must emit `op_Equality` / `op_Inequality` explicitly; nothing is synthesized by the runtime.
- **Is `Deconstruct` synthesized?** C# records emit it; Kotlin data classes emit `componentN()`. We pick a representation now even though the *syntax* that consumes deconstruction (Phase 4+) lands later.
- **Sealed or virtual?** Structs cannot be subclassed; the synthesized methods are *necessarily* sealed in CLR terms (`virtual final` because they override `System.ValueType.Equals` etc.). This sidesteps ADR-0017 — the data-struct case has no virtuality question.
- **What about `copy(field = newValue)` and positional destructuring syntax?** Surface form is out of scope for Phase 3.B.2 — slotted for **Phase 7 / ADR-0026**. This ADR commits only to the *underlying member shape* that ADR-0026 will eventually consume.

## Decision

A `data struct Name { F1 T1; F2 T2; … }` declaration emits the same CLR `ValueType` shape as Phase 3.B.1's plain `struct` (sealed sequential-layout TypeDef extending `System.ValueType`, public fields), **plus** the following synthesized members:

1. `public sealed override bool Equals(object other)` — returns `false` if `other` is not an instance of `Name`; otherwise returns `Equals((Name)other)`.
2. `public bool Equals(Name other)` — returns `true` iff every field `Fi` satisfies `EqualityComparer<Ti>.Default.Equals(this.Fi, other.Fi)`. Fields are compared in source declaration order; first inequality short-circuits.
3. `public sealed override int GetHashCode()` — combines field hashes via `System.HashCode.Combine(F1, F2, …)`. For data structs with more than 8 fields (the `HashCode.Combine` overload limit), the binder emits a fold using `HashCode.Add` on a stack-allocated `HashCode` then `ToHashCode()`.
4. `public sealed override string ToString()` — produces `Name(F1=<value>, F2=<value>, …)`. Field values use `Convert.ToString(Fi, CultureInfo.InvariantCulture)` (null becomes empty string). Format chosen for parity with Kotlin and for one-line debuggability.
5. `public static bool op_Equality(Name left, Name right)` and `public static bool op_Inequality(Name left, Name right)` — call `left.Equals(right)` and negation thereof. Required because the CLR does **not** synthesize value-type equality operators automatically.
6. `public void Deconstruct(out T1 F1, out T2 F2, …)` — assigns each field to the corresponding `out`. Emits with the exact field names so C# users can `var (x, y) = point;` (C# uses positional matching but tooling shows the names). Skipped for zero-field data structs.

Additional rules:

- A `data struct` MUST have at least one field. Diagnostic on the empty form: `'data struct' requires at least one field; use 'struct' instead.`
- The user **may not** hand-write any of the six synthesized members on a `data struct`. Diagnostic: `Member 'Name.Equals' is synthesized for 'data struct'; remove the declaration.` This avoids the "did the user intend to override the synthesized one?" ambiguity. (Phase 6+ may relax this if a user-visible `partial` story emerges; the present rule is the conservative one.)
- Field accessibility modifiers (`public` / `internal` / `private` per ADR-0014) are allowed but **the synthesized methods see every field**. A `private` field on a `data struct` is still part of its identity and `ToString`. A user who wants opacity should pick `struct`, not `data struct`. Documented.
- The `data` keyword is **context-sensitive**: it is only a keyword immediately before `struct` in a top-level type-declaration position; everywhere else it is an ordinary identifier (so users may still name a variable `data`).

CLR-level identity:

- TypeDef row is the same shape as a `struct` (`SequentialLayout | Sealed | AnsiClass | BeforeFieldInit`).
- The synthesized methods are emitted **on the struct's TypeDef row** — Phase 3.B.2 extends the emitter to associate `MethodDef` rows with struct TypeDefs. This is *the* deliverable, in emitter terms, that distinguishes 3.B.2 from 3.B.1.
- `[System.Runtime.CompilerServices.IsReadOnlyAttribute]` is **not** synthesized in Phase 3.B.2; data structs are mutable (per the plain-struct semantics) and immutability is a Phase 7 (`record` alias) discussion.

## Consequences

Positive:

- C# consumers get a value type that satisfies `IEquatable<Name>` informally (operator pair + `Equals(Name)` overload), composes with `HashSet<Name>`, `Dictionary<Name, …>`, and pattern matching. Indistinguishable from a hand-written value-record at the call site.
- Phase 3.B.2 is fully testable end-to-end without waiting for Phase 7's `copy` and destructuring *syntax* — the surface measured is the synthesized member contract, which is directly observable via reflection and `Equals`/`ToString` calls.
- The "user may not hand-write synthesized members" rule keeps semantics under the compiler's control and avoids the partial-class rabbit hole.

Negative:

- Hash combination via `HashCode.Combine` requires the System.HashCode type. It is available on every supported target (netcoreapp2.1+ and netstandard2.1+), but if a user targets `netstandard2.0` the emitter must fall back. Defer fallback: Phase 3 targets net10.0 (per `Directory.Build.props`); document the constraint and revisit if Phase 6 multi-targeting demands it.
- Forbidding user-written `Equals`/`GetHashCode`/`ToString` on data structs prevents customizing the format (e.g., suppress a field from `ToString`). Mitigation: users who need a custom format should pick `struct` and write everything themselves; this is a deliberate trade-off in favor of "data structs are predictable."
- The `Deconstruct` method emits even though Phase 3 has no destructuring syntax — costs a `MethodDef` row per data struct. Acceptable: rows are cheap, and shipping it now means Phase 4+ destructuring is purely a parser change.

Neutral:

- ADR-0026 (Phase 7) will add `let p2 = p.copy(x = 10)`. The lowering is `let p2 = data struct.copy(p, x = 10)` or equivalent — the synthesized contract here does **not** include a `copy` method, so ADR-0026 is free to pick either a synthesized instance method, a static helper, or pure syntactic sugar that constructs a new value via the existing composite literal.
- Frozen until ADR-0017 reopens for the question of *which* members are sealed-overridable. Data-struct members are intentionally sealed; that rule sticks.

## Alternatives considered

- **C# records (`Name { F1 = v1, F2 = v2 }` format, `EqualityContract` property, `Equals(Name)` virtual)**: rejected. The C# record runtime contract is intricate (`<>RawContract` virtual property, `protected virtual Equals`) so that inheritance works; data structs don't inherit, so the simpler Kotlin-flavor contract is enough.
- **Allow user-written synthesized members; treat the user's version as authoritative**: rejected. Opens "what does `data struct` actually guarantee?" to a per-type investigation. The teaching value of `data struct` rests on a fixed, learnable contract.
- **Synthesize `IEquatable<Name>` interface implementation explicitly**: deferred. The `Equals(Name)` overload + operator pair already satisfies the C# pattern; emitting the interface adds a TypeRef row and complicates Phase 3 emit for marginal interop benefit. Phase 6's full interface story can revisit.
- **Skip `Deconstruct` until Phase 4+**: rejected. The cost is one `MethodDef` row per data struct; the benefit is that Phase 4 destructuring becomes a parser-only change.
- **`ToString` format `{ F1 = v1, F2 = v2 }` (C# record style)**: rejected. The Kotlin form `Name(F1=v1, F2=v2)` matches `Point(X=3, Y=4)` in the README's "GSharp is Go shape" vibe better than the braces.
