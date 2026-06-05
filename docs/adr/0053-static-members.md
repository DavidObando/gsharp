# ADR-0053: Static members on user types — `shared` block

- **Status**: Accepted
- **Date**: 2026-05-29
- **Phase**: Phase 10 — CLR round-trip completeness
- **Related**: Issue #196; ADR-0003 (OO surface); ADR-0051 (properties); ADR-0052 (events); Kotlin companion objects

## Context

GSharp can *consume* static members on imported CLR types via `ImportedClassSymbol` (e.g., `Guid.NewGuid()`, `Console.WriteLine(…)`, `Int32.MaxValue`). However, user-defined types (`struct`, `class`) cannot *declare* static members. This prevents C# projects from referencing GSharp-authored libraries and calling static factory methods, constants, or shared state — breaking CLR round-trip symmetry.

Issue #196 asks to consider support for CLR static types and members, keeping an eye on how Kotlin operates.

### Kotlin model

Kotlin uses `companion object` to host static-like members on a class. On the JVM, companions compile to a nested `Companion` class with a singleton instance stored in a static field. However, adding `@JvmStatic` causes the Kotlin compiler to also emit a real static method forwarder on the enclosing class — enabling natural Java interop.

### Design goals

1. **CLR round-trip**: static members declared in GSharp must emit as standard CLR `static` FieldDef/MethodDef/PropertyDef rows on the enclosing TypeDef so C#/F#/VB can consume them with zero friction.
2. **Concise grouped syntax**: use a single `shared { … }` block as the declaration site — inspired by Kotlin's companion concept but more concise, consistent with GSharp's preference for brevity.
3. **No hidden nested types**: unlike Kotlin/JVM, no `Companion` nested class is emitted. The `shared` block is purely syntactic grouping — members lower directly to static CLR members.
4. **Uniform access**: inside the shared body, other static members of the same type are accessible without qualification. Instance members are not accessible (no `this`).

## Decision

### 1. Grammar

```
shared_block          = "shared" "{" shared_member* "}"
shared_member         = field_declaration
                      | function_declaration
                      | property_declaration
                      | event_declaration
                      | const_declaration
```

The `shared` keyword is contextual — recognized only inside a type body immediately preceding `{`. Outside type bodies, `shared` remains a valid identifier.

A type may contain at most one `shared` block. The parser reports an error on duplicates.

### 2. Placement

The `shared` block appears inside `struct`, `class`, or `sealed class` bodies:

```gs
type Counter class {
    value int

    shared {
        var instanceCount int = 0

        func create() Counter {
            instanceCount = instanceCount + 1
            return Counter { value: instanceCount }
        }
    }
}
```

### 3. Accessibility

Members inside `shared` inherit the same accessibility modifier rules as regular type members (`public` default, `internal`, `private`). The enclosing `shared` block itself has no accessibility modifier; all its members are individually annotated.

### 4. Member kinds

| Kind | Static emission | Notes |
|------|----------------|-------|
| `var` / `let` field | `static` FieldDef | Mutable or immutable static field |
| `const` | `static literal` FieldDef | Compile-time constant |
| `func` | `static` MethodDef | Static method — no receiver parameter |
| `prop` | `static` PropertyDef + accessors | Static property (ADR-0051 parallel) |
| `event` | `static` EventDef + accessors | Static event (ADR-0052 parallel) |

### 5. Binding rules

- Inside a shared body, `this` is not available. Attempting to reference `this` or instance members produces a diagnostic.
- Other static members of the same type are accessible by simple name (no `TypeName.` prefix required).
- Static members are accessed from outside via `TypeName.member` — reusing the existing `ImportedClassSymbol`-style accessor resolution path extended to user-defined types.
- Bare static-member access (no `TypeName.` prefix) is allowed from **both** shared and instance method bodies of the enclosing type. Lookup is own-type only — inherited static members must be qualified with `Base.X` (symmetric with the qualified-access paths, which also do not walk the inheritance chain for statics today). If an instance member or parameter shadows a same-named static member, the instance member / parameter wins.
- Compound assignment (`+=` / `-=`) on `TypeName.StaticField` and `TypeName.StaticProp` is supported wherever simple assignment is. For static properties, compound assignment requires both a getter and a setter; otherwise the binder reports `GS0127` (cannot assign) and the expression is rejected.

### 6. Type-level access from GSharp

User-defined types already register in the scope. The binder will extend `BindAccessorExpression` to recognize a user-defined `StructSymbol` on the left side of `.` and look up static members (shared fields/methods/properties) — mirroring the `ImportedClassSymbol` path but for user types.

### 7. Static initializers

