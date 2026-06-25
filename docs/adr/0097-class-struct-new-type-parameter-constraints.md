# ADR-0097: G# spelling for `class` / `struct` / `init()` type-parameter constraints

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Binder + emit hardening
- **Closes**: Issue #775 (G# language gap — no spelling for class/struct/init() generic constraints on G#-authored type parameters)
- **Related**: ADR-0020 (sealed-interface bounds and `any`/`comparable` spellings); ADR-0084 (Gsharp.Extensions Optional/Sequences — language-gap L2 residual was this hole on the *G# authoring* side); ADR-0088 (constraint-aware overload resolution — handled the *consumption* side of class/struct/init() that comes through CLR-imported assemblies); ADR-0089 (static-virtual interface members — sets the precedent of treating a constraint identifier as a self-referential generic instance); parent issue #706 (Oats cleanup); related issues #697, #751, #773, #774, #750

> **Update (issue #997):** the default-constructor flag constraint was
> originally spelled `new()` (mirroring C#). It has since been **renamed to
> `init()`** to give the constraint a G#-flavored surface keyword consistent
> with G#'s `init(...)` constructor declarations. This is a breaking change to
> an unreleased feature; `new()` is no longer accepted in constraint position.
> The keyword is contextual — `init()` is a constraint **only** inside a
> generic type-parameter list (`[T init()]`); the `init(...)` constructor-decl
> and init-only-property syntaxes are unaffected. The underlying CLR semantics
> (the `DefaultConstructorConstraint` flag) and emitted metadata are unchanged.
> This document is preserved with `init()` substituted for the historical
> `new()` spelling.

## Context

G#'s generic type-parameter syntax (Phase 4.1 / ADR-0020) accepted three
constraint spellings on a G#-authored type parameter:

| Spelling              | Meaning                                              |
| --------------------- | ---------------------------------------------------- |
| `[T any]` (or `[T]`)  | unconstrained — accepts every type argument          |
| `[T comparable]`      | accepts types that support `==`/`!=`                 |
| `[T IFoo]`            | sealed-interface bound — arg must implement `IFoo`   |
| `[T IAdd[T]]` (#755)  | self-referential generic-instance interface bound    |

It did **not** admit the three flag-style constraints the CLR's
`GenericParam` table can carry:

| Missing flag                                          | CLR projection                                          |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `class` — must be a reference type                    | `GenericParameterAttributes.ReferenceTypeConstraint`    |
| `struct` — must be a non-nullable value type          | `GenericParameterAttributes.NotNullableValueTypeConstraint` (+ `DefaultConstructorConstraint`, per ECMA-335 II.10.1.7) |
| `init()` — must expose a public parameterless ctor     | `GenericParameterAttributes.DefaultConstructorConstraint` |

ADR-0088 (constraint-aware overload resolution) read those flag bits
*from CLR-imported types* during overload resolution; but a G# author
could not **declare** them on a G# type parameter, so a same-named
overload pair like

```
func (self T?) Map[T class](f (T) -> U) U?
func (self T?) Map[T struct](f (T) -> U) U?
```

was unspellable in G#. That gap was the last documented blocker
preventing the dogfooded G# port of `Gsharp.Extensions.Optional` and
`Gsharp.Extensions.Sequences` (ADR-0084 L2 residual). It also blocked
authoring a value-type-only `Box[T struct]` shape, a
default-constructor-aware container, or any G# generic API whose
correctness depends on knowing the kind of `T` at the declaration site.

## Decision

### Spelling (G#-native bracket position, flag-style)

G#'s `[…]` bracket section after a generic declaration name (the same
slot that holds `any`, `comparable`, or an interface bound) is widened
to accept a sequence of constraint specifiers:

```
type-parameter   ::= variance? Ident constraint-spec*
constraint-spec  ::= 'any'
                   | 'comparable'
                   | InterfaceName generic-args?
                   | 'class'
                   | 'struct'
                   | 'new' '(' ')'
```

Examples — all legal, all parseable today:

```
func F[T class](x T) T { return x }
func F[T struct](x T) T { return x }
func F[T init()](x T) T { return x }
func F[T class init()](x T) T { return x }
func F[T IFoo class](x T) T { return x }
class Box[T struct] { var v T }
data struct Holder[T init()] { var v T }
```

The flag specifiers may appear **in any order**, may be combined with
each other (subject to validation below), and may be combined with a
single legacy slot (`any`, `comparable`, or an interface name) that
precedes them. The legacy slot remains identifier-only and singleton;
the new flags slot is repeatable.

#### Why not a `where` clause?

C#-style `where T : class` would have meant adding a brand-new
out-of-line clause grammar after the parameter list, duplicating the
constraint information that G# already places inside the `[…]`
brackets, and breaking the symmetry with the existing `[T any]`,
`[T comparable]`, `[T IFoo]` spellings. The bracket-position spelling
keeps every constraint about `T` in one visual region, mirrors Go's
type-parameter constraint syntax that G#'s generics descend from, and
reuses the existing parser look-ahead machinery without introducing a
new follow-set.

### Supported constraints

| G# spelling   | CLR flag                                              | Meaning                                                                                  |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `class`       | `ReferenceTypeConstraint`                             | Type argument must be a reference type (`!ClrType.IsValueType`, not `Nullable<T>`).      |
| `struct`      | `NotNullableValueTypeConstraint` + `DefaultConstructorConstraint` (ECMA-335 II.10.1.7) | Type argument must be a non-nullable value type.                                         |
| `init()`       | `DefaultConstructorConstraint`                        | Type argument must either be a value type or expose a public parameterless constructor. |

Combinations:

- `class init()` — legal. Restricts to reference types that also expose a
  public parameterless constructor. Both CLR flag bits are emitted.
- `class struct` — **illegal** (mutually exclusive). Diagnoses GS0361.
- `struct init()` — **illegal** (redundant; `struct` already implies
  `init()` at the CLR level per ECMA-335 II.10.1.7). Diagnoses GS0361.
  The recovery action is to write just `struct`.
- `class IFoo` (or `IFoo class`) — legal. Combines a reference-type
  constraint with an interface bound. The interface bound continues to
  occupy the single legacy slot; the `class` keyword occupies the new
  flags slot.

### Binder enforcement (`Binder.SatisfiesConstraint`)

The existing `Binder.SatisfiesConstraint(TypeSymbol, TypeParameterSymbol)`
entry point gains three checks on top of the legacy interface +
`comparable` checks:

1. `class` → `Binder.IsReferenceTypeForConstraint(arg)` — accepts
   `string`, classes (`StructSymbol { IsClass: true }`), interfaces,
   delegates, function-type symbols, arrays, slices, maps, channels,
   sequence/async-sequence symbols, and any CLR-imported type whose
   `ClrType.IsValueType` is false; rejects value-typed `StructSymbol`,
   `Nullable<T>`, and value-typed `ImportedTypeSymbol`.
2. `struct` → `Binder.IsNonNullableValueTypeForConstraint(arg)` —
   accepts value-typed `StructSymbol`, the primitive `int32` / `bool`
   symbols, and CLR-imported value types that are not `Nullable<T>`.
3. `init()` → `Binder.HasDefaultConstructorForConstraint(arg)` — value
   types satisfy it implicitly; G# classes satisfy it when no explicit
   ctor is declared or when at least one declared ctor has zero
   parameters; CLR-imported classes satisfy it when
   `ClrType.GetConstructor(Type.EmptyTypes)?.IsPublic == true`.

Constraint *propagation* through nested type parameters is honoured —
a substitution like `T → U` where `U` itself carries `struct` keeps the
`struct` bit alive for downstream checks. `DescribeConstraint(tp)`
includes the new flags in diagnostics (`"class init()"`, `"struct"`,
`"IFoo class"`, etc.) so GS0152 ("type argument does not satisfy
constraint") reads precisely.

### CLR mapping (emit)

`TypeDefEmitter.EmitGenericParamRows` now projects the new flags onto
the `GenericParam` rows:

```csharp
if (tp.HasReferenceTypeConstraint)
{
    attrs |= GenericParameterAttributes.ReferenceTypeConstraint;
}

if (tp.HasValueTypeConstraint)
{
    attrs |= GenericParameterAttributes.NotNullableValueTypeConstraint;
    attrs |= GenericParameterAttributes.DefaultConstructorConstraint; // ECMA-335 II.10.1.7
}
else if (tp.HasDefaultConstructorConstraint)
{
    attrs |= GenericParameterAttributes.DefaultConstructorConstraint;
}
```

This matches what C# emits for the equivalent `where` clauses. The
emitted IL passes `ilverify` (covered by the new
`Issue775ConstraintEmitTests` in `test/Compiler.Tests/Emit/`); the
runtime then rejects illegal type-argument substitutions with
`VerificationException` exactly as it does for C#-authored generics.

### Diagnostic — `GS0361`

A new diagnostic, **GS0361**, fires when the binder sees a forbidden
combination of flag-style constraints on the same type parameter:

```
GS0361: Type parameter 'T' carries the mutually exclusive constraints 'class' and 'struct' (ADR-0097).
GS0361: Type parameter 'T' carries the mutually exclusive constraints 'struct' and 'init()' (ADR-0097).
```

The binder recovers by dropping the offending companion flag (keeping
`class` in the `class struct` case, keeping `struct` in the `struct
init()` case) so downstream binding continues with one consistent
shape and the user receives at most one diagnostic per parameter.

We do **not** invent a new code for "duplicate `class`" / "duplicate
`struct`": the parser tolerates a single keyword and rejects a second
appearance of the same keyword by silently stopping the consume-loop,
leaving the second token to be parsed as the next syntactic element
(which will produce an unrelated diagnostic if it is not in the
follow-set). The shape is not common enough in real code to warrant a
dedicated code.

### Interaction with existing rules

- **Legacy spellings are unchanged.** `[T any]`, `[T]`, `[T comparable]`,
  `[T IFoo]`, `[T IAdd[T]]` continue to parse and bind exactly as
  before. The new flags slot is purely additive.
- **`where T : I` (interface) and `class`/`struct`/`init()` compose.**
  An interface bound occupies the legacy single-identifier slot; the
  flags slot is independent. `[T IDisposable class init()]` is a valid
  ordering, as is `[T IDisposable class]`. (`init()` after `struct` is
  rejected per the table above.)
- **ADR-0088 composes cleanly.** `Binder.SatisfiesConstraint` is the
  single entry point used by both call-site applicability checks and
  the new extension-method dispatch logic in
  `BoundScope.TryLookupExtensionFunction`. ADR-0088's existing
  CLR-imported constraint check (in `OverloadResolution.cs`) is
  untouched; G#-authored constraints flow through the symbol-level
  check in `Binder.cs`. The two paths produce consistent answers for
  the same `(arg, constraint)` pair.
- **ADR-0089 self-referential interface bounds compose cleanly.** The
  legacy `[T IAdd[T]]` shape continues to occupy the singleton
  interface slot; the new flags follow it in source order.
- **Constraint-aware extension-method dispatch (G# side).** When two
  same-name extensions both unify with a call-site receiver type, the
  binder filters out candidates whose flag constraints reject the
  inferred type argument, then prefers the most specific surviving
  candidate using the same `struct > class > none` ordering as
  ADR-0088. This makes the canonical Optional/Sequences shape

  ```
  func (self T?) Map[T, U class](f (T) -> U) U?
  func (self T?) Map[T, U struct](f (T) -> U) U?
  ```

  dispatch correctly without any user-side renaming.

## Why the Extensions stdlib port is staged

ADR-0084's "Known limitations" section called for the eventual port of
`Gsharp.Extensions.Optional` and `Gsharp.Extensions.Sequences` from C#
to G# once the language gaps closed:

- **L1 (constraint-aware overload resolution)** — closed by ADR-0088.
- **L2 parser side** — closed in the PR for #751.
- **L2 binder side** — closed by #773.
- **L2 emit side residual (open-receiver iteration)** — closed by #774.
- **L3 (`?:` over nullable value types)** — closed by #752.
- **G# `class`/`struct`/`init()` spelling** — closed by this ADR.

What remains is **not** a language gap: it is an SDK bootstrap cycle.
`Gsharp.Extensions.dll` is auto-referenced by every `.gsproj` build via
`Gsharp.NET.Sdk`, but the SDK itself takes a `ProjectReference` on
`Gsharp.Extensions.proj` at pack time (see
`src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj` and the
`PackGsharpExtensions` target). Re-authoring `Gsharp.Extensions` as a
`.gsproj` would require the SDK to already exist in order to compile
the `.gs` sources, which in turn would require `Gsharp.Extensions.dll`
to already exist — a circular dependency that needs a staged bootstrap
fix orthogonal to this ADR.

Concretely, the bootstrap fix needs to:

1. Build a minimal compiler-only payload (`gsc.dll`) that does not
   reference `Gsharp.Extensions` at all (the compiler already does not
   take a hard ref; it currently grabs the assembly only to stage it
   into the SDK NuGet).
2. Pack a temporary "stage-0" SDK NuGet without
   `tools/extensions/Gsharp.Extensions.dll`.
3. Build the new `Gsharp.Extensions.gsproj` against the stage-0 SDK,
   producing a real `Gsharp.Extensions.dll`.
4. Re-pack the SDK NuGet with the freshly built extensions DLL bundled
   under `tools/extensions/`.

That work is filed as a follow-up; the language-gap closure shipped in
this ADR is independent of it and unblocks any *user* project that
wants to author class/struct/init() constraints in G#. The
`Gsharp.Extensions.*` C# escape hatches stay in place until the
bootstrap is solved; once they migrate, the test suite
(`test/Extensions.Tests/`, 107 tests) is expected to continue passing
against the G# port unchanged.

## Migration

This ADR is additive and source-compatible. No existing G# program
needs to change. Projects that previously chose between two same-named
extensions by renaming one (e.g. `MapValue`, `FirstValueOrNil`) can now
collapse the surface to a single name with disjoint constraints, the
same way ADR-0088 collapsed the CLR-imported side.

## Consequences

- **Positive — closes the last documented G# language gap blocking the
  dogfooded Extensions port.** Future work on the SDK bootstrap cycle
  can now proceed knowing the language itself is ready.
- **Positive — symmetry with C#.** Any constraint a C# author could
  spell with `where T : class | struct | new()` is now spellable in
  G#'s bracket section. Emitted IL is bit-identical to what a C#
  compiler would produce, which means ECMA-335 reasoning, tooling, and
  decompilers all "just work".
- **Positive — predictable algorithm for same-name dispatch.** The
  Optional/Sequences shape (one extension constrained to `class`, one
  to `struct`, identical name) now dispatches without any user-side
  workaround.
- **Neutral — the flags slot is order-insensitive.** Style choice. The
  recommended convention (used in the docs samples) is
  `[T <interface>? class? struct? init()?]` — interface bound first,
  then the flag specifiers in `class struct init()` order. The binder
  does not enforce this; tooling may surface a fix-it later.
- **Neutral — the `new` token is contextual.** The parser only treats
  `new` as a constraint keyword when it directly follows the type
  parameter name (or another flag) inside the brackets and is
  immediately followed by `()`. Every other position keeps `new` as a
  free identifier (G# has no `new` operator today).

## Alternatives considered

1. **`where T : class` clauses after the parameter list.** Rejected: a
   parallel out-of-line spelling fragments where constraint
   information lives, breaks the symmetry with `[T any]` /
   `[T comparable]` / `[T IFoo]`, and complicates parsing without
   removing any ambiguity. The bracket-section spelling keeps the
   constraint right next to the parameter it constrains.
2. **A single combined enum** (extending `TypeParameterConstraint` to
   `Class`, `Struct`, `New`). Rejected: the CLR flags are independent
   *bits*, not mutually exclusive cases. Modelling them as boolean
   flags on `TypeParameterSymbol` matches the CLR shape one-for-one
   and lets the binder use simple bitwise reasoning.
3. **Implicit `init()` from `struct`** (i.e. accept `[T struct init()]`
   silently). Rejected: explicit redundancy invites the false belief
   that the two are independent. Failing fast with GS0361 keeps the
   surface honest.
4. **`unmanaged` constraint as part of this ADR.** Deferred: the
   `unmanaged` constraint requires emitting a synthetic
   `IsUnmanagedAttribute` marker and a modreq on `System.ValueType`;
   it composes with the work here but is best handled in a dedicated
   ADR alongside the P/Invoke ergonomics track (ADR-0096 follow-ups).

## Follow-ups

- **SDK bootstrap cycle.** **Build-system side closed by issue #792.**
  The `src/Sdk/Gsharp.NET.Sdk.Bootstrap/` targets file mirrors the
  consumer SDK on every axis except the `Gsharp.Extensions.dll`
  auto-reference and resolves `gsc.dll` + the BuildTask from in-tree
  `out/bin/$(Configuration)/...`, so a G#-authored
  `Gsharp.Extensions.gsproj` can consume it without participating in
  the cycle. The actual source port of `Optional` / `Sequences` is
  staged in the follow-ups filed from #792 — the remaining work is
  language-side (generic-method type-parameter threading in generic
  instance-method calls, `default(T)`, `params`, `==` between
  function-typed values and `nil`, `[MethodImpl(...)]` parsing in
  `shared { }`, `yield` in shared-static methods returning
  `IEnumerable[T]`).
- **`unmanaged` constraint.** Track separately; not required for the
  Extensions port.
- **Fix-it tooling.** The language server could offer a
  "reorder constraints" code action that normalises the order to
  `[T <interface>? class? struct? init()?]`.
