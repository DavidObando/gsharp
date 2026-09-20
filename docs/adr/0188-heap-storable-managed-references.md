# ADR-0188: Heap-storable managed references alongside borrowed ref contracts

- **Status**: Accepted
- **Date**: 2026-09-19
- **Implemented**: 2026-09-20 UTC (2026-09-19 PDT)
- **Phase**: Bounded managed-reference language/runtime implementation
- **Issue**: [#4330](https://github.com/DavidObando/gsharp/issues/4330)
- **Related**: [ADR-0190](0190-native-slices-and-clr-array-interoperability.md),
  [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md),
  [ADR-0039](0039-byref-pointers-and-clr-interop.md),
  [ADR-0058](0058-ref-safe-to-escape.md),
  [ADR-0060](0060-ref-out-in-parameters.md),
  [ADR-0181](0181-readonly-managed-reference-contracts.md),
  [ADR-0100](0100-default-expression.md),
  [upstream ADR-0184](https://github.com/DavidObando/gsharp/blob/b96dff29c4d18f5a29f9b7e372ce31953cb52a74/docs/adr/0184-unscoped-ref-definition-side.md)
- **Effect**: Adds a separate persistent category to ADR-0039's
  model without reinterpreting existing byrefs. Extends lifetime/capture classification
  in ADR-0058 while retaining ADR-0060/0181 borrowed ABI and ADR-0184's
  definition-side work. Adds an initialization restriction for the new
  non-null handle type alongside ADR-0100. The existing borrowed-reference
  contracts remain unchanged.

## Acceptance and implementation amendment — September 20, 2026 (UTC)

### Readonly spelling amendment

The maintainer approved **`readonly managed[T]`** and
**`readonly managed(location)`** on **September 19, 2026 PDT / September 20,
2026 UTC**, superseding the initial joined `readonlyManaged` intrinsic spelling
before release. The joined spelling is no longer a compiler alias; ordinary
user-defined types, functions and values named `readonlyManaged` still resolve
normally. Neither `readonly` nor `managed` becomes a globally reserved word.

The modifier is represented by a separate syntax token, as with `readonly
slice[T]`. It binds to the managed category before a trailing nullable marker:
`readonly managed[T]?` and `(readonly managed[T])?` are nullable handles;
`readonly managed[T?]` has a nullable referent. Nested generic/tuple/array
positions retain these distinctions. After `ref`, the first `readonly` remains
the borrowed-return modifier: `ref readonly managed[T]` borrows a writable
handle slot readonly; `ref readonly readonly managed[T]` borrows a readonly
handle slot readonly.

The expression modifier applies only to the address intrinsic and requires an
admitted addressable location; it is not a readonly operator on arbitrary
values. Visible ordinary names and escapes retain precedence. When shadowed,
use the explicit `Gsharp.Values.ReadOnlyManagedRef[T]` CLR type/API rather than
retargeting an ordinary callable. The CLR classes, `.AsReadOnly()`, location
identity, permissions and lifetime contracts are unchanged. ADR-0189 and
ADR-0191 remain Proposed.

### Original design acceptance and delivered scope

The maintainer approved this design on **2026-09-19**. Proposal PR #4332
intentionally left its status Proposed; this implementation records acceptance
alongside the feature, following native slices in #4338 / ADR-0190.
ADR-0189 remains Proposed. Neither structural adaptation nor go2gs is
implemented by this amendment.

The implemented spelling is `managed[T]` / `readonly managed[T]`, including
nullable handles, `managed(location)` / `readonly managed(location)`, and `*p`.
Ordinary visible types, aliases, values, functions, static imports and escaped
identifiers retain precedence. Explicit `Gsharp.Values` names remain available.
The nominal classes ship in the existing `Gsharp.Runtime.Values` assembly.

Implementation:

- Whole-body discovery precedes address emission. Locals, containing value
  roots, and by-value parameters reuse the existing closure-box plan, including
  early borrows, nested literals, conditional requests and per-iteration cells.
  By-value parameters retain G#'s existing readonly binding permission:
  `readonly managed(parameter)` retains their independent entry copy; an
  explicit mutable local copy is required for a writable handle.
- Constructor and type-initializer expressions use emit-local initialization
  plans under their actual owning type/function. Base arguments, primary
  parameter stores, field-initializer locals and constructor bodies share one
  cell plan. Only parameter-cell setup precedes the existing base-call boundary;
  user field initializers retain their ordinary after-base ordering. Cached
  declaration initializer dictionaries are not replaced by managed-reference
  lowering, so repeated implementation/reference emission recreates its helpers.
  Lambda and `go` discovery covers every plan prologue, argument and body.
  Declaration initializer discovery is suppressed only when every constructor
  path that emits those initializers has a plan.
- Known borrowed aliases save a descriptor at their original selection site.
  A nested persistent request captures that descriptor, not a raw byref.
  Stable `let` pointer aliases are also tracked. Unknown/merged mutable
  pointer provenance remains diagnosed, never repaired by copying a referent.
- Ordinary accessible source/imported fields, nested value fields, exact CLR
  array elements and native writable/readonly slice elements retain their
  selected owners. Reference-valued traversal snapshots a new object root;
  replacing a value root continues to update the same slot.
  Wide CLR-array indices keep their bound native width through the compiler-facing
  `FromArrayNative(T[], nint)` factory, which checks bounds before narrowing to
  the stored absolute index. The existing `FromArray(T[], int)` ABI remains.
- Generated ordinary typed classes implement `Borrow` using field addresses
  and parent borrows. Array factories use typed array element addresses.
  The canonical key is owner reference identity, absolute array index and a
  flattened path of runtime field handles paired with constructed declaring
  type handles. Equality is independent of helper site/assembly and referent
  contents. `SameLocation` compares permission views; CLR wrapper identity
  remains a separate observation.
- Writable and readonly borrowed contracts use the existing metadata path.
  Implementation and `/refout` are tested with a C# producer/consumer.
  Async, iterator and channel state retain ordinary handles/cells only;
  temporary borrows still obey execution-segment liveness.
- Primary-constructor parameters are instance storage and therefore cannot be
  scoped managed handles. Explicit constructor calls and convenience chaining
  honor the selected same-compilation constructor's scoped parameter contract;
  primary-constructor arguments remain stores. Imported constructors and
  operators conservatively reject scoped handle arguments because this
  by-value lifetime contract is not preserved in their CLR metadata.
  Same-compilation operators/conversions honor scoped parameters, while the
  compiler-known handle equality and permission APIs retain their category
  semantics.
- Non-null handle locals participate in definite assignment. Explicit
  non-null defaults, missing aggregate fields, incomplete source constructors
  and compiler-created arrays with unsupplied non-null handle elements are
  diagnosed. Every source primary, designated and compiler-synthesized/default
  constructor path is checked at the declaration, even when the current
  compilation contains no construction expression. Nullable defaults are nil.
  Generic/foreign CLR zero-initialization remains an explicit boundary:
  annotations cannot prevent foreign nulls, `default(T)`, or a foreign/generic
  factory from supplying null. Such a null throws on dereference/Borrow; no fake
  target is allocated.
- GS0604 diagnoses unsupported provenance, permissions, initialization and
  suspended borrowed operations. Imported unknown ref returns, caller/scoped
  storage, borrowed struct `this`, ref-like/native storage, property-value
  copies, statics, multidimensional arrays and explicit-layout fields are not
  turned into persistent aliases. A borrowed argument preceding a suspending
  argument is diagnosed rather than hoisted or re-evaluated. Scoped handles
  cannot become instance/static field or top-level global initializer results,
  including stores in `shared { init { ... } }`. Array elements, CLR ref
  indexers and imported ref-return properties reached through a managed handle
  remain borrowed locations and cannot be selected before a later suspension;
  scalar and by-value property copies remain ordinary values.
- State-machine entry is a storage boundary. Scoped managed-reference
  parameters and scope-preserving locals are rejected in async, declared or
  inferred suspending, iterator, and async-iterator functions because the
  current lowering conservatively hoists every parameter and declared local
  into generated fields. This applies even to uses before the first
  suspension; ordinary non-scoped handles and scalar/value copies remain
  valid. The rule is enforced in the shared managed-reference semantic pass,
  before lowering. A Roslyn analyzer is intentionally not used here: the
  decision depends on G# bound provenance, suspension inference, and iterator
  detection that C# syntax analysis cannot recover without duplicating the
  compiler. Focused compiler, reimport, reference-assembly, repeated-emit, and
  ILVerify tests are the durable guard.

The runtime, real-driver/ILVerify, cross-assembly, GC, allocation, formatting,
completion and cs2gs witnesses are in `ManagedReferenceLanguageTests`,
`ManagedReferenceRuntimeTests`, `ManagedReferenceFormattingTests`,
`NativeSliceCompletionTests`, and `ManagedReferenceTranslationTests`.
The runtime benchmark declares its budget before execution: **zero allocated
bytes for one million warmed dereferences**, with a five-second sanity bound,
and reports direct borrowed and explicit `StrongBox` baselines. This is not a
zero-cost or portable throughput claim. Generated `Borrow` bodies are also
checked for allocation/boxing/delegate construction and generated heap fields
for forbidden byref/ref-like types. No verifier suppression is added.

ADR-0154 discrimination: replacing promoted roots with independent value
snapshots compiled and verified but made **eight of ten** execution programs
fail their output assertions. A runtime mutant that copied array owners and
omitted covariance rejection made **all four** runtime tests fail. Both
mutants were reverted. A real packed-SDK consumer and an in-tree bootstrap
consumer both execute the early-borrow/returned-cell witness and print `42`.
The actual REPL script also prints `42`. On the validation host, the warmed
million-operation observation was 2.1063 ms for the handle, 0.3248 ms for the
direct borrow, and 2.0172 ms for `StrongBox`, with zero measured allocations
in the handle loop. These measurements are informational and machine-specific.

The proposal-stage text below retains the original rationale and matrices;
its “proposed” and staged-implementation wording is historical.

## Context

A CLR managed byref is excellent for a short-lived alias into existing
storage. It is not a universal representation of a reference that can be put
in an ordinary class field, captured, or retained through suspension.

Cliamp at `4dee32c` needs value copies and persistent aliases together:

- [Model.Update](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ui/model/update.go)
  has a value receiver. Changing every translated model into a class would
  change its copy behavior.
- [normalizeMainFocus](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ui/model/model.go)
  takes addresses of fields in an existing model.
- [biquad](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/eq.go)
  retains a reference to an atomic gain location owned elsewhere.
- [Player](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/player.go)
  combines atomic fields, arrays, pointers, and concurrent activity.

The baseline is the implementation at `88f4c4ad8`, not every historical
restriction in older ADR prose.
[RefStructAsyncLivenessAnalyzer](../../src/Core/CodeAnalysis/Binding/RefStructAsyncLivenessAnalyzer.cs)
and
[Issue4222RefAliasSuspensionEmitTests](../../test/Core.Tests/CodeAnalysis/Emit/Issue4222RefAliasSuspensionEmitTests.cs)
already allow native ref aliases confined to an execution segment.
[Issue4224RefReturningCallStorageTests](../../test/Core.Tests/CodeAnalysis/Binding/Issue4224RefReturningCallStorageTests.cs)
exercises retained and forwarded call/getter references; ADR-0181 describes
readonly contracts. Issues #4219 and #4220 are closed. This ADR does not
describe those delivered capabilities as universally absent or as new
persistent-reference prerequisites.

The pinned upstream ADR-0184 corrects ADR-0058's historical claim of complete
definition-side `@UnscopedRef` support. It is labeled Proposed at that upstream
revision. It concerns the ref-safe-context of struct `this`, not conversion of
arbitrary byrefs into heap-storable objects. The two designs must compose.

The primary runtime boundary is precise:
[the CLI addendum](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Ecma-335-Augments.md#ref-fields-support)
permits ref fields in byref-like types, not ordinary heap objects.
[Modern C# ref-struct support](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/ref-struct)
includes restricted interfaces and generic arguments; it does not permit
boxing or ordinary heap fields containing those values. The proposal therefore
uses legal owner/location state, not suppressed diagnostics.

## Decision

**Keep borrowed CLR references unchanged and introduce an explicit
heap-storable, GC-retained location handle. A handle retains storage ownership
and enough typed information to derive a short-lived CLR byref on demand.
Compiler-owned locals selected for persistent addressing are promoted as whole
storage roots before any alias to them is lowered.**

This is GC lifetime extension, not exclusive borrowing, Rust ownership, an
unsafe pointer, or automatic conversion of structs into classes.

### 1. Categories, syntax, and ABI

All new syntax below is **proposed**.

| Category | Proposed/existing source | CLR representation | Heap-storable? |
| --- | --- | --- | --- |
| Existing writable borrow | `ref T`, `*T`, `let ref x`, `&x` | `T&` with existing parameter/return contracts | No ordinary heap storage |
| Existing readonly borrow | `ref readonly T`, readonly alias, `in` contract | `T&` plus exact readonly metadata | No ordinary heap storage |
| New writable persistent handle | `managed[T]` | `Gsharp.Values.ManagedRef<T>` reference type | Yes |
| New readonly persistent handle | `readonly managed[T]` | `Gsharp.Values.ReadOnlyManagedRef<T>` reference type | Yes |
| Nullable persistent handle | `managed[T]?` / `readonly managed[T]?` | Nullable reference annotation on that handle type | Yes |

Outside unsafe contexts, `*T` continues to mean the existing managed byref.
`&x` continues to produce a borrowed address. Neither changes meaning because
the compiler discovers a later escape. Public signatures cannot depend on an
optimization or on whether a caller happens to retain an argument.

```gsharp
// Proposed syntax and behavior.
func Counter() managed[int32] {
    var count = 0
    let ref early = count
    let saved = managed(count)
    early = 3
    count += 4
    return saved
}

let p = Counter()
*p += 1                         // reads 7, stores 8 in the original cell
let ro = p.AsReadOnly()
let ref readonly observed = ro.Borrow()
// observed is a live readonly borrow, not a value snapshot.
```

`managed(location)` is a compiler intrinsic on an addressable expression;
it is not a generic method accepting a `ref T` whose provenance can be lost.
`readonly managed(location)` admits the same supported locations with readonly
permission. Dereferencing a handle with `*p` is an lvalue, subject to its
permission. `.Borrow()` returns `ref T` or `ref readonly T` for existing APIs.
`managed(*p)` denotes the same location and may return the existing handle.
There is no implicit borrow-to-handle or handle-to-borrow conversion.

The runtime API names and assembly are proposed as
`Gsharp.Values.ManagedRef<T>` / `ReadOnlyManagedRef<T>` in
`Gsharp.Runtime.Values`, shared with ADR-0190 if both land. The compiler
recognizes the actual type identity. A user class with the same short name
does not gain promotion privileges.

### 2. Nullability, default, permissions, and value copies

A non-null handle has no useful auto-created target: silently allocating a
fresh `T` would not identify the intended variable. A declaration of the new
non-null handle type therefore requires an initializer, or local definite
assignment before use where the existing analysis proves it. Non-null fields
must be initialized by all admitted construction paths. `default` is allowed
for a nullable handle and yields nil; `default` targeting the new non-null
intrinsic type is diagnosed rather than allocating a fake location.
This is an explicit, narrow extension of ADR-0100's rules, not a change to
existing class defaults.

C# or other CLR code can still supply a null handle despite annotations, just
as for other non-null reference contracts. Dereference/Borrow of such a value
throws `NullReferenceException`; it never treats null as a zero-valued target.
Generic and foreign initialization do not prove non-nullness automatically.
An implementation must reject a compiler-owned aggregate initialization that
would silently synthesize a null non-null-handle field.

Handle assignment copies the handle value; it does not copy the referent.
`var copy = *p` copies `T` normally. Promoting `copy` later identifies that
copy, not the original storage. Promotion of a by-value parameter similarly
preserves the parameter's independent value copy. This distinction is critical
to value-receiver translation.

`let p` prevents rebinding the handle variable, not writes through a writable
handle. `.AsReadOnly()` weakens permissions without copying the value.
Readonly permission propagates through value-type fields and forbids writable
borrows, `out`, assignment, and increments. A non-readonly method on a readonly
struct referent follows ADR-0181's defensive-copy rule for an ordinary call;
ADR-0189 deliberately restricts automatic readonly-location forwarding
further to avoid silently losing mutations.

Readonly permission is neither deep immutability nor proof of exclusivity.
The object stored in a readonly reference-valued slot can mutate, and writable
sibling aliases can exist. No optimization may assume otherwise.

### 3. Admitted location origins

The initial safe set is intentionally finite.

| Origin of `managed(e)` | Initial decision | Storage retained / reason |
| --- | --- | --- |
| Writable compiler-owned local or by-value parameter | Admit after whole-root promotion | One stable heap cell per dynamic variable instance |
| Existing persistent dereference | Admit | Preserve its location; do not re-box `*p` |
| Ordinary object instance field | Admit if accessible and writable | Evaluated object reference and resolved field |
| Nested value field of admitted root | Admit | Same root plus immutable typed field path |
| Exact one-dimensional CLR array element | Admit | Evaluated array and checked absolute index |
| ADR-0190 native slice element | Admit when native slices ship | Snapshot backing array and offset+index, after Length check |
| Readonly field / readonly borrow of an otherwise admitted location | Readonly handle only, subject to known provenance | No writable capability upgrade |
| Incoming `ref`, `in`, `out`, or `scoped` parameter slot | Reject persistent conversion | Callee cannot own or relocate caller storage |
| Arbitrary imported/source ref-returning call/property | Reject unless it already returns a persistent handle | `T&` does not encode recoverable owner/location |
| Existing borrowed alias of a compiler-proven admitted root | Admit after origin analysis | Reuse original root; never promote the alias slot |
| Struct method's borrowed `this` | Reject as a promotion root | It is caller-owned, even with `@UnscopedRef` |
| `Span[T]`/ref-struct storage, stackalloc, unmanaged memory | Reject | Not an admitted heap owner |
| Ordinary property value, temporary, string or map element | Reject | No stable addressable slot of the selected kind |
| Static/thread-static fields, multidimensional arrays, explicit-layout overlapping fields | Defer and diagnose | Need additional initialization/thread/identity rules |

`managed(array[i])` also verifies an exact runtime `T[]` when writable
`ref T` access could otherwise meet CLR array covariance. No handle is
manufactured for `string[]` viewed as `object[]`. Nullable element annotations
do not change the runtime-array test, but remain part of the static writable
contract.

Imported accessible ordinary instance fields are eligible because their owner
and field identity are known; an imported ref-return method is not, even if
its current implementation happens to return one such field. Whole-program
guessing and reflection over method bodies are not interoperability contracts.
Existing `@UnscopedRef` metadata expands borrowed escape scope where valid; it
does not supply a persistent owner descriptor.

A heap object read from a borrowed slot may independently root a handle to
one of **that object's** fields when ordinary value-escape rules permit that
object reference to escape. This does not grant a handle to the original
borrowed slot. Likewise `scoped` restrictions on an existing persistent value
remain enforced; the new category is not a route around an explicit scope.

### 4. Selection and identity are about locations, not expressions

Evaluate each owner and index once in source order when the address is taken.
Perform null, bounds, covariance, and capability checks then. Save object
references, indices, and resolved member identities, not expression trees.

```gsharp
// Proposed behavior.
var values = array[int32]{10, 20}
let oldElement = managed(values[NextIndex()]) // NextIndex runs once
values = array[int32]{30, 40}
*oldElement = 99                   // updates the selected old array

var owner = Box{Value: 1}
let oldField = managed(owner.Value)
owner = Box{Value: 2}
*oldField = 3                      // updates the old Box

var pair = Pair{Left: 1, Right: 2}
let left = managed(pair.Left)
pair = Pair{Left: 7, Right: 8}
// *left == 7: replacing a value in the same promoted slot is not a new slot.
```

A traversal through a reference-valued field establishes a new object root at
that point. `managed(node.Child.Value)` saves the current `Child`; replacing
`node.Child` does not retarget it. Traversal through value fields stays in the
same root storage. These rules also apply to nested slices, array-valued
fields, and values containing handles.

Location equality uses owner **reference identity** plus a canonical typed
path of field identities and array indices. The root of a promoted local is
its cell. Array slices use the real array and absolute element index, not a
slice descriptor or source variable. Field identity includes the declaring
constructed type and runtime field identity, not a textual name or a module-
local token alone. Path flattening makes independently compiled address sites
for the same field compare equal; no global owner-interning table is required.

Handles to the same location compare equal and hash equally even when
separately allocated. Hashes never depend on the mutable referent's contents.
Writable-to-readonly conversion preserves location identity; provide a
`SameLocation` operation for comparing permissions without granting a write.
Typed equality is invariant in `T`. Nil equals nil; nil differs from any
valid location. `ReferenceEquals` on CLR handle objects still observes wrapper
identity, which is **not** the language's location equality. Debugger and API
documentation must make that distinction explicit.

The first implementation excludes overlapping explicit-layout fields because
field-path equality must not silently pretend to be arbitrary physical-address
equality. Go pointers to zero-size locations and unsafe offset arithmetic are
not given a compatibility guarantee by this rule.

### 5. Legal runtime representation and access

Use ordinary heap objects with typed, generated access code:

- A promoted variable uses one `StrongBox<T>` or an equivalent compiler-owned
  closure cell, reusing existing BCL/compiler machinery.
- A runtime handle base exposes a typed `Borrow()` contract. Compiler/runtime-
  generated sealed implementations retain a cell, object, array/index, or
  parent location plus a field path.
- Each implementation derives a byref using normal `ldflda`/`ldelema` and
  typed calls **inside** `Borrow`. The method may return a legal managed byref;
  it never stores one as a heap field.
- Readonly handles expose only `ref readonly T`. A writable-to-readonly view
  may retain a writable handle privately, but offers no conversion back.
- Equality uses the canonical location key, not the generated implementation
  type. Access and identity implementations must agree on the same location.

The selected minimal implementation is a typed accessor method on a handle,
not a delegate invoked for every load/store, `Reflection.Emit`, a reflection
field setter, an untyped byte offset, or a pinned interior address. Array and
cell forms are reusable generic runtime classes. Field paths are compiler-
generated typed classes where necessary. Nested source helpers can access
private fields only when the original source address expression was legal;
imported private fields remain inaccessible.

The abstract support surface needed by generated classes in another assembly
is public, compiler-facing, and versioned with the runtime. It is not a
user-facing extension registry for arbitrary memory owners. Its contract
requires stable, side-effect-free location access and a consistent identity
key. Hand-authored CLR subclasses must obey that contract; the G# compiler
does not infer fresh provenance from their borrowed return values.
Source factories remain limited to the matrix above. Runtime factory/helper
accessibility and emitted nested helpers must be checked with normal CLR
visibility, not privileged reflection.

Each persistent address can initially allocate a handle; promotion can also
allocate its root cell. Permission views/path compositions can allocate
additional small descriptors. Repeated **dereference** must not allocate,
box `T`, invoke a setter, or construct a delegate. Canonicalizing handle
objects is an optional optimization because location equality does not
require `ReferenceEquals`. No process-global cache may keep otherwise dead
owners alive merely to avoid allocations.

### 6. Whole-root promotion algorithm

Late independent boxing is incorrect:

```gsharp
// Proposed witness; expected all three accesses identify one cell.
var x = 1
let ref before = x
let p = managed(x)
before = 2
*p = 3
// x == 3 and before == 3
```

The binder/lowerer must plan storage before emitting addresses:

1. Bind lexical variables, lvalues, readonly capabilities, and borrowed-origin
   relationships. Preserve symbol identity through aliases and nested captures.
2. Discover persistent-address requests and escaping lexical bindings across
   the complete owning body and nested literals. Compute roots to a fixed point.
   A conditional address request can conservatively promote its root for the
   whole dynamic declaration instance.
3. Reject external, scoped, unknown-provenance, byref-like, or unsupported roots.
   An alias with multiple possible origins is admitted only when every origin
   is supported and lowering retains the runtime-selected descriptor. A first
   implementation may reject such merges instead of inventing provenance.
4. Assign one cell to every promoted root, including a whole containing struct
   if a field is addressed. For a by-value parameter initialize that cell from
   its entry value. For a local allocate at its declaration/required lexical
   environment creation and evaluate its initializer exactly once.
5. Rewrite **all** reads, writes, compound assignments, closure captures, and
   borrowed address sites for the root, including sites textually before the
   persistent request. An earlier `&x` or native alias is an address into the
   cell from the beginning. Integrate with existing closure hoisting so two
   environment objects cannot hold independent copies of one binding.
6. Form handles using the planned cells/owners; run ordinary borrowed escape
   and segment-liveness checks on derived borrows.

Promotion may move allocation earlier than the branch taking an address; this
potential allocation/OOM cost is part of the explicit `managed` feature.
It must not reorder user initializer effects, change definite assignment,
merge separate loop-iteration bindings, or turn a value copy into a shared
binding. If existing closure lowering cannot establish that invariant, the
promotion case remains diagnosed until corrected.

This analysis is an ownership-of-storage analysis, not a uniqueness analysis:
multiple aliases are expected. It neither copies a caller's byref into a cell
nor treats a scoped parameter's value copy as its original location.

### 7. Suspension, borrowed adapters, and lifetimes

```gsharp
// Proposed: only the persistent handle crosses suspension.
async func Change(p managed[int32]) int32 {
    {
        let ref now = p.Borrow()
        now += 1
    }
    await Pause()
    *p += 1
    return *p
}
```

A closure or state machine stores the handle/cell/owner descriptor. It obtains
short-lived byrefs after resumption as needed. It never stores `T&`, `Span<T>`,
or a ref-struct accessor object in an ordinary heap field. The current
segment-local rules remain in force; declaring `let ref x = p.Borrow()` before
an `await` and using `x` afterwards is still rejected. The programmer retains
`p` and creates a new borrow in the next segment.

At a synchronous borrowed API boundary, `p.Borrow()` or an address of `*p`
supplies a `ref`/`in`/`out` argument using existing call binding. A writable
handle permits `ref` and `out`; either permission permits an appropriate `in`
borrow. `out` changes the value of an existing initialized location, not the
handle itself. Passing a handle by reference would instead refer to the
handle variable, a different type and operation.

For a call with later arguments that suspend, do not acquire a byref and then
hoist it. A supported lowering saves the stable descriptor and earlier
argument values, preserves already-required checks and source order, and
acquires the address immediately before the synchronous call. Until that
lowering is validated, diagnose the combination. No borrowed argument may
remain live across an actual suspending callee contract.

Borrowed returns into an admitted heap owner may retain their existing
caller-escape permission; this does not enable capturing the raw byref.
Foreign borrowed returns do not become handles on the way back. To expose
persistence across an assembly boundary, an API returns the handle itself.

### 8. Generic, metadata, GC, and concurrency contracts

`managed[T]` and `readonly managed[T]` are invariant. No `managed[Derived]` to
`managed[Base]` conversion can widen writable storage. The readonly category
also remains invariant initially to avoid different identity/borrow contracts.
Generic substitutions preserve permission and pointee nullability. Ref-like,
raw-byref, pointer, and `void` targets are rejected in the initial safe surface.
Allowing a ref-like generic parameter does not make its instantiation storable.

A handle parameter/return/field emits the nominal runtime type, with ordinary
reference nullability and pointee annotations on its type argument. It is
not `T&` decorated with a marker. The `Borrow` methods emit normal writable or
ADR-0181 readonly-ref signatures, including required modifiers, return
attributes, and property metadata if a property form is exposed. `scoped`,
`in`, `out`, tuple names, generic constraints, and `@UnscopedRef` must survive
normal import/substitution where applicable. Implementation and `/refout`
contracts must agree, including generated abstract method return rows.

Normal GC references keep owners alive. Temporary byrefs derived by typed IL
are tracked by the GC; permanent pinning and pointer arithmetic are unnecessary.
Handles into a slice still keep the old array alive after the slice grows.
Releasing one handle is not disposal of shared storage, and no finalizer
owns a pooled/native resource in this design.

Memory safety does not provide race freedom or atomic access. `*p += 1` is
not an atomic increment. Existing `Interlocked`/`Volatile` or synchronization
APIs can operate on supported borrowed primitive locations. Multiword struct
replacement can race with a nested-field access. A translator must preserve
source locks, atomic operations, and publication; it cannot use the word
"managed" as a memory-model bridge.

### 9. Rejected programs and failure reporting

```gsharp
// Proposed negative examples.
func Bad(ref caller int32) managed[int32] {
    return managed(caller)          // ERROR: externally owned borrowed storage
}
func AlsoBad(scoped caller *int32) managed[int32] {
    return managed(*caller)         // ERROR: scoped borrowed provenance
}
let q = managed(ForeignRef())       // ERROR: imported T& has no owner contract
let r = managed(stackSpan[0])       // ERROR: unsupported borrowed owner
let bad managed[Span[int32]] = ...  // ERROR: ref-like referent cannot be stored
let ro = readonly managed(value)
WriteByRef(&*ro)                    // ERROR: readonly capability
```

A readonly alias of a **proven compiler-owned root** can be retained readonly,
but cannot be used to regain write permission. A same-value `StrongBox` copy
is never offered as an automatic repair to unknown provenance. Diagnostics
name both the address site and the offending root/origin. A user can explicitly
copy a value into a new local and address that local when independence is
intended.

Nil access, failed array checks, and allocation failures are normal runtime
exceptions. Constructing a location performs its selection checks once;
reading/writing thereafter must not repeat source getters or index effects.
No success-shaped placeholder handle is emitted after an unsupported origin.

### 10. Implementation and migration

Implementation crosses type binding, lvalue/origin analysis,
`RefCapabilities`, closure storage planning, state-machine capture planning,
generic symbol substitution, runtime references, and normal metadata emission.
Preserve a distinct bound persistent-location node rather than overloading
`ByRefTypeSymbol` with a "might escape" bit. Reuse existing named classes,
typed field/array address emission, and readonly-return metadata.

ADR-0189 binding captures and this ADR's promotion must share one storage
plan per variable. An anonymous object capturing a local and a returned handle
addressing that local must see the same writes. ADR-0190 supplies array/offset
provenance for native elements, but cell/object/CLR-array support can ship
independently of native slices.

cs2gs keeps C# `ref`, `in`, `out`, ref returns, scoped contracts, readonly
aliases, and byref-like fields in their existing categories. It does not
automatically transform C# borrowed APIs into runtime handles or weaken
definition-side diagnostics. A G# author opting into handles changes public
ABI intentionally. Specification, tooling displays, diagnostics, runtime
reference resolution, and migration notes must land with implementation.

For Go translation, a value receiver needs a value copy before its body;
a pointer receiver needs the appropriate stable location. G# in-body struct
methods do not automatically implement Go value-receiver copying. A translator
must preserve that independently, as well as nil pointers, fixed-array value
semantics, method sets, atomics, panic/recover behavior, and unsupported
zero-size/unsafe pointer observations. This proposal enables storage
preservation; it is not a complete Go pointer runtime.

## Consequences

Positive:

- Stable aliases to supported storage become returnable, capturable, and
  suspension-safe without changing value types into reference types.
- Borrowed hot-path APIs remain usable, with their exact existing CLR ABI.
- Explicit syntax makes the potential heap cost and persistent public type
  visible; correctness does not depend on escape-elision optimizations.

Costs and limits:

- Handles and promoted roots can allocate and retain large owners.
  Indirect typed access can cost more than a direct local or borrowed ref.
- Storage planning must unify early aliases and all closure/state-machine
  accesses. Partial promotion is a correctness failure, not an optimization.
- Unknown imported references remain non-convertible even when a human knows
  their current implementation is heap-backed.
- The additional category requires a runtime ABI; it does not erase existing
  lifetime diagnostics or replace a possible future ownership system.

## Alternatives considered

1. **Relax all ref diagnostics.** Reject: legal ref returns do not imply legal
   heap fields. Invalid IL and dangling stack references are not a feature.
2. **Turn structs into classes.** Reject: loses assignment, receiver, and
   interface value-copy behavior. Classes remain useful for deliberately
   reference-semantic application types.
3. **Box only when a reference escapes.** Reject as a semantic lowering:
   earlier aliases and ordinary variable reads would retain another location.
   Whole-root promotion permits later allocation optimizations only when
   identity is unchanged.
4. **Use getter/setter closures for every reference.** Convenient prototype,
   but cannot faithfully pass arbitrary nested storage by `ref`/`out`, adds
   per-access invocation machinery, and risks get-copy-set lost updates.
   Typed location access is the selected baseline.
5. **Use pinned native addresses or object byte offsets.** Reject for the
   safe baseline: complicates GC, layout, portability, and verification with no
   need for these bounded managed owners.
6. **Require a Rust-style borrow checker first.** Reject as a dependency.
   Exclusivity and GC reachability solve different problems. Readonly/scoped
   refinements can evolve without forbidding intentional shared mutation.

## Staged implementation and conformance

No implementation, allocation measurement, or runtime verification is claimed
by this proposal.

1. **Heap-origin handles.** Add explicit object-field and exact-array-element
   handles, readonly access, equality, and borrowed API bridges. Validate
   G#/C# and `/refout` before adding promotion. This is already useful for
   retained gain cells and buffers.
2. **Compiler-owned root promotion.** Add locals/by-value parameters and
   nested value fields, integrated with closure cells. Require early-alias and
   whole-aggregate tests before admitting persistent local addresses.
3. **Composition.** Add native slice origins, anonymous-object binding capture,
   and supported suspension expressions. Unsupported origins remain explicit
   diagnostics rather than waiting for a universal location framework.

Required discrimination witnesses under
[ADR-0154](0154-test-oracle-strength.md):

| Scenario | Required observation |
| --- | --- |
| Borrow before `managed(x)`, then writes by all routes | One live location; catches late boxing |
| Two address sites, nested captures, and two assemblies | Equal location/hash, shared mutation |
| Copy struct/parameter before promotion | Independent copy; catches accidental class semantics |
| Replace struct root versus replace object/array variable | Same value slot in first case, old object/array in second |
| Nested reference-field traversal | Replacing intermediate object does not retarget handle |
| Slice append within capacity versus reallocation | Handle retains selected element in the correct owner |
| Readonly nested field and object-valued slot | Reject slot writes, permit shallow object mutation |
| Incoming/scoped/imported ref and span negatives | No silent cell copy, no forged owner |
| Await, yield, channel suspension, and finally edges | Only legal handle/cell fields; raw aliases stay segment-local |
| Moving GC after original owner variable is cleared | Original owner remains reachable and mutation is correct |
| Writable/readonly generic Borrow across G#/C# | Exact byref metadata and retained alias, not a snapshot |
| Explicit-layout/covariant-array negative cases | Deliberate rejection before unsafe address creation |

Inspect emitted field types, not just successful execution: generated heap
types must contain no raw managed-byref or byref-like fields. Compare direct
borrow, explicit `StrongBox`, and handle paths for allocation/access costs.
Require zero allocations for repeated dereference and no per-access boxing;
set throughput budgets before measurement. Do not claim an unmeasured
zero-cost abstraction.

## Remaining questions and acceptance gates

- Ratify `managed[T]` / `readonly managed[T]` and address-intrinsic parsing.
  Existing `*T` and borrowed ABI are non-negotiable compatibility boundaries.
- Validate the small compiler-facing handle-base ABI, field-path identity,
  visibility, and readonly adapters through AOT and separate-assembly emission.
  No reflection fallback is permitted if typed access cannot be emitted.
- Decide whether the first root-promotion release diagnoses all merged-origin
  borrowed aliases or carries a selected descriptor through those merges.
  Either is safe; copying the current value is not.
- Coordinate ADR-0184's definition-side checks as that work is accepted.
  Persistent handles must not be used to bypass its unresolved override/
  interface contracts.
- Static/thread-static locations and arbitrary external memory owners remain
  separate extensions. They are not blockers for the bounded initial feature.
