# ADR-0152: Interpreter native-call boundary

- **Status**: Partially superseded by [ADR-0156](0156-gsi-emit-to-memory-execution.md) Phase 1; remains accepted for the default interactive evaluator
- **Date**: 2026-07-31
- **Phase**: Interpreter conformance
- **Related**: ADR-0086 (P/Invoke), ADR-0153 (interpreter compiled-only storage boundary), [ADR-0156](0156-gsi-emit-to-memory-execution.md) (execution-engine migration), issue [#2986](https://github.com/DavidObando/gsharp/issues/2986)

## Context

The compiler turns a P/Invoke declaration into a native ABI transition and
marshalling stub. The interpreter has no equivalent callable value.

Without an explicit boundary, direct calls can return a plausible fabricated
default value, while first-class references can fail later with unrelated
conversion errors. Silently producing a defined but incorrect value is never
acceptable.

ADR-0153 separately governs the interpreter's compiled-only storage boundary,
including `fixed`, unmanaged `&`/`*`, stack allocation, and function pointers.
This ADR does not redefine that boundary.

## Decision

A bound P/Invoke declaration presented to the tree evaluator reports **GS0514
(Error)** before evaluation, located at the function identifier. The message
names P/Invoke and directs the user to compile with `gsc`.

The error applies even when the declaration is not called. The evaluator cannot
create a valid callable value for the declaration, and function references can
escape the declaring expression before a later indirect call. Refusing the
declaration at the shared evaluation boundary is deterministic, prevents both
fabricated results and delayed `GS9999` failures, and adds no native or
reflection dispatch path.

Since ADR-0156 Phase 1, this boundary applies to `SessionEngine`,
`Compilation.Evaluate`, and default interactive `gsi`, not to file drivers.
Bare `gsc` and `gsi <file>` emit and run the native call; `gsc /out:` emits it
to disk. Interactive `gsi --engine emit` also uses emitted execution.

## Consequences

- The default interactive evaluator never loads a native library for a
  P/Invoke declaration.
- P/Invoke cannot silently return zero, `nil`, or another fabricated default.
- File-mode programs and the opt-in emitted interactive engine run P/Invoke
  through the CLR; evaluator submissions report GS0514 even when a particular
  execution would not call the declaration.
- `GS9999` remains an unexpected evaluator-exception diagnostic, not a
  deliberate capability boundary.

## Alternatives considered

- **Implement P/Invoke with `NativeLibrary` and delegates** — rejected because
  it would cover only a subset of CLR marshalling and preserve divergence for
  unsupported signatures.
- **Diagnose only direct call syntax** — rejected because first-class function
  references and indirect calls would bypass that syntactic check.
- **Let the evaluator fail with GS9999** — rejected because a designed
  capability boundary needs a stable, actionable diagnostic contract.
