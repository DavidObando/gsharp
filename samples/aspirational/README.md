# `samples/aspirational/`

Per ADR-0010 (aspirational samples policy), this folder holds samples that exercise GSharp features for which **emit is deferred**. They are deliberately excluded from `test/Compiler.Tests`' end-to-end conformance harness (which compiles through `gsc` and runs the emitted assembly under `dotnet`) and are instead run through the interpreter only.

A sibling test, `test/Core.Tests/LanguageConformance/AspirationalSamplesTests`, discovers every `*.gs` file in this folder that has a paired `*.golden`, parses + binds + evaluates it through the same `Compilation.Evaluate(...)` path as the in-repo unit tests, and compares captured stdout against the golden.

## Current contents (post Phase H async emit closure)

`AsyncTask.gs` now lives under top-level `samples/` and runs on both backends. Remaining files in this directory are aspirational for other deferred surfaces and are excluded from the emit conformance harness until their paired features are implemented.

Phase 5 samples (`AsyncTask.gs`, `PortScan.gs` exercising `chan` + `go` + `scope` + `select`, and `Patterns.gs` / `SwitchExpression.gs` exercising pattern matching) now live under top-level `samples/` and run on both backends after the Phase A–H emit work.

## When to add a sample here

Add a sample here if it exercises a surface that the **interpreter** accepts end-to-end but the **emit backend** does not yet (see the coverage matrix's Emit column). Once emit catches up, the sample MAY be promoted out of `aspirational/` into top-level `samples/` so the regular conformance suite covers it on both backends.
