# go2gs M0 typed inventory

`go2gs analyze` is the M0 Go frontend from
[ADR-0191](../../docs/adr/0191-go-to-gsharp-migration-tool.md). It loads a
profile-selected package graph through the pinned Go helper, records an
immutable schema-v1 typed inventory, and fails closed when the requested
toolchain or graph is unavailable.

M0 does **not** emit G#, lower Go semantics, execute target programs or tests,
run `go generate`, provide a Go compatibility runtime, or claim that an
inventory is migration-ready.

## Build and test

```sh
cd tools/go2gs
go build -o ../../artifacts/go2gs/go2gs .
go test -count=1 ./...
```

The helper pins `golang.org/x/tools` in `go.mod`. Tests use local modules and
must pass with no network.

## Analyze

```sh
artifacts/go2gs/go2gs analyze \
  --source /path/to/go/module \
  --profile tools/go2gs/profiles/cliamp-m0.json \
  --out artifacts/go2gs/analysis
```

Outputs:

- `analysis.json`: deterministic semantic inventory. It contains no run
  timestamp, absolute cache path, or process-pointer identity.
- `run.json`: non-semantic measurements for the isolated run (cold load,
  peak RSS, interchange size, and counts). M0 intentionally does not label a
  second cache-influenced load as a meaningful warm measurement.

Exit zero means `inventoryComplete: true`; it does not mean
`migrationReady: true`. Loader, toolchain, checksum, source-identity, CGo,
native-input, and resource-limit failures are nonzero while preserving any
diagnostics that were available. Profile, output, and toolchain bootstrap
failures—including a missing `go` executable or unusable GOROOT—exit 2 and
may produce no artifact.

M0 also records migration blockers without making a complete inventory fail.
Typed nil/interface values, byte strings, maps, panic/defer/recover, fixed
value arrays, and concurrency sites are linked to typed syntax nodes and
marked as explicit M1 prerequisites. M0 chooses no G# representation or
runtime API for them.

The profile is exact and versioned. M0 accepts offline `readonly` or `vendor`
module modes only, forces `GOTOOLCHAIN=local`, `GOPROXY=off`,
`GOSUMDB=off`, `GOWORK=off` unless a later version adds an explicit workspace,
and disables `GOPACKAGESDRIVER`. The child environment is allowlisted rather
than inherited wholesale. The selected `go` executable's own canonical
`GOROOT` is resolved before isolation and used for loading. `goFlags` accepts
only `-tags`, `-trimpath`, and `-buildvcs=false`; execution and path override
flags such as `-toolexec`, `-overlay`, and `-modfile` are rejected. The only
accepted `goDebug` key is `gotypesalias`, with value `0` or `1`.
Before loading, source inputs and authorized local replacements are copied
with bounded, no-follow reads into a private mirror. The loader sees only
those captured bytes; emitted manifest hashes remain those of the originals.
On Linux and macOS, private temporary trees are removed recursively through
verified directory descriptors and atomic name exchanges without following
links; an exchange failure or retained entry makes the command fail. Other
platforms intentionally leave non-empty private trees behind rather than risk
deleting a path that another process replaced.

The selected Go executable is captured with a bounded no-follow read and
required by Go build metadata to identify itself as native `cmd/go`, then
staged under the canonical `go` or `go.exe` name. Scripts, interpreted
wrappers, and native delegate wrappers are rejected before execution. Child
`PATH` contains only the private staged Go directory; the selected executable's
original parent directory and its siblings are never exposed.

M0 always invokes `go/packages` with `CGO_ENABLED=0`. It never executes a C/C++
compiler, linker, assembler, cgo, pkg-config, or helper. `cCompiler` and
`cCompilerHelpers` remain profile-v1 compatibility fields only: they must be
empty. When `cgoEnabled` requests CGo selection, go2gs independently applies Go
file/build-tag selection to the immutable source mirror, records selected CGo,
native, assembly, and reachable header inputs, and emits deterministic
`cgo`/`native` blockers. Active `#cgo pkg-config:` directives are parsed from
selected source and emit a `pkg-config` blocker without running pkg-config;
inactive directives do not block.
Source commit provenance is read directly from bounded `.git` metadata; the
analyzer never discovers or executes an ambient `git` command.

Package records preserve both the exact compiled-file order and the execution
order of variable initializers followed by `init` functions. Diagnostic
positions use portable source/module/GOROOT identities. Schema validation
requires the complete v1 handshake, mandatory fields and collections, exact
record counts, and valid references.

## Validate an inventory

```sh
artifacts/go2gs/go2gs validate-analysis \
  --analysis artifacts/go2gs/analysis/analysis.json
```

Validation rejects unknown schema versions, unknown required record kinds,
duplicate IDs, dangling references, and inconsistent complete/ready states.

## cliamp smoke

The checked-in profile pins:

- source commit `4dee32c6c967cb2cc6069196e40cd3ff397deb3f`;
- requested Go `1.26.6`;
- `darwin/arm64`, tests enabled, CGo disabled, workspace disabled, and
  offline read-only modules.

Run:

```sh
artifacts/go2gs/go2gs analyze \
  --source /Users/davidobando/GitHub/DavidObando/cliamp \
  --profile tools/go2gs/profiles/cliamp-m0.json \
  --out artifacts/go2gs/cliamp
```

After bootstrap succeeds, an exact-version or source-commit mismatch writes a
deterministic actionable blocker and exits 1. A missing or unusable Go
executable is a bootstrap failure: it exits 2 and may produce no artifact.
The helper never downloads or substitutes a newer toolchain.
