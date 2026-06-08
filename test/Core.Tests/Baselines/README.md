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
5. Compares against the entry in `refactoring-baseline.json`.

Entries with a `null` hash are intentionally skipped. Two categories
exist today:

- **Compile failures on `main`** — recorded with a `null` hash so the
  gate doesn't fail on a missing fixture. The per-sample rationale lives
  in `samples/refactoring-baseline/README.md`. The list lives in
  `RefactoringBaselineTests.KnownCompileFailureSamples`.
- **Flaky emit on `main`** — fixtures whose compiled IL is not currently
  byte-deterministic across compiles within the same process (the
  state-machine basic-block emit order depends on reference-identity
  hashes that vary with heap layout). These are pinned to `null` so the
  gate stays green while the underlying compiler determinism bug is
  tracked separately. The list lives in
  `RefactoringBaselineTests.KnownFlakyEmitSamples`. If the underlying
  determinism bug is fixed, remove the sample from that set and
  regenerate the baseline.

## When to regenerate

**Almost never** during the decomposition. The whole point is that
extractions preserve emitted IL — if the gate fires, find the divergence
in the extraction, do not regenerate.

You should only regenerate when a PR has **explicitly and intentionally**
changed emitted IL (e.g. a Wave-3 bug fix that lands after the
decomposition is complete). In that case:

1. Open `test/Core.Tests/CodeAnalysis/Emit/RefactoringBaselineTests.cs`.
2. Find the `RegenerateBaseline` `[Fact(Skip = "manual: …")]` and remove
   the `Skip = …` argument (or change it to a value xUnit accepts as
   unset) so the fact runs.
3. From the repo root, run:
   ```
   dotnet test test/Core.Tests/Core.Tests.csproj \
     --filter "FullyQualifiedName~RegenerateBaseline" \
     --no-restore --nologo
   ```
4. The fact rewrites `test/Core.Tests/Baselines/refactoring-baseline.json`
   in place. If any sample failed to compile, the fact throws and lists
   them — update `samples/refactoring-baseline/README.md` accordingly.
5. Re-apply the skip so the manual fact doesn't run in CI again.
6. Commit both the test file (skip restored) and the regenerated JSON.

If you also added new samples, they will appear in the regenerated JSON
automatically — both `samples/*.gs` and `samples/refactoring-baseline/*.gs`
are scanned.
