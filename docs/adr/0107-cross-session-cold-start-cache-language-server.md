# ADR-0107: Cross-session cold-start cache for the language server

- **Status**: Proposed
- **Date**: 2026-06-15
- **Phase**: Language-server performance
- **Related**: issue #868; issue #866 / ADR-0105 (incremental delta binding — complementary, per-keystroke); ADR-0106 (incremental SemanticModel); `src/Core/CodeAnalysis/Symbols/ReferenceResolver.cs`, `src/Core/CodeAnalysis/Symbols/ReferenceMetadataIndex.cs`, `src/LanguageServer/ColdStartCache.cs`, `src/LanguageServer/ProjectState.cs`, `src/LanguageServer/ProjectDiscovery.cs`

## Context

The first time the language server opens a large G# workspace, the user waits on a full cold analysis pass before completion, diagnostics, and hover work. Measured on the Oahu repro (`Oahu.Cli.Tests`, 54 source files, 352 assembly references) by driving the real LSP path (`ProjectDiscovery` → `ProjectState` → `Compilation`), cold start is ~880–940 ms, decomposed as cold `GlobalScope` ~290–336 ms plus cold `BoundProgram` ~594–602 ms. None of it survives process exit, so every reopen and every fresh clone pays it again. ADR-0105 and ADR-0106 attack the *per-keystroke* (warm-session) cost; this ADR attacks the *cross-session cold-start* cost, the visible "open the folder and wait" pause.

### Prior art: C# Dev Kit `.lscache`

C# Dev Kit ships a cold-start cache as one text, INI-like `<Project>.csproj.lscache` file per project, sitting next to the project file. It begins with `version=1` and a human-readable `#` comment block (states what it caches, that it is not for manual editing, that it can be safely deleted and auto-regenerates, how to gitignore it, and the opt-out setting `dotnet.projectsystem.enableLanguageServiceCache`), then `[section]` blocks: `[project]`, `[properties]`, `[commandLineArguments]`, `[sourceFiles]`, `[metadataReferences]`, analyzers, and so on. What it persists is the **MSBuild design-time-build / project-system output** — a full project snapshot that lets the C# language service describe and analyze a project on reopen *without re-running the slow design-time build*. It is not a semantic/bind cache; Roslyn persists semantic state separately. Known pitfalls from their tracker that any such cache inherits: payload non-determinism (vscode-dotnettools#2965) and stale/duplicate entries (#2996); a robust fingerprint and a safe fallback are the mitigations.

### Correcting the original framing: G# *does* need the project-system layer

An earlier draft of this ADR claimed G# "barely needs" a `.lscache` because it "gets project data cheaply from the `.rsp`." That is wrong, and the evidence is concrete. The `.rsp` the language server reads (`ProjectDiscovery.DiscoverReferences`) is the MSBuild-emitted response file at `$(IntermediateOutputPath)$(TargetName).rsp` — i.e. it lives under `obj/`, and `*.rsp` is gitignored. It is an **ephemeral build artifact**: it does *not* survive `dotnet clean`, and it does *not* exist in a fresh clone before the first build/restore. When it is absent, `DiscoverReferences` returns an *empty* reference set, so the language server cannot resolve a single imported CLR type — completion, hover, and diagnostics on imported types are all degraded until a build runs. The original cold-start cache made this worse, not better: its fingerprint *required* the `.rsp`, so it was useless in exactly the fresh-clone / freshly-cleaned scenarios where a cold-start cache matters most.

C#'s `.lscache` is in fact *more* like what G# needs than the original framing admitted. Its `[commandLineArguments]` section is the direct `.rsp`-equivalent, and it *additionally* persists the resolved `[metadataReferences]`, `[sourceFiles]`, `[properties]`, and analyzers — a committable, build-independent project-system snapshot. G# should adopt that full project-system layer (so a checkout can describe its reference set without re-running the design-time build) **and** add the slice that is uniquely G#'s cold bottleneck: the reference-metadata type-name index.

### Where G#'s cold `GlobalScope` time actually goes

Profiling the G# cold `GlobalScope` on Oahu decomposes the ~300 ms into three parts:

