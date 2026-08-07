# ADR-0008: Variable bindings — keep Go's `var`/`const`/`:=`, add `let`

- **Status**: Superseded by [ADR-0077](0077-drop-colon-equals-short-variable-declaration.md) (the `:=` short variable-declaration leg only; `var`, `const`, and `let` remain as decided here).
- **Date**: 2026-05-22
- **Phase**: Phase 1 (implementation), Phase 0 (lock)
- **Related**: gaps doc §6.1; execution plan §0 D8, §1.6; design doc D8

> **Note (ADR-0077, issue #717):** the `:=` short variable declaration described below was **removed** from the language. The parser now hard-rejects every occurrence of `:=` with diagnostic `GS0305` and a context-sensitive `let`/`var` (or `for … in …`, `case let v = <-ch`, etc.) migration suggestion. Use `let name = expr` (immutable) or `var name = expr` (mutable) at every binding site. The rest of this ADR is preserved as a historical record of the original decision.

## Context

GSharp inherits Go's binding keywords: `var x = e` (mutable), `const x = e` (compile-time constant), `x := e` (short mutable declaration). Kotlin and Swift prefer a two-keyword split (`val`/`var`, `let`/`var`) to steer users toward immutability without a `const`-style compile-time requirement.

Adding such a keyword without removing existing ones risks four overlapping concepts; replacing existing ones breaks existing samples and Go-developer expectations.

## Decision

**Keep `var`, `const`, `:=`; add `let`** for immutable runtime bindings (Swift/Rust flavor).

- `var x = e` — mutable, runtime-initialized.
- `let x = e` — **immutable**, runtime-initialized. Reassignment is a binder diagnostic.
- `const x = e` — immutable, **compile-time constant** (initializer must be a constant expression).
- `x := e` — short mutable declaration, equivalent to `var x = e`. Statement-only (not allowed at expression position).

Type annotations work on all four: `let x : int = 7`.

A `var` declaration may omit its initializer when an explicit type clause is present (e.g. `var x int32`), in which case the variable takes that type's default (zero) value — `0` for numerics, `false` for `bool`, `""` for `string`, and the all-zero value for structs and enums. This mirrors Go's zero-value rule. `let` and `const` are immutable and therefore still require an initializer, and `var` without a type clause also still requires one (there is nothing to infer the type from).

> **Note (ADR-0159, issue #3310):** for the magic collection types the zero value is now a **sound empty instance**, not a null reference — `var m map[K, V]` binds an empty map, `var s []T` an empty slice, `var a [N]T` a zeroed length-N array, `var q sequence[T]` an empty sequence. `chan T` is carved out: it has no sensible default and a declaration without an initializer reports GS0520. See [ADR-0159](0159-magic-collection-zero-values-and-nil-comparison.md).

> **Note (issue #3324):** this paragraph's `""` for `string` was, until #3324, aspirational for a genuine function-local declaration — the bare-`var` binder fell through to the CLR reference-type default (`null`), NRE-ing on any string-returning use like `len(s)`. Fixed for LOCALS only. This does **not** extend to class/struct fields, auto-property backing fields, a top-level (global) `var`, or the `default(string)` expression: those are a separate, already-settled contract (issue #1714 / PR #2788, pinned by `Issue1714StringZeroValueEmitTests`) that deliberately keeps the CLR storage default (`null`) for uninitialized reference-typed storage, distinct from a local binding's language-level zero value. A top-level `var` binds a `GlobalVariableSymbol` (emitted as a static field) and so falls on the field side of that line, not the local side.

## Consequences

Positive:

- Existing Go-shaped code keeps working unchanged.
- `let` provides a one-keyword nudge toward immutability without losing `const`'s stronger compile-time guarantee.
- The naming `let` (vs Kotlin's `val`) follows Swift/Rust, which matches GSharp's modern-language aesthetic and avoids the `val`/`var` visual collision.

Negative:

- Four binding keywords is more than Go's three or Kotlin's two. Mitigation: style guidance recommends `let` as the default for local bindings; `var` only when mutation is genuinely needed; `const` only for compile-time constants; `:=` for short scripts and tight loops.

Neutral:

- `let` participates in the same scope, shadowing, and type-inference rules as `var`.

## Alternatives considered

- **Rename to Kotlin's `val`/`var`**, drop `:=`: rejected; breaks every existing GSharp sample and is a Go-incompatibility tax for no proportionate gain.
- **Keep Go-style unchanged**: rejected; users want a short immutable-binding keyword and `const`'s compile-time requirement is too strict for most "I don't mean to reassign this" cases.
- **Use `val` instead of `let`**: rejected; user preference (D8) is `let`.
