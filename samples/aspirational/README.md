# `samples/aspirational/`

Per ADR-0010 (aspirational samples policy), this folder held samples that exercised GSharp features for which **emit was deferred**. They were deliberately excluded from `test/Compiler.Tests`' end-to-end conformance harness (which compiles through `gsc` and runs the emitted assembly under `dotnet`) and were instead run through the tree-walking interpreter only.

That interpreter-only harness (`AspirationalSamplesTests`, built on `Compilation.Evaluate(...)`) was removed together with the evaluator in ADR-0156 Phase 3c — emit is now the only execution backend, so an "interpreter-runs-it, emit-doesn't" sample can no longer execute at all.

## Current contents

_None — every sample previously parked here has been promoted out as the emit
backend caught up. See "Previously promoted samples" below for the history._

### Previously promoted samples

| Sample | Promoted from aspirational in | Demonstrates |
| --- | --- | --- |
| `AsyncTask.gs` | #135 | Async/await with `Task` (ADR-0023) |
| `PortScan.gs` | Phase A–G emit closure | `chan` + `go` + `scope` + `select` concurrency |
| `Patterns.gs` | Phase A–G emit closure | Pattern matching |
| `SwitchExpression.gs` | Phase A–G emit closure | Switch expressions |
| `Enum.gs` | This PR | `type … enum` declarations with switch/arrow patterns |
| `Exhaustiveness.gs` | This PR | Exhaustive enum switch expressions (no `default` needed) |
| `ExpressionEval.gs` | This PR | Sealed-interface type-pattern switch expressions |
| `NullableFlow.gs` | This PR | Nullable flow analysis with pattern switch and `if` guard |
| `Defer.gs` | #408 | Block-scoped `defer` and `using` cleanup convergence (Phase 7.1) |
| `MethodsWithReceivers.gs` | #409 | Same-package receiver declarations bound as methods on user-defined structs (Phase 6.4) |

## When to add a sample here

Historically: a sample landed here when the **interpreter** accepted it end-to-end but the **emit backend** did not yet; once emit caught up it was promoted into top-level `samples/`. With the evaluator removed (ADR-0156 Phase 3c) that split no longer exists — a new sample for an unimplemented emit surface has nowhere to run, so this folder is expected to stay empty. If a future feature ships parsing/binding ahead of emit and wants a parked sample, it needs a new policy (e.g. a bind-only golden), decided at that time.
