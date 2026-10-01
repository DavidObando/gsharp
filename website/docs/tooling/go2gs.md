---
title: "go2gs typed inventory"
description: "Analyze Go packages into a deterministic, typed migration inventory without generating G# code."
---

# go2gs typed inventory

The first `go2gs` milestone is an analysis-only frontend for Go migration
work. It uses Go's parser, type checker, exact-constant model, and the pinned
`golang.org/x/tools/go/packages` loader to write deterministic
`analysis.json` schema v1.

```sh
cd tools/go2gs
go build -o ../../artifacts/go2gs/go2gs .
go test -count=1 ./...

../../artifacts/go2gs/go2gs analyze \
  --source /path/to/module \
  --profile profiles/cliamp-m0.json \
  --out ../../artifacts/go2gs/analysis
```

The inventory records the selected module/package/test graph, active and
ignored inputs, source bytes and positions, stable symbol/type/node
identities, exact constants, scopes, selections, calls, method sets, generic
instances, embeds, `go:generate` directives, dependencies, diagnostics, and
blockers. `run.json` separately records non-deterministic measurements.
Blocker messages redact private source, mirror, replacement, temporary, and
output roots and are normalized and bounded before their stable IDs are
derived. Redaction observes complete path boundaries, prefers nested roots, and
recognizes Windows drive/UNC case and separator aliases. Remote URIs remain
unchanged; absolute, `localhost`, drive-authority, and configured UNC `file:`
URI paths are redacted. Unknown authorities, encoded or relative forms, and
ambiguous noncanonical separator counts fail closed rather than being decoded
or guessed. The published bounded message is therefore the message the ID
names.

Analysis is offline and fail-closed. It disables automatic Go toolchain
downloads, network module resolution, ambient workspaces, unapproved package
drivers, generators, and target execution. Exit zero means only that the
requested inventory completed. M0 always reports `migrationReady: false`.
The selected Go executable's build metadata supplies its version. Its verified
path or parent handoff supplies GOROOT, whose bounded `VERSION` file is hashed;
bootstrap does not run `go version` or `go env`. Profile `goFlags` are
allowlisted; tool execution and path overrides are rejected. Profile
`buildTags` and `goFlags -tags` values are merged into one canonical tag set
used by package loading and in-process source classification.
Architecture feature values are validated per GOARCH and expanded to cmd/go's
cumulative tool tags.
`goExperiment` and `goDebug` must be empty because the in-process semantic
engine cannot authoritatively apply selected-toolchain overrides.
Before decoding and before the configured timeout exists, the profile must be
a stable regular file of at most 256 KiB. Oversized, growing, replaced,
symlink, and non-regular profile inputs fail bootstrap without an artifact.
Profile, output, and toolchain bootstrap failures—including a missing `go`
executable, unusable GOROOT, or dynamically linked Linux `cmd/go`—exit 2 and
may produce no artifact. Exact-version or source-commit mismatches produce an
incomplete artifact and exit 1.
Complete public `analyze` is supported only on Linux. Non-Linux platforms
secure and invalidate the output first, then run only the preload checks. A
definitive toolchain/source mismatch publishes a deterministic exit-1 artifact
without `go/packages`; a matching preload exits 2 without an artifact because
the required descriptor-bound launch cannot be provided securely.
Source and local-replacement capture and verification use descriptor-relative
reads that reject symlinks in every path component. Enumeration uses
128-entry batches and fails before sorting above 10,000 entries in one
directory or 100,000 traversed entries total across the source and selected
local replacements. Files, directories, links, and other entries all consume
that traversal budget separately from the captured-file limit.
Output locking, stale-artifact invalidation, and atomic publication remain
relative to one held directory descriptor/handle, so replacing an output-root
ancestor cannot redirect them. Keep the selected output directory exclusively
controlled by go2gs until the command exits. The lock excludes cooperating
invocations, and observed identity drift fails closed. An actively mutating
same-UID peer with equal filesystem authority is outside M0's portable threat
boundary; hashes and schema validation detect provenance drift but do not
authenticate or mediate that peer.

The selected native `cmd/go` is captured into a parent bootstrap capsule only
for handoff. Linux first validates the captured bytes as a supported static ELF
executable or static PIE with no interpreter, imported libraries or dynamic
symbols, RPATH, or RUNPATH. The Linux worker then enters a private user and mount namespace,
recaptures the handoff by expected SHA-256, and places only `go` in a read-only
tmpfs. It holds the directory descriptor and sets both process `PATH` and
`packages.Config.Env` `PATH` to `/proc/<worker-pid>/fd/<dir-fd>`. Both package
loads therefore execute the worker's immutable object and do not depend on the
original path, bootstrap pathname, or ambient sibling tools after launch.

M0 uses `go/packages` only for metadata with `CGO_ENABLED=0` and no compiled
file or export request. Captured source is parsed and type-checked in-process,
so the GOROOT compiler, assembler, linker, cgo, vet, C/C++ compilers,
pkg-config, and helpers are never executed. Profile-v1 `cCompiler` and
`cCompilerHelpers` fields are accepted only when empty.
The selected `cmd/go` build-info version, bounded captured `GOROOT/VERSION`,
and helper runtime/build-info version must self-report the same canonical
final-release Go version label before preload or package loading. These labels
are provenance metadata, not authentication; executable and captured-content
hashes are the authoritative identities. All three labels are recorded and
schema validation requires relational consistency. Unsupported, missing, or
contradictory labels fail bootstrap without an artifact, as do helpers built with nonempty
`GOEXPERIMENT` or `DefaultGODEBUG` semantic overrides.
Requested CGo selection is instead classified from the immutable source mirror
with Go build constraints and file naming rules. Selected CGo files, native
sources, assembly, and reachable headers are recorded with deterministic
`cgo`/`native` blockers. Active `#cgo pkg-config:` directives are parsed from
source and block without executing pkg-config; inactive directives are ignored.
Directory drift checks cover every package-input extension recognized by the
pinned Go build rules regardless of whether CGo is enabled; CGo selection only
decides which captured native inputs are active.
Commit provenance is read directly from bounded repository metadata rather
than by discovering or executing an ambient `git` command.
Source inputs and authorized local replacements are loaded from a private,
bounded no-follow mirror, so loader semantics and emitted inventory bytes
come from the same captured snapshot.
Schema validation permits `inventoryComplete: true` only when the artifact
contains a loaded main module, package, owned source files, and typed-file
ownership; blocker-free preload artifacts are rejected. Validation reparses
captured bytes to verify raw and `//line`/`/*line*/` display coordinates,
including columns and CRLF handling. It checks
artifact structure and relationships, not the authenticity of recorded
executables or content.

Typed nil/interface values, byte strings, maps, panic/defer/recover, fixed
value arrays, and concurrency are inventoried as typed syntax sites with
migration blockers. Their G# lowering and runtime representations are explicit
M1 prerequisites and are not selected by M0.

Schema v1 preserves compiled-file and package-initialization order and rejects
missing fields, null collections, count mismatches, and dangling identities.

M0 does not emit G#, perform semantic lowering, run a migrated program, or
provide a Go runtime compatibility layer. See
[ADR-0191](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0191-go-to-gsharp-migration-tool.md) and the
[implementation README](https://github.com/DavidObando/gsharp/tree/main/tools/go2gs)
for the full profile and validation contract.
