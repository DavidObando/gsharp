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

Linux tests probe the private mount-namespace and read-only tmpfs capability.
Hosted sandboxes that deny those mount operations skip only the successful
capsule and host-path attack tests; an unprivileged fail-closed test still
requires capsule creation to stop before staging an executable. Privileged
Linux runs execute the full adversarial suite.

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
diagnostics that were available. Profile, output, and toolchain bootstrap failures—including a missing `go`
executable, unusable GOROOT, or dynamically linked Linux `cmd/go`—exit 2 and
may produce no artifact.

M0 also records migration blockers without making a complete inventory fail.
Typed nil/interface values, byte strings, maps, panic/defer/recover, fixed
value arrays, and concurrency sites are linked to typed syntax nodes and
marked as explicit M1 prerequisites. M0 chooses no G# representation or
runtime API for them. Every blocker message is path-redacted, normalized to
valid UTF-8, and bounded by `maxStringBytes` before its stable ID,
deduplication, record count, ordering, and publication. The ID therefore
identifies the exact published message rather than an unbounded private
diagnostic. Redaction matches complete path components, prefers the most
specific nested root, and recognizes case- and separator-equivalent Windows
drive and UNC paths without rewriting unrelated message text. Non-`file:`
URIs are never interpreted as filesystem paths. Absolute Unix, Windows-drive,
case-insensitive `localhost`, drive-authority, and configured UNC `file:` URIs
redact their path roots. Unknown authorities, percent-encoded or relative
non-drive forms, and ambiguous noncanonical separator counts are not decoded
or guessed and collapse to `file:<private-path>`. Absolute drive paths redact
with zero, one, or three separators after `file:`; unmatched drive-shaped
paths fail closed. Any `.` or `..` path component, encoded form, invalid byte,
raw whitespace, misplaced drive component, or unexpected ASCII/Unicode
punctuation also collapses the complete URI. Path components accept ASCII
letters, digits, `-._~`, and normal Unicode letters/numbers only; a drive
component is valid only as the first component or immediately after
`localhost` when that name was parsed as the authority of an exactly
two-separator `file://localhost/...` form. Recognized quote/bracket wrappers
terminate the URI so an adjacent path is sanitized separately. A query is
retained only as unique, nonempty `key=value` pairs separated by one `&`;
keys and values must start and end with an ASCII letter or digit and may
contain `-._~` internally, but cannot equal `.` or `..`. A fragment is one
token under the same rule. Key-only, empty, duplicate, repeated-delimiter,
Unicode, path-like, and otherwise ambiguous suffixes fail closed.

The profile is exact and versioned. M0 accepts offline `readonly` or `vendor`
module modes only, forces `GOTOOLCHAIN=local`, `GOPROXY=off`,
`GOSUMDB=off`, `GOWORK=off` unless a later version adds an explicit workspace,
and disables `GOPACKAGESDRIVER`. The child environment is allowlisted rather
than inherited wholesale. Before profile decoding and before its configured
timeout exists, the profile must be a stable regular file of at most 256 KiB;
symlinks, replacement, growth, and larger inputs fail bootstrap without an
artifact. Profile `entryPatterns` are restricted to `.`,
`./...`, or canonical module-relative `./segment[/segment]` patterns,
optionally ending in `/...` for recursion.
Segments use ASCII letters, digits, `.`, `_`, or `-`; no normalization is
performed. Absolute paths, backslashes, traversal, query forms such as
`file=`, URI/drive/UNC forms, bare `std`/`cmd`/`all` meta-patterns, whitespace,
control characters, and any other `go/packages` operator syntax are rejected
before either package-load phase.
The selected `go` executable's build metadata supplies its version. Its
`GOROOT` is derived from the verified executable path or the parent's verified
handoff, and the bounded `VERSION` file is hashed. Bootstrap never runs
`go version` or `go env`. `goFlags` accepts only `-tags`, `-trimpath`, and
`-buildvcs=false`; execution and path override flags such as `-toolexec`,
`-overlay`, and `-modfile` are rejected. Profile `buildTags` and allowed
`goFlags -tags` values are merged into one canonical tag set used by package
loading and in-process source classification. Architecture feature values are
validated per GOARCH and expanded to cmd/go's cumulative tool tags.
`goExperiment` and `goDebug` must be
empty because the in-process parser and type checker cannot authoritatively
apply selected-toolchain semantic overrides.
Before loading, source inputs and authorized local replacements are copied
with bounded, descriptor-relative reads that reject symlinks in every path
component into a private mirror. Directory enumeration reads at most 128
entries per batch and fails before sorting above 10,000 entries in one
directory or 100,000 traversed entries total across the source and selected
local replacements. Every file, directory, symlink, and other entry consumes
that traversal budget independently of the captured-file limit. The same
rooted reads verify the originals after loading. The loader sees only those
captured bytes; emitted manifest hashes remain those of the originals.
Only an operational mirrored `go.mod` that needs local-replacement rebinding is
made owner-writable; the source manifest and unrelated mirrored files retain
their captured permissions.
Output locking, stale-artifact invalidation, and atomic publication stay
relative to one held directory descriptor/handle, so replacing an output-root
ancestor cannot redirect owned output operations. The selected output directory
must remain under go2gs's exclusive control until the command exits. The lock
excludes cooperating invocations, and observed identity drift fails closed;
an actively mutating same-UID peer with equal filesystem authority is outside
M0's portable threat boundary. Hashes and schema validation detect provenance
drift but do not authenticate or mediate that peer.
Atomic writers flush and close staged files before rename. Unix-like platforms
then sync the parent directory; Windows reopens the final file with write
access, verifies its handle identity, flushes it, applies the requested
read-only attribute, closes that handle, and reopens read-only to verify the
published identity rather than treating a denied directory-handle sync as
success.
On Linux and macOS, private temporary trees are removed recursively through
verified directory descriptors and atomic name exchanges without following
links; disappearance and changed-to-symlink races are tolerated, while
permission and other persistent open failures, an exchange failure, or a
retained entry make the command fail. Windows
uses held-root, handle-relative renaming and recursive removal without
following reparse points. Platforms without a secure cleanup implementation
reject private temporary-directory creation before copying executables or
source snapshots.

