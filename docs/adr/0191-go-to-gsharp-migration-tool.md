# ADR-0191: go2gs - a typed Go-to-G# migration and fidelity pipeline

- **Status**: Proposed
- **Date**: 2026-09-19
- **Phase**: Tooling design; typed inventory before staged implementation
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
- **Dependency status**: ADRs 0190, 0188, and 0189 are Proposed in the
  docs-only prerequisite [PR #4332](https://github.com/DavidObando/gsharp/pull/4332).
  Approval of their design direction is not implementation availability.
  This ADR neither accepts nor changes them.

## Context

The requested tool should mechanically migrate real Go programs into
maintainable G#, with cliamp as an eventual application-scale gate, in the
same spirit as cs2gs. Similar surface syntax is not sufficient: Go values,
aliasing, initialization, interface identity, byte strings, and concurrency
have observable contracts that differ from CLR defaults.

This design uses the G# source at `dd7622098` plus proposal commit
`6ed7ef842ace8c9b973b7ff76e9100ef4999eb12`. Existing source, not historical
limitations quoted in older ADRs, determines what can be reused. In
particular, existing borrowed-reference work is not a missing feature to
reimplement, and proposed persistent handles are a different category.

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
| [Cs2Gs.CodeModel](../../tools/cs2gs/Cs2Gs.CodeModel/Cs2Gs.CodeModel.csproj), its [AST](../../tools/cs2gs/Cs2Gs.CodeModel/Ast/GTypeReference.cs), and [GSharpPrinter](../../tools/cs2gs/Cs2Gs.CodeModel/Printing/GSharpPrinter.cs) | Reuse the Roslyn-independent G# output model and printer. It references `Core`; it is not dependency-free. Add bounded native-type/operation nodes only when existing nodes cannot express the accepted output. |
| [GSharpRoundTrip](../../tools/cs2gs/Cs2Gs.CodeModel/RoundTrip/GSharpRoundTrip.cs) | Reparse every emitted file with the actual G# parser. Parsing is necessary, not evidence of semantic fidelity. |
| [CSharpToGSharpTranslator](../../tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.cs), [CSharpProjectLoader](../../tools/cs2gs/Cs2Gs.ProjectLoading/CSharpProjectLoader.cs) | Do not use as a Go frontend: they depend on Roslyn, C# binding, and MSBuild project loading. |
| [GscInvoker](../../tools/cs2gs/Cs2Gs.Pipeline/GscInvoker.cs), [ProcessRunner](../../tools/cs2gs/Cs2Gs.Pipeline/ProcessRunner.cs), [IlVerifyRunner](../../tools/cs2gs/Cs2Gs.Pipeline/IlVerifyRunner.cs), [Fingerprint](../../tools/cs2gs/Cs2Gs.Pipeline/Fingerprint.cs) | Reuse or narrowly extract process/compiler/verifier mechanics and fingerprint principles after separating C# assumptions. Do not fork these helpers. |
| [MigrationPipeline](../../tools/cs2gs/Cs2Gs.Pipeline/MigrationPipeline.cs), [CorpusApp](../../tools/cs2gs/Cs2Gs.Pipeline/CorpusApp.cs), [StageExecutionContext](../../tools/cs2gs/Cs2Gs.Pipeline/IMigrationStage.cs), [TriageArtifact](../../tools/cs2gs/Cs2Gs.Pipeline/TriageArtifact.cs) | Reuse ordered stage semantics and reporting concepts, not the contexts unchanged. C# project paths, NuGet/reference metadata, test oracles, `csFile`, and `offendingCSharpConstruct` need a Go-specific schema or a small language-neutral extraction. |

No new printer, C# reimplementation of Go binding, Go-to-C# intermediate port,
or universal multi-language compiler framework is justified.

## Decision

**Build go2gs as a small Go typed frontend and a .NET migration driver/lowerer
feeding the existing G# code model. Preserve Go-observable behavior within
explicit package, feature, dependency, and platform profiles; reject or
report every gap. Verify generated programs against independent original Go
executions. Start with inventory and semantic witnesses, not bulk rewriting
of main.go.**

Everything named `go2gs`, its commands, artifacts, helper types, and support
libraries below is **proposed**, not an installed command or implemented
compiler feature.

### 1. Fidelity contract, goals, and non-goals

Mechanical fidelity has two parts. Output should be deterministic,
human-maintainable G#: preserve names where legal, source organization,
comments and licenses, and use explicit, reviewable support calls rather than
opaque generated interpreters. More importantly, the output must preserve
program-observable values, copies/aliases, order where specified, errors,
control effects, initialization, synchronization, and external protocols.
Readability never authorizes a semantic approximation.

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
[go/types][go-types], and [go/constant][go-constant]. The selected x/tools
version is pinned when the helper is implemented; no unverified version
number or package installation is prescribed by this document.

The profile fixes entry packages and the exact source/toolchain context:

| Profile input | Required handling |
| --- | --- |
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
environment with a read-only source snapshot and isolated caches. A
metadata-only/source-scan fallback is labeled untyped and incomplete.
Neither `analyze` nor `translate` runs the target, `init` functions, tests,
`go generate`, module-provided scripts, or arbitrary MSBuild imports.

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
| Stable package/symbol/type identities | Include module/replacement identity, import path, profile/test variant, declaration identity, and instantiated type arguments. Preserve named versus alias versus unnamed types and package-qualified unexported member identity. Go-identical unnamed types must canonicalize even across packages. Do not persist process pointers or assume `packages.Package.ID` alone is a portable semantic ID. |
| Typed syntax and source coordinates | Node kinds, original and effective types, addressability, assignability, conversions, tuple/comma-ok forms, declaration/use links, lexical scopes, labels, and source comments/directives. Source byte spans and displayed positions are both needed; retain `//line` provenance rather than trusting it as a filesystem path. |
| Constants and sizes | Exact integer/rational/complex constant components, untyped category, final contextual conversions, iota values, array lengths, and target `int`/`uint`/`uintptr` sizes. Do not round through JSON floating-point numbers. |
| Calls and methods | Resolved builtin versus user call, signatures, variadic expansion, method values versus expressions, receiver type/mode, selections and embedded-field index paths, implicit address/dereference adjustments, and complete relevant method sets for `T` and `*T`. |
| Generic/interface facts | Type parameters, constraint/type-set terms, substitutions/instances, relevant satisfaction checks, comparability, embedded obligations, and struct field tags/export flags. Interface type sets are not inferred from CLR reflection. |
| Initialization/build provenance | Dependency graph, `types.Info.InitOrder`, ordered init functions and compiler input-file order, blank imports, resolved embedded assets, language versions, and source/content hashes. |

Use a bounded versioned JSON record stream with interned IDs and explicit
length/count limits. Preserve raw string/constant bytes losslessly, including
invalid UTF-8 string values, through an explicit byte encoding. Reject unknown
required record kinds and dangling IDs; diagnostics cannot masquerade as
missing optional type information. Deterministic output IDs come from
canonical declarations/types, not dictionary traversal or absolute cache paths.

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

Use three verbs initially; `translate` is the emission operation, not an
alias for a successful migration:

```sh
# Proposed commands, not commands available in this checkout.
go2gs analyze --source ../cliamp --profile cliamp-leaf.json \
  --out artifacts/cliamp-analysis
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
| Slices `[]T` | Use proposed native `slice[T]` for the non-nil payload, with an explicit nullable descriptor for Go nil. Compatibility operations preserve nil-sensitive construction, len/cap, bounds, append/copy/clear, capacity-limited subslices, and panic translation. Descriptor equality is never Go slice equality; Go slices only compare with nil. |
| Strings, bytes, and runes | Use a small immutable Go byte-string value, not `System.String` as the semantic representation. Preserve arbitrary bytes, byte indexing/slicing/length and bytewise comparison. Rune iteration reports UTF-8 byte offsets and yields the replacement rune while advancing one byte for an invalid encoding; `[]rune` is not UTF-16 `char[]`. String/byte-slice conversion copies where aliasing would be observable. Explicit CLR text adapters define encoding/error policy. |
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

### 7. Native capability integration without changing their contracts

**Slices: ADR-0190 / #4328.** Use `Gsharp.Values.Slice<T>` and
`ReadOnlySlice<T>` from proposed `Gsharp.Runtime.Values`, spelled `slice[T]`
and `readonly slice[T]`. Raw `[]T` and proposed `array[T]` remain exact CLR
arrays. The current
[BindArraySlice](../../src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.MemberLookup.cs)
copying path must not be changed globally for go2gs.

Lower to `.Subslice` for known instance operations. `.Slice` is the proposed
extension convenience facade, not an instance member declared inside the C#
`Slice<T>` runtime type. Keep exclusive endpoints and saved evaluation order.
Use the native descriptor's sharing, overlapping-copy behavior, append
capacity, and addressable value elements rather than build another
application-wide `GoSlice<T>` implementation.

The small Go layer still distinguishes nil from non-nil empty, preserves nil
through zero-length slicing/copy cases as required, maps bounds faults to Go
panic, and checks source-width bounds before native `int32` endpoints.
Native descriptor equality, CLR-default elements and CLR exception classes
do not become Go semantics automatically. Maximum representable buffer sizes
are a declared platform/profile limit; never truncate large Go indices.
An input outside a declared representable domain is an explicit unsupported
boundary, not a successful translation with a fabricated Go result.

For strings, a `readonly slice[byte]` can be an implementation building block,
but read-only permission is not immutable backing storage. The Go string
contract must own/copy data when writable siblings could otherwise change it.

**References: ADR-0188 / #4330.** Reuse `managed[T]` /
`readonlyManaged[T]`, nominally `Gsharp.Values.ManagedRef<T>` /
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

**Value arrays are a separate gate.** Native slices solve outer-buffer sharing,
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

**Captures/adaptation: ADR-0189 / #4329.** Explicit initializer fields snapshot;
free variables in bodies share lexical bindings. Use native captures and
static `adapt[I](source)` forwarding where their bounded member surface
matches. Initial automatic adaptation admits nongeneric by-value instance
methods; later borrowed/generic/property/event surfaces remain independently
gated. Extension methods are not automatic structural candidates.

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

### 8. Demand-driven compatibility and dependency policy

Keep Go-specific contracts in a small versioned go2gs compatibility library,
separate from `Gsharp.Runtime.Values` and the compiler. Prefer BCL
implementation behind a Go-preserving boundary, not a second implementation
of facilities whose semantics already match. Generate per-program type/tag/
equality/dispatch metadata and specialized helpers only when demanded.

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

Canonicalize output paths under declared roots, reject traversal and symlink
escapes, and distinguish display/source-map names from paths authorized for
I/O. Preserve source notices and dependency license/provenance files during
translation; require redistribution review for translated dependencies and
native assets. Deterministic source output excludes timestamps, random IDs
and absolute developer paths. Run-time timestamps belong only in artifacts.

Use typed failures, not broad catch-and-default fallback. On cancellation or
failure, close pipes, cancel owned subprocesses, release native handles and
temporary storage, and leave a failed/incomplete manifest. Resource cleanup
must not delete user files or mask the primary diagnostic. Go compatibility
panic handling catches the explicitly modeled Go carrier/faults; arbitrary
CLR/native failures remain unexpected failures, not recovered nil results.

Budget translator overhead separately from translated-program performance.
Use one helper session per profile/closure, intern semantic identities, and
avoid reloading/rebinding the full graph per file. Cache only by complete
content/toolchain/profile/dependency keys. Bound specialization count, emitted
helper volume, memory, execution time and artifact size; exceeding a budget
produces an actionable incomplete result, not truncated semantic output.

M0 records cold/warm loading time, peak memory, interchange/output size and
package count on a named machine/profile; these are measurements to establish,
not numbers claimed here. M1 sets reviewed regression ceilings from that
baseline. Investigate unexpected superlinear growth before broadening the
closure. Initial runtime witnesses include no per-sample boxing/inner-array
allocation for stereo frames, allocation-free handle dereference as specified
by ADR-0188, and no hidden whole-buffer copies on subslicing. Benchmarks may
guide later optimization but never override fidelity gates.

### 12. Milestones and objective rollout gates

Each milestone selects a named dependency closure and profile before work
begins. A fixture subset is labeled a fixture, not a completed application
package. The three native capability issues remain independently tracked;
using a feature depends on its implemented and verified surface, not just this
ADR or the approval of its design.

| Milestone | Selected scope and dependencies | Done / blocked criterion |
| --- | --- | --- |
| M0: typed inventory and correctness spikes | Go helper/driver boundary; cliamp selected leaf graphs and then its platform/test graph matrix. No native G# capabilities required to report blockers. | Done when active versus ignored/test/native/embed inputs and full relevant module/package edges have reproducible hashes, typed facts and classified gaps; loader failures reproduce as incomplete inventory. Include small witnesses for byte strings, simultaneous assignment, value receivers, typed nil and nil/empty slices. No bulk `main.go` emission as the first deliverable. |
| M1: semantic corpus | Small standalone Go fixtures and their explicit stdlib/compatibility closures; native ADR-0190/0188/0189 surfaces only as delivered. | Done when each admitted semantic family has an independent Go/G# witness, a discrimination witness, stable generated text/maps and all four stages green; every deliberately unsupported neighbor yields an attributed diagnostic. Fixed-array and interface-identity gates cannot be waved through by parsing. |
| M2: real leaf packages | `internal/fuzzy`, then `internal/tomlutil`, then `internal/deeplink`, with all their active files, tests and selected compatibility imports, including Unicode, strings/iterator, errors/fmt and URL rules. | Each package is banked separately only when its complete selected test variant/closure and paired behavior pass. Tomlutil stays blocked until iterator early-stop and shared captures work; deeplink until wrapping, byte limits and rejection rules match. No unrelated third-party application dependency is silently counted as covered. |
| M3: offline audio fixtures | Source-attributed fixtures from EQ/gapless and alias-sensitive ring-buffer behavior, with explicit streamer contracts, math, synchronization/atomic support, ADR-0190, required ADR-0188 origins, and real fixed-frame value lowering. | Done for the named fixtures when original buffers mutate correctly, frame copies stay independent, numerical/state/chunk behavior matches and no audio device/network is opened. Extracted fixtures do not mark the full `player` package or Beep closure green; their remaining imports/native paths stay blocked in the inventory. |
| M4: headless application, IPC and providers | Actual selected application packages/test binaries and their complete closures: initialization, serialization, context/sync, sockets/files, CLI, provider interfaces and deterministic local protocol peers. | Done per headless profile only after protocol, error/typed-nil, security rejection, cancellation, permissions and shutdown/resource behavior agree. A headless harness does not excuse omitted production dependencies; it declares its separate scope. Unknown optional capabilities or incomplete library closures block. |
| M5: TUI, playback, plugins and platform matrix | Full selected cliamp entry/test closures, Bubble Tea/Lip Gloss/ANSI, Beep/backends/codecs, Gopher-Lua, provider/network libraries, embed resources, and each supported OS/architecture/CGo configuration. | Done only with controlled interactive oracles, real supported platform/entry/callback ownership, playback/plugin lifecycle and independent end-to-end gates. Every mandatory dependency has an accepted disposition. Native-adapted/hybrid profiles are labeled as such; unresolved CGo, unsafe, reflection or Go-sidecar requirements block an all-managed claim. |

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
| M0 frontend release | Select/pin the compatible Go/x/tools versions and schema v1 encoding, freeze stable identity/constant/span rules, and demonstrate loader/offline/CGo failure provenance. |
| M1 runtime contracts | Finalize Go byte-string/map/interface/panic support APIs and the legal G# lowering for eager defer, direct recovery and iterator nonlocal control flow. A candidate that changes user-visible behavior stays blocked. |
| Native integration | Detect and pin actual compiler/runtime versions providing ADR-0190, ADR-0188 and the necessary ADR-0189 stages. Never fall back to copying arrays, unknown byrefs or reflection proxies when one is missing. |
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
  concurrency require work even after the three native proposals land.
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
