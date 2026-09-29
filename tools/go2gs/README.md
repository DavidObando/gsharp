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
diagnostics that were available.

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

If the exact source and Go executable are not present, the command writes a
deterministic actionable blocker and exits nonzero. It never downloads or
substitutes a newer toolchain.
