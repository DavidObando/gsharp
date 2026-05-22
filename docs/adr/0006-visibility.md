# ADR-0006: Visibility — explicit modifiers, `public` default

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 2 (implementation), Phase 0 (lock)
- **Related**: gaps doc §6.2; execution plan §0 D6, §2.8; design doc D6

## Context

Two precedents:

- **Go** encodes visibility in identifier capitalization: `Capitalized` is exported, `lowercase` is package-private. Compact, but clashes with .NET BCL naming conventions (where capitalized identifiers are also the norm for non-public members in some styles, and where the BCL surface is highly capitalized regardless of visibility).
- **C#, Kotlin, Java** use explicit modifiers: `public`, `internal`, `private`, `protected`.

GSharp targets the CLR and consumes the BCL. The CLR has no concept of capitalization-based visibility; emitted IL must carry explicit accessibility flags either way.

## Decision

**Explicit modifiers**:

- `public` — visible everywhere (default for top-level declarations).
- `internal` — visible within the assembly.
- `private` — visible within the declaring type or file.
- Visibility modifiers parse on `func`, `var`, `const`, `let`, `type`, `struct`, `data struct`, `class`, `interface`, `sealed interface`, and on fields/methods within types.
- Go's capitalization-as-visibility rule is dropped entirely; capitalized identifiers carry no special meaning beyond convention.

Emitter maps the modifiers to CLR `TypeAttributes` / `MethodAttributes` / `FieldAttributes`. Default for top-level: `public`. Default for members inside `private` types: same as enclosing.

## Consequences

Positive:

- One-to-one with CLR accessibility; no translation layer.
- Familiar to anyone coming from C#, Java, Kotlin, Swift, Rust.
- Eliminates a known friction point for ex-Go developers consuming the BCL.

Negative:

- More verbose than Go's capitalization rule.
- Style guidance needed to discourage `public` everywhere; recommend `internal` as the default _idiom_ for library code even though the _syntactic_ default is `public` (matches C# muscle memory).

Neutral:

- `protected` is not in the initial set; revisit if/when class inheritance hierarchies grow (Phase 3 / Phase 6).

## Alternatives considered

- **Capitalization-as-visibility** (Go-faithful): rejected; clashes with .NET conventions and CLR accessibility model.
- **Explicit modifiers with `internal` default**: rejected; `public` matches C# default for top-level types and reduces surprise for new users. Style guidance will recommend `internal` for libraries.
- **Hybrid** (capitalization as default, modifiers override): rejected; two visibility systems in one language is a teaching hazard.
