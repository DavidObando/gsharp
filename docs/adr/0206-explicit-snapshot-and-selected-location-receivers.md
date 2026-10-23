# ADR-0206: Explicit snapshot and selected-location receiver modes

- **Status**: Withdrawn
- **Date**: 2026-10-21
- **Withdrawn**: 2026-10-22
- **Phase**: Historical design only; no implementation authorization
- **Issue**: [#5099](https://github.com/DavidObando/gsharp/issues/5099)
- **Related**: [#4333](https://github.com/DavidObando/gsharp/issues/4333),
  [Proposed ADR-0205](0205-type-preserving-interface-values.md),
  [ADR-0191](0191-go-to-gsharp-migration-tool.md) section 7,
  [ADR-0182](0182-receiver-clause-is-always-extension.md),
  [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md),
  [ADR-0188](0188-heap-storable-managed-references.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md),
  [ADR-0154](0154-test-oracle-strength.md)

## Withdrawal decision

The maintainer withdrew this feature proposal. Independent Quote trials already
fit ordinary G# local copies and forwarding bodies. The proposal did not
establish why those application policies need new language receiver kinds.
It also conflicted with the confirmed protocol direction: copy a struct once
at conversion and preserve ordinary instance mutations in that saved copy.

Only necessary protocol storage rules and open source-location view questions
continue in Proposed ADR-0205, especially sections 3, 7 and 8. Its location
investigation preserves original-source aliasing without redefining invariant
`managed[T]`. It does not continue snapshot/location slot modes, automatic
fresh-per-call receivers or reset semantics under a construction modifier.
Safe typed protocol forwarding still needs proof, not a new ordinary receiver.

ADR-0205 remains Proposed. Neither its revision nor this withdrawal accepts
new semantics, authorizes product implementation, changes ADR-0182/0188/0189,
moves the SDK pin or admits Go operations under ADR-0191.
Issue #5097 remains open for protocol design. After merge, the conductor may
close #5099 with this withdrawal evidence; this document does not close it.

## Historical proposal — not current recommendation

**Everything below preserves the withdrawn proposal as historical context.**
Words such as “recommend”, “required”, “first proof” and “acceptance” below
describe its former position, not current obligations. Historical links to
ADR-0205 section numbers reflect the old revision and are not current authority.
The former syntax, trial witnesses, receiver gates and metadata plan are not
dependencies of the revised protocol proposal. Do not implement them from this
record or interpret the old Proposed language below as its current status.

## Context

### 1. Independent trials and live configuration

A simulation saves a struct configuration with mutating trial logic. Each trial
should start from that saved configuration. Mutating a scalar during one trial
must not change the next trial's starting point. Shared caches remain shared.
This is useful without Go, dynamic type tests or foreign interface export.

Existing G# can express this with a rich object:

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
// trial.Next(), trial.Next(): 11, 11.
```

By contrast, `adapt[Quote](configuration)` saves one mutable struct field.
Its two calls return 11, 12. Neither behavior is wrong. They serve different
contracts. The repeated copy inside each forwarding method is the reuse problem.
One insertion copy does not solve it.

A live editor provides a second need. A saved callback should follow the selected
configuration location and observe later external edits, without following a
variable that might later contain another handle. A trial against that location
reads its current value but does not advance its scalar state. A commit callback
instead receives the selected handle and may update that location.

Current-language selection can already be explicit:

```gsharp
var original = Configuration{Step: 10}
var other = Configuration{Step: 90}
var handle = managed(original)
let selected = handle
handle = managed(other)
original.Step = 20
var receiver = *selected
let result = receiver.Next()
// result: 21; original.Step: 20; other.Step: 90.
```

An existing nullable-location extension can handle nil without a value read:

```gsharp
func (p managed[Configuration]?) ReadOrMissing() int32 {
    if let present = p {
        return (*present).Step
    }
    return -1
}
let missing managed[Configuration]? = nil
let result = missing.ReadOrMissing()
// result: -1. The static extension receives the nullable handle by value.
```

These are illustrative current-language compositions, not new conformance
fixtures. No snippets in this ADR were compiled as evidence. `managed`,
dereference, nullable bindings, receiver-clause extensions and rich members
are existing constructs. All mode declarations and `values` operations below
are **hypothetical**, not available syntax.

### 2. Inspection evidence, not proposed behavior presented as current

The following evidence was inspected at `622325c41`:

| Current mechanism | Evidence and limit |
| --- | --- |
| Addressable struct mutation | `EmitInstanceReceiver` in [member emission](../../src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.gs) loads addresses for value receivers. `RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy` controls readonly copies. Neither selects a new snapshot-call policy. |
| Static adaptation | `BindStructuralAdaptation` in [Binder](../../src/Core/CodeAnalysis/Binding/Binder.gs) builds an exact nominal adapter and retains its source. ADR-0189 specifies a mutable saved struct, a fresh exposed wrapper per evaluation and null rejection. These remain unchanged. |
| Rich snapshots and retained handles | `RichMutableCapturesShareOneCellPerDynamicBinding` and `RichCaptureAndPersistentHandleAdaptersVerifyAndExecute` in [adaptation tests](../../test/Compiler.Tests/InterfaceAdaptationLanguageTests.gs) distinguish initializers from shared cells. The retained-handle test expects 22 after two increments from 20, including in the original. |
| By-value extension receivers | ADR-0182 makes receiver clauses static extensions, with an ordinary parameter-zero copy. [Extension emission tests](../../test/Core.Tests/CodeAnalysis/Emit/Issue792ExtensionAttributeEmitTests.gs) check CLR extension metadata. `NullableReceiver_Extension_Dispatches_OnStringNullable_NoBodyNullCheck` in [receiver tests](../../test/Compiler.Tests/Emit/Issue773GenericReceiverExtensionEmitTests.gs) exercises static extension entry with nil. Extensions do not enter a nominal method table. |
| Ordinary method values | `EmitMethodGroupTarget`, `EmitClrMethodGroup` and `EmitClosedStaticMethodGroup` in [closure emission](../../src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Closures.gs) evaluate a receiver for a delegate target and box value receivers where needed. This does not create a fresh receiver on every delegate invocation. |
| Retained-location boundaries | [Method-group safety tests](../../test/Compiler.Tests/ManagedReferenceMethodGroupSafetyTests.gs) reject scoped handle receivers as delegate targets and allow non-scoped handle capture. ADR-0188 rejects unknown borrowed provenance and suspended borrowed operations. These are foundations, not proof of the new call plans. |
| Imports | `UserTargetsRespectReadonlyImportedHandleMembers` and imported nullability tests in [adaptation review tests](../../test/Compiler.Tests/InterfaceAdaptationReviewTests.gs) preserve readonly and signature contracts. They do not encode copy mode or new capture timing. |

Existing readonly flags, boxed receivers, `adapt` signatures and static
extensions cannot be interpreted as metadata for the proposal.

## Decision

**Recommend explicit capability-slot modes: a fresh shallow value receiver per
invocation, or a selected managed handle passed to an explicitly named typed
witness. Keep ordinary declarations and calls unchanged.**

Start with a bounded synchronous proof. Do not add a method-declared mode or
automatic extension membership in the first surface. A slot may select a saved
value or a live location, but must record which at insertion. Capturing a slot
never changes that choice. The recommendation, spelling and scope remain
**Proposed**. Merge, green CI and automated review do not accept either this
ADR or ADR-0205. This document authorizes no product changes.

### 3. Contract ownership and candidate spelling

ADR-0205 owns its proposed category, insertion evidence, presence, type identity,
views and equality restrictions. This ADR owns only receiver selection, call
copies, typed forwarding, capture timing and their metadata. It neither accepts
nor replaces that category. Modes can be explored privately without completing
the category, but public capability slots depend on acceptance of both designs.

Candidate slot notation:

```gsharp
interface value TrialQuote {
    snapshot func Next() int32;
}
interface value ConfigReader {
    location func Read() int32;
}

let trial = values.Pack[TrialQuote](configuration)
let liveTrial = values.Pack[TrialQuote](selected)
let reader = values.Pack[ConfigReader](missing, witness: ReadOrMissing)
```

In a handwritten live-preview API, the proposed use would be:

```gsharp
let preview () -> int32 = liveTrial.Next
original.Step = 30
handle = managed(other)
let first = preview()
let second = preview()
// first: 31; second: 31; original.Step: 30; other.Step: 90.
```

`liveTrial` retained `selected`, not the mutable `handle` binding. A shared
array field would still refer to the same array in both call copies. For example,
incrementing its first element in `Next` would accumulate across these calls,
even while each call's `Step` increment remained local.

This uses `snapshot func` from ADR-0205 as a candidate, not as previously selected
syntax. `location func` and `witness:` are also candidates requiring parser and
binding proofs. No new global keyword, public runtime envelope or universal
invocation helper is selected.

For the first proof, each mode-bearing capability has one nongeneric method
slot. Snapshot forwarding selects an exact accessible ordinary struct instance
method, not an extension. Location forwarding requires an explicitly named
static function or receiver-clause extension. Its parameter zero has exactly the
selected handle type `H`; remaining parameters and return match the slot exactly.
For example, `ReadOrMissing` supplies `H = managed[Configuration]?`.
No automatic extension search, conversion ranking or name-based witness lookup
occurs. Witness accessibility is checked at insertion and export.

The location witness need not have the slot's name. The explicit binding is its
authority. This is not structural membership in the underlying struct. A single
exact candidate is required. Multi-slot witness maps, inheritance between
mode-bearing capabilities and overload adaptation remain outside the first proof.
Ordinary non-mode slots keep ADR-0205's independently gated rules.

### 4. Three times, three different operations

| Event | Saved struct snapshot source | Selected-location snapshot source | Selected-location witness source |
| --- | --- | --- | --- |
| Insertion | Evaluate `S` once and save a shallow value snapshot. Later assignments to its source variable are irrelevant. | Evaluate `H` once and save that handle, including nil. Do not read the pointee. | Evaluate `H` once and save that handle, including nil if its exact type permits it. Do not read the pointee. |
| Slot selection / method-value capture | Retain the entry's saved value and exact slot plan. Do not create a mutable call receiver. | Retain the selected handle and exact slot plan, not the variable that contained the handle. Do not read the pointee. | Retain the selected handle and exact witness plan. Do not read the pointee. |
| Each invocation | Shallow-copy the saved value into fresh mutable storage, then invoke the ordinary body on that storage. | Read the selected pointee once into fresh mutable storage, then invoke the ordinary body on that storage. | Pass the saved handle by value to parameter zero. The witness decides whether and when to dereference it. |

Here `S` is an admitted non-null value type. `H` is an admitted writable or
readonly managed handle, with its exact handle/referent nullability. Snapshot
selection through `H` requires non-null `S` as referent in the first scope.
Nullable referents are not implicitly unwrapped.

All copying is **shallow**. A receiver's scalar assignments stay local.
Class, array, native-slice and managed-location fields preserve their ordinary
sharing and permissions. Incrementing a shared cache counter through such a field
is visible to later calls. Replacing the field in the temporary is not.
Neither mode promises deep cloning, deep immutability or race isolation.

For `Step = 10`, saved-value trial calls return 11, 11. Changing the original to
20 after insertion still yields 11. Live-location trial calls after that edit
return 21, 21, leaving the original at 20. Rebinding `handle` to `other` never
changes the selected location. Reassigning the original *pointee* changes what
the next live read sees. These are different operations.

### 5. Evaluation, copy point and fault order

For every **new mode-bound invocation**, the call plan is:

1. Evaluate the receiver expression once. Retain its selected entry/handle.
2. Evaluate explicit arguments once, left to right, into typed values.
3. Execute the receiver preparation from section 4. The live snapshot read
   occurs here, after all arguments and immediately before body entry.
4. Invoke the exact typed body/witness once. Preserve its ordinary effects,
   return and exceptions. Do not reread the source variable or copy back.

Nested expression evaluation retains ordinary G# rules inside each expression.
This specifies new call nodes only, not a retroactive rule for existing calls
or a universal Go operand-order rule. An absent outer capability must first be
narrowed or explicitly checked with `!!`. That check is part of receiver
evaluation, before arguments. `?.` follows ordinary short-circuit absence rules.

If receiver evaluation fails, no arguments run. If an argument fails, no
snapshot read or body occurs. If an argument edits the selected pointee, the
live snapshot sees that edit. If it rebinds the handle variable, the selection
does not change. Saved-value snapshots are unaffected by either scalar change.
Argument values may themselves retain aliases according to their types.

A nil live-snapshot handle faults on the required read in step 3, before the
body counter can increment. Arguments have already run. The native fault follows
ADR-0188's nil dereference/Borrow boundary, not an invented Go panic policy.
Insertion and capture of that typed nil handle do not fault.

An explicitly nullable location witness instead receives nil in step 4 and
can increment its body counter, return -1 or choose its own fault. Do not emit
a null CLR instance call or dereference before that body. A non-null `H` cannot
receive source-level nil. Invalid foreign null storage remains an explicit
boundary, not a way around required initialization.

Three separate positions remain distinct:

- `TrialQuote? = nil`: absent category value, no selected receiver.
- A present entry containing `managed[Configuration]? = nil`: nil handle.
- A present non-null `managed[SomeClass?]` pointing at a slot containing nil:
  valid location with nullable referent. Reading that slot succeeds.

The last shape can be passed to an exact location witness after its own proof.
It cannot satisfy the initial struct snapshot slot. None of these cases changes
ADR-0205's presence or extraction semantics.

### 6. Calls, method values and callback conversion

| Surface | Proposed meaning / unchanged boundary |
| --- | --- |
| Ordinary `configuration.Next()` | Existing addressable mutation, including readonly defensive-copy rules. No new mode. |
| Direct mode-bound `values.Pack[TrialQuote](expression).Next(args)` | Perform insertion once, then section 5. A handle source stays a live selected location; a struct source becomes a saved value. |
| Stored capability `trial.Next(args)` | Evaluate the capability once, then section 5 with its recorded plan. Views preserve that plan rather than adding another copy layer. |
| Ordinary nominal interface / `adapt` call | Existing CLR boxing and nominal dispatch. No reinterpretation as snapshot slots. |
| `let f () -> int32 = liveTrial.Next` | Evaluate the capability once at capture, retain its handle/plan, then use a fresh read/copy at each `f()`. No invocation read at capture. |
| `let f () -> int32 = trial.Next` | Retain the saved value/plan at capture, then copy it anew at each `f()`. No shared mutable delegate receiver. |
| Callback parameter conversion of a mode-bearing group | Same capture rule as a saved method value. Conversion is capture, not invocation. No special policy based on whether the callback escapes. |
| Ordinary `configuration.Next` or extension method group | Existing conversion and boxing rules. No snapshot upgrade. |
| Direct `ReadOrMissing(missing)` or `missing.ReadOrMissing()` | Existing static function/extension call, with the explicitly nullable handle parameter. No capability membership is created. |
| Imported mode-bearing slot | Same recorded capture/call plan only after section 9 validation. An ordinary CLR signature alone cannot supply it. |

For a live callback captured when `original.Step == 10`, changing the pointee
to 30 before invoking it produces 31. Capturing an explicitly read value instead,
`values.Pack[TrialQuote](*selected).Next`, reads at capture's insertion point.
Its invocations return 11, 11 after that later edit. Reading nil in this explicit
expression faults at capture, not at callback invocation.

These are two explicit native compositions: **live-location snapshot calls**
and **captured-value snapshot calls**. The compiler never chooses between them
from context. A method expression with an unbound receiver is not added.
Callback export to an unaware CLR API remains ADR-0205's gated foreign boundary.
Native G# callback signatures need mode-aware metadata preservation too.

For clean translated-output intent, after all relevant admissions:

```gsharp
func RunTrial(strategy TrialQuote) int32 -> strategy.Next()
func ReadConfiguration(reader ConfigReader) int32 -> reader.Read()
```

Explicit insertion/witness binding belongs at conversion points, not inside
these algorithm bodies. These bodies are not an executable translated corpus
or proof of any Go method-value rule.

### 7. Storage lifetime, permissions and effects

Fresh means distinct logical storage for **every dynamic invocation**, including
recursive or concurrent invocations of one callable. Reusing an adapter field,
delegate target box or scratch cell is incorrect even if a sequential example
happens to work. Receiver-local writes cannot be copied back into the saved value
or selected pointee.

The first scope rejects receiver-derived escaping locations. A body returning
`managed(this.Field)`, retaining a borrow, capturing receiver-local storage or
passing it to an unknown retaining/suspending boundary cannot be admitted by
assuming that ordinary adaptation already proves it safe.

A feasible later extension is a root-aware body lowering:

1. Classify receiver-derived addresses and transitive effects before emission.
2. Allocate a fresh typed owned cell for each invocation that needs escape.
   Copy the selected value into that cell at section 5's preparation point.
3. Bind all receiver-field addresses, early aliases and nested captures to that
   same cell. Emit an owner-aware body variant where necessary. A persistent
   location must retain that invocation's owner/path, not a raw borrowed `this`.
4. Keep the cell alive as long as its escaped handles. Separate calls have
   separate owner identities, including equal-valued or zero-valued copies.

This requires a new verified body/storage contract. Merely boxing an imported
byref's current value cannot represent its original location. The new cell
would represent an explicitly new invocation copy, never the original pointee.
If an imported body cannot participate in root-aware lowering, reject that
escaping family. Do not promise that current escape analysis enforces this.

For non-escaping calls, a local value and a temporary address can suffice.
Borrow raw byrefs only inside a proven non-suspending segment. Materialize all
arguments before borrowing. No borrowed raw byref may escape, enter a state
machine or cross an unknown effect boundary. Unknown body/effect evidence blocks
admission. A body containing no `await` is not by itself a transitive proof.

Readonly selection preserves the original permission. A snapshot may call a
mutating body on its *new independent value* after a readonly read. That does not
grant write access to the selected pointee. A readonly handle field inside the
copy stays readonly. A location witness receives exactly the selected writable
or readonly type. Reject readonly-to-writable conversion, including through
inference or imported forwarding. Writable-to-readonly selection, when desired,
is explicit before insertion. ADR-0188 owner/path identity and permission views
remain authoritative. Readonly does not prove deep immutability or exclusivity.

Ordinary non-scoped handles may live across suspension under ADR-0188. That does
not authorize a new receiver borrow across suspension. G# already has goroutines
and channels. No scheduler or concurrency ABI is proposed here.

### 8. First proof scope and negative gates

The first implementation proposal, **only after acceptance**, may cover:

- One public synchronous nongeneric method per mode-bearing capability.
  Parameters and results are ordinary by-value, non-ref-like types with exact
  existing nullability. No signature adaptation or optional/variadic expansion.
- Saved non-null nongeneric struct values and non-scoped managed handles to
  those structs, including readonly and nullable handles for live snapshots.
  Reference-like fields retain their existing shallow semantics.
- Exact public ordinary instance bodies for snapshots, initially available
  source bodies with an audited finite call graph. Explicit accessible static
  witnesses for location calls, including exact nullable-handle parameter zero.
- Native direct calls, saved groups and G# callback conversion with identical
  call plans. Implementation/ref imports are required proofs before shipping
  those public surfaces, not an optional later correctness patch.

Reject generic receiver types/slots, open parameters, default interface bodies,
properties, indexers, events, operators, ref/in/out parameters or returns,
ref-like/unmanaged/borrowed payloads, scoped retained handles and unbound method
expressions. Reject suspension, iterators and unknown indirect call effects in
the first mode-bound body/argument proof. Reject receiver-derived escape until
section 7's distinct storage proof is accepted and implemented.

Class receivers, nullable struct referents and automatic CLR member witnesses
are not inherited from `adapt`. A location witness over a nullable class referent
is a useful later proof, not authorization for class snapshot slots. Existing
ordinary class calls remain under ADR-0205's separate class-only admission.

Unavailable or incomplete effect metadata on an imported body rejects new mode
binding, even if the ordinary member is public. Existing ordinary calls remain
legal. Each future relaxation needs a focused acceptance and witness decision,
not blanket inheritance of ADR-0189's larger member surface.

### 9. Feasible compiler plan and versioned imports

Use a typed call plan attached to the bound slot and insertion witness:

1. Validate exact selection, accessibility, source storage kind and effects.
2. Retain immutable saved-value storage or the evaluated handle. Reuse
   ADR-0205's entry/evidence without exposing an adapter as original evidence.
3. Synthesize an exact typed forwarder. Evaluate arguments before receiver
   preparation. For a snapshot, copy to fresh invocation storage and call its
   address; for a location, call the explicitly selected static witness.
4. Build method-value thunks that retain the source plan, not a mutable call
   receiver. Invoke the same preparation path as direct capability calls.
5. Verify IL, ref-safety, permission and lifetime through real driver paths.

Private typed boxes, cells and witnesses are possible backend tools. No public
`Invoke_*` helpers, caller-supplied tags, reflection member search or `object[]`
ABI is permitted. Forwarding a forwarded slot must preserve the original
preparation point exactly once. It must not read/copy at every forwarding layer
or create a second mutable saved receiver.

Both implementation and reference assemblies need the same versioned receiver
contract, alongside ADR-0205's evidence revision:

| Recorded fact | Required import validation |
| --- | --- |
| Contract revision and feature set | Known revision and every required feature; unknown revisions fail closed, not ordinary dispatch. |
| Capability/slot identity and exact signature | Canonical assembly-qualified identity, full parameter/return types and nullability; no short-name matching. |
| Copy mode and selected receiver type | Saved `S`, live `H`-to-`S`, or exact location `H`; preserve constructed type positions even though generics are initially blocked. |
| Permissions and nullability | Handle permission, nullable handle versus nullable referent, read requirement and nullable witness entry. |
| Capture and preparation timing | Retain source at capture; copy/read after arguments per invocation; nullable witness has no implicit pointee read. |
| Target and forwarding contract | Exact method/static witness, accessibility, origin plan and one preparation owner. Re-export cannot erase or reinterpret the mode. |
| Storage/effect evidence | Supported non-escape/non-suspension revision and relevant body/contract identity. Later owner-aware variants require their own revision. |

The precise attribute/manifest encoding, authentication and invalidation rules
are prototype obligations before metadata acceptance, not a fixed ABI here.
Public source and ref-only consumers must reach the same decision. Missing,
stale, malformed or conflicting evidence rejects insertion/import before native
dispatch. Do not infer a mode from names, readonly flags, extension attributes
or ordinary CLR signatures. Public callback signatures must preserve the
contract; erased/unaware foreign consumers stay blocked.

Use deterministic declaration/signature order for generated witnesses and
storage plans, not hash enumeration. Existing CLR nullability attributes are
necessary but insufficient. Imported positions must enter through
`NullabilityImportRule`, `ClrNullability.Get*TypeSymbol` and receiver-aware
`MemberLookup.GetClr*TypeSymbol` as appropriate. Consumers use existing type
queries/readers. Do not create another nullable-position parser or infer nullable
entry from the erased CLR receiver type. ADR-0193 is still Proposed with staged
implementation; this ADR does not claim all its query migration has landed.

### 10. Go correspondence remains a separate admission

ADR-0191's frontend owns Go method sets, canonical defined/alias identities,
`T` versus `*T`, embedding paths and package-private authority. An explicit native
witness does not prove Go membership. A static extension is not automatically
a structural or nominal member.

Native live-location snapshot capture intentionally does not implement a Go
value-method capture that reads the pointee at selection. The frontend may
request an explicit captured-value insertion when it proves the corresponding
read/copy/fault timing. Pointer method values may use selected handles only after
proving their distinct rules. Unsupported implicit adjustments, promoted paths,
method expressions and nil timing cases remain diagnostics. No hidden
context-sensitive capture behavior is added to make a corpus pass.

G# nil dereference exceptions and witness-defined nil handling are not Go
panic/recover policy. A mapping needs separate versioned nil, panic and timing
witnesses. Native equality, type identity, nullable payload presence and foreign
interop stay with Proposed ADR-0205. This ADR grants no new equality/export
operation or source schema. Schema/profile v1 and `migrationReady: false` stay
unchanged. An unavailable mapping remains an attributed diagnostic boundary.

### 11. Independent witnesses and cost probes

This table is a **future obligation plan**, not executed tests or experiments.
Use real compiler/driver paths and independent expected outputs per ADR-0154.

| Axis | Positive / negative observations | Discriminating mutant or paired witness |
| --- | --- | --- |
| Insertion versus call copy | Original 10 changes to 20 after insertion. Saved calls yield 11, 11; ordinary calls on a writable `var` and adapter calls from 10 yield 11, 12. | Retain original location or reuse one mutable adapter field. |
| Shallow sharing | Array/class/slice/location field writes are visible between trials; temporary scalar/field replacement is not. | Deep-clone fields or copy temporary scalars back. |
| Live selection | External pointee edit to 20 gives 21, 21. Rebinding the handle to a 90-valued location cannot retarget. | Read at insertion, reread the handle variable, or commit trial mutation. |
| Nil and presence | Nil snapshot read faults with body count 0; nullable witness sees nil with body count 1. Absence and present nullable payload remain separate. | Eagerly dereference witness input, invoke null CLR instance, or collapse presence. |
| Evaluation / faults | Trace receiver, argument 1, argument 2, preparation, body exactly once. Argument edit is observed; argument fault prevents read. Nil read follows arguments. | Duplicate receiver, read before arguments, reorder arguments, or enter body before required read. |
| Capture / callbacks | Capture live at 10, edit to 30, invoke: 31. Explicit captured value: 11, 11. Nil live capture succeeds; explicit nil read at capture faults. | Snapshot at live capture, read eagerly, reuse a delegate receiver, or change mode for callback parameters. |
| Escaping copies, later gate | Two admitted per-call handles retain independent receiver roots after return/GC; writing one does not change the other or original. Initially the same source must diagnose. | Reuse one cell, discard owner, or box original byref as a counterfeit original location. |
| Permissions / effects | Readonly live read permits local scalar mutation only. Readonly-to-writable witness binding, scoped capture and borrowed suspension reject with source spans. | Drop permission or effect evidence; hoist a raw byref. |
| Implementation/ref import | Three assemblies (contract, producer, caller), using implementation and ref imports, agree on timing, nil, signatures and one forwarding preparation. Unknown revision rejects. | Strip ref metadata, accept unknown effects, change exact receiver nullability or double-prepare a forwarded slot. |
| Unchanged behavior | Addressable calls mutate; nominal boxing/dispatch and readonly copies retain their existing observations. `adapt` remains fresh and rejects null. An extension alone fails snapshot membership; explicit location witness succeeds. | Apply new mode to an old signature or add ambient extension search. |
| Negative families | Unproved generic/property/ref/suspending/escaping/imported shapes diagnose at the boundary; compile a supported remedy separately. | Fall back to ordinary mutable forwarding when evidence is missing. |
| Go mapping | Independent Go/G# pairs distinguish captured value versus live pointer, nil/body counts and method-set mismatches. Neighboring unadmitted cases remain blocked. | Use one capture policy for all method values or accept native slots as Go method-set authority. |

Assert nonempty diagnostics with stable reason and source location, not message
text alone. Preserve applied mutant diffs, artifact movement and red/green
results. Independent expected traces must not be computed by the lowering under
test. Include recursion/concurrent-call isolation when admitting those effects.
Escaping-root positives are later-gate tests, not a claim they compile initially.

Parser/metadata/call-plan prototypes, emitted IL/ILVerify, repeated emission,
separate-assembly probes and JIT/NativeAOT runs remain obligations. No prototype,
product mutant or performance experiment was run for this docs-only proposal.

Measure small/large structs, shared fields, live reads, capture, repeated calls,
forwarding and escaping roots against handwritten same-runtime controls.
Report copy bandwidth, allocations, retained owners, throughput and code size
separately. Typed thunks may increase code size; large shallow snapshots may
retain large shared graphs. Non-escaping copies might use locals. Escaping copies
may allocate a cell per invocation. No blanket allocation-free claim or invented
benchmark follows from this design.

### 12. Separate acceptance and delivery gates

1. **Design review:** maintainer accepts or revises this receiver contract and
   syntax separately from ADR-0205. Keep its acceptance issue #5097 open while
   that category remains unaccepted. A Proposed-document merge is not acceptance.
2. **Bounded prototypes:** prove nonbreaking parsing, exact call plans, typed
   witness binding, effects and implementation/ref metadata. Narrow on failure.
   No repository source adoption or Go admission follows from prototype success.
3. **Focused implementation after acceptance:** implement only proved families,
   diagnostics/tooling and discriminating witnesses. Keep escaping roots, larger
   signatures and foreign interop blocked until separately proved.
4. **Release:** publish compiler/runtime contract revisions and supported scope.
   In-tree APIs, including bytestring slices, need not be released or pinned.
5. **Separate verified N-1 pin movement:** a distinct PR moves the published pin
   and verifies a clean-clone build. Only then may repository source use features
   supplied by that pin. Never work around a bootstrap defect with an unreleased pin.
6. **Capability probes:** bank exact versions, ref imports, JIT/AOT, costs and
   handwritten/translated source readability. A plan is not completed evidence.
7. **Go admission:** independently admit finite families under ADR-0191 after
   source correspondence and nil/panic/capture policies pass. Missing mappings
   stay diagnosed. No deadline or application migration-readiness claim is made.

Fixed arrays, maps, control effects and concurrency remain separate tracks.
No compiler/runtime/translator changes, source-schema changes or SDK pin movement
belong in this ADR's PR.

## Consequences

- Trial APIs can request reusable per-call copies without changing ordinary
  struct mutation or handwritten bodies. Shared reference fields remain visible.
- Location callbacks keep one selected location and permission. Rebinding a
  handle variable cannot silently redirect later calls.
- Two explicit compositions separate capture-time snapshots from live reads.
  This limits convenience but avoids context-dependent method-value semantics.
- Slot modes depend on Proposed ADR-0205 for the public capability category.
  Existing rich objects and explicit extensions remain useful independently.
- Finite effects and metadata restrict initial admission. A compiler cannot
  infer safe lifetime or forwarding from CLR signature shape alone.
- Escaping receiver copies require distinct storage and possibly per-call heap
  allocation. They are not included by promising future optimization.

## Alternatives considered

| Choice | Assessment |
| --- | --- |
| Method-declared snapshot/location modes | Could make direct methods and method values share a declared contract without a capability. Costs include a new body/`this` model, overload/override and CLR export rules, and separate import ABI. Defer: the trial requirement can wrap an existing body without changing its ordinary callers. Nullable location bodies already have explicit static handle parameters. |
| **Capability-slot modes plus explicit typed location witnesses** | **Recommended.** The API requesting independent trials owns the policy. Existing methods retain their meaning. Static witnesses make nullable/permission authority explicit. Costs: category dependency, typed thunks, finite evidence and metadata. |
| Existing rich objects / explicit static extensions only | Working baseline, and preferred when a single adapter suffices. A by-value extension already copies its parameter. But repeated forwarding boilerplate and cross-assembly policy are not reusable slot contracts. Keep as composition tools, not automatic method-set members. |
| Per-insertion copy only or one boxed delegate receiver | Insufficient: mutable saved state yields 11, 12, not independent trials. CLR boxing and nominal dispatch remain correct for ordinary calls, not this opt-in requirement. |
| Captured snapshot for every live method value | Useful when explicitly written, but would silently change live trial callbacks into stale configurations. Use explicit value insertion for that choice. Unmatched Go cases stay blocked. |
| New universal receiver invocation library / Go wrapper | Reject public tags, `Invoke_*`, `object[]` dispatch and renamed Go bookkeeping. Private typed storage is an implementation option, not the source contract. |

The remaining acceptance decisions are spelling/parser compatibility, precise
metadata encoding and trusted effect evidence, and whether the single-slot proof
justifies expansion. Per-call root promotion and foreign export need separate
proofs. None is settled by this document's merge.
