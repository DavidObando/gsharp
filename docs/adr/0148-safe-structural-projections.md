# ADR-0148: Safe structural projections and object-spread mapping

- **Status**: Accepted
- **Date**: 2026-07-15
- **Phase**: Phase 3.B (OO surface) follow-on
- **Related**: ADR-0051 (properties and auto-properties), ADR-0100 (target-typed `default`), ADR-0112 (unified member resolution), ADR-0117 (object and collection initializers), ADR-0146 (anonymous-object literals)
- **Implementation**: `StructuralProjectionPlanner` and projection lowering in `ConversionClassifier`; object-spread parsing/binding in `Parser` and `ExpressionBinder.Literals`

## Context

G# supports named class and struct literals, anonymous `object { ... }` and
`data object { ... }` values, ordinary implicit conversions, and target-typed
function arguments. It does not yet provide a safe way to project one object
shape into another unrelated concrete type.

This leaves routine application boundaries verbose. Domain models, persistence
entities, transport DTOs, view models, and anonymous query results often carry
the same public data under distinct nominal types. Developers must currently
copy each member manually or introduce a mapping library and its runtime
configuration.

The language can remove that boilerplate because both shapes are known at
compile time. However, structural projection must not be implemented as a raw
copy of the target's storage. Such a copy could bypass constructors, setters,
visibility, readonly state, and other invariants. Reusing a source expression
for every projected member could also evaluate calls or other side effects more
than once.

This ADR distinguishes a **structural projection** from a cast or reference
conversion:

- A cast or nominal conversion preserves or adapts the existing value.
- A structural projection constructs a new target value from readable source
  members.
- Interface adaptation forwards behavior and identity rather than constructing
  a concrete value; it is a separate feature.

Both anonymous synthesized source types and explicitly declared source types
participate. Projection is entirely compile-time and does not use runtime
reflection or mapping profiles.

## Decision

### A. Strict implicit structural projection

An expression of source type `S` is implicitly projectable to an unrelated
concrete target type `T` when the compiler can build one complete, unambiguous,
safe projection plan.

```gsharp
data class PersonDto(Name string, Age int32)

let dto PersonDto = source
send(source) // `send` accepts PersonDto
```

The same rule applies when `source` has an anonymous synthesized type:

```gsharp
data class PersonDto(Name string, Age int32)

let dto PersonDto = object {
    let Name = "Ada"
    let Age = 37
}

let dataDto PersonDto = data object {
    let Name = "Grace"
    let Age = 40
}
```

It also applies to explicitly declared source classes and structs:

```gsharp
class PersonEntity {
    var Name string
    var Age int32
    var PersistenceVersion int64
}

data class PersonDto(Name string, Age int32)

let entity = PersonEntity{
    Name: "Ada",
    Age: 37,
    PersistenceVersion: 12
}

// The extra PersistenceVersion source member is ignored.
let dto PersonDto = entity
```

Implicit projection is **strict on the destination** and permits width
subtyping on the source:

- Every required target construction slot must be supplied.
- Every automatically writable target member in the selected construction path
  must have a compatible source member.
- Extra source members are ignored.
- A missing, ambiguous, inaccessible, or incompatibly typed member makes the
  implicit projection unavailable and produces a targeted diagnostic when the
  conversion is required.

This strictness prevents an implicit conversion from silently leaving visible
destination state at a default value.

### B. Explicit object-spread projection

A named target literal may contain one object-spread source, written
`...expression`, followed by explicit member initializers:

```gsharp
let dto = PersonDto{
    ...entity,
    Name: entity.DisplayName,
    Age: int32(entity.Years)
}
```

The spread must be the first entry and may appear at most once. Explicit
initializers win over same-named spread members. They provide ordinary G#
expressions for renaming, flattening, calculation, explicit conversion, nested
projection, or intentional defaulting:

```gsharp
data class AddressDto(City string)
data class CustomerDto(Name string, Address AddressDto, LoyaltyPoints int32)

let dto = CustomerDto{
    ...customer,
    Name: customer.Profile.DisplayName,
    Address: AddressDto{ ...customer.PostalAddress },
    LoyaltyPoints: default
}
```

Unlike implicit projection, explicit spread may be partial for writable members:
unmatched optional fields and settable properties retain the target type's
ordinary constructor, initializer, or default value. Required constructor
inputs must still be supplied by the spread or by an explicit initializer.

No separate ignore, rename, resolver, converter, reverse-map, or profile syntax
is introduced. Explicit target initializers already express those operations.

### C. Automatic mapping surface

Automatic discovery considers only members that form a public data and
construction contract.

Eligible source members are:

- public readable instance fields; and
- public readable, non-indexed instance properties.

Eligible target slots are:

- parameters of the selected public construction path;
- public mutable instance fields; and
- public non-indexed instance properties with an `init` or `set` accessor.

The following never participate automatically:

- private, protected, or internal members;
- compiler-generated backing fields;
- static members;
- constants, readonly fields, events, indexers, or methods;
- get-only target properties that are not supplied through a constructor; and
- members available only because the projection occurs inside their declaring
  type.

Automatic projection therefore never gains privilege from the lexical binding
context. Explicit member expressions continue to follow ordinary G#
accessibility rules, allowing a type's own code to access its private state
deliberately without making that state discoverable by the mapper.

For example, the private field is neither required nor writable by projection:

```gsharp
class Account {
    var Name string
    private var PasswordHash string
}

data class AccountView(Name string)

let view AccountView = account
```

A constructor may initialize private target state internally. That is safe
because the constructor remains the type's declared invariant boundary.

### D. Construction paths