Static field initializers (`var count int = 0`) emit into a `.cctor` (class constructor / type initializer). The emitter generates a `beforefieldinit` type with a single `.cctor` that runs all static field initializers in declaration order.

### 8. Static-only types (future extension)

A future follow-up may introduce `type Utils object { … }` syntax for declaring top-level static-only utility types. This parallels Kotlin's `object` declaration. Deferred to a separate ADR; not part of this proposal.

## Implementation plan

### Phase A: Syntax

1. Add contextual keyword `shared` to `SyntaxKind` (e.g., `SharedKeyword`).
2. Create `SharedBlockSyntax` node containing field, function, property, and event declarations.
3. Extend `StructDeclarationSyntax` to hold an optional `SharedBlockSyntax`.
4. Extend the parser to recognize `shared { … }` inside type bodies.

### Phase B: Symbols

1. Add `StaticFields`, `StaticMethods`, `StaticProperties`, `StaticEvents` collections to `StructSymbol` (or a unified `SharedMembers` container).
2. Mark `FieldSymbol` / `FunctionSymbol` / `PropertySymbol` / `EventSymbol` with an `IsStatic` flag.
3. Add `SetStaticMembers(…)` setter on `StructSymbol`.

### Phase C: Binding

1. In `BindStructDeclaration`, detect the `SharedBlockSyntax` and bind its members as static.
2. Extend `BindAccessorExpression` to resolve `UserType.StaticMember` — when the left-side name matches a user-defined type in scope, look up static members before falling through to error.
3. Inside shared method bodies, push a scope that disallows `this` and exposes sibling static members by simple name.
4. Emit a diagnostic (`GS0XXX`) for `this` references and instance member access inside shared bodies.

### Phase D: Emit

1. In `EmitStructTypeDef`, emit static FieldDefs with `FieldAttributes.Static`.
2. Emit static MethodDefs (shared `func` declarations) with `MethodAttributes.Static`.
3. Emit `.cctor` (static constructor) for types that have static field initializers.
4. Extend property/event emission (ADR-0051/0052 paths) to handle the static case (`MethodAttributes.Static` on accessors).

### Phase E: Tests

1. Parser tests: `shared` block parses, duplicate rejected.
2. Binder tests: static members resolve via `Type.member`; `this` is rejected; diagnostics fire correctly.
3. Emit tests: round-trip validation — emit GSharp assembly, load via reflection, verify static members are callable from C#-style reflection invocations.
4. End-to-end tests: GSharp program declares a type with a shared block, calls static members, produces correct output.

## Consequences

- User types gain full CLR static member support, enabling GSharp libraries to be consumed from C# without wrapper code.
- The `shared` block syntax provides a clear visual grouping for static members — avoiding the C# antipattern of interspersing static and instance members — while being concise (single keyword).
- No ABI impact on existing code: shared block support is additive.
- Future `object` declarations (singleton/utility types) can reuse the same infrastructure with minimal additional work.

## Alternatives considered

### A1: `static` modifier on individual members

```gs
type Counter class {
    static var count int = 0
    static func create() Counter { … }
}
```

Pro: minimal syntax, familiar to C#/Java developers. Con: loses grouping; interleaving static and instance members reduces readability. Also, introducing a `static` keyword would shadow the existing import path for `System.Reflection.BindingFlags.Static` and similar identifiers, creating ambiguity.

**Verdict**: rejected for v1 in favor of `shared` grouping. If community demand arises, a `static` modifier sugar could desugar to shared placement in a future ADR.

### A2: Nested `Companion` class (Kotlin/JVM style)

Emit a nested `TypeName.Companion` class with instance methods and a singleton field on the parent. Add `[JvmStatic]`-equivalent forwarders.

Pro: matches Kotlin/JVM. Con: adds hidden types to the assembly metadata; C# consumers see both the forwarder and the nested class; complicates reflection-based tooling.

**Verdict**: rejected. Direct static emission is cleaner for CLR interop.

### A3: Top-level `object` only (no companion)

Only support `type Utils object { … }` for static-only types; no static members on types that also have instances.

Pro: simple. Con: overly restrictive — common pattern (factory methods, shared counters, caches) require instance + static coexistence.

**Verdict**: deferred as a future complement, not a replacement.

### A4: `companion object { … }` (Kotlin-verbatim)

```gs
type Counter class {
    companion object {
        var count int = 0
    }
}
```

Pro: identical to Kotlin, immediately recognizable to Kotlin developers. Con: two keywords for a single concept is verbose; `object` conflicts with a potential future singleton `type X object { … }` syntax. GSharp already diverges from Kotlin in other areas (e.g., `func` vs `fun`, `struct` vs `data class`), so verbatim Kotlin syntax is not a design goal.

**Verdict**: rejected in favor of the single-keyword `shared`.
