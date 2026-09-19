# ADR-0189: Capturing anonymous objects and structural interface adaptation

- **Status**: Proposed
- **Date**: 2026-09-19
- **Phase**: Language design; capture/inference before explicit forwarding
- **Issue**: [#4329](https://github.com/DavidObando/gsharp/issues/4329)
- **Related**: [ADR-0146](0146-anonymous-class-literal.md),
  [ADR-0148](0148-safe-structural-projections.md),
  [ADR-0181](0181-readonly-managed-reference-contracts.md),
  [ADR-0182](0182-receiver-clause-is-always-extension.md),
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md),
  [ADR-0188](0188-heap-storable-managed-references.md),
  [ADR-0154](0154-test-oracle-strength.md)
- **Effect if accepted**: Lift ADR-0146's rich-field inference and lexical
  capture limitations, with explicit ordering and lifetime rules. Supply the
  separate interface-adaptation feature deferred by ADR-0148 section H.
  Preserve ADR-0181's ref contracts and ADR-0182's extension/member distinction.
  This proposal does not amend accepted documents ahead of implementation.

## Context

G# already emits ordinary CLR classes for rich anonymous literals such as
`object : I { func M() ... }`. That machinery is the right foundation for
capturing implementations and explicit forwarding adapters. CLR generics can
share emitted code; they do not make an unrelated type nominally implement
an interface. The emitted object must satisfy the actual nominal interface
slots and dispatch rules described by the
[C# interface specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/interfaces);
source-level structural matching is a compiler operation before that emission.

At the inspected `88f4c4ad8` compiler snapshot:

- [Binder.cs](../../src/Core/CodeAnalysis/Binding/Binder.cs), approximately
  lines 3113-3240, synthesizes top-level rich classes before expression binding.
  It requires explicit rich-field types, copies initializers/base arguments
  into the class, and carries methods/events into the ordinary class binder.
- [ExpressionBinder.Literals.cs](../../src/Core/CodeAnalysis/Binding/ExpressionBinder.Literals.cs),
  approximately lines 1913-1922, constructs the rich type with zero arguments.
  Its field-only path already binds initializer values in lexical scope and
  infers their types.
- [Parser.Expressions.Creation.cs](../../src/Core/CodeAnalysis/Syntax/Parser.Expressions.Creation.cs)
  admits anonymous fields, methods, and events. It does not parse a general
  anonymous property member; synthesis supplies an empty property list.
  ADR-0146's broader introductory property wording must not be mistaken for a
  delivered implementation.
- [Issue2243AnonymousClassEmitTests](../../test/Core.Tests/CodeAnalysis/Emit/Issue2243AnonymousClassEmitTests.cs)
  demonstrates interface methods, base overrides, and field-only data copying.
  It does not establish universal rich-property or rich-data behavior.

Cliamp at `4dee32c` provides concrete consumers:
[provider/interfaces.go](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/provider/interfaces.go)
declares small optional capabilities;
[ui/model/update.go](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/ui/model/update.go)
combines a value receiver with message type switches; its streaming pipeline
uses independently implemented methods with shared buffer arguments.
These motivate native composition, but Go dynamic-interface fidelity remains a
separate translation boundary.

## Decision

**Bind rich-object fields, initializers, and free variables in their lexical
environment, then lower them through the existing class/closure machinery.
Add an explicit `adapt[I](source)` operation that generates a statically
checked forwarding class implementing `I`.**

There is no implicit structural interface conversion, reflection proxy,
retroactive interface declaration, or runtime shape search. A missing or
unsupported contract is a diagnostic. Direct `object : I { ... }` remains
useful on its own and does not wait for ADR-0188.

All new constructs and examples below are **proposed**. Named interfaces,
methods, and existing object syntax in the examples use their current role;
capture/inference/adaptation semantics are the proposed additions.

### 1. Captures: binding versus snapshot

```gsharp
// Proposed capture/inference behavior.
var count = 1
let counter = object : ICounter {
    let Initial = count
    func Read() int32 -> count
    func Increment() { count += 1 }
}
count = 10
counter.Increment()
// counter.Initial == 1; counter.Read() == 11; count == 11.
```

An explicit initializer, such as `let Initial = count`, evaluates once when
the literal is constructed and stores that value. It is a **snapshot**, with
ordinary shallow value copying. A free variable used by a member body denotes
its **lexical binding**: later reads/writes use the same variable as the outer
body and sibling closures. Do not implement both forms by copying their
current value into unrelated fields.

A `let` binding remains immutable as a binding; captures cannot assign to it.
Capturing an object-valued `let` does not make its object immutable. Mutable
captured variables share a closure cell. Immutable captures can be stored
directly when doing so is observationally equivalent. If ADR-0188 also takes a
persistent address of a captured variable, both features must use one storage
plan and one cell.

The capture environment is hidden implementation state. It is not a public
anonymous member, primary-constructor data field, equality/hash component, or
`ToString`/deconstruction component. Capturing `secret` must not accidentally
create a public `secret` field for reflection-oriented consumers.

### 2. Lexical binding, inference, and receiver rules

Bind omitted rich-field types at the literal site using the existing local/
field-only inference rules. Explicit annotations supply the expected type and
continue to win. `nil`, an untyped lambda, an ambiguous method group, or a
cyclic inference dependency requiring more information gets the normal
target-type/inference diagnostic; it does not infer `object` as a fallback.
Nullability and generic type parameters are retained in field types.

There are deliberately two scopes:

| Position | Name binding |
| --- | --- |
| Base-constructor argument / explicit field initializer | Enclosing lexical scope; evaluated once |
| Member parameter/local | Ordinary member-local scope, shadows outer names |
| Unqualified anonymous member reference inside a body | Anonymous member scope before enclosing lexical fallback |
| Remaining free variable inside a body | Original enclosing binding, captured by symbol identity |
| `this` inside a member body | New anonymous object |
| `this` inside an initializer/base argument | Enclosing receiver, if available at the literal site |

Initializers cannot refer to not-yet-constructed anonymous instance members.
`let x = x` can snapshot an outer `x`; it does not read its own uninitialized
field. To refer to an outer receiver from a method body, explicitly capture
an outer local such as `let outer = this` before the literal. This avoids
making the same `this` token mean two receivers inside a member.
Unqualified missing members do not implicitly search an outer receiver's
instance members; ordinary lexical variables and available type names suffice.

Nested objects/closures preserve the original binding identity, not the name
string or a copied intermediate value. A declaration shadowing the name
creates a new binding. Loops use the language's existing dynamic variable-
instance rules; synthesis must not merge separate iteration bindings.

Capturing an ordinary reference-type receiver value is permitted. Capturing
a borrowed struct receiver is not implicitly a value copy or lifetime
extension. Use an explicit value snapshot before the object when a copy is
intended, or an admitted ADR-0188 handle when persistent shared mutation is
intended. Captures of raw borrowed aliases, ref parameters, scoped references,
or byref-like values remain rejected. A by-value initializer may read a
borrowed scalar while in scope and store the scalar copy; that is not a
borrow capture.

Synthesized classes close over lexical type parameters as ordinary generic
parameters with their constraints and nullability. A capture type that might
be byref-like cannot be an ordinary heap field. Generic sharing is an emission
optimization, not permission to erase that restriction.

### 3. Construction order and exceptions

The new lexical-construction contract is deterministic:

1. Resolve the capture bindings without executing member bodies.
2. Evaluate base-constructor arguments once, left-to-right.
3. Evaluate explicit field initializers once in declaration order, in the
   literal's lexical environment. Method/event declarations introduce no
   initializer effects of their own.
4. Construct the ordinary generated class with the saved values and capture
   environment. Initialize its explicit fields and hidden environment before
   invoking the selected base constructor.
5. Invoke the base constructor once and return the object after it completes.

This deliberately ensures an override called by a base constructor observes
the initialized snapshot fields and valid capture environment. It requires
the same legal pre-base field-initialization capability used by normal class
construction; do not achieve it by invoking methods on an otherwise
uninitialized `this`. Initializer expressions cannot access the new object.
If the existing emitter cannot satisfy this order in verifiable IL, that
inheritance combination remains diagnosed until the emitter is corrected.

If an argument/initializer throws, later initializers and the base constructor
do not run. If the base constructor throws, already executed argument and
initializer effects remain observable; no successfully constructed object is
returned. A base constructor can still leak `this`, as with an ordinary class;
the proposal does not invent a construction-transaction guarantee.

Environment allocation may occur when the enclosing binding is hoisted,
rather than at the literal itself. Object allocation may fail. These ordinary
allocation effects do not justify reordering user computations, running field
initializers twice, or moving a snapshot into a later forwarding call.
For existing self-contained rich literals, the rollout must compare exact
constructor/initializer traces. Any difference introduced by this specified
order requires explicit migration notes, not a claim of universal source
equivalence.

### 4. Existing object variants and exposed types

Field-only `object` and `data object` literals keep their current synthesis
paths, reflection shape, snapshot evaluation, and data-member behavior.
Do not route all field-only objects through a new heap class merely to
simplify captures.

Rich `object` stays a reference type and keeps nominal interface/base dispatch.
Its explicitly declared fields remain the declared members; inferred types do
not make those fields hidden captures. Preserve ADR-0146's local/private/
internal access to the inferred rich type and public/protected narrowing to
the declared supertype (or `object`). Public exported APIs should declare an
interface/base return type explicitly when multiple supertypes make intent
unclear. This proposal does not silently solve ADR-0146's separate field-only
private-return inference limitation.

The present rich synthesis does not preserve `data` as a general rich-data
implementation. Do not promise rich-data equality or `with` capture semantics
because field-only data tests pass. Capturing rich `data object` combinations
are diagnosed in the initial feature; existing noncapturing cases are not
redefined here. A future rich-data decision must specify copy behavior for
capture cells and exclude hidden environment fields from data operations.

### 5. Explicit structural adaptation

```gsharp
// Proposed explicit adaptation. The source need not declare IReader.
let reader IReader = adapt[IReader](OpenReader())
let manual = object : IReader {
    let Source = OpenReader()
    func Read(buffer slice[byte]) int32 -> Source.Read(buffer)
}
```

`adapt[I](e)` evaluates `e` exactly once and returns a fresh compiler-generated
ordinary class implementing the statically known interface `I`, including
inherited obligations. It always wraps, even if the source already nominally
implements `I`. Ordinary assignment/casts remain the allocation-free nominal
choice; making `adapt` uniform avoids conditional identity/boxing surprises.
The result's source type is `I`, not the richer anonymous implementation type.

Automatic mapping uses accessible public instance members of the static
source type. It does not gain privileged access because the adaptation
expression appears inside the source type's own body. Internal/private
members and extensions are not automatic candidates; a manually written rich
object can deliberately express a legal lexical call when desired.
Inherited public instance members participate under ordinary member lookup.
A source exposing a slot only through an explicit nominal implementation can
first be viewed as that interface and adapted from the interface-typed value.
Nominal conformance does not make a private implementation a public structural
candidate or bypass the applicability rules.

Resolve the complete plan at compile time. Store selected symbols and
substitutions in the bound plan; do not redo overload resolution by name in
the emitter or invoke `GetMethod` at runtime. Diagnostics identify the source
type, target interface slot, and the exact mismatch.

An imported source declaration is never modified. The adapter is emitted in
the caller's assembly, which already references the source and target
contracts. This avoids requiring the source assembly to reference every
future capability interface or introducing dependency cycles.

### 6. Source storage and mutation

| Adaptation form | Saved state | Mutation and reassignment |
| --- | --- | --- |
| `adapt[I](classExpression)` | Evaluated object reference | Calls use that object; reassigning source local does not retarget |
| `adapt[I](structExpression)` | One value copy in a mutable private field of adapter | Calls act on that field; changes persist across calls, not in original variable |
| `adapt[I](interfaceExpression)` | Evaluated interface value | Forward only statically available interface members; never discover dynamic shape |
| `adapt[I](ref handle)` | ADR-0188 `managed[T]` for value-type `T` | Each call borrows that persistent location; updates original slot |
| `adapt[I](ref readonlyHandle)` | ADR-0188 `readonlyManaged[T]` for value-type `T` | Only compatible readonly source members admitted |
| Raw borrowed/ref-like source or location | Not admitted | Ordinary heap adapter cannot retain it |

The `ref` operand form is a **proposed adaptation mode**, not a CLR borrowed
argument. Its expression must have one of the persistent handle types.
The referent must be statically a value type; an open type parameter needs an
appropriate existing value-type constraint.
It evaluates the handle once; rebinding that handle variable does not retarget
the adapter. It is deferred until ADR-0188 is available and does not block
reference/value-copy adaptation.

For class-valued handles, explicitly dereference and use value adaptation to
snapshot the current object: `adapt[I](*p)`. The initial location mode rejects
class-valued handles rather than ambiguously deciding whether replacing an
object reference slot should retarget all calls.

A struct copy is stored in a **mutable** adapter field even when the adapter
variable is declared with `let`. Forwarding obtains that field's address;
it must not box a new copy or call through a defensive temporary on each
invocation. Constrained generic dispatch preserves mutation when required.
An already boxed source supplied through an interface remains that evaluated
interface object; the adapter does not unbox/rebox it behind the caller's back.

```gsharp
// Proposed witnesses; Counter is a mutable value type.
var c = Counter{Value: 1}
let copy = adapt[ICounter](c)
copy.Increment()
copy.Increment()
// copy.Read() == 3; c.Value == 1.

let p = managed(c)
let shared = adapt[ICounter](ref p)
shared.Increment()
// c.Value == 2. No value-copy adapter was substituted.
```

Readonly-location adaptation rejects a non-readonly struct source method
rather than silently forwarding to a defensive copy. Use an explicit manual
object to request copy-per-call behavior. This stricter automatic-adaptation
rule does not change ADR-0181's ordinary readonly-call semantics.

### 7. Supported-member and contract matrix

The first automatic-adaptation release is useful but intentionally narrow.
Every required unsupported slot causes a diagnostic; a partial adapter is not
success. Direct rich literals retain their existing methods/events regardless
of the automatic matrix.

| Contract | Stage B1: initial automatic adaptation | Stage B2: bounded extension |
| --- | --- | --- |
| Public instance nongeneric method, by-value parameters/return | Supported with exact substituted signature | Unchanged |
| Closed generic source/interface types | Supported where ordinary substitution proves mapping | Unchanged |
| Inherited abstract method slots | Supported; enumerate complete interface closure | Unchanged |
| Generic methods | Diagnose initially | Same arity and alpha-equivalent constraints; exact substituted signature |
| `ref`, `out`, `in`, `ref readonly` parameters/returns | Diagnose initially | Exact ref-kind, readonly, scope, and lifetime contract |
| Properties / indexers | Diagnose required slots initially | Exact accessible accessor set and metadata; no field-to-property inference |
| Events | Diagnose required slots initially | Forward exact add/remove accessors; do not synthesize a different event store |
| Default interface instance method | Use normal default when no source match is selected | Same; most-specific/default conflicts diagnosed |
| Static abstract/virtual requirements, operators | Diagnose | Separate future design, not part of B2 |
| Extension-only source member | Not a candidate | Still not a candidate |
| Ref-like source/possible ref-like generic source | Reject heap capture | Still reject |

For B1, parameter types and non-void return types must be ordinary
heap-storable types; `void` returns are supported, and passing a slice
descriptor is fine. Later support for scoped/ref-like method
**parameters** does not imply storing them in the adapter. B2 opens only forms
whose named-interface emitter and importer already preserve the full contract.
The rich-literal property/indexer grammar and synthesis need explicit work;
they cannot be assumed to exist because adaptation needs accessor stubs.

Matching rules:

1. Names are exact and case-sensitive. Normal public instance lookup supplies
   candidates; extension methods are excluded under ADR-0182.
2. Parameter count, ordered parameter types, ref-kinds, generic arity, and
   return type/ref-kind must match exactly after substitution. No numeric,
   user-defined, structural-projection, array/slice, optional-argument, or
   `params` expansion conversion repairs a mismatch. No return covariance is
   synthesized in the initial mapping.
3. Enforce parameter/return nullability compatibility in the correct direction:
   the source must accept every value the interface permits and must supply
   every guarantee the interface makes. Treat an unknown/oblivious annotation
   that prevents proof as an automatic-adaptation error; a manual wrapper can
   validate or explicitly assert intent. Writable byrefs require invariant
   pointee annotation contracts.
4. Generic method constraints in B2 are compared under renaming of method
   parameters. A source method with stronger constraints is not a valid
   forwarder. Start with exact normalized constraint equivalence rather than
   designing a general implication prover.
5. Parameter names/default constants come from the target contract on generated
   slots; they do not select source overloads. A target `params` member remains
   that metadata contract and forwards the supplied array normally.
6. Required/custom modifiers, readonly return attributes, `scoped`, and
   `UnscopedRef` behavior are part of the contract, not decorations discarded
   after matching. Unsupported required modifiers or lifetime adaptation are
   diagnostics. Unknown optional metadata is preserved where needed, not
   invented as semantics.

If two accessible candidates survive exact matching, reject ambiguity.
Inherited duplicate target slots can share a stub only when contracts agree;
otherwise emit separately qualified implementations when legal, or diagnose.
For a default slot, an exact selected source method is forwarded; absent one,
use the interface's normal most-specific default. A required abstract slot
still needs a match. Default-interface ambiguity is not resolved by arbitrary
declaration order.

Interface variance remains a normal **nominal conversion of the resulting
interface value**. It is not structural inference or a reason to change the
source method signature. An unconstrained type parameter has no discoverable
structural method set; adapting it requires sufficient existing nominal
constraints. This proposal adds no `where T has M` constraint system.

### 8. Ref forwarding and suspension in the extended surface

In B2 a writable ref result must forward the source's exact live location,
and a readonly ref result must retain its capability and metadata. A by-value
getter is never a substitute. The target interface's lifetime promises must be
provable from the source method and adapter storage. A borrowed result rooted
in the adapter's owned struct field or an admitted persistent location can be
legal; a result requiring an unsupported definition-side contract is rejected.
Coordinate with
[upstream ADR-0184](https://github.com/DavidObando/gsharp/blob/b96dff29c4d18f5a29f9b7e372ce31953cb52a74/docs/adr/0184-unscoped-ref-definition-side.md)
rather than dropping its checks from generated stubs.

The adapter retains heap-storable source state only. Temporary borrows used
for invocation never cross an `await`/`yield` inside a generated state machine.
Forwarding a method returning `Task[T]` normally returns that task directly;
the wrapper does not become `async`, add an `await`, wrap exceptions, or
change completion identity. Existing async methods' value-receiver behavior
is preserved by their ordinary calls, not rewritten into persistent byref
state machines.

For methods/events/accessors, evaluate each caller argument once under normal
call rules. Invoke the selected target once. Throw the target's original
exception, not `TargetInvocationException`. No getter is invoked during
adapter construction merely to discover whether its type matches.

### 9. Identity, nulls, equality, and observable types

An automatic adapter is a **distinct CLR object**:

- `ReferenceEquals(adapter, source)` is false for a reference source.
- Repeated `adapt[I](source)` calls produce distinct adapter identities.
  Assignment of an existing adapter value preserves its identity.
- `GetType()` and reflection observe the generated wrapper. `is SourceType`
  does not become true merely because the wrapper contains that source.
- The wrapper implements only the requested interface and its inherited
  interfaces, not all other interfaces that happen to match.
- Default `Equals`/hashing are wrapper reference identity; no automatic
  forwarding to source equality or mutable struct contents occurs. Interface
  slots explicitly declaring equality-like methods follow their slot mapping;
  that does not silently replace `object.Equals`/`GetHashCode`.
- Generated type names/layout are not a stable serialization or source API.
  There is no implicit source-unwrapping cast or universal `Source` property.

The generated class derives from `object`, not the source class. Its methods
are explicit interface implementations where appropriate, so an interface
member named `Equals` cannot inadvertently override the wrapper's object
identity contract.

`adapt[I](e)` requires a statically non-null reference/interface source, or a
non-null persistent handle in location mode. A nullable source must be
narrowed first. A null supplied from an oblivious/foreign boundary throws
`ArgumentNullException` at adaptation, before constructing a functioning
wrapper. The operation does not manufacture a non-null interface value
containing a null source. `I?` can still represent absence using ordinary G#
nil semantics; no typed-nil rule is added to ordinary interface comparison.

This identity policy intentionally differs from a transparent cast. ADR-0148's
statement that adaptation forwards behavior/identity must be read here as
preserving the selected **source storage target for calls**, not as making a
wrapper CLR-identical to its source. A concrete DTO projection still constructs
a different value by copying members; it is not adaptation.

### 10. Overloads, accessibility, and lowering

`adapt[I](e)` is an explicit contextual operation with a fully resolved
interface target. It does not add an implicit conversion edge to
`ConversionClassifier`. Existing nominal conversions, casts, generic
inference, and ADR-0148 concrete projection precedence are unchanged. If a
method overload takes either `I` or a concrete DTO, `adapt[I](e)` has type `I`;
the compiler does not retry another adaptation when overload selection fails.

The planned implementation reuses:

- lexical binding and inferred initializer binding from the field-only path;
- variable capture discovery and storage rewriting in
  [ClosureEmitter](../../src/Core/CodeAnalysis/Emit/ClosureEmitter.cs) and its
  existing lowering collaborators;
- rich/named-class symbol creation, interface verification, and constructor
  emission;
- ordinary call binding, generic substitution, explicit interface slots, and
  ADR-0181 readonly metadata;
- the shared location plan from ADR-0188 only for persistent-location mode.

Do not transplant syntax into a different scope and attempt to recover
captures by spelling later. Predeclare a synthetic type/member shell to handle
recursive references and existing return-type inference, bind the literal
in its lexical context, then populate bound initializers, capture fields,
constructor parameters, and method bodies. Circular inferred field/member
dependencies must produce a diagnostic, not a speculative `object` type.
Keep stable syntax/symbol identity across global/program passes and editor
partial binding. Where a captured type or explicit lexical member access
requires enclosing-type visibility, place a helper in the appropriate nested
declaration context or use a legal compiler-generated bridge. Do not widen
user-member visibility, use privileged reflection, or assume a relocated
top-level class has its original source's access rights.

An adaptation plan records source-storage mode, exact interface obligations,
selected source symbols, substitutions, permissions, and generated stubs.
Emission is ordinary generic IL with direct/constrained/interface calls as
appropriate. No `dynamic`, `DispatchProxy`, runtime assembly generation, or
reflection-based member invocation is used as a fallback.

Generated classes can be cached by static shape within a compilation, but
instances cannot be silently cached: allocation identity and captured values
are observable. Closed generic instantiations reuse ordinary CLR generics.
Trim/AOT reachability follows static method references. Generated members
must not require runtime discovery of unreferenced source methods.

Public API signatures expose `I`, not internal wrapper/capture types.
Implementation assemblies contain the ordinary InterfaceImpl/MethodImpl,
MethodDef, and applicable property/event metadata. Reference assemblies must
agree on externally visible source/target/ref/nullability contracts and must
not require consumers to resolve a private closure class. For exported
signature types, normal accessibility rules still apply; adaptation cannot
export an inaccessible interface accidentally.

### 11. Diagnostics and rejected programs

```gsharp
// Proposed negative examples.
let implicit IReader = unrelated     // ERROR: still no nominal conformance
let wrong = adapt[IReader](42)       // ERROR: missing required Read signature
let hidden = adapt[IReader](privateOnlyReader) // ERROR: no public candidate
let borrowed = adapt[ICounter](ref stackAlias) // ERROR: requires persistent handle
let unknown = adapt[IReader](someObject) // ERROR when static type is object

func Bad(ref n int32) ICounter {
    return object : ICounter {
        func Read() int32 -> n        // ERROR: escaping borrowed capture
    }
}
```

Other required diagnostics include ambiguous signatures, unknown generic
constraints, incompatible nullability/ref-kind, readonly-location mutation,
byref-like captured fields, unsupported required properties/events in B1, and
unsupported lifetime contracts in B2. Retiring GS0486 for supported inferred
rich fields must not suppress unrelated invalid-type diagnostics. Existing
`init`/`deinit` rejection remains in force.

The primary diagnostic belongs at the adaptation/capture expression and names
the target obligation; related locations identify the candidate or captured
declaration. Do not report success and emit a stub that returns default,
throws `NotImplementedException`, drops an event, or invokes a reflection proxy.

### 12. Translation and compatibility boundaries

cs2gs C# anonymous types remain on the field-only property-shaped path. Their
snapshot evaluation, expression-tree member metadata, equality behavior, and
ordinary nominal interface conversions must not be rerouted through automatic
adapters. Explicitly authored G# adapters can be consumed by C# through normal
interfaces. They do not change C# source type tests or reflection.

The translator cannot model Go interfaces as "just call `adapt` everywhere."
The [Go specification](https://go.dev/ref/spec#Interface_types) distinguishes
dynamic types, value copies, pointer method sets, and comparability; the
[Go FAQ](https://go.dev/doc/faq#nil_error) explains why an interface holding a
typed nil differs from a nil interface. Native G# wrappers deliberately keep
ordinary CLR identity and null behavior.

Consequently Go translation still needs an explicit, bounded interface-value
layer or metadata strategy:

- Record original Go dynamic type and value-versus-pointer mode separately
  from the CLR adapter class. Type assertions/switches consult that identity,
  not `GetType()` on the wrapper.
- Enforce `T` versus `*T` method sets before selecting mappings. ADR-0182
  extension methods are not nominal implementations or automatically eligible
  structural candidates.
- Copy a source value when placing it into an interface. Preserve Go
  value-receiver copy-per-call behavior in translated method bodies/bridges;
  the native struct adapter's persistent field mutation is not that rule.
- Use native persistent-location mode for translated pointer sources only
  when its storage semantics match. Do not alias a reassignable source local
  merely because a closure was convenient.
- Implement Go interface equality/hashing, dynamic comparability failure, and
  typed-nil distinctions explicitly. Wrapper reference equality is not the
  source-language answer.
- Runtime optional-capability checks require generated known-type metadata or
  dispatch bridges. `adapt[I](objectValue)` does not inspect an unknown runtime
  shape. Imported types require no retroactive declaration modification.

Those helpers should be generated only for actually used interfaces/types.
This ADR does not authorize a universal runtime proxy or dependency graph
rewrite. Its native captures/adapters remain useful without a Go translator.

## Consequences

Positive:

- Capturing rich objects become practical for callbacks and small interface
  implementations without hand-written named classes.
- Static forwarding supports imported types without altering their source or
  manufacturing assembly dependency cycles.
- Existing class/interface emission, closure storage, and generics provide
  most of the mechanism. AOT-friendly direct calls replace runtime shape search.

Costs and boundaries:

- An explicit adaptation allocates an ordinary wrapper and changes observable
  CLR identity. Mutable struct value adaptation owns a copy.
- Binding rich members in lexical scope requires a real symbol/capture plan,
  not a small textual-desugaring patch.
- B1 rejects contracts that need properties, events, generic methods, or refs;
  expansion requires exact metadata and lifetime tests, not optimistic docs.
- Full Go interface identity/comparability/typed-nil semantics remain outside
  normal G# interface behavior.

## Alternatives considered

1. **Implicit structural interface conversion.** Convenient, but introduces
   hidden allocation, wrapper identity, and new overload edges. Explicit
   adaptation supplies a controlled first implementation.
2. **Add matching interfaces to each source declaration.** Useful when an
   author intentionally owns both contracts, but impossible for arbitrary
   imported types and capable of introducing dependency cycles.
3. **A universal generic `Adapter[S,I]`.** CLR generics cannot emit arbitrary
   nominal interface slots just because signatures look compatible. Generated
   ordinary classes are still necessary; generics share their code.
4. **Reflection or dynamic proxies.** Avoid some compile-time generation but
   weaken diagnostics, alter exception/performance behavior, and complicate
   trimming/AOT. Rejected as default and as silent fallback.
5. **Snapshot every free variable.** Easy synthesis, wrong for later writes
   observed by sibling closures. Explicit field initializers already provide
   deliberate snapshot semantics.
6. **Capture every source variable by binding.** Wrong for adaptation:
   reassigning a local would retarget an adapter that should retain the
   originally evaluated source. Storage mode is explicit instead.
7. **Ship capture only forever.** It is the right first stage and remains the
   manual escape hatch, but complete static forwarding avoids repetitive
   wrappers without introducing another dispatch runtime.

## Staged implementation and conformance

This proposal adds no implementation and claims no executed validation.

1. **Stage A: capture and inference.** Bind rich fields/base arguments at the
   literal site, synthesize constructor/environment state, and share lexical
   cells with closures. Support existing methods/events, inherited overrides,
   generic captures, and visibility narrowing. Diagnose unsupported capture
   shapes. This stage is independently useful.
2. **Stage B1: explicit method forwarding.** Add the initial matrix for
   ordinary reference sources and value copies, including closed generic and
   inherited interfaces. Freeze identity/null/error behavior with G#/C# tests.
3. **Stage B2: richer exact contracts.** Add properties/indexers/events,
   generic methods, and borrowed/readonly forwarding only as exact named-
   member metadata and lifetime support permit. This includes any missing
   rich-property syntax/synthesis work, not just a switch in the mapper.
4. **Stage C: persistent-location composition.** Enable the explicit handle
   operand mode after ADR-0188. Native slice parameters under ADR-0190 simply
   use their declared nominal runtime types; no array/slice adaptation occurs.

Discriminating fixtures under ADR-0154 must include:

| Scenario | Required observation / failure witness |
| --- | --- |
| Snapshot field plus method capture of same variable | Initial snapshot differs from later binding value |
| Outer assignment and sibling object/lambda mutation | All binding captures see one cell |
| Nested shadowing and generic captures | Correct symbol/type/nullability, not name-based lookup |
| Base arguments, field initializers, throwing cases, base virtual call | Exact event trace and initialized environment |
| Ref-like/ref/scoped capture | Targeted error; no forbidden generated heap fields |
| Field-only/data/cs2gs regression corpus | Existing properties, data members, and expression-tree shape unchanged |
| Source expression with side effects, then local reassignment | Evaluated once; wrapper stays on original source |
| Mutable struct forwarded twice | Mutations persist in adapter copy, not original variable |
| Persistent-location and readonly-location mode | Original updates only in admitted mode; unsafe mutation rejected |
| Missing/ambiguous/inaccessible/nullable/ref-kind mismatch | Slot-specific diagnostics, no partial adapter |
| Generic/inherited/default interface cases | Correct exact slots and conflict rejection |
| Properties/indexers/events in B2 | Accessor calls and subscriptions reach source once, no replacement store |
| Ref result retained while source storage changes | Correct live alias, not a value or defensive copy |
| Repeated adaptation, `is`, reflection, equality/hash | Explicit distinct wrapper identity |
| Foreign null, throwing source call, returned task | Selected null behavior; original exception/task identity |
| Separate source/target/caller assemblies and `/refout` | No declaration edits, exact interface and ref metadata |
| AOT/trim and unsupported runtime shape | Static reachability; no dynamic-code/reflection fallback |
| Go-derived typed-nil/type-switch/comparability cases | Translator identity layer used, not accidental wrapper semantics |

For allocations, require one ordinary wrapper per successful `adapt` in the
baseline, plus only documented capture/handle state, and no per-forwarded-call
boxing/delegate allocation introduced by the adapter. Compare against a
hand-written ordinary wrapper before claiming performance. Budget decisions
belong in the implementation PR before measurements, not fabricated here.

## Remaining questions and rollout gates

- Ratify `adapt[I](e)` and the explicit persistent-handle operand spelling
  with parser/name-collision tests. The explicit allocation/conversion boundary
  must remain regardless of final spelling.
- Verify pre-base field/environment initialization and existing constructor
  traces in the real emitter before enabling captured base overrides.
- Decide the exact B2 member order by existing emitter readiness; the matrix's
  diagnostics remain mandatory until each contract passes cross-assembly tests.
- Coordinate shared capture-cell planning with ADR-0188 without making
  reference-type captures depend on the complete persistent-reference feature.
- Rich-data captures, structural generic constraints, runtime shape discovery,
  and Go interface-value emulation remain separate designs, not hidden
  prerequisites or promised native behavior.
