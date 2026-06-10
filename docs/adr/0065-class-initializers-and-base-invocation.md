# ADR-0065: Class multiple initializers and base-class invocation

- **Status**: Accepted
- **Date**: 2026-06-10
- **Phase**: Phase 9 — language depth / class initialization
- **Related**: ADR-0003 (OO surface), ADR-0017 (method virtuality / `open`), ADR-0063 (method overloading — §9 multiple `init` overloads), issue [#646](https://github.com/DavidObando/gsharp/issues/646), issue [#656](https://github.com/DavidObando/gsharp/issues/656)

## Context

G# classes today support two constructor forms (ADR-0003):

1. **Primary constructor** — `type C class(p T) { … }`: parameters declare same-named fields; implicitly chains to a parameterless base ctor (or an explicit base via `: Base(args)`).
2. **Explicit `init` constructor** — `init(params) [: base(args)] { body }`: arbitrary statement body that initialises fields manually.

ADR-0003 originally stated "a class may declare *either* form but not both, and at most one `init` constructor." ADR-0063 §9 relaxed the second restriction: multiple `init(...)` overloads are now supported for binding, overload resolution, and evaluation. However, several aspects remain unspecified:

- **Coexistence of primary ctor and explicit `init(...)` bodies.** Issue [#656](https://github.com/DavidObando/gsharp/issues/656) demonstrates that when an interface-implementing class declares a parameterless `init()` body (with no primary-ctor parameters), the emitter fails with `GS9998: Type 'X' has no emitted primary ctor`. A second shape (parameterized `init(title string, key string)` plus default-initialized fields) triggers the same diagnostic. The emitter's "primary ctor selection" heuristic has no rule for classes that use explicit `init` bodies without a primary-ctor parameter list.
- **Designated vs convenience initializers.** All current `init` bodies are structurally "designated" (they directly initialise fields and optionally chain to a base), but there is no mechanism for a secondary init to delegate **across** to another init in the same class.
- **Two-phase initialization safety.** No compiler checks currently enforce that all stored properties are initialised before `base(...)` is invoked, or that inherited members are not read before the superclass initializer completes.
- **Initializer inheritance.** There is no specification for when (if ever) a derived class automatically inherits base-class initializers.

Issue #646 requests that these gaps be filled by adopting Swift's two-phase initializer model.

## Decision

G# adopts a **Swift-inspired two-phase initializer model** for classes, adapted to the existing G# syntax and CLR emission target.

### 1. Designated initializers

A **designated initializer** is the canonical path that fully constructs a class instance. It must:

- Initialise every stored property introduced by the class (fields declared in the body that do not have a default-value expression).
- Invoke exactly one superclass designated initializer (if the class has a base class) **after** all own properties are initialised.

Syntax — an `init` member without a `convenience` modifier:

```gsharp
type Rect class {
    Width int32
    Height int32
    Area int32

    init(w int32, h int32) {
        Width = w
        Height = h
        Area = w * h
    }
}
```

A class may declare **multiple** designated initializers (overloads per ADR-0063 §9). Each overload independently satisfies the rules above.

### 2. Convenience initializers

A **convenience initializer** is a secondary entry point that must delegate to another initializer in the **same** class (designated or convenience) before performing any further work. It may not directly assign stored properties before delegating.

Syntax — the contextual modifier `convenience` precedes `init`:

```gsharp
type Rect class {
    Width int32
    Height int32
    Area int32

    init(w int32, h int32) {
        Width = w
        Height = h
        Area = w * h
    }

    convenience init(side int32) {
        init(side, side)   // delegates to designated init
    }
}
```

The delegation call uses bare `init(args)` (calling another initializer in the same class). This mirrors the existing `base(args)` spelling for superclass delegation and avoids introducing a new keyword.

### 3. Base-class invocation

A designated initializer in a derived class invokes a base-class designated initializer using the existing `: base(args)` syntax (established in ADR-0003 / issue #306):

```gsharp
type Animal open class(Name string) {
    func Speak() string { return Name }
}

type Dog class : Animal {
    Tricks int32

    init(name string, tricks int32) : base(name) {
        Tricks = tricks
    }
}
```

**Ordering rule**: the `: base(args)` clause is syntactically attached to the `init` signature (as today). Semantically, the base initializer is invoked **after** all of the current class's own introduced stored properties have been assigned in the body. This matches Swift's phase-1 completion ordering.

For classes whose base class has a parameterless designated initializer (including `object`), the `: base()` clause may be omitted; the compiler synthesises the call.

### 4. Two-phase initialization rules

Adapted from Swift's safety checks:

1. **Rule 1 — All own properties before super.** A designated initializer must ensure that every stored property introduced by its class is assigned a value before invoking the superclass initializer.
2. **Rule 2 — Super before inherited access.** A designated initializer must call the superclass initializer before reading or writing any inherited property or calling any inherited method (other than `base(args)` itself).
3. **Rule 3 — Convenience delegates first.** A convenience initializer must delegate to another initializer (`init(args)`) before accessing any property (own or inherited) or calling any method on `this`.
4. **Rule 4 — No self-use in phase 1.** Until all stored properties of the most-derived class through the entire inheritance chain are initialised (i.e. until phase 1 completes for the whole hierarchy), the instance may not be passed as an argument, returned, or used as a value.

These rules are enforced by definite-assignment flow analysis at bind time. Violations produce diagnostics (see §Consequences).

### 5. Primary-constructor compatibility

When a class declares both a primary-constructor parameter list and one or more `init(...)` bodies, the following rule applies:

> **The primary constructor is one designated initializer among others.**

Specifically:

- `type C class(a int32, b string) { … }` synthesises a designated `init(a int32, b string)` that assigns the primary-ctor parameters to their corresponding fields.
- Additional `init(...)` bodies declared in the class body are additional designated (or convenience) initializers.
- The synthesised primary-ctor init is treated identically to any user-written designated init for overload resolution, inheritance, and emission purposes.
- If a user-written `init` has the same parameter signature as the primary ctor, it is a compile-time error (duplicate overload per ADR-0063 §1).

This directly unblocks issue #656: a class with no primary-ctor parameter list (e.g. `type FakeJobService class : IJobService { … }`) that declares an explicit `init()` body **is** a class whose sole designated initializer is that explicit `init()`. The emitter selects it as the "emitted primary ctor" without requiring primary-ctor parameters.

**Emitter selection rule** (replaces the current heuristic that trips GS9998):

- If the class has a primary-ctor parameter list, the synthesised init is the emitted primary ctor.
- If the class has no primary-ctor parameter list but declares one or more explicit designated `init` bodies, the emitter selects the **first declared** designated init as the emitted primary ctor.
- All other designated and convenience inits are emitted as additional CLR `.ctor` overloads.
- A class with neither a primary-ctor parameter list nor any explicit `init` body receives a compiler-synthesised parameterless designated init (as today).

### 6. Initializer inheritance

G# adopts a restricted form of Swift's initializer inheritance rules:

- **Rule A**: If a derived class introduces **no** new designated initializers (i.e. it declares no `init` bodies and has no primary-ctor parameters beyond what it passes through to the base), it inherits all of the base class's designated initializers.
- **Rule B**: If a derived class provides overriding implementations of **all** of the base class's designated initializers (matching by parameter signature), it additionally inherits all of the base class's convenience initializers.

In all other cases, base-class initializers are not inherited and must be explicitly delegated to.

### 7. Failable initializers

**Deferred.** Swift's `init?` / `init!` failable initializer forms are not adopted in this ADR. G# will address failable construction through nullable return types on factory functions or a future `init?` proposal. This decision may be revisited in a subsequent ADR.

### 8. CLR interop

Each G# designated initializer maps to one CLR instance `.ctor` method. Each convenience initializer also maps to a CLR `.ctor` that internally delegates to another `.ctor` via `this(args)` (the standard CLR constructor-chaining pattern).

- CLR consumers see a normal set of constructor overloads; there is no metadata distinction between designated and convenience inits at the CIL level.
- The binder/emitter MUST NOT emit `GS9998` for any well-formed class. The "primary ctor selection" rule (§5) guarantees that at least one designated `.ctor` is always identifiable.
- When loading CLR metadata for imported classes, all `.ctor` overloads are treated as designated initializers (since CLR metadata does not distinguish the two kinds).

## Examples

### Example 1 — Single explicit `init()`, no primary ctor (issue #656 repro)

```gsharp
package Probe.Tests
import Probe.CSharp
import System.Collections.Generic

type FakeJobService class : IJobService {
    Active List[JobSnapshot]

    init() {
        Active = List[JobSnapshot]()
    }

    func GetSnapshot(jobId string) JobSnapshot? {
        return nil
    }
}
```

`FakeJobService` has one designated initializer (`init()`). The emitter selects it as the emitted primary ctor. No `GS9998`.

### Example 2 — Primary-constructor syntax AND a secondary `init` body

```gsharp
type LifecycleTab class(Title string, Key string) {
    Active bool = false

    convenience init(key string) {
        init(key, key)   // delegates to synthesised designated init(Title, Key)
    }
}

var t1 = LifecycleTab("Settings", "settings")
var t2 = LifecycleTab("home")   // uses convenience init
```

The primary ctor synthesises `init(Title string, Key string)` as designated. The user-declared `convenience init(key string)` delegates to it.

### Example 3 — Multiple designated initializers (no inheritance)

```gsharp
type Color class {
    R float64
    G float64
    B float64

    init(r float64, g float64, b float64) {
        R = r
        G = g
        B = b
    }

    init(gray float64) {
        R = gray
        G = gray
        B = gray
    }

    convenience init() {
        init(0.0, 0.0, 0.0)
    }
}

var red = Color(1.0, 0.0, 0.0)
var mid = Color(0.5)
var black = Color()
```

### Example 4 — Derived class with base invocation and two-phase ordering

```gsharp
type Vehicle open class {
    Wheels int32

    init(wheels int32) {
        Wheels = wheels
    }
}

type Car class : Vehicle {
    Brand string

    init(brand string, wheels int32) : base(wheels) {
        // Phase 1: assign own stored properties BEFORE base runs
        Brand = brand
        // `: base(wheels)` fires here (after own fields assigned)

        // Phase 2: inherited state is now safe to read
        let desc = Brand + " has " + Wheels.ToString() + " wheels"
        // ↑ Reading `Wheels` (inherited) is legal — we're in phase 2.
    }
}

var c = Car("Toyota", 4)
```

If the programmer tried to read `Wheels` **before** assigning `Brand`, the compiler would report a phase-1 violation (see diagnostics below).

### Example 5 — Convenience initializer delegating to designated

```gsharp
type HttpClient open class {
    BaseUrl string
    Timeout int32

    init(baseUrl string, timeout int32) {
        BaseUrl = baseUrl
        Timeout = timeout
    }

    convenience init(baseUrl string) {
        init(baseUrl, 30)   // delegates to designated init
    }

    convenience init() {
        init("http://localhost")   // delegates to convenience → designated
    }
}
```

## Consequences

### Positive

- **Unblocks #656**: classes with explicit `init()` bodies (with or without interface implementations returning nullable records) have a clear emitter path.
- **Multiple constructors are first-class**: G# can now cleanly port Swift, Kotlin, and C# patterns that rely on constructor overloading and delegation.
- **Safety**: two-phase initialization prevents use-before-init bugs that are common in C++ and Java, without requiring a heavy type-state system.
- **CLR-compatible**: the emit strategy maps directly to CLR `.ctor` overloads with `this(...)` chaining — verifiable and interoperable.

### Negative

- **Learning curve**: the designated/convenience distinction is not present in C# or Kotlin. G# documentation must explain the motivation clearly.
- **Restrictive phase-1 rules**: users accustomed to C#'s permissive constructor bodies (where `this.X` can be read immediately) will encounter new diagnostics. Mitigation: default field initializers reduce the need for complex init bodies.

### Breaking changes

- None at the source level for existing programs. The `GS9998` ICE on classes with explicit `init()` bodies becomes a successful compilation.
- The emitter's internal "primary ctor selection" heuristic changes, but emitted CIL remains ABI-compatible.

### New diagnostics

The diagnostic codes below are the live codes assigned at implementation time
(see `src/Core/CodeAnalysis/DiagnosticBag.cs`).

| Code | Description |
|---|---|
| `GS0278` | Convenience initializer body must begin with `init(args)` self-delegation. |
| `GS0279` | Convenience initializer may not declare an explicit `: base(args)` clause. |
| `GS0280` | `init(args)` self-delegation is only valid inside a class constructor body. |
| `GS0281` | Designated initializer may not delegate to a sibling `init(args)` overload; use `: base(args)` instead. |
| `GS0282` | Convenience initializer may not delegate to itself (recursive). |
| `GS0283` | No applicable `init(...)` overload on this class matches the self-delegation arguments. |
| `GS0284` | A user-declared `init(...)` overload duplicates the signature synthesized from the primary constructor. |

Future diagnostics — to be added when the deferred two-phase enforcement
work (see Implementation notes) lands:

| Placeholder | Description |
|---|---|
| `GSxxxx` | Designated initializer does not assign stored property `'P'` before invoking base initializer. |
| `GSxxxx` | Designated initializer must invoke base-class initializer before accessing inherited member `'M'`. |
| `GSxxxx` | Instance may not be used as a value until phase-1 initialization is complete. |
| `GSxxxx` | Convenience initializer may not directly assign stored properties; delegate first. |

### Migration

- Existing classes with a single `init` body: no change required; they continue to compile.
- Existing classes with multiple `init` overloads (ADR-0063 §9): no change; all are designated by default.
- New classes may opt into `convenience` where appropriate.

## Alternatives considered

### A. C# `: this(...) / : base(...)` constructor chains

C# uses `: this(args)` to delegate to another constructor in the same class and `: base(args)` for the superclass. There is no designated/convenience distinction — all constructors are peer entry points.

**Why rejected**: C#'s model provides no compiler-enforced ordering between own-field initialization and base-class invocation. The base call happens *first* in C# (before the body runs), which means fields may be uninitialized when virtual methods dispatch during the base constructor. This is a well-known source of subtle bugs. Swift's two-phase model prevents this entire category.

### B. Kotlin's single primary + `init {}` blocks + `constructor(...) : this(...)`

Kotlin allows exactly one primary constructor, zero or more `init {}` blocks that run in declaration order, and secondary `constructor` declarations that must ultimately delegate to the primary.

**Why rejected**: Kotlin's model is more restrictive than needed (only one designated constructor) and conflates initializer blocks (which run for *every* constructor) with constructor bodies. G# already supports multiple `init` overloads (ADR-0063 §9); adopting Kotlin's single-primary restriction would be a regression.

### C. Go-style "no constructors, use factory functions"

Go has no constructors. Types are always zero-initialized; factory functions (`NewFoo(...)`) provide domain initialization.

**Why rejected**: G# targets the CLR, where constructors are fundamental to the type system. Interface contracts, serialization frameworks, and dependency injection containers expect `.ctor` methods. Removing constructors would break BCL interop.

## Open questions

1. **Phase-1 enforcement strictness for field initializers.** If a field has a default-value expression (`Active bool = false`), does the designated init still need to "assign" it before calling `base`? **Resolved**: No — fields with default values are considered pre-initialised at the start of the init body. This matches the implementation's existing instance-field-initializer emission, which runs before the user-authored body.
2. **`override init` syntax.** Swift allows `override init(...)` when a subclass re-declares a base designated init. Should G# require `override` on such inits, matching the `override func` precedent (ADR-0017)? **Deferred** to a follow-up issue alongside the initializer-inheritance Rule B implementation.
3. **Interaction with `required` fields.** If G# introduces a `required` field modifier (analogous to C# 11's `required` members), how does it interact with designated-init obligations? Deferred to a future ADR.
4. **Initializer access control.** May a designated init be `private`? Swift allows this (used to prevent external subclassing). **Resolved**: Yes — all visibility modifiers (`public`/`internal`/`private`) apply to `init` exactly as they do to `func`. The existing accessibility-resolution path already covers this.

## Implementation notes

The first implementation (this PR) covers §1, §2, §5, §8, parts of §3 and §4, and the
diagnostic surface above. The following pieces are tracked as follow-up work:

- **§3 strict ordering**: the implementation emits the base call as the first
  instruction of a designated init body (matching the CLR convention) rather
  than reordering the body to delay the base call to the "after all own fields
  assigned" point. This is observationally indistinguishable for well-formed
  programs unless the base initializer calls a virtual method that depends on
  derived-class state — that scenario is covered by the deferred §4 Rule 2 and
  Rule 4 diagnostics described below.
- **§4 Rules 1, 2, 4**: full two-phase definite-assignment diagnostics
  (all-own-properties-before-super, no-inherited-access-before-super,
  no-self-as-value-during-phase-1). Rule 3 (convenience must delegate first)
  is enforced via `GS0278`.
- **§6 Rule A & Rule B initializer inheritance**: derived classes that
  declare no `init(...)` bodies do not yet inherit the base class's
  designated initializers as overload candidates of the derived type. Both
  rules will be added in a follow-up PR alongside the `override init`
  machinery noted in open question #2.

## Out of scope

The following topics are explicitly deferred to future ADRs:

- **Failable initializers** (`init?` returning a nullable instance) — deferred pending nullable-return design work.
- **Async initializers** (`async init(...)`) — deferred pending async/await surface stabilisation.
- **Struct (value-type) initializers** — value types use `data struct` synthesis or memberwise initialization; the two-phase model does not apply to types that cannot participate in inheritance.
- **Pattern matching in initializer bodies** — no special interaction defined.
- **Deinitializers / finalizers** (`deinit`) — separate lifecycle concern; not coupled to this proposal.
