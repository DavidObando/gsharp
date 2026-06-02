# ADR-0056: Span consumption v1 — ref-returning members, span element access, and closed generic value-type fields

- **Status**: Proposed
- **Date**: 2026-06-01
- **Phase**: Phase 8 — `ref struct` / `Span<T>` consumption (level 2 of issue #344)
- **Related**: #344 (consuming ref structs / `Span<T>` — level decision), #367 / #371 / #373 (binder, GS0219, user `ref struct` declaration + emit), #375 (generic value-type field layout fault), #376 (full ref-safe-to-escape, deferred), ADR-0039 (by-ref pointers `&`/`*`, `ByRefTypeSymbol`), ADR-0004 (type-erased generics)

## Context

Issue #344 framed `Span<T>` / `ref struct` support as a choice between three levels: (1) tolerate-only, (2) limited consumption, (3) full support with two-level escape analysis. Since then the building blocks for level 2 have landed independently:

- **ADR-0039** introduced managed by-ref pointers (`&x`, `*p`, `*T`), the `ByRefTypeSymbol` type, `BoundAddressOfExpression` / `BoundDereferenceExpression`, and per-argument `RefKind`. `ref`/`out` call sites work end-to-end (`Int32.TryParse("42", &result)` emits and runs — see `ByRefEmitTests`). ADR-0039 is marked *Proposed* but is implemented; diagnostics GS9001–GS9006 exist.
- **#367 / #371 / #373** added by-ref-like recognition (`TypeSymbol.IsByRefLike`), the GS0219 escape rules (no boxing, no non-ref-struct field, no closure capture, no async/iterator hoist, no generic type argument, no top-level global), and user-declared `ref struct` types emitted with `IsByRefLikeAttribute`.

What works today (verified empirically):

- A `ReadOnlySpan[T]` / `Span[T]` value as an ordinary local or parameter; `text.AsSpan()`, `.Slice(...)`, `.Length`, `.ToString()`.
- `[]T → ReadOnlySpan[T]` implicit conversion at **local-init** (`var span ReadOnlySpan[int32] = values` — `RefStructSpan.gs`), via the user-defined `op_Implicit` fallback in `Binder.BindConversion`.
- Passing an already-span-typed **local** as an argument (`f(span)`).
- A user `ref struct` with plain fields and with a nested **plain** (non-generic) `ref struct` field (`UserRefStruct.gs`).

What is blocked today (each reproduced against the current `main`):

1. **Span element access does not work.** The span indexer returns `ref readonly T` / `ref T`, which G# surfaces as a `ByRefTypeSymbol` (`System.Int32&`) and never dereferences in rvalue position:
   - `total + s[i]` → `GS0129: Binary operator '+' is not defined for types 'int32' and 'System.Int32&'`.
   - `span[0]` in value position binds but emits a malformed open methodref `System.T& ReadOnlySpan`1.get_Item(Int32)` → **`MissingMethodException`** at runtime (the element type is erased and the by-ref return is not loaded).
   - `Span[T]` element write `s[i] = 99` → `GS0116: type ... is not indexable`.
2. **`[]T → Span[T]` / `ReadOnlySpan[T]` conversion is not applied in argument position.** `sum(nums)` where `sum` takes `ReadOnlySpan[int32]` and `nums` is `[]int32` → `GS0154`, even though the identical conversion succeeds at local-init. Argument coercion / overload applicability uses `Conversion.Classify` (which returns `None` for slice→span) and never reaches the `op_Implicit` fallback that `BindConversion` uses.
3. **A user `ref struct` embedding a closed constructed generic value-type field faults at runtime (#375).** `type Window ref struct { data ReadOnlySpan[int32] }` constructs and compiles, but reading `w.data.Length` throws **`AccessViolationException`**. The constructed generic value type in field position is laid out under the type-erased generics model (ADR-0004) rather than with its real, closed layout, so the field has the wrong size and the CLR corrupts the stack.

These three gaps are exactly what keeps level 2 from delivering value: a span you cannot index, cannot pass a slice into, and cannot embed is barely usable. They share one root theme — **G# can name `ref struct` and by-ref types but cannot yet flow values through ref-returning members or lay out closed generic value types** — so they are best decided together.

Constraints that bound the solution:

- **CLR rules.** `ref struct` values are stack-only; a `ref T` returned by an indexer is a managed pointer that must be consumed in place (load via `ldobj`, store via `stobj`) and must not outlive its referent.
- **Go-flavored surface.** ADR-0039 deliberately requires `&` to *take* an address and `*` to *dereference a pointer the user holds*. Forcing `*span[i]` for every read would be noisy and breaks the "a span looks like an array" intuition.
- **Type erasure boundary (ADR-0004).** Open type parameters and type-parameter-bearing generics erase to `System.Object`. Closed constructed generic value types (`ReadOnlySpan[int32]`, `Nullable[int32]`, etc.) have a real, knowable layout and cannot be erased when they sit in field position — and `ref struct` fields can never be boxed as the erasure path assumes.

## Decision

Adopt **level 2 (limited consumption)** as "Span consumption v1," scoped to the three gaps above plus a documentation correction. Defer level 3 (full ref-safe-to-escape) to #376.

### 1. Ref-returning members auto-dereference in rvalue position

When a member access, call, or indexer resolves to a CLR member whose return type is `T&` (byref) — i.e. its bound type is a `ByRefTypeSymbol` — and it appears in an **rvalue** context, the binder wraps it in a `BoundDereferenceExpression` so its observable type is the pointee `T`.

```gsharp
var x = span[i]      // get_Item returns `ref readonly int32`; x : int32
total = total + s[i] // s[i] auto-dereferences to int32
```

This reuses ADR-0039's `BoundDereferenceExpression` (no new bound-node kind). The rule is asymmetric and intentional:

- **Taking** an address still requires explicit `&` (ADR-0039 unchanged).
- **Reading** a ref *return* auto-dereferences, because a ref return in rvalue position has exactly one meaning — read the referent — and there is no ergonomic reason to make the user write `*`.

The rule is general, not span-specific: it also fixes `System.Runtime.InteropServices.CollectionsMarshal`-style ref getters and any value-type member returning `ref`/`ref readonly`.

### 2. Span element read and write

`span[i]` on `ReadOnlySpan[T]` or `Span[T]` binds to the `get_Item` indexer (which returns `ref readonly T` / `ref T`):

- **Read** (both span kinds): bind the indexer call, then auto-dereference per §1. Emit the `get_Item` methodref over the **closed** constructed generic (element type *not* erased), then `ldobj T` to load the value.
- **Write** (`Span[T]` only): `span[i] = v` binds the `get_Item` call to obtain the `ref T`, evaluates `v`, and stores through the pointer with `stobj T`. Writing through a `ReadOnlySpan[T]` element is a hard error (its indexer is `ref readonly`) — see §Diagnostics.

`GS0116 ("not indexable")` no longer fires for spans; spans become indexable.

### 3. `[]T → Span[T]` / `ReadOnlySpan[T]` conversion in argument position

Argument coercion and overload applicability must consider the same user-defined `op_Implicit` fallback that `Binder.BindConversion` already uses, so a `[]T` argument binds to a `Span[T]` / `ReadOnlySpan[T]` parameter exactly as it does at local-init. The conversion ranks as a standard user-defined implicit conversion — below identity, and worse than an exact span-typed argument — so existing overload resolution is not disturbed.

### 4. Closed constructed generic value-type fields get real layout (#375)

The type-erasure boundary is tightened: a field whose type is a **closed** constructed generic value type (no in-scope type parameters; e.g. `ReadOnlySpan[int32]`, `Nullable[int32]`) is emitted with its real `GenericInstantiation(openDef, args, isValueType: true)` signature — never erased to `System.Object`. Erasure (ADR-0004) continues to apply only to open, type-parameter-bearing types (`T`, `List[T]`, `func(T) U`). `EncodeClrType` already encodes constructed generic value types correctly (the `IsConstructedGenericType` path); the fix is to route generic value-type **field** signatures through that path instead of the erased-object path, so the emitted field has the correct size and layout.

This is a targeted emitter fix, but it is captured here (rather than as a bare bug) because it *decides where erasure stops* — a design boundary that interacts with ADR-0004 — and because it is a prerequisite for embedding spans in user `ref struct` types.

### Scope boundaries (explicitly out of v1)

- Returning `ref` / `ref struct` from G# functions (`func f() *T { ... }`), the `scoped` and `[UnscopedRef]` modifiers, and the full two-level ref-safe-to-escape analysis — all remain deferred to **#376**.
- `stackalloc`, stack-allocated span buffers, `MemoryMarshal`, unmanaged pointers / `unsafe` — out of scope (ADR-0039 §Follow-ups).
- Generic user `ref struct` declarations over an *open* element type (`type Buffer[T] ref struct { data ReadOnlySpan[T] }`) — open generic value-type field layout is a separate, larger problem; v1 supports only **closed** generic value-type fields.
- Auto-dereference of ref *parameters* — still require `&` (ADR-0039 unchanged).

## Consequences

**Unlocked:**

- Real buffer-style consumption: read and write span elements, iterate a span by index, pass a `[]T` slice straight into a span-typed BCL or user API, and embed a closed generic span in a user `ref struct` (the `Window` example runs instead of faulting).
- A clean, teachable surface rule: **ref returns auto-dereference in rvalue position; taking an address requires `&`.** This generalizes beyond spans to every ref-returning CLR member.
- The type-erasure boundary is now stated precisely (closed value-type generics in field position carry real layout), removing a class of `AccessViolationException` faults that is not limited to spans.

**Constrained / foreclosed:**

- §1's auto-deref rule is now load-bearing; #376's eventual ref-return support must compose with it (a ref return that the user wants to *keep* as a pointer, rather than read, will need explicit syntax — likely `&`-free because the declared return type already says `*T`).
- §4 commits ADR-0004's erasure model to "open-only"; any future reified-generics work inherits this boundary as already-true for value-type fields.

**Safety / escape analysis:** auto-dereferenced span reads produce plain `T` copies (no new escape vector). A span element write consumes the `ref T` immediately at the `stobj` site and never binds it to a local, so no ref-local lifetime is created — consistent with ADR-0039's "by-ref values cannot escape their declaring scope" and not requiring the #376 machinery.

**Diagnostics:** a new code **GS0226** — "cannot assign through a read-only span element (`ReadOnlySpan[T]` is read-only)" — covers writes to a `ReadOnlySpan[T]` element. (`GS0226` is the next free code after the GS0220–GS0225 interpolation block.) Per the diagnostics convention, `docs/diagnostics.md` must document GS0226, and the GS0116 span case must be removed there.

**Process:** §1/§2 reuse `BoundDereferenceExpression` (no new `BoundNodeKind`), and span indexing reuses the existing index syntax (no new `SyntaxKind`), so the coverage matrix (`test/Core.Tests/CoverageMatrix/coverage-matrix.golden.txt` + `docs/coverage-matrix.md`) needs no enum additions. New conformance samples (a span-indexing sample, plus a `Window`-style `ReadOnlySpan[int32]`-in-`ref struct` sample) with sibling `.golden` files are required, since those are the executable spec.

**Doc correction (low cost, bundled):** ADR-0039 is flipped from *Proposed* to *Accepted* (it is implemented and tested), and `clr-interop.md` documents the implemented by-ref `&`/`*` surface and the new span-consumption rules.

## Alternatives considered

### A. Require explicit `*span[i]` to dereference span elements

Treat the indexer result as a `*T` the user must dereference (`*span[i]`, `*s[i] = v`).

**Pros:** uniform with ADR-0039's "the user always writes `*` to dereference"; zero magic.
**Cons:** every span read becomes `*span[i]`, which is noisy and breaks the array intuition that makes spans approachable. The `*s[i] = v` write form is especially alien. **Rejected** — the asymmetry (auto-deref ref *returns*, explicit `&` for ref *parameters*/address-taking) is the better trade and still unambiguous.

### B. Implement level 3 (full escape analysis) now

Do the complete ref-safe-to-escape / `scoped` / `UnscopedRef` model from C# 11 before shipping any consumption.

**Pros:** one comprehensive feature; no interim rules.
**Cons:** #376 is a large, self-contained workstream; gating everyday span consumption behind it delays the high-value 80% indefinitely. **Rejected** — v1 delivers consumption; #376 hardens lifetimes later.

### C. Special-case only `Span<T>` / `ReadOnlySpan<T>`

Hard-code span indexing rather than the general ref-returning-member auto-deref of §1.

**Pros:** smaller surface to reason about.
**Cons:** misses other ref-returning BCL members (`CollectionsMarshal.GetValueRefOrNullRef`, `ref` property getters on value types) and creates a one-off path that the next ref-returning API would have to special-case again. **Rejected** — the general rule is simpler and pays for itself immediately, exactly as ADR-0039 argued for general by-ref over per-call-site hacks.

### D. Keep erasing generic value-type fields to `System.Object` and box

Leave ADR-0004 erasure untouched and box the span into the field.

**Cons:** `ref struct` values cannot be boxed by definition (the entire reason they exist), and erasure is precisely what produces the `AccessViolationException` in #375. Closed value types have a real layout that the emitter already knows how to encode. **Rejected** — there is no correct erased representation for a `ref struct`-bearing field.

## Follow-ups

- **#376** — full ref-safe-to-escape (`scoped`, `[UnscopedRef]`, ref returns from G# functions, assignment/return escape diagnostics). The §1 auto-deref rule and §4 layout decision are designed to compose with it.
- **Open generic `ref struct` declarations** (`type Buffer[T] ref struct { data ReadOnlySpan[T] }`) — open generic value-type field layout, broader than v1's closed-only support.
- **`stackalloc` / stack buffers / `MemoryMarshal`** — high-performance span creation, a separate ADR.
- **`Utf8JsonReader` end-to-end** — once §1–§4 land, re-evaluate the originally-motivating ref-struct JSON reader path from #344 as a conformance target.
