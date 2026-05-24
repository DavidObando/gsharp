# `samples/aspirational/`

Per ADR-0010 (aspirational samples policy), this folder holds samples that exercise GSharp features for which **emit is deferred**. They are deliberately excluded from `test/Compiler.Tests`' end-to-end conformance harness (which compiles through `gsc` and runs the emitted assembly under `dotnet`) and are instead run through the interpreter only.

A sibling test, `test/Core.Tests/LanguageConformance/AspirationalSamplesTests`, discovers every `*.gs` file in this folder that has a paired `*.golden`, parses + binds + evaluates it through the same `Compilation.Evaluate(...)` path as the in-repo unit tests, and compares captured stdout against the golden.

## Current contents (Phase 5 exit)

| Sample | Demonstrates |
| --- | --- |
| `PortScan.gs` | `chan T`, `make`/`close`, send/receive, `go`, `scope { ... }`, `select` with timeout arm. |
| `AsyncTask.gs` | `async func`, `await`, BCL `Task.Delay` interop, `scope { go asyncEntry() }` driver pattern for top-level async. |

## When to add a sample here

Add a sample here if it exercises a surface that the **interpreter** accepts end-to-end but the **emit backend** does not yet (see the coverage matrix's Emit column). Once emit catches up, the sample MAY be promoted out of `aspirational/` into top-level `samples/` so the regular conformance suite covers it on both backends.
