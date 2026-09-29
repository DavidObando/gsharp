---
title: "go2gs typed inventory"
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

M0 does not emit G#, perform semantic lowering, run a migrated program, or
provide a Go runtime compatibility layer. See
[ADR-0191](../../docs/adr/0191-go-to-gsharp-migration-tool.md) and the
[implementation README](https://github.com/DavidObando/gsharp/tree/main/tools/go2gs)
for the full profile and validation contract.
