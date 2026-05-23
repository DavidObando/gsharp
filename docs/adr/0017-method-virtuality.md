# ADR-0017: Method virtuality — sealed by default, opt-in with `open`

- **Status**: Proposed
- **Date**: 2026-05-22
- **Phase**: Phase 3 (lock before 3.B.3)
- **Related**: ADR-0003 (OO surface — data-oriented core with light OO escape hatch); ADR-0006 (visibility); execution plan §3.B.3; gaps doc §3.2

## Context

Phase 3.B.3 adds user `class` declarations with single inheritance. Three orthogonal sub-decisions follow:

1. **Are classes inheritable by default?** C# says yes (you opt out with `sealed`); Kotlin/Scala say no (you opt in with `open`).
2. **Are methods overridable by default?** C# says no (you opt in with `virtual`); Kotlin/Scala say no (you opt in with `open`); Java says yes (you opt out with `final`).
3. **Is the keyword pair `virtual` / `override` (C#) or `open` / `override` (Kotlin)?**

GSharp positioning:

- The README and ADR-0003 explicitly steer **away** from deep OO hierarchies. Classes are an "escape hatch" for BCL interop, not the default modeling tool.
- The target audience reads C# fluently; `virtual` and `override` are house words.
- ADR-0014 set the precedent that defaults should support the most common case without ceremony, with explicit opt-in for the wider/more-dangerous form.

Joshua Bloch's "design for inheritance or prohibit it" rule and the broader industry consensus (Kotlin, Scala, Swift, Rust) point at **sealed-by-default classes and non-virtual-by-default methods**. C#'s class-inheritable-by-default has been a frequent source of accidental-fragile-base-class bugs; Kotlin closed that door deliberately.

## Decision

GSharp adopts **Kotlin-style "sealed by default + `open` opt-in"**, with **`override` required** on the derived side.

- **Classes are sealed (CLR `sealed`) unless declared `open class Name { … }`.** Attempting `class B : A { … }` when `A` is not `open` is a binder error: `Class 'A' is not open; declare 'open class A' to allow subclassing.`
- **Methods are non-virtual unless declared `open func Name(…) … { … }`.** A non-`open` method on an `open` class is sealed in CIL terms (regular non-virtual instance method).
- **A subclass that re-declares an inherited method MUST use `override func Name(…) …`.** Overriding a non-`open` method is a binder error. Overriding an `open` method without the `override` keyword is a binder error: `Method 'A.Name' is overridable; add 'override' to redefine it.`
- **`override` methods are themselves sealed for further override unless re-declared `open override func Name(…) …`.** Mirrors Kotlin; prevents accidental three-level virtual chains.
- **The CLR identity is direct**: `open class` → `class` (no `sealed` flag); plain `class` → CLR `sealed class`. `open func` → CLR `virtual` method; `override func` → CLR `virtual final` (sealed override); `open override func` → CLR `virtual` method (overridable downstream).
- **`data struct` synthesized members** (ADR-0029) emit as `sealed override` on the struct's `Equals`/`GetHashCode`/`ToString`. Structs are value types and cannot be subclassed; this just records that the override slot is final.

Worked example:

```gsharp
package Shapes

open class Shape {
    open func Area() float64 { return 0.0 }
    func Tag() string { return "shape" }   // not open — final
}

class Circle : Shape {
    let radius float64

    override func Area() float64 {
        return 3.14159 * radius * radius
    }
}

// class Sphere : Circle { … }            // ERROR: 'Circle' is not open
// open override func Area() … on Circle  // would allow Sphere : Circle to override again
```

## Consequences

Positive:

- Aligns with ADR-0003's "OO is an escape hatch" framing: the easy path produces final classes that can't be accidentally subclassed.
- Mirrors Kotlin, Scala, and Swift — three peers that learned from C# and Java's experience with default-inheritable types.
- The `open` keyword pulls double duty for both classes and methods, halving the keyword footprint vs `virtual` + `open` and matching the rest of the language's "one concept, one keyword" style.
- The CLR-level mapping is mechanical, leaves verifiable code, and stays compatible with C# consumers (they see a normal sealed class with non-virtual methods, or an open class with virtual methods — both idiomatic).

Negative:

- C# users expecting `virtual` will need a one-line README footnote. Mitigation: the keyword `open` is one of Kotlin's most-cited educational moments; we get the same teaching opportunity.
- "Sealed by default" makes some BCL patterns awkward (e.g., a user wanting to build a parallel `MyStream` hierarchy must remember to mark each base `open`). Acceptable: this is exactly the friction the ADR wants for the OO escape hatch.

Neutral:

- Frozen until Phase 4 introduces generic classes and Phase 5 introduces async; both will inherit this model unchanged.

## Alternatives considered

- **C#-style `virtual` + opt-in inheritable classes (no `sealed` by default)**: rejected — the default is "deep inheritance permitted," which contradicts ADR-0003.
- **C#-style `virtual` keyword on methods, plus Kotlin-style `open class`**: rejected — two keywords for one concept (overridability). The current decision picks `open` for both.
- **Java-style "everything virtual unless `final`"**: rejected outright — the README and ADR-0003 specifically push back on this culture.
- **No virtuality at all (Go-style — composition + interface dispatch only)**: rejected because BCL interop sometimes requires `override` (e.g., deriving from `Exception` and overriding `ToString`).
