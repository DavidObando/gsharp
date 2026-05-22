# ADR-0014: Visibility defaults — `public` for top-level declarations

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 2 (statement form)
- **Related**: ADR-0006 (visibility model — explicit modifiers); execution plan §2.8, §2.9

## Context

ADR-0006 already locked GSharp's visibility model: **explicit `public` / `internal` / `private` modifiers**, dropping Go's capitalization-based scheme. ADR-0014 closes the one open sub-decision: what the default is when no modifier is written.

Three precedents for top-level declarations:

| Language | Default | Notes |
| --- | --- | --- |
| Go | exported when capitalized, package-private otherwise | Modifier is the identifier itself. |
| C# | `internal` for top-level types / `private` for members | Defensive; opt in to a wider audience. |
| Kotlin | `public` everywhere unless specified otherwise | Optimistic; opt out to narrow. |
| Java | package-private | Implicit middle level. |

GSharp targets the .NET ecosystem and is primarily consumed via C# / F# / VB code. For a teaching language whose initial story is "publish a library and call it from C# without ceremony," the **Kotlin-style optimistic public** default minimizes friction for the dominant interop path. Users who want to narrow accessibility opt in to `internal` or `private` explicitly.

## Decision

- **Default for top-level declarations is `public`.** Applies to `func`, `type`, `var`, `let`, and `const` declarations that appear directly inside a package (i.e. that are bound through `Binder.BindGlobalScope`).
- Accessibility modifiers are **not** allowed on locals, inside function bodies, or on positional members. The parser emits `ReportAccessibilityModifierNotAllowedHere` for any modifier that does not precede a recognised top-level declaration keyword.
- Future member-on-type declarations (Phase 3, when `struct` / `class` / `interface` ship) will inherit the same default and the same per-construct ADR-style overrides where useful.

## Consequences

Positive:

- New users can write `func Add(x, y int) int { return x + y }` and call `Add` from C# without any modifier-archaeology.
- Lines up with Kotlin and Scala, the closest spiritual cousins; consistent with GSharp's "Go shape, .NET semantics" tagline.
- Modifiers carry exactly the meaning every C# developer expects (Public / Assembly / Private), so the emitter mapping is trivial.

Negative:

- Library authors who want a small public surface must remember to write `internal` explicitly on most declarations. Mitigation: ADR-0006 already accepted the explicit-modifier trade-off; this just sets the convenient default for the most-trafficked path.

Neutral:

- `public` is also the default in ADR-0006's worked examples; this ADR locks the implementation rather than the user-visible spelling.

## Alternatives considered

- **`internal` default (C#-style)**: rejected; produces a worse first-run experience for users authoring `dotnet new` projects whose entire purpose is to be consumable from outside the assembly.
- **`private` default**: rejected; nonsensical at top level — a private top-level function can only be called within `<Program>`.
- **Mirror Go's capitalization rule**: rejected upstream in ADR-0006; the explicit-modifier model needs a default, and matching identifier casing would re-introduce exactly the confusion ADR-0006 set out to eliminate.
