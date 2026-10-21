# ADR-0205: Opt-in type-preserving interface values

- **Status**: Proposed
- **Date**: 2026-10-21
- **Phase**: Design only; no implementation authorization
- **Issue**: [#5097](https://github.com/DavidObando/gsharp/issues/5097)
- **Related**: [#4333](https://github.com/DavidObando/gsharp/issues/4333),
  [ADR-0191](0191-go-to-gsharp-migration-tool.md) sections 1.1 and 7,
  [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md),
  [ADR-0188](0188-heap-storable-managed-references.md),
  [ADR-0182](0182-receiver-clause-is-always-extension.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md),
  [ADR-0154](0154-test-oracle-strength.md)

## Context

### 1. Handwritten programs first

The following pairs describe two independent needs. The left-hand programs use
existing language constructs. The proposed programs are **hypothetical**, not
examples that the published compiler accepts. The receiver example has an
additional design gate, explained below. None of these snippets was compiled
as evidence for this document.

#### Heterogeneous messages with optional capabilities

A message router needs a common queue, optional audit behavior, and access to
the original concrete message. Adding an audit view must not replace that
message's identity with a forwarding object's type.

| Current-language baseline | Proposed contract |
| --- | --- |
| Keep the source and an adapter separately. Carry both through every routing layer that needs concrete tests. | Store one opted-in value. Acquire typed capability views without losing the original evidence. |
| An `Audit` adapter is an ordinary nominal object. Testing that wrapper for the source type does not recover the source. | Capability tests inspect validated evidence, not the adapter's CLR type. |

Current-language sketch, with ordinary nominal interfaces and static adaptation:

```gsharp
interface Audit { func Describe() string; }
class OrderPlaced(Number int32) {
    func Describe() string -> "order"
}
class Heartbeat {}

let order = OrderPlaced(42)
let audit = adapt[Audit](order)
let messages = []object{order, Heartbeat()}
// Keep order/messages and audit separately if both observations are needed.
```

Proposed spelling and operations:

```gsharp
interface value Message {}
interface value Auditable { func Describe() string; }
class OrderPlaced(Number int32) {
    func Describe() string -> "order"
}
class Heartbeat {}

let messages = []Message{
    values.Pack[Message](OrderPlaced(42)),
    values.Pack[Message](Heartbeat())
}
for message in messages {
    if message is Auditable audit {
        Print(audit.Describe())
        if values.TryGet[OrderPlaced](audit, out var order) {
            Print(order.Number)
        }
    }
}
```

`Print` stands for an application function. `values` denotes the proposed
compiler-recognized operations, not an existing import. Their qualification
and packaging need acceptance with the spelling. They expose no wrapper,
type tag, slot number or universal invocation operation.

The `Heartbeat` capability test returns false. Recovering `OrderPlaced` through
`audit` succeeds with the same object reference. Neither operation searches the
runtime shape. Both types and the queried capability belong to the validated
finite evidence closure described in section 7.

#### Value-backed strategies without stored-state mutation

A pricing simulation wants independent trial calls against a saved strategy.
Each call may mutate its temporary receiver while reading shared reference
data. Trial calls must not advance the saved configuration.

| Current-language baseline | Proposed family, after the receiver gate |
| --- | --- |
| Write a rich object that saves a value and explicitly copies it inside each forwarding method. | Request a snapshot-call slot in an opted-in capability, with ordinary typed calls. |
| `adapt[Quote](configuration)` instead keeps one mutable struct field. It is not this contract. | Copy the saved struct for each call, not just at insertion. Shared reference-like fields remain shared. |

Current-language sketch:

```gsharp
interface Quote { func Next() int32; }
struct Configuration {
    var Step int32
    func Next() int32 {
        Step += 1
        return Step
    }
}
let configuration = Configuration{Step: 10}
let trial = object : Quote {
    let Saved = configuration
    func Next() int32 {
        var receiver = Saved
        return receiver.Next()
    }
}
// Repeated trial.Next() calls return 11. Each method creates its own receiver.
```

Proposed **receiver-gated** sketch:

```gsharp
interface value TrialQuote {
    snapshot func Next() int32;
}
let configuration = Configuration{Step: 10}
let trial = values.Pack[TrialQuote](configuration)
Print(trial.Next())  // 11
Print(trial.Next())  // 11, not 12
```

`snapshot func` is a **candidate slot modifier for a separate receiver-mode
ADR**, not syntax selected by this ADR. It describes a call policy on a new
capability slot, not a change to `Configuration.Next`. The value category has
an independent use in the message example without this policy. Do not admit
the strategy sketch by treating a normal method, extension or readonly
defensive copy as an already available snapshot slot.

#### Intended migrated output, not an executable corpus

After both the category and the necessary receiver modes pass their gates,
algorithm bodies should look like this:

```gsharp
func Price(strategy TrialQuote) int32 -> strategy.Next()

func Route(message Message) {
    if message is Auditable audit {
        Print(audit.Describe())
    }
}
```

Insertion remains explicit at source conversion points. The translator must
also prove the Go mapping in section 10. These bodies do not certify Go
assertions, typed nil, pointer receivers or method values. A frontend operation
without an admitted mapping remains blocked, even when a native call works.

### 2. What exists today

These observations come from repository source and existing tests, not from
the intended behavior of this proposal. This is inspection evidence, not a
new test run:

| Existing mechanism | Inspected evidence and limit |
| --- | --- |
| Nominal interface closure | `ExpandStructInterfaceClosures` in [interface verification](../../src/Core/CodeAnalysis/Binding/DeclarationBinder.InterfaceVerification.gs) expands declared interfaces and inherited obligations. It does not install optional structural views on every value. |
| Static adaptation | `BindStructuralAdaptation` in [Binder](../../src/Core/CodeAnalysis/Binding/Binder.gs) selects a target interface, creates an adapter class and stores a private source field. It rejects nullable, borrowed and unsupported location sources. Reference inputs use `ArgumentNullException.ThrowIfNull` before construction. |
| Struct mutation | That source field is mutable for value adaptation. [Member access emission](../../src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.gs) has address-based value receiver paths. ADR-0189 requires calls to update the saved field, not a new temporary on every call. |
| Rich captures and selected locations | `RichMutableCapturesShareOneCellPerDynamicBinding` and `RichCaptureAndPersistentHandleAdaptersVerifyAndExecute` in [language tests](../../test/Compiler.Tests/InterfaceAdaptationLanguageTests.gs) assert shared captures, initializer snapshots and writes through a retained handle. The latter expects two increments to update the original from 20 to 22. |
| Separate assemblies | `ReferenceAssemblyExposesOnlyTheRequestedInterfaceContract` and `SourceTargetAndCallerMayLiveInThreeIndependentAssemblies` in those tests cover nominal signatures and caller-emitted adaptation. They do not carry original-type evidence through an opt-in category. |
| Imported contracts | `ImportedAdapterEventsPreserveNestedNullabilityMetadata` and `ImportedGenericNullabilityAndConstraintMetadataRemainExact` in [review tests](../../test/Compiler.Tests/InterfaceAdaptationReviewTests.gs) cover nested nullability and exact generic contracts. These are obligations to preserve, not evidence for new receiver metadata. |
| Managed locations | [ManagedRef](../../src/Sdk/Gsharp.Runtime.Values/ManagedRef.gs) supplies borrowing and readonly views. Its equality uses location identity. A handle copy does not copy the referent or provide an interface presence discriminator. |

The current-language examples use the interface, class/struct, array literal,
`adapt`, rich field and method constructs exercised by those mechanisms.
They are illustrative compositions, not newly banked conformance fixtures.

## Decision

**Recommend an explicit interface-value type category with finite, statically
validated evidence and ordinary typed capability calls. Preserve evidence
through views. Use ordinary outer nullability for absence, while retaining
the insertion payload's exact admitted G# type inside a present value.**

This is one source contract, not three competing public APIs. Hidden storage
can use library types and synthesized forwarders. It is not a public
`GoInterface` envelope. All decisions here remain **Proposed**. Merging this
document or passing CI does not accept its semantics or authorize product work.

### 3. Ownership and recommended spelling

This ADR owns:

1. Opt-in category declarations, insertion, absence, extraction and views.
2. Preservation of exact admitted G# insertion evidence.
3. Conservative native equality and explicit foreign boundaries.
4. Closed-evidence and emitted-contract requirements.

A **separately accepted receiver-mode ADR** must own snapshot-call slots,
location-receiver slots, nullable-location entry, method-value captures and
their imported metadata. This document records their required observations;
it does not approve a receiver syntax or silently add those modes.

The first category implementation may admit class-reference calls through
ordinary accessible instance methods. It may store/extract structs and handles
without offering their methods as callable structural slots. Automatic
struct/handle slot forwarding stays blocked until the receiver ADR selects the
mode explicitly. There is no fallback to mutable adapter storage.

Recommended declaration spelling is `interface value Name { ... }`.
`value` is contextual only between `interface` and a following declaration
identifier. An existing `interface value { ... }`, a method named `value`,
and escaped identifiers retain their current parsing. A parser proof must
cover the old grammar before acceptance. No global keyword is reserved.

`values.Pack[V](expression)` is an explicitly recognized, typed insertion
operation targeting category `V`. The proposed library-qualified operation
does not reserve `Pack`, `TryGet` or `values` in ordinary user code.
Recognition requires the compiler-owned symbol identity, not a short-name
match. A local alias can shorten qualification without granting privileges.

Each category declares ordinary synchronous by-value method signatures.
Initial slots reuse ADR-0189's exact public instance selection and accessibility
checks, but not its exposed wrapper semantics. Do not import its larger
generic/property/event/ref surface by implication. These require separate
focused proofs before admission to this category.

### 4. Presence, payload and insertion boundaries

`V` is a present value. `V?` is either absent (`nil`) or present. This uses the
existing source operations for outer nullability: `== nil`, `if let`, `?.` and
`!!`. A present entry can hold an explicitly nullable payload whose value is
nil. That entry is not absent.

| Operation | Proposed meaning |
| --- | --- |
| `default(V?)` | Absent, no payload and no original-type evidence. |
| `default(V)` or an uninitialized non-null `V` field | Rejected unless existing definite assignment proves initialization. Do not allocate a fictitious payload. |
| `values.Pack[V](expression)` | Evaluate once, validate insertion and slots, then create a present entry. A nullable payload's nil is retained. |
| Assignment/copy of `V` or `V?` | Preserve presence, evidence and semantic payload. Copy a struct payload logically; retain class/handle identity. |
| Ordinary `T` to `V` assignment | Rejected without explicit insertion. No new ambient structural conversion. |
| Existing `V` to another view | Preserve the original entry, not a newly inserted adapter or category-typed payload. |
| Packing an existing category value | Rejected; use view conversion. No nested category payloads in the initial scope. |

An expression containing bare `nil` has insufficient insertion evidence.
A typed local, such as `let text string? = nil`, supplies `string?` evidence
for `values.Pack[Message](text)`. A category with no callable slots can hold
that payload. Nullable class payloads cannot satisfy ordinary instance-call
slots, even if their current value happens to be non-null. Narrow explicitly
before insertion to obtain a different, non-null insertion type.

The same rule applies to nullable managed handles. A nil handle can be a
present payload; it cannot be called through ordinary instance forwarding.
`T?` inside an entry, outer `V?`, nullable handles, and nullable referents are
different positions. `T!` remains ADR-0186's unspellable imported platform
position. Platform input requires an explicit checked/narrowed payload contract
before insertion; it is not silently canonicalized to `T?`.

All initialization paths must enforce presence, including arrays, generic
storage and foreign returns. The compiler may reuse ADR-0188's required-value
analysis, but must prove it applies to this category. Runtime CLR zero storage
does not become a valid non-null `V`. Foreign invalid storage fails at the
explicit boundary, rather than creating an apparently present default.

### 5. Original type evidence and capability operations

Original evidence identifies the **admitted concrete insertion type** and its
nullability/constructed arguments, not a wrapper type or a member-name list.
For a struct it denotes that exact type. For a class it requires an exact
concrete type proof; initially a statically sealed class suffices. Insertion
through `object`, a nominal interface, or an open base class cannot guess the
original concrete type using `GetType()`. Reject such insertion unless a later
accepted evidence protocol supplies the missing proof.

An already-created ordinary adapter may be treated only as that ordinary CLR
object at an explicitly admitted boundary. Its source identity is not
recoverable evidence. It is never implicitly unwrapped.

Within a validated finite closure:

| Operation | Proposed result |
| --- | --- |
| `entry is Capability view` | Test the original evidence against that category's exact validated slots. Bind a present view on success; false on a known mismatch. |
| `entry as Capability` | A present view on success, otherwise absent. Absence as input remains absent. |
| `values.TryGet[T](entry, out var payload)` | True only for exact insertion-type evidence `T`; bind the extracted payload with type `T`, including its admitted nullability. Copy struct values; retain class/handle identity. |
| Failed `TryGet` | False; output is definitely unassigned and cannot be read on the false path. No counterfeit non-null `default(T)`. |
| Test/extraction on absent `V?` | False; no output binding. Capability conversion preserves absence. |
| Assert a capability | `(entry as Capability)!!` uses the ordinary checked-presence failure. It is not automatically a Go assertion panic. |

Concrete recovery is explicit `TryGet`, not ordinary CLR `is T` or `as T`.
Capability patterns apply only when the target is the new category. Ordinary
type tests on nominal interfaces/objects keep their current meaning. No
unchecked concrete cast, runtime member-name invocation or implicit
assignability-based payload extraction is added.

Output definite assignment for `TryGet` is a new, narrowly recognized compiler
contract. Its true/false branch behavior, nullable outputs and short-circuit
use require proof before implementation acceptance. If it cannot fit the
existing flow model, revise the spelling before acceptance, not the semantics.

A failed test means **known not to satisfy**, not **missing evidence**.
Unknown closure members or unsupported signatures produce a compile-time
boundary diagnostic. Imported values with unverifiable evidence cannot enter
native dispatch. A runtime contract/version failure must fail the explicit
import operation, not return a misleading false capability result.

### 6. Three different copy/receiver decisions

| Event | Contract or gated requirement |
| --- | --- |
| Value insertion | Snapshot the struct at that evaluation point. Ordinary shallow value copy preserves sharing of class, slice, array and location fields. Do not capture its source variable as a location. |
| Reference/handle insertion | Retain the evaluated object reference or selected handle. Reassigning the original variable never retargets the entry. Selecting a handle does not dereference it. |
| Snapshot-slot call, receiver ADR required | Copy the current selected struct value for **every call**, invoke on the fresh receiver, and discard receiver-local mutation. Shared reference-like field effects remain visible. |
| Snapshot slot through a location, receiver ADR required | Read/copy the current pointee at invocation, not insertion. Repeated calls observe intervening external writes but cannot mutate the pointee through receiver-local writes. |
| Location slot, receiver ADR required | Pass the retained selected handle and its permission. Writes affect that location. Do not copy its referent or retarget from the handle variable. |

For a nil selected location, a snapshot/value-method call must fail on the
attempted read **before entering the body**. A separately declared nullable
location receiver must instead receive the nil handle and may handle it.
There is no substitute involving a null CLR instance invocation or an eager
dereference before a nullable receiver body.

The receiver ADR must specify evaluation and fault timing for direct calls,
method values, callback conversion and imported slots. A snapshot method value
must state when it captures the selected source and when it copies a receiver.
Its callable cannot accidentally share one mutable temporary across invocations.
If a body retains a location into its copy, that invocation needs independent
storage with the required lifetime. A location method value retains the chosen
handle, not the variable holding it. No escaping raw CLR byref is allowed.

Ordinary struct calls continue to mutate addressable storage. CLR boxing,
nominal interface dispatch, readonly defensive copies and extension selection
do not change. ADR-0182 receiver-clause functions remain static extensions,
not nominal method slots. A future explicit snapshot slot can call an ordinary
struct body on a fresh receiver, but cannot relabel that body's direct or
nominal calls. Extensions are not automatic structural candidates.

### 7. Finite evidence, generic and cross-unit boundaries

The first admission is closed, not a runtime structural type system.
It supports finite known concrete insertion types and finite declared
capabilities. A producer validates the full matrix of its admitted insertion
types against its declared/referenced capability closure. A negative matrix
entry is evidence too. Unused combinations need not allocate dispatch objects.

For separate libraries, a shared contract assembly declares the available
capabilities. The producer exports a versioned closure manifest with its
public value signatures. A consumer must prove its queried capabilities are
covered before accepting the value. A consumer-added capability outside that
manifest is a boundary error, not false. Rebuilding the producer against an
expanded validated closure is explicit; importing an old binary does not
silently gain new structural capabilities. This restricts plugin extensibility
but avoids reflection or universal late dispatch.

Opaque/private concrete types need assembly-qualified opaque identities,
issued by their defining assembly, with only publicly legal witness slots.
Consumers need not name private types to call an already exported capability.
Concrete extraction requires a nameable accessible type and exact evidence.
The producer never exports private methods as public authority.

Initial admission excludes open type parameters at insertion, generic
capability declarations/slots, ref-like payloads and unbounded dynamic loading.
Closed constructed payload types may follow only when identity, substitution,
nullability and storage proofs cover that particular family. Nongeneric
helpers may transport a category value without inspecting its payload.
Generic containers must preserve the category contract; using a container
does not admit arbitrary generic insertion or waive initialization checks.

An imported CLR type with complete known public shape may receive a local,
statically generated witness at insertion. Its identity remains the CLR/G#
type identity selected there, never a guessed Go identity. Unknown versions,
unrecognized metadata, unknown dynamic classes and runtime-only plugins stay
attributed boundaries. Native AOT and trimming cannot depend on unrestricted
reflection to complete a missing witness.

### 8. Native equality, hashing and CLR interop

For the initial category, no intrinsic payload equality or hashing is admitted.
Only presence comparison against `nil` on `V?` is defined. `==` between entries,
ordering, implicit map-key comparers and default payload hashing must receive
diagnostics where the compiler controls the operation. A future explicit
comparer may use extracted payloads or an application-defined capability.
Do not silently choose wrapper reference equality, record equality or Go
comparability. No hash stability or serialization format is promised.

Boxing a category to `object`, converting it to a nominal interface, calling
inherited `object.Equals/GetHashCode/GetType`, or passing it to an unconstrained
CLR API must not bypass that restriction. These are explicit export boundaries,
not ordinary implicit conversions. The proof must cover generic/default
comparers and arrays as well as direct operators. Merely forbidding `==` is
insufficient if a generic escape exposes backing-box identity.

G#-to-G# calls through metadata-aware public signatures preserve presence,
original evidence and selected storage. They are not foreign exports.
Ordinary CLR code does not receive that guarantee from the erased backing
signature alone.

**Initial foreign export/import is rejected.** Before admitting it, a separate
interop contract must decide all of the following together:

- Which nominal interfaces can be exported and which receiver slots they expose.
- Whether repeated exports create distinct wrappers, and what CLR reflection,
  reference equality, equality and hash calls observe.
- How absence differs from a present nullable payload at that boundary.
- Whether importing an exported wrapper recovers the same semantic entry, and
  what happens after foreign wrapping, copying or serialization.
- Which versioned evidence authenticates a recognized round trip; unknown
  wrappers cannot be unwrapped heuristically.

This does not restrict existing nominal CLR interfaces or `adapt`. They keep
CLR nullness, equality, boxing, public slot contracts and ordinary BCL use.
ADR-0189 adapters remain fresh exposed objects, reject null sources and expose
only their selected interface closure. No conversion cache or transparent
source-unwrapping rule changes those observations.

### 9. Feasible lowering and costs to prove

A feasible backend uses an internal immutable entry containing original
evidence, semantic payload storage and a validated slot witness. A view changes
the statically available slot contract without replacing original evidence.
Snapshot insertion can use immutable boxed storage; extraction returns a copy.
Reference payloads retain references. Handles retain their selected locations.
These are implementation hypotheses, not a universal layout or allocation ABI.

Reuse static member selection and exact contract checking from adaptation.
Reuse rich-object/capture synthesis for typed forwarders and retained storage.
Reuse managed-location promotion and permission checks where the receiver ADR
permits them. These mechanisms do not already implement this category.

Receiver lowering, once accepted, needs a distinct storage/call plan:

1. Evaluate insertion or location selection exactly once at its source point.
2. Save the original evidence and snapshot/reference/handle choice.
3. At a call, resolve the typed slot from validated evidence.
4. Execute its explicit receiver mode. A snapshot slot obtains a fresh value
   receiver per invocation, including reads through a selected location.
5. Preserve exception timing, aliasing and escaping receiver storage.

Generate exact typed methods or typed delegates, not an `object[]` dispatch
ABI, universal `Invoke_I_M` helpers or caller-supplied numeric tags.
Generated boxes and witnesses are permitted behind the compiler boundary.
No reflection proxy, global adapter cache or application-maintained tag table
is intended output.

Evidence identities and witness order must derive from canonical declaration
identities and exact signatures in deterministic order. Never assign IDs by
hash-table enumeration, task completion or process-local CLR handles.
Separate assembly identity/version and signature changes need explicit
invalidation. No universal tag numbers or binary layout are fixed here.

Both implementation and reference assemblies must carry a versioned contract:
category identity, original-type descriptor identities, finite capability
closure including negative knowledge, exact slot signatures/nullability, and
required receiver/evidence revisions. Include permissions and receiver modes
when those are accepted. Ref-only consumers must reach the same decisions as
implementation-assembly consumers. Unknown revisions fail closed.
Existing CLR nullability attributes remain necessary, but are not sufficient
to encode these facts. Imported position nullability must use ADR-0193's
producer funnel and existing readers, not another nullable-signature parser.

Likely costs include per-entry evidence/storage, view checks, typed dispatch,
code-size growth for witnesses and possible insertion allocation. Views might
share immutable storage, but no allocation-free view guarantee is made.
Snapshot copies can be local when non-escaping; escaping receiver locations
may require a heap cell per invocation. Large structs increase copy bandwidth.
Reference-like fields can retain large object graphs after shallow snapshots.
Readonly handles do not imply exclusive ownership or deep immutability.

Before cost claims, measure insertion, repeated calls, view conversion,
extraction, escaping copies and separate-library calls against handwritten
same-runtime controls. Include small/large structs, reference fields and JIT/AOT.
Record allocations, retention, code size and throughput separately. There are
no invented benchmarks, zero-allocation promises or deadlines in this ADR.

### 10. Go mapping is not the native default

ADR-0191 owns the frontend mapping and family admission. G# original evidence
is not automatically Go dynamic identity. The frontend must preserve canonical
defined-type versus alias identity, `T` versus `*T`, exact constructed source
types, embedding/selection paths and package-qualified private method authority.
An adapter's `GetType()` or public CLR member list cannot supply these facts.

Go nil interfaces map to absence only under an explicit mapping. Go typed nil
requires a present entry with validated Go source identity and a nil payload.
It is not equivalent to G# `T?`, `T!` or an ordinary null CLR instance.
Nullable pointer-receiver entry requires the separately accepted receiver mode.

Native capability tests do not by themselves implement Go method-set tests,
comma-ok zero results, single-result panics or ordered type switches. The
mapper must construct exact target zero results on failed comma-ok assertions;
native `TryGet` leaves its output unassigned instead. Value assertions copy;
pointer assertions retain nil/location identity under the mapping.

Go equality requires dynamic source identity and recursive comparability,
including matching non-comparable values faulting rather than returning false.
Floating NaN/signed-zero rules, blank fields, equality-consistent hashing,
panic payload/version and package privacy are separately proved policies.
The native equality deferral does not admit any Go comparison or map key.
Where two Go source identities map to the same G# type, an approved mapping
must preserve that distinction without public application tags, or block them.

The existing schema/profile v1, `migrationReady: false`, M0 Linux-only
execution/trust boundary and proposed `go2gs.execution-contract` are unchanged.
ByteString APIs being in-tree does not imply a released/pinned capability or
admitted text corpus. Interface design proceeds independently of that schedule.
Value arrays, maps, control effects and concurrency remain separate tracks.

### 11. Independent witnesses and admission gates

The matrix below is an **obligation plan**, not executed probes. Product work
must add focused tests with independent expected values and ADR-0154 witnesses.
Use real compiler/driver paths and verify emitted IL where relevant.

| Axis | Positive and negative observations | Discriminating mutant or paired witness |
| --- | --- | --- |
| Presence | Absent `Message?`, present non-null payload and present `string?` nil are three different cases. Reject untyped nil insertion and uninitialized `Message`. | Collapse nil payload into absence; assert presence and exact extraction success separately. |
| Type retention | Recover the same concrete message through two capability views; a different concrete type fails extraction. | Replace original evidence with the current view/wrapper identity. |
| Views | Known matching slots call exact members; known missing slots test false. Unknown capability closure fails compilation/import, not false. | Drop negative knowledge or accept missing evidence as a mismatch. |
| Insertion copy | Change the original struct after insertion; extracted saved scalar stays unchanged. Mutate a shared array field; its change remains visible. | Retain the original variable as a location; deep-copy a shared field. |
| Repeated snapshot calls, receiver gate | Two mutable calls return 11 and 11, not 11 and 12; external shared-field effects remain visible. | Reuse one mutable receiver box across calls; suppress reference-field effects. |
| Selected location, receiver gate | Rebinding the handle variable does not retarget. External pointee writes affect the next snapshot call; receiver-local writes do not. | Copy at insertion instead of invocation; reread the handle variable on each call. |
| Nil location, receiver gate | Nullable-location body sees nil and returns its own result. A value-method read of nil fails before the body counter increments. | Eagerly dereference both modes; invoke a null CLR instance instead. |
| Method values, receiver gate | Repeated captured snapshot calls do not share receiver-local mutation. Two escaping receiver locations remain distinct. | Capture one call temporary at method-value creation or reuse one cell. |
| Equality/export boundaries | Presence comparison works; entry equality, default generic comparer and implicit CLR export are rejected. Ordinary CLR interface equality still works. | Permit a generic/object escape to backing-box equality or ban ordinary nominal equality. |
| Separate libraries | Ref-only and implementation imports agree on closed positive/negative witnesses, nullability and original identity. Old/unknown revisions reject. | Omit evidence from the reference assembly; identify unrelated same-name types as equal. |
| Ordinary behavior | Two ordinary struct/adapter increments persist; exposed `adapt` evaluations stay fresh, null inputs reject, extensions do not satisfy slots. | Route ordinary calls through the snapshot plan or transparently unwrap an adapter. |
| Go mapping | Independently authored Go/G# oracle pairs distinguish typed nil, source identity, receiver mutation and comparison faults. Unsupported neighboring cases remain blocked. | Merge source identities, treat a non-comparable value as false, or admit a method-set mismatch. |

Record the applied mutant diff and artifact movement, then red/green results.
A diagnostics test must also compile the proposed remedy. Do not use only
message text, a round trip to itself or an empty quantified assertion.
Unsupported-case diagnostics need source locations and stable boundary reasons.

Review handwritten and translated output independently of runtime fidelity.
Both message and strategy examples must remain readable without generated
public boxes, tags, dispatch tables, universal helpers or pervasive casts.
Inspect emitted public/ref signatures as well as pretty source. A clean
printer cannot hide an unsound boundary, and a correct runtime cannot justify
unreadable source. The docs-only PR runs no product mutants or new syntax.

### 12. Phased rollout, not automatic acceptance

1. **Design acceptance:** maintainer accepts or revises this category contract.
   Green docs CI and a COMMENTED automated review are not semantic acceptance.
2. **Bounded proofs:** prove presence/flow, closed evidence, exact class views,
   ref-assembly metadata and nonbreaking parsing. Stop at a failed boundary.
   Prototype storage privately; do not adopt proposed syntax in repository code.
3. **Receiver design gate:** a separate Proposed ADR must earn snapshot and
   nullable-location modes, capture rules, imported contracts and non-Go uses.
   Category storage/type retention need not wait for that design; affected
   callable slots and the strategy example must wait.
4. **Focused implementation after acceptance:** implement only proved surfaces,
   tooling/diagnostics and discriminating tests. Keep foreign interop and other
   unsupported neighbors rejected. Do not expand this docs PR into code.
5. **Release:** publish implemented compiler/runtime contract revisions.
6. **Separate verified pin movement:** follow the N-1 rule in a new PR with a
   clean-clone build. In-tree implementation is not permission for source use.
7. **Capability probes:** bank exact released/pinned revisions, JIT/AOT,
   separate-library, cost and clean-output evidence. Design obligations are
   not reported as completed probes.
8. **Go family admission:** accept a separately verified finite mapping under
   ADR-0191. Missing receiver, source-identity, equality or boundary proofs
   continue blocking their operations. No broad application-readiness claim.

## Consequences

- Handwritten capability-oriented code can retain concrete evidence without
  carrying the source and each nominal wrapper side by side.
- Ordinary CLR interfaces, adaptation and source method semantics do not change.
- Presence is useful independently of optional slots; snapshot dispatch remains
  a separate explicit choice rather than an inseparable Go mode.
- Finite manifests restrict unknown future capabilities and plugins. This is a
  stated admission limit, not a promise of open-world structural dispatch.
- Compiler recognition is required for presence, flow, views and metadata.
  A library-only implementation cannot claim these language guarantees.
- Equality and CLR export stay unavailable until their own contracts are proved.
- The strategy use case remains an acceptance obligation for receiver design,
  not evidence that snapshot or nullable-location receivers already exist.

## Alternatives considered

| Candidate | Assessment |
| --- | --- |
| Current language/library only | Keep source values plus nominal adapters, use rich objects to request per-call copies, and use managed handles for locations. This is the working baseline, with no new compiler contract. It cannot transparently retain type evidence across erased views or distinguish nullable payload presence without an explicit sum/envelope. Handwritten protocols are possible, but exporting that bookkeeping is not the desired reusable language surface. |
| **Opt-in interface-value category** | **Recommended.** It gives typed calls, explicit insertion and evidence-preserving views a distinct boundary. It can prohibit ambiguous operations without altering nominal CLR behavior. Cost: new type/flow rules, finite evidence and versioned metadata. |
| Compiler-recognized library storage plus hidden evidence | Viable as the recommended category's backend. As the public design it still needs all the same call/test/presence/compiler rules; an ordinary library type alone does not supply them. Reject a caller-tag or universal-Invoke API. Do not publish a second competing envelope surface. |
| Nominal interfaces plus explicit hidden boxes/forwarders | Reuse exact forwarding emission internally where useful. As a complete source model it cannot rely on ordinary CLR tests, nullness, wrapper equality or mutable boxed receivers for the required observations. Adding special extraction, presence, conversion and generic rules recreates a category boundary. Reject wrapper leakage rather than claiming nominal boxing already meets the contract. |

No alternative is selected as a universal runtime layout. If proofs show that
the category cannot enforce its boundaries across public signatures, revise
or narrow it before acceptance. Do not substitute reflection or weaken unknown
evidence into a successful or negative runtime type test.
