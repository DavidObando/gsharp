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
or guessed; unmatched drive-shaped paths also fail closed. Absolute drive
paths redact with zero, one, or three separators after `file:`. Query and
fragment text is retained only under a path-incapable grammar. Queries require
unique nonempty `key=value` pairs separated by one `&`; fragments are one
nonempty token. Every token starts and ends with an ASCII letter or digit, may
use `-._~` internally, and cannot equal `.` or `..`. Exact dot path
components, raw whitespace, misplaced drive components, unexpected ASCII or
Unicode punctuation, path separators, percent encoding, controls, Unicode
suffixes, key-only or empty parameters, duplicate keys/delimiters, and other
ambiguous bytes collapse the complete URI to `file:<private-path>`. Path
components otherwise allow ASCII letters, digits, `-._~`, and ordinary
Unicode letters/numbers. Recognized wrappers end the URI so an adjacent path
is sanitized independently; malformed unwrapped tails are consumed and fail
closed. A drive after `localhost` is accepted only when `localhost` is the
actual authority of an exactly two-separator `file://localhost/...` form, not
an ordinary path component. The published bounded message is therefore the
message the ID names.

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
executable or static PIE with no interpreter, imported libraries or imported dynamic
symbols, RPATH, or RUNPATH. The Linux worker then enters a private user and mount namespace,
applies a 2 GiB `RLIMIT_DATA` ceiling before either package load,
recaptures the handoff by expected SHA-256, and places only `go` in a read-only
tmpfs. It holds the directory descriptor and sets both process `PATH` and
`packages.Config.Env` `PATH` to `/proc/<worker-pid>/fd/<dir-fd>`. Both package
loads therefore execute the worker's immutable object and do not depend on the
original path, bootstrap pathname, or ambient sibling tools after launch.
Darwin preload requires a native executable Mach-O for the host CPU and rejects
foreign formats or non-executable Mach-O file types.

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
Only the mirrored operational `go.mod` is made owner-writable when replacement
paths must be rebound; source permissions and unrelated mirrored files remain
unchanged. Compiled-file records use `go/types`' effective per-file language
version, and structural identities retain positional package ownership for
unexported anonymous fields and interface methods.
Schema validation permits `inventoryComplete: true` only when the artifact
contains a loaded main module, package, owned source files, and typed-file
ownership; blocker-free preload artifacts are rejected. Validation reparses
captured bytes to verify raw and `//line`/`/*line*/` display coordinates,
including columns and CRLF handling. It checks
artifact structure and relationships. It recomputes deterministic IDs for the
module, package, file, type, node, constant, scope, selection, call, method-set,
instance, embed, generate-directive, dependency, feature, diagnostic, and
blocker records whose identity inputs are fully serialized. Package identity
combines the semantic profile, including the authoritative GOROOT/toolchain
identity, with the serialized module/replacement identity, import path, and
test variant. Type identity combines that profile discriminator
with the canonical Go identity, preserving within-profile cross-package
deduplication without cross-profile aliasing. Symbol identities still depend on
canonical type-ownership inputs not duplicated into their records, so validation
instead enforces their uniqueness, references, and ownership. Schema-v1 file
roles are limited to `compiled`, `active`, `test`, `ignored`, `native`,
`embed`, and `method-authority`, with exact native/embed flag agreement;
`compiled` role must exactly match membership in the owning package's
`compiledFileIds`, and authority-only dependency source must match its owning
package's `methodAuthorityFileIds`. Compiled sources selected by `go:embed`
retain the `compiled` role and are also linked by embed records.
Serialized syntax nodes must belong to compiled files, and each node-bearing
file must be one parent-linked `*ast.File` tree without detached nodes or
cycles. Incomplete artifacts may omit trees; complete artifacts require one for
every compiled file. These checks do not authenticate recorded executables or
content.

Typed nil/interface values, byte strings, maps, panic/defer/recover, fixed
value arrays, and concurrency are inventoried as typed syntax sites with
migration blockers. M0 does not select their G# lowering or runtime representations.

### Proposed direction: stronger G# and maintainable output

Semantic fidelity and readable, maintainable G# are joint requirements. There is no deadline for first runnable M1. Existing native facilities remain the starting point, but reusable additive language, type-system and runtime design is a first-class route when it improves the result. A passing translation should not leave applications with a Go-prefixed wrapper ecosystem, visible dispatch tables or manual boxing/checking protocols at ordinary operations. Hidden compiler machinery is different from application code; narrow Go-specific policies may still need compatibility support.

