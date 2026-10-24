# ADR-0191: go2gs - a typed Go-to-G# migration and fidelity pipeline

- **Status**: Proposed
- **Date**: 2026-09-19
- **Phase**: M0 implemented; proposed capability design and M1 fidelity contracts
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
  [ADR-0182](0182-receiver-clause-is-always-extension.md),
  [Accepted ADR-0210](0210-explicit-same-type-array-copy-operations.md)
  ([#5208](https://github.com/DavidObando/gsharp/issues/5208))
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

The October 20 design direction prioritizes long-term G# capability and output
quality over time to the first executable migration. Earlier helper sketches
were bounded representation experiments, not a requirement to expose a Go
runtime vocabulary in application source. In particular, the proposed public
`GoInterface` envelope and mandatory field-backed array output are superseded
by the design tracks below. Their semantic witnesses remain requirements.

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
feeding the existing G# code model. Require both Go fidelity and maintainable
G# output. Develop reusable additive language/type-system/runtime capabilities
where existing facilities cannot meet both requirements. Design and release
those capabilities before depending on them; no first-executable deadline
justifies a parallel Go runtime in application source. Preserve explicit
profiles, fail-closed diagnostics and independent original-Go witnesses.**

M0's `analyze`, `validate-analysis`, profile and inventory contracts are
implemented. Emission, executable validation, capability designs and compatibility
support below remain **proposed**. This ADR selects a design strategy and
semantic obligations, not new language semantics, public ABI or settled syntax.
Each user-visible capability requires its own ADR and implementation decision.

### 1. Fidelity contract, goals, and non-goals

Mechanical migration has two joint requirements. Preserve program-observable
values, copies/aliases, specified order, errors, control effects, initialization,
synchronization and protocols. Also produce deterministic, human-maintainable
G#: preserve legal names, source organization, comments and licenses.
Neither readability nor fidelity excuses failure of the other requirement.

Reuse existing native facilities where they fit. For a recurring semantic
gap, evaluate an additive G# capability alongside a reusable library design,
not only after a translator-helper workaround. Prefer a facility that also
benefits handwritten G# and leaves existing programs unchanged. Keep narrowly
Go-specific policies in compatibility support. Do not disguise an entire Go
runtime as new G# features, or move its complexity into generated user code.

**Output acceptance:** application signatures and bodies use ordinary G# types,
member calls, operators, control flow and native slices. They must not require
a Go-prefixed wrapper ecosystem, visible tag/dispatch tables, repeated manual
boxing, or field-switch expansion at ordinary calls/indexes. Compiler-generated
metadata, boxes and forwarding methods can remain implementation details, as
closure machinery already does. Necessary temporaries preserve evaluation;
explicit conversions mark real encoding, ownership, capability or CLR boundaries,
not every source operation. Review representative output beside independently
written G# before admitting a family. A parseable helper-heavy listing is not
success; keep it an experiment or report `output-design-blocked`.

Ordinary CLR `string`, interfaces, null/equality, `adapt` identity and struct
instance mutation retain their current contracts. Any new semantic category
must be explicit and opt-in, including at exported metadata and BCL boundaries.
General usefulness, compatibility and understandable operations must justify it.

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

#### 1.1 Capability design tracks, not a wrapper backlog

The order below prioritizes design questions, not a delivery deadline.
Tracks can proceed independently; a profile waits only for capabilities it
uses. Each dedicated ADR must include handwritten use cases, a clean output
example, alternatives, interoperability rules and discriminating proof obligations.
Reject a proposal that merely exports Go implementation bookkeeping.

| Priority / semantic need | Existing reusable basis and remaining gap | Candidate design and decision gate | Intended application idiom |
| --- | --- | --- | --- |
| A: immutable arbitrary bytes | ADR-0204's core, UTF-8 conversion, scalar iteration and code-point collection APIs are implemented in-tree; native slices/arrays alone do not supply immutable ownership | Accepted [ADR-0204](0204-immutable-bytestring-values.md); release, separate verified pin movement and Go family admission remain distinct gates; section 6.2 | A byte-string type, ordinary operations and explicit text conversion, not string-runtime calls |
| A: interface values and receiver copies | Nominal interfaces, `adapt`, rich objects and managed locations provide slots, forwarding and storage. They do not select original Go dynamic identity, typed presence or Go call-copy semantics | Proposed [ADR-0205](0205-native-protocols-with-type-preserving-values.md) recommends native protocols, ordinary receivers and stable typed witnesses. ADR-0206 is withdrawn; Go call copies remain a separate frontend proof, not a new native receiver requirement. No design acceptance or implementation is implied | Typed method calls and paired capability tests/views; hidden witness metadata |
| B: fixed value arrays and addressable aggregates | Structs copy values; native slices/ref indexers preserve locations. Existing `[N]T` remains CLR-array-backed and keeps its source length identity and sharing | Accepted [ADR-0210](0210-explicit-same-type-array-copy-operations.md) section 9 selects SDK-owned CLR values for lengths 0-32, checked copying interop and separately retained fixed views. Implementation and production evidence are pending; fixture feasibility is not implementation. Explicit copies remain the historical alternative, not the first implementation step. Audio storage is a separate gate | Ordinary value operations only after the approved implementation, release and separate pin; ordinary indexed writes, no `Array2F64.Get/Set` calls |
| B: slices, arithmetic and evaluation | Native `slice[T]`, nullable descriptors, concrete integers, factories, managed refs and capture cells already exist | First prove ordinary lowering. Where repeated source-width checks or nil/evaluation scaffolding obscure code, evaluate general checked-index/conversion or sequencing facilities in separate ADRs. Do not add a Go slice/index wrapper or resurrect `make` | `slice[T].Create`, ordinary indexing and clear, minimal evaluation temporaries |
| C: faults, defer/recover, maps and iterator effects | Existing exceptions/control flow, native defer and collections supply mechanisms, not automatic Go equivalence | Separate semantic studies: reusable cleanup/unwinding or control-effect capabilities where justified; exact Go recovery eligibility, panic payload/version and map rules remain explicit mappings | Structured control flow and typed errors, not hand-expanded state/dispatch protocols |
| C: concurrency and suspension boundaries | Native goroutines, channels, select and suspension already supply the base | Map launch/lifetime/failure and callable boundaries, then prove channel/memory contracts. Propose only demonstrated reusable gaps; section 6.3 | Native concurrency idioms, no replacement scheduler |

There are three ownership boundaries. **Compiler/runtime implementation**
owns hidden storage, witness tables, dispatch and metadata for accepted
capabilities. **G# source design** owns useful, explicit types and operations
that handwritten programs can understand. **Go compatibility** owns source
identity correspondence, package-private method authority, pinned Unicode/API
versions and residual panic/recovery rules. Moving information behind the
compiler boundary is not permission to weaken it or add runtime reflection.
Not every Go distinction belongs in G#'s default semantics.

Before a track enables migration: approve its dedicated ADR where needed,
prove the representation and unchanged existing behavior, implement and release
it, then move the repository SDK pin in a separate verified N-1 PR.
Translator/compiler source cannot use an unreleased feature. Profiles record
the released capability revisions they require. A missing capability is a
design task with an attributed blocker, not pressure to emit unreadable code.

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
  -> accepted G# capabilities + narrow, explicit compatibility boundaries
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
matches a concrete type in an unrelated package. The selected capability
design may synthesize typed bridges in the composition unit, which can
reference both. Their metadata/dispatch need not appear in application source.
Compatibility libraries must not reference application types. The dedicated
interface design determines how compiled type evidence crosses that boundary;
this ADR does not fix a descriptor ABI or modify every source declaration to
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
at the recorded source language version. The table fixes observations and
design boundaries, not all target representations. Each admitted row needs
both reviewed G# output and discriminating witnesses. Dedicated designs may
replace candidate lowering mechanisms without weakening those obligations.

| Go construct | Selected lowering and fidelity boundary |
| --- | --- |
| Short declarations and scope | Bind `:=` by declaration identity: some names can be reused and others newly declared in the same scope. Preserve shadowing, initializer scope, `_`, if/switch/for scopes, labels and branch targets. Choose G# `let` only when later assignment/address/capture analysis permits it; token substitution is insufficient. |
| Evaluation and assignment | Materialize calls, receives, lvalue owners/indices, and RHS values at the required evaluation points, then commit multiple assignments in source order. Do not impose an invented universal Go left-to-right rule on otherwise unspecified operand ordering. Short-circuit expressions and loop conditions retain their execution frequency. Compound assignment selects a location once. |
| Multiple/named returns | Lower result tuples with exact element types. Named results have zero-initialized mutable slots; explicit return expressions fill them before deferred calls, and final results are read after defers. A naked return is not an early tuple snapshot. |
| Untyped constants and iota | Use the helper's exact constant values and contextual types, preserving repeated const expressions/iota, representability diagnostics, rounding points, and named-type conversions. Do not let G# literal inference or JSON numbers choose Go types. |
| Numeric operations | Map fixed widths explicitly; map `int`, `uint`, and `uintptr` from target sizes, not the translator host. Lower wrapping integer operations, conversions, signed division edge cases, and shifts explicitly where CLR instructions differ. Negative runtime shift counts panic; large counts must not inherit CLR masked-shift behavior. Complex arithmetic is gated until its chosen representation and operations have witnesses. |
| Struct values and receivers | Use value types with recursively correct field representation. Assignment, arguments, return, interface insertion, range values, and value-receiver calls copy values, while reference-like fields retain their own sharing. Investigate explicit copy-receiver/location-receiver facilities with hidden lowering; ordinary struct instance mutation remains unchanged. By-value functions/extensions are existing building blocks, not automatic interface method-set entries. |
| Pointers and function values | Use nullable `managed[T]?` for admitted Go pointer locations; do not spell every Go pointer as existing borrowed `*T`. Preserve nil pointer receiver calls that do not dereference their receiver. Method-value creation snapshots the proper receiver; method expressions retain explicit receiver parameters. Closures share lexical bindings. Nil functions stay distinct from a callable empty delegate; only source-legal nil comparisons are emitted. |
| Fixed arrays `[N]T` | Retain length/type identity, whole-value copies/equality and addressable nested writes. Current G# `[N]T` is CLR-array-backed and must not change silently. Accepted ADR-0210 section 9 defines a bounded CLR value contract, not yet implemented. Its CLR-comparer equality is not Go equality; fixed views are not native slices. `[2]float64` and `[10]float64` are initial proof shapes, not mandated generated classes. Unsupported nesting, growth, slicing, equality and escaping addresses stay blocked until witnessed; see section 7. |
| Slices `[]T` | Use implemented native `slice[T]` for the non-nil payload, with an explicit nullable descriptor for Go nil. Compatibility operations preserve nil-sensitive construction, len/cap, bounds, append/copy/clear, capacity-limited subslices, and panic translation. Descriptor equality is never Go slice equality; Go slices only compare with nil. |
| Strings, bytes, and runes | Use proposed reusable `bytestring`, an immutable arbitrary-byte value, not CLR `string` or an alias for `readonly slice[uint8]`. Byte indexing/length/order remain byte-based even for valid UTF-8. Go string range selects an explicit UTF-8 decoding policy with byte offsets and one-byte invalid-input advancement. Go `rune` maps to `int32`, not `char` or `System.Text.Rune`; decoded `slice[int32]` is algorithm data, not string storage. Mutable conversions copy, and CLR text conversion has an explicit encoding/error policy. |
| Maps | Select storage and readable lookup/update operations through the map design track, not a preset public Go map wrapper. Preserve nilness, zero/missing-key and comma-ok behavior, element copies/non-addressability, legal key comparability, NaN/signed-zero cases and typed-interface keys. Nil reads/deletes/clear/len remain legal; nil writes fault. Iteration must obey Go mutation rules, not `Dictionary` fail-fast enumeration or promised insertion order. |
| Equality and hashing | Generate Go equality/comparability operations for named/unnamed values, arrays, structs and dynamic interfaces. Do not inherit data-struct/CLR equality when it compares slices, compares wrapper identities, treats NaNs differently, or includes blank fields. Map hashing agrees with source equality and preserves original dynamic type distinctions. |
| Errors and wrapping | Model `error` as a Go interface value, not an exception by default. Preserve nil/typed nil, sentinel identity, formatting, wrap trees, and `errors.Is`/`As` including custom methods and target assignment. CLR exceptions at mapped I/O boundaries become the specified Go error values, not arbitrary message-only substitutes. |
| Defer, panic, recover | Preserve eager registration, function-scoped LIFO execution, named-result access and unwinding, including loop defers. Design reusable control-effect support where warranted; isolate Go recovery eligibility, per-goroutine panic and version-dependent `panic(nil)` policy. A catch around any caller or native `defer` syntax alone is insufficient. No public panic protocol is selected here. |
| Interfaces/assertions/type switches | Preserve original dynamic type, a value snapshot or pointer location, nil versus typed nil, `T` versus `*T`, method-set satisfaction and assertion failure behavior. Value assertions return copies. Evaluate an opt-in interface-value capability with hidden type evidence; neither a public `GoInterface` envelope nor `GetType()` on an `adapt` wrapper is the selected contract. |
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

#### 6.1 M1 admissions follow capability design

The proposed **`m1-text-values-v1`** is a small proving corpus, conditional on
the selected byte/value designs and their release gates. It is not a deadline
or permission to reject useful language work to get a runnable result sooner.
Its allowlist bounds evidence, not the eventual architecture. It selects Linux/amd64,
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
| Text and small buffers | Exact-byte literals through the byte-string facility selected by its ADR; library construction and dedicated literal syntax are alternatives, neither presumed shipped. Concatenation, byte length/index/two-index slicing, bytewise equality/order, `[]byte`/`[]rune` conversions and reverse string conversions. Nil slices, empty/nonempty literals, source `make`, len/cap, checked element reads/writes, two/three-index subslices and descriptor copies use native G# storage/factories plus required checks. Append/copy/clear are later slice admissions, not inferred from native support. |
| Mapped API | Only `unicode.ToLower(rune)`, using tables and rules from the selected Go toolchain. No blanket `unicode`, `strings`, `fmt` or testing-package support claim. Fixture transport is a separately specified harness, not translated application I/O. |

These operations cover the direction of pinned `internal/fuzzy/fuzzy.go`:
named results, `[]rune`, string range, `unicode.ToLower`, scoring and control
flow. This is **not** a claim that its package, test variants or dependency
boundary already migrate. Small unchanged Go programs provide initial witnesses.
Bank the complete fuzzy package only at M2, followed by `internal/tomlutil`
and `internal/deeplink`. Fuzzy tests the chosen architecture; its size does not
choose that architecture or force a schedule.

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
set after its design gates pass. Those capability designs may precede the
text corpus; their implementations are not all prerequisites for a text
witness that does not use them. Feature expansion or changed output contracts
version the admission profile, rather than silently broadening it.

#### 6.2 Byte strings, zero values and faults

**Representation and naming.** Keep G# `string` as ordinary CLR
`System.String`. Propose `bytestring` for immutable arbitrary bytes, useful
to handwritten G# as well as generated code. It is not `utf8string`: invalid
UTF-8 and embedded zero bytes are valid stored data. Even known-valid UTF-8
does not authorize CLR string emission, since byte length/index/order differ
from UTF-16 operations. Proof-based representation optimization is deferred.

The selected direction is a general-purpose immutable byte-string type.
The dedicated [ADR-0204](0204-immutable-bytestring-values.md) is Accepted.
Its core, native spelling/literals, explicit UTF-8 conversion, scalar iteration
and code-point collection APIs are implemented in-tree through #5076, #5083,
#5090 and #5096. That ADR records the handwritten examples, library/language
comparison, ownership, encoding and cost contracts. Its nominal type is
`Gsharp.Values.ByteString`; native `bytestring` spelling is compiler integration,
not a requirement for applications to declare an alias.
This status does not establish a published SDK, verified pin movement,
complete witness certification or Go family admission. The N-1 pin still
governs repository source. This ADR implements none of those APIs or gates.

An immutable owner plus offset and byte length is a candidate representation,
using native array/slice storage internally where useful. The public requirements
do not fix that layout. Default `bytestring` is non-null empty,
not Go nil or a nullable native descriptor. Copy mutable inputs at publication.
A private owned-storage transfer is permitted only for freshly allocated,
proven-exclusive storage with no surviving writable aliases; it is not a
public unchecked ownership flag. Never expose a writable backing array, span,
slice or persistent handle. `readonly slice[uint8]` alone cannot guarantee
immutability because writable siblings may exist. Immutable substrings may
share their owner; concatenation may reuse empty operands or own new storage.
Equality/order/hash consume byte content, not slice descriptor identity,
culture, normalization or UTF-16 units.

**Candidate operation surface.** The dedicated ADR-0204 now owns the proposed
public surface, including ordinary exceptions rather than paired value/error
returns. These aligned signatures remain unavailable sketches, not a settled
source or binary contract. The dedicated design includes operators, iteration
and literals instead of requiring method calls everywhere. The initial representable
storage domain uses `int32` lengths/indices. Instance operations below use
`value: bytestring`; static operations use the type name.

```text
ByteString.CopyFrom(source: readonly slice[uint8]) -> bytestring
value.ToSlice() -> slice[uint8]
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
ByteString.FromCodePoints(source: readonly slice[int32], policy: CodePointEncoding)
    -> bytestring
value.DecodeCodePoints(policy: Utf8Decoding) -> slice[int32]
value.DecodeUtf8Scalars(policy: Utf8Decoding) -> ByteString.Utf8Enumerable
value.DecodeUtf8(policy: Utf8Decoding) -> string
ByteString.EncodeUtf8(text: string, policy: Utf16Encoding) -> bytestring
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
`Strict` rejects malformed input with an encoding exception and an input
byte/code-unit/element offset. Eager conversion returns no partial value.
Lazy scalar enumeration can yield a valid prefix, then throws at the first
failed decoding position; it does not report that failure as end-of-sequence.
ADR-0204 specifies those source-independent exception and enumeration contracts.

`Utf8Decoding.ReplaceInvalidByte` emits U+FFFD and advances **one byte**
for each invalid encoding, including truncated/overlong sequences and encoded
surrogates. A valid U+FFFD encoding advances three bytes. Each scalar item
exposes its starting byte offset, scalar value and byte width.
String range saves its source once and uses this explicit policy.
`DecodeCodePoints` uses the same policy for Go `[]rune` conversion.
Its result is writable algorithm data in `slice[int32]`, not the source string
representation. Go `rune` is unrestricted `int32`; `System.Text.Rune`, which
represents a valid Unicode scalar, cannot replace it.

`CodePointEncoding.ReplaceInvalidCodePoint` encodes negative values, surrogate
values and values above U+10FFFF as U+FFFD; go2gs selects it for Go
`string([]rune)` conversion. `Strict` rejects those values instead.
`Utf16Encoding.ReplaceUnpairedCodeUnit` replaces each unpaired surrogate
on CLR-text import; paired surrogates encode their scalar normally.
No policy normalizes Unicode. If a reusable implementation lacks the exact
Go-selected policy, a small compatibility shim must supply it with independent
witnesses, or the operation stays blocked. Do not silently use a BCL decoder's
different replacement grouping.

`CopyFrom` and `FromCodePoints` snapshot mutable input.
`ToSlice` and successful `DecodeCodePoints` return independent writable
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

One **unavailable library-route sketch** illustrates ordinary G# composition.
ADR-0204 compares it with integrated spelling/literals; neither route is
accepted or compiling with today's SDK:

```gsharp
type bytestring = Gsharp.Values.ByteString
let input = slice[uint8]{0x41, 0xff, 0}
let text = bytestring.CopyFrom(input.AsReadOnly())
input[0] = 0x42
let length int64 = int64(text.Length)
let prefix = text.Subslice(0, 1)
let scratch slice[int32]? = slice[int32].Create(0, 4)
```

`text` retains bytes `41 ff 00`; `scratch` is non-nil empty with capacity four.
Either selected literal route must materialize exact bytes without a CLR
string round trip. The example needs no Go-shaped string/slice wrapper or
target `make` builtin. The final output review should also examine realistic
string range and scoring loops, not only simple construction.

**Native values and residual checks.** Emit Go `int` as concrete `int32` or
`int64` according to the source profile, not translator-host width or a
public integer wrapper. Operand signedness/width/bits belong to translator
bookkeeping, not a public universal index type. Emit ordinary typed operands,
checks and casts, or a narrowly specialized private helper when necessary.
If these repeat enough to obscure the algorithm, first evaluate a reusable
index/conversion or sequencing capability. Hidden lowering may perform many
checks; application code should not hand-expand that protocol at every access.
An additive feature must preserve existing numeric/index contracts and expose
its different behavior explicitly. A private helper is not a waiver of the
output acceptance gate.
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

The minimal witness harness may use an internal fault record
`(kind, site, source-width operands)`. This is validation/compatibility
transport, not a prescribed public `GoFault` type or generated call vocabulary.
The later control-effect design chooses its implementation. Initially
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

The candidate text/value corpus has no concurrent source. Its separate
admission therefore does not discharge these translation/design obligations:

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

The candidate text/value profile rejects `go`, channel types/creation/send/receive/
range, `select`, synchronization/atomic/context APIs, callbacks and foreign
calls. Report `concurrency-boundary` at the originating site and dependent
call edges; reject even an unused channel declaration or unreachable launch.
Do not lower a goroutine synchronously, replace nil-channel blocking with a
null exception, or use arbitrary worker blocking as a fallback.

Admit concurrency in a later profile once its explicit mappings pass the
ordered verification stages and independent original-Go/JIT/NativeAOT
witnesses. This is not a prerequisite for the first scalar/text slice and
does not imply a new scheduler or rewriting G#'s built-in concurrency.
The design work can precede that slice; there is no schedule reason to defer
a useful capability design. Unmapped call edges remain blocked. A demonstrated
gap may justify an additive callable/effect facility, with its own ADR,
implementation, release and compatibility evidence.

Maps, explicit `panic`, `defer`, `recover`, and iterator-function control
effects likewise produce `deferred-semantics`, not placeholder helpers.
Named-result slots can be admitted without defer; a later defer profile must
prove that post-defer results are read from those slots. `tomlutil` remains
blocked on map, capture and iterator contracts, while `deeplink` also needs
error/wrapping and parsing boundaries. These are not prerequisites for
`m1-text-values-v1`.

### 7. Reusable capability design with explicit compatibility boundaries

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

The lowering still distinguishes nil from non-nil empty, preserves nil
through zero-length slicing/copy cases as required, maps bounds faults to Go
panic, and checks source-width bounds before native `int32` endpoints.
Native descriptor equality, CLR-default elements and CLR exception classes
do not become Go semantics automatically. Maximum representable buffer sizes
are a declared platform/profile limit; never truncate large Go indices.
An input outside a declared representable domain is an explicit unsupported
boundary, not a successful translation with a fabricated Go result.

For proposed `bytestring`, `readonly slice[uint8]` can be an internal building
block, but read-only permission is not immutable backing storage. The chosen
facility must own/copy bytes when writable siblings could otherwise change
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

#### Fixed value arrays: design before output representation

Native slices solve outer-buffer sharing, not the value semantics of
`[][2]float64`. Existing G# `[N]T` keeps its CLR-array identity and interop;
it must not silently acquire whole-value copying.

The historical compatible alternative is operation-first.
[ADR-0210](0210-explicit-same-type-array-copy-operations.md) separates a
fresh same-type shallow copy from a store into an existing array. It ranks
spellings, including the existing `cast[[N]T](a.Clone())` idiom, and bounds a
flat-array/array-field lowering profile. Its section 8 evaluates making
existing `[N]T` a value and records #5225's fixture-only feasibility evidence.
Section 9 now selects that production recommendation: one frozen SDK-owned
compositional ABI for lengths 0-32, ordinary value/store boundaries, checked
copying bridges and separate owner-retaining fixed views. The broader element
domain, complete production lowering, promotion and release-target certification remain unproved.
The maintainer approved the production contract on October 23, 2026.
The small direct syntax footprint is not implementation evidence.
Compiler-directed copies over `T[]` do not solve uninformed CLR generic or
array-field struct copies. Implementation, certification and a breaking release
remain pending; `.copy()` is not a prerequisite implementation.
ADR-0210 F1 separately records product import and host NativeAOT witnesses.
The maintainer approved a finite verification exception on October 24, 2026,
for the two existing native-slice `AsSpan` false positives tracked by
[#5244](https://github.com/DavidObando/gsharp/issues/5244) and
[dotnet/runtime#129030](https://github.com/dotnet/runtime/issues/129030).
The full verifier still runs; exact signature/closure certificates and raw
reporting replace neither safety witnesses nor unmeasured target evidence.
Success under that exception is not strict unsuppressed ILVerify success.
This does not change M0's `migrationReady: false`.
`[]T` remains the CLR interop anchor. Native slice descriptors still share
outer storage; fixed-array element value boundaries and views over inline
storage need their own witnessed composition.

Storage is a separate decision. M3 audio requires no per-frame inner arrays
or boxes, which a `T[]` per frame cannot meet even with in-place copies.
Ordinary nominal value types, compiler-synthesized storage or inline value
storage are candidates for that gate. Two- and ten-field structs are useful
representation proofs, not required emitted application classes or a public
`Array2F64.Get/Set` API. A compiler may hide field dispatch; the migrated
algorithm must not contain switch ladders for every index.

Initial proof shapes remain Go `[2]float64` and `[10]float64`, their defined
names, fields and native-slice elements. Decide length/type identity, generic
composition, zero initialization, equality, ref-return indexing, nested
addressability and metadata before admitting a profile. An alias retains its
original identity; CLR layout coincidence never merges distinct Go types.
General-purpose equality may require an explicit Go mapping for floating or
blank-field rules rather than changing existing CLR equality.

Assignment, argument, return, interface insertion and value-range snapshots
copy all fields. Equality compares each element using Go floating equality:
NaN is unequal to itself, while signed zeros compare equal. Future hashing
must respect that equality; CLR `Double.Equals` is not the equality helper.
Default storage is all zero. Reads and writes validate the original source-width
index against the length before narrowing or storage dispatch; an invalid
access cannot return zero or write a default field.

For `frames[i][j] = rhs`, normalization retains the outer descriptor and
evaluated indices at their required evaluation points, then writes through
the original element slot, not a property-returned copy. Compound assignment
selects that location once. Native `Slice<T>` already exposes a ref-returning
indexer; composing it with any selected array storage needs its own ILVerify
and alias witnesses. No borrow crosses suspension or an unknown call boundary.

Slicing, nested shapes, pointer-to-array range and escaping element addresses
need a coherent owner/lifetime design, including how views observe later
whole-value assignment. Field-backed values cannot expose a shared `T[]`
through a hidden `ToArray()` copy. Unproved shapes/operations report
`fixed-array-storage`, even if a smaller shape is admitted. These blockers
are design work, not a permanent two-length limit. Array copies cannot conceal
an allocation. This ADR accepts no new native-array semantics.

#### Interfaces and receivers: why an envelope was proposed, not required

The earlier `GoInterface` sketch made the missing observations explicit:
original dynamic type, absence versus a typed nil payload, and value versus
location storage. It was one bounded implementation experiment. It does not
follow that applications need that type, public boxing APIs or generated
`Invoke_I_M` calls. That output contract is withdrawn, not renamed.

Current G# has substantial reusable machinery:

- [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md)
  supplies rich objects, lexical captures and explicit static adaptation.
  [Binder.BindStructuralAdaptation](../../src/Core/CodeAnalysis/Binding/Binder.gs)
  builds exact forwarding methods and a private source field, checks null
  sources and constructs a fresh nominal wrapper. Its registry already hides
  synthesized types/bodies from handwritten source. Generic slots, properties,
  indexers, events and ref contracts are supported native surfaces.
- [Rich-object binding](../../src/Core/CodeAnalysis/Binding/RichAnonymousObjectPlan.gs)
  and [capture lowering](../../src/Core/CodeAnalysis/Lowering/CaptureBoxingRewriter.gs)
  separate initializer snapshots from shared lexical cells. That is reusable
  storage planning, not evidence of dynamic interface-value semantics.
- [ADR-0188](0188-heap-storable-managed-references.md) and
  [ManagedRef](../../src/Sdk/Gsharp.Runtime.Values/ManagedRef.gs) provide retained
  locations, permission views, location equality and temporary borrows.
  A nullable handle can model a nil pointer payload, but does not itself
  distinguish an absent interface from a present value holding that payload.
- [Nominal interface verification](../../src/Core/CodeAnalysis/Binding/DeclarationBinder.InterfaceVerification.gs)
  and [instance receiver emission](../../src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.gs)
  preserve CLR slots and addressable struct mutation. Those contracts are
  foundations to compose with, not defects to replace.

The differences are specific, not a claim that G# cannot model Go:

| Observation | Why ordinary interfaces / `adapt` alone do not choose it |
| --- | --- |
| Nil versus typed nil | An ordinary null interface reference has no dynamic payload type. `adapt` rejects null rather than creating a present interface containing it. A distinct opt-in presence/payload model needs its own rules. |
| Original dynamic identity across views | An adapter's CLR identity/type is its wrapper. It exposes the selected nominal interface closure, not transparent source identity or every optional capability. Interface conversions must retain the original Go type independently of wrapper creation. |
| Method-set assertions | Native adaptation resolves accessible members of the static source type. Go assertions use the dynamic type's method set, including `T`/`*T`, embedding and package-qualified unexported identity. The Go frontend remains authoritative for those facts. |
| Value insertion snapshots | CLR boxing or a struct adapter can copy once, but representation-specific sharing still matters. Snapshotting an aggregate must retain its reference-like fields' sharing and not capture the source variable as a live location. |
| Copy on each value-receiver call | Native struct adapters own one mutable field; repeated calls mutate that field. Go value receivers need a fresh call copy, even when selected through a pointer. Ordinary struct instance calls must continue to mutate addressable storage. |
| Equality, hashing and assertions | Wrapper reference equality and nominal CLR tests do not implement dynamic Go comparability, copy-returning assertions or type switches. Type evidence and operation policies are needed, not necessarily a public runtime envelope. |

**Selected direction:** design reusable native protocols before admitting this
family. Proposed ADR-0205 recommends `protocol`, statically proved
`let p MyProtocol = x`, ordinary extensions as typed-witness candidates, and
paired `is`/`as` views. This is proposed syntax, not an available feature or
accepted ABI. Handwritten heterogeneous messages retaining concrete evidence
motivate that work independently of Go. Native struct conversion copies once;
ordinary instance mutation persists in the saved copy. By-value extensions keep
their existing copying semantics. Class conversion retains the evaluated object,
not the source variable. Copied-protocol ownership remains an acceptance choice.
Typed presence must distinguish absence from a present nullable payload.
No native copy-per-call/reset policy follows from Go translation.

The dedicated Proposed [ADR-0205](0205-native-protocols-with-type-preserving-values.md)
compares the source/backend candidates below. It separates bounded finite
evidence proofs from intended retroactive conformance, including future consumer
protocols and separate-library coherence. Missing evidence cannot mean false.
Its merge does not accept new semantics, implement this execution contract or
admit a Go family.
[Withdrawn ADR-0206](0206-explicit-snapshot-and-selected-location-receivers.md)
is historical context, not a receiver-mode acceptance dependency. Independent
trials already fit ordinary forwarding/local copies. Necessary protocol storage
rules and open restricted source-location projections now belong to ADR-0205;
the candidate `managed[MyProtocol](x)` is not current syntax or safe writable
covariance. Existing invariant `managed[T]` is unchanged.

The comparison must cover:

| Candidate | Benefit / reusable implementation basis | Tradeoff and required decision |
| --- | --- | --- |
| Native protocol type category | Ordinary typed calls, paired capability tests/views and concrete pattern candidates over preserved evidence; reuse static resolution and typed forwarding | Prove coherent extension witnesses, copied-value ownership, nullable recovery and emitted metadata. Location projections require separate storage/permission proofs. Keep ordinary CLR interfaces unchanged; no runtime shape search. |
| Compiler-recognized library value plus type evidence | An ordinary runtime storage type can carry hidden identity/dispatch evidence; compiler integration can expose the same clear calls/tests | Library storage alone is insufficient if users must pass tags or call universal dispatch helpers. Decide which source operations and metadata are language contracts, and their cross-assembly versioning. |
| Existing nominal interfaces with compiler-synthesized boxes/forwarders | Reuses CLR dispatch and existing adapter emission; may avoid a new runtime value layout | Separate opt-in boxing/conversion and type-inspection rules still need design. Wrapper identity, typed nil and copy receivers cannot change implicitly. Reject this route if it leaks wrappers or cannot preserve all observations. |

[ADR-0182](0182-receiver-clause-is-always-extension.md) already gives by-value
extension receivers, but extensions are not nominal method-set members. The
protocol proposal may validate them as exact typed witnesses without changing
that rule. Do not reinterpret instance methods, readonly defensive copies or
existing extension lookup. Go value receivers and nullable pointer receivers
need separately proved frontend lowering, using ordinary constructs where
sufficient. Neither a null CLR instance call nor eager dereference implements
a Go pointer body that must handle nil.

The public surface and hidden backend are different decisions. A compiler
may need tags, typed storage cells, dictionaries of exact slots or witness tables.
Generate such evidence deterministically from validated facts, not reflection
proxies or arbitrary caller-supplied tags. It belongs behind the accepted
capability's lowering/metadata boundary, not in every migrated function.
Go package/method identity correspondence and version-specific behavior can
remain narrow compatibility metadata without teaching ordinary G# every Go rule.

This **output-intent sketch** uses ordinary body syntax. `Reader` would be
declared through the proposed opt-in facility; its declaration, conversions
and type-test syntax are intentionally unresolved and unavailable today:

```gsharp
func ReadChunk(reader Reader, buffer slice[uint8]) int32 {
    return reader.Read(buffer)
}
```

The implementation must make that call preserve its proved Go receiver mapping
without an application-visible tag, `object[]` ABI or dispatch helper.
Capability queries need equally clear, statically checked source operations.
Before admitting a mapping, compare side-by-side handwritten and migrated
examples for conversion copies, typed absence, repeated calls and optional
capabilities. Native protocol instance mutation is not Go call-copy semantics.

#### Interface semantic and admission obligations

Every candidate must preserve the frontend's canonical Go identity, resolving
aliases without merging defined types or `T` versus `*T`. A nil interface
has no dynamic type; a typed nil pointer interface has one and is non-nil.
Value insertion snapshots the value; pointer insertion retains the selected
nullable location, not the pointer variable. Shared immutable boxes are a
possible backend optimization, not an observable identity promise.

Legal interface conversion retains nilness or original dynamic type/payload.
Assertions to interfaces test the original dynamic type's Go method set.
A comma-ok failure returns target zero and false; a single-result assertion
faults. Concrete value assertions return copies; pointer assertions preserve
location/nil identity. Type switches preserve source case order, the nil case
and case-dependent variable type. Missing required closed-world evidence is
a translation blocker, not an assertion failure.

After the capability ADR/release and output gates, a candidate admission
covers closed nongeneric interfaces over admitted scalars, byte strings,
byte/code-point slices, plain structs, value arrays and nullable locations.
Each payload family needs its own witnesses. Methods initially use synchronous
by-value signatures; promoted methods use the frontend's exact selection
path. Unproved embedding, method-value capture or slot mappings report
`interface-bridge`; unresolved capability design reports `output-design-blocked`.
Function/map payloads, unknown dynamic loading and unsupported generic instances
remain blocked. This scope does not imply a public cross-assembly Go ABI.

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

The Go frontend's selected call mechanism copies a value receiver **on every call**,
including a value method selected through `*T`. In that case it reads/copies
the current pointee; a nil pointer faults before entering the value-method
body. This is not a new native protocol receiver policy. Pointer-receiver lowering
passes the nullable handle without eagerly dereferencing it, allowing a
method to handle nil. This distinction is independent of native `adapt`.

Ordinary CLR interfaces keep CLR nullness, equality and BCL interoperability.
Export from the proposed opt-in facility needs an explicit conversion contract
covering wrapper identity, nil/payload behavior, snapshots and round trips.
Import cannot guess a Go identity from `GetType()`. Until that contract is
proved, the interface profile rejects this boundary as `interface-interop`.
No existing `adapt` wrapper is unwrapped or identity-elided implicitly.

#### Interface conversion and reuse policy

The translator proves the Go mapping to the selected capability. Its compiler
and runtime own that capability's implementation. Native `adapt` is reusable
forwarding machinery, not by itself the full interface-value contract:

| Source operation | Required lowering |
| --- | --- |
| Concrete value to interface | Snapshot a fresh value at that evaluation point. Recursively preserve ordinary Go value-copy behavior while retaining the sharing of reference-like fields. Never substitute a live location merely to avoid the snapshot. |
| Pointer to interface | Capture the pointer value/location at conversion time. Later reassignment of the pointer variable does not retarget the interface payload. The selected opt-in facility must preserve a present typed nil, not call `adapt` on null. |
| Existing interface assignment/copy | Preserve the original dynamic Go type and semantic payload. Do not infer either from an adapter's CLR type or rebuild the value through another concrete conversion. |
| Interface to interface conversion/assertion | Preserve original dynamic identity and apply Go method-set/assertion rules. A forwarding wrapper may change, but the wrapper is never the dynamic Go type. |

Interface nilness, typed-nil payloads, comparability, equality, hashing, type
switches, map keys and assertion results operate on the explicit Go dynamic
type and value/location. Adapter `ReferenceEquals`, `GetType()`, unrestricted
CLR equality and G# nullability alone cannot supply these rules. Go typed nil is not
`T?`, `T!`, a nullable managed handle, or a nullable referent; those continue
through the existing nullability import/query rules.

A Go value-receiver call copies the receiver for **each call**. A native
adapter over a mutable struct retains one adapter-owned copy and therefore
cannot by itself implement this rule. The frontend mapping must preserve the
call copy, including repeated calls through one interface value. Ordinary
by-value extensions or explicit local copies are possible building blocks,
not evidence of a complete admitted mapping or a need for withdrawn slot modes.

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

These obligations constrain any later optimization; they do not choose
wrapper construction as the default representation. Keep conversions at their
source evaluation point until reuse is proved. There is no global adapter
cache, blanket immutable-input rule or speculative loop-invariant optimizer.
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
| `compiler` | Published SDK package ID/version/content hash, gsc and compiler dependency hashes, and sorted required language/metadata contract revisions. Preserve `adr0190-additive-v1`; separately identify any accepted byte-string, interface-value, receiver or value-array capabilities. Repository compiler/tool source remains G# and builds with `global.json`'s previous released SDK; this PR moves no pin. |
| `nativeRuntime` | Exact assembly names, package versions and implementation/reference assembly hashes for Values and any other demanded runtime. Same display version with different bytes is a mismatch. Channels is not required for the text/value profile. |
| `libraries` | Sorted demanded library identities, exact artifact hashes, nominal types, API/policy revisions and probes. Record `bytestring` here or through its selected native-runtime artifact, plus any required compiler contract; a candidate name is not availability. Do not invent duplicate package identities for one artifact. |
| `goSupport` | Residual compatibility artifact/version/content hash, semantic ABI and Go type-correspondence/mapped API revisions. Record only what remains after capability design, such as pinned Unicode and recovery/version policy. Hidden interface dispatch may belong to the accepted compiler/runtime facility, not this package. No parallel string, integer, slice or public interface-wrapper runtime is prescribed. |
| `validation` | Target RID; .NET SDK, JIT/runtime and NativeAOT toolchain identities; verifier version/reference hashes; probe-suite revision and artifact hashes; profile resource/domain limits. |
| `requiredCapabilities` | Sorted unique `(capabilityId, revision, probeId, probeSourceHash)` records. No version-range guess or presence-only assembly test substitutes for a passed probe. |

Compiler/SDK pins must name available releases when implementation starts.
The first reusable-library and compatibility-support implementations may use
their own versioned, content-pinned build artifacts for corpus validation;
distributed output must pin available packages. Neither case permits an
unreleased compiler feature. If a native fix is needed, land/release it
separately and move the repository pin in its own PR under the N-1 rule. Do not replace the SDK
locally to obtain green evidence.

The proposed driver owns small versioned probes, not a universal compiler
discovery API. Dedicated capability ADRs determine their metadata contracts.
`CheckCapabilities(requirements, resolvedArtifacts) -> CapabilityReport`
first checks hashes and signatures, then reparses, compiles, IL-verifies and
executes the demanded probes in JIT and NativeAOT. Each result records
`passed`, `failed` or `unavailable` plus evidence/reason. Reuse is permitted
only under the complete artifact/profile/probe key. The native compiler's
own diagnostics remain additional checks, not this handshake.

| Capability | Required probe and current implementation basis |
| --- | --- |
| `native-slice-v1` | Exact nominal identity, nullable descriptor, shared subrange, capacity, ref-returning element/nested writes and copied descriptor behavior. [Slice.gs](../../src/Sdk/Gsharp.Runtime.Values/Slice.gs) supplies `Subslice`, `Create`, indexers and managed-location access; [NativeSliceTypes.gs](../../src/Core/CodeAnalysis/Symbols/NativeSliceTypes.gs) performs compiler recognition. |
| `bytestring-v1` (proposed) | Non-null default empty, arbitrary byte preservation, ownership isolation, content equality/order/hash, immutable substrings and explicit encoding policies. Pin the selected type/API and any language integration separately; do not infer a built-in, literal syntax, UTF-8 validity or Go compatibility from its name. |
| `managed-location-v1` | Nullable handles, retained owner/index after reslice/reallocation, root sharing, location equality and segment-local borrow. [ManagedRef.gs](../../src/Sdk/Gsharp.Runtime.Values/ManagedRef.gs) supplies `Borrow` and `FromArrayNative`; generated field/root support must be probed too. |
| `capture-adapt-v1` | Shared lexical cell versus initializer snapshot, one evaluation, fresh exposed wrapper and exact requested slot forwarding, including negative null-source behavior. ADR-0189's richer native surface does not expand the Go profile. |
| Interface-value / receiver / value-array capabilities (IDs not yet selected) | Dedicated ADRs must define emitted/ref-assembly metadata, nominal/structural boundaries, copy/location semantics and compatibility probes. Ordinary CLR/adapt behavior must remain unchanged. No tag layout, dispatch ABI or array spelling is assumed by this handshake. |
| `go-text-values-v1`, `go-interface-v1`, `go-array-f64-v1` | Corresponding translation witnesses below, tied to the accepted capabilities, concrete emitted types, policy revisions and residual Go support. Text/value probes include source-width bounds, nil-specific native operations, one-byte UTF-8 advancement and pinned Unicode. These are mapping-profile IDs, not public wrapper types. Native/library availability alone is insufficient. |

The candidate text profile requires native slices, the chosen byte-string
facility and residual text/value checks. Its final requirements depend on
that design; language integration may precede executable witnesses. No public
integer/index/slice wrapper or new `make` builtin is required. Other profiles
add only the capabilities they use. An interface-value implementation need
not manufacture an unused native adapter.
Required versions/signatures or probe results that disagree produce
`capability-mismatch`; missing artifacts, tools or executable target produce
`capability-unavailable`. Neither result publishes a runnable migration
attestation. Compile-only exploration remains unverified. No copying-array,
reflection-proxy or unknown-byref fallback is allowed. Changed inputs
invalidate generated-output and validation attestations before reuse.

### 8. Demand-driven compatibility and dependency policy

Use existing native operations where they fit; design reusable additive
facilities where they improve both G# and generated output. `bytestring`,
interface values and value arrays may have language, runtime and library
parts, each with an explicit approved contract. They must be useful without
a Go compatibility dependency. Keep residual Go policy in versioned support,
using BCL implementations behind exact boundaries where appropriate.
Pinned Unicode tables, Go API quirks and recovery/version policy do not become
universal G# defaults. Typed presence or copy-receiver facilities must earn
their opt-in semantics rather than merely rename Go concepts.
Synthesize demanded implementation metadata behind those boundaries. Do not
trade a compiler/runtime design task for a public generated helper ecosystem.

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
Reusable-capability and CLR-boundary probes use independently authored
G# consumers and declared outcomes. Encoding probes include byte/code-unit
fixtures. Preserve ordinary interfaces/adaptation, struct mutation and BCL
interop in explicit compatibility tests. These are separately labeled, not
presented as Go semantics or replacements for the Go oracle.

Every admitted Go row must pass translate/reparse, compile, ILVerify and
behavioral parity in order. Repeated clean translations under different
checkout roots must produce byte-identical generated source and maps.
Mutants below are controlled *wrong lowerings* to apply during implementation
under ADR-0154, not claims of discrimination already demonstrated.
Reviewed source-output fixtures additionally enforce section 1's maintainability
gate. Formatting/snapshot approval cannot prove semantics, and passing execution
cannot excuse unreadable output. The table's "First" means the candidate
text/value corpus after its capability gates, not a promised next release.

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
| Emitted signatures/operations compose with a separately authored G# consumer using the selected `bytestring` facility, concrete `int64` and native nullable slices under the released SDK | Public integer/index/slice wrappers, target `make` builtin or reliance on unaccepted byte-string/literal syntax | First binding/metadata boundary probe |
| Explicit/naked named returns and early scoring exits; pinned Go `unicode.ToLower` cases including non-ASCII/supplementary runes | Snapshot results before assignment, use UTF-16 chars or .NET case mapping/table version | First; fuzzy direction only |
| Named strict/replacement policies distinguish invalid UTF-8, invalid code points and unpaired UTF-16; strict CLR conversion returns no partial result | Hidden decoder default, ignored policy, silent replacement/normalization or partial success | Reusable-library/CLR-boundary probe; only strict CLR conversion is initially admitted |
| Nil interface versus `(*T)(nil)`; nil-aware pointer method runs, value method through nil pointer faults before body | Collapse typed nil; adapt null; eagerly dereference every pointer receiver | Later interface/location |
| Insert value, mutate source; repeatedly call a mutating value-receiver method and assert a value copy | Live source alias; persistent adapter-owned receiver mutation; assertion exposes the stored box | Later interface |
| Insert pointer then reassign pointer variable; interface conversion/type switch retains original `T`/`*T` and named type | Capture variable instead of pointer value; tag by wrapper CLR type; collapse defined types | Later interface/location |
| Equal values in separate boxes; equal locations via separate handles; differing dynamic tags; nil-slice interface comparison faults | Wrapper reference equality, unrestricted CLR equality, or comparability inferred from non-nullness | Later interface |
| Equal signed-zero payloads hash equally; NaNs remain unequal; nested interface fields preserve comparison faults | CLR `Double.Equals`, raw signed-zero hash bits, or suppress recursive faults | Later interface/array as required |
| Handwritten opt-in interface-value consumer and generated consumer use the same declared calls/tests, with implementation evidence hidden | Application-visible tags, manual boxing or `Invoke_I_M` protocol at each call; infer source identity from an adapter | Dedicated capability/output gate plus interface parity |
| Ordinary G# `adapt` remains fresh, rejects null and retains struct-field mutations; ordinary struct calls mutate addressable storage; CLR consumers see unchanged nominal contracts | Make all interfaces typed-nil-aware, unwrap existing adapters or copy every ordinary struct receiver | Separate G#/CLR compatibility gate, not a Go oracle |
| Captured binding versus initializer snapshot, per-iteration roots and addressed parameter copy | Copy live captures, share distinct dynamic roots, or retain caller storage for a by-value parameter | Later location/capture |
| Copy `[2]float64`/`[10]float64`, then mutate one; compare zero, signed zero and NaN elements | Inner CLR arrays alias; native `[N]T` treated as Go value; CLR float equality | Later fixed-array |
| `frames[i][j]` and compound writes with effectful indices reach the caller; invalid indices fault | Mutate property copy, evaluate index twice, wrap large index, or default invalid field selection | Later fixed-array |
| Generated array code uses explicit fresh copies, stores into existing arrays and ordinary indexing; existing G# `[N]T` still has its CLR-array semantics | Require per-access field-switch helpers, rebind an array that has live views or element handles, or silently change old fixed-array copy/interop behavior | Dedicated capability/output and compatibility gate |
| Unsupported array length/nesting/slicing/escaping element address | Emit a copied `ToArray` view or an unowned/unknown byref | Rejection gate until corresponding storage design is proved |
| Independently remove/change compiler, Values, selected byte/interface/array capability or residual Go-support hash, required metadata/policy revision, target or AOT availability | Accept display-version equality, assume a proposed facility exists, silently fall back, or report unavailable as passed | Every demanding profile |
| Add `go`, nil-channel receive, select, sync use, a concurrent initializer or hidden suspending callback to a valid fixture | Execute synchronously, erase unused syntax, block a worker or publish partial success | First-profile rejection |
| Add map write, defer/recover, iterator-function range or an unmapped dependency API | Stub or silently drop control effects/API; mistake named-result support for defer support | First-profile rejection |
| Later concurrent Go fixture evaluates launch operands in caller, separates child panic/recovery, observes nil/closed/buffered channels and publication; calls cross declared callable boundaries | Move launch effects into child, insert an implicit join, let parent recover child panic, or hide an unsupported suspension edge behind worker blocking | Concurrency design/admission; independent invariant traces, not identical schedules |
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
| Capability/output design blocker | Existing operations cannot meet both fidelity and readable output. Record the required additive design or narrow compatibility decision and dependent family; do not call it a compiler bug or publish helper-heavy output as complete. |
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

### 12. Capability-led milestones and objective rollout gates

There is no deadline for first runnable M1. Capability design may precede and
determine migration milestones. Section 1.1's tracks are not a commitment to
implement every idea: choose each capability after comparing clean output,
handwritten usefulness, compatibility and independent evidence.

Each execution milestone selects a named closure/profile after its required
designs are approved and available. A fixture subset is not a completed
application package. The three implemented native capabilities remain
independently tracked; new ones have separate ADRs, focused implementations,
releases and verified N-1 pin changes. This PR neither moves the SDK pin nor
authorizes unreleased language use in repository source.

| Milestone | Semantic completion | Performance readiness |
| --- | --- | --- |
| M0: typed inventory (implemented) | Active versus ignored/test/native/embed inputs and relevant module/package edges have reproducible hashes, typed facts and classified gaps. Loader failures reproduce as incomplete inventory. Schema/profile v1 and offline analysis validation landed in #4562. No emitted/runtime semantic witnesses or `migrationReady=true` claim. | Record reproducible inventory measurements and prerequisite profiles with honest unsupported cases. Performance is evidence, not a condition for completing inventory. |
| Capability design and release (proposed, independent tracks) | Resolve byte strings, native protocols and array operations/value implementation (Accepted ADR-0210) through dedicated ADRs and clean-output proofs. Protocol storage/location questions stay in ADR-0205; withdrawn ADR-0206 imposes no receiver-mode gate. Study control effects and concurrency on their own merits. Preserve existing native/CLR behavior until the approved implementation and breaking rollout gates close; implement/release selected capabilities before dependent source uses them. A decision to retain a blocker is valid; a rushed wrapper ABI is not required. | Representation probes and handwritten same-runtime controls inform choices. No design approval implies a speed claim or substitutes for #4513 workload policy. |
| M1: capability-backed semantic corpus (proposed) | Bank `m1-text-values-v1` when its chosen facilities meet both fidelity and output gates; admit interface/location/capture, value-array and other families independently as their designs mature. Each needs unchanged Go, JIT/AOT, ADR-0154 discrimination, deterministic text/maps, all four stages and rejected-neighbor witnesses. Unused concurrency/control effects are not prerequisites, but no schedule forces the text corpus ahead of their design. | Preserve prerequisite evidence and applicable steady-state/adapter/#4511/#4512 gates. A text fixture does not claim readiness for an unused interface, array or concurrent workload. |
| M2: real leaf packages | `internal/fuzzy`, then `internal/tomlutil`, then `internal/deeplink` are banked separately only when each complete selected test variant/closure and paired behavior pass. Required iterator, shared-capture, wrapping, byte-limit and rejection semantics remain blockers until admitted. | Each selected package closure passes approved JIT and AOT latency/allocation budgets against package-specific same-runtime controls. |
| M3: offline audio fixtures | Source-attributed EQ/gapless and alias-sensitive ring-buffer fixtures preserve mutation, frame-copy independence, numerical/state/chunk behavior and avoid devices/network. Extracted fixtures do not mark the full `player` or Beep closure green. | The measured workload meets approved JIT/AOT latency and allocation budgets with no per-frame boxing/inner arrays, hidden slice copies, or avoidable per-sample conversion/location creation. |
| M4: headless application, IPC and providers | The actual selected application/test closures pass protocol, error/typed-nil, security rejection, cancellation, permission and shutdown/resource oracles. Omitted production dependencies and unknown optional capabilities remain visible blockers. | Each representative headless profile passes approved throughput, tail-latency, allocation-rate, GC and memory budgets in JIT and AOT. |
| M5: TUI, playback, plugins and platform matrix | Full selected cliamp closures pass controlled interactive, platform, callback/lifecycle and end-to-end gates. Every mandatory dependency has an accepted disposition; adapted/hybrid profiles remain labeled. | Each supported application/platform profile passes its approved representative JIT/AOT budgets. Synthetic microbenchmarks cannot substitute for these profiles. |

Full cliamp is the eventual gate, not evidence inferred from M2 or M3.
Implementation proceeds in focused issues/PRs, with one approved native
capability implementation at a time where sequencing requires it. This
document introduces no compiler/tool code, tests, dependencies or acceptance
status changes.

### 13. Explicit remaining design and implementation decisions

The language-first strategy, joint output/fidelity requirement and fail-closed
policy are selected. Representations and new semantics remain proposed.
The following decisions need separate approval and evidence:

| Gate | Required decision/evidence |
| --- | --- |
| M0 maintenance | Preserve implemented schema/profile v1, source-backed method authority and Linux-only complete analysis. Extra facts required by a lowerer need an explicitly versioned extension or separately validated sidecar, never reinterpretation of v1 or .NET-side rebinding. |
| Text/value design and corpus | Resolve the byte/value capabilities and review realistic output before implementing section 6.1's allowlist. Then pin released compiler/runtime contracts and exact support artifacts and pass the independent matrix. No product implementation is approved by a docs check or compelled by a first-witness schedule. |
| Reusable bytestring | ADR-0204 is Accepted, with core/text/scalar/code-point APIs implemented in-tree. Release, separate verified N-1 pin movement, remaining witness certification and Go admission are independent gates. This ADR does not accept a migration mapping or change CLR `string`. |
| Native integration | Implement the separate execution-contract handshake and demanded probes from section 7 without changing M0. Missing capabilities block only dependent families; never substitute copying arrays, unknown byrefs or reflection proxies. |
| Protocol values and ordinary receivers | Proposed ADR-0205 covers native declarations/conversions, retroactive typed witnesses, paired is/as, one-time shallow copies, persistent instance mutation and open ownership/location-view decisions. ADR-0206 is Withdrawn, not an acceptance gate. Go call-copy and pointer mappings need independent proof without changing native receiver semantics. No public `GoInterface` or universal tag layout is mandated. |
| CLR and separate-library boundary | Specify explicit conversion, wrapper identity, round trips, public ABI, package privacy and cross-unit type evidence before exposing interface values or distributing package assemblies. Unknown imported types stay blocked; ordinary BCL interop must not change. |
| Maps and control effects | Design readable eager defer, direct recovery, panic payloads, map behavior and iterator nonlocal control flow. Evaluate reusable language support separately from Go-specific policy. Minimal internal fault transport and named results do not complete these contracts. |
| Performance budgets | Carry the approved prerequisite control-relative threshold and integrated #4511/#4512 allocation ceilings forward, then approve representative M2-M5 profile budgets. The current spike does not approve universal application limits. |
| Fixed value arrays | Accepted ADR-0210 section 9 selects SDK-owned values for lengths 0-32, explicit CLR copying bridges, retained fixed views and CLR-comparer equality. The maintainer approved all four concrete choices; F1-F4 define the ABI/import, lowering, location and rollout slices. Implementation/certification, release and separate N-1 pin movement precede source adoption. Go equality, named identity, pointers and audio remain separate proof gates. Approval does not change existing `[N]T` lowering, allocation inference or ADR-0190. |
| Numeric/index/evaluation ergonomics | Prove concrete-width operations and native nullable slices first. If exact checks obscure the algorithm, design additive reusable operations with explicit semantics; no universal Go integer/index wrapper or revived `make`. |
| Concurrency closure | Preserve section 6.3's native basis and launch/lifetime/failure rationale. Map suspension across functions, delegates, interfaces and callbacks, plus channel/select/memory behavior. Propose additive capability changes only for demonstrated gaps; no new scheduler is implied. |
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
- New capability designs can strengthen handwritten G# as well as migration
  output. Fidelity and readability are reviewed together, not traded for an
  earlier executable milestone.
- Deterministic source, manifest-owned output and source maps make the result
  inspectable and maintainable outside the translator.

Costs and limits:

- Two toolchains, a versioned typed interchange, Go-specific compatibility
  contracts and independent test execution are real maintenance obligations.
- Go value arrays, dynamic interfaces, byte strings, panic/recover and
  concurrency require work beyond the three implemented native capabilities.
- Dedicated language decisions, compatibility proofs, releases and N-1 pin
  changes can delay migration. That is acceptable; they must not silently
  alter existing CLR-facing semantics or become a universal runtime redesign.
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
   graph in metadata; let the selected capability synthesize closed-unit
   evidence without exposing bridge plumbing in application code.
7. **Use native `adapt` or CLR `object` as the entire Go interface system.**
   Rejected: loses original dynamic identity, method-set distinctions,
   value-copy behavior and typed nil. Additional semantic evidence is needed,
   but a public Go wrapper is not required. Evaluate opt-in language facilities
   and hidden implementation metadata while preserving ordinary interfaces.
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
11. **Freeze a Go-prefixed helper API to ship M1 sooner.** Rejected: no deadline
    justifies output that requires maintaining a parallel runtime vocabulary.
    A hidden implementation box may be appropriate; making it the application
    model without reusable language design is not.
12. **Make all G# interfaces/arrays/receivers behave like Go.** Rejected:
    breaks established CLR/adapt/value contracts and assumes every Go rule
    belongs in G#. Prefer narrowly justified additive, opt-in capabilities,
    with Go policy retained at explicit boundaries. This blanket rejection
    does not reject the scoped fixed-array value evaluation in ADR-0210.

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
