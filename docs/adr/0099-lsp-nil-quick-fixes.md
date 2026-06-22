# ADR-0099: LSP code-actions for nil-related diagnostics

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Phase 8 — tooling polish
- **Closes**: Issue #730 (Add LSP quick-fix code actions for common nil-related diagnostics)
- **Related**: ADR-0001 (postfix `!!` null-assertion); ADR-0072 (`??=` null-coalescing compound assignment); ADR-0073 (`?[...]` null-conditional index); ADR-0081 (`nil` literal — `null` is not a keyword); parent issue #706 (G# Language — Current State and Design Opportunities, §6.4 Tooling)

## Context

G# has had nullable types (`T?`), the postfix null-assertion operator
`!!`, the null-coalescing expression operator `??` (originally `?:`; respelled by ADR-0116), the
null-conditional member access `?.`, and the null-conditional index
access `?[…]` for several releases. The binder emits a small family of
diagnostics whenever a user writes code that does not yet thread these
operators through correctly:

| Code | Reported by | Trigger |
| ---- | ----------- | ------- |
| `GS0154` | `DiagnosticBag.ReportWrongArgumentType` | An argument of type `T?` was passed to a parameter declared `T`. |
| `GS0155` | `DiagnosticBag.ReportCannotConvert` | An expression of type `T?` was used where `T` was required (assignment, return value, conditional arm, …). |
| `GS0156` | `DiagnosticBag.ReportCannotConvertImplicitly` | Same as GS0155 but an explicit conversion exists (typically the implicit-only nullable→non-nullable). |
| `GS0158` | `DiagnosticBag.ReportUnableToFindMember` | A member access `a.b` did not find `b`; when the receiver is `T?` the binder reports this rather than a dedicated "deref of nullable" message — the `Nullable<T>` projection for value types and the NRT receiver path both flow here. |
| `GS0274` | `DiagnosticBag.ReportNilNotAssignableToNonNullableParameter` | A literal `nil` was passed to a non-nullable parameter. |