| Sub-phase | Cost | Cacheable across sessions? |
| --- | --- | --- |
| `ReferenceResolver.WithReferences` — create `MetadataLoadContext`, load 352 reference DLLs | ~103 ms | No — yields live `Type` objects bound to the load context; cannot be serialized |
| First `TryResolveType` — build the full-name → `Type` index via `Assembly.GetTypes()`/`GetForwardedTypes()` over the whole closure (~25 000 names) | ~120 ms | **Yes** — a pure function of the (ordered) reference set; its *structure* is independent of source |
| Actual signature binding | ~50 ms | No — source-dependent |

So the single biggest cross-session-cacheable slice of G#'s cold cost is the **reference-metadata type-name index**. The project-system layer (above) is what makes the cache usable at all without a build; the metadata index is what makes a warm open faster.

## Decision

Add a cross-session cold-start cache that adopts the C# `.lscache` format and conventions in full, persists both a committable project-system layer and the reference-metadata index, and is `.rsp`-independent so it survives `dotnet clean` and fresh clones.

### Format decision: a single human-readable text file (retracting the prior text-vs-binary split)

The cache is **one** text file per project, `<AssemblyName>.gsproj.lscache`, next to the project file. It starts with a `version=N` line and a `#` comment block (purpose, "generated, do not edit", safe-to-delete / auto-regenerates, gitignore guidance, committable opt-in note, and the opt-out env var), then `[project]`, `[fingerprint]`, `[references]`, and `[metadataIndex]` sections.

The original design split the heavy ~25 000-name index into a sibling **binary** blob (`<AssemblyName>.gsproj.lscache.bin`) under a "text is too large/slow" performance exception. **That exception is false, and is retracted.** Measured for a 25 000-name index: a text encoding is 1342 KB and parses in **4.2 ms**; the binary encoding is the same 1342 KB and parses in **2.2 ms**. Same size, ~2 ms apart, and both are negligible against the ~120 ms enumeration the cache exists to skip. There is no performance justification for a second file. There *is* a cost to it: `*.lscache` is becoming a standard .NET gitignore entry, whereas `*.lscache.bin` is a G#-unique line every consumer must remember to add. So the index lives in a `[metadataIndex]` **text section** — newline-delimited type names grouped per assembly (`assembly=<identity>`, `typeNameCount=<n>`, then `n` names) — written last so its body runs to end-of-file. One file, fully diffable, standard ignore rule.

### What is persisted

- **Project-system layer** (`[project]` + `[references]`): the assembly name, the target framework, a source fingerprint, and the resolved metadata reference set — each DLL path with its size and last-write time. This is the `.rsp`-equivalent plus snapshot. It lets a checkout describe its reference set on its own, with no design-time build.
- **Metadata index** (`[metadataIndex]`): a `ReferenceMetadataIndex` (`src/Core/CodeAnalysis/Symbols/ReferenceMetadataIndex.cs`) — for each referenced assembly, its identity (`AssemblyName.FullName`) and the full type-names it defines or forwards, in resolver search order. This is exactly the input to `ReferenceResolver`'s eager type-name index, captured *before* it is collapsed into live `Type` objects. It carries **no `Type` instances** (those are bound to a `MetadataLoadContext` and cannot survive a process exit) and **no source-derived state** — it is a pure function of the ordered reference set.

On load, `ProjectState` builds the resolver (`WithReferences`, the ~103 ms `MetadataLoadContext` load is unavoidable), then hands the deserialized index to `ReferenceResolver.TryUseMetadataIndex`. The resolver adopts it as a warm full-name → assembly-index map and **skips the ~120 ms `GetTypes()`/`GetForwardedTypes()` enumeration entirely**; `TryResolveType` materializes individual `Type` objects lazily by name (`Assembly.GetType`) only for names the binder actually probes.

### `.rsp`-independent bootstrap (the clean / fresh-clone capability)

The whole point of the project-system layer is that the cache no longer depends on the `.rsp`:

