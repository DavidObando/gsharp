# ADR-0056: Span consumption v1 — ref-returning members, span element access, and closed generic value-type fields

- **Status**: Accepted
- **Date**: 2026-06-01
- **Amended**: 2026-06-01 — §4's root-cause analysis was corrected after implementation (#382); the closed generic value-type field layout was already emitted correctly, and the #375 fault was a separate value-type receiver address-of bug. The §4 *invariant* stands; see [Amendment](#amendment-2026-06-01-4-root-cause-correction).
- **Amended**: 2026-06-13 — references to the ADR-0004 "type-erased generics" boundary are **superseded by ADR-0087 R1–R7** (all implemented). All generic shapes — open and closed, value and reference — now emit reified CLR metadata; the carve-out for closed value-type generic fields described in §4 is no longer a special case (everything carries real metadata) but the §4 *invariant* still holds.
- **Phase**: Phase 8 — `ref struct` / `Span<T>` consumption (level 2 of issue #344)
- **Related**: #344 (consuming ref structs / `Span<T>` — level decision), #367 / #371 / #373 (binder, GS0219, user `ref struct` declaration + emit), #375 (generic value-type field layout fault), #376 (full ref-safe-to-escape, deferred), ADR-0039 (by-ref pointers `&`/`*`, `ByRefTypeSymbol`), ADR-0004 (generics scope; the original "type-erased" framing is superseded by ADR-0087), ADR-0087 (reified-generics emit — R1–R7 implemented)

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
3. **A user `ref struct` embedding a closed constructed generic value-type field faults at runtime (#375).** `ref struct Window { data ReadOnlySpan[int32] }` constructs and compiles, but reading `w.data.Length` throws **`AccessViolationException`**. *(Diagnosis corrected during implementation — see [Amendment](#amendment-2026-06-01-4-root-cause-correction): the field is in fact laid out correctly; the fault is a value-type receiver address-of bug, not erasure. The underlying ADR-0004 erasure framing is itself superseded by ADR-0087 R1–R7.)*

These three gaps are exactly what keeps level 2 from delivering value: a span you cannot index, cannot pass a slice into, and cannot embed is barely usable. They share one root theme — **G# can name `ref struct` and by-ref types but cannot yet flow values through ref-returning members or lay out closed generic value types** — so they are best decided together.

Constraints that bound the solution:

- **CLR rules.** `ref struct` values are stack-only; a `ref T` returned by an indexer is a managed pointer that must be consumed in place (load via `ldobj`, store via `stobj`) and must not outlive its referent.
- **Go-flavored surface.** ADR-0039 deliberately requires `&` to *take* an address and `*` to *dereference a pointer the user holds*. Forcing `*span[i]` for every read would be noisy and breaks the "a span looks like an array" intuition.
- **Type erasure boundary (ADR-0004; superseded by ADR-0087 R1–R7).** As written in 2026-06-01, open type parameters and type-parameter-bearing generics erased to `System.Object`. Closed constructed generic value types (`ReadOnlySpan[int32]`, `Nullable[int32]`, etc.) had a real, knowable layout and could not be erased when they sat in field position — and `ref struct` fields can never be boxed as the erasure path assumed. (Under the reified emit this carve-out is general: every generic shape carries real metadata, but the §4 invariant still holds.)

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

> **Amended (#382):** The premise below — that #375 faulted because the field was *erased* to `System.Object` — proved incorrect at implementation time. The field was already emitted with its real `valuetype ReadOnlySpan`1<int32>` signature; the actual fault was a value-type-receiver address-of bug in the emitter. The decision still holds as a stated invariant (closed generic value-type fields carry real layout, never erased), and is now locked in by a regression test, but it required *no* field-signature change. See the [Amendment](#amendment-2026-06-01-4-root-cause-correction) for the corrected analysis.

The type-erasure boundary is tightened *(historical framing — superseded by ADR-0087 R1–R7)*: a field whose type is a **closed** constructed generic value type (no in-scope type parameters; e.g. `ReadOnlySpan[int32]`, `Nullable[int32]`) is emitted with its real `GenericInstantiation(openDef, args, isValueType: true)` signature — never erased to `System.Object`. As originally written, erasure (ADR-0004) continued to apply only to open, type-parameter-bearing types (`T`, `List[T]`, `func(T) U`); under ADR-0087 the open-shape erasure is also gone end-to-end. `EncodeClrType` already encoded constructed generic value types correctly (the `IsConstructedGenericType` path), and — as #382 confirmed — generic value-type field signatures already flowed through that path; the emitted field has the correct size and layout.

This boundary is captured here (rather than as a bare bug) because it *decided where erasure stopped* — a design boundary that interacted with ADR-0004 (now superseded by ADR-0087) — and because correct closed generic value-type field layout was a prerequisite for embedding spans in user `ref struct` types.

### Scope boundaries (explicitly out of v1)

- Returning `ref` / `ref struct` from G# functions (`func f() *T { ... }`), the `scoped` and `[UnscopedRef]` modifiers, and the full two-level ref-safe-to-escape analysis — all remain deferred to **#376**.
- `stackalloc`, stack-allocated span buffers, `MemoryMarshal`, unmanaged pointers / `unsafe` — out of scope (ADR-0039 §Follow-ups).
- Generic user `ref struct` declarations over an *open* element type (`ref struct Buffer[T] { data ReadOnlySpan[T] }`) — open generic value-type field layout is a separate, larger problem; v1 supports only **closed** generic value-type fields.
- Auto-dereference of ref *parameters* — still require `&` (ADR-0039 unchanged).

## Consequences

**Unlocked:**

- Real buffer-style consumption: read and write span elements, iterate a span by index, pass a `[]T` slice straight into a span-typed BCL or user API, and embed a closed generic span in a user `ref struct` (the `Window` example runs instead of faulting).
- A clean, teachable surface rule: **ref returns auto-dereference in rvalue position; taking an address requires `&`.** This generalizes beyond spans to every ref-returning CLR member.
- The type-erasure boundary is now stated precisely (closed value-type generics in field position carry real layout) and locked in by a regression test, foreclosing a class of layout-erasure faults — though the specific #375 fault turned out to be an emitter receiver bug rather than erasure (see [Amendment](#amendment-2026-06-01-4-root-cause-correction)). *(Note: the surrounding "type-erasure" framing is superseded by ADR-0087 R1–R7; the invariant still holds.)*

**Constrained / foreclosed:**

- §1's auto-deref rule is now load-bearing; #376's eventual ref-return support must compose with it (a ref return that the user wants to *keep* as a pointer, rather than read, will need explicit syntax — likely `&`-free because the declared return type already says `*T`).
- §4 commits ADR-0004's erasure model to "open-only"; any future reified-generics work inherits this boundary as already-true for value-type fields. *(Status update: ADR-0087 R1–R7 superseded ADR-0004's erasure model; the "open-only" carve-out is moot under the reified emit, but the §4 invariant — closed value-type generic fields carry real layout — still holds.)*

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

### D. Keep erasing generic value-type fields to `System.Object` and box *(superseded option, against the ADR-0087 R1–R7 reified model)*

Leave ADR-0004 erasure untouched (the erasure boundary as written in ADR-0004 was itself superseded by ADR-0087 R1–R7) and box the span into the field.

**Cons:** `ref struct` values cannot be boxed by definition (the entire reason they exist), and an erased field would have the wrong size and layout. Closed value types have a real layout that the emitter already knows how to encode — and, as #382 found, already emits. **Rejected** — there is no correct erased representation for a `ref struct`-bearing field. *(Note: the original claim that erasure was the actual cause of #375's `AccessViolationException` was incorrect; see [Amendment](#amendment-2026-06-01-4-root-cause-correction). The rejection still stands — erasing such a field would be wrong regardless. Under the reified emit (ADR-0087 R1–R7, superseded the ADR-0004 erasure model) no field of any shape is erased; the option remains moot.)*

## Follow-ups

- **#376** — full ref-safe-to-escape (`scoped`, `[UnscopedRef]`, ref returns from G# functions, assignment/return escape diagnostics). The §1 auto-deref rule and §4 layout decision are designed to compose with it.
- **Open generic `ref struct` declarations** (`ref struct Buffer[T] { data ReadOnlySpan[T] }`) — open generic value-type field layout, broader than v1's closed-only support.
- **`stackalloc` / stack buffers / `MemoryMarshal`** — high-performance span creation, a separate ADR.
- **`Utf8JsonReader` end-to-end** — once §1–§4 land, re-evaluate the originally-motivating ref-struct JSON reader path from #344 as a conformance target.

## Amendment 2026-06-01: §4 root-cause correction

During implementation of §4 (PR #382, fixing #375) the documented root cause turned out to be wrong, so this amendment records the corrected analysis. The design decision and its invariant are unchanged; only the *diagnosis* and the *nature of the fix* are corrected.

**What the ADR originally claimed.** That `ref struct Window { data ReadOnlySpan[int32] }` faulted with `AccessViolationException` because the closed constructed generic value-type field was laid out under the ADR-0004 type-erased model (erased to `System.Object`), giving the field the wrong size and corrupting the stack. §4 therefore proposed "routing generic value-type field signatures through the constructed-generic path instead of the erased-object path." *(The framing here is historical; ADR-0004's erasure model is superseded by ADR-0087 R1–R7.)*

**What was actually true.** The field signature was already correct. The emitted metadata shows the real value type, no `ClassLayout` row, and the correct `IsByRefLikeAttribute`:

```il
.field public valuetype [System.Private.CoreLib]System.ReadOnlySpan`1<int32> Demo.Window::data
```

The fault was a separate emitter bug in the **instance-method receiver load**. Calling an instance method on a value type requires a managed pointer (`this`). `EmitInstanceReceiver` only took the *address* of a value-type receiver (`ldflda`) when that receiver was a `BoundVariableExpression`; a `BoundFieldAccessExpression` receiver (`w.data`) fell through to `ldfld`, pushing the struct *by value* and reinterpreting its bits as the `this` pointer. `ilverify` pinpointed it:

```
[StackUnexpected] [found value 'ReadOnlySpan`1<int32>'] [expected address of 'ReadOnlySpan`1<int32>']
```

**The actual fix.** A one-line behavioral change in `EmitInstanceReceiver` (`ReflectionMetadataEmitter.cs`): load a value-type field-access receiver by address (`ldflda`, via the existing `EmitFieldAddress`) instead of by value. No field-signature or type-erasure code was touched. *(Type-erasure framing is superseded by ADR-0087 R1–R7.)*

**Why §4 still stands.** The decision — *closed constructed generic value-type fields carry their real layout and are never erased to `System.Object`* — remains a correct and now-tested invariant of the emitter; #382 added a regression test asserting the field is the real `System.ReadOnlySpan<int>` value type (not `System.Object`) and that the receiver opcode is `ldflda`. The boundary §4 draws around ADR-0004 erasure (open-only) is *now subsumed* by ADR-0087's reified emit (no erasure at all, open or closed). What changed is that this invariant was already upheld by the existing signature path, so realizing #375's fix required no change there — the corrective work was entirely in receiver emission. *(Note: the surrounding "erasure" framing is superseded by ADR-0087 R1–R7.)*

**Lesson for future ADRs.** The erasure hypothesis was plausible but unverified against emitted IL. Reproducing the fault under `ilverify` before settling on a cause would have caught this earlier; ADRs that assert an emitter root cause should cite IL/`ilverify` evidence. *(The erasure model itself is superseded by ADR-0087 R1–R7.)*