Without quick-fixes the user is stuck consulting prose docs (or
guessing) to remember which of `?.`, `??`, or `!!` is appropriate. The
issue (parent #706 §6.4) asks the LSP to surface those three rewrites
as `textDocument/codeAction` results directly off the diagnostic.

## Decision

Add a quick-fix provider per operator inside
`src/LanguageServer/NullabilityQuickFixes.cs`, dispatched from
`CodeActionComputer.ComputeCodeActions`. The provider keys off the
five diagnostic codes above (and ignores all others). Rewrites are
emitted as LSP `TextEdit`s — not syntax-tree transformations — so the
LSP layer can compose them with concurrent client edits without
re-parsing.

### Operator-to-diagnostic mapping

| Operator | Trigger diagnostics | Edit |
| -------- | ------------------- | ---- |
| `.` → `?.` | `GS0158` on the right-hand identifier of an `AccessorExpressionSyntax` whose left-part is statically nullable (chained `?.`, literal `nil`, or a local/parameter/field whose declared type-clause text ends with `?`). | Replace the dot token's span with `?.`. |
| `expr` → `(expr ?? <default>)` | `GS0154` / `GS0155` / `GS0156` whose diagnostic message contains the canonical `'T?'` → `'T'` pair. `GS0274` is excluded — the source is literal `nil`, the rewrite is degenerate. | Replace the diagnostic span with `(<original> ?? <default>)`, where `<default>` is a primitive-aware literal (`""`, `0`, `false`, `default`). |
| `expr` → `(expr!!)` | Same as `??`. | Replace the diagnostic span with `(<original>!!)`. |

### Edit-construction strategy

LSP code-actions return `WorkspaceEdit` values whose payload is a
sequence of `TextEdit`s scoped to document URIs. We use **text-edit-based
rewrites** rather than syntax-tree rewrites for three reasons:

1. The LSP wire format is itself text-edit-based; producing edits in
   the same shape keeps the server side simple and avoids a
   syntax-tree → text serialiser pass on every code action.
2. Text edits can be merged with any uncommitted typing the user has
   in flight on the client (LSP guarantees `version` ordering); a
   syntax-tree rewrite would force the server to claim ownership of
   the in-flight text.
3. The three rewrites are extremely narrow (`.` → `?.`, span → `(span
   ?? x)`, span → `(span!!)`). A syntax-tree rewrite would need a
   formatter pass to reconstruct trivia for the surrounding parens,
   which adds complexity for no gain.

The provider never re-binds the program; it reads diagnostics from the
existing `Compilation.BoundProgram.Diagnostics` cache (kept warm by the
existing `ProjectState.GetCompilation` pipeline) and inspects the
parser's syntax tree to validate receiver-is-nullable. This keeps the
hot path for `textDocument/codeAction` aligned with the existing
HoverComputer / CompletionComputer cost profile.

### Detection precision

The provider is intentionally **conservative on offer, generous on
correctness**. Both ergonomic principles are required by the issue's
acceptance criteria:

- The `.` → `?.` rewrite is gated on a syntactic nullability check on
  the receiver. If the receiver is an opaque method call (`foo().Bar`)
  whose result type is nullable, the rewrite is *not* offered yet — a
  future refinement can re-bind the left-part to recover the type.
  The user is no worse off than today; the diagnostic still surfaces.
- The `??` and `!!` rewrites are gated on the diagnostic message
  carrying the `'T?'` → `'T'` pair the binder produces verbatim from
  `TypeSymbol.ToString()`. This is robust against the binder reporting
  the same code (`GS0155`) for non-nullable mismatches.

### Negative cases (no quick fix)

The provider must remain silent for:

- Diagnostics outside the requested range.
- Diagnostic codes not in the supported set (any of the existing
  GS0001…GS0153, GS0157, GS0159…, etc.).
- `GS0274` on literal `nil`, where wrapping `nil` in `??` or `!!` is
  always wrong — the only sensible fix is to make the parameter
  nullable, which the diagnostic message already suggests.

## Consequences

- **Discoverability** — the three escape hatches surface directly at
  the squiggle, removing the need for users to remember the operator
  set.
- **Cost** — `textDocument/codeAction` already runs the binder pass via
  `Compilation.BoundProgram`; the new code adds a single
  diagnostic-loop and message-text parse, well below the existing
  per-request cost.
- **Forward compatibility** — adding a new nullable-related diagnostic
  in the future requires updating the `switch` in
  `CodeActionComputer.AppendNullabilityQuickFixes` to wire the code to
  the existing or a new provider.
- **VS Code surface** — no client changes; the VS Code extension
  already declares the `codeActionProvider` capability via the LSP
  capability handshake (`ServerCapabilitiesFactory`).

## Rejected alternatives

- **Syntax-tree-based rewrites with a formatter round-trip.** Would
  require threading the formatter through the code-action layer and
  re-emitting trivia, which adds complexity for the three narrow
  rewrites here.
- **A separate quick-fix per diagnostic code.** The three operators
  are conceptually about the *user's intent*, not the diagnostic. The
  current model (one operator → many diagnostics → one provider)
  matches the way users think and keeps the code mapping centralised.
- **Re-binding the receiver to determine nullability.** Considered for
  the `.` → `?.` case so we could offer the fix on
  `foo().Bar` chains. Deferred to a follow-up; the current syntactic
  check covers the common case (`local.Member`,
  `parameter.Member`, `field.Member`).

## Tests

- `test/LanguageServer.Tests/CodeActionHandlerTests.cs` covers each
  rewrite for the diagnostic that triggers it, asserts the title and
  the edit text, applies the edit, and re-binds to confirm the
  triggering diagnostic is no longer reported.
- Negative tests cover: a `GS0158` on a non-nullable receiver (no
  `?.` fix), a `GS0274` on literal `nil` (no `??` / `!!`), an
  unrelated diagnostic (no nullable fixes at all), and a request range
  that does not overlap any diagnostic span.

## References

- Issue #730 — Add LSP quick-fix code actions for common nil-related diagnostics.
- Parent issue #706 — G# Language — Current State and Design Opportunities, §6.4 Tooling.
- ADR-0001 — postfix `!!` null-assertion.
- ADR-0072 — `??=` null-coalescing compound assignment.
- ADR-0073 — null-conditional index access `?[i]`.
- ADR-0081 — `nil` as the canonical null literal (`null` is not a keyword).
