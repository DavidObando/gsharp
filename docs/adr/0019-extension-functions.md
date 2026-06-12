# ADR-0019: Extension function declaration syntax — `func (Receiver) Name(…) …`

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 3 (lock before 3.B.6); revisited by ADR-0024 in Phase 6
- **Related**: ADR-0003 (OO surface); execution plan §3.B.6, §6.4; gaps doc §3.B

## Context

Phase 3.B.6 adds **extension functions**: a way to define a function that *looks like* an instance method at the call site (`x.foo()`) but is statically dispatched against a separate top-level declaration. Extensions apply to user types, imported CLR types, structs, classes, and interfaces. They cannot access private state of the receiver type.

There are three established surface forms:

| Form | Example | Familiar from |
| --- | --- | --- |
| **A. Go-style "receiver in parens before name"** | `func (s string) shout() string { … }` | Go |
| **B. Kotlin/C++-style "Type.Member"** | `func String.shout() string { … }` | Kotlin, Swift, C++ |
| **C. C#-style "this on first parameter"** | `func shout(this string s) string { … }` | C# |

Phase 6 (§6.4, ADR-0024) plans **methods-with-receivers on user-owned types** as a *separate* feature: `func (p Point) Distance() float64 { … }`. Methods-with-receivers and extension functions overlap in the syntactic real estate of Form A: both want to write `func (Receiver) Name(…) …`. ADR-0024 will pick the *canonical* style for new user code once both are available.

To avoid Phase 3 painting Phase 6 into a corner, the extension-function syntax must:

1. Read as "I'm extending an existing type," not "I own this type and I'm adding a method."
2. Be uniformly applicable to types the author does **not** own (imported CLR types like `string`, user types in other packages).
3. Compose with the package-and-namespace model: extensions live in a CLR package as ordinary static methods on a synthesized container, importable like any other declaration.

## Decision

GSharp adopts **Form A — Go-style "receiver in parens before name"** — for both extension functions (Phase 3.B.6) and methods-with-receivers (Phase 6.4). The two are **distinguished by the receiver type, not the syntax**:

- If the receiver type is **declared in the same package** as the function, the declaration is a **method-with-receiver** (Phase 6.4) and emits as an instance method on the receiver's CLR type definition.
- If the receiver type is **declared elsewhere** (another GSharp package, the BCL, any imported assembly) or is a **CLR primitive**, the declaration is an **extension function** and emits as a `[Extension]`-tagged static method on a synthesized `<Extensions>` static class in the declaring package's CLR namespace, with the receiver as the first parameter.

Worked example:

```gsharp
package Strings

import System

// Extension on a CLR type — emits as a static method on
// Strings.<Extensions> with [ExtensionAttribute] on both the type
// and the method, so C# sees it as a regular extension method.
func (s string) Shout() string {
    return s.ToUpper() + "!"
}

// "Hello".Shout() → "HELLO!"
```

```gsharp
package Geometry

struct Point {
    var X int
    var Y int
}

// Same syntax, but the receiver is declared in this package, so this
// is a method-with-receiver (Phase 6.4) and emits as an instance
// method on Geometry.Point.
func (p Point) Distance() float64 {
    return math.Sqrt(float64(p.X*p.X + p.Y*p.Y))
}
```

Binder rules:

- The receiver parameter is bound in the function body as a normal parameter; its name is taken from the receiver declaration (`s` and `p` above).
- The receiver may be any non-pointer type. Pointer receivers (`func (p *Point) …`) are deferred to a future ADR; Phase 3 has no addressable-receiver story.
- An extension function may not access non-public members of its receiver (extension is just sugar over a static call).
- An extension function in package `A` is visible in package `B` only if `B` imports `A` *and* the receiver type is also in scope.

CLR emission (extension case):

- Declaring package gets one synthesized `[ExtensionAttribute]`-marked static class (`<Extensions>` per ADR-0028's `<Program>` pattern) lazily on first extension.
- Each extension function is a `public static` method with `[ExtensionAttribute]` on the method and the receiver as the first parameter.
- C# consumers can call these as ordinary extension methods (`using static Strings;` then `"hi".Shout()`).

## Consequences

Positive:

- One syntactic form for "method-shaped function with a receiver"; the user does not have to learn two flavors.
- Reads as Go to a Go reader; the receiver-binds-the-name shape is unambiguous.
- C# interop is clean: extensions emit as canonical `[Extension]` static methods that C# tooling recognises with no additional translation layer.
- The "where does the receiver type live?" rule is mechanical (lookup in `packageTypes`); no user-visible declaration ceremony beyond the existing import system.

Negative:

- A reader cannot tell, *purely from the function declaration*, whether it is a method-with-receiver or an extension function — they have to know which package the receiver type lives in. Mitigation: ADR-0024 will recommend a stylistic convention (e.g., comment, doc comment tag) and IDE tooling can decorate the symbol.
- Pointer receivers cannot be supported without an addressable-receiver story; some Go porters will miss `func (p *Point) Translate(dx, dy int) { p.X += dx; p.Y += dy }`. Acceptable for Phase 3; revisit when value-vs-reference semantics get a full ADR pass.

Neutral:

- Form B (`func String.shout() …`) remains a respectable alternative; the rejection is on stylistic and `func`-keyword-consistency grounds, not correctness.
- The synthesized `<Extensions>` class is a CLR artifact; it does not affect GSharp's name resolution. Importers see the *package*, not the container.

## Alternatives considered

- **Form B (`func Type.Name() …`)**: rejected. Two `func` shapes (`func Foo()` for free, `func Type.Foo()` for extensions) is one shape too many for a small language. Form A keeps every declaration starting with `func (`.
- **Form C (`func Name(this Type s) …`)**: rejected. The `this` keyword is C#-flavored, conflicts with `this` as an identifier in user code, and doesn't compose with Phase 6.4 methods-with-receivers.
- **Two separate syntaxes — Form A for receivers, Form B for extensions**: rejected. Reasonable for a larger language; for GSharp it doubles the learning surface for limited benefit.
- **Forbid extension functions entirely; require users to subclass / wrap**: rejected. Extending imported CLR types (e.g., `string.Shout()`) is a Phase 3 milestone; without extensions it is unreachable.
