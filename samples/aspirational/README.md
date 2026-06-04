# `samples/aspirational/`

Per ADR-0010 (aspirational samples policy), this folder holds samples that exercise GSharp features for which **emit is deferred**. They are deliberately excluded from `test/Compiler.Tests`' end-to-end conformance harness (which compiles through `gsc` and runs the emitted assembly under `dotnet`) and are instead run through the interpreter only.

A sibling test, `test/Core.Tests/LanguageConformance/AspirationalSamplesTests`, discovers every `*.gs` file in this folder that has a paired `*.golden`, parses + binds + evaluates it through the same `Compilation.Evaluate(...)` path as the in-repo unit tests, and compares captured stdout against the golden.

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

Add a sample here if it exercises a surface that the **interpreter** accepts end-to-end but the **emit backend** does not yet (see the coverage matrix's Emit column). Once emit catches up, the sample MAY be promoted out of `aspirational/` into top-level `samples/` so the regular conformance suite covers it on both backends.
