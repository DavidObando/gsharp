# ADR-0197: Explicit abstract property contracts

- **Status**: Accepted (owner decision, October 5, 2026)
- **Date**: 2026-10-05
- **Related**: issues #4765, #4715 and #3501; ADR-0051 (properties);
  ADR-0017 (virtual slots); ADR-0195 (abstract class owners); ADR-0060 §14
  (by-reference property restrictions); ADR-0029 and ADR-0115 (data members
  and C# record migration).

## Context

A bodyless `open prop Value int32 { get; init; }` is an established virtual
auto-property, even in an abstract class. Inferring a storage-free contract
from that shape would change existing native programs. C# abstract properties
need a distinct representation: their accessors have no bodies or backing
fields, and concrete descendants must implement every required accessor.
The owner explicitly chose support rather than rejecting legal C# contracts.

ADR-0196 is already assigned to generated validation-source provenance on the
integration base; this decision uses the next free number without replacing
that independent decision.

## Decision

Use the existing contextual `abstract` modifier explicitly:

```gs
abstract class Base {
    public abstract prop Value int32 { get; protected set; }
}
abstract data class Record(Value int32) {
    public abstract prop Value int32 { get; init; }
}
abstract class Middle : Base {
    public abstract override prop Value int32 { get; protected set; }
}
```

- An explicit abstract property belongs to an explicitly abstract class or data
  class. It requires a nonempty, bodyless accessor list. Neither property nor
  required accessor may be private. `open abstract prop`, a body or arrow,
  a bare auto-property, and explicit-interface implementation clauses are
  invalid (`GS0620`). `abstract override` and `override abstract` are equivalent.
- `abstract` implies virtual accessors. A new contract emits `abstract virtual
  newslot specialname hidebysig`; a reabstract override reuses the base slot,
  without `newslot` or `final`. Accessor accessibility and parameter names are
  preserved. There is no method body or backing field.
- An `init` requirement emits `set_Name` with the required
  `System.Runtime.CompilerServices.IsExternalInit` return modifier.
- An abstract descendant may inherit or reabstract the contract. A descendant
  not declared abstract must implement every required accessor with an actual
  override, including when the descendant is `open`. A getter-only override
  does not discharge a required setter, and a hiding property does not
  implement a virtual slot (`GS0387`).
- Concrete overrides use the existing auto-property or computed-property
  machinery. Source override checks preserve the base accessor's visibility
  and distinguish `set` from `init`. Imported property matching uses the
  existing CLR init-only reader to enforce the same distinction, including
  reabstract overrides; a mismatch reports `GS0185` before emission.
- Existing concrete auto-properties, including `open` get/init properties in
  abstract owners, keep their storage and concrete methods. The established
  bodyless `open` getter-only contract remains supported.
- cs2gs maps Roslyn `IPropertySymbol.IsAbstract` explicitly, for ordinary
  classes and records, including partial/generic declarations and escaped
  positional names. Abstract positional declarations are not auto-properties.
  An initialized get/init override keeps its init accessor and private
  storage; a truly getter-only override retains the existing getter-only
  lowering.
- This does not extend abstract or interface by-reference properties.
  ADR-0060 §14 remains authoritative. Nullability import and query funnels,
  record equality/clone/storage semantics, and ABI acceptance policy do not
  change.

## Consequences

The native syntax is additive and unambiguous. C# abstract record properties
can migrate faithfully instead of gaining concrete accessors and storage.
Tests compare Roslyn-emitted contracts with real native gsc metadata, strict
IL verification, derived dispatch and once-only copy updates; compilation
success or IL verification alone is not the metadata oracle.
