# G# compiler self-migration spike (#3394)

## Executive summary

This spike exercised the migration loop from issue #3394 rather than only
planning it:

1. translate `src/Core` from C# to G# with cs2gs;
2. round-trip parse every generated G# file;
3. compile the generated project with the current C#-implemented G# compiler;
4. fix compiler, translator, SDK-selection, and migration-harness defects;
5. repeat;
6. validate the same fixes against the pinned Oahu corpus.

The spike proves that cs2gs can translate the complete Core source tree:

- 578 C# inputs;
- 580 emitted G# files;
- zero unsupported translation diagnostics;
- every emitted file round-trip parses.

Cycle 111 proved complete Core translation and semantic compilation, reducing
the semantic frontier from 1,126 diagnostics in cycle 14 to zero. Later cycles
resolved the 163 emitted generic-ABI verification failures tracked by #3407.
Cycle 278 completed Core self-hosting with ILVerify 0 and Core.Tests at
7,661 passed / 0 failed; cycles 305-308 completed target-assembly translation,
compilation, and IL verification for gsc, gsgen, cs2gs, and gsi.

The independent Oahu gate reached full parity: all 15 projects pass
translation, compilation, IL verification, and test parity.

No generated migrated compiler source is committed. This branch contains only
durable compiler, translator, test, pipeline, harness, and documentation
changes.

## Baseline and toolchain

