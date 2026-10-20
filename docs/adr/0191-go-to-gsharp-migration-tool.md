# ADR-0191: go2gs - a typed Go-to-G# migration and fidelity pipeline

- **Status**: Proposed
- **Date**: 2026-09-19
- **Phase**: M0 implemented; proposed, staged M1 lowering contracts
- **Issue**: [#4333](https://github.com/DavidObando/gsharp/issues/4333)
- **Related**: [ADR-0115](0115-csharp-to-gsharp-migration-tool.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md)
  ([#4328](https://github.com/DavidObando/gsharp/issues/4328)),
  [ADR-0188](0188-heap-storable-managed-references.md)
  ([#4330](https://github.com/DavidObando/gsharp/issues/4330)),
  [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md)
  ([#4329](https://github.com/DavidObando/gsharp/issues/4329)),
  [ADR-0174](0174-goroutines-and-channels-wave-2.md),
  [ADR-0182](0182-receiver-clause-is-always-extension.md)
- **Dependency status**: ADRs 0190, 0188, and 0189 are Accepted and
  implemented. The paired
  [prerequisite viability spike](../../bench/go2gs-prerequisites/README.md)
  confirms the covered semantics. Performance fixes #4511 and #4512 are
  implemented; the approved #4513 policy defines translator and workload gates
  before application-scale performance readiness is claimed.
  Their implemented native surface is not proof of Go compatibility.
  This ADR neither accepts nor changes them.
- **Implementation status**: M0 typed inventory is implemented under
  [`tools/go2gs`](../../tools/go2gs/README.md) with schema/profile version 1
  (PR #4562, merged October 19, 2026).
  It provides `analyze` and analysis validation only. Translation, lowering,
  compatibility support, and runtime validation remain later milestones.
  Typed nil/interface values, byte strings, maps, panic/defer/recover, fixed
  value arrays, and concurrency are inventoried with migration blockers; their
  G# lowering/runtime representations gate their respective M1 families.
  Schema v1 always reports `migrationReady: false`. Complete public analysis
  requires Linux with the secure user/mount namespace and read-only tmpfs
  facilities described by the implementation README, not merely a Linux host.
  macOS and Windows preload failure reporting is not successful analysis.

## Context

The requested tool should mechanically migrate real Go programs into
maintainable G#, with cliamp as an eventual application-scale gate, in the
same spirit as cs2gs. Similar surface syntax is not sufficient: Go values,
aliasing, initialization, interface identity, byte strings, and concurrency
have observable contracts that differ from CLR defaults.

The original September 19 design used `dd7622098` plus proposal commit
`6ed7ef842ace8c9b973b7ff76e9100ef4999eb12`. The October 20 M1 refinement
checks native integration against `4e1a4430c94f655110d3f5b4d2f854f01a7c278f`.
Existing source, not historical limitations quoted in older ADRs, determines
what can be reused. Borrowed references and implemented persistent handles
are distinct categories. The
[September 27 analysis](../go2gs-preimplementation-performance-and-slice-design.md)
remains historical recommendations, not new measurements or approval for a
slice syntax change. This refinement keeps ADR-0190's additive syntax.

### Evidence and limits of the cliamp inventory

The reference application is **bjarneo/cliamp** at
[`4dee32c6c967cb2cc6069196e40cd3ff397deb3f`][cliamp-commit].
Its [go.mod][cliamp-mod] declares `go 1.26.6` and 15 direct third-party module
requirements. The preliminary tracked-source inventory, including mutually
exclusive variants and generators, records 557 Go files: 284 non-test files,
273 test files, 77,933 non-test physical lines, and 55 directories containing
Go files. These are **not** a loaded platform-specific package graph, a
type-checked audit, a transitive dependency measurement, or a supported
coverage percentage. No application execution or generators are needed to
write this proposal.

| Source witness | Requirement exposed |
| --- | --- |
| [internal/fuzzy/fuzzy.go][cliamp-fuzzy] | Named results, conversion to runes, Unicode case mapping, and string iteration; a small first real package. |
| [internal/tomlutil/sections.go][cliamp-toml] | Shared closure bindings, nil maps, missing-key lookup, and `strings.SplitSeq` range over an iterator function. |
| [internal/deeplink/deeplink.go][cliamp-deeplink] | Pure parsing with error identity/wrapping, byte-length limits, URL rules, and security-sensitive rejection paths. |
| [player/gapless.go][cliamp-gapless], [player/eq.go][cliamp-eq], [player/live_prefetch.go][cliamp-prefetch] | Mutating `samples[n:]` must reach the caller; stereo frames have fixed-array value semantics; streaming storage and copies are alias-sensitive. |
| [ui/model/update.go][cliamp-update], [ui/model/model.go][cliamp-model] | `Model.Update` has a value receiver and a message type switch, while other operations address fields. Making every struct a class is incorrect. |
| [provider/interfaces.go][cliamp-interfaces] | Optional capabilities are discovered from dynamic Go method sets, not just nominal CLR interface declarations. |
| [ipc/protocol.go][cliamp-protocol], [ipc/server.go][cliamp-server] | JSON tags, pointers, omitted fields and nil collections; goroutines, channels, locks, once-only shutdown, cancellation, and waiting. |
| [mediactl/service_darwin.go][cliamp-mediactl], [player/audio_device_macos.go][cliamp-audio] | CGo/Objective-C, native ownership, callback handles and recovery, unsafe access, platform entry/thread requirements, and device side effects. |
| [theme/theme.go][cliamp-theme], [internal/worldmap/worldmap.go][cliamp-worldmap] | Embedded resources and generator inputs; not every tracked Go file is an active compilation input. |

### What cs2gs actually supplies

The [cs2gs README](../../tools/cs2gs/README.md) and ADR-0115 establish the
existing migration pipeline, but the reuse boundary is narrower than the
whole tool:

| Existing component | go2gs decision |
| --- | --- |
| [Cs2Gs.CodeModel](../../tools/cs2gs/Cs2Gs.CodeModel/Cs2Gs.CodeModel.gsproj), its [AST](../../tools/cs2gs/Cs2Gs.CodeModel/Ast/GTypeReference.gs), and [GSharpPrinter](../../tools/cs2gs/Cs2Gs.CodeModel/Printing/GSharpPrinter.gs) | Reuse the Roslyn-independent G# output model and printer. It references `Core`; it is not dependency-free. Add bounded native-type/operation nodes only when existing nodes cannot express the accepted output. |
| [GSharpRoundTrip](../../tools/cs2gs/Cs2Gs.CodeModel/RoundTrip/GSharpRoundTrip.gs) | Reparse every emitted file with the actual G# parser. Parsing is necessary, not evidence of semantic fidelity. |
| [CSharpToGSharpTranslator](../../tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.gs), [CSharpProjectLoader](../../tools/cs2gs/Cs2Gs.ProjectLoading/CSharpProjectLoader.gs) | Do not use as a Go frontend: they depend on Roslyn, C# binding, and MSBuild project loading. |
| [GscInvoker](../../tools/cs2gs/Cs2Gs.Pipeline/GscInvoker.gs), [ProcessRunner](../../tools/cs2gs/Cs2Gs.Pipeline/ProcessRunner.gs), [IlVerifyRunner](../../tools/cs2gs/Cs2Gs.Pipeline/IlVerifyRunner.gs), [Fingerprint](../../tools/cs2gs/Cs2Gs.Pipeline/Fingerprint.gs) | Reuse or narrowly extract process/compiler/verifier mechanics and fingerprint principles after separating C# assumptions. Do not fork these helpers. |
| [MigrationPipeline](../../tools/cs2gs/Cs2Gs.Pipeline/MigrationPipeline.gs), [CorpusApp](../../tools/cs2gs/Cs2Gs.Pipeline/CorpusApp.gs), [StageExecutionContext](../../tools/cs2gs/Cs2Gs.Pipeline/IMigrationStage.gs), [TriageArtifact](../../tools/cs2gs/Cs2Gs.Pipeline/TriageArtifact.gs) | Reuse ordered stage semantics and reporting concepts, not the contexts unchanged. C# project paths, NuGet/reference metadata, test oracles, `csFile`, and `offendingCSharpConstruct` need a Go-specific schema or a small language-neutral extraction. |

No new printer, C# reimplementation of Go binding, Go-to-C# intermediate port,
or universal multi-language compiler framework is justified.

## Decision

**Build go2gs as a small Go typed frontend and a .NET migration driver/lowerer
feeding the existing G# code model. Preserve Go-observable behavior within
explicit package, feature, dependency, and platform profiles; reject or
report every gap. Verify generated programs against independent original Go
executions. Start with inventory and semantic witnesses, not bulk rewriting
of main.go.**

M0's `analyze`, `validate-analysis`, profile and inventory contracts are
implemented. Emission, executable validation, helper APIs and compatibility
support below remain **proposed**. Conceptual signatures specify obligations,
not installed APIs, new G# syntax or changes to native language semantics.

### 1. Fidelity contract, goals, and non-goals

Mechanical fidelity has two parts. Output should be deterministic,
human-maintainable G#: preserve names where legal, source organization,
comments and licenses, and use explicit, reviewable support calls rather than
opaque generated interpreters. More importantly, the output must preserve
program-observable values, copies/aliases, order where specified, errors,
control effects, initialization, synchronization, and external protocols.
Readability never authorizes a semantic approximation.

Choose existing native G# facilities first, reusable library facilities
second, and explicit Go compatibility support only for residual semantic
gaps. Lowering notation is not an application-visible wrapper API. Generated
code should use ordinary types, operators, control flow and native slices
where their contracts match, rather than a renamed Go runtime at every call.
The proposed reusable `bytestring` in section 6.2 follows this rule; typed
nil, Go faults and pinned Go Unicode behavior still need narrow compatibility
support.

The contract is relative to a recorded Go toolchain/language version,
GOOS/GOARCH, runtime settings, dependency graph, and external environment.
For deterministic observations, compare exact results. For source-permitted
nondeterminism, preserve the permitted behavior and obligations, not one
captured execution: map iteration, selection among ready channels, and
scheduler interleavings must not become ordered API promises. Differential
fixtures need a declared equivalence relation for those observations.
Pin platform-dependent widths and APIs rather than claiming one output
binary has every platform's behavior.

This does not promise identical scheduling, GC timing, allocation addresses,
stack traces, incidental runtime panic text, a particular append growth
factor, or performance parity. A program that explicitly depends on such
details is an identified boundary, not a silent success. Specified panic
values/types and documented API error text remain observable. Data races,
unsafe address arithmetic, runtime internals, open-world Go plugins, and
arbitrary reflection are not part of the initial managed profile. Removing
the race-free profile restriction requires a separate memory-model decision.

There is no LLM in parsing, binding, lowering, compatibility selection, oracle
generation, or pass/fail decisions. A human or external assistant may discuss
a diagnostic; an unreviewed AI rewrite cannot turn it into a mechanical pass.
Manual ports and deliberate behavior changes are recorded separately.

### 2. Source loading and reproducible profiles

Use a separately versioned Go helper built with a pinned compatible
toolchain, [golang.org/x/tools/go/packages][go-packages], `go/ast`,
[go/types][go-types], and [go/constant][go-constant]. M0 pins x/tools in
[`go.mod`](../../tools/go2gs/go.mod). The tables below describe the broader
profile design; implemented profile-v1 restrictions, including metadata-only
loading, in-process type checking, no workspace and no CGo execution, are
specified in the [M0 README](../../tools/go2gs/README.md). They are not
relaxed by the proposed executable profiles.

The profile fixes entry packages and the exact source/toolchain context:

| Profile input | Required handling |
| --- | --- |
| Entry packages | Accept only `.` or canonical module-relative `./segment[/segment]` patterns, with `...` permitted only as the final recursive component. Do not normalize profile input into acceptance. Reject absolute, drive, UNC, URI, traversal, backslash, whitespace/control, `key=value`, bare meta-pattern, and other loader query/operator forms before every package load so entry selection cannot escape the captured module mirror. |
| Toolchain and language | Record requested and actual Go executable version/hash, helper version/hash, module language versions, per-file language versions, GOROOT provenance, and relevant experiments/runtime compatibility settings. `go 1.26.6` is not proof of which executable was used. First cliamp profiles request that baseline explicitly; unavailable tooling is a loader blocker, not permission to upgrade it silently. |
| Modules/workspace | Record `go.mod`, `go.sum`, any `go.work`/`go.work.sum`, selected module versions, replacements, local replacement content hashes, and vendor mode plus `vendor/modules.txt`. Workspace discovery is explicit; do not accidentally inherit a parent's workspace. Module paths and replacements are identities, not just directory names. |
| Build selection | Record GOOS, GOARCH, architecture feature settings, tags, CGO_ENABLED, GOFLAGS, GOEXPERIMENT, build mode, and C/Objective-C compiler, SDK, flags, and native library provenance where relevant. Record GODEBUG settings affecting semantics. |
| Files | Record active source, ignored variants and reasons, compiled/generated CGo inputs, assembly/native files, test files, resources, and embed pattern expansion/content hashes. Track original source paths even when a driver exposes temporary compiled files. |
| Tests | Load ordinary packages, the augmented in-package test variant, external `_test` packages, and synthetic test mains as distinct build identities. Include TestMain and package initialization; never concatenate all test variants into one package. |
| Network/cache policy | Default to offline operation with prepopulated verified inputs, explicit module/vendor mode, and toolchain auto-download disabled. Missing exports/modules/checksums/toolchains produce incomplete inventory. A separately authorized fetch phase may populate caches and provenance; it must not silently update source manifests. |

The [module reference][go-modules] and [GODEBUG contract][go-godebug] are inputs
to profile interpretation, not excuses to follow whatever tooling is newest.
Capture relevant settings in a sanitized allowlist, not a dump of credential-
bearing environment variables. Unknown profile/schema versions fail explicitly.
Before decoding, profile-v1 bootstrap reads only a stable regular file of at
most 256 KiB. This fixed pre-profile ceiling applies before the profile's
configured timeout exists; oversized, growing, replaced, symlink, and
non-regular inputs fail without an artifact.

Ask the loader for the import graph, compiled files, syntax, type information,
type sizes, modules, and embed information needed by the selected closure.
Do not substitute a recursive scan of `*.go`. The tracked-file inventory is a
separate discovery view, including files not active in this profile.
Record per-package load errors and unaffected packages, but never mark a
partially loaded graph complete or bind unresolved imports as `object`.

Loading is **not a side-effect-free parse**. Package drivers and the Go
command can obtain exports, invoke build tooling, write caches, and process
CGo; native compilers and configured package drivers are executable trust
boundaries. Disable unapproved `GOPACKAGESDRIVER`, automatic toolchain
downloads, generators, and network access. Load in a bounded disposable
environment with a read-only source snapshot and isolated caches. Before
either `packages.Load` call, the Linux analysis worker applies a 2 GiB
`RLIMIT_DATA` ceiling. This also bounds x/tools' internal `cmd/go`
stdout/stderr buffers before package-count validation can run. Failure to
apply the ceiling is a bootstrap failure, not permission to continue
unbounded. A
metadata-only/source-scan fallback is labeled untyped and incomplete.
Neither `analyze` nor `translate` runs the target, `init` functions, tests,
`go generate`, module-provided scripts, or arbitrary MSBuild imports.
Source and selected local-replacement traversal reads directories in batches
of at most 128 entries and checks cancellation between batches. It fails before
sorting above 10,000 entries in one directory or 100,000 traversed entries
across the captured trees. Every file, directory, symlink, and other entry
consumes this traversal budget; the captured-file and byte limits remain
independent.

Checked-in generated files can be selected by the ordinary build rules.
Missing generated inputs block the affected closure. Record `go:generate`
directives for a later explicit regeneration decision, not execution.
Preserve `go:embed` bytes, logical names, pattern rules, and exposed string,
byte-slice, or filesystem behavior; finding an asset on the host filesystem
is not equivalent to embedding it.

### 3. Frontend, interchange, normalization, and lowering boundaries

The architecture has one Go-specific typed boundary, not a general IR:

```text
profile + immutable Go inputs
  -> Go loader / go/ast / go/types / go/constant
  -> versioned typed package records + diagnostics
  -> .NET Go normalization and storage/dispatch planning
  -> G# semantic lowering + explicit compatibility calls
  -> Cs2Gs.CodeModel -> GSharpPrinter -> GSharpRoundTrip
  -> compile -> ILVerify -> independent behavioral/test parity
```

The helper is authoritative for Go name resolution and type facts. Export
enough information that the .NET side never tries to reconstruct binding
from identifier strings:

| Interchange fact | Why it crosses the boundary |
| --- | --- |
| Stable package/symbol/type identities | Include module/replacement identity, import path, profile/test variant, declaration identity, and instantiated type arguments. Preserve named versus alias versus unnamed types and package-qualified unexported member identity. Structural identities encode unexported field and interface-method ownership at its exact nested position; an unordered package set is insufficient. Go-identical unnamed types must canonicalize even across packages. Do not persist process pointers or assume `packages.Package.ID` alone is a portable semantic ID. |
| Typed syntax and source coordinates | Node kinds, original and effective types, addressability, assignability, conversions, tuple/comma-ok forms, declaration/use links, lexical scopes, labels, and source comments/directives. Source byte spans and displayed positions are both needed; retain `//line` provenance rather than trusting it as a filesystem path. |
| Constants and sizes | Exact integer/rational/complex constant components, untyped category, final contextual conversions, iota values, array lengths, and target `int`/`uint`/`uintptr` sizes. Do not round through JSON floating-point numbers. |
| Calls and methods | Resolved builtin versus user call, signatures, variadic expansion, method values versus expressions, receiver type/mode, selections and embedded-field index paths, implicit address/dereference adjustments, and complete relevant method sets for `T` and `*T`. |
| Generic/interface facts | Type parameters, constraint/type-set terms, substitutions/instances, relevant satisfaction checks, comparability, embedded obligations, and struct field tags/export flags. Interface type sets are not inferred from CLR reflection. |
| Initialization/build provenance | Dependency graph, `types.Info.InitOrder`, ordered init functions and compiler input-file order, blank imports, resolved embedded assets, effective per-file language versions from `types.Info.FileVersions` with module fallback for non-syntax inputs, and source/content hashes. |

Use a bounded versioned JSON artifact with interned IDs and explicit
length/count limits. Preserve raw string/constant bytes losslessly, including
invalid UTF-8 string values, through an explicit byte encoding. Reject unknown
required record kinds, stale payload-derived IDs, and dangling IDs; diagnostics
cannot masquerade as missing optional type information. `validate-analysis`
recomputes IDs for every record whose complete identity input is serialized:
module, package, file, type, node, constant, scope, selection, call, method set,
instance, embed, generate directive, dependency, feature, diagnostic, and
blocker. Package identity combines the stable semantic profile, including the
authoritative GOROOT/toolchain identity, with the actual serialized
module/replacement record identity, import path, and test variant.
Type identity combines the same semantic-profile discriminator with its
canonical Go identity, preserving cross-package canonicalization within one
profile while separating target-dependent facts across profiles. Symbol IDs
additionally depend on canonical type ownership inputs that schema v1 does not
duplicate into those records, so their uniqueness, references, and ownership
are validated without claiming payload recomputation. Deterministic output IDs
come from canonical declarations/types, not dictionary traversal or absolute
cache paths.
Schema-v1 file roles are closed to `compiled`, `active`, `test`, `ignored`,
`native`, `embed`, and `method-authority`; the serialized native/embed flags
must agree with the role, `compiled` role must exactly match membership in the
owning package's `compiledFileIds`, and authority-only dependency source must
match its owning package's `methodAuthorityFileIds`. Compiled sources selected
by `go:embed` retain the `compiled` role and are also linked by embed records.
Every serialized syntax node belongs to a compiled file, and each
node-bearing file is exactly one `*ast.File`-rooted parent tree with no
detached nodes or cycles. Incomplete inventories may omit a compiled file's
tree, while complete inventories require one for every compiled file.
Blocker messages redact machine-local source, mirror, replacement, temporary,
and output roots, normalize invalid UTF-8, and apply the profile string limit
before stable-ID derivation, deduplication, counting, sorting, or publication.
Redaction is component-boundary-aware, orders nested roots most-specific first,
and treats Windows drive/UNC case and slash variants as aliases.
Non-`file:` URI text is not a filesystem candidate. Absolute Unix,
Windows-drive, case-insensitive `localhost`, drive-authority, and configured
UNC `file:` paths are redacted without decoding. Absolute drive paths accept
zero, one, or three separators after `file:`. Unknown authorities, relative
non-drive or percent-encoded forms, and ambiguous noncanonical separator
counts fail closed as `file:<private-path>`; unmatched drive-shaped paths do
likewise. Exact `.` or `..` path components, invalid bytes, and encoded or
Unicode dot/separator ambiguities collapse the complete URI before matching or
any unchanged fallback. Path components admit ASCII alphanumerics and `-._~`
plus ordinary Unicode letters/numbers only. Raw whitespace and unexpected
punctuation fail closed; a drive component is legal only first or immediately
after `localhost` when it is the parsed authority in an exactly two-separator
`file://localhost/...` form. Ordinary path components named `localhost` grant
no drive exception. The scanner consumes malformed unwrapped tails as part of
the failing file URI, while a recognized quote, parenthesis, bracket, brace,
or angle wrapper ends the URI and leaves an adjacent path to the ordinary
redactor.
Query text is preserved only as unique nonempty `key=value` pairs separated by
one `&`. Keys and values start and end with an ASCII alphanumeric and may use
`-._~` internally, but cannot equal `.` or `..`; key-only parameters are
forbidden. A fragment is one nonempty token under the same rule. Empty or
duplicate components, duplicate delimiters or keys, filesystem separators,
drive colons, percent encoding, controls, Unicode, and any other suffix byte
collapse the complete URI rather than reattaching unexamined text.
The blocker ID uses the exact bounded message present in the artifact.
The final record bound applies equally to preload-only failure inventories.
Validation recomputes source-manifest identity and byte-validity claims, and
indexes record ownership rather than repeatedly scanning record collections.

Normalize expression sequencing, multi-assignment, return slots, range loops,
and defer registration into a small set of Go-specific operations. Maintain
source-span attribution and distinguish values from addressable locations.
Then plan whole-root storage, closure bindings, generic specializations,
initialization, and interface dispatch before printing any file. Lowering
selects actual G# operations or declared compatibility calls; unsupported
operations stop that migration unit. It never invents syntax or stubs that
return zero, discard work, or throw `NotImplementedException` at runtime.

The printer only renders an already-decided G# model. It must not re-resolve
Go calls, infer pointer identity, or insert semantic fixes. Missing
`slice[T]`, `readonly slice[T]`, handle, or adaptation model coverage is added
alongside the corresponding native capability, without changing cs2gs array
output. No SSA optimizer or general escape-optimization framework is needed
for the first correct lowering.

### 4. Proposed CLI and artifact contracts

M0 implements `analyze` plus `validate-analysis`. Later milestones add
`translate` and runtime `validate`; `translate` is the emission operation, not
an alias for a successful migration:

```sh
go2gs analyze --source ../cliamp --profile cliamp-leaf.json \
  --out artifacts/cliamp-analysis
# Later milestones:
go2gs translate --source ../cliamp \
  --analysis artifacts/cliamp-analysis/analysis.json \
  --out migrated-cliamp --artifacts artifacts/cliamp-translation
go2gs validate --source ../cliamp \
  --manifest migrated-cliamp/go2gs.manifest.json \
  --artifacts artifacts/cliamp-validation
```

`analyze` produces a typed inventory, the original selected package graph,
feature/dependency decisions, and blockers. Exit zero means the requested
inventory completed, not that migration is supported; report
`inventoryComplete` and `migrationReady` separately. Toolchain/load failures
make the inventory incomplete and the command nonzero.

`translate` consumes that immutable analysis and verifies hashes before
emission. It publishes a mirror only after the selected unit is wholly
lowered and reparses; a stage-1-only result remains `unverified=true`.
Partial diagnostic renderings stay in artifacts, not in a plausible buildable
project that omits troublesome files. Independent units may complete while
another unit is blocked, with separate results.

`validate` compiles the already generated tree, IL-verifies its managed
assemblies, then runs the explicitly authorized oracle profile. It does not
retranslate silently. Source, generated-code, dependency, compiler/runtime,
or profile drift invalidates prior attestations. Hand edits can be validated
as a declared manual port but cannot retain the old mechanical-translation
attestation or stale source map.

Each command binds logical source/module roots to explicitly supplied local
paths and checks their content identities; the portable manifest never guesses
a developer's checkout location. `translate` exits nonzero on any requested
unit's blocked/failed emission. `validate` exits zero only for a fully verified
requested scope; failure and incomplete verification have distinct nonzero
results. A process exit code never replaces the detailed per-stage report.

| Proposed artifact | Contract |
| --- | --- |
| `analysis.json` | Schema/tool versions; exact profile and hashes; typed-inventory completeness; active/ignored/test variants; package/import edges; feature sites; dependency disposition; all blockers and their affected units. |
| `go2gs.manifest.json` | Source identities, translation/runtime/compiler requirements, build-unit graph, explicit source/resource lists, initialization plan, generated-file hashes, mapping-policy version, and pointers to the source map and dependency lock. No machine-local absolute paths. |
| `go2gs.dependencies.json` | Original Go modules, checksums, replacements/vendor provenance and licenses; each relevant package/API's chosen disposition and implementation version; exact managed/native dependency identities. Go module names are not guessed NuGet package names. |
| `go2gs.sourcemap.json` | Original module-relative UTF-8 byte ranges plus line/column convention; generated relative files/ranges; symbol/type IDs; one-to-many/many-to-one lowered mappings; synthetic-helper role and originating sites. Missing precise attribution is explicit, not guessed. |
| Artifact `run.json`, `summary.json`, and report | Stage outcomes, failures versus unavailable/not-requested/cascade skips, `succeeded`/`unverified`, scope denominators, dependency exclusions, oracle details, hashes, timings, and triage fingerprints. Report rendering escapes untrusted content. |

The mirror keeps original module-relative directory layout and `.go` to `.gs`
correspondence where possible. Put cross-file support in a clearly generated
directory; every generated declaration carries provenance through the map.
Dependencies outside the application module get collision-safe module roots,
not paths copied from a machine's module cache. Preserve required non-code
resources/notices from an explicit manifest; do not blindly copy executables,
secrets, or build scripts. Build intermediates and logs live outside the mirror.

Default output must be empty. Regeneration may replace only previously
manifest-owned, unchanged generated files; refuse edited files, path traversal,
symlink escape, or collision with unowned content. Publish via staged output
and atomic manifest replacement where supported. A cancelled run cannot leave
a half-updated tree claiming successful validation.

### 5. Package, assembly, visibility, and initialization decisions

The initial unit is **one closed translated program closure per executable
and build profile**, emitted into one `.gsproj`/assembly, plus the versioned
Go compatibility and native G# runtime references. Preserve Go packages as
separate namespaces and source directories; do not pretend namespaces are
assemblies. A selected Go test binary has its own closure/project with its
actual test variants. Reuse immutable analysis, not conflicting test state.

This avoids a generated assembly cycle when an interface in one Go package
matches a concrete type in an unrelated package. Generate the needed typed
bridges in the composition unit, which can reference both. Compatibility
libraries must not reference application types; application-owned descriptors
and dispatch tables supply those facts. No source assembly is modified to
implement every future interface.

Name symbols by their full import identity, not package basename. Preserve
readable segments, escape G# keywords, and use stable suffixes only for actual
collisions, including case-insensitive filesystem collisions and distinct
major module versions. Record the reversible name map. Named Go types remain
distinct even when their underlying CLR representations coincide.

Go's loader/typechecker enforces exported/unexported and `internal` import
rules before lowering. Unexported identifiers retain their package identity
in lookup and method-set metadata. In the initial closed application assembly,
implementation declarations may use CLR `internal` access for legal generated
cross-file bridges. That is an explicitly wider **CLR implementation**
visibility than Go package privacy, not permission to resolve illegal Go
accesses. Do not expose this implementation surface as a public CLR library
API or rely on it as a security boundary. Source-preserving package privacy
for arbitrary post-migration edits and separately consumable per-package
assemblies are deferred library-ABI work, not initial fidelity claims.

Generate package-state objects for Go globals, including addressable fields.
This supplies ordinary instance-field owners for ADR-0188 instead of requiring
its deferred static-field handle support. Allocate zero-valued storage before
running initializers; a Go zero-value plan must override G# defaults that
would create non-nil collections. Generate explicit once-only initialization
entry points, called by the program/test bootstrap before user entry.

Use the Go dependency/initialization schedule, including blank imports,
variable dependency order and ordered `init` functions. A merely arbitrary
topological sort is insufficient where the Go toolchain specifies tie-breaking.
Do not use demand-triggered CLR static constructors as the source schedule.
Initialization side effects, panic, goroutines started during initialization,
and imported compatibility-package initialization belong to the same plan.
Failed initialization never publishes an initialized flag or continues into
main. Test variants get the corresponding Go test initialization schedule.

### 6. Semantic mapping matrix

The [Go language specification][go-spec] is the semantic authority, interpreted
at the recorded source language version. The table selects lowering policy,
not a claim that the entire surface is currently implemented. Each admitted
row needs discriminating witnesses; unsupported subcases remain diagnostics.

| Go construct | Selected lowering and fidelity boundary |
| --- | --- |
| Short declarations and scope | Bind `:=` by declaration identity: some names can be reused and others newly declared in the same scope. Preserve shadowing, initializer scope, `_`, if/switch/for scopes, labels and branch targets. Choose G# `let` only when later assignment/address/capture analysis permits it; token substitution is insufficient. |
| Evaluation and assignment | Materialize calls, receives, lvalue owners/indices, and RHS values at the required evaluation points, then commit multiple assignments in source order. Do not impose an invented universal Go left-to-right rule on otherwise unspecified operand ordering. Short-circuit expressions and loop conditions retain their execution frequency. Compound assignment selects a location once. |
| Multiple/named returns | Lower result tuples with exact element types. Named results have zero-initialized mutable slots; explicit return expressions fill them before deferred calls, and final results are read after defers. A naked return is not an early tuple snapshot. |
| Untyped constants and iota | Use the helper's exact constant values and contextual types, preserving repeated const expressions/iota, representability diagnostics, rounding points, and named-type conversions. Do not let G# literal inference or JSON numbers choose Go types. |
| Numeric operations | Map fixed widths explicitly; map `int`, `uint`, and `uintptr` from target sizes, not the translator host. Lower wrapping integer operations, conversions, signed division edge cases, and shifts explicitly where CLR instructions differ. Negative runtime shift counts panic; large counts must not inherit CLR masked-shift behavior. Complex arithmetic is gated until its chosen representation and operations have witnesses. |
| Struct values and receivers | Use value types with recursively correct field representation. Assignment, arguments, return, interface insertion, range values, and value-receiver calls copy values, while reference-like fields retain their own sharing. Translate receiver bodies through explicit by-value or persistent-location bridges; an in-body G# struct method's borrowed `this` does not itself implement Go copy-per-call. |
| Pointers and function values | Use nullable `managed[T]?` for admitted Go pointer locations; do not spell every Go pointer as existing borrowed `*T`. Preserve nil pointer receiver calls that do not dereference their receiver. Method-value creation snapshots the proper receiver; method expressions retain explicit receiver parameters. Closures share lexical bindings. Nil functions stay distinct from a callable empty delegate; only source-legal nil comparisons are emitted. |
| Fixed arrays `[N]T` | Retain length in Go type identity and use real value lowering. Current G# `[N]T` is CLR-array-backed, not Go array copying. The first audio profile admits generated field-backed `[2]float64` and `[10]float64` values with checked constant/dynamic indexing, whole-value copies and equality. Other shapes, nested arrays, array slicing and escaping element addresses stay blocked until their full storage semantics are implemented; see section 7. |
| Slices `[]T` | Use implemented native `slice[T]` for the non-nil payload, with an explicit nullable descriptor for Go nil. Compatibility operations preserve nil-sensitive construction, len/cap, bounds, append/copy/clear, capacity-limited subslices, and panic translation. Descriptor equality is never Go slice equality; Go slices only compare with nil. |
| Strings, bytes, and runes | Use proposed reusable `bytestring`, an immutable arbitrary-byte value, not CLR `string` or an alias for `readonly slice[uint8]`. Byte indexing/length/order remain byte-based even for valid UTF-8. Go string range selects an explicit UTF-8 decoding policy with byte offsets and one-byte invalid-input advancement. Go `rune` maps to `int32`, not `char` or `System.Text.Rune`; decoded `slice[int32]` is algorithm data, not string storage. Mutable conversions copy, and CLR text conversion has an explicit encoding/error policy. |
| Maps | Use a nullable Go map contract over suitable BCL storage, with Go zero on missing keys and a separate comma-ok flag. Nil reads/deletes/clear/len are legal as specified; writing a nil map panics. Preserve element copy behavior and non-addressability, permitted key comparability, NaN/signed-zero cases, and typed-interface keys. Iteration must satisfy Go mutation rules, not `Dictionary` fail-fast enumeration or a promised insertion order. |
| Equality and hashing | Generate Go equality/comparability operations for named/unnamed values, arrays, structs and dynamic interfaces. Do not inherit data-struct/CLR equality when it compares slices, compares wrapper identities, treats NaNs differently, or includes blank fields. Map hashing agrees with source equality and preserves original dynamic type distinctions. |
| Errors and wrapping | Model `error` as a Go interface value, not an exception by default. Preserve nil/typed nil, sentinel identity, formatting, wrap trees, and `errors.Is`/`As` including custom methods and target assignment. CLR exceptions at mapped I/O boundaries become the specified Go error values, not arbitrary message-only substitutes. |
| Defer, panic, recover | Register eager callee/receiver/argument values in a function-scoped LIFO plan, including defers inside loops. Execute on ordinary return and unwinding, with mutable named-result access. Use a bounded logical-goroutine Go panic carrier/recovery protocol; direct recovery in the eligible deferred call is not a catch around any caller. Preserve nested panic/defer behavior and version-dependent `panic(nil)` behavior. G# `defer` syntax alone is not sufficient evidence. |
| Interfaces/assertions/type switches | Represent original Go dynamic type plus a value snapshot or pointer location, separately from CLR adapter identity. Distinguish nil interface from typed nil, `T` from `*T`, and failed assertions from comma-ok. Assertion to a value returns a copy. Runtime interface satisfaction uses generated Go metadata/bridges for the selected closed world, not `GetType()` on an `adapt` wrapper. |
| Embedding and promotion | Export resolved selection paths and method sets; emit explicit forwarding and address/dereference adjustments. Preserve shadowing, ambiguity, nil embedded pointers, and value/pointer receiver distinctions. Embedding is composition, not CLR inheritance. |
| Generics and type sets | Initially specialize finite closed instantiations discovered by the typed closure. Support a specialization only when all substituted operations/types already satisfy this matrix. Constraint checks, `~` terms, unions, `comparable`, aliases and instantiation identities come from Go, not translated CLR constraints. Constraint-only interfaces never become ordinary value interfaces. Open generic library APIs, unbounded specialization, and unsupported substituted operations diagnose; no universal `object` erasure. |
| Range: strings/maps/arrays/slices | Evaluate the range expression under Go's evaluation exceptions. Strings yield byte offset/rune; maps use the Go iterator contract. Array-value iteration copies the array when required, while pointer-to-array iteration observes its storage. Slice iteration snapshots its descriptor/length but reads current elements by value. It must not silently clone the backing buffer. |
| Range: channels/integers/functions | Channel range ends on closed-and-drained, not a received nil value; nil channel behavior remains blocking. Integer range uses the correctly typed bound and zero iterations for nonpositive bounds. Iterator-function range lowers through synchronous yield/control-state bridges, preserving early stop, return/break/continue, panic propagation and illegal post-stop yield detection, not a generic `IEnumerable` conversion. |
| Iteration bindings | Honor source/file language-version rules for `:=` loop variables, including Go 1.22+ distinct per-iteration instances and three-clause-loop carry-forward behavior. Assignment-form `=` reuses existing variables. Captured/addressed variables must follow these identities. |
| Goroutines and select | Evaluate launch arguments in the caller before scheduling. Reuse G# channel/goroutine machinery only after proving the needed rendezvous, buffered, nil, closed, directional and selection contracts. Save select channel/send operands once in source order; receive-assignment targets evaluate only for the selected arm. Preserve Go's uniform pseudorandom choice among ready communications; selection and cancellation must not acquire a new source-visible priority. |
| Synchronization and cancellation | Preserve the Go memory model's synchronization/publication guarantees for admitted race-free programs. Map atomic operations, Mutex/RWMutex, Once, WaitGroup and context through explicit contracts, not names. Go mutexes are not owner-thread/reentrant CLR monitors. Waiting/suspending call edges, callback boundaries and interface slots require a coherent ABI; unsupported edges block. |
| Package initialization | Execute the explicit plan in section 5, including zero storage, blank imports, variable dependencies, `init`, and failure. Neither namespace loading nor a convenient CLR static constructor determines order. |

Additional control-flow forms, type conversions, reflection calls, compiler
directives, unsafe operations, and runtime functions are inventoried by exact
kind. Their absence from an implemented support table is a blocker, not
permission to translate them approximately. `os.Exit`, for example, must not
accidentally run deferred cleanup just because ordinary CLR exception
unwinding would do so.

#### 6.1 M1 admission is per family, not all-or-nothing

Freeze the contracts below before implementing a lowerer. Then start with
the proposed **`m1-text-values-v1`** executable profile. It selects Linux/amd64,
Go 1.26.6 with matching helper/toolchain provenance, `int` width 64, CGo off,
offline inputs, and no Go experiments or GODEBUG overrides. This is a new
fixture profile, not a modification of the existing darwin/arm64 M0 inventory
profile. Its analysis host must satisfy M0's Linux execution requirements.
JIT and NativeAOT validation must run on the selected target.

| First executable family | Admitted boundary |
| --- | --- |
| Values and functions | Go `bool`, `byte`, `rune`, target-width `int`, their predeclared aliases, exact representable constants, strings, and `[]byte`/`[]rune`. Emit ordinary `bool`, `uint8`, `int32`, profile-selected `int64`, proposed `bytestring`, and native `slice[uint8]`/`slice[int32]` with nullable descriptors where nil is observable. Direct synchronous functions, local variables, constant package declarations, tuple results and named-result slots. No user-defined Go types, pointers, interfaces, closures, generics or effectful package initialization yet. |
| Operators and sequencing | Integer `+`, `-`, unary signs, `++`/`--`, integer/string comparisons, Boolean operators and short circuiting, assignment and simultaneous assignment. Integer conversions among the admitted types use Go width/truncation rules; string conversions are listed below. Other operators diagnose until separately witnessed. |
| Control flow | Blocks, `:=`, if, expression/tagless switch, three-clause/condition loops, range over strings and admitted slices, unlabelled break/continue, explicit and naked return. No fallthrough, goto, labelled branches or iterator-function range in this profile. |
| Text and small buffers | Go string literals materialized as exact bytes through the proposed library API; no new target literal syntax. Concatenation, byte length/index/two-index slicing, bytewise equality/order, `[]byte`/`[]rune` conversions and reverse string conversions. Nil slices, empty/nonempty literals, source `make`, len/cap, checked element reads/writes, two/three-index subslices and descriptor copies use native G# storage/factories plus required checks. Append/copy/clear are later slice admissions, not inferred from native support. |
| Mapped API | Only `unicode.ToLower(rune)`, using tables and rules from the selected Go toolchain. No blanket `unicode`, `strings`, `fmt` or testing-package support claim. Fixture transport is a separately specified harness, not translated application I/O. |

These operations cover the direction of pinned `internal/fuzzy/fuzzy.go`:
named results, `[]rune`, string range, `unicode.ToLower`, scoring and control
flow. This is **not** a claim that its package, test variants or dependency
boundary already migrate. First witnesses are small unchanged Go programs.
Bank the complete fuzzy package only at M2, followed by `internal/tomlutil`
and `internal/deeplink`.

Every syntax site, type, initializer and dependency API in a selected unit
must be admitted. An unreachable unsupported site still blocks that unit.
Unlisted operations produce an attributed `unsupported-operation` diagnostic;
unmapped APIs produce `compatibility-api`. These are proposed diagnostic
reason keys, not existing numeric IDs. Include profile, family, operation,
Go span/type ID, affected closure and the admission gate in each diagnostic.
Do not filter away source files or mistake M0's broad blocker categories for
an executable support table.

Later M1 profiles independently add interfaces/locations/captures and the
fixed-array family. Each records its exact admitted dependencies and witness
set. Neither family nor concurrency must be implemented before the first
text/value witness. Feature expansion versions the admission profile; it
does not silently broaden `m1-text-values-v1`.

#### 6.2 Byte strings, zero values and faults

**Representation and naming.** Keep G# `string` as ordinary CLR
`System.String`. Propose `bytestring` for immutable arbitrary bytes, useful
to handwritten G# as well as generated code. It is not `utf8string`: invalid
UTF-8 and embedded zero bytes are valid stored data. Even known-valid UTF-8
does not authorize CLR string emission, since byte length/index/order differ
from UTF-16 operations. Proof-based representation optimization is deferred.

The first implementation direction is an ordinary reusable value type with
normal methods and supported operators, not a compiler intrinsic. Existing
[Values naming](../../src/Sdk/Gsharp.Runtime.Values/Gsharp.Runtime.Values.gsproj)
uses PascalCase nominal types in `Gsharp.Values`; `Gsharp.Values.ByteString`
is a **candidate**, not a shipped type or fixed package ABI. The generated
spelling can use the existing alias syntax
`type bytestring = Gsharp.Values.ByteString`; qualify the nominal type or
choose a collision-safe alias when needed. Lowercase `bytestring` is not an
accepted built-in, reserved word, automatic alias or new literal syntax.
The reusable library's public contract/packaging needs its own accepted ADR
before release. Any native keyword, alias, literal or language-semantic
change additionally needs a separate language ADR, implementation and release,
followed by the N-1 pin gate before repository use. None is implemented here.

Store an immutable owner plus offset and byte length, using native array/slice
storage internally where useful. Default `bytestring` is non-null empty,
not Go nil or a nullable native descriptor. Copy mutable inputs at publication.
A private owned-storage transfer is permitted only for freshly allocated,
proven-exclusive storage with no surviving writable aliases; it is not a
public unchecked ownership flag. Never expose a writable backing array, span,
slice or persistent handle. `readonly slice[uint8]` alone cannot guarantee
immutability because writable siblings may exist. Immutable substrings may
share their owner; concatenation may reuse empty operands or own new storage.
Equality/order/hash consume byte content, not slice descriptor identity,
culture, normalization or UTF-16 units.

**Proposed library surface.** These signatures use native G# types; they
describe unavailable ordinary library APIs, not new syntax. The private
storage domain uses `int32` lengths/indices. Instance operations below use
`value: bytestring`; static operations use the type name.

```text
bytestring.FromBytesCopy(source: readonly slice[uint8]) -> bytestring
value.ToBytesCopy() -> slice[uint8]
value.Length -> int32
value.IsEmpty -> bool
value[index: int32] -> uint8
value.Subslice(lo: int32, hi: int32) -> bytestring
value.Concat(other: bytestring) -> bytestring
value.Equals(other: bytestring) -> bool
value.CompareTo(other: bytestring) -> int32
value.GetHashCode() -> int32
value.StartsWith(prefix: bytestring) -> bool
value.EndsWith(suffix: bytestring) -> bool
value.IndexOf(needle: bytestring) -> int32
bytestring.FromCodePoints(source: readonly slice[int32], policy: CodePointPolicy)
    -> (value: bytestring?, error: EncodingError?)
value.DecodeCodePoints(policy: Utf8DecodePolicy)
    -> (points: slice[int32]?, error: EncodingError?)
value.DecodeNextUtf8(offset: int32, policy: Utf8DecodePolicy)
    -> (hasValue: bool, codePoint: int32, nextOffset: int32, error: EncodingError?)
value.DecodeUtf8(policy: Utf8DecodePolicy) -> (text: string?, error: EncodingError?)
bytestring.EncodeUtf8(text: string, policy: Utf16EncodePolicy)
    -> (value: bytestring?, error: EncodingError?)
```

`+`, `==`, `!=` and ordering operators may forward to these ordinary methods
when their supported G# operator contracts are witnessed. `Subslice` uses
exclusive endpoints. Prefix/suffix/search are bytewise, with empty prefix/
suffix matching, empty needle at zero, and `IndexOf` returning a byte offset
or `-1`. They imply no whole-package Go `strings` mapping. Index/range misuse
is a library argument error; generated Go checks supply source fault semantics
before calling it. Content hashes agree for equal bytes but need not match
Go's private hash or remain stable between processes.

**Encoding policies and Go selection.** Encoding is always explicit; there
is no implicit UTF-8-validity requirement or unspecified decoder default.
`Strict` rejects malformed input at its first byte/code-unit/element offset.
An error result contains no partial decoded/encoded value. Success contains
a present result and no error, including empty results.
For step decoding, an error leaves the offset unchanged and has no value.
Offsets outside `[0, Length]` are library argument errors. At `Length`,
`DecodeNextUtf8` returns no value, no error and the unchanged offset.

`Utf8DecodePolicy.ReplaceInvalidByte` emits U+FFFD and advances **one byte**
for each invalid encoding, including truncated/overlong sequences and encoded
surrogates. A valid U+FFFD encoding advances three bytes. A successful step
exposes the starting byte offset through its input and returns the next offset.
String range saves its source once and uses this explicit policy.
`DecodeCodePoints` uses the same policy for Go `[]rune` conversion.
Its result is writable algorithm data in `slice[int32]`, not the source string
representation. Go `rune` is unrestricted `int32`; `System.Text.Rune`, which
represents a valid Unicode scalar, cannot replace it.

`CodePointPolicy.ReplaceInvalidCodePoint` encodes negative values, surrogate
values and values above U+10FFFF as U+FFFD; go2gs selects it for Go
`string([]rune)` conversion. `Strict` rejects those values instead.
`Utf16EncodePolicy.ReplaceUnpairedCodeUnit` replaces each unpaired surrogate
on CLR-text import; paired surrogates encode their scalar normally.
No policy normalizes Unicode. If a reusable implementation lacks the exact
Go-selected policy, a small compatibility shim must supply it with independent
witnesses, or the operation stays blocked. Do not silently use a BCL decoder's
different replacement grouping.

`FromBytesCopy` and `FromCodePoints` snapshot mutable input.
`ToBytesCopy` and successful `DecodeCodePoints` return independent writable
storage, including **non-nil empty slices** for empty input. The Go lowering
maps nil byte/code-point slices to empty `bytestring` before calling these
non-null library APIs. No mutable conversion can change an existing value or
another conversion result.

The first CLR text boundary selects only `Strict` for `DecodeUtf8` and
`EncodeUtf8`: invalid UTF-8 or unpaired UTF-16 produces an encoding error,
not replacement or a partial result. This boundary is not used for ordinary
Go string operations. Any lossy CLR adapter needs its own later admission.
Go `unicode.ToLower` remains a narrow compatibility call over `int32` with
pinned Go source/table hashes and `unicode.Version`; it is not culture-sensitive
casing, full case folding or a presumed match to .NET tables.

Conceptual generated G# using existing syntax and the **unavailable proposed
library** might look like this; it is not a compiling sample for today's SDK:

```gsharp
type bytestring = Gsharp.Values.ByteString
let input = slice[uint8]{0x41, 0xff, 0}
let text = bytestring.FromBytesCopy(input.AsReadOnly())
input[0] = 0x42
let length int64 = int64(text.Length)
let prefix = text.Subslice(0, 1)
let scratch slice[int32]? = slice[int32].Create(0, 4)
```

`text` retains bytes `41 ff 00`; `scratch` is non-nil empty with capacity four.
Literals in generated output similarly materialize exact bytes without a CLR
string round trip. The example needs no Go-shaped string/slice wrapper or
target `make` builtin.

**Native values and residual checks.** Emit Go `int` as concrete `int32` or
`int64` according to the source profile, not translator-host width or a
public integer wrapper. Operand signedness/width/bits belong to translator
bookkeeping, not a public universal index type. Emit ordinary typed operands,
checks and casts, or a narrowly specialized private helper when necessary.
Observed native/library lengths widen to the source integer type explicitly.
Go `[]T` emits native `slice[T]` or `slice[T]?` when nil is observable;
there is no additional runtime slice class.

The nullable native slice descriptor has two states: absent means nil;
present means non-nil, even with zero length/capacity. Nil len/cap are zero.
Nil `[0:0]` and `[0:0:0]` remain nil; the same ranges on non-nil empty
descriptors remain non-nil. Native descriptor equality is never exposed as
Go slice equality. Only comparisons with nil are legal. Descriptor copies
share elements; string conversions copy elements. Source `make` lowers to
existing factories such as `slice[T].Create(length, capacity)` after the
required source-width/order/fault checks, not a new function, operator or
Go-style builtin. G#'s retired collection builtins stay retired.
The factory result and native literals must
produce present descriptors and zero every newly observable slot using the
Go element zero plan, including capacity later exposed by reslicing.
For the first `uint8`/`int32` family, CLR zero and Go zero coincide. Later
bytestring, interface, nested-slice and aggregate elements require their own zero witness;
G# collection default construction cannot choose Go nilness.

All index/bound expressions evaluate with Go's required sequencing before
checks. Compare in the source integer domain before narrowing to native
`int32`: `-1` and `1 << 32` must not become valid index zero. For strings the
upper bound is byte length; for slice reslicing it is capacity, with an
omitted high bound supplied from length. Three-index slicing additionally
requires `0 <= lo <= hi <= max <= capacity`. Integer arithmetic wraps at its
Go width rather than inheriting checked overflow. Later shift admission must
preserve negative-count faults and large counts instead of CLR masked shifts.
Constant representability remains a frontend obligation. Nil-sensitive
subslice operations branch on the nullable descriptor and call native
`Subslice` after checks; they do not require a parallel slice library.

The initial storage domain has lengths/capacities at most `Int32.MaxValue`,
plus smaller explicit resource budgets in the executable profile. Invalid
Go bounds produce a Go fault before any narrowing. A Go-valid allocation or
result beyond the representable/budgeted domain produces
`unsupported-value-domain` or resource failure, not an invented Go panic,
truncation or a successful parity result.

The minimal proposed carrier is `GoFault(kind, site, operands)`. Initially
`kind` covers index bounds, slice bounds and invalid make length/capacity;
operands retain their source widths. Only explicit Go checks create it.
The harness classifies the corresponding fault from unchanged Go execution
and compares category, operands and effect trace, not incidental panic text.
Unexpected CLR exceptions, allocation failures and process failures remain
validation failures. There is no broad CLR-exception-to-Go-fault catch.
This unrecoverable fixture boundary does **not** implement arbitrary panic
values, defer stacks, recover or goroutine unwinding. Those remain separate
admissions. Future interface assertion/comparison faults extend the versioned
carrier only with independent witnesses.

#### 6.3 Deferred control effects and concurrent neighbors

**G# already supports goroutines, channels and `select`.** ADR-0174 supplies
native launch, suspension and channel/select machinery. The
[channel runtime](../../src/Sdk/Gsharp.Runtime.Channels/ChannelOps.gs)
already provides nil-channel waits and closed-and-drained receives;
[select](../../src/Sdk/Gsharp.Runtime.Channels/SelectWaiter.gs) handles nil
arms. The deferral is a **go2gs admission/evidence boundary**, not missing
language capability or a claim that G# cannot model Go concurrency.

The first text/value profile avoids combining its initial lowering with
these additional translation obligations:

- **Launch and lifetime:** preserve Go callee/receiver/argument evaluation in
  the caller before scheduling, rather than moving operands into a spawned
  block. Go launch does not implicitly join at caller return. G# already has
  [free launches](../../src/Sdk/Gsharp.Runtime.Channels/GoroutineRuntime.gs);
  inserting a [structured scope](../../src/Sdk/Gsharp.Runtime.Channels/ScopeFrame.gs)
  would add joining, sibling cancellation and child-failure propagation.
  Choose the mapping from source lifetime/synchronization, not syntax alone.
- **Failure isolation:** native free goroutines fail fast by default, while
  scoped failures propagate at scope exit. These mechanisms do not establish
  Go's per-goroutine panic/defer/recover mapping. A parent's recovery must
  not recover a child's panic; translated unwinding and unrecovered failure
  need their own witnesses.
- **Suspending call edges:** reuse G#'s
  [inference and declared suspension ABI](../../src/Core/CodeAnalysis/Binding/Suspension/SuspensionInference.gs).
  The translator must still plan function/delegate/interface signatures,
  context propagation and foreign callback boundaries. A compiling call that
  falls back to blocking is not proof of the selected Go mapping.
- **Channel and memory evidence:** native primitives remain the implementation
  basis, but generated code must prove Go nil/closed/buffered behavior, zero
  values and faults, select operand/assignment timing and ready-arm choice,
  and race-free publication/synchronization. Native tests alone do not test
  the translator's value, control-flow and compatibility lowering.

The first executable profile rejects `go`, channel types/creation/send/receive/
range, `select`, synchronization/atomic/context APIs, callbacks and foreign
calls. Report `concurrency-boundary` at the originating site and dependent
call edges; reject even an unused channel declaration or unreachable launch.
Do not lower a goroutine synchronously, replace nil-channel blocking with a
null exception, or use arbitrary worker blocking as a fallback.

Admit concurrency in a later profile once its explicit mappings pass the
ordered verification stages and independent original-Go/JIT/NativeAOT
witnesses. This is not a prerequisite for the first scalar/text slice and
does not imply a new scheduler or rewriting G#'s built-in concurrency.
Unmapped call edges remain blocked; any genuinely new language-wide
suspension ABI still requires a separate ADR.

Maps, explicit `panic`, `defer`, `recover`, and iterator-function control
effects likewise produce `deferred-semantics`, not placeholder helpers.
Named-result slots can be admitted without defer; a later defer profile must
prove that post-defer results are read from those slots. `tomlutil` remains
blocked on map, capture and iterator contracts, while `deeplink` also needs
error/wrapping and parsing boundaries. These are not prerequisites for
`m1-text-values-v1`.

### 7. Native capability integration without changing their contracts

**Slices: ADR-0190 / #4328.** Use `Gsharp.Values.Slice<T>` and
`ReadOnlySlice<T>` from `Gsharp.Runtime.Values`, spelled `slice[T]`
and `readonly slice[T]`. Raw `[]T` and `array[T]` remain exact CLR
arrays. The current
[BindArraySlice](../../src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.MemberLookup.gs)
copying path must not be changed globally for go2gs.

Lower to `.Subslice` for known instance operations. `.Slice` is the imported
extension convenience facade, not an instance member declared inside the G#
`Slice<T>` runtime type. Keep exclusive endpoints and saved evaluation order.
Use the native descriptor's sharing, overlapping-copy behavior, append
capacity, and addressable value elements rather than build another
application-wide slice implementation. Generated signatures use `slice[T]`
and `slice[T]?`, not a Go-specific runtime container.

The small Go layer still distinguishes nil from non-nil empty, preserves nil
through zero-length slicing/copy cases as required, maps bounds faults to Go
panic, and checks source-width bounds before native `int32` endpoints.
Native descriptor equality, CLR-default elements and CLR exception classes
do not become Go semantics automatically. Maximum representable buffer sizes
are a declared platform/profile limit; never truncate large Go indices.
An input outside a declared representable domain is an explicit unsupported
boundary, not a successful translation with a fabricated Go result.

For proposed `bytestring`, `readonly slice[uint8]` can be an internal building
block, but read-only permission is not immutable backing storage. The reusable
library must own/copy bytes when writable siblings could otherwise change
them. Its content equality and default empty value remain distinct from
native descriptor equality and nullable-slice nilness.

**References: ADR-0188 / #4330.** Reuse `managed[T]` /
`readonly managed[T]`, nominally `Gsharp.Values.ManagedRef<T>` /
`ReadOnlyManagedRef<T>` in `Gsharp.Runtime.Values`. Go mutable pointers
normally need the nullable writable form; never infer readonly merely because
one function does not mutate. Existing borrowed `ref` remains useful inside
non-escaping segments and at verified CLR calls.

Plan one promoted root per dynamic Go variable instance across early aliases,
closures and handles; package-state fields are ordinary object-owned origins.
Copy by-value parameters/receivers before addressing that copy. Imported
arbitrary byrefs, borrowed struct `this`, stack spans, unmanaged storage and
static/thread-static origins are not newly eligible. Do not box an imported
byref's current value and call it the original pointer. Pointer equality uses
the admitted location contract, not `ReferenceEquals` on handle objects;
zero-size/unsafe address observations remain outside this profile.

#### Fixed-array family contract

Native slices solve outer-buffer sharing,
not the value semantics of `[][2]float64`. Generate a small ordinary two-field
stereo value and a ten-field value for the initial admitted shapes, preserving
Go type IDs; dynamic indexing lowers to checked field selection and nested
element mutation uses the original addressable slot. A property returning a
copy is not a writable element. Do not allocate an inner CLR array per frame.
Slicing a field-backed fixed array cannot share a contiguous `T[]` without a
new representation: keep it unsupported, not a hidden `ToArray()` copy.
Broader fixed-array lengths/types, nested shapes, persistent element locations
and array/slice interoperability require a witnessed value-array design before
their dependent package closes.

The initial proposed array profile admits only `[2]float64` and `[10]float64`
(and Go-defined names over those shapes), as standalone values, ordinary
struct fields and native-slice elements. Each generated value contains exactly
two or ten `float64` fields, not a reference to an inner array. Length,
element type and any defined-name identity belong to the Go type descriptor.
An alias retains its original Go type identity. CLR layout coincidence never
makes distinct Go types identical.

```text
Array2F64.Zero() -> Array2F64
Array2F64.Get(value: Array2F64, index: int64, site: SourceSite) -> float64
Array2F64.Set(location: ref Array2F64, index: int64,
    value: float64, site: SourceSite) -> void
Array2F64.Equal(left: Array2F64, right: Array2F64) -> bool
// Array10F64 supplies the same operations with ten fields.
```

These are private generated helpers over ordinary value types. The signatures
show the selected 64-bit Go `int`; other admitted operand widths specialize
ordinary typed checks without exporting a universal index wrapper.

Assignment, argument, return, interface insertion and value-range snapshots
copy all fields. Equality compares each element using Go floating equality:
NaN is unequal to itself, while signed zeros compare equal. Future hashing
must respect that equality; CLR `Double.Equals` is not the equality helper.
Default storage is all zero. Reads and writes validate the original index
against 2 or 10 before a checked field dispatch; an invalid switch arm cannot
return zero or write a default field.

For `frames[i][j] = rhs`, normalization retains the outer descriptor and
evaluated indices at their required evaluation points, then writes through
the original element slot. The helper receives a segment-local borrowed
`ref Array2F64`, not a property-returned copy. Compound assignment selects
that location once. Native `Slice<T>` already exposes a ref-returning indexer;
using it must pass the array family's own ILVerify and alias witnesses.
No borrow crosses suspension or an unknown call boundary.

Other lengths/element types, nested fixed arrays, slicing these field-backed
arrays, pointer-to-array range and escaping element addresses report
`fixed-array-storage` with the exact shape and operation. Array whole-value
copies cannot conceal an allocation, and streaming storage must not allocate
one inner CLR array or box per frame. Additional shapes require storage and
performance evidence, not a generic `T[]` fallback or a new native-array
language contract in this ADR.

**Captures/adaptation: ADR-0189 / #4329.** Explicit initializer fields snapshot;
free variables in bodies share lexical bindings. Use native captures and
static `adapt[I](source)` forwarding where their bounded member surface
matches. Native adaptation already covers generic methods, properties,
indexers, events and ref contracts. The initial **Go translator profile**
admits only nongeneric by-value instance method signatures; broader surfaces
remain independently gated there. This is not a missing native capability.
Extension methods are not automatic structural candidates.

Implement Go interface values with a small Go-specific tagged value/descriptor
layer and generated direct dispatch bridges. Store the original Go dynamic
type and value/pointer mode independently of the adapter. Insertion of a
value copies it; pointer insertion preserves the location. An interface with
a nil pointer payload is non-nil and can call a pointer-receiver method that
handles nil. ADR-0189 rejects adapting a null source: generate an explicit
typed-nil-aware bridge, not `adapt` on that null.

Optional-capability assertions query generated Go method-set metadata for
concrete types and closed generic instances admitted to the unit. Interface
conversion retains the original tag; wrapper creation must not alter Go
equality, type switches, hashing, or `errors.As`. Generate only demanded
interface/type bridges, without missing possibilities merely because one test
did not instantiate them. Dynamic loading of unknown Go types remains blocked
until an explicit extension metadata contract exists.

Ordinary G# interfaces keep ordinary CLR null semantics. The adapter remains
a distinct CLR wrapper implementing only its selected nominal interface;
there is no universal runtime structural search. Value receiver forwarding
still copies on each Go call, unlike mutation retained in a native adapter's
owned struct field. These are translator obligations, not amendments to
ADR-0189.

#### Interface representation and direct bridge API

The proposed interface family uses a small value `GoInterface`:
`(dynamicTypeId?, payload?)`. Both fields absent means nil interface.
A present tag selects a generated immutable `ValuePayload<T>` snapshot or a
`PointerPayload<T>` containing a nullable `managed[T]` value. A typed nil
pointer has a present pointer tag/payload and an absent handle, never an
absent interface. The box is an implementation detail, not Go identity.
Interface copies may share an immutable box. Calls/assertions cannot mutate
its stored value, and pointer payloads preserve the selected location rather
than the pointer variable.

`dynamicTypeId` is the frontend's canonical Go identity within the closed
semantic profile, resolving aliases without collapsing defined types or
`T` versus `*T`. Generate type descriptors and demanded bridges in sorted
identity order. Descriptors contain the payload kind, Go comparability and
typed copy/equality/hash operations, plus method-set bindings derived from
M0's validated source-backed authority. No runtime CLR type discovery,
reflection proxy, general method-name lookup or adapter cache is needed.

```text
GoInterface.BoxValue<T>(type: GoTypeId, value: T) -> GoInterface
GoInterface.BoxPointer<T>(pointerType: GoTypeId,
    pointer: managed[T]?) -> GoInterface
GoInterface.IsNil(value: GoInterface) -> bool
GoInterface.Convert(value: GoInterface, target: GoInterfaceId) -> GoInterface
GoInterface.TryAssert<T>(value: GoInterface, target: GoTypeId) -> (T, bool)
GoInterface.Assert<T>(value: GoInterface, target: GoTypeId, site: SourceSite) -> T
GoInterface.TryAssertInterface(value: GoInterface, target: GoInterfaceId)
    -> (GoInterface, bool)
GoInterface.Equal(left: GoInterface, right: GoInterface, site: SourceSite) -> bool
GoInterface.Hash(value: GoInterface, seed: uint64, site: SourceSite) -> uint64
Invoke_I_M(receiver: GoInterface, arguments: declared slot types)
    -> declared result types
```

These are checked generated entry points, not APIs accepting arbitrary
caller-supplied type tags or an `object[]` invocation ABI. `Convert` is used
only for a statically legal interface conversion; it preserves nil or the
original dynamic tag and payload. Assertions to interfaces instead test the
original dynamic type's Go method set. A comma-ok failure returns the target
Go zero and false; a single-result assertion faults. Concrete value assertions
return a copy; pointer assertions preserve pointer/nil identity. Type switches
test source cases in order against these same facts, with a distinct nil
case and Go's case-dependent variable type. Missing closed-world metadata
is a translation blocker, not an assertion failure.

Initially admit closed nongeneric interfaces over admitted scalar/string
values, byte/rune slices, plain structs of admitted fields, admitted array
values, and witnessed nullable pointer locations. Array payloads require the
array profile; location payloads require the location profile. Interface
methods use admitted synchronous by-value signatures. Promoted methods use
the frontend's exact selection path; an unwitnessed embedded-pointer path or
method-value capture reports `interface-bridge`. Function/map payloads,
unknown dynamically loaded types and unsupported generic instances remain
blocked. No public cross-assembly Go interface ABI is implied.

Equality first compares nilness and dynamic identity. Different dynamic
types compare false; matching comparable types compare payloads with Go
operations. Matching non-comparable dynamic types (including a nil slice)
produce a Go comparison fault, not false or CLR box equality. A struct's
static comparability can still require recursive dynamic-interface checks.
Pointer equality uses nil/location identity. Value equality uses snapshots
and preserves Go floating/blank-field rules when those fields are admitted.
Hashing includes the original dynamic identity and uses equality-consistent
payload hashing, including signed-zero normalization; non-comparable payloads
fault. Hash values need not equal Go's private hash implementation.
Defining this obligation does not admit maps.

`Invoke_I_M` dispatches through generated exact slots. A value receiver
copies the payload **on every call**, including a value method selected
through `*T`. In that case it reads/copies the current pointee; a nil pointer
faults before entering the value-method body. A pointer-receiver bridge
passes the nullable handle without eagerly dereferencing it, allowing a
method to handle nil. This distinction is independent of native `adapt`.

Generated Go descriptors stay internal to the closed composition unit.
Ordinary CLR interfaces keep CLR nullness. Any requested export to a CLR
interface requires an explicit wrapper whose fresh object identity and
typed-nil behavior are part of that boundary; arbitrary CLR objects cannot
be imported by guessing a Go type from `GetType()`. The first profile rejects
such interop as `interface-interop`. Wrapper reuse across an observable CLR
boundary is never licensed by Go interface equality.

#### Interface conversion and reuse policy

The normalization/storage plan owns Go interface semantics. Native `adapt`
is forwarding machinery, not the Go interface representation:

| Source operation | Required lowering |
| --- | --- |
| Concrete value to interface | Snapshot a fresh value at that evaluation point. Recursively preserve ordinary Go value-copy behavior while retaining the sharing of reference-like fields. Never substitute a live location merely to avoid the snapshot. |
| Pointer to interface | Capture the pointer value/location at conversion time. Later reassignment of the pointer variable does not retarget the interface payload. A nil pointer payload produces a non-nil interface through the typed-nil bridge, not `adapt` on null. |
| Existing interface assignment/copy | Preserve the original dynamic Go type tag and semantic payload. Do not infer either from an adapter's CLR type or rebuild the value through another concrete conversion. |
| Interface to interface conversion/assertion | Preserve original dynamic identity and apply Go method-set/assertion rules. A forwarding wrapper may change, but the wrapper is never the dynamic Go type. |

Interface nilness, typed-nil payloads, comparability, equality, hashing, type
switches, map keys and assertion results operate on the explicit Go dynamic
type and value/location. They never use adapter `ReferenceEquals`,
`GetType()`, unrestricted CLR equality, or G# nullability. Go typed nil is not
`T?`, `T!`, a nullable managed handle, or a nullable referent; those continue
through the existing nullability import/query rules.

A Go value-receiver call copies the receiver for **each call**. A native
adapter over a mutable struct retains one adapter-owned copy and therefore
cannot by itself implement this rule. The generated Go dispatch bridge must
make the call copy, including when one interface value is invoked repeatedly.

Wrapper reuse or conversion hoisting is allowed only when all of these proof
obligations hold:

1. the Go dynamic type and semantic payload are unchanged;
2. source evaluation, nil/assertion checks, panic timing and side effects occur
   at the same point and frequency;
3. wrapper identity cannot escape to observable G#/CLR interop, reflection,
   callbacks, storage or user code;
4. reuse does not merge mutable adapter-owned state that Go conversions keep
   independent; and
5. the proof is recorded by the normalization/storage plan rather than guessed
   by the printer.

Initial lowering may reuse explicitly retained interface values and obvious
local dominance/stability cases. Otherwise it converts at the source
evaluation point and reports the cost. There is no global adapter cache,
blanket immutable-input rule or speculative loop-invariant optimizer.
ADR-0189 continues to promise a fresh ordinary wrapper for each exposed native
G# `adapt` evaluation; go2gs cannot erase that behavior across an observable
CLR boundary.

#### Address-taking and retained-location policy

An existing Go pointer value maps to one retained managed location; repeated
dereference does not reconstruct a handle. Repeated `&local` may share a root
only for the same dynamic variable instance. Per-iteration bindings, factory
calls and addressed by-value parameter/receiver copies create distinct roots.

For `&slice[i]`, capture the selected backing owner and absolute index, not the
slice variable. Later reslicing or append reallocation must not retarget the
location. Reuse of repeated address expressions requires proof that the
selected location and every required evaluation/check are equivalent.
Reassignment, changed indices, append reallocation, replaced reference fields,
and effectful or throwing owner/index expressions defeat that proof. Never
hoist such an expression before a conditional or zero-trip loop.

A borrowed `ref` lowering is permitted only inside a proven non-escaping
segment with no retained identity requirement. It is not the default Go
pointer representation. Zero-size and unsafe pointer identity remain explicit
unsupported boundaries.

#### Versioned capability handshake

M0's existing `go2gs.analysis`/`go2gs.profile` version 1 stays unchanged,
including `migrationReady=false`. It neither advertises executable support
nor contains a compiler-capability handshake. The later translation manifest
proposes a separate **`go2gs.execution-contract` version 1** requirements
record. It binds the immutable analysis hash to an admission profile and the
following exact values:

| Required field | Representation and validation |
| --- | --- |
| `analysis` / `admission` | Analysis schema name/version/content SHA-256; admission profile ID/version/content SHA-256; sorted admitted family IDs and their contract revisions. Unknown required fields/families/revisions fail closed. |
| `go` | Requested/actual/helper Go versions and hashes, GOROOT identity, effective language versions, GOOS/GOARCH, type widths, experiments/GODEBUG, and Unicode version/table hashes. Match the analyzed profile; no host-width inference. |
| `compiler` | Published SDK package ID/version/content hash, gsc and compiler dependency hashes, and the selected syntax contract (`adr0190-additive-v1`). Repository compiler/tool source remains G# and builds with `global.json`'s previous released SDK; this PR moves no pin. |
| `nativeRuntime` | Exact assembly names, package versions and implementation/reference assembly hashes for Values and any other demanded runtime. Same display version with different bytes is a mismatch. Channels is not required for the text/value profile. |
| `libraries` | Sorted reusable-library identities, exact artifact hashes, nominal types, API/policy revisions and demanded probes, including proposed `bytestring`. Its candidate name is not proof of availability. If supplied by Values, reference that same artifact identity rather than inventing a second package. |
| `goSupport` | Separate residual compatibility-support package/version/content hash, semantic ABI revision, generated descriptor/bridge format revision and mapped API set. This covers Go nil/fault/interface/Unicode gaps, not a parallel string, integer or slice runtime. These are proposed identities; no package version is available yet. |
| `validation` | Target RID; .NET SDK, JIT/runtime and NativeAOT toolchain identities; verifier version/reference hashes; probe-suite revision and artifact hashes; profile resource/domain limits. |
| `requiredCapabilities` | Sorted unique `(capabilityId, revision, probeId, probeSourceHash)` records. No version-range guess or presence-only assembly test substitutes for a passed probe. |

Compiler/SDK pins must name available releases when implementation starts.
The first reusable-library and compatibility-support implementations may use
their own versioned, content-pinned build artifacts for corpus validation;
distributed output must pin available packages. Neither case permits an
unreleased compiler feature. If a native fix is needed, land/release it
separately and move the repository pin in its own PR under the N-1 rule. Do not replace the SDK
locally to obtain green evidence.

The driver owns small versioned probes, not a new compiler discovery API.
`CheckCapabilities(requirements, resolvedArtifacts) -> CapabilityReport`
first checks hashes and signatures, then reparses, compiles, IL-verifies and
executes the demanded probes in JIT and NativeAOT. Each result records
`passed`, `failed` or `unavailable` plus evidence/reason. Reuse is permitted
only under the complete artifact/profile/probe key. The native compiler's
own diagnostics remain additional checks, not this handshake.

| Capability | Required probe and current implementation basis |
| --- | --- |
| `native-slice-v1` | Exact nominal identity, nullable descriptor, shared subrange, capacity, ref-returning element/nested writes and copied descriptor behavior. [Slice.gs](../../src/Sdk/Gsharp.Runtime.Values/Slice.gs) supplies `Subslice`, `Create`, indexers and managed-location access; [NativeSliceTypes.gs](../../src/Core/CodeAnalysis/Symbols/NativeSliceTypes.gs) performs compiler recognition. |
| `bytestring-v1` (proposed library) | Non-null default empty, arbitrary byte preservation, ownership isolation, byte content equality/order/hash, shared immutable substrings, and explicit strict/replacement encoding policies. Pin the ordinary nominal library identity; do not infer a native alias, UTF-8 validity or Go compatibility from its name. |
| `managed-location-v1` | Nullable handles, retained owner/index after reslice/reallocation, root sharing, location equality and segment-local borrow. [ManagedRef.gs](../../src/Sdk/Gsharp.Runtime.Values/ManagedRef.gs) supplies `Borrow` and `FromArrayNative`; generated field/root support must be probed too. |
| `capture-adapt-v1` | Shared lexical cell versus initializer snapshot, one evaluation, fresh exposed wrapper and exact requested slot forwarding, including negative null-source behavior. ADR-0189's richer native surface does not expand the Go profile. |
| `go-text-values-v1`, `go-interface-v1`, `go-array-f64-v1` | Corresponding translation witnesses below, tied to the concrete emitted types, selected library policies, residual Go-support ABI and generated bridge revision. Text/value probes include source-width bounds, nil-specific native operations, one-byte UTF-8 advancement and pinned Go Unicode mapping. Native/library availability alone is insufficient. |

The first profile requires native slices, the proposed reusable byte-string
library and the residual Go text/value checks. It requires no public integer/
index/slice wrapper and no new `make` builtin or byte-string literal syntax.
Later profiles add the actual location/adaptation/capture capabilities they
use; direct interface bridges need not manufacture an unused native adapter.
Required versions/signatures or probe results that disagree produce
`capability-mismatch`; missing artifacts, tools or executable target produce
`capability-unavailable`. Neither result publishes a runnable migration
attestation. Compile-only exploration remains unverified. No copying-array,
reflection-proxy or unknown-byref fallback is allowed. Changed inputs
invalidate generated-output and validation attestations before reuse.

### 8. Demand-driven compatibility and dependency policy

Use native G# operations and existing factories first. Put reusable facilities
such as `bytestring` in an ordinary general-purpose library, available to
handwritten G# without a Go compatibility dependency. Keep only residual
Go-specific contracts in a small versioned go2gs compatibility library,
separate from the native runtime/compiler and the reusable library API.
Prefer BCL implementation behind an exact boundary where it matches.
Pinned Go Unicode mapping, typed nil and panic/recovery are not renamed
general G# features. Generate per-program type/tag/equality/dispatch metadata
and specialized helpers only when demanded; do not repackage an entire Go
runtime under G# names.

Every relevant package and used API in the original loaded graph gets an
explicit disposition. A single module can contain several dispositions:

| Disposition | Acceptance obligation |
| --- | --- |
| Translated | Active source and the relevant dependency closure pass lowering and all required stages; no hidden unsupported files. |
| Mapped / compatibility-implemented | A versioned implementation supplies the exact admitted Go contract, initialization and error behavior, with independent Go/BCL boundary witnesses. Record its managed dependency closure and unsupported members. |
| Native-adapted | An explicit, reviewed native ABI/resource/security boundary and per-platform validation. Report native dependence; this is not all-managed translation. |
| Blocked | Name the missing semantic/API/dependency/platform work and affected closure. Preserve it in denominators and cascade reports. |

Mapped standard-library packages need not have their Go implementation
internals translated. The original import graph remains recorded, while the
manifest states which complete boundary replaces those internals and which
selected APIs it covers. Do not drop a source-translated dependency's active
files through ad hoc reachability filtering to make the package appear green.

The first compatibility inventory must examine at least these contracts:

| Surface | Edges a token rename would lose |
| --- | --- |
| `fmt`, `strings`, `unicode`, `strconv` | Go formatting verbs and custom formatting/String/Error methods; byte versus rune operations; `SplitSeq` yield behavior; pinned Unicode tables rather than culture-sensitive casing; integer bases, widths, overflow and error identity. |
| `math`, `time` | Floating-point operations, rounding and special values; durations as integer nanoseconds, overflow, monotonic versus wall time, timers/tickers, time zones and parsing layouts. A CLR TimeSpan/timer is not automatically equivalent. |
| `context`, `sync`, `sync/atomic` | Cancellation propagation, deadlines, error/cause/value identity, channel completion, lock non-reentrancy and ownership, once-after-panic behavior, WaitGroup ordering/reuse rules, atomic width/order and publication. The [Go memory model][go-memory] is the contract to preserve. |
| `io`, `os`, filesystem and process APIs | Partial reads with errors, EOF identity, seek/close behavior, Unix modes/umask, symlinks and paths, environment, signals, subprocess argument arrays, exit status, pipe draining and cleanup. Match the selected OS rather than normalize security-relevant differences away. |
| `net`, `net/http`, `net/url` | URL escaping/rejection, deadlines, cancellation, redirect and header behavior, HTTP status versus transport error, proxy/TLS settings, streaming body lifetime, socket permissions and shutdown. |
| `encoding/json` | Source field names/tags and visibility, `omitempty`, nil versus empty collections, pointer presence, byte-slice encoding, custom marshal methods, number handling and decode errors. Generate Go field metadata; do not serialize mangled CLR members with default serializer options. |
| `regexp` | Go/RE2-compatible syntax, Unicode, match semantics and byte offsets, plus resource guarantees. An unrestricted backtracking .NET regex is not a transparent replacement. |

Use [errors][go-errors], [strings][go-strings], [UTF-8][go-utf8],
[iterators][go-iter], and [JSON][go-json] API contracts to select witnesses.
Reflection needed by a compatibility API is bounded generated Go metadata;
it does not declare arbitrary `reflect` supported. Error strings are tested
where contractual or consumed by the application, not assumed interchangeable
with localized BCL messages.

Cliamp's third-party requirements need their **full relevant package/native
closures** classified, not just replacements for its direct imports:

| Dependency group from the pinned module file | Recommended investigation path; no support claimed |
| --- | --- |
| Bubble Tea v2, Lip Gloss v2, charmbracelet ANSI | Preserve message/update/command execution, terminal input/output and display-width semantics. Evaluate translating their managed portions and small explicit terminal adapters. Swapping in an unrelated .NET TUI is a manual redesign, not this milestone. |
| Beep v2, oggvorbis, dhowden/tag | Begin with offline audio/value-buffer contracts; separately classify codecs, resampling, metadata, audio-device/backend and native transitive dependencies. A mock Streamer validates a fixture, not the entire Beep package. |
| go-librespot, youtube/v2, OAuth2, Google API | Inventory protocol/authentication, caching, streaming, generated clients and all transitive APIs. Use deterministic local protocol fixtures first; no substitution with a superficially similar SDK without contract evidence. |
| Gopher-Lua | Treat the VM, values, host bindings, plugin lifecycle and sandbox/resource policy as a dependency program, not a handful of callback names. A different Lua engine needs an explicit compatibility decision. |
| urfave/cli v3 | Preserve argument parsing, defaults, env/config precedence, help/error output and exit codes; a .NET CLI framework is not a mechanical mapping. |
| godbus/dbus v5, x/sys, x/text | Separate platform IPC/syscalls/native ABI from text/encoding tables. Runtime/platform-specific internals are blockers or explicit native adapters, not automatic P/Invoke declarations. |

An optional Go sidecar may unblock a separately labeled hybrid experiment,
with a versioned protocol, lifecycle, cancellation, authentication and copying/
latency constraints. It does not preserve in-process pointer identity by
magic and must never count as full managed translation or remove its Go
dependency from reports. It is not the default architecture.

CGo/Objective-C is similarly an explicit porting boundary. Retain callback
roots/handles until native unregistration and in-flight callbacks finish;
respect allocator ownership, encoding, ABI, calling convention and thread/
run-loop affinity. A Go `runtime/cgo.Handle` is not a portable integer-shaped
CLR object reference. Recovery around handle lookup must retain its narrow
meaning, not become a broad swallowed native fault. Entry-thread ownership,
system audio changes and cleanup in cliamp's macOS files require a dedicated
platform design and oracle. No arbitrary CGo-to-PInvoke conversion is promised.

### 9. Ordered verification and independent oracles

Preserve the four-stage order from cs2gs:
**translate plus reparse -> compile -> ILVerify -> behavioral/test parity**.
A failed stage short-circuits dependent stages and units. A missing compiler,
verifier, runnable target platform, oracle, or admitted native dependency
produces an unavailable/unverified state, never a pass. Translate-only is not
fully green. The fully green predicate is:

```text
succeeded == true AND unverified == false
```

It also applies only to the reported selected closure/profile; an application
with other blocked capabilities is not described as fully migrated. If an
existing result schema gives failure precedence over its aggregate unverified
flag, retain each skipped stage and reason rather than losing that information.
Any verifier suppression is narrowly documented and reported; a suppressed
real unverifiable operation cannot be labeled verified managed code.

Build two independent sides of an oracle: the unchanged original Go program
or tests under the pinned toolchain, and generated G# under pinned compiler/
runtime dependencies. Use paired deterministic drivers with the same input
fixtures, but do not generate expected values with the same lowering or
compatibility implementation being tested.

| Observation | Required oracle |
| --- | --- |
| Pure package behavior | Structured typed results, error identity/classification and byte values, not just exit zero. Include Unicode/invalid-byte, nil/empty, boundary, and rejection cases. |
| CLI/files/processes | Exit status, stdout/stderr bytes, output files and permissions where relevant, subprocess arguments and cleanup. Normalize only predeclared nondeterministic fields; never strip an unexpected error to obtain parity. |
| Buffers/DSP | Frame values, mutations of the original backing buffer, alias observations, frame-copy independence, chunk boundaries, silence/EOF and state across calls. Specify justified absolute/relative or ULP tolerances for each numerical fixture before observing G# output; no blanket audio tolerance. |
| IPC/providers | Paired local servers/clients, structured and where required wire-byte messages, errors, subscriptions, cancellation, socket permissions and shutdown. Recorded credentials are never fixtures. |
| TUI | Controlled terminal size/encoding, clock and input/message sequence, model transitions, commands and terminal-screen/escape behavior. Generic stdout comparison is not evidence of live interactive TUI parity. |
| Concurrency/native | Controlled barriers, virtual clocks where both sides can use the same seam, bounded event-trace/invariant checks, cancellation and leak checks; real platform callback and ownership probes separately. Do not demand identical schedules or infer race freedom from a few runs. |

Translate original [Go tests][go-testing] with assertions intact, including table-driven cases,
subtests, helpers, cleanup ordering, Fatal/FailNow versus nonfatal failure,
Skip, TestMain and package lifecycle. Go testing's goroutine-local termination
semantics cannot be replaced by throwing an exception a translated user
`recover` can intercept. Unsupported testing features, `t.Parallel`, fuzzing
or example/output behavior remain explicit gaps until their contracts are
implemented; do not silently serialize/drop them and declare all tests ported.

Reports track discovered, selected, translated, executed, passed, failed and
skipped tests, with original identifiers and selected package variants.
Original skips are compared as skips and remain visible; they are not passing
assertions. Missing tests or matched names alone do not establish parity.
Preserve test/feature denominators even when a dependency blocks execution.
Each semantic witness follows ADR-0154: a known wrong lowering, pre-fix
version or controlled mutant must fail the relevant assertion. Maintain
independent fixtures as well as translated tests to detect common-mode errors.

The
[prerequisite spike](../../bench/go2gs-prerequisites/README.md) is a native
mechanism and benchmark-policy gate, not a translator test. Its milestone
evidence must contain:

- the exact non-empty expected semantic row set from independent Go, pinned-tier
  JIT and NativeAOT executions, with pairwise equality;
- paired checksum equality across all three runtimes as well as stability
  across launches;
- at least five rotated launches, retained raw launch rows, raw elapsed timer
  values/frequencies, operation counts, allocated-byte totals and available
  allocation counts;
- exact repository, source, artifact, compiler, SDK, runtime, Go toolchain,
  target RID, host and tier-configuration provenance; and
- explicit unsupported witnesses where current native mechanisms cannot
  represent Go semantics without fabrication.

`--no-aot` is an exploratory iteration mode and is marked non-milestone
evidence. Missing AOT, an empty semantic set, semantic drift in only one
runtime, a paired checksum mismatch, or absent provenance fails the applicable
gate; no success-shaped default or silent fallback is permitted. The runner's
gate tests carry ADR-0154 mutants for an empty semantic set, single-runtime
semantic drift and paired checksum mismatch.
Milestone evidence also requires at least five launches from a committed
source state. The JIT environment removes ambient overrides and pins the
repository's tiered-PGO steady-state configuration; that is reproducible launch
configuration, not a false assertion that CoreCLR reports the internal tier of
every measured method.

#### M1 independent witness matrix

This is a **required future test plan**, not tests run by the design PR.
Each Go-semantic positive row needs unchanged original Go fixture source,
its input/hash and independently observed output, then generated G# in JIT
and NativeAOT.
Original Go and generated programs must not share the helper under test.
A Go-only driver may catch a fixture's fault for structured observation;
that driver does not make translated `recover` supported. Record the driver
and compare fault categories/effect traces without relying on panic text.
Library-only encoding and CLR-boundary probes use independently authored
byte/code-unit fixtures and declared outcomes. They are separately labeled,
not presented as Go semantics or as a replacement for the Go oracle.

Every admitted Go row must pass translate/reparse, compile, ILVerify and
behavioral parity in order. Repeated clean translations under different
checkout roots must produce byte-identical generated source and maps.
Mutants below are controlled *wrong lowerings* to apply during implementation
under ADR-0154, not claims of discrimination already demonstrated.

| Family / independent Go observation | Wrong lowering that must fail | Admission |
| --- | --- | --- |
| Bytes `41 c2 a2 f0 9f 98 80 ff ef bf bd`: length 11; range byte offsets `0,1,3,7,8`; separate valid replacement rune and invalid byte. Valid-only `c2 a2` still has byte length two | UTF-16 storage/indexing, including an opportunistic CLR-string path for valid UTF-8; advancing three bytes for every replacement rune | First text/value profile |
| Truncated/overlong UTF-8, surrogate encodings, embedded NUL and arbitrary bytes; compare byte order and Go `[]rune` results | Require UTF-8-valid storage; decoder coalesces invalid bytes, normalizes text, or uses culture/string comparison | First |
| Convert writable bytes/code points to `bytestring`, mutate input, convert back twice and mutate one result; shared immutable substring remains unchanged | Readonly alias or unchecked ownership transfer masquerades as immutability; conversion results expose/share writable backing | First |
| Go empty/default string versus proposed default `bytestring`; equal bytes from different owners and substrings compare equal and hash equally | Nil default, native descriptor/reference equality, or owner-based hash | First plus reusable-library hash probe |
| Go `string([]rune{-1, 0xd800, 0x110000, 0})` and reverse conversion preserve three replacement scalars followed by zero | Represent arbitrary `int32` as `System.Text.Rune`, reject instead of selecting replacement, or discard embedded zero | First |
| Empty Go string to bytes/code points, nil and non-nil empty literals/source make, len/cap and zero-length subslices | Collapse nil and empty; convert empty text to nil; G# defaults create a non-nil Go zero | First |
| Zeroed make capacity later exposed by reslicing; copied descriptors observe the same element writes | Initialize only length, clone on descriptor copy/subslice, or expose stale capacity | First |
| Negative and high-bit indices/bounds, invalid make lengths, boundary slicing and effectful operand traces | Narrow to int32 first; return empty on bounds fault; duplicate or reorder required evaluation | First |
| Exact constants, 64-bit `int` wrap, rune/byte truncation, simultaneous assignments, short circuiting and repeated loop conditions | Host-width arithmetic, checked overflow, early store, or duplicated operand | First |
| Emitted signatures/operations compose with a separately authored G# consumer using `bytestring`, concrete `int64` and native nullable slices under the released SDK | Public integer/index/slice wrappers, target `make` builtin or assumed intrinsic byte-string/literal syntax | First binding/metadata boundary probe |
| Explicit/naked named returns and early scoring exits; pinned Go `unicode.ToLower` cases including non-ASCII/supplementary runes | Snapshot results before assignment, use UTF-16 chars or .NET case mapping/table version | First; fuzzy direction only |
| Named strict/replacement policies distinguish invalid UTF-8, invalid code points and unpaired UTF-16; strict CLR conversion returns no partial result | Hidden decoder default, ignored policy, silent replacement/normalization or partial success | Reusable-library/CLR-boundary probe; only strict CLR conversion is initially admitted |
| Nil interface versus `(*T)(nil)`; nil-aware pointer method runs, value method through nil pointer faults before body | Collapse typed nil; adapt null; eagerly dereference every pointer receiver | Later interface/location |
| Insert value, mutate source; repeatedly call a mutating value-receiver method and assert a value copy | Live source alias; persistent adapter-owned receiver mutation; assertion exposes the stored box | Later interface |
| Insert pointer then reassign pointer variable; interface conversion/type switch retains original `T`/`*T` and named type | Capture variable instead of pointer value; tag by wrapper CLR type; collapse defined types | Later interface/location |
| Equal values in separate boxes; equal locations via separate handles; differing dynamic tags; nil-slice interface comparison faults | Wrapper reference equality, unrestricted CLR equality, or comparability inferred from non-nullness | Later interface |
| Equal signed-zero payloads hash equally; NaNs remain unequal; nested interface fields preserve comparison faults | CLR `Double.Equals`, raw signed-zero hash bits, or suppress recursive faults | Later interface/array as required |
| Captured binding versus initializer snapshot, per-iteration roots and addressed parameter copy | Copy live captures, share distinct dynamic roots, or retain caller storage for a by-value parameter | Later location/capture |
| Copy `[2]float64`/`[10]float64`, then mutate one; compare zero, signed zero and NaN elements | Inner CLR arrays alias; native `[N]T` treated as Go value; CLR float equality | Later fixed-array |
| `frames[i][j]` and compound writes with effectful indices reach the caller; invalid indices fault | Mutate property copy, evaluate index twice, wrap large index, or default invalid field selection | Later fixed-array |
| Unsupported array length/nesting/slicing/escaping element address | Emit a copied `ToArray` view or an unowned/unknown byref | Rejection gate for array family |
| Independently remove/change compiler, Values, bytestring library or residual Go-support hash, required slot/policy revision, target or AOT availability | Accept display-version equality, assume bytestring exists, silently fall back, or report unavailable as passed | Every demanding profile |
| Add `go`, nil-channel receive, select, sync use, a concurrent initializer or hidden suspending callback to a valid fixture | Execute synchronously, erase unused syntax, block a worker or publish partial success | First-profile rejection |
| Add map write, defer/recover, iterator-function range or an unmapped dependency API | Stub or silently drop control effects/API; mistake named-result support for defer support | First-profile rejection |
| Repeated emission/source maps and stage status under compile, verifier, parity or tool-availability failure | Random/hash-order names, absolute paths, skipped stages marked green, or stale attestation reuse | Every profile |

Negative witnesses assert the proposed reason key, original source span,
affected closure and **no published successful translation**. Loader-invalid
Go remains a frontend error, not an unsupported-lowering witness.
Hashing tests compare Go-equal values and Go comparison behavior, not Go's
unexported hash bits. Allocation witnesses belong to the separate performance
gate; semantic parity alone cannot establish no per-frame allocation.

Reports keep three independent decisions: semantic support for the exact
admitted family, completed verification for the selected closure, and
performance readiness under approved budgets. A missing NativeAOT run is
unverified, not a verified semantic milestone. A fully verified family may
still have a performance blocker. Preserve #4511/#4512/#4513 policy without
adding a universal Go speed ratio or treating this document as a benchmark.

### 10. Diagnostics, ownership, and coverage ratchets

Diagnostic identifiers and serialization are a go2gs contract, not reused
`GS` compiler errors. Keep source language and root-cause category distinct:

| Category | Owner/action |
| --- | --- |
| Loader/toolchain/platform failure | Missing/version-mismatched tooling, unresolved modules, type errors in original source, unavailable exports/CGo/SDK or unsupported execution host. Preserve original tool diagnostics; do not file as gsc defects. |
| Translator unsupported construct | Known Go syntax/type/control/storage form has no admitted lowering. Name the exact subcase and feature gate. |
| Translator defect | Invariant violation, corrupt interchange, invalid generated syntax or a wrong lowering. A failed reparse starts here unless reduced evidence proves a parser defect. |
| Compatibility-library gap | An understood Go API contract/member is missing or mismatched in the mapped implementation. |
| Dependency blocker | A package/native/library boundary has no approved disposition; show its transitive dependents and the original dependency edge. |
| Intentional G# semantic boundary | Go requires semantics not supplied by a chosen native G# operation; use explicit compatibility or a separate capability proposal, not a bogus compiler bug. |
| Actual gsc defect | Valid G# with a promised contract fails binding/emission/execution in a reduced reproduction. Include emitted G# and evidence against that contract. |
| IL error | Verification fails for emitted managed code; retain method/token, references and verifier version. Investigate compiler versus intentional unsafe boundary without guessing. |
| Parity failure | A successful build disagrees with the independent oracle. Record inputs, expected/actual structured observations, stage/profile and applicable tolerances. |

Attach Go and generated spans, package/variant and type/symbol identities,
tool versions, dependency/profile fingerprints, expected/actual evidence, and
the smallest legal reproduction available. Reductions must retain imports,
initialization, build selection and alias relationships needed to reproduce;
a snippet with no semantic context is not automatically minimal evidence.
Redact secrets and private source before publishing any issue.

Deduplicate by category, normalized construct/type/diagnostic and relevant
semantic profile, excluding timestamps and workstation paths. Keep occurrence
sites and affected closures separately. One blocked compatibility package may
cause many skipped dependents; report one root blocker with its cascades, not
many fabricated compiler regressions. Do not automatically file issues or
submit source to a service during translation.

Ratchet exact banked `(package or fixture, feature set, platform/profile,
stage floor)` tuples. A banked case cannot regress without an explicit reviewed
change. New unsupported cases and blockers remain visible. Report loaded
packages and feature sites as counts with clear denominators; do not infer
supported coverage from physical line counts, successful syntax emission, or
excluding the application's difficult dependencies.

### 11. Security, resource handling, and overhead budgets

Treat repositories, module caches, generators, build configurations, native
toolchains and original/generated test binaries as untrusted execution inputs.
Loading/building and running tests are separate explicit permissions.
Validation uses disposable working directories, least privilege, allowlisted
executables/environments, no ambient credentials, and network/device access
only for the named fixture. Offline leaf validation must not contact providers,
start audio playback, install plugins or alter desktop configuration.

Reuse ProcessRunner's argument-list invocation, concurrent output draining,
timeouts, cancellation and child cleanup where applicable. Its current
closed-stdin captured-process contract is not a TUI/interactive oracle;
introduce a narrow bounded driver/PTY boundary only for that later milestone.
Do not inherit shell interpolation, unbounded output capture, or stdin behavior
incompatible with the specified fixture. Cap logs/artifacts and report
truncation; it is not a successful comparison.
Schema-v1 producers and `validate-analysis` share a deterministic 512 MiB
artifact ceiling. Validation verifies regular-file identity and size before a
bounded read, rejects initially oversized inputs before decoding, and rejects
growth that crosses the ceiling while reading. Producer and validator also
share the payload-derived record-ID formulas listed above, so a payload edit
cannot retain a stale deterministic ID and still pass structural validation.
The validator also closes the schema-v1 file-role vocabulary and verifies each
serialized per-file AST as one bounded, iterative parent walk rather than
trusting producer-only tree construction.
This is an internal consistency check, not artifact authentication.

Canonicalize output paths under declared roots, reject traversal and symlink
escapes, and distinguish display/source-map names from paths authorized for
I/O. Preserve source notices and dependency license/provenance files during
translation; require redistribution review for translated dependencies and
native assets. Deterministic source output excludes timestamps, random IDs
and absolute developer paths. Run-time timestamps belong only in artifacts.

The selected output root must be exclusively controlled by go2gs for the
duration of locking, invalidation, and publication. M0 binds operations to an
opened root descriptor or handle, rejects symlink/reparse traversal, excludes
cooperating writers with a lock, and fails when identity drift is observed.
An actively malicious same-UID peer with equal filesystem authority is outside
this boundary: portable Unix and Windows APIs cannot make pathname removal or
rename conditional on a previously opened identity without extra privilege.
Artifact hashes and structural validation detect provenance drift; they do not
authenticate or mediate such a peer.

Use typed failures, not broad catch-and-default fallback. On cancellation or
failure, close pipes, cancel owned subprocesses, release native handles and
temporary storage, and leave a failed/incomplete manifest. Resource cleanup
must not delete user files or mask the primary diagnostic. Descriptor-relative
temporary-file opens ignore only disappearance and changed-to-symlink races;
permission and other persistent failures abort cleanup rather than spin.
Go compatibility
panic handling catches the explicitly modeled Go carrier/faults; arbitrary
CLR/native failures remain unexpected failures, not recovered nil results.

Budget translator overhead separately from translated-program performance.
Use one helper session per profile/closure, intern semantic identities, and
avoid reloading/rebinding the full graph per file. Cache only by complete
content/toolchain/profile/dependency keys. Bound specialization count, emitted
helper volume, memory, execution time and artifact size; exceeding a budget
produces an actionable incomplete result, not truncated semantic output.

M0 records cold loading time, peak memory, interchange size and counts in
`run.json`; it does not label a cache-influenced second load as a warm baseline.
Reproducible warm measurements remain later work. No new measurements are
claimed here. M1 sets reviewed regression ceilings from an established
baseline. Investigate unexpected superlinear growth before broadening the
closure. Initial runtime witnesses include no per-sample boxing/inner-array
allocation for stereo frames, allocation-free handle dereference as specified
by ADR-0188, and no hidden whole-buffer copies on subslicing. Benchmarks may
guide later optimization but never override fidelity gates.

Semantic completion and performance readiness are separate statuses at every
milestone. A semantic milestone can complete with a reported performance
blocker; it cannot be described as performance-ready until its selected
profile passes both pinned-tier CoreCLR JIT and NativeAOT budgets.
Same-runtime, shape-equivalent hand-written controls determine implementation
overhead. Go results and ratios remain informational, including unusually
small non-escaping Go construction rows.

For the prerequisite mechanisms, steady-state slice/location/interface calls
must allocate zero, and generated adapter construction/allocation must match a
shape-equivalent named wrapper. For adapter reference calls and adapter
construction, the initial investigation threshold is a median of each launch's
measured/control time ratio no greater than 1.10 in each execution mode. Those
two measured rows are paired with their same-launch, same-runtime named
controls across at least five rotated launches with retained samples; this is
not a universal cross-machine promise. The #4511 gate caps immediate, retained,
first-identity and direct-readonly managed handles at 40 B/op per launch and
requires warmed identity to allocate zero. The #4512 gate requires shared-root,
retained and multi-capture rich construction to match their shape-equivalent
named controls on every launch; fresh-root construction retains its measured
once-per-dynamic-binding setup cost. No NativeAOT result hides an unreported
JIT regression.

M2 additionally needs package-specific controls and approved latency/allocation
budgets for its exact closure. M3 needs measured workload budgets and no
per-frame boxing, inner arrays, hidden slice copies, or avoidable per-sample
conversion/location creation. M4-M5 require approved representative
throughput, tail-latency, allocation-rate, GC and memory budgets per profile;
microbenchmarks alone cannot pass application readiness.

### 12. Milestones and objective rollout gates

Each milestone selects a named dependency closure and profile before work
begins. A fixture subset is labeled a fixture, not a completed application
package. The three native capability issues remain independently tracked;
using a feature depends on its implemented and verified surface, not just this
ADR or the approval of its design.

| Milestone | Semantic completion | Performance readiness |
| --- | --- | --- |
| M0: typed inventory (implemented) | Active versus ignored/test/native/embed inputs and relevant module/package edges have reproducible hashes, typed facts and classified gaps. Loader failures reproduce as incomplete inventory. Schema/profile v1 and offline analysis validation landed in #4562. No emitted/runtime semantic witnesses or `migrationReady=true` claim. | Record reproducible inventory measurements and prerequisite profiles with honest unsupported cases. Performance is evidence, not a condition for completing inventory. |
| M1: staged semantic corpus (proposed) | Freeze sections 6–7 contracts, then bank `m1-text-values-v1`; add interface/location/capture, fixed-array and other admitted families independently. Each needs original Go, JIT/AOT, ADR-0154 discrimination, deterministic text/maps, all four stages and rejected-neighbor witnesses from section 9. Do not wait for all Go control effects or concurrency before the first executable fixture. | Preserve prerequisite evidence and applicable steady-state/adapter/#4511/#4512 gates. A first text fixture does not claim readiness for an unused interface, array or concurrent workload. |
| M2: real leaf packages | `internal/fuzzy`, then `internal/tomlutil`, then `internal/deeplink` are banked separately only when each complete selected test variant/closure and paired behavior pass. Required iterator, shared-capture, wrapping, byte-limit and rejection semantics remain blockers until admitted. | Each selected package closure passes approved JIT and AOT latency/allocation budgets against package-specific same-runtime controls. |
| M3: offline audio fixtures | Source-attributed EQ/gapless and alias-sensitive ring-buffer fixtures preserve mutation, frame-copy independence, numerical/state/chunk behavior and avoid devices/network. Extracted fixtures do not mark the full `player` or Beep closure green. | The measured workload meets approved JIT/AOT latency and allocation budgets with no per-frame boxing/inner arrays, hidden slice copies, or avoidable per-sample conversion/location creation. |
| M4: headless application, IPC and providers | The actual selected application/test closures pass protocol, error/typed-nil, security rejection, cancellation, permission and shutdown/resource oracles. Omitted production dependencies and unknown optional capabilities remain visible blockers. | Each representative headless profile passes approved throughput, tail-latency, allocation-rate, GC and memory budgets in JIT and AOT. |
| M5: TUI, playback, plugins and platform matrix | Full selected cliamp closures pass controlled interactive, platform, callback/lifecycle and end-to-end gates. Every mandatory dependency has an accepted disposition; adapted/hybrid profiles remain labeled. | Each supported application/platform profile passes its approved representative JIT/AOT budgets. Synthetic microbenchmarks cannot substitute for these profiles. |

Full cliamp is the eventual gate, not evidence inferred from M2 or M3.
Implementation proceeds in focused issues/PRs, with one approved native
capability implementation at a time where sequencing requires it. This
document introduces no compiler/tool code, tests, dependencies or acceptance
status changes.

### 13. Explicit remaining implementation decisions

The architecture and fail-closed policy are selected; the following need
concrete evidence before their milestone is enabled:

| Gate | Required decision/evidence |
| --- | --- |
| M0 maintenance | Preserve implemented schema/profile v1, source-backed method authority and Linux-only complete analysis. Extra facts required by a lowerer need an explicitly versioned extension or separately validated sidecar, never reinterpretation of v1 or .NET-side rebinding. |
| First M1 runtime | Implement the section 6.1 allowlist and section 6.2 byte/zero/fault contracts with the independent matrix. Select published compiler/native-runtime pins, identify reusable-library and residual compatibility artifacts, and prove ordinary G# lowering. No product implementation is approved by a passing docs check. |
| Reusable bytestring | Approve its ordinary public library contract, nominal identity/packaging and encoding policies in a separate ADR before release. Prove immutable ownership and content semantics independently of go2gs. Native aliases/keywords/literals remain separate language work, not an M1 requirement. |
| Native integration | Implement the separate execution-contract handshake and demanded probes from section 7 without changing M0. Missing capabilities block only dependent families; never substitute copying arrays, unknown byrefs or reflection proxies. |
| Interface bridge and interop boundary | Implement and witness section 7's tagged payload, direct slots and per-call copies before admission. CLR exports, cross-unit identity and broader reuse remain deferred; native `adapt` alone is insufficient. |
| Maps and control effects | Freeze map APIs and legal lowering for eager defer, direct recovery, panic payloads and iterator nonlocal control flow before their families or dependent packages are admitted. Minimal fault transport and named results do not complete them. |
| Performance budgets | Carry the approved prerequisite control-relative threshold and integrated #4511/#4512 allocation ceilings forward, then approve representative M2-M5 profile budgets. The current spike does not approve universal application limits. |
| Value-array expansion | Prove representation, copies, equality, dynamic addressability and slice sharing for additional shapes before admitting them. A future native value-array proposal is possible but not silently included in ADR-0190. |
| Concurrency closure | Establish channel/select/memory-model witnesses and suspension propagation across functions, delegates, interfaces and foreign callbacks. Blocking I/O/locks cannot simply occupy arbitrary pooled workers forever and be called Go scheduling equivalence. |
| Separate library distribution | Specify public CLR ABI, package-private access, cross-unit dynamic type identity/adaptation and versioning before splitting the default closed-world assembly into reusable package assemblies. |
| Platform/dependency rollout | Approve each third-party closure, native ABI and redistribution scope, then record measured operational budgets and platform oracle availability. No estimate in this ADR substitutes for that audit. |

## Consequences

Positive:

- Reusing Go's own typechecker and the existing G# printer concentrates new
  work on the actual semantic differences instead of duplicating parsers.
- Typed inventory yields actionable blockers before expensive application
  translation, and independent oracles distinguish attractive output from a
  faithful port.
- Native slices, persistent references and explicit capture/adaptation are
  used as designed, remaining useful general G# capabilities rather than
  language-wide Go compatibility switches.
- Deterministic source, manifest-owned output and source maps make the result
  inspectable and maintainable outside the translator.

Costs and limits:

- Two toolchains, a versioned typed interchange, Go-specific compatibility
  contracts and independent test execution are real maintenance obligations.
- Go value arrays, dynamic interfaces, byte strings, panic/recover and
  concurrency require work beyond the three implemented native capabilities.
- Closed-world assembly composition simplifies correct dispatch but does not
  initially provide separately publishable Go-package-shaped CLR libraries
  or enforce Go package privacy on arbitrary later G# edits.
- CGo, terminal/audio systems, plugins and third-party closures may dominate
  the effort. A correct partial result will often be explicitly blocked.
  This ADR promises a method and evidence gates, not a completion date or
  a measured cliamp support percentage.

## Alternatives considered

1. **Textual Go-to-G# rewriting.** Rejected: similar punctuation hides binding,
   receiver copies, byte strings, typed nil, initialization and build variants.
   It is useful only as a throwaway syntax demonstration, not this tool.
2. **Reimplement the Go parser/typechecker in C#.** Rejected: duplicates mature
   version-sensitive semantics. A bounded Go helper is smaller and more
   authoritative.
3. **Go -> C# -> cs2gs.** Rejected: introduces another semantic translation
   boundary and still must solve Go storage/interfaces before cs2gs can help.
   Reuse the G# emit model directly instead.
4. **A universal SSA/multi-language IR and plugin framework first.** Rejected:
   neither typed inventory nor the selected corpus requires it. Add a local
   normalization operation only when a concrete lowering needs one.
5. **All structs become classes; slices become Lists or copied arrays.**
   Rejected: changes value copies, receiver semantics, aliasing and buffer
   mutation. The source witnesses exercise those differences directly.
6. **Every package becomes its own assembly and all matching interfaces are
   added to source types.** Rejected initially: introduces artificial
   dependency cycles and an unnecessary distribution ABI. Preserve the Go
   graph in metadata and use closed-unit typed bridges first.
7. **Use native `adapt` or CLR `object` as the entire Go interface system.**
   Rejected: loses original dynamic identity, method-set distinctions,
   value-copy behavior and typed nil. A small explicit Go descriptor layer is
   required; ordinary G# interfaces must not change.
8. **Replace dependencies with idiomatic .NET frameworks.** Valid for a manual
   rewrite, rejected as an unrecorded mechanical migration. Approved
   compatibility implementations must preserve specific contracts and
   independent evidence.
9. **Keep Go running behind a sidecar by default.** Useful as a transparent
   hybrid experiment, rejected as proof that the program has been translated
   to managed G#. It adds protocol/identity/lifecycle boundaries instead.
10. **Start by emitting all of cliamp and count compiling files.** Rejected:
    obscures dependency blockers and gives a misleading numerator. Inventory,
    discriminating semantic fixtures, then banked real packages provide a
    smaller and more reliable path to a full application gate.

## References

Local source links above refer to the inspected G# checkout. Application
links below are pinned; general Go documentation links describe the relevant
contracts but implementation must use the profile's exact toolchain/language
version rather than silently adopting later documentation changes.

[cliamp-commit]: https://github.com/bjarneo/cliamp/commit/4dee32c6c967cb2cc6069196e40cd3ff397deb3f
[cliamp-mod]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/go.mod
[cliamp-fuzzy]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/internal/fuzzy/fuzzy.go
[cliamp-toml]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/internal/tomlutil/sections.go
[cliamp-deeplink]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/internal/deeplink/deeplink.go
[cliamp-gapless]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/gapless.go
[cliamp-eq]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/eq.go
[cliamp-prefetch]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/live_prefetch.go
[cliamp-update]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ui/model/update.go
[cliamp-model]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ui/model/model.go
[cliamp-interfaces]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/provider/interfaces.go
[cliamp-protocol]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ipc/protocol.go
[cliamp-server]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ipc/server.go
[cliamp-mediactl]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/mediactl/service_darwin.go
[cliamp-audio]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/audio_device_macos.go
[cliamp-theme]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/theme/theme.go
[cliamp-worldmap]: https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/internal/worldmap/worldmap.go
[go-spec]: https://go.dev/ref/spec
[go-packages]: https://pkg.go.dev/golang.org/x/tools/go/packages
[go-types]: https://pkg.go.dev/go/types#Info
[go-constant]: https://pkg.go.dev/go/constant
[go-modules]: https://go.dev/ref/mod
[go-godebug]: https://go.dev/doc/godebug
[go-memory]: https://go.dev/ref/mem
[go-errors]: https://pkg.go.dev/errors
[go-strings]: https://pkg.go.dev/strings
[go-utf8]: https://pkg.go.dev/unicode/utf8
[go-iter]: https://pkg.go.dev/iter
[go-json]: https://pkg.go.dev/encoding/json
[go-testing]: https://pkg.go.dev/testing