The general-purpose `bytestring` capability holds immutable arbitrary bytes, including invalid UTF-8 and embedded zeros. ADR-0204's core and native literals are implemented in development; explicit encoding/scalar APIs, a published SDK and separate N-1 adoption are still outstanding. This is not a UTF-8-validity promise, an alias for a readonly slice or permission for go2gs to emit unsupported APIs. G# `string` remains CLR `System.String`, even when Go bytes happen to be valid UTF-8. Mutable inputs are copied. Byte-content equality, byte offsets and non-null default empty differ from native slice descriptors.

The byte-string proposal is now a separate entry in the [design decisions](../design-decisions.md) index. It compares handwritten protocol, tokenizer and fuzzy-style examples, proposes integrated spelling and exact-byte literals alongside a nominal runtime type, and specifies copying, substring retention and explicit encoding policies. These remain design choices under review, not commands or APIs available to a migration today.

Encoding policies remain explicit: Go decoding advances one byte for invalid UTF-8, and encoding invalid Go rune values produces replacement characters. Go `rune` stays unrestricted `int32`, not `System.Text.Rune`; decoded `slice[int32]` is algorithm data. Concrete integers, native `slice[T]`/`slice[T]?` and existing factories such as `slice[T].Create` remain the intended building blocks, not public integer/index/slice wrappers or a revived `make` builtin. Source-width checks, nil/empty distinctions and evaluation order still need proof. Repeated scaffolding is a reason to evaluate a reusable capability, not to weaken those semantics.

**A public `GoInterface` is not the selected output contract.** The earlier envelope sketch recorded observations that ordinary CLR interfaces and `adapt` do not automatically supply: nil versus typed nil, original dynamic type across views, dynamic method-set assertions, insertion snapshots and copies on each value-receiver call. The new design track compares opt-in interface-value facilities, compiler-supported type evidence and hidden boxing/forwarding. It must justify useful handwritten G# operations, not rename a Go runtime. Ordinary interfaces, `adapt` wrapper identity, struct mutation and BCL interop keep their existing behavior. Type spelling, representation, conversions and metadata require separate decisions.

Fixed value arrays likewise need a reusable design, not permanent shape-specific helpers. Existing G# `[N]T` remains CLR-array-backed. Stereo and ten-element Go arrays are useful proofs for copying, equality, checked indexing and nested writes; they do not settle new syntax or layout. Views and escaping element locations stay blocked until their storage/lifetime contracts are proved.

**G# already supports goroutines, channels and `select`.** Their separate go2gs admission is a mapping/evidence decision, not missing native concurrency. Remaining obligations include caller-side launch evaluation, free versus structured-scope lifetime/join behavior, per-goroutine panic/recovery isolation, suspension through callable/callback boundaries, and channel/select/publication witnesses. The design reuses native concurrency; it does not propose a new scheduler. Maps, defer/recover and iterator control effects also need explicit designs, separating reusable facilities from Go-specific rules.

Capability tracks may precede and determine migration milestones. Each language change needs its own accepted design, implementation and release; repository source waits for the separate N-1 SDK-pin update. A small text/value corpus remains a useful proving ground after its chosen capabilities are available, not a schedule forcing helper-heavy architecture. Interfaces/locations/captures, arrays and concurrency are independently admitted families; unused features are not prerequisites for that corpus. The first full package target remains pinned cliamp's `internal/fuzzy`, followed by `internal/tomlutil` and `internal/deeplink`; none is claimed as migrated.

Every admitted family still requires deterministic source/maps, translate-and-reparse, compilation, IL verification and independent unchanged-Go versus generated JIT/NativeAOT witnesses. Unsupported or unavailable stages are not green; semantic completion, verification and performance readiness remain separate. Later capability contracts will be versioned separately from M0 schema/profile v1 and will not change its `migrationReady: false`.

### Implemented boundary

Schema v1 preserves compiled-file and package-initialization order and rejects
missing fields, null collections, count mismatches, stale payload-derived IDs,
and dangling identities.

M0 does not emit G#, perform semantic lowering, run a migrated program, or
provide a Go runtime compatibility layer. See
[ADR-0191](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0191-go-to-gsharp-migration-tool.md) and the
[implementation README](https://github.com/DavidObando/gsharp/tree/main/tools/go2gs)
for the full profile and validation contract.
