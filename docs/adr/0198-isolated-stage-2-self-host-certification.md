# ADR-0198: Isolated stage-2 self-host certification

- **Status**: Proposed (flips to Accepted on merge; owner direction was
  approved October 5-6, 2026)
- **Date**: 2026-10-07
- **Phase**: Self-hosting Phase 0 — bootstrap proof
- **Related**: issues #3501, #4631 and #4716; draft PR #4693; PR #4695;
  ADR-0115 (C# to G# migration); ADR-0154 (test oracle strength);
  ADR-0196 (validation-source provenance)

## Context

The cutover requires stage 2 to reproduce stage 1. Stage 1 is the migrated G#
tree built by the final C# compiler. Stage 2 is the same source built by the
stage-1 compiler.

Draft PR #4693 tested an in-place driver. Review found repeated bypasses. The
driver changed and built a caller-owned tree while project files, imports,
targets, restore outputs, caches, and report paths could also change. Local
guards fixed one shape at a time. They did not create a stable trust boundary.

The owner approved a fail-closed contract on October 5, 2026. Every PE byte
must remain significant except the exact, validated `Module.Mvid` GUID slot.
Unsupported, ambiguous, stale, changed, or incomplete evidence cannot certify
equivalence. Effective compiler selection and workspace ownership must be
validated.

On October 6, 2026, the owner stopped further in-place patches. The replacement
must use immutable isolated input and build trees, externally owned evidence
destinations, and graph snapshots that are revalidated at every build and test
boundary.

## Decision

### 1. Certification controller and trust boundaries

A stage-2 run MUST have one external certification controller. The controller
MUST run outside the source and build trees. Projects and project-controlled
MSBuild code are untrusted inputs.

The controller MUST create and own these disjoint roots:

| Root | Ownership and use |
| --- | --- |
| caller tree | Caller-owned input. The controller MUST NOT change it. |
| source snapshot | Controller-owned, immutable copy of the caller tree. It is the source of both stages. |
| stage-1 build tree | Controller-owned copy derived from the source snapshot. Stage 0 receives read-only project inputs and separate writable output roots. |
| stage-2 build tree | Controller-owned copy derived from the same source snapshot. Stage 1 receives read-only project inputs and separate writable output roots. |
| package feed and caches | Controller-owned. Stage 0, stage 1, restore, and test caches MUST be separate when their contents or compiler selection differ. |
| evidence root | Controller-owned. It contains receipts, process records, graph snapshots, hashes, and comparison inputs. |
| report root | Controller-owned. Reports are derived from accepted evidence. |

The source snapshot MUST be frozen before any pin, restore, dependency setup,
build, or test action. Freezing MUST record every file identity, length, and
SHA-256 digest. The controller MUST verify this manifest before certification.
Read-only permissions are defense in depth. The manifest is authoritative.

For release certification, the controller MUST construct the source snapshot
from the exact release commit. It MUST verify every participating tracked path,
file mode, symbolic-link target, and submodule identity against that commit.
Dirty, untracked participating, or different-commit inputs MUST reject the run.
The evidence MUST bind the commit identity, Git tree identity, and common source
manifest identity.

After stage-specific setup, project files, sources, imports, references,
analyzers, SDK payloads, and other command inputs MUST be read-only to the
command. Generated files, restored assets, intermediates, final outputs, and
test scratch files MUST use explicit controller-owned writable roots.
Authoritative test results remain controller-only evidence. The two stages MUST
NOT share writable files with each other, the caller tree, the source snapshot,
or an evidence destination.

The controller MUST create receipts, reports, logs, comparison snapshots, and
test-result destinations. A project MUST NOT select or own those paths.

Each graph discovery, graph revalidation, restore, build, and test command MUST
run in an OS-enforced sandbox or under a separate restricted identity. This
includes MSBuild evaluation and SDK resolution before the controller can reject
an unsupported target, task, import, or graph. Either mechanism MUST provide one
restricted command boundary. That boundary MUST:

- allow reads only from the applicable immutable inputs and trusted toolchain;
- allow writes only to the command's declared cache, intermediate, output, and
  test-scratch roots;
- deny access to the caller tree, the other stage, controller state, evidence
  root, comparison snapshots, and report root;
- disable network access after restore;
- terminate descendant processes when the command ends.

File permissions alone under the controller's identity are not sufficient.
Analyzers, generators, build tasks, and tests execute as untrusted project code.
They MUST NOT be able to read, write, replace, or restore authoritative
evidence. A supervisor outside the sandbox MUST record process identity,
arguments, start, exit, and output hashes. If compiler-invocation evidence uses
a channel, it MUST be a pre-opened, one-command authenticated channel to that
supervisor. It MUST NOT be a project-visible file path or reusable nonce.

### 2. Path and alias rules

All input and output paths MUST be normalized to absolute real paths before the
run starts. The controller MUST reject the run before mutation when:

- a source, work, cache, output, evidence, or report root contains another root
  that has a different owner or purpose;
- two destinations resolve to the same path;
- a destination exists as a symbolic link, junction, reparse point, or hardlink
  to an input or another destination;
- a path component escapes its declared root after real-path resolution;
- an explicit assembly, PDB, package, log, receipt, test-result, comparison, or
  report path aliases an input or another output;
- `global.json` or any file that will be replaced aliases another input;
- a participating project names a controller destination as `Compile`,
  `Reference`, `HintPath`, analyzer, `AdditionalFiles`, resource, import, or
  other build input.

The controller MUST create controller-authored destination files, including
evidence, receipts, reports, logs, and comparison snapshots, by writing a new
sibling and using an atomic replace. It MUST NOT follow an existing destination
link.

### 3. Participating closure

The execution-node identity is:

```text
(project real path, complete global-property map, SDK resolver environment)
```

The controller MUST retain that full identity for execution and revalidation.
For the ordinary-to-isolated context comparison only, it MUST also compute a
logical-node identity that removes the controller-owned
`BuildProjectReferences` scheduling projection. No other property or resolver
input may be removed. The two contexts compare logical-node identities and
edges; each command still compares its full execution-node identity.

The controller MUST discover the closure by evaluated MSBuild data, not by XML
text search and not by `MSBuildAllProjects`. Discovery MUST include:

- every requested build and test root;
- every effective `ProjectReference`, with its reference metadata and property
  context;
- every evaluated import;
- `Compile`, explicit `Reference` and `HintPath`, analyzer,
  `GsharpCodeAnalyzer`, `AdditionalFiles`, resource, and generated input items;
- implementation, reference, runtime, and test outputs;
- package and SDK inputs selected by restore and SDK resolution.

The snapshot MUST record the exact command, environment, selected .NET SDK,
MSBuild version, NuGet configuration, package sources, package identities and
hashes, global properties, evaluated properties, items, imports, references,
targets, tasks, and planned outputs.

The snapshot MUST NOT retain plaintext credentials, tokens, or secret-bearing
arguments, environment values, or configuration entries. The controller MUST
bind each secret value with a per-run keyed commitment and use that commitment
for boundary comparisons. The key MUST remain controller-only, outside evidence
and reports, and MUST be destroyed after final verification. Reports MAY retain
only the entry name, redacted form, and commitment.

The exact property map MUST include all properties passed to restore, build, or
test. It includes, when applicable, `Configuration`, `Platform`,
`TargetFramework`, `RuntimeIdentifier`, `SelfContained`,
`BuildProjectReferences`, `CustomAfterMicrosoftCommonTargets`,
`GsharpCompilerFullPath`, `GsharpToolFullPath`, and the effective test logger,
filter, and result-directory properties.

Stage-2 v1 supports one evaluated context for each project. It MUST REJECT:

- multitargeted projects;
- a reference that changes configuration, platform, target framework, global
  properties, targets, or other evaluation context;
- project-authored reference metadata that removes an expected participating
  edge, such as `BuildReference=false`, or another build-disabled reference;
- an outside-snapshot project, import, source, analyzer, or reference;
- an ambiguous SDK, import, package, target, task, or output owner.

The controller MUST freeze plans in producer order:

1. Before mutation, freeze the common source manifest and the stage-1 restore
   producer plan.
2. Execute the restore plan. Accept and hash-bind its assets, generated files,
   packages, and other declared outputs. Then freeze the stage-1 build/package
   producer plan from those accepted bytes.
3. Execute the build/package plan. Accept and hash-bind the stage-1 SDK package,
   compiler, task, runtime, and other declared outputs to the source manifest,
   producer plan, command evidence, and output paths.
4. Using only those accepted bytes, freeze and execute the stage-2 restore
   plan. Accept and hash-bind its outputs before freezing the stage-2 build
   plan.
5. After each accepted stage-2 producer output exists, freeze any downstream
   restore, build, setup, or test plan that consumes it.

Each plan MUST be frozen before its own command executes. A downstream plan MAY
depend on an earlier accepted producer output. It MUST name that output's
controller evidence identity and exact hash. A path, package ID, version, or
filename without this binding is not an input identity.

Stage-2 v1 MUST produce the stage-1 SDK inside the same certification run. It
MUST REJECT a caller-supplied prebuilt stage-1 package. This prevents a stage-0
package with a changed label from entering the stage-2 plan.

The common source manifest and participating logical closure MUST match across
the plans. Controller-owned pin, cache, build-root, evidence-root, and
toolchain-path projections MUST differ as the plan declares.

A plan is frozen when every node and edge has one supported meaning and all
input hashes are recorded. A path-only graph is not a frozen graph.

For each plan:

- the **ordinary context** uses the plan's stage pin and properties with normal
  project-reference discovery enabled. It defines the complete logical closure;
- the **isolated context** uses the same inputs and properties, but sets
  `BuildProjectReferences=false`. It defines each manually scheduled command.

The contexts MUST contain the same participating nodes and edges. The only
permitted difference is that the isolated context does not schedule implicit
reference builds. An input, import, reference, target, task, or output visible
in only one context MUST reject the plan.

### 4. Required graph revalidation

The controller MUST evaluate and compare a fresh graph snapshot at these
boundaries. Each evaluation MUST use the restricted command boundary in
section 1 and return its snapshot through a one-command authenticated channel
to the controller:

1. before any mutation, when the controller creates the common source manifest
   and stage-1 restore plan in the ordinary and isolated compilation contexts;
2. after the matching pin and dependency setup, immediately before each restore
   command;
3. after each restore and before its outputs are accepted, then again after
   those outputs are hash-bound when the dependent build plan is frozen;
4. after dependency builds and immediately before each stage build command;
5. after test setup, including result-directory creation and receipt
   invalidation, and immediately before each test command;
6. after each build or test command and before outputs or test evidence are
   accepted;
7. immediately before the final certification verdict.

Each new snapshot MUST equal the applicable frozen execution plan for all
inputs, imports, references, toolchain selections, targets, tasks, and planned
outputs. A restore command is compared with its restore plan. A build or test
command is compared with its plan after that plan is frozen from accepted
restore and upstream producer evidence. Generated restore files MAY enter a
dependent plan only after the controller records their controller-owned
locations and hashes.

Any other graph change MUST fail the run. After a frozen plan begins execution,
the controller MUST NOT repair, ignore, or relearn that plan. This prohibition
does not prevent freezing a declared downstream plan from accepted producer
evidence before that downstream plan begins execution.

### 5. Effective compiler and SDK selection

Each participating project and reference MUST resolve the intended SDK package
for its stage. Validation MUST use the same environment, cache, property map,
and resolver inputs as the build command.

For every participating G# project, the controller MUST prove:

- the effective `Gsharp.NET.Sdk` ID and version;
- the resolved package path and full package-payload hash;
- the effective compiler executable, compiler runtime closure, build task
  assembly, and task runtime closure;
- the effective target and task definitions that invoke the compiler;
- the compiler and task payload hashes immediately before invocation.

A versioned project `Sdk` attribute or imported SDK override inside the
participating closure MUST match the stage selection exactly or the run MUST be
rejected. Intentional pins outside the closure MUST remain byte-for-byte
unchanged. Unrelated helpers and package pins MUST NOT be rewritten.

Case-insensitive MSBuild names and `TreatAsLocalProperty` rules MUST be applied
as MSBuild applies them. A local-property exemption for a protected property
MUST be rejected.

### 6. Build, test, and evidence execution

The controller MUST restore explicitly. Build and test commands MUST use
`--no-restore`. Restore MUST use the same configuration and graph-defining
properties as the later command.

Dependencies MUST be built in frozen topological order. Each build command MUST
consume only already verified dependency outputs. Implicit project-reference
builds MUST be disabled and revalidated as disabled.

For each command, the supervisor MUST create and retain a fresh nonce and fresh
controller-owned evidence destinations. The command MUST NOT receive the nonce,
credentials, or destination paths. When in-process reporting is unavoidable,
the command MAY receive only a pre-opened channel whose peer and process
identity the supervisor authenticates. Channel messages are untrusted until the
supervisor verifies them against its independent process and output
observations. Evidence MUST bind:

- command identity and exact arguments;
- process start and completion;
- frozen graph snapshot identity;
- compiler, task, SDK, and dependency payload hashes;
- implementation, reference, and requested final output paths and hashes;
- test assembly and compared dependency hashes, when testing.

Evidence MUST be checked immediately after its command and again before final
certification. Evidence from an earlier command, repeated root, prior run, or
different graph MUST be rejected.

Project-controlled targets and tasks MUST NOT create authoritative evidence.
Stage-2 v1 MUST REJECT an unmodeled custom target or task. A participating
project or non-platform import MAY execute one only when the frozen plan:

- identifies its exact definition, import owner, conditions, ordering, inputs,
  outputs, property and item effects, task assembly, and complete payload
  hashes;
- records why the target or task is required by the accepted cutover closure;
- revalidates those identities and effects at every applicable boundary; and
- executes it inside the restricted command boundary without access to
  controller evidence.

The replacement implementation MUST either model and hash-allowlist the custom
targets and non-platform imports required by the current cutover closure,
including the `Gsharp.Extensions` compile-item reset and repository versioning
imports, or remove them from that closure before certification. Any undeclared
target, task, effect, or payload change MUST reject the run. The installed .NET
SDK, byte-verified G# SDK, and controller-supplied instrumentation remain
trusted only at their recorded bytes and load paths.

A requested test run MUST produce fresh machine-readable results through a
controller-owned test supervisor. The test process MUST NOT have write access
to the result or evidence destination. A trusted runner/logger outside the test
sandbox MUST capture events through a one-command authenticated channel and
write the result. Custom test adapters or result loggers MUST be rejected unless
they can run under the same separation.

The evidence MUST show a completed run, a positive executed-test count, no
failed tests, and the requested filter and assembly identity. Exit code zero or
a result file written by the test sandbox is not enough. Test setup and test
execution MUST NOT change compared binaries.

Reports MUST be written only after their destination is proven
controller-owned. If that proof fails, the controller MUST leave the path
unchanged and report the failure on standard error.

### 7. Fail-closed support policy

Stage-2 v1 models only graphs for which it can prove the rules above. It MUST
REJECT unsupported input before destructive work.

Rejection is the required result for unmodeled custom project targets or tasks,
multitargeting, context-changing or build-disabled references, ambiguous
imports, mutable external inputs, and any graph that cannot be frozen and
revalidated. The exact modeled and hash-allowlisted cases in section 6 are
supported; an implementation MUST NOT approximate any other case. A later ADR
or amendment may add support.

An unsupported or rejected run is not evidence of non-equivalence. It is also
not certification.

### 8. Semantic fingerprint

The stage-1 and stage-2 comparison MUST operate on complete PE files.

The normalizer MUST:

1. parse a valid PE and CLR image;
2. locate the module row and its `Mvid` GUID heap index;
3. validate that the index names one in-range 16-byte GUID slot;
4. copy the complete file;
5. replace only those 16 bytes with a fixed value;
6. compare the resulting bytes.

Every other byte MUST remain significant. This includes:

- DOS, PE, COFF, optional, CLR, section, and debug headers;
- COFF `Machine`;
- CLR flags and entry point;
- all metadata tables and heaps outside the one MVID slot;
- method headers, IL, and exception regions;
- attributes, signatures, names, and custom data;
- managed resources;
- native and embedded resources;
- reference assemblies and every other certified PE output.

The normalizer MUST reject malformed, ambiguous, duplicate, overlapping, or
out-of-range MVID evidence. It MUST NOT search for and clear all occurrences of
the MVID byte sequence.

Raw SHA-256 and normalized SHA-256 MUST both be reported. Certification requires
equal normalized bytes. A raw difference is acceptable only when the structural
normalizer proves that the exact MVID slot is the sole difference.

### 9. Security and correctness invariants

The replacement implementation MUST preserve these invariants:

1. Caller-owned bytes never change.
2. Stage 1 and stage 2 start from the same immutable source manifest.
3. No writable file is shared across stages or trust domains.
4. Every participating input is known before a destructive action.
5. Every command uses the frozen graph and intended effective compiler.
6. Project code cannot select, overwrite, or forge authoritative evidence.
7. Receipts are fresh, command-specific, output-bound, and revalidated.
8. Tests execute against the certified stage-2 outputs.
9. Only the validated `Module.Mvid` GUID slot is ignored.
10. Missing or uncertain evidence causes rejection, never equivalence.

### 10. Required acceptance tests

ADR-0154 witnesses MUST run through the real replacement driver where the
boundary is under test. The suite MUST include:

- `global.json` symlink and hardlink aliases that would overwrite another input;
- explicit `Reference`/`HintPath`, analyzer, `GsharpCodeAnalyzer`,
  `AdditionalFiles`, and resource inputs under a cleanup or destination root;
- inputs visible only under the actual compiler paths and
  `BuildProjectReferences=false` context;
- ordinary and isolated execution identities that differ only by the
  controller-owned `BuildProjectReferences` projection;
- secret-bearing restore configuration whose plaintext MUST NOT appear in
  evidence, logs, or reports while changed commitments MUST reject;
- graph evaluation or SDK resolver code that attempts to read the caller tree
  or controller-owned evidence, proving that discovery and revalidation use the
  restricted command boundary;
- a build-phase analyzer or generator that attempts to read the caller tree,
  write controller-owned evidence, and use the network after restore, proving
  that compiler child processes use the restricted command boundary;
- a graph that changes after restore or after a dependency build;
- a test graph that changes after result-directory setup or receipt deletion;
- report, log, receipt, and error-path collisions with project inputs;
- project SDK attributes, imported SDK overrides, same-version alternate
  packages, compiler path overrides, task overrides, and runtime-payload
  replacement;
- the accepted current-closure custom target/import inventory, plus a changed
  definition, ordering, effect, task assembly, or payload that MUST reject;
- source/work containment, destination aliasing, symlink, junction, hardlink,
  and real-path escape cases;
- repeated roots, stale receipts, copied outputs, replaced implementation or
  reference assemblies, test-only compilation, zero-test success, and test
  execution against changed outputs;
- a dirty tracked input, an untracked participating input, and source bytes from
  a different commit carrying the expected commit label;
- a stage-0 SDK relabeled with the stage-1 package identity, and any downstream
  input that names an unbound producer path instead of accepted output evidence;
- a test and descendant process that write a success-shaped TRX or replace a
  logger output after completion, proving that only supervisor-owned result
  capture is accepted;
- non-MVID metadata mutation, method-header mutation, exception-region
  mutation, CLR entry-point and flags, COFF `Machine`, managed resources, and
  native or embedded resources;
- MVID bytes repeated in an attribute or resource, proving that only the
  referenced GUID slot is ignored;
- malformed or duplicate module rows, zero or out-of-range MVID indexes,
  truncated GUID heaps, an MVID index that aliases another semantic GUID use,
  and metadata ranges that overlap or escape the PE section that contains
  them.

Each rejection test MUST also prove that caller inputs remain byte-for-byte
unchanged. The successful certification control MUST perform the same caller
manifest comparison. Error tests MUST prove that two independent failures
cannot overwrite or misattribute each other's reports.

### 11. Rollout and landing order

The work lands in this order:

1. Keep draft PR #4693 as the prototype and discrimination inventory. It MUST
   NOT merge.
2. Before other 0.5 implementation work, add a temporary publish guard. It MUST
   reject an emitted 0.5 artifact or any artifact built by the stage-2 compiler.
   Tag text MUST NOT control this decision. The guard remains until the
   evidence-bound gate replaces it in the same change.
3. Implement the isolated controller and port #4693's useful tests to the new
   trust boundaries.
4. Land the replacement stage-2 gate only after this ADR is accepted, its
   acceptance tests pass, CI is green, and current-head review has no material
   finding.
5. Rebase and land PR #4695 after the replacement gate. #4695 MUST consume the
   new controller-owned evidence contract and MUST NOT depend on #4693.
6. Run the full stage-1/stage-2 proof on the cutover closure.
7. Complete the fresh-clone cutover dry run required by #3501.
8. Before any 0.5 package or extension can publish, make the release workflow
   require successful replacement-gate certification for the exact release
   commit. The controller MUST produce a release manifest that records the
   identity and SHA-256 digest of every package and extension that may publish.
   Each artifact MUST be produced by the certified run or have every input bound
   to its accepted evidence. Before the first upload, the publish jobs MUST
   verify the manifest, evidence identity, commit, and every artifact digest. A
   missing, rejected, stale, different-commit, or different-byte proof MUST
   block publication.

The replacement MUST NOT claim that a normal self-migration nightly proves
stage-2 equivalence. The nightly is a separate source-translation and behavior
gate.

## Consequences

The design uses more disk space and repeats graph evaluation. It also rejects
valid MSBuild features that stage-2 v1 does not model. These costs are accepted
because certification must be stronger than an ordinary successful build.

The controller has a narrow proof surface: immutable inputs, isolated writable
trees, exact graph snapshots, verified toolchains, fresh external evidence, and
complete-PE comparison. Support can expand only when the same invariants remain
provable.

## Alternatives considered

- **Add more guards to the in-place driver.** Rejected. PR #4693 showed that
  each guard exposed another alias, graph, task, or timing shape.
- **Normalize PE fields that appear nondeterministic.** Rejected. Shape-by-shape
  normalization already hid changes to metadata, COFF `Machine`, and resources.
- **Trust project targets, task output, or project-selected receipts.** Rejected.
  The project is inside the certification boundary and can create
  success-shaped evidence.
- **Use successful nightly self-migration as stage-2 proof.** Rejected. The
  nightly does not establish the effective self-built compiler, immutable
  inputs, byte equivalence, or fresh stage-2 test evidence.
- **Support every MSBuild graph in v1.** Rejected. Partial modeling would turn
  an unsupported graph into a false certificate.