Complete public `analyze` is supported only on Linux. Windows and macOS still
secure and lock the output, invalidate stale owned artifacts, capture native
`cmd/go` without executing it, mirror source/manifests, and publish deterministic
exit-1 artifacts for definitive toolchain or source-provenance mismatches. A
matching preload reaches the unsupported secure-execution binding and exits 2
without an artifact. It never calls `go/packages`. Targets without secure
temporary cleanup reject private temporary-tree creation before copying into
it; non-Unix/non-Windows fallback targets also reject output-root creation
before mutation.

The parent captures the selected native `cmd/go` into a bootstrap capsule only
for handoff. On Linux the captured bytes must be a supported ELF executable or
static PIE with no `PT_INTERP`, imported libraries or imported dynamic symbols,
`DT_RPATH`, or `DT_RUNPATH`; this check completes before any execution. Every
analysis worker runs in a private user and mount namespace,
applies a 2 GiB `RLIMIT_DATA` ceiling before either package load,
captures that handoff by expected SHA-256, and copies only `go` into a read-only
tmpfs. The worker holds the tmpfs directory descriptor and gives both process
`PATH` and `packages.Config.Env` the descriptor path
`/proc/<worker-pid>/fd/<dir-fd>`. Both package-load phases therefore execute the
worker's immutable object, not the original selected path or parent bootstrap
pathname. Scripts, wrappers, ambient sibling tools, and pathname replacement
are rejected or unreachable.
Darwin preload likewise requires a native executable Mach-O with the matching
CPU; foreign formats and non-executable Mach-O files are rejected.

M0 uses `go/packages` only for metadata with `CGO_ENABLED=0` and without
compiled-file or export requests. It parses the captured source and runs the
standard-library Go type checker in-process, so it never executes the GOROOT
compiler, assembler, linker, cgo, vet, a C/C++ compiler, pkg-config, or helpers.
`cCompiler` and `cCompilerHelpers` remain profile-v1 compatibility fields only:
they must be empty. Before preload or package loading, the selected `cmd/go`
build-info version, bounded captured `GOROOT/VERSION`, and helper
runtime/build-info version must self-report the same canonical final-release
Go version label. These labels are provenance metadata, not authentication;
the executable and captured-content hashes are the authoritative identities.
Unsupported, missing, or contradictory labels fail bootstrap without an artifact. Helpers built
with nonempty `GOEXPERIMENT` or `DefaultGODEBUG` semantic overrides are also
rejected. A requested version mismatch remains an inventory blocker only after
that agreement succeeds. When `cgoEnabled` requests CGo selection, go2gs independently applies Go
file/build-tag selection to the immutable source mirror, records selected CGo,
native, assembly, and reachable header inputs, and emits deterministic
`cgo`/`native` blockers. Active `#cgo pkg-config:` directives are parsed from
selected source and emit a `pkg-config` blocker without running pkg-config;
inactive directives do not block.
Directory drift checks cover every package-input extension recognized by the
pinned Go build rules regardless of whether CGo is enabled; CGo selection only
decides which captured native inputs are active.
Source commit provenance is read directly from bounded `.git` metadata; the
analyzer never discovers or executes an ambient `git` command.

Package records preserve both the exact typed-source order and the execution
order of variable initializers followed by `init` functions. Diagnostic
positions use portable source/module/GOROOT identities. Schema validation
reparses captured bytes to verify raw and line-directive-adjusted paths, lines,
and columns exactly. It
requires the complete v1 handshake, mandatory fields and collections, exact
record counts, valid references, and loaded main-module package/file ownership
before `inventoryComplete` may be true. `validate-analysis` checks structural
and relational consistency, including recomputing every deterministic record
ID whose schema-v1 derivation is fully represented by the serialized payload
(module, file, type, node, constant, scope, selection, call, method set,
instance, embed, generate directive, dependency, feature, diagnostic, and
blocker). Package and symbol IDs retain canonical loader/type ownership inputs
that are not duplicated into their records and remain covered by uniqueness,
reference, and ownership checks. Validation does not authenticate the recorded
binaries or captured content.
Compiled Go file records use the type checker's effective
`types.Info.FileVersions` value, including a selected `go1.N` build constraint;
non-syntax inputs retain the module language-version fallback. Structural type
identities include the positional package ownership of unexported anonymous
struct fields and interface methods.

## Validate an inventory

```sh
artifacts/go2gs/go2gs validate-analysis \
  --analysis artifacts/go2gs/analysis/analysis.json
```

Validation rejects unknown schema versions, unknown required record kinds,
stale payload-derived IDs, duplicate IDs, dangling references, and inconsistent
complete/ready states.
It accepts only a regular file whose opened identity and pre-read size are
verified beneath a 512 MiB (536870912 byte) ceiling; growth beyond that bound
is also rejected while reading. Profiles cannot configure `maxOutputBytes`
above the same deterministic validation ceiling.

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
