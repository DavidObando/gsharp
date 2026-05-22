# ADR-0016: Slice backing storage — `T[]` (single-dimensional zero-based array)

- **Status**: Accepted
- **Date**: 2026-05-22
- **Phase**: Phase 3 (locked at 3.A.2)
- **Related**: gaps doc §3.A; execution plan §3.A.2; ADR-0003 (OO surface)

## Context

GSharp's slice type `[]T` (Phase 3.A.2) must be lowered to *some* CLR representation. The three candidates are:

| Option | Pros | Cons |
| --- | --- | --- |
| **A. `T[]` (CLR array)** | Heap-allocated, GC-tracked, can be returned from functions, stored in fields, captured by closures, passed across assembly boundaries without ceremony. `len`/`cap` map directly to `array.Length`. Trivial signature encoding (`SZArray` token). Mature ecosystem support. | Fixed capacity — `append` always allocates a new array when growing (no amortized doubling without an explicit `cap` distinct from `len`). |
| **B. `Span<T>` / `ReadOnlySpan<T>`** | Zero-allocation views; lifetime safety; fast slicing. | `ref struct` — cannot be returned from `async`, stored in fields, captured by closures, boxed, or used as type arguments. Requires escape analysis to know when a slice is safe to lower this way. Cross-assembly slice exchange forces a switch back to `T[]`. |
| **C. Hand-rolled `Slice<T>` (ptr + len + cap)** | Faithful Go semantics including amortized `append` and `s[lo:hi:max]` triple slices. | Whole new BCL surface to design, document, and version. Doesn't compose with imported CLR APIs that consume `T[]` / `IEnumerable<T>`. |

Phase 3.A.2 also defines (and Phase 3 ships) `len(s)` / `cap(s)` / `append(s, e)`. Slice-of-slice (`s[lo:hi]`) and the three-index form (`s[lo:hi:max]`) are explicitly *not* in Phase 3.

## Decision

**Slices are lowered to `T[]` — a CLR single-dimensional zero-based array — for every storage form** (locals, fields, parameters, return values, captured variables).

- `len(s)` and `cap(s)` both lower to `array.Length` for the Phase 3 surface; `cap` exists as a separate built-in so that Phase 4+ can introduce a distinct underlying representation without breaking source. Today the two are observably aliases — documented as such.
- `append(s, e)` performs one allocation per call: it constructs a new `T[len(s)+1]`, copies via `System.Array.Copy`, writes the new element at index `len(s)`, and returns the new array. The original slice is unchanged.
- Slice literals `[]T{e0, e1, …}` lower to `new T[N]` followed by per-element store.
- Signature encoding uses the same `SZArray` token already used for fixed-length arrays (`[N]T`); fixed-length-vs-slice is a *front-end* distinction (different `TypeSymbol` subclasses), not a CIL distinction.

## Consequences

Positive:

- Trivial round-trip with the entire .NET BCL: a GSharp slice IS a `T[]`, so it satisfies `IEnumerable<T>`, `IReadOnlyList<T>`, `Span<T>` (implicit), and every C# method that accepts an array.
- Closures, async, returns, fields — everything works without escape analysis.
- Single emit path for both `[N]T` and `[]T`. The fixed-length form merely refuses `append`, gives a constant `cap`, and rejects literals whose element count differs from `N`. (Front-end work only.)
- Lays the groundwork for Phase 4 generics: `Slice[T]` as a generic alias for `T[]` falls out automatically.

Negative:

- `append` in a loop is O(n²) without an amortized capacity. Go's `append` doubles. Documenting `cap` as "aliases length for now" lets us add the doubling later (Phase 5 or 6) by introducing a backing struct (Option C above) without changing the surface — the cost is breaking ABI for any code that has stored slices in published .NET fields.
- Slice expressions (`s[lo:hi]`) cannot reuse the underlying storage. When Phase 3 adds them they will allocate a new array. (`Span<T>`-style aliased subranges become available only if Option B is added later for the locals-only case.)
- `cap` is observably equal to `len` for now. Users who write `cap(s) != len(s)` for Go-compatible code will observe different behavior — the gaps doc must flag this.

Neutral:

- A future ADR may introduce a hybrid lowering: keep `T[]` for fields/return values/captured variables, switch to `Span<T>` for locals that demonstrably don't escape. That ADR would supersede this one. Phase 3 deliberately picks one form to avoid the escape-analysis bootstrapping problem.

## Alternatives considered

- **`Span<T>` for locals + `T[]` for everything else** (Option B-hybrid): rejected for Phase 3 because the escape analysis isn't built yet and would block 3.A.2 indefinitely. Re-openable as a follow-up ADR.
- **Hand-rolled `Slice<T>` struct** (Option C): rejected because the cross-language ergonomics regress (every C# caller has to learn the new type) and the Phase 3 sample surface doesn't exercise enough of Go's slice semantics to justify the engineering.
- **Lower `cap` to a constant `0`**: rejected; users porting Go code will read `cap` and expect a length-like number. Aliasing to `len` is the least-surprising lie.
