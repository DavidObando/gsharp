# ADR-0033: Inline value classes / `inline struct`

## Status

Partially superseded by ADR-0078 — the `inline struct` semantics described below are unchanged; the declaration head is updated to the Kotlin/Swift form (drop the `type` keyword). Combination rules (inline rejects with `class`, `data`, and `open`) are catalogued canonically in ADR-0078 §3 and emitted as diagnostics GS0308 / GS0311.

## Context

Phase 7.4 adds a missing value-wrapper shape that `data struct` does not address: zero-allocation typed wrappers such as `inline struct UserId(value string)`. Kotlin's `value class`, Swift's single-field `struct` pattern, C#'s `readonly struct` newtype pattern, and Scala's value classes all serve this niche. Today GSharp users can write `data struct UserId { value string }`, but that communicates a data-record contract rather than an inline wrapper intent and synthesizes a heavier multi-field-oriented contract.

## Decision

GSharp adds a contextual `inline` modifier on `struct` declarations: `inline struct UserId(value string)`. An inline struct must have exactly one field, typically from the primary constructor, and the body may be omitted when empty. The single field and the struct itself are implicitly readonly. Inline structs synthesize a minimal single-field contract: `Equals(object)`, `Equals(Name)`, `GetHashCode()`, `ToString()`, `op_Equality`, `op_Inequality`, and `Deconstruct(out T field)`. The emitted CLR type is a value type with sequential layout, an init-only public field, and `System.Runtime.CompilerServices.IsReadOnlyAttribute` so C# consumers see the readonly-struct intent. `inline` cannot combine with `data`, `record`, or `open`.

## Rationale

The feature maps directly to the .NET `readonly record struct UserId(string Value)` pattern while keeping the GSharp surface focused on a single-field newtype wrapper. It communicates intent better than a one-field `data struct`, avoids surprising auto-promotion when a `data struct` happens to have one field, and produces a smaller synthesized contract than the general data-struct path: single-field equality, direct hash, and `Name(field=value)` formatting. The ergonomics match Kotlin value classes while preserving distinct nominal types in GSharp.

## Consequences

The one-field constraint is enforced at bind time across primary-constructor parameters and body fields. The field is readonly, so post-construction assignment is diagnosed. C# consumers see a readonly value type with equality operators and an `IEquatable<Name>`-style `Equals(Name)` method, though the compiler does not need a separate surface interface declaration to provide the observable members. The practical no-boxing guarantee comes from emitting a struct rather than a class; runtime tests for absence of boxing are impractical, so metadata shape and `IsReadOnlyAttribute` are the contract. Multi-field inline projection or projected-reference extensions are out of scope and should be introduced by a separate phase if needed.

## Alternatives considered

`value struct` was rejected because it is too close to existing `data struct` naming and would blur the difference between record-like data and newtype wrappers.

Auto-promotion of single-field `data struct` declarations was rejected because silently changing semantics when a second field is added or removed would be surprising.

A new `newtype` keyword was rejected because it adds a top-level keyword for what is fundamentally a struct variant.
