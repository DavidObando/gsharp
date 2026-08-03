# ADR-0152: Interpreter native-call boundary

- **Status**: Partially superseded by [ADR-0156](0156-gsi-emit-to-memory-execution.md) Phases 1–3a; remains accepted for direct tree evaluation and the deprecated evaluator compatibility path
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

Interpreted execution reports **GS0514 (Error)** when it reaches either a
direct P/Invoke call or a first-class reference to a P/Invoke function. The
diagnostic is located at the use expression, not the declaration, and directs
the user to emit with `gsc /out:<path>` and run the emitted program.

An unused P/Invoke declaration remains valid. This preserves programs such as
`samples/PInvokeFunctionPointer.gs`, which declare native signatures for the
emit pipeline but execute only managed code. A first-class reference is refused
when evaluated because the interpreter cannot create a valid callable value for
it. A direct call is refused before argument evaluation or native dispatch.
This prevents fabricated results and delayed `GS9999` failures without adding
a native or reflection dispatch path.

Deliberate evaluator diagnostics are compiler control signals, not user
exceptions. G# `catch` clauses cannot intercept them; ordinary runtime
exceptions remain catchable. The evaluator marks deliberate diagnostics as
control signals and routes them past user exception matching. Evaluator
wrappers that preserve a real runtime exception remain catchable by that
exception's runtime type.

ADR-0022 discards unhandled *runtime exceptions* from a free-standing `go`
task. GS0514 is not a runtime exception, so a direct `go` P/Invoke call is
rejected synchronously before the fire-and-forget task is scheduled.

Since ADR-0156 Phases 1–3a, this boundary applies to `SessionEngine`,
`Compilation.Evaluate`, and interactive `gsi --engine evaluator`, not to
default drivers. Bare `gsc`, `gsi <file>`, and the default interactive REPL
emit and run the native call; `gsc /out:` emits it to disk. The evaluator path
is deprecated and scheduled for removal in Phase 3c.

## Consequences

- Interpreted execution never loads a native library for a P/Invoke use.
- P/Invoke cannot silently return zero, `nil`, or another fabricated default.
- User `catch` clauses cannot swallow GS0514, and a direct `go` P/Invoke call
  is rejected before its fire-and-forget task is scheduled.
- Programs may declare P/Invoke functions under interpretation when execution
  never calls or references them.
- Default drivers run P/Invoke through emitted CLR execution; native calls are
  unavailable only on the deprecated evaluator path.
- `GS9999` remains an unexpected evaluator-exception diagnostic, not a
  deliberate capability boundary.

## Alternatives considered

- **Implement P/Invoke with `NativeLibrary` and delegates** — rejected because
  it would cover only a subset of CLR marshalling and preserve divergence for
  unsupported signatures.
- **Reject every P/Invoke declaration** — rejected because declaration alone
  does not require a callable interpreter value and shipped emit-focused
  samples contain intentionally unused native signatures.
- **Diagnose only direct calls** — rejected because first-class function
  references would otherwise create invalid callable values and fail later.
- **Let the evaluator fail with GS9999** — rejected because a designed
  capability boundary needs a stable, actionable diagnostic contract.