A projection constructs the target through its normal public surface:

1. A declared primary/data constructor is used when its required parameters can
   be satisfied unambiguously.
2. Otherwise, a public parameterless constructor or the normal zero-value
   construction for a value type is used, followed by ordinary public field and
   property initialization.
3. An abstract target or a type with no safe public construction path is not
   structurally projectable.

The compiler must not initialize non-public fields directly, invoke private
setters, or manufacture a value that ordinary source code could not construct
through the selected public path.

Source and target member names match exactly and case-sensitively. Member values
must have an existing implicit conversion to their target slot. A caller that
wants narrowing or another explicit conversion writes it in an explicit target
initializer.

Structural projection is not recursively applied to member values in the first
implementation. Nested objects and collections use explicit projection or
ordinary sequence operations. Recursive projection can be considered later
with cycle detection and separate overload-resolution analysis.

### E. Evaluation and side effects

Projection has an exact single-evaluation contract:

- The source expression is evaluated exactly once and captured in a synthetic
  local before any projected member is read.
- Every selected source field or property getter is evaluated at most once.
- Anonymous-object member initializer expressions are evaluated exactly once in
  lexical order, including initializers for extra members ignored by width
  subtyping.
- Explicit target initializer expressions are evaluated exactly once in lexical
  order.
- Target constructors, setters, and public field writes retain their ordinary
  language semantics.

Conceptually, a named-source projection lowers as follows:

```gsharp
let sourceTemp = sourceExpression
let targetTemp = Target(
    Name: sourceTemp.Name,
    Age: sourceTemp.Age
)
targetTemp
```

The actual lowering may use existing bound block, synthetic-local, constructor,
field-assignment, and property-assignment nodes. It must not duplicate the
original source expression in generated member-access nodes.

### F. Conversion and overload precedence

Structural projection is considered only after identity, nominal inheritance,
built-in representation-preserving conversions, and applicable user-defined
conversions.

For overload resolution it is weaker than those conversions. If two overloads
are applicable only through different structural projections and neither has a
better non-structural conversion, the call is ambiguous. The compiler does not
rank candidates by counting matching members or by guessing which shape is
closer.

Implicit projection is unavailable for `ref`, `out`, or `in` arguments because
it creates a distinct target value rather than an alias to the source storage.

### G. Compiler architecture

One context-aware structural-projection planner is the source of truth for:

- conversion applicability;
- overload candidate validation;
- detailed missing/ambiguous/incompatible-member diagnostics; and
- bound-tree lowering.

The planner operates on source and target member models plus the current
projection mode (strict implicit or explicit spread). It must not be represented
only by a type-pair conversion singleton: construction choice, accessibility,
explicit overrides, and evaluation capture are part of the plan.

User-defined member lookup reuses `TypeMemberModel`; imported CLR lookup reuses
the existing public-member helpers behind `MemberLookup`. Target writes route
through the same accessibility and writability checks as ordinary named target
literals and object initializers.

Lowering reuses existing constructors, `BoundBlockExpression`, synthetic
locals, and normal field/property assignment nodes. No projection-specific
runtime library or emitter path is required.

### H. Interface targets are separate

This ADR does not structurally project to an interface. A concrete target is
constructed; an interface has no construction shape. Making an unrelated value
act as an interface requires a forwarding adapter and decisions about identity,
mutation, equality, method dispatch, and allocation.

Anonymous objects continue to implement interfaces explicitly:

```gsharp
let listener MouseListener = object : MouseListener {
    func onClick() { Console.WriteLine("clicked") }
}
```

Structural interface adapters may be proposed separately with explicit syntax.

## Consequences

Positive:

- Anonymous object literals and explicitly typed objects share one safe,
  compile-time projection model.
- Common DTO and view-model mapping becomes a normal assignment or argument
  conversion.
- Object spread provides local, visible control without runtime profiles or
  reflection.
- Constructors and public setters retain responsibility for target invariants.
- Private storage cannot be discovered or overwritten automatically.
- Single-evaluation rules make side effects deterministic.
- Existing binder and lowering machinery can implement the feature without a
  mapping runtime or bespoke emitter.

Negative:

- Implicit projection can allocate and invoke public getters, constructors, and
  setters; diagnostics and documentation must make the value-producing nature
  clear.
- Exact-name matching intentionally does not provide convention-based
  flattening or case-insensitive matching.
- Strict destination coverage may reject mappings that a permissive runtime
  mapper would accept; explicit spread is the escape hatch.
- Interface adaptation, recursive mapping, and collection mapping remain
  explicit or deferred.

## Alternatives considered

### Raw field-to-field reconstruction

Rejected. Enumerating target storage bypasses visibility, constructors, setters,
readonly state, and invariants. A projection must use only the target's normal
construction surface.

### Runtime AutoMapper-style profiles

Rejected as the language primitive. Runtime reflection and global mapping
configuration add startup work, trimming/AOT concerns, delayed failures, and
configuration that is distant from the conversion site. Libraries remain free
to provide that model when dynamic mapping is genuinely required.

### Anonymous-object sources only

Rejected. Anonymous query results are important, but explicitly declared
entities, DTOs, structs, and imported CLR objects have the same shape-mapping
need. The safety rules are based on public contracts, not whether the source
type has a name.

### Implicit partial mapping

Rejected. Silently defaulting unmatched visible target state makes ordinary
assignment too permissive. Strict implicit projection plus explicit partial
spread keeps the zero-ceremony path safe and the controlled path concise.

### Implicit structural interface conformance

Rejected from this ADR. Forwarding behavior is an adapter problem rather than a
concrete-value projection and requires separate identity and mutation semantics.
