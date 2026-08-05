# ADR-0152: Interpreter native-call boundary

- **Status**: Superseded by [ADR-0156](0156-gsi-emit-to-memory-execution.md) — the tree-walking evaluator (and with it this boundary and GS0514) was deleted in Phase 3c ([#3176](https://github.com/DavidObando/gsharp/issues/3176)); every driver executes emitted code, where P/Invoke runs natively
- **Date**: 2026-07-31
- **Phase**: Interpreter conformance
- **Related**: ADR-0086 (P/Invoke), ADR-0153 (interpreter compiled-only storage boundary), [ADR-0156](0156-gsi-emit-to-memory-execution.md) (execution-engine migration), issue [#2986](https://github.com/DavidObando/gsharp/issues/2986)

## Context

The compiler turns a P/Invoke declaration into a native ABI transition and
marshalling stub. The deleted interpreter had no equivalent callable value.

Without an explicit boundary, direct calls can return a plausible fabricated
default value, while first-class references can fail later with unrelated
conversion errors. Silently producing a defined but incorrect value is never
acceptable.

ADR-0153 separately governed the interpreter's compiled-only storage boundary,
including `fixed`, unmanaged `&`/`*`, stack allocation, and function pointers.
This ADR did not redefine that boundary.

## Decision

A bound P/Invoke declaration presented to the tree evaluator reported **GS0514
(Error)** before evaluation, located at the function identifier. The message
named P/Invoke and directed the user to compile with `gsc`.

The error applied even when the declaration was not called. The evaluator could
not create a valid callable value for the declaration, and function references
could escape the declaring expression before a later indirect call. Refusing the
declaration at the shared evaluation boundary was deterministic, prevented both
fabricated results and delayed `GS9999` failures, and added no native or
reflection dispatch path.

During ADR-0156 Phases 1–3b, this boundary applied to `SessionEngine`,
`Compilation.Evaluate`, and interactive `gsi --engine evaluator`, not to
default drivers. Bare `gsc`, `gsi <file>`, and the default interactive REPL
emitted and ran the native call; `gsc /out:` emitted it to disk. Phase 3c
deleted the evaluator path and GS0514.

## Consequences

- The tree evaluator never loaded a native library for a P/Invoke declaration.
- P/Invoke could not silently return zero, `nil`, or another fabricated default.
- Default drivers ran P/Invoke through the CLR; evaluator submissions reported
  GS0514 even when a particular execution would not call the declaration.
- `GS9999` remained an unexpected evaluator-exception diagnostic, not a
  deliberate capability boundary.

## Alternatives considered

- **Implement P/Invoke with `NativeLibrary` and delegates** — rejected because
  it would cover only a subset of CLR marshalling and preserve divergence for
  unsupported signatures.
- **Diagnose only direct call syntax** — rejected because first-class function
  references and indirect calls would bypass that syntactic check.
- **Let the evaluator fail with GS9999** — rejected because a designed
  capability boundary needs a stable, actionable diagnostic contract.
