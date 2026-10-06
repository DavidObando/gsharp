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
changed emitted metadata or IL (e.g. a Wave-3 bug fix that lands after the
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

The hierarchy-mode transport in PR #4808 intentionally changes 48 of the
160 existing hashes. All 107 other emitted hashes and five existing `null`
entries remain unchanged. A complete comparison against the genuine previous
compiler establishes that the changes are class semantics markers (including
synthesized capture cells), appended attribute-constructor references, and
inheritance-mode extensions to existing markers. Method contracts and bodies,
fields, slots, locals, exception regions, and existing reference rows are
unchanged. Some unrelated assembly metadata attributes now reference an
equivalent duplicate constructor row; its declaring scope, name, signature,
and attribute payload are unchanged. These are reviewed metadata changes,
not a reason to exclude attributes or normalize additional tokens in this gate.

The composition of PR #4715's explicit abstract-property and record repairs
with main at `6296ff2c` derives all 160 entries from the combined compiler's
actual emitted PEs, retaining the same five `null` entries. Fresh builds of both
parents establish 48 hierarchy-transport-only differences from the #4715
producer, with identical methods, slots, fields and resources. Against main,
the existing #4715 record repair changes typed `Equals` flags in 11 samples
and preserves whole-value data-struct copy bodies in two of those samples.
The fresh #4715 parent also exposes four stale pre-composition hashes; the
combined baseline records the actual preserved behavior instead of selecting
either parent's snapshot. Nonempty public/private resource controls retain
their payloads and runtime result. No additional token normalization, compile
exceptions or production behavior change is part of this composition.

The ADR-0190 native-slice implementation adds `samples/NativeSlices.gs` with a
non-null baseline. Its reviewed diff adds only that sample; every pre-existing
hash remains unchanged. The emitted stereo witness also independently verifies
caller-visible value-frame writes and zero allocations in its warmed-up loop.

The reviewed #4776/#4796 update changes only `samples/WebsiteData.gs`: its
`with` expression now calls the existing typed clone once before updating `X`,
instead of reconstructing a parameterless instance and rewriting untouched
members. `Issue4776WebsiteDataCopyEmitTests` pins the real gsc/native C# clone
calls, strict IL verification, unchanged output and original/copy identity and
values. No hashing or baseline-acceptance policy changes accompany that update.

The bounded follow-up updates only `samples/WebsiteKotlin.gs` for the same
typed-clone correction. `Issue4776WebsiteKotlinCopyEmitTests` uses the actual
sample and native Developer contract to pin one clone before the Years update,
unchanged Name storage, original/copy identity and values, and nullable-label
output. Together these corrections replace exactly two hashes; every other
baseline byte remains unchanged.

The value-copy follow-up changes only `samples/DataStructErgonomics.gs` and
`samples/WebsiteSwift.gs` in the complete 160-entry inventory. Their copies now
load existing `Point` storage instead of reconstructing it with `initobj`.
Only the entry-point IL and its larger local signature substantively change;
shifted metadata blob indices still reference identical signatures and
attributes. `Issue4776ValueCopySampleEmitTests` uses both actual samples and
explicitly Roslyn-compiled native record structs to pin fresh-construction
counts, strict whole-image IL verification, output and original/copy state.
The unchanged test DLL fails precisely on the extra constructions with the
pre-copy-fix compiler and passes after restoration. All other 158 entries,
including the five existing null entries, and the hashing policy remain
unchanged.

The bounded composition of #4776 with the reviewed #4808 hierarchy metadata
derives the complete 160-entry map from newly built genuine parent and combined
compilers. The combined map differs from the value-copy parent in its 48
hierarchy-metadata hashes and from the hierarchy parent only in
`DataStructErgonomics` and `WebsiteSwift`; these two combined hashes match
neither parent's standalone output. All 155 emitted samples retain the
value-copy parent's method contracts and bodies, locals, exception regions,
field/type layout and managed resources. Only the intended hierarchy markers
and their attribute-constructor references compose with the two existing
storage-copy entry points. The five null entries and hash policy are unchanged.

The #4777/#4675 data-equality repair intentionally changes eleven existing
sample hashes. Compiler-owned typed equality has a virtual self slot (final for
value data and non-extensible classes), parameters are named `other` and `obj`,
and the nullable reference parameter contracts are emitted. Value-data self
parameters remain values. Class equality operators dispatch through that self
slot rather than repeating field comparisons; this preserves most-derived
equality through inherited calls.

The reviewed before/after images reproduce the original and new gate hashes.
All method counts and decoded signatures, including init modifiers, are
unchanged. Outside the class operators, instruction changes are only metadata
token relocation from the added nullable attribute references. All eleven
samples execute with identical stdout, and both image banks pass unsuppressed
IL verification. Only those eleven hashes changed; the byte-identical gate,
sample inventory and existing null entries are unchanged. This sample-baseline
acceptance does not update the Core public-API golden or certify Core ABI parity.

The #4778 composition with #4808 retains both intentional changes. Fresh full
160-entry banks reproduce each parent's baseline through the existing
enumerator, hash and serializer. The combined bank changes 48 hashes from the
equality parent and eleven from the hierarchy parent, preserving all 155
compiled samples and five known-null entries. Against the equality parent,
every decoded type, field, interface, method signature, slot owner, instruction,
local and exception region is unchanged; the hierarchy metadata matches the
hierarchy parent. Against that parent, the eleven equality changes are exactly
the contracts and operator dispatch described above. The complete golden is
regenerated by the existing baseline fact, without new exclusions or
normalization. This composition does not establish full Core ABI parity.

The #4776 integration with that combined baseline regenerates only the three
conflicted entries. `DataStruct` keeps the equality parent's hash.
`DataStructErgonomics` and `WebsiteSwift` compose the equality and hierarchy
metadata with the existing whole-value copy bodies. The other 157 entries,
five null entries, inventory, and hashing policy are unchanged.