- Repository base: `6ceb8ef0` (`main`, including PR #3398)
- Branch: `oats/3394-gsharp-self-migration`
- .NET SDK: `10.0.301`
- gsc: `0.4.4+6ceb8ef0c4`
- local SDK package:
  `Gsharp.NET.Sdk.0.4.4-g6ceb8ef0c4.nupkg`
- Oahu commit: `0ac1fece4415d31955ae7a1dcf7da31e343d363d`

Primary Core command:

```sh
dotnet out/bin/Release/Cs2Gs.Cli/cs2gs.dll migrate \
  --diagnostic-run \
  --corpus src/Core \
  --out artifacts/issue-3394/core-cycle-N \
  --config Release
```

Final Core run:

```text
artifacts/issue-3394/core-cycle-49/2026-08-13T17-29-08Z_e7e65c
```

Final Oahu run:

```text
artifacts/issue-3394/oahu-gate/runs-cycle-6/2026-08-13T17-31-31Z_e2de53
```

## Core cycle results

Cycles 1–13 established complete translation, deterministic SDK selection, and
the first semantic compile. Cycle 14 exposed 1,126 compile diagnostics. The
remaining measured frontier was:

| Cycle | Translation | Compile diagnostics | Notes |
|---:|:---:|---:|---|
| 14 | pass | 1,126 | First complete semantic frontier |
| 15 | pass | 916 | High-fanout generic/type fixes |
| 16 | pass | 832 |  |
| 17 | pass | 785 |  |
| 18 | fail | — | Temporary translator regression |
| 19 | fail | — | Temporary translator regression |
| 20 | pass | 755 | Translation regressions repaired |
| 21 | pass | 738 |  |
| 22 | pass | 657 |  |
| 23 | pass | 654 |  |
| 24 | pass | 647 |  |
| 25 | pass | 639 |  |
| 26 | pass | 539 | Largest single later reduction |
| 27 | pass | 531 |  |
| 28 | pass | 518 |  |
| 29 | pass | 509 |  |
| 30 | pass | 499 |  |
| 31 | pass | 483 |  |
| 32 | pass | 474 |  |
| 33 | pass | 1 | Invalid result; binder stack overflow aborted analysis |
| 34 | pass | 462 | Adapter recursion fixed; real frontier restored |
| 35 | pass | 444 |  |
| 36 | pass | 430 |  |
| 37 | pass | 412 |  |
| 38 | pass | 359 |  |
| 39 | pass | 359 | Diagnostic-neutral correctness fixes |
| 40 | pass | 351 |  |
| 41 | pass | 336 |  |
| 42 | pass | 320 |  |
| 43 | pass | 306 |  |
| 44 | pass | 299 |  |
| 45 | pass | 290 | Lowest intermediate count |
| 46 | pass | 292 | Final-tree remeasurement after reverted experiment |
| 47 | pass | 292 |  |
| 48 | pass | 291 | Removed generated out-variable scope regression |
| 49 | pass | **291** | Final measured frontier |

Cycle 33 is deliberately not counted as progress. Binding recursively adapted
a lambda return conversion until the compiler stack overflowed. The pipeline
then observed only the diagnostic reached before the abort, masking hundreds
of later failures. Exact target-return shaping fixed the recursion and cycle 34
restored the real frontier.

## Durable fixes

### Parser and syntax

- Bounded multi-assignment lookahead to remove exponential parsing.
- Iterator accessor and local-function `yield break` support.
- Type-test/property-pattern versus if-expression disambiguation.
- Nullable array elements in generic-call lookahead.
- Newline disambiguation between indexing and following blocks.
- Receiver-clause operator versus trailing-lambda disambiguation.
- Postfix continuation after `++` and `--`.
- Composite/function type binding in `typeof`.

### Compiler binding and emit

- Nested generic symbolic type argument preservation.
- Nullable tuple-element CLR construction.
- Constructed generic enumerable/interface element substitution.
- Imported class-constraint dispatch through generic type parameters.
- Open-generic overload specificity.
- Better user-defined conversion target ranking.
- Imported array params pass-through.
- Symbolic return, out, and delegate projection for imported generic calls.
- Extension-call symbolic method argument propagation.
- Tuple-recursive generic inference.
- Deferred lambda and method-group target agreement by type signature.
- Exact lambda return adapters, avoiding recursive adapter construction.
- Conditional common typing through imported user-defined conversions.
- Stackalloc `Span<T>.Slice` concrete return projection.
- Source-type delegate materialization for constructed generic constructors,
  including capturing lambdas (`Lazy<SourceType>` no longer emits
  `Func<object>` invalid IL).
- Index-slot `??=` support where CLR default null is the valid empty value.

### cs2gs translation

- Typed property-pattern lowering.
- Declaration-site identifier sanitization.
- Nested source and metadata generic type rendering.
- Constructor initializer default argument materialization.
- Boxing/reference/typed-null cast correction.
- User-defined reference conversions remain conversion calls rather than
  `as` tests.
- Nullable sink and flow assertions.
- Multiple, mutable, and nullable negated-pattern guard hoisting.
- Generic and short-circuit pattern narrowing casts.
- Recursive capture-free static local-function SCC lifting.
- Static local-function dependency lifting.
- Cross-file nullability and foreign syntax-tree analysis safety.
- Native `out` call rendering.

### SDK, pipeline, and harness

- Current local SDK package selection.
- Isolated `NUGET_PACKAGES` for deterministic same-version SDK extraction.
- Process environment propagation through migration runners.
- Oahu clone-root `Directory.Build.props` and
  `Directory.Build.targets` isolation boundaries.

## Oahu validation

The Oahu baseline passed before migration:

- build: zero warnings and errors;
- CLI tests: 342 passed;
- Foundation tests: 2 passed;
- CLI E2E tests: 5 passed;
- smoke test: passed.

The migrated gate progressed through these frontiers:

1. Eleven projects crashed during translation with
   `ArgumentException: SyntaxTree is not part of the compilation`.
2. After guarding cross-project nullability syntax, all 15 translated; compile
   failures remained in Foundation, Decrypt, and dependents.
3. Source nested-type qualification and concrete `Span<T>.Slice` projection
   brought four projects fully green and all projects compiling except the
   Decrypt dependency chain.
4. All projects compiled; one Decrypt IL verification failure and two CLI test
   parity failures remained.
5. Symbolic capturing delegate materialization fixed the Decrypt
   `Func<object>`/`Func<MetadataItems>` stack mismatch.
6. Correct user-defined nullable reference cast translation fixed JsonNode
   string extraction in CLI tests.
7. Final rerun: 15 of 15 projects passed all four stages.

This result matters because it proves the branch's fixes against an external,
multi-project, runtime-tested corpus rather than only synthetic Core fixtures.

## Final Core diagnostic taxonomy

Final total: 291.

| Diagnostic | Count |
|---|---:|
| GS0159 | 58 |
| GS0154 | 42 |
| GS0125 | 33 |
| GS0238 | 28 |
| GS0155 | 25 |
| GS0130 | 23 |
| GS0158 | 19 |
| GS0157 | 18 |
| GS0266 | 9 |
| Other 20 diagnostic IDs | 36 |

Largest file concentrations:

| Generated file | Count |
|---|---:|
| `ExpressionBinder.Access.Accessor.gs` | 58 |
| `ControlFlowGraph.gs` | 30 |
| `DeclarationBinder.Attributes.gs` | 21 |
| `StatementBinder.Blocks.gs` | 21 |
| `OverloadResolver.Arguments.gs` | 16 |
| `Binder.gs` | 16 |
| `ReflectionMetadataEmitter.gs` | 9 |

Repeated messages show that raw diagnostic count overstates independent root
causes:

- 20 missing recursive `Add` calls plus `NewLabel`, `NewChoice`, `Collect`,
  and `Find` cascades;
- 14 unresolved `Add` calls and 8 unresolved `Where` calls after generic type
  information is lost;
- repeated pointer/pointee mismatches for `ImmutableArray<SourceType>` out
  parameters;
- paired definite-assignment diagnostics after those out calls fail;
- escaped short-circuit pattern binders;
- a smaller set of overload ambiguities, nullable/reference conversions, and
  generic construction failures.

## Proven remaining blockers

The spike minimized and filed four independent blockers:

- [#3399](https://github.com/DavidObando/gsharp/issues/3399):
  capturing recursive/mutually-recursive local functions;
- [#3400](https://github.com/DavidObando/gsharp/issues/3400):
  out/ref kind loss for imported generics over source types;
- [#3401](https://github.com/DavidObando/gsharp/issues/3401):
  params-array pass-through infers a nested array;
- [#3402](https://github.com/DavidObando/gsharp/issues/3402):
  short-circuit pattern binders escape generated scope.

### Capturing recursion (resolved — #3399)

cs2gs lifted recursive capture-free local functions on the `let`/hoist path,
which G# supports for self- and mutual recursion. Capturing recursive or
mutually recursive local functions (builders, counters, labels, other mutable
outer state) now lower to the documented G# scheme (ADR-0137 / ADR-0069): the
whole SCC of recursive sibling functions is bound as nil-initialized
nullable-function-typed `var` locals — declarations first, assignments after —
instead of plain `let`/`func` literals, because `let` is not recursive or
forward-visible across siblings (GS0130/GS0125). Sibling calls inside the
closure bodies then go through postfix null assertions, and the captured
mutable outer state stays a single shared `var` binding, preserving C#'s
shared-mutation semantics. Capture-free SCCs keep the canonical `let` path
untouched.

### Byref symbolic generics

`out ImmutableArray<Kind>` works when `Kind` is imported, but loses ref kind
when `Kind` is declared in the same compilation. Calls then compare
`*ImmutableArray<Kind>` to a value parameter and produce paired GS0154/GS0238
diagnostics.

### Params-array pass-through

`ImmutableArray.Create(values)` with `values : []Item?` infers
`ImmutableArray<[]Item?>` instead of selecting normal-form params pass-through
with `T = Item?`.

### Pattern scope

C# binders introduced in `is T x && ...` conditions are sometimes lowered into
an embedded G# if-expression. Later conjuncts and the true body then reference a
name whose generated scope has ended.

## Validation

Local validation used focused project/test gates rather than the complete
solution matrix:

- targeted Core parser/binder regressions: 236 passed;
- targeted compiler delegate/conversion emit tests: 19 passed, including
  runtime and ILVerify;
- cs2gs project sweep: 2,017 passed and exposed six changed-output/regression
  tests; all six were repaired and passed focused rerun;
- final Oahu migrated gate: 15/15 projects green.

CI remains the authority for the full repository matrix.

## Feasibility conclusion

Migration is feasible, but self-hosting is not yet proven.

The spike moved Core past the earlier translation/syntax barrier and removed
most semantic debt. Oahu's complete green result demonstrates that the
compiler and translator can already sustain a substantial real application,
including IL verification and runtime tests.

The remaining Core work is no longer a single broad "cs2gs cannot translate
the compiler" problem. It is a smaller set of compiler-language and symbolic
binding gaps with large diagnostic fan-out. Capturing recursion is the clearest
architectural gap; byref symbolic generics, params pass-through, and pattern
scope are concrete compiler/translator defects with minimal reproductions.

Required sequence remains:

1. close the minimized blockers and rerun Core until compile succeeds;
2. ILVerify the migrated Core assembly;
3. run Core test parity;
4. compile Core with the migrated Core implementation;
5. only then continue in order through gsc, gsi, gsgen, and cs2gs.

## Continuation through cycle 65

Follow-up branch `oats/3394-core-compile-continuation`, based on `02a8ca99`,
continued the same Core-first sequence. Translation and round-trip parsing
remain green. Core compile diagnostics moved:

| Cycle | Diagnostics | Milestone |
|---:|---:|---|
| 51 | 291 | Fresh-main baseline |
| 52 | 208 | #3399–#3402 root-fix cluster |
| 53 | 200 | Ref-kind local-function and scope follow-up |
| 54 | 183 | Nested negated-pattern binders |
| 55 | 157 | Generic CLR import aliases |
| 56 | 140 | Exhaustive-switch definite assignment and nullable arrays |
| 57 | 135 | Lifted-helper capture nullability |
| 58 | 127 | Pattern binders after short-circuit prefixes |
| 59 | 129 | Diagnostic-neutral nested-builder experiment |
| 60 | 123 | Inferred generic `Enum.TryParse` rendering |
| 61 | 122 | Constant-pattern binder scope |
| 62 | 116 | Explicit statement-array element typing |
| 63 | 115 | Mutable narrowing-frame locals |
| 64 | 111 | Positional-record property deduplication |
| 65 | 110 | Nullable reference interface-signature matching |
| 66 | **108** | Final remeasurement after CI repairs |

Continuation reduction is 291 → 108 (183 removed, 62.9%). From cycle 14,
Core semantic diagnostics are 1,126 → 108 (1,018 removed, 90.4%).

Durable continuation fixes include capturing recursive and mutually recursive
local-function lifting with transitive captures and by-ref mutable state;
ref/out local-function lifting; structural by-ref pointee matching; params
normal-form specificity; wider short-circuit and nested pattern-binder scope;
open generic CLR type aliases; exhaustive-switch out-parameter analysis;
nullable array-allocation element preservation; positional-record property
deduplication; and nullable-reference-insensitive CLR interface matching.

Cycle 66's largest remaining IDs are GS0155 (21), GS0159 (19), GS0158 (17),
GS0154 (11), GS0266 (6), and GS0125 (6). Core still does not compile, so
ILVerify, test parity, self-hosted Core recompilation, and downstream project
migrations remain gated exactly as before.

## Continuation through cycle 83

Branch `oats/3394-core-compile-continuation-2`, based on `bf2602b6`, moved the
Core semantic frontier from 108 to **60** diagnostics:

| Cycle | Diagnostics | Milestone |
|---:|---:|---|
| 67 | 108 | Fresh-main review baseline |
| 68 | 101 | Imported static generic managed by-ref projection; #3400 closed |
| 69 | 93 | Source collection interface element inference |
| 70 | 89 | Nested imported generic return substitution |
| 71–73 | 88 → 87 → 86 | Structural generic erasure and method-type substitution |
| 74 | 81 | Reference-nullable array/slice runtime identity |
| 75 | 74 | Named-argument convertibility-aware overload selection |
| 76 | 72 | Constructor accessibility filtering |
| 77–79 | 67 → 66 → 65 | Imported class-constraint properties and pattern access |
| 80–82 | 62 → 61 → 60 | Nullable nested-type rendering, named tuple patterns, attribute order |
| 83 | **60** | Final remeasurement |

Final run:

```text
artifacts/issue-3394/core-cycle-83-final/2026-08-16T05-20-12Z_936f92
translate: PASS
compile:  FAIL(60)
```

Continuation-2 removed 48 diagnostics (44.4%); the complete semantic effort is
now 1,126 → 60 (1,066 removed, 94.7%).

Durable fixes include:

- recursive erased CLR projection for symbolic managed by-ref arguments,
  proving generic `Volatile.Read/Write` over same-compilation reference types;
- source collection-interface element inference;
- preservation of symbolic nested imported generics through method/member
  substitution;
- structural erasure for slices, tuples, arrays, maps, and delegate targets;
- runtime identity for reference-nullability-only wrapper differences;
- convertibility-aware named-argument overload selection and inaccessible
  constructor filtering;
- imported class-constraint property access;
- cross-file attribute-base recognition before base binding completes;
- nullable promotion retaining nested containing types and array rank;
- named tuple property patterns lowering to positional tuple members.

Cycle 83's largest IDs are GS0159 (10), GS0155 (8), GS0158 (8), GS0125 (6),
and GS0154 (4). The largest file remains
`ExpressionBinder.Access.Accessor.gs` with 13 diagnostics.

## Continuation through cycle 111

Branch `oats/3394-core-compile-continuation-3`, based on `ed0f00f4`, removed
the final 60 semantic diagnostics and then continued through the newly exposed
emit failures:

| Cycle | Result | Milestone |
|---:|---:|---|
| 85 | compile fail (60) | Fresh-main baseline |
| 86–89 | 55 → 53 → 46 → 22 | Nested construction, mutable deconstruction, pattern/source shaping |
| 90–95 | 1–4 diagnostics | Final semantic clusters |
| 96–104 | emit failures | Latent iterator/tuple emit paths exposed after semantic diagnostics reached zero |
| 105 | compile pass | First complete Core semantic compile |
| 111 | compile pass | Final-tree confirmation; ILVerify fail (163) |

Final run:

```text
artifacts/issue-3394/core-cycle-111-final/2026-08-16T08-23-34Z_24caa3
translate: PASS
compile:  PASS
ilverify: FAIL(163)
test parity: skipped
```

The original semantic frontier is therefore **1,126 → 0**. Durable fixes
cover qualified nested constructor continuations, mutable by-ref
deconstruction locals, pattern-variable scope-safe source shaping,
nullable/default imported parameters, binding-context state, definite
assignment, nested rewriter placement, unsupported migrated iterator/tuple
helpers, and runtime-equivalent conversion emission.

The ILVerify frontier is dominated by symbolic generic ABI mismatches:

- 121 `StackUnexpected`;
- 40 `PathStackUnexpected`;
- one `DelegateCtor`;
- one `ValueTypeExpected`;
- 80 failures involving erased `ImmutableArray<object>` paths;
- large concrete-enumerator versus open `IEnumerator<!0>` families.

Issue #3407 tracks this proven emitted-metadata blocker. A direct symbolic
MemberRef experiment reduced 163 failures to 79, but broke seven existing
emitted-runtime generic call regressions (`List<Source>.Add`,
`ConcurrentDictionary.GetOrAdd`, `Dictionary.TryGetValue`, and related
families), proving that TypeSpec parenting, VAR/MVAR signature encoding, and
call-site symbolic projection must be repaired together.

Final focused validation:

- Core migration/binder, SyntaxTree, and CLR utility regressions: 63 passed;
- cs2gs nested-generic/deconstruction regressions: 7 passed;
- SDK and cs2gs CLI Release builds passed;
- `git diff --check` passed.

Per the required sequence, test parity, self-hosted Core recompilation, and
gsc/gsi/gsgen/cs2gs migration remain gated behind #3407 rather than running
against unverifiable IL.

## ADR-0166 pattern variables (issue #3409)

Branch `oats/3409-is-pattern-variables` (PR #3417), rebased onto `28cb0e891`,
added C#-style pattern variables to boolean `is` (ADR-0166) and taught cs2gs
to emit C# `is` patterns with designations verbatim. Measured against a
same-harness run of `28cb0e891` (the same `cs2gs migrate --diagnostic-run
--corpus src/Core` invocation, both trees built from source):

| Metric | `28cb0e891` (main) | ADR-0166 branch |
|---|---:|---:|
| Core compile diagnostics | 12 | **14** |
| `__spillN` declarations | 142 | **4** (2 files, all `{ P: var x }`) |

The twelve main diagnostics (`labelOrdinal` / `choiceOrdinal` locals emitted
after the lifted recursive local functions that read them, and named
arguments on `Find!!(…)` delegate invocations, both from the #3411 lowering)
are unchanged. The two additional diagnostics are in code the native path
restored: the legacy positive-guard hoist had silently dropped every `else if`
branch of `SignatureEncoder.EncodeTypeSymbol` after the hoisted
`TypeParameterSymbol tp` arm (issue #3418); the restored channel branch reports
`typeof(Channel[_])` / `MakeGenericType` (GS0113, GS0159; issue #3425).

Along the way the definite-assignment analyzer learned per-edge conditional
state, so `x is T t && t.TryGet(name, out field)` now definitely assigns
`field` on the true edge (C# §9.4.4) — the native shape had exposed a spurious
GS0238 in `TypeMemberModel.TryGetStaticField`.

Against the pre-#3408 baseline (`ed0f00f44`, 60 diagnostics / 231 spills) the
same branch measured 52 / 4; ten baseline diagnostics were pattern-lowering
artifacts (`GS0125` on escaped binders, `GS0296` on a non-nullable `if let`,
`GS0157` on binder names bound as types).

Remaining synthetic constructs are tracked as follow-ups: `(x as T)!!` explicit
downcasts (#3421), `{ P: var x }` designations (#3420), redundant `!!` chains
(#3422), `__castN` / `__deconN` / `__using` (#3423), property patterns on
property receivers (#3424), and the fallback hoist ordering / unbound-write
defects (#3419).

## Self-host and toolchain completion through cycle 310

Branch `oats/3394-core-self-host-continuation` (PR #3426) completed the
remaining #3394 sequence:

The independently machine-readable self-host checkpoint is
[`self-host-stage-3394.json`](self-host-stage-3394.json).

| Cycle | Target | Result |
|---:|---|---|
| 278 | Core ordinary migration | translate, compile, ILVerify PASS; no pipeline parity oracle |
| 309 | Core ordinary checkpoint | translate, compile, ILVerify PASS after final review fixes |
| 310 | Core review follow-up | accessor/property-pattern regressions and invariant hardening; gate PASS |
| 311 | Core/compiler follow-through | high-arity delegates, symbolic imported bases, conversion and named-extension ABI fixes; gate PASS |
| 278 | Core compiled by migrated Core | compile PASS; ILVerify 0 |
| 278 | Core.Tests against self-hosted Core | **7,661 passed, 0 failed** |
| 305 | gsc | translate, compile, target-assembly ILVerify PASS; no parity oracle |
| 308 | gsi | translate, compile, target-assembly ILVerify PASS; no parity oracle |
| 306 | gsgen | translate, compile, target-assembly ILVerify PASS; no parity oracle |
| 307 | cs2gs | translate, compile, target-assembly ILVerify PASS; no parity oracle |

The real self-hosted Core test frontier moved from 7,572 passed / 89 failed in
cycle 271 to 7,661 / 0. High-fanout repairs included nullable hierarchy walks,
targetless lambda return classification, constructed-symbol cache identity,
stable CLR adapters for extension-based test APIs, and nullable generic
constraint traversal.

Downstream migration exposed and repaired SDK-harness fidelity gaps:
MSBuild-evaluated project references, source assembly identity, package
reconstruction, MSBuild runtime-asset policy, and interface default-method
body rendering. Small source reshapes removed entry-class nested declarations,
unsupported array P/Invoke marshalling, and inherited-interface projection
ambiguity.

Cycles 305-308 also hardened output discovery to require the source assembly
name (`gsc.dll`, `gsi.dll`, `gsgen.dll`, or `cs2gs.dll`) instead of accepting
an arbitrary dependency DLL from the output directory. Re-running each target
with that guard verified the intended migrated assembly.

Generated `.gs` sources, compiler payloads, logs, packages, and migration
artifacts remain uncommitted.

## Pinned code-exploder continuation (#3395)

The downstream pinned corpus at
`4edc419ada45049297096ae367b6d23915e235b4` now has two clean proofs:

- diagnostic cycle 8: **12/12** applications passed translation, compilation,
  ILVerify, and test parity;
- full repository cycle 2: **17/17** source and test projects passed all four
  stages.

The durable gate is `build/run-cs2gs-code-exploder.sh`, backed by
`tools/cs2gs/external/code-exploder.json` and the `cs2gs-code-exploder` CI job.
