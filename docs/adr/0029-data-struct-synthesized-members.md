# ADR-0029: `data struct` synthesized members

- **Status**: Superseded by ADR-0078 (spelling) — synthesis contract is retained
- **Date**: 2026-05-22
- **Phase**: Phase 3 (lock before 3.B.2)
- **Superseded**: The `record` keyword and the `record` alias are removed by ADR-0078. The synthesis pipeline (equality, `with`-copy, deconstruction) lives on unchanged under the canonical spellings `data class Name(...)` and `data struct Name(...)`. References below to the `record` keyword should be read as historical.
- **Related**: ADR-0003 (OO surface); ADR-0017 (method virtuality); ADR-0026 (copy syntax, Phase 7); ADR-0078 (Kotlin/Swift declaration head); execution plan §3.B.2; gaps doc §3.2.1
- **Implementation**: Issue [#410](https://github.com/DavidObando/gsharp/issues/410); see `EmitDataStructSynthesizedMembers` in `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` and diagnostic GS0232.

## Context

Phase 3.B.2 introduces `data struct` — Kotlin-flavoured data class, but built on the `struct` foundation laid by Phase 3.B.1. ADR-0003 sketches the surface: "compiler synthesizes structural equality, hash, `ToString`, `copy(field = newValue)`, and positional destructuring." This ADR fixes the *exact* member contract so Phase 3.B.2 implementation, conformance tests, and C# interop expectations are unambiguous.

The synthesized contract has knock-on choices:

- **Whose equality is "structural"?** All fields, in declaration order, via the field's own `Equals`.
- **Is `GetHashCode` stable across runs?** Yes — derived from the fields via `HashCode.Combine`.
- **What does `ToString()` look like?** Two precedents: C# records (`Point { X = 3, Y = 4 }`), Kotlin data classes (`Point(X=3, Y=4)`). Pick one; lock it.
- **Do operators `==` / `!=` come for free?** For value types in CLR, the language must emit `op_Equality` / `op_Inequality` explicitly; nothing is synthesized by the runtime.
- **Is `Deconstruct` synthesized?** C# records emit it; Kotlin data classes emit `componentN()`. We pick a representation now even though the *syntax* that consumes deconstruction (Phase 4+) lands later.
- **Sealed or virtual?** Structs cannot be subclassed. Their object overrides remain CLR `virtual` reuse-slot methods, but omit a redundant method-level `final` bit because the containing TypeDef already prevents derivation. The typed `Equals(Self)` slot remains final.
- **What about `copy(field = newValue)` and positional destructuring syntax?** Surface form is out of scope for Phase 3.B.2 — slotted for **Phase 7 / ADR-0026**. This ADR commits only to the *underlying member shape* that ADR-0026 will eventually consume.

## Decision

A `data struct Name { F1 T1; F2 T2; … }` declaration emits the same CLR `ValueType` shape as Phase 3.B.1's plain `struct` (sealed sequential-layout TypeDef extending `System.ValueType`, public fields), **plus** the following synthesized members:

1. `public override bool Equals(object other)` — returns `false` if `other` is not an instance of `Name`; otherwise returns `Equals((Name)other)`.
2. `public bool Equals(Name other)` — returns `true` iff every field `Fi` satisfies `EqualityComparer<Ti>.Default.Equals(this.Fi, other.Fi)`. Fields are compared in source declaration order; first inequality short-circuits.
3. `public override int GetHashCode()` — combines field hashes via `System.HashCode.Combine(F1, F2, …)`. For data structs with more than 8 fields (the `HashCode.Combine` overload limit), the binder emits a fold using `HashCode.Add` on a stack-allocated `HashCode` then `ToHashCode()`.
4. `public override string ToString()` — produces `Name(F1=<value>, F2=<value>, …)`. Field values use `Convert.ToString(Fi, CultureInfo.InvariantCulture)` (null becomes empty string). Format chosen for parity with Kotlin and for one-line debuggability.
5. `public static bool op_Equality(Name left, Name right)` and `public static bool op_Inequality(Name left, Name right)` — call `left.Equals(right)` and negation thereof. Required because the CLR does **not** synthesize value-type equality operators automatically.
6. `public void Deconstruct(out T1 F1, out T2 F2, …)` — assigns each field to the corresponding `out`. Emits with the exact field names so C# users can `var (x, y) = point;` (C# uses positional matching but tooling shows the names). Skipped for zero-field data structs.

Additional rules:

- A zero-field `data class`/`data struct` (e.g. `data class Name() {}` or `data class Name {}`) is now permitted — see "Amendment 2026-07-20" below; the original text of this rule required at least one field and is superseded.
- The user **may not** hand-write any of the six synthesized members on a `data struct`. Diagnostic: `Member 'Name.Equals' is synthesized for 'data struct'; remove the declaration.` This avoids the "did the user intend to override the synthesized one?" ambiguity. (Phase 6+ may relax this if a user-visible `partial` story emerges; the present rule is the conservative one. **Update:** see "Amendment 2026-07-15" below — `ToString` alone is now relaxed under a strict shape-compatibility check.)
- Field accessibility modifiers (`public` / `internal` / `private` per ADR-0014) are allowed but **the synthesized methods see every field**. A `private` field on a `data struct` is still part of its identity and `ToString`. A user who wants opacity should pick `struct`, not `data struct`. Documented.
- The `data` keyword is **context-sensitive**: it is only a keyword immediately before `struct` in a top-level type-declaration position; everywhere else it is an ordinary identifier (so users may still name a variable `data`).

CLR-level identity:

- TypeDef row is the same shape as a `struct` (`SequentialLayout | Sealed | AnsiClass | BeforeFieldInit`).
- The synthesized methods are emitted **on the struct's TypeDef row** — Phase 3.B.2 extends the emitter to associate `MethodDef` rows with struct TypeDefs. This is *the* deliverable, in emitter terms, that distinguishes 3.B.2 from 3.B.1.
- `[System.Runtime.CompilerServices.IsReadOnlyAttribute]` is **not** synthesized in Phase 3.B.2; data structs are mutable (per the plain-struct semantics) and immutability is a Phase 7 (`record` alias) discussion.

## Consequences

Positive:

- C# consumers get a value type that satisfies `IEquatable<Name>` informally (operator pair + `Equals(Name)` overload), composes with `HashSet<Name>`, `Dictionary<Name, …>`, and pattern matching. Indistinguishable from a hand-written value-record at the call site.
- Phase 3.B.2 is fully testable end-to-end without waiting for Phase 7's `copy` and destructuring *syntax* — the surface measured is the synthesized member contract, which is directly observable via reflection and `Equals`/`ToString` calls.
- The "user may not hand-write synthesized members" rule keeps semantics under the compiler's control and avoids the partial-class rabbit hole.

Negative:

- Hash combination via `HashCode.Combine` requires the System.HashCode type. It is available on every supported target (netcoreapp2.1+ and netstandard2.1+), but if a user targets `netstandard2.0` the emitter must fall back. Defer fallback: Phase 3 targets net10.0 (per `Directory.Build.props`); document the constraint and revisit if Phase 6 multi-targeting demands it.
- Forbidding user-written `Equals`/`GetHashCode`/`ToString` on data structs prevents customizing the format (e.g., suppress a field from `ToString`). Mitigation: users who need a custom format should pick `struct` and write everything themselves; this is a deliberate trade-off in favor of "data structs are predictable."
- The `Deconstruct` method emits even though Phase 3 has no destructuring syntax — costs a `MethodDef` row per data struct. Acceptable: rows are cheap, and shipping it now means Phase 4+ destructuring is purely a parser change.

Neutral:

- ADR-0026 (Phase 7) will add `let p2 = p.copy(x = 10)`. The lowering is `let p2 = data struct.copy(p, x = 10)` or equivalent — the synthesized contract here does **not** include a `copy` method, so ADR-0026 is free to pick either a synthesized instance method, a static helper, or pure syntactic sugar that constructs a new value via the existing composite literal.
- Frozen until ADR-0017 reopens for the question of *which* members are sealed-overridable. The typed `Equals(Self)` slot remains final; object overrides omit redundant method-level finality when the containing TypeDef is already sealed.

## Amendment 2026-10-07: CLR record ABI convergence (#4828)

The translated C# record contract now distinguishes positional components from
ordinary body members. A body-only translated record does not gain a synthesized
`Deconstruct`; its fields and auto-properties still participate in structural
equality and printing. Native G# body-form data types retain their existing
field/property deconstruction, including when they explicitly implement
`IEquatable<Self>`. cs2gs records carry the compiler-intrinsic
`@__Cs2GsRecordProvenance_4828`
provenance marker; it affects synthesis and emits no CLR metadata. A data class
with a non-empty primary constructor emits that constructor only, not an
additional public parameterless constructor.

Synthesized equality operators name their parameters `left` and `right`, and a
data-class copy constructor names its parameter `original`. Object overrides
(`Equals(object)`, `GetHashCode`, and `ToString`) and derived
`EqualityContract` getters omit a redundant CLR `final` bit when the containing
TypeDef is already sealed. Typed `Equals(Self)` and clone-slot finality remain
unchanged. These rules match Roslyn's record metadata while preserving G#
runtime behavior and the open data-class inheritance contract.

## Alternatives considered

- **C# records (`Name { F1 = v1, F2 = v2 }` format, `EqualityContract` property, `Equals(Name)` virtual)**: rejected. The C# record runtime contract is intricate (`<>RawContract` virtual property, `protected virtual Equals`) so that inheritance works; data structs don't inherit, so the simpler Kotlin-flavor contract is enough.
- **Allow user-written synthesized members; treat the user's version as authoritative**: rejected. Opens "what does `data struct` actually guarantee?" to a per-type investigation. The teaching value of `data struct` rests on a fixed, learnable contract.
- **Synthesize `IEquatable<Name>` interface implementation explicitly**: deferred. The `Equals(Name)` overload + operator pair already satisfies the C# pattern; emitting the interface adds a TypeRef row and complicates Phase 3 emit for marginal interop benefit. Phase 6's full interface story can revisit.
- **Skip `Deconstruct` until Phase 4+**: rejected. The cost is one `MethodDef` row per data struct; the benefit is that Phase 4 destructuring becomes a parser-only change.
- **`ToString` format `{ F1 = v1, F2 = v2 }` (C# record style)**: rejected. The Kotlin form `Name(F1=v1, F2=v2)` matches `Point(X=3, Y=4)` in the README's "GSharp is Go shape" vibe better than the braces.

## Amendment 2026-07-15: `ToString` user-override relaxation (#2361)

Issue #2361 found that `cs2gs` faithfully translates a C# `record`/`record struct` with an explicit `ToString` override into a G# `data class`/`data struct` with an in-body `ToString` method — which the original "no hand-written synthesized members" rule unconditionally rejected with GS0232. Since `cs2gs` cannot omit or rewrite a user's C# override without losing behavior, every migrated record with a custom `ToString` (e.g. `Oahu.Core.ProfileKey`/`ProfileKeyEx`, `Oahu.Cli.Tui.Tokens.SemanticColor`) was unmigratable.

**Relaxation, scoped narrowly to `ToString` only.** The other five synthesized members (`Equals(object)`, `Equals(Name)`, `GetHashCode`, `op_Equality`/`op_Inequality`, `Deconstruct`) remain unconditionally forbidden — hand-writing any of them is still GS0232. A user-declared `ToString` is now permitted, but only if it exactly matches the synthesized member's shape: `public string ToString()`, zero parameters, returns `string`, not `static`/`async`/`unsafe`, no type parameters. A declaration with the name `ToString` that does not match this shape (wrong arity, wrong return type, `async`, generic, non-`public`) is rejected with the new diagnostic **GS0487** ("incompatible `ToString` override") rather than GS0232, since the intent is clearly to override `ToString` but the shape is invalid.

When a compatible user `ToString` is present:

- The synthesizer skips emitting `EmitDataStructToString`; the emitter's row planner (`PlanClassMethods`/`PlanStructMethods`) reserves 6 `MethodDef` rows instead of 7 to keep row-count planning in lockstep.
- The user's `ToString` reuses the same vtable slot the synthesized version would have used (`ReuseSlot`, not `NewSlot`) — for both `data class` and `data struct` — so polymorphic dispatch through a base-typed reference still resolves to the most-derived override, exactly as if the compiler had synthesized it. `MethodInfoHelpers.RequiresVirtualOnValueType` is bypassed for this case so a `data struct`'s user `ToString` is still marked `Virtual` (data structs' synthesized members are already virtual-callable via `Equals`/`GetHashCode`, so this is consistent).
- `Final`-ness follows the same rule as the synthesized object overrides: the slot remains non-final because sealed data classes and value types already prevent derivation, while open data classes must allow a derived data class to re-override it and call `base.ToString()`.

**Deferred/out of scope, not fixed by this amendment:**

- A receiver-clause (`func (p T) ToString() string`) declaration never reaches this new check at all, for an owned data type or an imported one alike: [ADR-0182](0182-receiver-clause-is-always-extension.md) (2026-09-15) made a receiver clause unconditionally an extension function, regardless of whether the package owns `T`, retiring the GS0314 warning this paragraph originally described for the owned case. Only the in-body form reaches the reservation logic now — consistent with G#'s extension-function design (extension functions cannot participate in virtual dispatch), not a defect.
- Plain (non-`data`) classes' hand-written `ToString` overrides still always get a new vtable slot unless the G# `override` keyword resolves against a matching base declaration; this pre-existing limitation is unrelated to data types and is not addressed here.

## Amendment 2026-07-20: zero-field `data class`/`data struct` support (#2363)

Issue #2363 found that `cs2gs` translates a C# `record Name();` / `record struct Name();` (an explicit-but-empty positional parameter list) into a G# `data class Name() {}` / `data struct Name() {}` — but the binder unconditionally rejected any `IsData` declaration with zero bound fields (`GS0104`), and misreported the kind as "struct" even for a rejected `data class`. This blocked migrating Oahu's `Oahu.Cli.App` challenge hierarchy: `MfaChallenge()`, `CvfChallenge()`, and `ApprovalChallenge()` are all empty positional records that only override a base `Kind` property, and have no positional data of their own.

**The "at least one field" rule is removed, universally, for both `data class` and `data struct`.** A zero-field data type is a degenerate but well-defined case: every synthesized member still has a sensible, crash-free definition (below), and rejecting it forced users to give up record/data semantics (equality-by-type, `with`-copy, and the synthesized `Equals`/`GetHashCode`/`ToString`/`==`/`!=` contract) purely because the type happens to carry zero positional data — a real and common shape for "marker" record subtypes distinguished only by their runtime type or by non-positional (e.g. property-override) members.

Synthesized-member behavior for a zero-field data type:

1. `Equals(Name other)` / `Equals(object other)` — the field-by-field comparison loop has zero iterations, so any two non-null instances of the same concrete type are trivially equal (matching C# record/`record struct` semantics: an empty record's equality reduces to a runtime-type check).
2. `GetHashCode()` — `HashCode.Combine()` has no zero-argument overload, so a deterministic 32-bit FNV-1a hash of the declared type name is embedded as a fixed IL constant instead (stable across runs/processes, consistent with the "stable across runs" goal in Context above; distinct types get distinct hashes since the name differs).
3. `ToString()` — emits the fixed literal `"Name()"` directly (the general field-interpolation path indexes `fields[0]`, which does not exist).
4. `op_Equality` / `op_Inequality` — unchanged; still call `Equals`.
5. `Deconstruct` — **skipped entirely**, per the existing (previously unenforced) "Skipped for zero-field data structs" text in Decision item 6 above. A zero-`out`-parameter `Deconstruct()` has no meaningful arity to bind against future destructuring syntax, so emitting it would be dead weight. The method-row planner (`ReflectionMetadataEmitter.PlanClassMethods`/`PlanStructMethods`) reserves one fewer `MethodDef` row for a zero-field type (composes independently with the #2361 `ToString`-override row reduction — a zero-field type with a compatible user `ToString` reserves five rows total).

**A related latent crash was found and fixed while validating this relaxation.** `DataStructSynthesizer.GetSynthesisFields`'s fallback path (used when a type's `Fields` collection is empty) assumed every entry in `Properties` has a non-null `BackingField` — true for its only prior caller shape (anonymous-class-literal synthesis, where every property is auto-implemented). Relaxing the zero-field rejection newly exposed user-declared data types with empty `Fields` *and* non-empty `Properties` containing a computed/override property with no backing field (e.g. `public override string Kind => "mfa";`), which pushed a `null` `FieldSymbol` into the synthesis-fields array and crashed field-token resolution with `ArgumentNullException`. Fixed by filtering `Properties` for `BackingField != null` — matching C# record semantics, where only auto/positional members participate in synthesized equality, never a computed/override property.

**Deferred/out of scope, not fixed by this amendment:**

- Leaf-type-only equality for an `open` base type with derived data-type siblings is a pre-existing limitation independent of zero-field support: `Equals(Name other)` dispatches on the *declared* type of the typed overload, so two different sibling data types (e.g. `MfaChallenge` vs. `CvfChallenge`) are never equal to one another even when both are zero-field, which matches C# record semantics (sibling record types are never equal) and is not a new gap introduced here.
- **Superseded translator limitation:** at the time of this amendment, `cs2gs` downgraded an abstract/open base record with only property overrides and no positional data (e.g. Oahu's `CallbackChallenge` with an abstract `Kind` property) to a plain class. Subsequent zero-field record support (#2363) preserves that shape as an abstract `data class`; the 2026-10-04 amendment below additionally preserves its native `IEquatable[Self]` contract. The old downgrade is not the current mapping.

## Amendment 2026-10-04: inherited typed equality and declared interfaces (#4777, #4675)

Structural equality includes inherited data fields regardless of the caller's
static type. A data class declares a compiler-owned virtual `bool Equals(Self?
other)` slot (final on a non-extensible class). A derived data class also declares
`public final override bool Equals(Base? other)` for its direct data base's self
slot. That override dispatches through virtual object equality to the
most-derived structural comparison. The self comparison calls its direct base's
self comparison **nonvirtually**, then compares its own fields in declaration
order; making this base-field call virtual would recurse through the override.
Class equality operators use the same virtual self comparison after their
existing null checks. Runtime-type discrimination, zero-field behavior and
value-data field comparison remain intact.

The immediate-base decision is shared for source data bases and imported record
bases. Imported data/record semantics must first be recognized by the existing
assembly marker or C# record-shape detector; an ordinary CLR class's virtual
`Equals(Self)` alone is not a record contract. Such domain equality remains
inherited and is not called by synthesized self equality or given a forwarding
override. An imported record base uses its actual declared virtual `Equals(Base)` slot:
receiver-aware projection supplies the parameter contract, and the existing
member-reference emitter retains the symbolic generic owner. The self comparison
calls that slot nonvirtually; the forwarding override explicitly implements the
same slot. This includes cross-assembly symbolic generic record bases without
changing imported-base admissibility or other record ABI features.
Imported parameter names are retained when present; absent optional CLR name
metadata uses the existing positional `arg{Position}` import fallback without
changing the signature or its nullability.

These signatures participate in ordinary member lookup, constructed-owner
projection, MethodDef row planning and implementation/reference assembly
emission. Typed parameters are named `other`: reference-data parameters admit
null, while value-data parameters are passed by value. Generic/nested owner
mapping and parameter nullability use the existing shared services.

Compiler-owned typed slots participate in the shared declared-member projection
used by normal calls, named arguments, method groups and completion, not only
interface conformance and emission. Imported CLR members retain their actual
signatures without additional synthetic duplicates.
Ordinary and class-constrained calls use the same receiver-aware declaring-owner
resolution as method groups, including lazy equality slots inherited from a
constructed source generic base; token resolution does not require those
constructed signatures to have their own open MethodDef cache entries.
The same projection includes the already synthesized `Equals(object? obj)`
override, so exposing typed equality does not hide object calls or object-typed
method groups. Its parameter name and nullability use the existing CLR
signature reader and parameter emitter, consistently in implementation and
reference images; its body is unchanged, and its virtual-slot finality follows
the sealed-owner exception in the October 7, 2026 amendment above.
Lazy equality signatures are materialized against source generic vectors before
emission reifies nested owners. Implementation/reference emission must leave
later source queries and repeated emits with the same declared generic shape.

A declared `IEquatable[Self]` is implemented by the compiler-owned self slot;
cs2gs preserves the interface advertised by the native record. This does **not**
add an interface to a G# data declaration that did not name it, nor satisfy a
wrong-self interface or an ordinary class without an implementation. GS0232
still reserves user-authored `Equals` members; no source override escape hatch
is introduced. Ordinary method virtuality remains governed by ADR-0017.
