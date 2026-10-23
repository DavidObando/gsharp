# ADR-0205: Native protocols with type-preserving values

- **Status**: Proposed
- **Date**: 2026-10-21
- **Revised**: 2026-10-22
- **Phase**: Design only; no implementation authorization or semantic acceptance
- **Issue**: [#5097](https://github.com/DavidObando/gsharp/issues/5097)
- **Related**: [#4333](https://github.com/DavidObando/gsharp/issues/4333),
  [#5099](https://github.com/DavidObando/gsharp/issues/5099),
  [ADR-0191](0191-go-to-gsharp-migration-tool.md) sections 1.1 and 7,
  [Withdrawn ADR-0206](0206-explicit-snapshot-and-selected-location-receivers.md),
  [ADR-0182](0182-receiver-clause-is-always-extension.md),
  [ADR-0188](0188-heap-storable-managed-references.md),
  [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md),
  [ADR-0154](0154-test-oracle-strength.md)

## Context

### 1. Handwritten programs first

A message router needs heterogeneous storage, optional capabilities and concrete
recovery without carrying each nominal adapter beside its source. Ordinary
interfaces and `adapt` already provide typed CLR forwarding. They do not preserve
the source type through tests on the adapter itself.

This revision recommends a native `protocol` declaration and target-typed
conversion. All protocol examples are **hypothetical design sketches**.
No published compiler supports them, and none was compiled for this document.
`Print` denotes an application function.

```gsharp
protocol Message {}
protocol Auditable { func Describe() string; }

class OrderPlaced(Number int32) {}
class Heartbeat {}

func (order OrderPlaced) Describe() string -> "order"

let order = OrderPlaced(42)
let message Message = order
if message is Auditable audit {
    Print(audit.Describe())
    if audit is OrderPlaced recovered {
        Print(recovered.Number)
    }
}
let optionalAudit Auditable? = message as Auditable
let heartbeat Message = Heartbeat()
// A validated Heartbeat/Auditable mismatch yields false or absent.
```

The extension remains an ordinary static extension, not a newly attached
instance member. A validated typed witness makes it usable for protocol
conformance. Renaming a category alone cannot provide retroactive conformance.
Section 4 specifies candidate selection, authority and separate-library limits.

Concrete recovery above is an ordinary-compatible, non-null type-pattern
candidate. It is not an exact-insertion-type assertion or a solution for typed
nil. Section 6 distinguishes those operations.

### 2. Current baseline and why adaptation survives

These are existing contracts, not completed protocol implementation evidence:

| Mechanism | Current contract and protocol boundary |
| --- | --- |
| Receiver-clause extensions, ADR-0182 | `func (r R) Foo() T` is static, with a by-value parameter zero. It is not a nominal member and has no new private access. Protocol witness eligibility must not change direct extension calls. |
| Ordinary struct instance methods | Calls on writable addressable storage may mutate it. Existing readonly defensive-copy rules remain authoritative. |
| Managed locations, ADR-0188 | A handle selects supported original storage. `*h` is a permission-checked lvalue; `Borrow()` returns exact `ref T` or `ref readonly T`. Whole-value writes require that exact storage type. |
| Adaptation, ADR-0189 | `adapt[I](x)` creates a fresh nominal CLR implementing wrapper. It saves one mutable struct copy, or retains an object/explicit handle. It rejects unsupported/null sources and exposes the requested nominal contract. |
| Rich objects, ADR-0189 | Ordinary fields, captures and forwarding bodies can already express independent trials, retained handles and richer member surfaces. |
| Existing patterns and safe casts | Nominal CLR tests, nullable results, definite-assignment regions and safe-cast target restrictions are current language behavior, not protocol evidence lookup. |

Inspection anchors include `BindStructuralAdaptation` in
[Binder](../../src/Core/CodeAnalysis/Binding/Binder.gs),
[member emission](../../src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.gs),
[ManagedRef](../../src/Sdk/Gsharp.Runtime.Values/ManagedRef.gs),
[adaptation language tests](../../test/Compiler.Tests/InterfaceAdaptationLanguageTests.gs)
and [adaptation review tests](../../test/Compiler.Tests/InterfaceAdaptationReviewTests.gs).
They exercise current storage/forwarding, not this proposal.

**Keep `adapt` as the working CLR bridge.** Native protocols do not automatically
implement nominal CLR interfaces. Nor do they inherit the wrapper's observable
identity, equality, null behavior, properties/events, larger member surface or
safe foreign export. A protocol-to-CLR replacement requires a separately proved
interop contract. This is a concrete division of responsibility, not two
interchangeable capability APIs. Protocols aim at type-preserving native views;
adaptation supplies exposed nominal implementations today.

Independent Quote trials do not establish a language requirement. A local copy
inside an ordinary forwarding body already requests a fresh trial. This ADR
does not add receiver kinds, automatic resets or per-call snapshot construction
modifiers. ADR-0206 is withdrawn, not a remaining acceptance prerequisite.

## Decision

**Recommend native protocols, statically proved target-typed conversion, and
paired `is`/`as` views with stable typed witnesses. Copy a concrete struct once
at conversion; retain a concrete object reference. Preserve ordinary receiver
semantics. Investigate source-location projections without changing
`managed[T]`.**

Every recommendation remains Proposed. The confirmed conversion direction does
not settle representation, ownership of copied protocol values, location-view
syntax or metadata. The explicit proposed choices and acceptance gates below
must not be reported as accepted semantics.

### 3. Declaration, conversion and stored mutation

Recommended declaration spelling is `protocol Name { ... }`. Contextual parsing,
existing identifiers named `protocol` and old grammar compatibility require a
parser proof. No global keyword reservation is authorized.

`let p MyProtocol = x` is the baseline language spelling when conformance is
statically proved. It evaluates `x` once and constructs a present protocol value.
There is no recommended public packing/extraction library or alternate envelope.
The same proof must govern argument, return and assignment conversion points.

For a **struct**, conversion copies `x` once, shallowly, into persistent saved
storage. Ordinary instance calls mutate that saved storage across calls, not
the original `x`. It is neither immutable storage nor a fresh call receiver.
Class, array, slice and managed-handle fields preserve their ordinary sharing.
Replacing such a field in the saved struct does not replace the original's
field; mutating their shared referent can affect both.

Hypothetical protocol trace, assuming a legal ordinary mutating receiver:

```gsharp
protocol NextValue { func Next() int32; }
struct Counter {
    var Step int32
    func Next() int32 {
        Step += 1
        return Step
    }
}
var x = Counter{Step: 10}
let p NextValue = x
x.Step = 30
Print(p.Next()) // 11
Print(p.Next()) // 12
Print(x.Step)   // 30
```

For a **class**, retain the evaluated object reference. Rebinding `x` does not
retarget `p`; mutation of that object remains shared. If `a` has state 10,
`p` is constructed from `a`, and `a` is rebound to another object with state 90,
`p` still calls the old object. A capability view must not wrap the new object.

An extension witness over a struct instead receives its ordinary by-value
copy on each call. If its body increments `Step`, two calls from saved state 10
can return 11 and 11, leaving saved `Step` at 10. That is the existing extension
contract, not a new protocol receiver policy. An instance witness starting at
10 returns 11 and 12. Do not normalize one into the other. Readonly instance
receivers and readonly handles retain their existing permission/copy rules.

Converting an already-erased protocol value is transport or a capability view,
not a second concrete insertion. Preserve original evidence; do not store a
protocol box as a new concrete payload or implicitly unwrap an ordinary adapter.

### 4. Retroactive conformance, selection and coherence

The intended source experience includes adding a protocol and ordinary
extensions for a type owned by another library. A user should then write
`let p MyProtocol = x` without public wrappers, manual tags or witness tables.
This resembles Swift's retroactive conformance goal, but does not adopt Swift's
conformance declarations, global lookup/coherence rules or ABI. In particular,
ADR-0182 extensions stay static and never enter the receiver's nominal method
table. Their participation below is new protocol validation only.

Proposed conformance binding rules:

1. A conformance record identifies an exact concrete type `T`, protocol `P`,
   contract revision and one typed target for each slot. Identity includes
   assembly, constructed types and nullability, not short names.
2. At the conformance's defining compilation, first select an exact accessible
   ordinary instance member using existing applicable member rules. If there
   is none, consider ordinary receiver-clause extensions visible in that
   compilation's explicitly imported scope. Use existing extension applicability
   and overload resolution; initial proof requires exact supported signatures
   without signature adaptation. An inaccessible instance member grants no
   private authority; an independently accessible extension can qualify.
3. Ambiguous applicable candidates are a diagnostic, not import-order priority.
   Unsupported signatures are not silently skipped to manufacture a negative
   conformance. The first proof rejects those cases at the boundary.
4. Record exact target identities, receiver convention and accessibility
   authority. Runtime dispatch uses those targets. A later import does not
   re-run extension search or rebind an old conformance.
5. At a composition boundary require one canonical compatible record per
   `(T, P)` within that program's validated closure. Two independent libraries
   choosing different witnesses are a conflict diagnostic, not last-writer
   wins or whichever view was tested first. Identical re-exported records can
   be recognized by origin and exact contract identity.
6. Calls/tests use that record, including its negative decisions. Local
   conversion sites cannot quietly create incompatible records. The mechanism
   for declaring/exporting a canonical record and deliberately resolving
   conflicts remains a source/metadata acceptance gate; no syntax is invented
   here to conceal that requirement.

A private extension cannot be exported as callable public witness authority.
A defining library may expose an ordinary legal public forwarder which uses
its own private implementation; a consumer may bind that public contract.
Neither a protocol declaration nor possession of a type descriptor grants
access to another library's private members. Opaque private concrete identities
may be exported by their owner for existing witnesses without becoming
consumer-nameable or permitting concrete recovery.

Separate-library example: library A owns `Counter`; library B owns `NextValue`
and an accessible extension for `Counter`; library C references both. C can
validate and emit a witness without changing A. If D supplies a conflicting
`Counter/NextValue` record, composition must diagnose it. Adding D to C cannot
change an already-bound call in A or B.

This is deliberately more than a spelling change. Declaration authority,
cross-unit conflict detection and ref-only import parity must be proved before
claiming usable retroactivity.

### 5. Presence and evidence completeness

`P` denotes a present protocol value. `P?` also permits outer absence (`nil`).
Use ordinary `if let`, `?.`, `!!` and nullable presence checks. A present value
may contain an explicitly nullable payload whose current value is nil.
Outer absence has no payload/evidence; present typed nil has both.

| Input/operation | Proposed boundary |
| --- | --- |
| `default(P?)` | Absent. |
| Uninitialized non-null `P` or `default(P)` | Reject unless valid initialization is proved; no fictitious concrete payload. |
| Bare `nil` to non-null `P` | Reject: no insertion type evidence. |
| Typed nullable payload to an empty protocol | Potentially present typed nil; requires explicit presence-preserving conversion and evidence proof. |
| Nullable class payload to an instance-method protocol | Reject without a separate proved safe entry contract; current non-null value alone cannot erase declared nullability. |
| Open base/object/interface source with unknown concrete type | Initially reject original-concrete evidence claims; no `GetType()` discovery fallback. |
| Existing ordinary adapter | At most evidence for that adapter as a CLR object, never automatically its hidden source. |

The nullable-payload conversion in this table remains an admission gate.
In particular, overload/conversion ranking must distinguish lifting outer
absence from constructing present typed nil. No ambiguous nullable assignment
is claimed to work merely because non-null conversion has a recommended spelling.
Platform `T!` stays distinct from `T?`; use the existing ADR-0193 producer funnel
and readers, not another nullability computation.

The **bounded first proof** uses finite exact insertion types and finite
protocols, including positive and negative conformance records. A manifest
certifies only its declared closure. Missing evidence is **unknown**, not a
negative answer. Reject the query at compilation/import/link validation if its
coverage is unknown; invalid runtime contract versions fail the explicit
boundary before dispatch, not an ordinary false result.

The **long-term source goal** includes protocols authored after a source
library shipped. A closed old producer manifest cannot promise arbitrary
future consumer protocols. A consumer can generate supplemental typed evidence
only for a complete accessible finite set of source types with legal targets,
then explicitly validate the composed closure and coherence. An old opaque
erased payload without sufficient descriptors/authority remains blocked.
Rebuilding/re-exporting an expanded producer closure is one bounded remedy,
not the desired universal source experience.

The mechanism to compose supplemental evidence across reference assemblies,
public exports and independently compiled consumers remains an acceptance gate.
No ambient registry, dynamic shape search, unrestricted reflection or later
import is allowed to extend an existing conformance silently. Open generic
insertion and unbounded plugins remain outside the first proof. Generic
containers do not waive presence, copy, escape or evidence checks.

### 6. Paired capability tests and concrete recovery

Within a validated closure, both forms use the **same stable conformance**:

```gsharp
if message is Auditable audit {
    Print(audit.Describe())
}
let audit Auditable? = message as Auditable
```

| Case | `is Auditable audit` | `as Auditable` |
| --- | --- | --- |
| Present, known conformance | True; bind a present view. | Present `Auditable?` result. |
| Present, known mismatch | False; no success binding. | Absent result. |
| Outer absence | False; no payload read. | Absent result. |
| Missing/unknown evidence | Boundary diagnostic, not false. | Same boundary diagnostic, not absence. |
| Present typed nil | Use its recorded conformance, not outer nullness. Empty/safely proved contracts can match. | Same decision; successful view is present despite nil payload. |

A view preserves the selected payload storage and original evidence, not
nested adapter identity. Section 7 makes the aliasing choice explicit.
For source-location projections, section 8 distinguishes selecting the view
from reading the current referent. A capability test cannot introduce an
implicit retarget or invent a safe nil instance receiver.

Integrate protocol targets with existing pattern binding and flow regions.
Success variables obey existing definite assignment, `&&` short-circuiting,
direct negation false-branch binding and restrictions under `or`/nested `not`.
Property and list-pattern composition keeps its current evaluation and scope
rules; a protocol view does not gain undeclared properties or list operations.
An unsupported composition diagnoses rather than changing the meaning of a
neighboring nominal pattern. No special out-variable flow model is required.

Existing nominal CLR `is`/`as` on ordinary objects/interfaces stay unchanged.
For ordinary concrete recovery from a protocol, explore reusing `is T name`
with ordinary-compatible payload type relations, rather than testing the
backing object's CLR type. For a non-null class, a compatible base pattern can
match, just as for an ordinary value. A struct pattern binds a shallow value
copy of its **current saved state**, not a writable alias. Concrete `as`
recovery, if admitted, must retain existing target rules: ordinary non-nullable
value-type targets remain invalid (`GS0270`), not a new extraction loophole.
Protocol-target `as` is a specifically new fallible view returning `P?`.

Ordinary type compatibility is **not exact insertion evidence**. A base-class
match does not certify that the base was the exact insertion type. Exact
nullable/constructed insertion-type assertions need a distinct justified
language contract if later required; this ADR selects no extra public API.
The initial concrete-evidence proof may restrict class insertion to sealed
concrete types without redefining ordinary base patterns.

An ordinary type pattern does not extract a nil payload as a non-null `T`.
A present `string?` nil can fail `is string text` while remaining present.
A failed nullable `as` concrete result cannot distinguish that nil from a
mismatch or outer absence. **Ergonomic typed-nil concrete recovery is unresolved.**
Options include a presence-aware pattern extension with a genuinely nullable
binding, or deferring that recovery family. Neither is ordinary `is` secretly
binding nil, nor a counterfeit `default(T)` on failure. Until selected and
proved, keep the operation blocked rather than add an envelope.

### 7. Copying protocol values, views and extraction

The maintainer confirmed one-time shallow concrete conversion and persistent
stored mutation. That does **not** settle whether copying an already-created
protocol duplicates its saved struct. This is a separate acceptance decision.

**Coherent proposed baseline: protocol values retain a shared semantic entry.**
Concrete-to-protocol conversion creates independent saved struct storage once.
Ordinary copies of that protocol value and successful capability views retain
the entry, including its mutable saved struct. This is deliberate reference-like
transport of the protocol entry, not accidental sharing from CLR boxing.
It does not alias the original concrete variable.

For saved `Step = 10`:

| Operation sequence | Observation under this proposed baseline |
| --- | --- |
| Construct `p` from concrete `x`; construct `q` independently from `x` | Two independent saved struct copies. Mutating `p` does not advance `q` or `x`. |
| Construct `p`; assign `q = p`; call `q.Next()`, then `p.Next()` | 11, 12: protocol assignment retains the same saved entry. |
| Obtain capability view `v` from `p`; call through either | Both see the same saved state and stable witnesses. |
| Copy `v` to another view local | Retain the same entry; no second insertion or extra struct copy. |
| Rebind the protocol variable `p` after saving `v` | `v` retains the old entry; it does not follow the variable `p`. |
| Extract concrete struct `s` using a successful pattern; mutate `s` | Mutate an independent shallow copy of current saved state. Referenced fields still share normally. |
| Extract concrete class/managed handle | Retain the object/selected handle with its existing permission and identity. |
| Pass or return a protocol by value | Same entry-retaining semantics as assignment, including across metadata-aware G# libraries. |

This recommendation is **not confirmed ownership semantics**. An alternative
is value-like protocol assignment with a logical struct copy, while reference
payloads retain object references. That alternative must specify whether
capability views also copy, or use a distinct retaining view category. Copying
on every view would not preserve selected mutable storage; mixing copy/share
based only on an invisible compiler box is unacceptable. Another alternative
is an explicit language copy operation with retaining default transport.
Acceptance must choose and document one complete model before implementation.

The baseline avoids mixing hidden ownership kinds on assignment: every protocol
copy retains its entry; only independent concrete insertion/extraction copies
struct state. Location projections retain their selected storage, not a detached
entry pretending to be that storage. Internal cell promotion must preserve
early aliases and lifetime. A projection cannot outlive an owner it fails to
retain. Raw byrefs cannot escape to implement any of these choices.

No CLR box identity becomes a public protocol equality, hash or `GetType`
contract. Initial native equality/hash operations other than outer presence
checks remain rejected, including generic/default comparer or object escapes
which expose backing storage. Foreign exports are likewise initially rejected.
Sharing mutation is an explicit semantic observation; `ReferenceEquals` on an
implementation box is not. No concurrency isolation or deep immutability follows.

### 8. Original-source storage and the managed boundary

The maintainer's candidate **`managed[MyProtocol](x)` means alias the original
source storage of `x`**. It must not copy `x` into a protocol entry or allocate
a new protocol-valued slot and claim that slot is the original.
The spelling is hypothetical, not current syntax or an approved ABI.

There is a real conflict with the existing invariant `managed[T]` contract.
A `managed[Counter]` can expose `ref Counter`, read/write a whole `Counter`,
and select fields using Counter's storage layout. A writable
`managed[NextValue]` would allow storing any `NextValue`. A conforming
`OtherCounter` cannot be written into a `Counter` slot. Neither covariance,
a checked box copy nor silently switching to readonly solves that contract.

Distinguish these two objects:

- **Managed location containing a protocol value:** first construct
  `var p MyProtocol = x`, then use existing `managed(p)` after protocols are
  supported. Whole writes replace the protocol value in that protocol slot.
  That slot is not the original `Concrete` slot.
- **Protocol view of existing concrete storage:** select `x` itself and
  forward allowed operations against its current contents. It needs a
  restricted projection contract, not `ref MyProtocol`.

Concrete alternatives for design proof:

| Alternative | Permitted behavior and conflict |
| --- | --- |
| Distinct projected-location/protocol-view type with language selection syntax still to choose | Retain owner/path and exact underlying storage type. Allow validated typed calls with original permissions; no `Borrow(): ref P`, raw projected lvalue or arbitrary whole-protocol write. This best preserves the requested aliasing without redefining `managed[T]`. |
| Candidate spelling constructs that distinct projection type | Possible only with an explicit, non-misleading type/diagnostic story. It must not claim its result is ordinary invariant `managed[P]`. Parser and API consistency remain open. |
| Exact managed handle plus a separately selected capability projection | Existing handle keeps `Borrow` and whole `Concrete` writes. Projection only forwards proved operations. This adds a selection step, not a public envelope or detached copy. |
| Readonly projected view | Useful only when explicitly requested. It cannot replace the requested writable source alias or silently admit mutating instance slots through defensive copies. |

Recommended proof target is the distinct restricted projection. Restrictions
are part of its explicit type contract, not a silent weakening of `managed[T]`.
Whether optional exact-type replacement can be exposed remains open; it must
require the original `Concrete`, never an arbitrary conforming protocol.

Required selection/read/fault rules for that proof:

1. Select supported source owner/path once using ADR-0188 checks and location
   identity. Owner/index evaluation and selection faults occur at selection,
   not at each protocol call. A copied projection retains that location and
   permission, without copying the referent.
2. Replacing a struct in that same source slot changes subsequent calls:
   select `x` at Step 10, set `x = Counter{Step: 30}`, then a mutating instance
   call returns 31 and leaves `x.Step` at 31. A detached entry would be wrong.
3. For a **class-variable slot** projection, rebinding that slot makes a later
   call observe its current object. This differs from ordinary protocol
   conversion retaining the old object. Selecting `owner.Field` instead
   retains the object root/path chosen at selection; rebinding `owner` cannot
   redirect it. Traversal through references obeys ADR-0188 root selection.
4. Capability `is`/`as` validates the fixed exact source-slot type/witness,
   without reading its current payload or selecting another location. Initially
   reject polymorphic slot types needing unknown dynamic evidence. Capability
   success does not certify a non-nil current referent.
5. Proposed direct-call trace: evaluate the projection receiver once; check
   outer presence, permission and required handle validity; prepare the
   ordinary typed receiver; evaluate arguments once in ordinary source order;
   invoke once. For a class slot, read/retain its current object during receiver
   preparation, before arguments. Argument-side replacement cannot retarget
   that pending call. For a by-value extension, read/copy the current value
   there instead. For a struct instance, retain the exact location there and
   acquire the safe typed borrow only for invocation after argument evaluation.
   Argument-side replacement of that same struct slot is therefore visible
   to the instance body. No raw borrow may span an unknown/suspending argument.
6. A nil required handle faults during receiver preparation, before arguments
   or body. A valid class slot containing nil can be read successfully; a
   non-null instance invocation then faults after arguments, before body entry.
   An exact static extension legitimately accepting that nullable class instead
   receives nil without an injected instance check. Evidence-only view selection
   performs none of these reads. Nullable handle, nullable referent and absent
   protocol remain different positions. These traces are proof targets, not
   permission to change existing calls if their established timing differs.
7. Concrete extraction, if admitted, reads at extraction time. A successful
   struct extraction copies; class extraction retains the current object.
   Its ordinary non-null pattern may fail for nil without collapsing protocol
   presence. Exact read/body/argument traces must be specified and tested
   before admitting this surface; unsupported nil/timing cases stay blocked.

Writable projections may call mutating instance witnesses on original storage
only with a proven lifetime-safe typed borrow. Readonly projections cannot gain
writes via a view, witness, inference or import. No borrowed raw byref may cross
suspension or unknown retaining boundaries. Scoped provenance, receiver-derived
escaping locations, imported body effects and method-value capture require
focused proofs. Lack of proof diagnoses; there is no hidden copy fallback.

Projection identity follows the underlying canonical owner/path, but it does
not grant protocol equality. Any future location-identity observation must
compare locations, not CLR wrapper references or mutable contents. Metadata must
record exact underlying type, witness, permission, lifetime/provenance contract,
selection/read timing and replacement rules. Reference and implementation
assemblies must agree. Current managed metadata does not already encode this
new projected view.

### 9. Lowering and separate-assembly proof gates

A possible backend uses typed storage cells and exact typed forwarders.
The saved struct is mutable. Entry evidence and selected witness bindings can
be immutable without making the payload immutable. Class payloads retain object
references; projected views retain original locations. No per-call reset,
new ordinary receiver kind or invocation-time fresh-storage policy is needed.

Typed forwarding must preserve instance mutation versus extension by-value
copying. It must also preserve ordinary evaluation, exceptions, readonly rules
and safe receiver lifetime. Reusing adaptation emission does not prove those
facts for native evidence/views, projections or escaping receiver locations.
Reject unsupported member families rather than quietly use another receiver.

Use exact typed methods/delegates, not `object[]`, universal `Invoke` helpers,
reflection proxies or public type tags. Internal cells, boxes and witness
records are hypotheses, not an exposed CLR ABI or allocation promise.
Method values and callbacks need a proof consistent with retained entry or
selected location and current ordinary capture rules; no fresh-call policy
is introduced here.

Implementation and reference assemblies need versioned evidence for protocol
identity, exact insertion identity/nullability, closure coverage including
negative knowledge, canonical conformance origins/targets, receiver conventions,
storage transport and permission/lifetime contracts. Exported signatures must
preserve these facts. Unknown, stale, conflicting or malformed revisions fail
the boundary; ordinary CLR attributes alone are insufficient.

Generate identities and witness order deterministically from canonical
declarations/signatures, never hash iteration, task completion or runtime handles.
Exact generic substitution and nullability imports use existing funnels/readers.
The first proof may exclude generic protocols/slots, ref-like or borrowed
payloads, rich property/event/ref signatures and unknown dynamic loading.
Such exclusions bound proof scope; they do not redefine existing ordinary code.

Costs to measure after acceptance include insertion copies/allocations, retained
graphs, large structs, shared views, concrete extraction, projected calls and
separate-library metadata/code size under JIT/AOT. Compare handwritten controls.
No prototypes, benchmarks, IL checks or product test results are claimed here.

### 10. Go correspondence remains separate

ADR-0191 owns Go family admission. Native protocols do not automatically prove
Go defined/alias identity, `T` versus `*T`, package-private method authority,
embedding, typed nil, assertions, equality or method-value capture. Go
value-receiver copies are a frontend mapping obligation, not the native
instance-call default. Ordinary by-value extensions are a possible building
block only where the complete mapping is proved.

Go comma-ok failure must produce its exact target zero; native pattern failure
does not manufacture an initialized non-null binding. Go pointer identity and
nil/body fault order require separate correspondence. Go comparability, dynamic
comparison faults and hashing cannot use internal box identity. Missing mappings
remain attributed boundaries.

Schema/profile v1, `migrationReady: false`, M0 execution/trust restrictions and
the proposed execution contract are unchanged. Bytestring APIs in-tree imply
neither released/pinned features nor Go readiness. Arrays, maps, control effects
and concurrency remain separate tracks.

### 11. Obligation and observation matrix

This is a **future design/test obligation**, not executed evidence. No new
syntax tests, product mutants, probes or benchmarks were run for this docs PR.
After semantic acceptance, behavioral tests need independent oracles and
ADR-0154 discrimination using real compiler/driver paths.

| Obligation | Expected observation / negative boundary | Error a future witness must distinguish |
| --- | --- | --- |
| One-time shallow conversion | After saving Step 10, original becomes 30; saved instance calls return 11, 12 while original stays 30. Shared referenced-field changes remain visible. | Original-storage alias, fresh-call copy or deep clone. |
| Persistent stored mutation | Repeated instance calls advance the same saved state. Existing readonly rules are not bypassed. | Immutable entry assumption or temporary receiver each call. |
| Retained class and reassignment | Ordinary conversion retains old object after source rebinding; mutations of that object remain shared. | Following the source variable instead. |
| Live selected storage/replacement | Project original struct slot at 10, replace with 30, call: 31 in original slot. Class-slot projection follows replacement; selected old object field does not retarget. | Detached box, capture-time payload or expression re-evaluation. |
| Extension by-value | Same initial scalar gives 11, 11 through mutating by-value extension, versus 11, 12 through instance witness. Reference-field effects persist normally. | Treating an extension as a byref nominal instance member. |
| Paired capability tests | Match binds/presents; known mismatch returns false/absence for both `is` and `as`. `as` has `P?` result. | Different selection or witness rebinding by operation. |
| Unknown evidence | Missing closure/unsupported revision rejects at compilation/import, not false or absence. | Treating unrecorded as negative conformance. |
| Typed nil and absence | Absent has no evidence; present typed nil retains evidence. Non-null concrete pattern does not bind nil. Typed-nil recovery stays gated. | Counterfeit non-null binding or collapsed presence. |
| Copies/views/evidence | Proposed retaining baseline: `q = p`, then two instance calls across q/p yield 11, 12. Independent concrete insertion and struct extraction copy. Views retain original evidence/storage. | Accidental sharing/detachment, nested adapter or unaccepted value-copy policy. |
| Invariant writes | Two unrelated conformers cannot be written into a narrower Counter slot through a projection. Ordinary `managed[Counter]` still permits exact Counter replacement. | Writable covariance, `ref P` fabrication or silent readonly fallback. |
| Permissions/lifetime/fault timing | Selection once; evidence-only view does not read; current nil faults at the required call/read. Readonly/scoped/escaping unsupported paths reject. | Eager test dereference, retarget, permission gain or dangling byref. |
| Separate-library coherence | A owns source, B protocol/extension, C witness consumer; implementation/ref imports agree. Conflicting D rejects. Later imports cannot rebind old records. | Ambient search, private-authority leak, incomplete manifest or ref metadata loss. |
| Existing language compatibility | Nominal tests, flow/short-circuit/negation/property/list scopes, safe-cast restrictions, managed writes and fresh nominal adapt behavior remain unchanged. | Protocol special cases escaping into ordinary code. |
| Equality/export | Presence works; backing-box equality/hash and unproved CLR export reject, including generic escapes. Adapt still provides nominal CLR interop. | Wrapper identity becoming native semantics. |

Acceptance must decide the ownership fork in section 7, canonical witness
declaration/composition, nullable conversion/recovery, projected-location type
and full fault traces. Unsupported cases need stable diagnostics/source
locations and separately validated remedies, not a false success claim.
Review handwritten and eventual translated output for ordinary calls/tests
without public wrappers, tags or pervasive casts.

### 12. Delivery and acceptance boundaries

1. Review/revise and explicitly accept a bounded protocol contract. This
   document remains Proposed; docs CI or COMMENTED review is not acceptance.
2. Prove parsing, presence/flow, copy/view ownership, exact typed witnesses,
   coherent separate-library evidence and ref metadata. Investigate projections
   independently; do not advertise them until permissions/lifetimes are proved.
3. Only after authorization, implement accepted surfaces with diagnostics,
   tooling and discriminating tests. Keep unproved neighbors blocked.
4. Release compiler/runtime contracts. In-tree source alone grants no adoption.
5. Move the released N-1 pin in a separate verified PR with a clean-clone build
   and release notes. Do not use new features in repository source beforehand.
6. Bank exact released/pinned capability, cost and output evidence. Go family
   admission requires its own verified mapping under ADR-0191.

No compiler/runtime/translator edits, prototypes, pin movement or Go admission
belong in this revision. Keep #5097 open for design acceptance. After a document
merge, the conductor may close #5099 with withdrawal evidence; that is not
acceptance of the former receiver proposal.

## Consequences

- Native protocols aim at reusable retroactive capability programming without
  changing nominal CLR interfaces or ordinary receiver semantics.
- Conversion copies once; persistent saved mutation and shallow sharing are
  explicit. Copied protocol ownership remains a separately identified decision.
- Restricted source-location projections may preserve aliasing, but cannot be
  invariant writable `managed[P]` over arbitrary concrete storage.
- Finite first proofs cannot promise arbitrary future protocols. Cross-library
  evidence composition and coherence are necessary long-term work.
- Adaptation remains useful and operational at the nominal CLR boundary.
- Independent trial policy remains ordinary application composition, not a new
  language receiver mode or mandatory protocol acceptance gate.

## Alternatives considered

| Candidate | Assessment |
| --- | --- |
| Current language only | Working nominal adapters, rich forwarding and exact managed handles cover many APIs. Keep using them where sufficient. They do not transparently preserve concrete evidence across erased capability views. |
| **Native protocol declarations and conversions** | **Recommended for further design.** Typed witnesses can admit ordinary extensions without changing their meaning. Requires explicit coherence, ownership, presence and metadata proofs. |
| Compiler-recognized public packing/extraction library | Reject as recommended spelling. It obscures language-level conversion and pattern intent without removing compiler obligations. Internal library storage remains possible. |
| Hidden nominal boxes as backend | Possible only behind the protocol contract. Ordinary CLR wrapper identity, tests and equality cannot define source evidence/views. |
| Universal shape registry or public Go envelope | Reject ambient/runtime search, caller tags and universal invocation. They neither establish stable authority nor provide the intended G# source experience. |

If representation or cross-unit proofs fail, narrow or revise the proposal.
Do not assert away unsafe storage, report missing evidence as mismatch or
reintroduce the withdrawn receiver modes through another construction spelling.