- **When a `.rsp` exists, it remains authoritative.** The references come from it; the cache is loaded/refreshed against them.
- **When no `.rsp` exists** (fresh clone, or after `dotnet clean`) and a valid `.lscache` is present, `ProjectState.GetOrBuildResolver_NoLock` **bootstraps the reference set from the cache's `[references]` section** (`ColdStartCache.TryBootstrapReferences`) instead of returning empty — so the LSP resolves imported types without first building. Every recorded DLL is re-validated (it must still exist and match its recorded `size:mtime` stamp) before use, and the assembly identities are re-checked when the metadata index is adopted (`TryUseMetadataIndex`). If any reference is missing or changed, the bootstrap refuses and the LSP falls back to today's empty/degraded behavior — it never resolves against a stale reference set.

### Fingerprint and invalidation (conservative, `.rsp`-independent)

The metadata index is trusted only when **all** of the following match; any mismatch, missing file, version change, or corruption is a cache miss:

- **Descriptor version** (`DescriptorVersion`) and **index format version** (`ReferenceMetadataIndex.FormatVersion`) — bumped on any layout change.
- **Compiler / cache version** — the `GSharp.Core` assembly version, so a compiler upgrade invalidates every cache.
- **Reference set** — the ordered reference paths, each with its file size and last-write time (UTC ticks). Adding/removing/reordering a reference, or touching any reference DLL, flips the fingerprint.
- **Source fingerprint** — a SHA-256 over the project's current sources (each file's project-relative path plus its content). Conservative: any source edit invalidates. (The metadata index is strictly a function of the references, so this is stronger than necessary for *this* payload; it is included deliberately so the same fingerprint vocabulary gates the source-dependent Phase 2 payload, and over-invalidation is always safe.)
- **Target framework** — the project's TFM moniker (`ProjectDiscovery.ResolveTargetFramework`).
- **Index integrity SHA-256** — the `[metadataIndex]` section is re-hashed on load and compared to the recorded value, rejecting in-place corruption (e.g. a flipped type name) that still parses structurally.
- **Assembly-identity match** — `TryUseMetadataIndex` additionally rejects the payload unless the recorded assembly identities match the freshly-loaded resolver's assemblies exactly (count + `FullName` + order). Defence-in-depth on top of the fingerprint.

Critically, the fingerprint **deliberately does not depend on the `.rsp`** — the `.rsp` is the ephemeral `obj/` artifact, not the real input. The descriptor still *records* the `.rsp` path and stamp for information, but the cache validates and loads without it. The `[references]` bootstrap is gated only on physical DLL re-validation (existence + stamp + identity-at-adoption), independent of the source fingerprint, so reference resolution keeps working in a fresh clone even if a source file has since been edited.

Under-invalidation (loading a stale cache) would be a correctness bug; over-invalidation merely costs a cold rebuild. The scheme is deliberately conservative on the side of over-invalidation.

### Correctness: warm resolution is a superset of cold resolution

The non-negotiable property is that a cache-loaded analysis is identical to a cold from-scratch one — same diagnostics, hover, definition, completion — and that the cache never touches emit (it changes latency, not emitted IL). Two facts make warm resolution match cold:

1. **Same keyset.** The cached names are exactly those `GetTypes()`/`GetForwardedTypes()` produced (the same enumeration, shared via `ReferenceResolver.EnumerateDefinedAndForwardedTypes`). So a name absent from the warm index is a genuine miss, and first-writer-wins precedence is preserved by recording the first declaring assembly.
2. **Faithful materialization with a scan fallback.** `Assembly.GetType(fullName)` on the recorded declaring assembly returns the same `Type` the eager index held — verified empirically on the Oahu closure: for all ~25 000 names, warm `GetType` resolution matched the cold index on `FullName` and assembly identity (zero nulls, zero mismatches, including the forwarded types whose forwarders `GetType` follows). For defence in depth, if the recorded assembly cannot satisfy `GetType`, `TryResolveType` falls back to an in-order scan of all assemblies, guaranteed to find the first declarer. Warm resolution can therefore never resolve *fewer* or *different* types than cold.

The opt-out path is untouched: when the cache is disabled, no index is adopted and `TryResolveType` uses the existing eager index, byte-for-byte as before this ADR. The metadata index carries no `Type` instances and no source-derived state, so it cannot encode a load-context-bound or stale-source dependency.

### Committable (opt-in) and its honest caveat

