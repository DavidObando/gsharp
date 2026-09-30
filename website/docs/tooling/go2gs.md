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
selected executable's original parent directory or its mutable siblings. The
captured bytes must identify as a native `cmd/go`; scripts and wrappers are
rejected before execution.

M0 forces `CGO_ENABLED=0` for every `go/packages` load and never executes cgo,
a C/C++ compiler, linker, assembler, pkg-config, or helper. Profile-v1
`cCompiler` and `cCompilerHelpers` fields are accepted only when empty.
Requested CGo selection is instead classified from the immutable source mirror
with Go build constraints and file naming rules. Selected CGo files, native
sources, assembly, and reachable headers are recorded with deterministic
`cgo`/`native` blockers. Active `#cgo pkg-config:` directives are parsed from
source and block without executing pkg-config; inactive directives are ignored.
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
