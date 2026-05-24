# ADR-0024: Methods with receivers vs. extension functions canonical style

- **Status**: Accepted
- **Date**: 2026-05-24
- **Phase**: Phase 6
- **Related**: ADR-0019 (extension function declaration syntax); ADR-0017 (method virtuality); execution plan §6.4

## Context

ADR-0019 chose the Go-style receiver declaration form for both extension functions and methods with receivers:

```gsharp
func (p Point) Distance() int { ... }
```

That syntax intentionally does not encode the declaration kind. The binder decides from the receiver type's declaring package:

- if the receiver type is declared in the same package as the function, the declaration is a method with receiver;
- otherwise it is an extension function.

Phase 6.4 ships same-package methods with receivers, so the language now needs canonical user-code guidance for the overlap.

## Decision

Use the same syntactic form for both features and distinguish the kind by receiver ownership.

Prefer a **method with receiver** when the package owns the receiver type. It binds onto the receiver's `StructSymbol.Methods`, dispatches through the same path as in-body class methods, participates in interface conformance, and is the symbol IDE tooling should present as a method of `T`.

Use an **extension function** only when the package does not own the receiver type: imported CLR types, BCL primitives, and types declared by another GSharp package.

A reader who sees `func (p Point) Distance() ...` should interpret it as a method on `Point` when the current package declares `Point`, and as an extension otherwise. IDE decoration for the two cases is desirable but out of scope for this ADR.

Visibility follows the declaration site. A top-level method with receiver uses the `public` / `internal` / `private` modifier on the `func` declaration, defaulting to `public` per ADR-0014. In-body methods retain their existing defaults.

Emit intent: receiver methods emit beside in-body methods on the receiver CLR TypeDef. The interpreter already binds them onto `StructSymbol.Methods`, so dispatch is uniform today.

## Consequences

Positive:

- One declaration shape covers every receiver-based function.
- User-owned behavior is modeled as real methods, so interface conformance and method lookup do not need a parallel extension path.
- Extension functions remain available for the "I do not own this type" case.

Negative:

- The declaration line alone does not reveal the kind; readers need package context.
- The binder must diagnose same-package non-aggregate receivers instead of treating them as extensions.

Neutral:

- Same-package top-level receiver methods are appended to the receiver symbol after class/struct declaration binding. This keeps in-body method binding unchanged and lets later declarations merge into the method set.
- Pointer receivers remain deferred from ADR-0019.

## Open follow-ups

- Pointer receivers require an addressability and mutation model; deferred.
- Top-level receiver methods do not override base methods for now. `override` remains an in-body form so the modifier stays co-located with the class declaration and inheritance surface.
- Generic receiver methods on generic user-defined types are deferred until generic type clauses and receiver type-parameter scope are fully specified.
