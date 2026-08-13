# IL byte-identical baseline (PR-0 gate)

This directory holds `refactoring-baseline.json`, the committed SHA-256 digest
for every fixture compiled by
`test/Core.Tests/CodeAnalysis/Emit/RefactoringBaselineTests.cs`.

The gate exists for the Binder/Emitter decomposition work (see the PR-0
plan): every extraction PR is supposed to be behavior-preserving, so the
emitted PE for the curated sample set must hash to exactly the same value
as it did before the extraction. Any diff blocks the PR.

## What the test does

For each `samples/*.gs` and `samples/refactoring-baseline/*.gs`:

1. Parses the source and constructs a `Compilation`.
2. Sets `DebugInformation.Deterministic = true`.
3. Calls `compilation.Emit(...)` with a fixed assembly name + version.
4. Hashes the parts of the PE that the gate pins:
   - the metadata stream, with the MVID GUID bytes zeroed,
   - every method body's IL bytes in MethodDef table order.
   The PE wrapper itself (headers, section layout, debug directory, PE
   checksum, COFF `TimeDateStamp`) is deliberately excluded because those
   regions are derived from content hashes that can drift orthogonally to
   actual emit changes.
5. Serializes the complete sorted hash map and compares it to
   `refactoring-baseline.json` through the shared `GoldenFile` snapshot helper.
   Drift writes `refactoring-baseline.json.actual` with the first differing
   line reported.

Entries with a `null` hash are intentionally skipped. One category exists
today:

- **Compile failures on `main`** — recorded with a `null` hash so the
  gate doesn't fail on a missing fixture. The per-sample rationale lives
  in `samples/refactoring-baseline/README.md`. The list lives in
  `RefactoringBaselineTests.KnownCompileFailureSamples`.

## When to regenerate

**Almost never** during the decomposition. The whole point is that
extractions preserve emitted IL — if the gate fires, find the divergence
in the extraction, do not regenerate.

You should only regenerate when a PR has **explicitly and intentionally**
changed emitted IL (e.g. a Wave-3 bug fix that lands after the
decomposition is complete). In that case:

1. Run the gate normally and inspect
   `test/Core.Tests/Baselines/refactoring-baseline.json.actual`. Confirm every
   changed hash belongs to the intended emit change.
2. From the repo root, rerun the same gate with shared golden update mode:
   ```
   GSHARP_UPDATE_GOLDENS=1 \
   dotnet test test/Core.Tests/Core.Tests.csproj \
     --filter "FullyQualifiedName~Samples_EmittedPE_Match_Baseline" \
     --no-restore --nologo
   ```
3. The shared helper rewrites
   `test/Core.Tests/Baselines/refactoring-baseline.json` in place. If any
   sample failed to compile, the fact fails and lists it before updating the
   snapshot; update `samples/refactoring-baseline/README.md` when adding a
   deliberate compile-failure exception.
4. Commit the reviewed regenerated JSON.

If you also added new samples, they will appear in the regenerated JSON
automatically — both `samples/*.gs` and `samples/refactoring-baseline/*.gs`
are scanned.
