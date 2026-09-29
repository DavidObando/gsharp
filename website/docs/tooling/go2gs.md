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

Analysis is offline and fail-closed. It disables automatic Go toolchain
downloads, network module resolution, ambient workspaces, unapproved package
drivers, generators, and target execution. Exit zero means only that the
requested inventory completed. M0 always reports `migrationReady: false`.
The selected Go executable supplies the verified GOROOT. Profile `goFlags`
are allowlisted; tool execution and path overrides are rejected.
Profile, output, and toolchain bootstrap failures—including a missing `go`
executable or unusable GOROOT—exit 2 and may produce no artifact. Once
bootstrap succeeds, exact-version or source-commit mismatches produce an
incomplete artifact and exit 1.
The selected Go executable is captured and staged under the canonical `go` or
`go.exe` name. Child `PATH` contains only private staged directories, never the
selected executable's original parent directory or its mutable siblings.
Profiles enabling CGo must set `cCompiler` to an absolute, explicitly approved
compiler executable. go2gs hashes that compiler and records its name and hash.
Every compiler executable helper, including internal drivers such as GCC's
`cc1` and PATH-resolved assembler/linker tools, must also be explicitly listed
in `cCompilerHelpers` by logical name, canonical absolute path, and SHA-256.
go2gs captures those bounded regular executables without following links,
stages only the captured bytes in a private directory used for both `PATH` and
GCC's `-B` executable prefix, records their
hashes, sizes, and executable modes, and detects source or staged-copy drift.
On Linux, Go, the compiler, and helpers execute from a read-only private tmpfs
addressed through a held directory descriptor, so a host-visible pathname swap
cannot replace them transiently. CGo fails closed on platforms without that
identity-binding mechanism. Source executable directories and ambient PATH are
never exposed. Helper names use a host-independent portable executable grammar
and reject Windows aliases, device names, ADS syntax, and reserved tool names.
Active `#cgo pkg-config:` directives fail closed because M0 does not model or
approve pkg-config; directives inactive under the selected build constraints
are ignored.
Commit provenance is read directly from bounded repository metadata rather
than by discovering or executing an ambient `git` command.
Source inputs and authorized local replacements are loaded from a private,
bounded no-follow mirror, so loader semantics and emitted inventory bytes
come from the same captured snapshot.

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