The file is gitignored **by default** (`*.lscache`, matching the prevailing .NET convention and minimizing friction). But the format and fingerprint are designed so a team *can* choose to commit it for fast fresh-clone opens: the descriptor is plain diffable text, the source fingerprint is over project-relative paths (portable across clones of the same sources), and the metadata index is keyed on assembly identities rather than machine state. The honest caveat is documented in the file's own comment block and here: **a committed `.lscache` still needs the referenced DLLs present.** `dotnet restore` brings the NuGet package DLLs back; project-reference DLLs require those projects to be built. So a committed cache helps "after restore / after clean," not from a zero-dependency checkout — and because the reference paths and their stamps are validated before use (and are machine-specific for NuGet/SDK locations), a cache that does not validate simply and safely degrades to a cold build. Relocatable/portable-path encoding (token-substituting the NuGet/SDK/workspace roots) is a possible future enhancement; it is not required for correctness.

### Location, opt-out, and lifecycle

- **Location**: next to the project file, `<AssemblyName>.gsproj.lscache`. Gitignored by default; not picked up as a compile item (the SDK globs `**/*.gs`).
- **Opt-out**: environment variable `GSHARP_DISABLE_COLD_START_CACHE` (`1`/`true`/`on`/`yes`), surfaced in VS Code as the `gsharp.coldStartCache.enable` setting (the extension maps the setting onto the env var at server launch). When the `gsharp` setting is left unset, the extension honors the C# Dev Kit setting `dotnet.projectsystem.enableLanguageServiceCache` as a fallback if present (read-only — G# never contributes that key), giving dual C#/G# users a single toggle. When disabled, the cache is neither read (load nor bootstrap) nor written, and the resolver stays on the cold path.
- **Safe to delete**: deleting the file at any time is harmless; the next open rebuilds and rewrites. No method in `ColdStartCache` ever throws into the LSP pipeline — every read/write is best-effort and any error degrades to a cold build.
- **Ownership**: `ProjectState` owns the cache lifecycle, in `GetOrBuildResolver_NoLock`, alongside the warm `ReferenceResolver` it already caches. The cache is consulted exactly once per resolver build (i.e. when the reference set changes), so steady-state editing pays nothing.

### Measured result (Oahu, separate processes)

| | Cold `GlobalScope` | Warm `GlobalScope` | `BoundProgram` | Diagnostics |
| --- | --- | --- | --- | --- |
| With cache | ~350–410 ms | **~207–230 ms** | ~650 ms (unchanged) | identical |

Warm `GlobalScope` is ~140–180 ms faster than cold — a ~40 % reduction of `GlobalScope` and ~15–18 % of total cold start — with **identical diagnostics**, confirming the cache changes only latency, not results. Separately, with the `.lscache` present but the `.rsp` removed (simulating `dotnet clean`), the LSP bootstraps its reference set from the cache and produces the same diagnostics as a normal `.rsp`-backed build, whereas with no cache and no `.rsp` it degrades to an empty reference set. `BoundProgram` is unchanged because the source bind is deliberately *not* cached here (see the phased plan).

## Consequences

**Positive**

- Reopening a previously-analyzed project skips the ~120 ms reference-metadata enumeration, directly cutting the most cacheable slice of cold `GlobalScope`, and — new in this revision — a fresh clone or freshly-cleaned tree can resolve imported types *before the first build* by bootstrapping its reference set from the cache. The win is correctness-safe (superset resolution, conservative fingerprint, identity check, integrity hash, physical DLL re-validation) and free of new cold-path cost (the index the cold path builds anyway is the one written).
- One diffable text file with a standard gitignore rule; optionally committable for fast fresh-clone opens.
- Establishes the cache container, fingerprint vocabulary, project-system layer, and on-disk layout that a future, larger payload (bound signatures / global scope) can extend without re-litigating location, opt-out, invalidation, or encoding.
- Cold and warm sessions now share one resolution code path (lazy `GetType` from a name index), so the cache cannot introduce a divergence the cold path would not also exhibit.

**Negative / cost**

