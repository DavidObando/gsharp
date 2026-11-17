# ADR-0223: Structural nullable types through native CLR type companions

- **Status**: Proposed
- **Date**: 2026-11-17
- **Phase**: Compiler ABI design; implementation requires separate maintainer approval
- **Related**: [#6040](https://github.com/DavidObando/gsharp/issues/6040), [#6043](https://github.com/DavidObando/gsharp/issues/6043), [draft #6044](https://github.com/DavidObando/gsharp/pull/6044), [ADR-0001](0001-null-model.md), [ADR-0084](0084-gsharp-extensions-optional-sequences.md), [ADR-0087](0087-reified-generics-emit-audit.md), [ADR-0089](0089-static-virtual-interface-members.md), [ADR-0100](0100-default-expression.md), [ADR-0154](0154-test-oracle-strength.md), [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md), [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md)

## Context

Source structural `T?` must distinguish absence from a present zero when `T` becomes `int32`.
The current unconstrained declaration ABI encodes `T?` as bare `T`.
Closed substitution can instead produce `Nullable<int32>`.
This disagreement produces invalid IL in #6040.
The same representation boundary affects generic fields in #6043.

The adapter in draft #6044 wraps returned raw values.
It repairs stack types but cannot recover an erased absence tag.
It changes `Nil[int32]() == nil` from true to false.
That adapter remains nonmergeable, regardless of its green CI.
Approval of this Proposed ADR would authorize replacing it, not accepting it.

### Existing decisions and their boundary

- ADR-0001 gives source nullable types structural absence.
  `NullableTypeSymbol.Get` already normalizes repeated nullable application.
- ADR-0100 makes `default(T?)` absent.
  `default(T)` follows the actual argument.
- ADR-0084 rejects a public `Option<T>` API.
  Its unconstrained reference/value split describes an emission limitation, not a sufficient presence-preserving ABI.
- ADR-0087 retains ordinary CLR generic reification.
  This proposal does not replace ordinary `T` with `object`.
- ADR-0089 currently erases unconstrained source nullable positions for interface matching.
  Acceptance would replace that rule **for marked source structural signatures**.
  It would not change foreign CLR slot identity.
- ADR-0186 and ADR-0193 remain authoritative for unmarked CLR imports.
  Imported `[Nullable(2)]T` stays nullable for reference arguments, unchanged for value arguments, and unchanged for an in-scope unconstrained argument.
  `PlatformTypeSymbol` remains distinct from `NullableTypeSymbol`.
  This proposal does not reinterpret C# annotations as structural nullable operators.
- [ADR-0220](0220-type-level-nullability-metadata-and-constraints.md) supplies type-level nullable metadata and constraint enforcement.
  Preserve `class?`, `notnull`, annotated bounds, dependent bounds, and their existing diagnostics.
  The companion plan must integrate with `TypeNullabilityPlan`, not duplicate its logical nullability decisions.

Thus raw `T` is an existing emitted ABI, but cannot implement the required source distinction.
Changing only return instructions or closed substitution cannot solve the problem.
No implementation or new semantic mode is authorized by this document.

### Recorded controls

These are executions, not a proof of the proposed ABI.
They used the actual published osx-arm64 compiler 0.5.698 and draft compiler commit `91fe547cc49cc430bd5bf9d0bf56e8471e5f8b1b`.
Both runtimes exited zero.
The combined published image failed strict unsuppressed ILVerify; the draft image passed.

| Source operation | Published runtime observation | Draft adapter observation | Required structural result |
| --- | --- | --- | --- |
| `Value[T]() T? -> default(T)`; `Value[int32]().ToString()` | Empty string | `"0"` | `"0"` |
| `Empty[T]() T? -> default(T?)`; `Empty[int32]() == nil` | True | False | True |
| `Nil[T]() T? -> nil`; `Nil[int32]() == nil` | True | False | True |
| `Nil[string]() == nil` | True | True | True |
| `Nil[int32?]() == nil` | True | True | True |
| Struct-constrained `Value[int32]().ToString()` | `"0"` | `"0"` | `"0"` |
| Struct-constrained `Nil[int32]() == nil` | True | True | True |
| One producer chooses `nil` or `default(T)`; test absence at `int32` | True / True | False / False | True / False |
| `Forward[T]() bool -> Nil[T]() == nil`; `Forward[int32]()` | False | False | True |

The original minimal program requires stdout bytes `30 0a`, not merely a successful exit.
Published execution of invalid IL is not a language oracle.

Explicit native Roslyn controls used SDK 10.0.401's `csc.dll`, framework references, nullable checking, and warnings as errors.
In C#, unconstrained `T?` is an annotation:
`Value<int>()` and `Empty<int>()` both produce zero.
Reference and nullable-value arguments produce null.
Unconstrained `T? Nil<T>() => null` is rejected with CS0403.
Struct-constrained nullable absence is supported.
The valid C# controls passed strict ILVerify.
These controls explain why copying the C# ABI would change accepted G# source semantics.

## Decision

**Recommend native CLR nullable type companions, not a new runtime value carrier.**
When an open source parameter needs structural nullable representation, carry its normalized nullable CLR type as an additional generic argument.
Keep the original parameter unchanged.

This is a proposed breaking source-ABI revision.
Implementation requires explicit approval of the representation, foreign-slot diagnostics, and coordinated rebuild boundary below.

### 1. One normalized native type family

Define `N(A)` as the physical CLR type of the source nullable form of `A`.

| Actual or known parameter kind | Physical `A` | Physical `N(A)` |
| --- | --- | --- |
| Nonnullable value, such as `int32` | `System.Int32` | `System.Nullable<System.Int32>` |
| Reference, such as `string` | `System.String` | `System.String`, with logical nullable information |
| Already nullable value, such as `int32?` | `System.Nullable<System.Int32>` | The same `System.Nullable<System.Int32>` |
| Already nullable reference | Its CLR reference type | The same CLR reference type |
| Open `T struct` | `VAR/MVAR T` | `System.Nullable<VAR/MVAR T>` |
| Open `T class` or `T class?` | `VAR/MVAR T` | The same `VAR/MVAR T` |
| Open mixed `T`, including `notnull` | `VAR/MVAR T` | Companion `VAR/MVAR N_T` |
| Open parameter already known logically nullable | Its normalized physical type | That same physical type |

`notnull` does not prove a reference or value representation.
Use existing constraint queries to recognize other proven reference bounds.
Ordinary constraints still apply to `T`.
Do not copy its `struct`, `class`, interface, or `notnull` constraints onto `N_T`.
The companion can be a reference type or a nullable value type.
Existing unsupported byref-like generic arguments remain unsupported; boxing cannot silently extend their domain.

Conceptually:

```text
source: Missing[T]() T? -> default(T)
CLR:    Missing<T, N_T>() -> N_T
call:   Missing<int32, Nullable<int32>>()

source: Box[T].Value : T?
CLR:    Box<T, N_T>.Value : N_T
closed: Box<int32, Nullable<int32>>.Value : Nullable<int32>
```

`T` still denotes `int32` in the first call.
Do not implement it as `Missing<Nullable<int32>>()`.
That would change `default(T)` and `typeof(T)`.

`N(N(A)) = N(A)`.
There is no second presence bit for `int32??` or for an already nullable actual generic argument.
The proposal preserves the existing idempotent nullable model, not an `Option<Option<A>>` model.

### 2. Value operations and location identity

All storage and signatures use the same physical type plan.
There is no return-only adapter.

| Operation in mixed open code | Planned lowering |
| --- | --- |
| `default(T)` | Initialize the original `T` slot |
| Convert an ordinary `T` value to `T?` | Evaluate once; `box T`, then `unbox.any N_T` |
| `nil` or `default(T?)` | Initialize an `N_T` slot |
| Test nullable absence | Box `N_T` and compare with null |
| Unwrap after a successful presence check | Value conversion from `N_T` to `T`; preserve existing checked-assertion failure behavior |
| Copy a nullable value | Copy the native `N_T` value, not a shared boxed storage cell |
| Address a whole nullable slot | Address its actual `N_T` storage |

The CLR's nullable boxing rules preserve absent versus present zero during these value conversions.
They also normalize an already nullable actual argument.
See the platform's [nullable boxing specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#1037-unboxing-conversions).
Temporary boxes are value conversions, not the storage ABI.
Their allocation cost needs measurement; this ADR makes no allocation-free claim.

For `T=string`, both nil and `default(T)` are absent.
For `T=int32`, only nil and `default(T?)` are absent; converted `default(T)` is present zero.
For `T=int32?`, `default(T)` is already absent.
These are consequences of normalization, not method-name heuristics.

`ref`, `out`, and readonly-ref to a whole `T?` slot use `N_T&`.
Closing with `int32` produces exactly `Nullable<int32>&`.
No temporary, copy/write-back bridge, or extra receiver evaluation is permitted.
Field, array-element, captured-cell, and nested-owner paths must preserve the same location.
This requirement includes #6043's generic field assignment and later observation.

An underlying `T&` cannot be borrowed from an arbitrary `N_T&`.
In particular, `Nullable<T>.Value` does not expose a writable underlying reference.
If source requests such a location, report a diagnostic at the argument or receiver.
State that the nullable projection is a value, not an addressable underlying slot.
Do not mutate a boxed copy and claim that the original struct changed.
Whole-slot mutation remains supported; a mutating member requiring an unavailable underlying location is rejected.
Ordinary nonnullable `T` struct locations retain their existing address-based dispatch.
Byref pointees and setters remain invariant.

### 3. Allocate and freeze companion requirements

Maintain one declaration-level nullable ABI plan.
Do not add independent calculations to the binder, signature encoder, call emitter, and metadata reader.

For nonvirtual declarations, allocate companions only when a mixed parameter needs `N(T)`.
Requirements come from signatures, constraint bounds, storage, body operations, and calls or constructed types that require a companion.
Propagate requirements through source declaration dependencies to a finite fixed point.
Requirements only add members to finite parameter sets.
A call with actual `T?` uses `N_T` as its ordinary argument, and uses `N_T` again if its callee also needs the nullable form.
No infinite chain of companions is permitted.

Owner-parameter requirements belong to the owning generic type.
Method-parameter requirements belong to the generic method.
Synthesized closures, state machines, local functions, and nested types capture or propagate the applicable physical arguments.
An unused ordinary identity method retains its existing generic arity.

**Reserve companions for every mixed method parameter of source-owned virtual, abstract, and interface slots.**
Their physical arity cannot depend on a future override's body.
An override must use the established slot plan.
It cannot independently append parameters.
Companion requirements for generic source interface/delegate owners are recorded on those owners.

Freeze the plan before assigning metadata rows or emitting bodies.
Order ordinary parameters by source order, then companions by their original parameter order.
For nested CLR types, map the complete enclosing physical parameter prefix explicitly.
Do not assume logical ordinals equal physical ordinals.
Use stable declaration identities and sorted work lists, not hash iteration order.
This is one necessary finite analysis, not a new general dependency framework.
Evaluate reuse of the existing declaration-dependency machinery before adding infrastructure.

An implementation-only edit can consequently change a nonvirtual declaration's physical arity.
Treat this as a binary compatibility change, including for public methods whose visible signatures did not change.
Expose the physical plan to API compatibility inspection.
Do not advertise body-only edits as universally binary compatible.

### 4. Generic identity, containers, and runtime observation

Ordinary `T` remains CLR-reified as required by ADR-0087.
`typeof(T)` observes the original actual argument.
`typeof(T?)` observes its normalized native nullable type through the companion.

`Id[U](value U) U -> value` can receive `T?` as `U=N_T`.
It does not receive a tuple, erased `object`, or fake nullable `T`.
This holds for explicit and inferred generic calls.
The existing #3226 nullable-input cases must retain their behavior.
Replace their representation-specific emitter heuristics with the common plan only after discrimination tests exist.

Arrays of `T?` use `N_T[]`.
`List[T?]` uses `List<N_T>`.
Nested constructed types recursively use the physical argument map.
At `int32`, these are ordinary arrays and lists of `Nullable<int32>`.
Invariant containers therefore need no element copying or identity-changing adapters.
Genuine source tuples remain tuples; #6041's symbolic tuple preservation stays intact.

Reflection sees physical generic arity and the actual native constructed types.
An ABI-aware G# reader reconstructs logical arity.
Raw CLR reflection does not hide companions.
Native nullable boxing means `object` and `dynamic` observe null or the boxed underlying value.
They do not retain a separate wrapper identity.
Dynamic dispatch does not synthesize hidden generic arguments.
ABI-affected generic members require an explicit closed reflection invocation or a statically typed G# call.
No dynamic binder extension is part of this proposal.

Source-owned delegates encode their actual `Invoke` signature from the same plan.
Imported `Func` and `Action` constructions use native argument types.
Method-group conversions must compare those physical signatures.
Generic method companions are fixed when creating a closed delegate.
No covariance through nullable value types or byref parameters is introduced.
For source-declared variant owner parameters, companion variance follows the same direction only after the complete physical signature passes CLR variance validation.
If that validation fails, reject the declaration rather than inserting a cast.

### 5. Metadata recognition and import boundary

Reuse BCL `System.Reflection.AssemblyMetadataAttribute`, already emitted by `AssemblyAttributeEmitter` and read by `ImportedAssemblySemantics`.
No new runtime assembly, custom attribute type, or public `Option` type is needed.
Propose these reserved version-one records:

```text
GSharp.SourceNullableAbi = "1"
GSharp.SourceNullableMap =
  {"token":33554435,"visible":[0],"nullable":[[0,1]]}
```

The example describes a TypeDef with logical parameter zero at physical ordinal zero and its companion at physical ordinal one.
Emit one map record per affected TypeDef or MethodDef.
Tokens identify definitions in the emitting manifest module.
For nested types, `visible` covers the complete logical enclosing prefix and declared parameters.
The paired ordinals refer to the corresponding complete physical list.
Method maps describe method parameters; owner maps describe owner parameters.
Reference and implementation images generate their own token maps.
Do not copy tokens between images.
Version one supports single-module assemblies; reject marked multi-module input rather than guessing token ownership.

The reader validates version, token kind and ownership, arity, unique/disjoint ordinal mappings, required slot maps, and constraint consistency.
Every physical parameter must have exactly one ordinary or companion role.
Reject missing, duplicate, malformed, or unsupported records with a source-located import diagnostic.
Serialize records and JSON properties in deterministic order.
Do not include timestamps or MVIDs in the payload.

Within a marked declaration, companion occurrences decode to logical `Nullable(T)`.
Constructed companion arguments must equal the normalized physical nullable type of their ordinary argument.
Unmarked declarations continue through `NullabilityImportRule`, `ClrNullability` signature readers, and receiver-aware `MemberLookup` readers.
Do not bypass those readers with raw CLR type conversion.
Do not add a legacy nullability-mode path.

The marker encodes a source type operator, not a special interpretation of `ValueTuple<bool,T>`.
Actual source tuples cannot be mistaken for nullable carriers.
Ordinary `[Nullable]` annotations remain applicable to other reference positions.
They do not substitute for the ABI marker.
Companion positions reconstruct `T?` even if their physical parameter has no useful C# nullable annotation.
Extend existing metadata plans across base types, InterfaceImpl rows, generic parameters, and constraint rows using the physical ordinal map.
Preserve ADR-0220 annotations on original logical parameters and bounds.
Do not shift or copy annotation bytes onto hidden parameters without recomputing the physical signature traversal.

### 6. Interfaces, overrides, and foreign consumers

Source-to-source slot matching uses logical structural signatures, then verifies a common physical slot plan.
The source-erasure shortcut in ADR-0089 is no longer sufficient for marked signatures.
Nullable-accepting setters cannot implement nonnullable or differently represented setters through variance.
Value-return bridges may perform an existing valid nullable lift.
Byref returns cannot use such a bridge.

Unmarked CLR interface and virtual method slots retain their exact existing arity and imported annotation policy.
A source override cannot append `N_U` to a foreign generic method parameter `U`.
If its body needs structural `U?` and no physical companion is available, reject the nullable operation or dependent call.
The diagnostic must identify the foreign slot and explain that its generic ABI cannot carry a structural nullable type.
Do not reject harmless `Id[U]` forwarding that needs no companion.
An available source-owner companion may be used without changing the foreign method's arity.
Do not fabricate `N_U=U`, erase to object, specialize by runtime reflection, or insert a nil guard.

A bounded textual inventory at `91fe547` examined 3,533 tracked `.gs` files under `src` and `test`.
It found 25 single-line generic override candidates, all in tests; four candidate signature lines contained `?`.
These counts include fixture text.
They do **not** resolve source versus foreign bases, implicit interface implementations, multiline declarations, generated code, or downstream libraries.
They establish a bounded audit starting point, not zero compatibility impact.
A semantic slot inventory remains an implementation gate.

C# consumption of changed definitions exposes companions:
`Missing<int, int?>()` and `Box<int, int?>` have native nullable result and field types.
C# does not infer a result-only hidden argument.
Reference-type annotation intent is documented by the G# map, not enforced by the CLR.
No convenience façade generation is proposed.

The CLR cannot express the relationship `N_T=N(T)` as a generic constraint.
G# validates it statically for source calls and marked imports.
Source-emitted executable bodies must validate otherwise supplied pairs before relying on them.
Use BCL type identity: for nonnullable value `T`, require `Nullable.GetUnderlyingType(typeof(N_T)) == typeof(T)`; otherwise require `typeof(N_T) == typeof(T)`.
Fail invalid pairs with `InvalidOperationException` and identify the malformed construction.
Do not use `MakeGenericType` to discover the expected pair.
Share the check within each constructed owner where possible; generic methods need their own check.
Do not rely on a before-field-init initializer running before every instance method.
The placement and cost of these checks require prototype verification.

Raw public field access and foreign interface implementations cannot enforce this relationship by themselves.
Such foreign consumers must supply valid pairs, just as raw reflection must obey the documented ABI.
The proposal does not promise source semantics for malformed pairs constructed through reflection, uninitialized-object APIs, unsafe code, or arbitrary foreign implementations.
CLR type safety must still hold.
This unenforceable relational constraint is an explicit interop tradeoff requiring approval, not a hidden guarantee.

### 7. Compatibility, release, and N-1 boundary

Use one new writer at a maintainer-approved breaking ABI boundary.
Do not ship an opt-in source mode whose assemblies silently mix two meanings of `T?`.
The marker versions the representation; it does not authorize an unsound raw-T fallback.
No release number or SDK adoption is selected here.

Existing raw-T binaries remain readable as ordinary CLR imports.
Their lost source presence contract cannot be reconstructed from `[Nullable(2)]`.
Rebuild affected producers and their dependent cohort together.
Old consumers cannot transparently bind a member whose physical generic arity changed.
Publish appropriate package and assembly compatibility changes.
Do not claim drop-in binary compatibility from unchanged source spelling.

The compiler implementation must itself compile with published Gsharp.NET.Sdk 0.5.698.
Use established G# collections, symbols, and IL encoding features.
Do not use the proposed structural behavior in host implementation source.
Runtime-library declarations built by the old pin can remain legacy imports during initial compiler construction.
Audit target-reference lookups for affected runtime types and logical versus physical arity.
Do not resolve target ABI identities through host runtime types.

The future standard Release graph and stage-2/stage-3 fixpoint must pass without pin changes or source exclusions.
Only a subsequent published release and separately approved adoption can enable source that requires the new ABI.
Held translator work stays held.
The C# annotation-to-G# structural translation boundary needs its own audit; this ADR does not authorize translator changes.

### 8. Affected components and approval-gated execution

The implementation must cover this complete representation path:

| Component | Required responsibility |
| --- | --- |
| Nullable symbols and canonical queries | Keep logical normalization separate from the single physical ABI plan |
| Declaration binding and dependencies | Collect, propagate, freeze, and diagnose companion requirements |
| Substitution and overload resolution | Preserve logical arguments; derive physical arguments only from the frozen plan |
| Owner/member lookup and generic inference | Apply owner and method maps consistently, including inherited slots |
| Signature encoder and token resolver | Encode TypeSpec, MethodSpec, fields, locals, returns, and byrefs with physical ordinals |
| Definition, delegate, and interface emission | Emit matching generic parameters, slots, constraints, bridges, and variance |
| Body conversion and expression emission | Preserve absence, defaults, boxing, checked unwraps, and native addressability |
| Storage and synthesized code | Use one type for fields, arrays, captures, state machines, and every read/write path |
| Metadata writer and reader | Emit deterministic maps; validate and reconstruct logical source signatures |
| CLR nullability import | Preserve ADR-0193 policy for unmarked positions |
| Runtime/target type lookup and tooling | Handle physical arity without losing logical display and source API identity |
| Public driver, API compatibility, and bootstrap tests | Verify representation rather than only successful compilation |

After approval, implement bounded phases:

1. Establish failing real-driver witnesses for both return #6040 and storage #6043.
   Include absence and present zero before modifying the draft adapter.
   Inventory resolved foreign generic slots and affected public ABI definitions.
2. Implement the canonical plan, metadata roundtrip, and native value/storage lowering together.
   Remove the unsound adapter only as its complete replacement becomes testable.
   Keep unsupported paths diagnostic until their location or slot invariants can be met.
3. Connect source interfaces/delegates, inherited owners, byrefs, and synthesized storage.
   Audit old nullable-input lifting through the same plan.
   Run focused suites, then the released-pin graph, full CI, and fixpoint.
4. Propose the explicit breaking release and rebuild/adoption sequence separately.
   No implementation success grants release or pin-change approval.

The smallest useful public-driver acceptance groups are:

- **Presence:** one producer choosing nil or `default(T)`, `default(T?)`, direct and `Id`-forwarded returns.
  Cover `int32`, `string`, already nullable `int32?`, open forwarding, and class/struct/notnull constraints.
  Assert exact stdout bytes and strict unsuppressed ILVerify success.
- **Storage and identity:** #6043 write/read, a shared whole-slot ref/out alias, readonly-ref observation, and two independent mutable struct copies.
  Assert mutation visibility, single evaluation counters, and no copy/write-back.
  Include rejected underlying-value borrow and foreign-slot cases with diagnostic locations.
- **Metadata and generic identity:** a separately compiled marked producer and G# consumer, an explicit Roslyn consumer supplying valid pairs, and an invalid-pair failure.
  Check `typeof(T)`, `typeof(T?)`, normalized repeated nullable application, one invariant container, and delegate/interface dispatch.
  Keep genuine tuples and imported `[Nullable(2)]T` controls unchanged.
- **Build invariants:** released 0.5.698 host build, existing generic/nullability/emitter suites, #6041 controls, deterministic repeated images, and the standard fixpoint.

Use existing public-driver/shared verification helpers.
Each new behavioral test must be RED without its correction and GREEN with it, per ADR-0154.
Invalid published IL execution does not supply an expected result.
Explicit native C# fixtures must use Roslyn.
No suppressed ILVerify category, weakened assertion, or finite invalid-IL exception is acceptable.

## Consequences

The recommendation preserves native type identity, nullable idempotence, whole-slot aliasing, and ordinary CLR reification.
It fixes the original accepted program without replacing `default(T)` with `default(T?)`.
It handles return and field representation together.
It requires no new runtime carrier dependency.

Costs include additional generic arguments, new metadata maps, possible value-conversion boxing, and changed reflection-visible arity.
Foreign generic slots can require new diagnostics.
Public ABI plans can depend on nonvirtual bodies.
Foreign languages must supply companion arguments explicitly.
Relational pair validity is not a CLR generic constraint.
These are substantial compatibility costs, not implementation details to conceal.

The following remain unproved until an approved prototype:

- Verification and runtime behavior of generic `box T; unbox.any N_T` on every supported CLR target.
- Complete companion propagation through recursive declarations, state machines, nested owners, and metadata-only reference images.
- Variance and source-slot bridge correctness after physical expansion.
- Runtime-check placement, allocation cost, AOT/trimming behavior, and diagnostic coverage of foreign-slot uses.
- Actual downstream ABI impact and the resolved repository compatibility inventory.
- N-1 construction and standard fixpoint with unchanged pinned dependencies.

Failure of these gates requires revising the proposal, not silently replacing it with object erasure or tagged tuples.
The maintainer must approve **this companion ABI, its documented interop limits, and its breaking rebuild strategy** before product implementation.
Draft #6044 remains blocked until then.
This Proposed ADR carries no implemented release-note claim.

## Alternatives considered

| Alternative | Reason not recommended |
| --- | --- |
| Keep raw `T`; always wrap closed results | Cannot distinguish nil from present zero. The draft's nil regression demonstrates the loss. |
| Change source unconstrained `T?` to C# annotations | Would reject or change accepted structural nil/default behavior. This is a different language decision. |
| Diagnose every unsupported closed call | Sound containment, but does not successfully compile the original valid program. |
| Rewrite ordinary `T` to `Nullable<T>` at calls | Changes `default(T)`, `typeof(T)`, and ordinary generic identity. Existing input-lifting cases are not a general ABI. |
| Store open nullable as boxed `object` | Represents absence but does not preserve invariant container identity or native whole-slot byrefs. Shared boxes can corrupt mutable-value copy semantics. |
| Private BCL `ValueTuple<bool,T>` carrier | Preserves a local tag and value copy. However, `Tuple<bool,Nullable<int>>` is not normalized `Nullable<int>`, and genuine `(bool,T)` has the same CLR type after generic/object escape. Position markers cannot restore per-value provenance there. Containers and byrefs still differ. |
| New nominal nullable/Option carrier | Avoids tuple collision but changes CLR identity, boxing, idempotence, containers, and public consumption. ADR-0084's public Option remains a non-goal. |
| Existing `OptionalValue` or channel `ReceiveResult<T>` | Compiler constant bookkeeping and domain-specific delivery results are not a nullable type family. Channel delivery can distinguish a delivered null, unlike idempotent nullable. |
| Uniform companions on every generic declaration | Simpler allocation, but changes harmless identity methods and needlessly blocks foreign-slot forwarding. Reserve uniformly only where extensible source slots require stable arity. |
| Dual ABI writers selected by a source flag | Creates two structural contracts with the same spelling and spreads compatibility choices through the compiler. Prefer one explicitly versioned breaking boundary. |
