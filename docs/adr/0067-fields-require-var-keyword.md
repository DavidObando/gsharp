# ADR-0067: Field declarations require `var` or `let`

- **Status**: Accepted
- **Date**: 2026-06-11
- **Phase**: Phase 9 — language depth / type surface consistency
- **Related**: ADR-0008 (variable bindings — `var`/`let` for locals), ADR-0029 (struct surface), ADR-0033 (inline struct), ADR-0051 (property declarations — `prop` keyword), ADR-0052 (event declarations — `event` keyword), ADR-0053 (static members — `shared { … }` block), ADR-0065 (class initializers and base invocation), issue [#694](https://github.com/DavidObando/gsharp/issues/694)

## Context

G# `struct` and `class` bodies began life as bare field-only structures, in the Go tradition: a member line was an identifier followed by a type clause, with no leading keyword. Over the lifetime of the language the type body picked up several richer member shapes that *do* carry an introducer keyword: `func` for methods (ADR-0017), `prop` for properties (ADR-0051), `event` for events (ADR-0052), `init` for user-defined constructors (ADR-0065), `shared { … }` for static members (ADR-0053), and so on. The result is a member surface where every member kind except fields announces itself with a keyword:

```gs
type Counter class {
    Value int32 = 0              // field — bare; the odd one out
    prop Name string             // property — `prop` keyword
    event Changed Action         // event — `event` keyword
    func Touch() { … }           // method — `func` keyword
    init(seed int32) { … }       // constructor — `init` keyword
}
```

This inconsistency has been called out repeatedly during reviews. It hurts readability (the eye scans the leading keyword to classify each member), it confuses the editor lookahead (where the parser today has to *guess* "is this a field, a method header missing `func`, or an annotation typo?"), and it makes the read-only intent invisible — there is no surface marking that distinguishes "this field is mutable" from "this field is set once at construction time".

ADR-0008 already established `var` and `let` as the binding keywords for local variables (`var x = …` for mutable, `let x = …` for immutable runtime bindings). Lifting the same pair into the type body — Swift's exact convention — fixes all three issues with one change: every type-body member now leads with a single contextual keyword, the parser dispatch becomes unambiguous, and read-only fields gain a one-token surface marker that drives `FieldAttributes.InitOnly` in emit.

## Decision

Field declarations inside `struct`, `class`, `data struct`, `inline struct`, and `shared { … }` bodies **must** be introduced by a `var` (mutable) or `let` (read-only) keyword. The keyword sits immediately after the optional accessibility modifier and before the field name:

```ebnf
field_declaration = annotations? accessibility_modifier? ("var" | "let") identifier type_clause ("=" expression)?
```

### Examples

```gs
type Counter class {
    var Value int32 = 0          // mutable instance field
    let Origin int32 = 0         // read-only instance field — set only at init time
    prop Name string             // property — unchanged
    func Touch() { … }           // method — unchanged
}

type Point struct {
    var X int32
    var Y int32
}

type Defaults class {
    shared {
        var Counter int32 = 0    // mutable static field
        let Pi float64 = 3.14159 // read-only static field
    }
}
```

### Semantics

- `var <Name> <Type> [= initializer]` — mutable field. Identical to today's behaviour. The initializer is optional; when absent the field takes the type's default (zero) value, per ADR-0008.
- `let <Name> <Type> [= initializer]` — read-only field. The binder rejects assignments to the field outside of construction (primary constructor, struct literal, `init(...)` body, or the field's own declaration-site initializer). The emitter sets `FieldAttributes.InitOnly` so the CLR honors the constraint at runtime and so consumers see a `readonly` field through reflection. C# and other CLR consumers experience this as a normal `public readonly int Origin`.
- The keyword is mandatory: omitting it is a binder-time error (GS0288). The parser still attempts recovery so the rest of the type body can be checked.

### What is **not** affected by this ADR

- **Property declarations** (`prop`, ADR-0051) — already carry their own introducer keyword; their grammar is unchanged.
- **Event declarations** (`event`, ADR-0052) — unchanged.
- **Method / function declarations** (`func`, ADR-0017) — unchanged.
- **Constructor declarations** (`init`, ADR-0065) — unchanged.
- **Primary-constructor parameter lists** — `type Person class(Name string, Age int32) { … }` continues to parse as before. Primary-constructor parameters are *parameters*, not field declarations; the binder still synthesises a public read-only field for each parameter automatically (this is a separate language affordance, not a field-declaration shape).
- **`inline struct` value parameter** — `type UserId inline struct(value string)` continues to declare its single value through the parenthesised parameter list, identical to the primary-constructor parameter path above.
- **`const` declarations at top level / inside packages** — unchanged. ADR-0067 is scoped to type-body fields.

### Diagnostic

A new diagnostic is allocated:

- **GS0288** — `"Field declarations require a 'var' (mutable) or 'let' (read-only) keyword."` Reported at the offending token's location (the would-be field identifier, or whatever the parser sees where it expected `var`/`let`). The parser then recovers by treating the next identifier as the field name so subsequent fields and members are still checked.

## Considered alternatives

- **Status quo (no keyword)** — rejected: directly contradicts the issue request and leaves the inconsistency described above unresolved. Even if we kept the bare form as a transitional convenience, the lack of a surface marker for read-only fields would force a separate decoration (an attribute, a contextual keyword, or per-member `readonly`) that is strictly more work for users than `let`.
- **Single keyword (`var` only)** — rejected: the issue explicitly asks for "Swift language style" and Swift uses both `var` and `let`. Adopting only `var` would leave read-only fields with no syntactic marker, forcing users back to attributes or trusting convention. Since ADR-0008 already supports `let` for locals, lifting the same pair into type bodies is the cheaper, more uniform change.
- **`field` keyword (C# 13 style)** — rejected: `field` is already proposed in the C# / Roslyn world as a *contextual* identifier inside property accessors (the backing-field shorthand). Reusing it as a field-declaration introducer would collide with the natural future direction of property accessors and would not give us the var/let mutability split.
- **`val` instead of `let`** — rejected for the same reason ADR-0008 rejected it for locals: user preference is `let`, and consistency with the local-binding pair matters more than alignment with Kotlin.
- **Keep `prop`/`event`/`func` but make fields opt-in via `field`** — rejected: produces *four* member keywords (`field`/`prop`/`event`/`func`) and still gives us nothing for read-only intent.
- **Allow `const <Name> <Type> = <constexpr>`** as a third form — out of scope. Compile-time constants on instance types are a separate design question (ADR-0008 already covers `const` for locals); we can revisit once we have a concrete static-constant proposal.

## Migration impact

This is a **breaking** language change. Every existing `.gs` source that declares a bare field inside a `struct`, `class`, `data struct`, or `shared { … }` body must be updated to prepend `var` or `let`. The PR that implements this ADR migrates:

- Every G# sample under `samples/` (101 files; ~30 carry field declarations).
- Every `.gs` test fixture under `test/` (~140 files contain type declarations; ~70 declare fields).
- Every doc snippet that shows the old syntax. The ADRs that describe field shapes (this ADR; ADR-0029, ADR-0051) are updated alongside.

The rule of thumb for the mechanical migration is: bare fields that are mutated after construction become `var`; bare fields that are only ever read after construction become `let`. When in doubt the migration defaults to `var` — that preserves today's behaviour exactly and never introduces a new diagnostic. Read-only conversion (`var` → `let`) is a follow-up that callers can do at their convenience as a one-character no-risk change.

## Backward compatibility

Intentionally **not** backward compatible. The parser surfaces GS0288 with a precise, actionable message at the first bare-field site, which is enough information for the user to make the one-character correction. No deprecation period is offered: keeping a fallback "accept bare fields" path would defeat the consistency goal of this ADR and bifurcate the parser dispatch.

## Implementation notes

- **Syntax**: `FieldDeclarationSyntax` gains a `VarOrLetKeyword` token and an `IsReadOnly` convenience property (`true` iff the keyword is `let`). The constructor signature picks up the new token between `AccessibilityModifier` and `Identifier`.
- **Parser**: `Parser.ParseFieldDeclaration` consumes the keyword after the optional accessibility modifier. A missing keyword reports GS0288 and continues; the parser does not consume tokens for recovery beyond the diagnostic.
- **Binder**: `DeclarationBinder` reads `fieldSyntax.IsReadOnly` and ORs it into the `isReadOnly` argument of `FieldSymbol`, so the existing `IsInline` path (which already forces read-only on `inline struct` fields) continues to compose. Static fields inside `shared { … }` blocks pick up `IsReadOnly` directly from the field syntax.
- **Emit**: no change required. `TypeDefEmitter` already maps `FieldSymbol.IsReadOnly` to `FieldAttributes.InitOnly` on both instance and static field definitions, so `let` fields automatically emit as CLR `initonly` fields.
- **Bound tree**: no new node kind is needed. The mutability decision is recorded on the `FieldSymbol` itself (`IsReadOnly`), which is already consulted by every assignment-binding path that can target a field — `BindFieldAssignmentExpression`, `BindMemberFieldAssignmentExpression`, `BindStructLiteralExpression` (init-only enforcement), the `ImplicitFieldVariableSymbol` and `ImplicitStaticFieldVariableSymbol` accessors, and so on.
- **Diagnostics**: a single new diagnostic, GS0288, with the message text above.

## Status

Accepted; implemented in the same PR as this ADR.