- A new on-disk artifact per project (~1.3 MB text on Oahu). It is gitignored by default, safe to delete, and outside the build, but it is real disk footprint.
- The `MetadataLoadContext` load (~103 ms) and the full source bind (~600 ms) are *not* eliminated; this ADR captures the metadata-index slice and the bootstrap capability. The headline warm cold-start number drops by ~15–18 %, not to zero.
- A new invariant future binder/resolver changes must uphold: warm resolution must remain a superset of cold (same name set, faithful materialization). The `EnumerateDefinedAndForwardedTypes` single-source-of-truth and the equivalence tests guard it.
- Cross-machine committability is partial: NuGet/SDK reference paths are machine-specific, so a committed cache validates fully only where those paths match; elsewhere it safely degrades to a cold build. Portable-path encoding is left as future work.

**Neutral**

- No change to emitted IL or to non-LSP build behavior. The cold from-scratch path remains the correctness oracle and the universal fallback.
- No change to the `Compilation` shape or its immutability; the cache lives entirely in `ProjectState`/`ReferenceResolver` state set before first resolution.

## Phased plan (deferred, by design)

This ADR ships the **project-system layer + reference-metadata layer** (best cold-time-saved and bootstrap-capability ÷ serialization-risk ratio) and *designs* the riskier layer:

- **Phase 2 — bound `GlobalScope` / per-file symbol signatures.** The ~600 ms `BoundProgram` and the signature half of `GlobalScope` are the biggest remaining cold cost, but serializing the bound symbol graph soundly is hard: symbols reference `Type` objects (load-context-bound), each other, and source spans. It requires the *stable symbol identity* ADR-0105 Phase 2 introduces (a position-independent `stableMemberId`) plus a content-addressed, load-context-independent symbol encoding, and the same byte-reproducibility guarantees ADR-0105 demands for emit. It should be fingerprinted on source content hashes in addition to the reference set (the source fingerprint this ADR already records), and validated against the cold bind as oracle. Deferred until stable identity lands; only implemented if byte-for-byte equivalence (diagnostics *and* emitted IL) can be guaranteed.
- **Portable / relocatable reference paths.** Token-substitute the NuGet package root, SDK root, and workspace root so a committed `.lscache` validates across machines after `restore`. Only a path-encoding policy and a determinism audit are needed; correctness already degrades safely without it.

## Alternatives considered

- **Faithfully copy C# `.lscache` content (project-system output) only.** The project-system layer *is* adopted (it is what makes the cache `.rsp`-independent). What C# does not have, and G# adds, is the reference-metadata type-name index — G#'s actual cold bottleneck.
- **Keep depending on the `.rsp` (original design).** Rejected: the `.rsp` is a gitignored `obj/` artifact that does not survive clean/clone, so a cache fingerprinted on it is useless in exactly the scenarios a cold-start cache is for.
- **Cache the resolved `Type` index directly.** Impossible: `Type` objects are bound to a live `MetadataLoadContext` and cannot be serialized or rehydrated across processes. Caching the *names* and re-materializing lazily is the load-context-safe equivalent.
- **Store the type-name index as a sibling binary blob.** Rejected on the measured numbers: text is 4.2 ms / 1342 KB vs binary 2.2 ms / 1342 KB — same size, ~2 ms apart, both negligible vs the ~120 ms enumeration — and a single `*.lscache` is the standard, lower-friction gitignore entry. The earlier "text too large/slow" exception was false and is retracted.
- **Eagerly materialize every cached name on load.** Rejected: resolving all ~25 000 names up front (~370 ms) is *slower* than the eager `GetTypes()` build it replaces. The win comes precisely from materializing lazily only the names the binder probes.
- **Cache the bound program now.** Rejected for this pass: highest value but highest risk (symbol-graph determinism, load-context-bound types, IL-equivalence gate). Designed above as Phase 2, gated on ADR-0105 stable identity.

## Acceptance criteria (from issue #868)

- An ADR proposing a cold-start cache design — what is persisted, the fingerprint/invalidation scheme, where files live, and whether they are committable: this document.
- Determinism: a loaded cache yields identical analysis/diagnostics to a from-scratch run — verified by equivalence tests and the Oahu run (identical diagnostics).
- No stale results across source edits, reference changes, or compiler-version changes — the conservative, `.rsp`-independent fingerprint invalidates on each, with cold build (and, for references, the empty/degraded path) as the safe fallback.
- Survives clean / fresh clone: with the `.rsp` gone, the cache bootstraps the reference set so imported types still resolve.
