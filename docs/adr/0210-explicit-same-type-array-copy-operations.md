# ADR-0210: Array copy operations and fixed-array value evaluation

- **Status**: Proposed
- **Date**: 2026-10-23
- **Phase**: Proposed design with a bounded, fixture-only feasibility prototype.
  No shipped compiler, runtime, translator or SDK-pin change.
- **Issue**: [#5208](https://github.com/DavidObando/gsharp/issues/5208),
  evaluation follow-up [#5221](https://github.com/DavidObando/gsharp/issues/5221),
  executable feasibility [#5224](https://github.com/DavidObando/gsharp/issues/5224),
  part of [#4333](https://github.com/DavidObando/gsharp/issues/4333)
- **Related**: [ADR-0191](0191-go-to-gsharp-migration-tool.md) sections 1.1,
  6.1, 7 and 12,
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md),
  [ADR-0188](0188-heap-storable-managed-references.md),
  [ADR-0205](0205-native-protocols-with-type-preserving-values.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0015](0015-multi-target-assignment.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [Withdrawn ADR-0206](0206-explicit-snapshot-and-selected-location-receivers.md)

This record evaluates fixed-array values and proposes an explicit-copy
contract as the compatible baseline. A merge accepts neither proposal.
The maintainer approves semantics, and a
separate implementation issue, release and N-1 pin change follow only after
that approval.

## Context

### The request

The maintainer asked for an explicit operation that produces a copy of an
existing fixed array, with the result in the same existing type. The
illustrative spelling is hypothetical:

```gsharp
var frame [2]float64 = [2]float64{0.25, 0.75}
var copy = frame.(value) // produces a value copy of frame
copy[0] = 1.0
var frames = slice[[2]float64]{frame, copy}
frames[0][1] *= 0.5
```

The intended outcome is:

| Observation | Value | Reason |
| --- | --- | --- |
| `frame` | `{0.25, 0.375}` | `frames[0]` is `frame`: ordinary G# element insertion shares the array |
| `copy` | `{1.0, 0.75}` | The copy has independent element storage |
| static type of `copy` | `[2]float64` | Same existing type, not a new category |

In that original operation-only proposal, ordinary sharing stays.
`b = a`, argument passing, returns, struct fields,
slice-literal elements and generic slots continue to copy the array
reference. The request is about an operation, not a change in what `[N]T`
means. The follow-up request asks whether changing that meaning is preferable.

An earlier internal investigation conditionally preferred a new value-array
type such as `value [N]T`. A second investigation reversed that ranking: the
example needs one operation over the existing type, and no new type is
necessary for that operation. The maintainer subsequently authorized a serious
evaluation of making existing `[N]T` assignments and swaps Go-like values.
Section 8 evaluates that breaking alternative without treating the earlier
ranking as settled. It does not authorize a shipped feature or semantic acceptance.
Audio layout remains a separate workload gate.

### Why fixed arrays, not all buffer types?

Go arrays contain element values. Current G# `[N]T` instead retains a CLR
array reference. This is the gap under evaluation. G# `[]T` / `array[T]`
deliberately means CLR `T[]`, not Go `[]T`; it remains the interop anchor.
Native `slice[T]` already copies a descriptor while sharing outer element
storage ([ADR-0190](0190-native-slices-and-clr-array-interoperability.md)).
That resembles Go slices, but does not establish full Go equivalence.
Native default descriptors are usable empty values and cannot compare to
`nil`; Go has nil slices. See the specification's
[native slice contract](../../website/docs/ref/spec.md#native-shared-storage-slices).

The proposed inner value boundary must compose with that outer sharing:
copying `slice[[N]T]` still shares its buffer, reading an element as a value
copies the fixed array, and assigning an element stores into its selected
location. `frames[i][j] += rhs` must write through that location, not a
temporary element copy. This evaluation does not redesign `[]T`, native
slices or their general Go mapping. Views over value-backed arrays require
the separate lifetime decision in section 8.

### Current behavior that the contract must respect

- **Source length identity.** `[N]T` keeps its length beside the erased CLR
  `T[]` through conversions, generic arguments and projected member slots.
  `[3]int32` does not convert implicitly to `[4]int32`, and
  `List[[3]int32]` differs from `List[[4]int32]`. See the specification's
  "Arrays and slices" section.
- **Length lenience.** An explicit `cast[[N]T](...)` reinterprets and does not
  resize or validate. An array recovered from imported metadata converts to
  any `[N]T`. A value whose static type is `[3]int32` can therefore have a
  physical `Length` of 2.
- **Zero values.** An initializer-less `var a [N]T` declaration slot is a
  zeroed length-`N` array, including struct fields that receive synthesized
  initializers. Array or slice elements of collection type keep the CLR
  default (`nil`), and `= default` keeps its CLR meaning.
- **CLR members.** `Array.Clone()` makes a shallow copy with the same runtime
  type and returns `object`
  ([.NET API](https://learn.microsoft.com/en-us/dotnet/api/system.array.clone?view=net-10.0)).
  `Array.Copy` writes into existing storage and tolerates overlap
  ([.NET API](https://learn.microsoft.com/en-us/dotnet/api/system.array.copy?view=net-10.0)).
- **Existing copy vocabulary.** Lowercase `.copy(...)` on data types produces
  a new value of the same type with shallow field copies; `s.copy()` on a data
  struct is the zero-override form. On other receivers, a call named `copy`
  goes through ordinary member and extension lookup. Arrays have no intrinsic
  `.copy` today: an extension named `copy` binds normally (P7), and without one
  `pair.copy()` reports `GS0159` (P8).
- **Grammar.** Postfix `.` starts a member continuation. `frame.(value)`
  reports `GS0005` at `(` (probe P5 below).
- **Native slices.** `slice[T].FromArray(a)` shares storage. `Clone()` and
  `ToArray()` copy shallowly. `CopyTo` copies the shorter logical length and is
  not an exact fixed-array assignment ([ADR-0190](0190-native-slices-and-clr-array-interoperability.md)).
  `Slice.Create` over an array element type yields `nil` element slots, and
  growth copies inner references. These are correct G# semantics.
- **Protocols.** A raw CLR array can be a native-protocol payload. The entry
  retains the array, and recovery returns that reference. Fixed-array protocol
  method-slot types are separately restricted
  ([ADR-0205](0205-native-protocols-with-type-preserving-values.md)).

### What existing source can already write

The shown example works today without a language change:

```gsharp
var frame [2]float64 = [2]float64{0.25, 0.75}
var copy [2]float64 = cast[[2]float64](frame.Clone())
copy[0] = 1.0
var frames = slice[[2]float64]{frame, copy}
frames[0][1] *= 0.5
```

An ordinary `Array`-constrained generic extension also keeps the exact
source type through inference:

```gsharp
import System

func (value T) CloneArray[T Array]() T {
    return cast[T](value.Clone())
}

var original = [2]int32{1, 2}
var independent = original.CloneArray() // [2]int32
```

That extension is research code. It is not a shipped API and not a proposal
to add one.

The existing idiom has three concrete costs:

1. The type is restated, and the cast is not checked against the receiver.
   `cast[[3]int32](pair.Clone())` compiles for a `[2]int32` receiver and gives
   a `[3]int32` value whose `Length` is 2. A wrong element type compiles and
   fails at run time with `InvalidCastException` (probe P6).
2. `Clone()` returns `object`, so the cast is mandatory and the result type
   does not follow the receiver.
3. G# ships no type-preserving copy. Each program writes its own helper or
   repeats the cast.

### Two operations, not one

A fresh copy and a store into an existing array are different operations.
This record uses two plan names for them. The names are vocabulary for this
document. They are not shipped APIs, selected intrinsics or proposed
spellings.

| Plan name | Meaning | Destination identity |
| --- | --- | --- |
| CopyNew | Allocate a new array and copy the receiver's element slots into it | New array |
| CopyInto | Copy element slots into an array that already exists | The existing array stays; views and element handles into it stay valid |

Go's canonical witness shows the difference:

```go
a := [2]int{1, 2}
b := a        // CopyNew
p := &a[0]
view := a[:]
a = [2]int{8, 9} // CopyInto: a keeps its storage
*p = 7
// a[0] == 7, view[0] == 7, b[0] == 1
```

CopyNew followed by rebinding `a` gives the wrong result: `p` and `view`
stay on the old array. CopyInto with `Array.Copy` gives the right result
(witnesses W2 and W3). The rebind failure shows that CopyNew alone does not
implement Go assignment to an existing variable. It does not show that a new
type is necessary.

Storage and performance are a third, separate concern. A copy operation
defines logical independence. It does not choose inline layout, remove inner
arrays or promise an allocation count.

## Decision

### 0. Recommendation after the value-array evaluation

Keep the explicit-copy proposal as the compatible, implementable baseline,
not as proof that fixed-array values are undesirable. Investigate a genuine
CLR value representation as the preferred candidate **if ordinary, including
uninstrumented generic, value copying is the approved goal**. The direct
source footprint is small enough to justify that investigation. It is not
evidence that a breaking release is safe.

Do not select automatic copying over the existing `T[]` representation as
a general solution. It can support a closed, instrumented lowering profile,
but uninformed CLR generic bodies and struct copies bypass its copy hooks.
Keeping the physical ABI would not solve that semantic problem.

There is no complete arbitrary-`N` value-array design yet. Canonical
cross-assembly carrier identity and owner-retaining escaping views are
blocking acceptance gates, not implementation details to assume away.
Section 8 records the alternatives, compatibility choices and evidence
needed to resolve them. If those gates fail, explicit CopyNew/CopyInto
remains a real outcome. No spelling or breaking semantics is accepted here.

### 1. Proposed semantic contract for a fresh same-type copy (CopyNew)

Whatever spelling is selected, the operation has these semantics. Section 2
ranks the spellings.

| Aspect | Proposed rule |
| --- | --- |
| Admitted receivers | A receiver whose static type is a single-dimensional array: `[N]T` or `[]T`, including element-nullable forms such as `[N]T?`. Rectangular arrays, native `slice[T]`, type parameters and `System.Array` are not admitted in this proposal. |
| Static result type | The receiver's static type symbol. `[2]float64` gives `[2]float64`; `[]T` gives `[]T`; element nullability, including platform elements (`[]T!`), and the retained spelling stay. The result is not a new type. The single exception is top-level platform nullability: a platform array receiver (`[]!T`, see Nullness) gives the non-platform `[]T`, because the copy is a fresh non-null array. |
| Runtime result | A newly allocated array with the receiver's exact runtime array type and physical `Length`. This matches `Array.Clone`. Under CLR array covariance, a `[]Base` receiver that holds a `Derived[]` produces a `Derived[]`. |
| Element copying | Shallow. Each element slot is copied as the CLR copies that slot. Value-type elements are copied by value. Reference elements, inner arrays of jagged arrays, slice descriptors and managed handles keep their sharing. No element is deep-copied. |
| Length | No validation and no repair. A `[3]int32` value with physical length 2 copies to a `[3]int32` value with physical length 2. A length-checked copy is a different operation and is not proposed. |
| Evaluation | The receiver expression is evaluated exactly once, before allocation. The copy itself runs no user code: no getters, conversions, callbacks or element constructors. |
| Nullness | The receiver must have a non-nullable static type. A nullable array reference (`[N]?T`) needs the existing `?.` form, which gives `nil` or a fresh `[N]T` as `[N]?T`, or an explicit `!!`. A platform-typed imported array (`[]!T`, [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md)) is accepted and gives a non-null `[]T` result type. A non-nullable static type does not guarantee a non-`nil` reference: `= default`, CLR-default array elements of array type and platform-typed values can all hold `nil`. |
| Faults | After the receiver has been evaluated, the copy itself can throw only `NullReferenceException`, when the evaluated reference is `nil` (whatever its static type, as a member call does), and `OutOfMemoryException`. Exceptions raised while evaluating the receiver expression, such as an index or getter fault, are that expression's own faults and happen before the copy starts. |
| Concurrency | No cross-thread atomic snapshot. A concurrent writer can be observed per element as the CLR allows for an `Array.Clone` of that element type. |
| Lowering | `Array.Clone()` on the evaluated receiver, then `castclass` to the receiver's CLR array type. The cast always succeeds because `Clone` preserves the runtime type; it exists for verifiable IL. |
| Category | An rvalue. It is not an assignable location and creates no borrow, so it composes with indexing and calls (`a.copy()[0]`) like any call result and is legal across suspension points. |
| Metadata | None. The call site emits ordinary IL. Public signatures, reference assemblies and CLR consumers see only `T[]`. |

Unchanged by this contract: `b = a`, parameters, returns, fields, slice and
collection insertion, generic substitution, protocol insertion and recovery,
data `.copy(...)` on records, receiver behavior, managed-location rules and
every native-slice operation. Withdrawn ADR-0206 stays withdrawn; this record
adds no receiver mode.

### 2. Ranked spelling

For the compatible explicit-copy direction, the recommendation is to admit
a zero-argument `.copy()` on single-dimensional arrays, under the contract
above. This does not select the breaking direction in section 8.
Option 2 is a fully viable outcome. If the
maintainer prefers no new surface, the contract becomes the documented meaning
of the existing idiom, and the Go lowering in section 4 still works.

| Rank | Option | Assessment |
| --- | --- | --- |
| 1 (recommended) | `a.copy()` admitted for arrays | Reuses G#'s existing word for "a new value of the same type with shallow copies", which data types already use. Needs no new grammar or punctuation. The result type follows the receiver, so the unchecked cast disappears. Costs: a compatibility rule for existing extensions named `copy` (below); Go readers may associate `copy` with Go's destination-preserving `copy(dst, src)` builtin, so documentation must say "fresh copy". |
| 2 (real alternative) | No language change: `cast[[N]T](a.Clone())`, or an ordinary user or library extension such as `CloneArray` | Works today (P1, P3). An extension also works in generic code over `T Array`, where an intrinsic does not apply. Costs: the cast restates the type and is unchecked; a shipped extension is a public API naming decision; an `Array` constraint also admits rectangular arrays and `System.Array`. |
| 3 | Maintainer candidate `a.(value)` | Coherent: it can mean "the same type, as a fresh value", and it cannot collide with member lookup. Costs: a new postfix production after `.`, which must compose with later indexing, calls and `?.`. `value` would be contextual only inside that production, and it is also the property-setter parameter name, so `value.(value)` is legal but unclear. For Go readers, `x.(T)` is a type assertion, so `frame.(value)` can read as "assert to a type named `value`". This is not a G# grammar conflict, because G# has no `.(T)` form. It is a readability cost for the migration audience. |
| 4 (rejected) | Retype `Array.Clone()` on `[N]T` receivers to return `[N]T` | Changes the type of existing expressions. `var o = a.Clone()` changes from `object`, which can change overload resolution and inference in source that compiles today. |
| Separate semantic decision | Existing `[N]T` becomes a value, or a distinct value-array type | Not a spelling for CopyNew. Evaluated in section 8 for automatic copying, generic composition and stable locations; not rejected merely because the original operation needs no new type. |

Rules for the recommended `.copy()` admission:

- **Lookup first.** Ordinary member and extension lookup runs first. When it
  finds an applicable `copy`, that call keeps its current meaning. The
  intrinsic applies only where lookup finds nothing, which is `GS0159` today.
  Every program that compiles today keeps its meaning. The cost is that a later
  extension named `copy` takes precedence; an implementation may offer an IDE
  hint, but it must not add a warning to code that compiles today, because
  warnings are errors in many builds. Data structs keep their existing
  intrinsic-first `.copy` rule.
- **Exact shape.** Zero arguments and no type arguments. A named argument keeps
  today's diagnostic; array element-update syntax is not proposed. Other
  arities fall through to ordinary lookup.
- **No hijack.** `copy` stays a legal identifier, including as a variable name.
  The CLR `CopyTo` member and `Array.Copy` are unaffected.
- **Conditional receivers.** `a?.copy()` follows the existing null-conditional
  member-call rules.
- **cs2gs.** Translated C# `(int[])a.Clone()` output does not change unless a
  separate decision selects the new form.

If the maintainer selects option 3 instead, the same contract and rules apply,
except that lookup cannot collide and the parser needs the new production.

### 3. Store into an existing array (CopyInto): use existing APIs

No second construct is proposed. Existing APIs cover the demonstrated cases:

```gsharp
// Go: a = b, where a already exists and has the static type [2]int32.
Array.Copy(b, a, 2)
```

Rules for a destination-preserving store:

- Pass the static length `N` as the count. `Array.Copy` throws
  `ArgumentException` before it writes when either physical length is shorter
  than `N`. A physical length longer than `N` is not detected; the bounded
  profile below excludes such arrays at its boundaries.
- Use arrays whose runtime element types are exactly the source element type.
  With other element types, `Array.Copy` can convert, and an exception during
  the copy leaves the destination undefined. Go has no array covariance, and
  the profile creates exact arrays.
- Overlap is safe: `Array.Copy` behaves as if it copied the source first (W6).
  `Array.ConstrainedCopy` rolls back only its own single copy; it is not a
  transaction over several stores.
- `slice[T].CopyTo` copies the shorter length, so it is not an exact
  fixed-array assignment.

A new CopyInto facility would need a concrete gap: for example, recursive
array-in-struct stores whose emitted text fails the ADR-0191 output review.
That is a later, separate proposal.

### 4. Bounded Go lowering profile

This section shows how a Go frontend could lower flat arrays and array-valued
struct fields with the section 1 operation and section 3 stores. It is a
design for review, not an admitted go2gs family. M0 still reports
`migrationReady: false`, and admission needs the gates in section 6.

#### Profile invariants

1. A Go array variable, parameter, struct field or slice element owns one
   represented CLR array for its lifetime. Emitted code never rebinds that
   reference after initialization; whole-value assignment uses CopyInto.
2. A new Go array value gets CopyNew storage: a new variable, a by-value
   argument, a return of a location, a struct literal field and a slice-literal
   element. These boundaries are mandatory. A fresh composite literal or a
   profile call result needs no extra copy, because the callee already copied
   any returned location.
3. Go evaluates index and indirection operands and right-hand sides, then
   stores left to right
   ([Go specification, assignment statements](https://go.dev/ref/spec#Assignment_statements)).
   Emitted code captures each operand once at its source point and selects the
   final destination in the store phase. It does not check every destination
   before the first store, because Go permits an earlier store before a later
   store panics.
4. Go orders calls, method calls and receives lexically, but the order of
   other operands relative to them is unspecified
   ([Go specification, order of evaluation](https://go.dev/ref/spec#Order_of_evaluation)).
   The frontend emits one permitted evaluation plan per statement. At each
   mandatory boundary of rule 2, it captures a fresh owned value at that
   boundary's point in the plan; a later call or callback cannot change a
   value already captured. Where permitted plans give different results, the
   frontend uses the plan observed for the reference toolchain and witnesses
   it, or rejects the statement. It does not invent a universal left-to-right
   rule (ADR-0191 section 6).
5. Elsewhere, such as an operand that a later CopyInto store in the same
   statement reads, an extra source snapshot is optional. The frontend may read
   the live array only with a proof that nothing between the operand's point
   in the plan and its last use can change it: no intervening evaluation,
   call or callback, no earlier store in the statement, and no alias or escape
   through which either can write it. An earlier store that overwrites the
   source is one way the proof fails, not the only one. Without the proof, it
   snapshots.
6. Element types are flat: numbers, booleans, strings and other values whose
   G# copy matches Go's. Nested fixed arrays, struct elements with array
   fields, pointers to arrays and array equality are unsupported neighbors.
7. Emitted `.copy()` must bind to the CopyNew operation: the proposed
   intrinsic, or a member the frontend has proved equivalent. Because lookup
   comes first, an extension named `copy` in scope can win. In that case the
   frontend emits the existing `cast[[N]T](a.Clone())` form or reports a
   diagnostic. It never assumes that a winning extension copies.

#### Side-by-side examples

Each row shows Go source, emitted text with the existing idiom, and emitted
text with the recommended spelling. The examples are hand-written
illustrations. No frontend emits them today.

**The maintainer example, as ordinary G#.** No Go is involved. Sharing in the
slice literal is intended.

```gsharp
// Existing language
var copy [2]float64 = cast[[2]float64](frame.Clone())
// Recommended
var copy = frame.copy()
// Maintainer candidate
var copy = frame.(value)
```

**New variable and slice literal.** Go stores element values, so each element
needs a snapshot. This differs from the G# example above, which shares.

```go
copied := frame
copied[0] = 1.0
frames := [][2]float64{frame, copied}
frames[0][1] *= 0.5 // frame[1] stays 0.75
```

```gsharp
// Existing language
var copied = cast[[2]float64](frame.Clone())
copied[0] = 1.0
var frames = slice[[2]float64]{cast[[2]float64](frame.Clone()), cast[[2]float64](copied.Clone())}
frames[0][1] *= 0.5

// Recommended
var copied = frame.copy()
copied[0] = 1.0
var frames = slice[[2]float64]{frame.copy(), copied.copy()}
frames[0][1] *= 0.5
```

**Arguments and returns.** The caller copies a location argument. The callee
returns its parameter; the copy at return is omitted only when the frontend
proves that no pointer, view or closure retains `a`. The conservative form
copies.

```go
func Mix(a [2]float64, gain float64) [2]float64 {
    a[0] *= gain
    a[1] *= gain
    return a
}
out := Mix(frame, 0.5)
```

```gsharp
func Mix(a [2]float64, gain float64) [2]float64 {
    a[0] *= gain
    a[1] *= gain
    return a.copy() // conservative; elide only with an ownership proof
}
var out = Mix(frame.copy(), 0.5)
```

With the existing idiom, `a.copy()` and `frame.copy()` become
`cast[[2]float64](a.Clone())` and `cast[[2]float64](frame.Clone())`.

**Store into an existing variable.** The canonical witness:

```gsharp
var a = [2]int32{1, 2}
var b = a.copy()                      // Go: b := a
let p = managed(a[0])                 // Go: p := &a[0]
let view = slice[int32].FromArray(a)  // Go: view := a[:]
Array.Copy([2]int32{8, 9}, a, 2)      // Go: a = [2]int{8, 9}
*p = 7
// a[0] == 7, view[0] == 7, b[0] == 1
```

**Extraction and store through a slice element.** Operands are captured in
source order. The destination element is selected in the store phase.

```go
x := frames[i]
frames[NextIndex()] = ComputeFrame()
```

```gsharp
var x = frames[i].copy()
let selected = frames
let index = NextIndex()
let value = ComputeFrame()            // a fresh result needs no copy
Array.Copy(value, selected[index], 2) // selects and checks in the store phase
```

A real Go `int` index also needs its original-width check before narrowing
([ADR-0191](0191-go-to-gsharp-migration-tool.md) section 6.1). The store
requires a non-`nil` element, so slices whose elements can be `nil` are
unsupported neighbors.

**Order-dependent operands.** Rule 4 protects a guaranteed order. In the
first statement below, `id(a)` is a call, so it runs, and copies its argument,
before `mutateA()` runs. In the second, Go does not say whether `a` is read
before or after `mutateA()`, so `x[0]` can be 1 or 9.

```go
// mutateA sets a[0] = 9 and returns [2]int{5, 6}
x, y = id(a), mutateA() // x[0] == 1 in every permitted order
x, y = a, mutateA()     // x[0] is 1 or 9; Go 1.27.2 gave 9
```

```gsharp
// First statement: the rule 2 argument copy happens before MutateA runs.
let first = Id(a.copy())
let second = MutateA()
Array.Copy(first, x, 2)
Array.Copy(second, y, 2)

// Second statement, following the observed order: call first, then read a.
let result = MutateA()
Array.Copy(a, x, 2)
Array.Copy(result, y, 2)
```

In the second form, the live read of `a` is allowed by rule 5 because nothing
runs between the read and its use, and `x` and `y` own separate arrays. A
frontend that emits the other permitted order captures `a.copy()` before the
call instead. Both are valid Go results, but differential agreement needs the
observed one or a rejection (W24, W25).

**Swap.** `a` is overwritten by the first store and read by the second, so it
needs a snapshot. `b` is read by the first store before anything can write
it, so rule 5 allows the live read.

```go
a, b = b, a
```

```gsharp
let oldA = a.copy()
Array.Copy(b, a, 2)
Array.Copy(oldA, b, 2)
```

**Array-valued struct field, fresh copy and existing destination.** A G# struct
copy shares the array field, so a fresh Go struct value copies the field. A
store into an existing struct keeps its array field's storage and assigns the
other fields.

```go
type State struct {
    Samples [2]int32
    Count   int32
}
next := state
state = Compute()
```

```gsharp
struct State {
    var Samples [2]int32
    var Count int32
}

var next = State{Samples: state.Samples.copy(), Count: state.Count}

let incoming = Compute()
Array.Copy(incoming.Samples, state.Samples, 2)
state.Count = incoming.Count
```

Whole-struct assignment (`state = incoming`) would rebind `state.Samples`.
A field-path handle would then see the new array while an earlier element
handle and view stay on the old one (W7). The fieldwise store keeps all three
consistent (W8). A data struct can write the fresh copy as
`state.copy(Samples: state.Samples.copy())`, but a Go struct does not become a
data type for this purpose.

These examples are readable ordinary G#. Long field lists, nested shapes and
effectful destinations can make the output dense. Such output must pass the
ADR-0191 side-by-side output review. Failure there is a reason to consider a
reusable store facility. It does not by itself decide the value-type
alternative in section 8.

#### Unsupported neighbors in this profile

Each case fails closed with a frontend diagnostic until its own design and
witnesses exist:

| Neighbor | Why it is not covered |
| --- | --- |
| Nested fixed arrays (`[N][M]T`) and arrays of structs with array fields | A shallow copy shares inner arrays (W5). Go needs copies along every fixed-array axis, but not through slices, pointers or references. Recursive CopyNew and CopyInto plans with aliasing and overlap need proof. |
| `make`, zero-length-to-capacity growth, `append`, `copy`, `clear` and `range` values over slices of arrays | `Slice.Create` gives `nil` elements (W12), and growth shares inner arrays (W13). These are correct G# results, but Go needs zeroed, independently copied elements. |
| Zero values in elements and `default` | Only declaration slots get zeroed arrays. Elements and `= default` are `nil`. |
| Pointers to arrays (`*[N]T`), whole-array dereference and `p[i]` through them | Needs a location contract over the stable owner, with ADR-0188 rules. |
| Array equality (`==`) and arrays as map keys | Needs an explicit Go equality and hash mapping, including NaN and signed zero. |
| Closures and per-iteration bindings over arrays | Needs capture and binding identity rules; not every capture copies. |
| Generic code over array type arguments | A caller-side copy does not fix a generic body that copies `T` internally. Finite instantiation plans or instrumented bodies are required. |
| Interface and protocol values holding arrays | Insertion and extraction copies are possible, but Go dynamic names and lengths are not recovered from CLR `T[]` identity alone. Mixed named arrays with one underlying shape stay blocked. |
| Arrays from foreign or untranslated code | Physical length, exact runtime element type, retained aliases and later replacement are not controlled. A boundary must validate or the shape stays blocked. |
| Effectful nested destinations and multi-destination stores with recursive shapes | Requires a store-order and snapshot proof (W18). |

### 5. Interoperability and metadata

- The operation adds no metadata. Public `[N]T` signatures stay `T[]` in
  metadata, and `N` is not recorded. A cooperating translated library that
  needs `N` across assemblies requires a separately designed, validated
  manifest. This record does not propose one or any public tag or wrapper type.
- Imported `T[]` values copy as `[]T`. A `cast[[N]T]` over an imported value
  stays length-lenient, and copying it does not validate the length.
- C# and other CLR consumers see ordinary arrays from both the copy and the
  existing sharing. Their assignment keeps CLR semantics.
- Native-protocol insertion and recovery keep retaining the array reference.
  A Go frontend that needs value insertion writes `let p Counted = a.copy()`
  and copies on recovery (W14). That covers one known concrete shape, not Go
  interface identity.

### 6. Evidence

#### Executed research probes

Nine small G# probes and one Go probe ran outside the repository. The G#
probes used only current language features. None is a Go differential run,
ILVerify, NativeAOT, mutation or performance campaign.

- P1-P5 ran before this record with a local Release `gsc.dll` built from the
  native-protocol core branch, SHA-256
  `a6df0360184269441966dc5fad6feb19e41d5d6116b644f01313f3e4bf555fda`.
  They are not proof of behavior in a published SDK.
- P6-P9 ran for this record with the published pinned SDK 0.5.212
  (`tools/compiler/gsc.dll`, SHA-256
  `4269006bdbc28426f6616a3c19db9e165df4dda686c0f1cffede5b8791590286`).
- Both used .NET SDK 10.0.401. The repository pin did not change.
- Command form: `dotnet gsc.dll /target:exe /targetframework:net10.0
  /out:<Name>.dll <Name>.gs`, then `dotnet <Name>.dll`.
- P10 is a Go program run with `go run .` under Go 1.27.2 (darwin/arm64).
  It records Go behavior only. No G# lowering of it was compiled or run.

| Probe | Result | Covers |
| --- | --- | --- |
| P1 `CopyProbe.gs` | Compile 0, run 0, 16 expected `True` lines | W1-W13 |
| P2 `ProtocolProbe.gs` | Compile 0, run 0, stdout `2 1 5 5` | W14 |
| P3 `GenericCloneProbe.gs` | Compile 0, run 0, 2 expected `True` lines | W15 |
| P4 `GenericLengthNegativeProbe.gs` | Compile 1, `GS0154` (expected) | W16 |
| P5 `ProposedSyntaxProbe.gs` | Compile 1, `GS0005` at `(` (expected) | W17 |
| P6 `CastProbe.gs` | Compile 0, run 0, stdout `2 InvalidCastException` | W20 |
| P7 `CopyLookupProbe.gs` | Compile 0, run 0, stdout `3` | W21 |
| P8 `CopyMissingProbe.gs` | Compile 1, `GS0159` (expected) | W22 |
| P9 `RangeCopyProbe.gs` | Compile 1, `GS0156` (expected) | W23 |
| P10 Go `main.go` | Run 0, stdout `assign 9 5`, `consume 9 5`, `call-first 1 5`, `local-closure 9 9` | W24, W25 |

| ID | Witness | Observation | Status |
| --- | --- | --- | --- |
| W1 | Shown example with the cast idiom | `frame[0]` 0.25, copy 1.0, `frame[1]` 0.375; `frames[0]` is `frame` | Executed P1 |
| W2 | Canonical store into an existing array | `a[0]` 7, `view[0]` 7, `b[0]` 1 | Executed P1 |
| W3 | Copy and rebind instead | New `a[0]` 8 while the old view sees 7 | Executed P1 |
| W4 | Reference elements | Shared referent; replacing a slot in the copy leaves the original slot | Executed P1 |
| W5 | Jagged arrays | Shallow copy shares inner arrays; per-inner copies separate them | Executed P1 |
| W6 | Overlapping `Array.Copy` | `[1,2,3,4]` shifted right gives `[1,1,2,3]` | Executed P1 |
| W7 | Whole-struct assignment | Field handle sees the new array; element handle and view stay on the old one | Executed P1 |
| W8 | Fieldwise struct store | Field handle, element handle and view all see the new value | Executed P1 |
| W9 | Outer slice rebinding | A retained old element and view see the store; the rebound slice does not | Executed P1 |
| W10 | Swap with snapshots | Correct swap | Executed P1 |
| W11 | Length lenience | A `[3]int32` cast of a length-2 array and its clone both have `Length` 2 | Executed P1 |
| W12 | `Slice.Create` of arrays | Element is `nil` | Executed P1 |
| W13 | Growth of a slice of arrays | Old and new buffers share inner arrays | Executed P1 |
| W14 | Raw-array protocol payload | Insertion copy isolates the source; recovery retains the entry | Executed P2 |
| W15 | Same-type generic helper and extension | Result keeps `[2]int32` and is independent | Executed P3 |
| W16 | Copy result passed as `[3]int32` | `GS0154` | Executed P4 |
| W17 | `frame.(value)` today | `GS0005` | Executed P5 |
| W18 | Recursive, aliased, multi-destination store with a later fault | Not run | Future obligation |
| W19 | Mixed Go dynamic names and lengths through protocols and separate libraries | Not run | Future obligation |
| W20 | Existing idiom with a wrong cast | `cast[[3]int32](pair.Clone())` compiles and has `Length` 2; `cast[[2]float32](pair.Clone())` compiles and throws `InvalidCastException` | Executed P6 |
| W21 | Extension named `copy` on `[2]int32` | Binds and returns `3` | Executed P7 |
| W22 | `pair.copy()` without an extension | `GS0159` | Executed P8 |
| W23 | `pair[..]` result stored in a `[2]int32` slot | `GS0156`: the range copy has type `[]int32` | Executed P9 |
| W24 | Go `x, y = id(a), mutateA()`, an order the specification guarantees | `x[0]` 1 | Go executed P10; G# lowering not run, future obligation |
| W25 | Go `x, y = a, mutateA()` and `consume(a, mutateA())`, an unspecified order | Go 1.27.2 read `a` after the call: `x[0]` 9, `p[0]` 9 | Go executed P10; G# lowering not run, future obligation |

#### Future implementation obligations

If the maintainer approves the contract and a spelling, the implementation PR
must provide ADR-0154 discriminating tests for at least:

- Same static type: a copied `[2]int32` is rejected at a `[3]int32` slot;
  element nullability is kept.
- Independence for value elements and shallow sharing for reference and jagged
  elements.
- Runtime type: a covariant `[]Base` copy keeps `Derived[]`, and a store of
  `Base` into it still throws `ArrayTypeMismatchException`.
- Length lenience: a cast `[3]int32` with physical length 2 copies to length 2.
- Single evaluation: an effectful receiver runs once.
- Nullness: `a.copy()` on `[N]?T` is rejected, `a?.copy()` gives `nil` or a
  copy, and a `nil` receiver with a non-nullable or platform static type
  (`= default`, a CLR-default array element, a null import) throws
  `NullReferenceException` at the copy site, after receiver faults.
- Compatibility: an existing extension named `copy` still binds; data
  `.copy(...)` is unchanged; a named argument on an array keeps today's
  diagnostic; `copy` stays a legal identifier; rectangular arrays and native
  slices are unchanged.
- Verifiable IL (ILVerify), JIT and NativeAOT runs, deterministic emit,
  formatter and language-server behavior (completion, hover, semantic tokens)
  for the selected spelling.

A go2gs family based on section 4 additionally needs everything that ADR-0191
requires for admission: unchanged Go, JIT and AOT agreement, rejected-neighbor
witnesses, deterministic text and maps, all four stages and the output review.
It also needs witnesses for section 4 rules 4, 5 and 7: W24 and W25 lowered and
run, a later call or callback that mutates an operand after its mandatory copy,
and an in-scope extension named `copy` that forces the `Clone` form or a
diagnostic.

### 7. Storage and performance stay separate

The #4513 and ADR-0191 gates are workload-specific, not a rule that every copy
is allocation-free. M3 audio excludes per-frame inner arrays and boxing. A
`T[]`-per-frame representation cannot meet that structural gate. CopyInto
avoids a new destination array per store, but it does not remove existing
inner arrays. An ordinary struct such as `StereoFrame` in
`samples/NativeSlices.gs` already stores a frame without an inner array. Audio
storage is therefore a separate decision. This record makes no allocation,
latency or throughput claim and measured none.

### 8. Evaluation: make existing `[N]T` a value?

All contracts in this section are candidate obligations, not language rules.
Sections 1-7 describe the reference-array baseline and explicit operations.
They must be revised if the maintainer later selects breaking value semantics.

#### Evidence and compatibility scope

A parser census at `02a9eb8f5ab9fe2c8c0d66713e3cd9d3be3a8b60`
traversed 4,507 `.gs` files. It found five live fixed-array literals in four
samples: [`Arrays.gs`](../../samples/Arrays.gs) twice,
[`CountWords.gs`](../../samples/CountWords.gs),
[`ParenthesizedReceiver.gs`](../../samples/ParenthesizedReceiver.gs) and
[`SliceLinqUntypedLambda.gs`](../../samples/SliceLinqUntypedLambda.gs).
It found no live fixed-array type clauses, and no fixed-array literals in
compiler, runtime or tool implementation source. Comments and embedded
fixture programs were excluded. Twenty-six files had parser diagnostics;
a separate numeric-array-line check found only
[`Bench.gs`](../../bench/concurrency/gsharp/Bench.gs)'s empty numeric
allocation among them. This is a syntax census, not a build, external-user
survey or predicted count of failing tests.

A prior current-behavior probe observed sharing through assignment,
parameters, `List`, nested arrays and native slice elements. Its swap
retained the old backing array, `default` was nil and reflection reported
`Int32[]`. It used the local protocol-core compiler at
`fa0d27cfe6b5424d182c52809312f9a205235025`, not a rebuilt census snapshot or
published compiler. The audited array symbol, creation parser and literal
binder had no diff from the census base. None of these results exercises
a compiler with value-array semantics.

The compatibility surface is larger than five literals:

| Existing contract and source evidence | Effect of genuine fixed-array values |
| --- | --- |
| [`Issue3998FixedArrayLengthConversionTests`](../../test/Compiler.Tests/Issue3998FixedArrayLengthConversionTests.gs), `AcceptedCases`: implicit `[N]T -> []T` is sharing; explicit `[3]T -> [4]T` keeps physical length 3 | A real length-4 value cannot retain length 3. Reject mismatches or define an explicit checked copy; do not retain an unchecked false length. A value-to-reference bridge must say copy or retained view. Neither is today's no-op identity conversion. |
| Same tests: `System.Array`, `IEnumerable[T]`, `object`, reflection name `Int32[]` | A CLR struct is not an array. Explicit materialization can preserve API access, not array identity. Sequence enumeration may copy or borrow under an explicit lifetime rule. Boxing reports the carrier type. |
| [`Issue3962GenericOverFixedArrayIdentityTests`](../../test/Compiler.Tests/Issue3962GenericOverFixedArrayIdentityTests.gs), `InteropCases`: actual C# `List<int[]>` and nested lists cross both directions | `List<Carrier<int>>` is not `List<int[]>`. Elementwise adapters can copy and validate but cannot be identity conversions preserving foreign mutation. Generic invariance forbids reinterpreting either list. |
| [`ArrayTypeSymbol`](../../src/Core/CodeAnalysis/Symbols/ArrayTypeSymbol.gs) and the [array specification](../../website/docs/ref/spec.md#arrays-and-slices): source shape retains `N`; imported `T[]` has no `N` and is length-lenient | Import needs validated shape metadata for new values, or explicit foreign-array conversion. Missing length is not evidence of a matching value shape. Old libraries remain reference-array libraries. |

**Inference is a separate decision.** In expression position, `[5]T` and
`[5]T{}` allocate zero-initialized **`[]T`** today. Only a nonempty
`[5]T{...}` literal gives fixed `[5]T`; in type position `[5]T` is fixed.
See [`Parser.Expressions.Creation`](../../src/Core/CodeAnalysis/Syntax/Parser.Expressions.Creation.gs)
and [`ExpressionBinder.Literals`](../../src/Core/CodeAnalysis/Binding/ExpressionBinder.Literals.gs).
Changing the fixed type while preserving that inference limits the direct
source migration. It leaves an ergonomic surprise: an empty numeric
allocation is not a value-array literal. Typed zero declarations or a
separately designed construction form must remain unambiguous, including
length zero.

Revising constant numeric allocations to infer value arrays is a larger,
independent breaking choice, not a harmless consistency fix. It reaches
[`ByteString.DecodeUtf8`](../../src/Sdk/Gsharp.Runtime.Values/ByteString.gs)
(`buffer.AsSpan()` and `StringBuilder.Append(char[], ...)`),
[`TupleTypeSymbol.BuildClrType`](../../src/Core/CodeAnalysis/Symbols/TupleTypeSymbol.gs)
(`Array.Copy` and `MakeGenericType(Type[])`), and channel receive buffers
([`ChanBatchTests`](../../test/Runtime.Channels.Tests/ChanBatchTests.gs)).
[`cs2gs` array translation](../../tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.Patterns.gs)
intentionally emits `[]T{...}` literals and `[n]T` allocations for C# arrays.
Preserving `[]T` requires a clear zero-filled CLR-array allocation path.
Keeping `[n]T` inference is the narrower candidate; changing it requires
rewriting these consumers and cs2gs output, not silently materializing copies.
Existing `System.GC.AllocateArray[T](n)` is a CLR-array alternative, subject
to its own ordinary API contract, not newly selected native syntax.

#### Compare the three directions

| Direction | What it genuinely supplies | Remaining cost or blocker |
| --- | --- | --- |
| Reference arrays plus explicit CopyNew/CopyInto | Existing ABI, sharing, defaults, generic interop and array APIs. Sections 1-7 supply a bounded Go lowering with real current-language alternatives. | Automatic copies require frontend instrumentation. Nested shapes, generic bodies and location stores remain explicit. Inner arrays remain allocated. This is the compatible baseline, not full Go arrays. |
| Existing `[N]T` with a real CLR value representation | Ordinary CLR value copies compose through fields, generic code, containers and boxing. Nested fixed-array carriers copy recursively; reference elements retain sharing. | Breaking conversions and reflection; exact cross-assembly identity, zero-length storage and escaping views unresolved. Large values increase copy/stack/ABI costs. This is the preferred research candidate for a general value goal, conditional on the gates below. |
| Compiler-directed copies while retaining `T[]` | Can preserve physical public signatures and most foreign array API calls. Recursive fresh copies and destination stores can implement a closed translated subset. | Every semantic boundary must cooperate. Foreign `Duplicate<T>(T x) => (x, x)` still duplicates a reference, and foreign code copying a struct with an array field shares that field. Neither a caller copy nor intercepting `List.Add` fixes those internal copies. General support needs specialization, changed storage, cooperative code or rejected boundaries. It is not transparent CLR-wide value semantics. |

The last direction need not change the physical ABI. It **does** change the
source/metadata contract if G# callers expect value semantics. An attribute
can tell a cooperating compiler to copy; it cannot make old IL copy.
Copy-on-write is not an escape: retained writable byrefs, raw arrays and
foreign mutations can bypass the write barrier.

#### Complete copy and location obligations

The value candidate must cover this matrix before semantic acceptance.
These are not claims that ordinary shallow `Array.Clone` suffices.

| Boundary | Required value behavior and distinguishing obligation |
| --- | --- |
| Declarations, assignment, parameters and returns | A value read creates independent fixed-array contents. A write replaces contents at the destination location. Conservative snapshots precede later mutating calls where the selected evaluation plan requires them; elision needs an ownership/alias proof. |
| Parallel assignment and swap | Capture required RHS values before stores. `a,b=b,a` must exchange contents while retained `managed(a[0])` and views of `a` keep observing destination `a`. Clone-and-rebind fails W3. |
| Fields, enclosing structs, tuples and nested arrays | A struct copy must copy its fixed-array fields, recursively through value elements. `[N][M]T` copies both fixed axes. Class, CLR-array, native-slice and managed-handle elements retain their ordinary reference/descriptor semantics. No recursive cloning through class graphs or slices. |
| Generic functions and containers | An open `T` copy must work without inspecting source spelling. `List[[N]T]` insertion, return and ordinary by-value extraction copy values. Ref-returning access selects a location; a by-value property result is not a writable parent. Test unknown CLR generic bodies and nested instantiations, not just direct `Add` calls. |
| Native slices and channels | `slice[[N]T]` copies only the outer descriptor. By-value element reads and sends/receives copy inner values; direct nested writes address original storage. Growth, `clear`, batch operations and default element creation must not introduce shared inner fixed arrays or nil elements. CLR value storage can compose naturally; a `T[]` element representation needs cooperating runtime paths. |
| Boxing and protocols | CLR value boxing/unboxing copies the carrier; reference-backed arrays do not. ADR-0205 already copies actual structs at concrete insertion/recovery and retains protocol entries on transport. A value carrier would compose with that policy; `T[]` would need additional copy evidence, including array fields inside structs. Fixed-array protocol slots remain blocked pending their public/ref contract. No new receiver modes. |
| Zero, default and nullability | A non-null value `[N]T` has zeroed elements, including collection slots, enclosing defaults and generic `default(T)`; `[0]T` is a valid empty value. Reference elements keep CLR-default nil where applicable. A nullable container needs explicit absence, distinct from a zero value and from nullable elements. Revisit current nil comparison and platform imports through ADR-0186's funnel; no blanket `!!` workaround. |
| Writable/readonly locations, views and handles | Element reads may copy; nested writes and compound updates select a location exactly once. Readonly access cannot grant writable spans/handles. A view or exact invariant managed handle retains the destination owner/path, not a detached copy. Raw borrows obey existing escape and suspension rules. |

The last row is not solved merely by inline layout. Stack-local inline
storage can yield a scoped `Span<T>`, not automatically an escaping,
heap-storable native `slice[T]`. Current native slices own exact `T[]`.
An explicit `ToArray` can be a copy bridge, never a shared view.
A new retained view over a promoted cell, class field or carrier-array
element needs a separate owner/path representation and public contract.
Promotion must precede every derived alias and survive later whole-value
stores. It must not turn all ordinary value copies into aliases.
Existing ADR-0188 handles are invariant in their exact referent type.
Neither covariance nor a fabricated `ref T[]` over carrier storage is valid.

**Evaluation and faults remain distinct policies.** Native G# parallel
assignment follows [ADR-0015](0015-multi-target-assignment.md): capture targets,
evaluate RHS values, then write, each phase left-to-right. A representation
change must not silently replace that policy with Go's. Go translation uses
the qualified evaluation plan in section 4: calls, method calls and receives
have lexical order, but not all bare operand reads do. W24 is a guaranteed
witness; W25 records one permitted observation, not a universal rule.
For recursive or overlapping stores, snapshot any source an earlier write
can affect, including array-valued fields. Select effectful receivers and
indices once. Test `frames[next()][j] += rhs`, aliasing destinations, a later
RHS fault, and a later store fault. No blanket prevalidation or transaction
may erase a permitted earlier Go store. Conversely, existing native G#
capture-time faults must still prevent its stores. These obligations remain
unrun for a hypothetical value compiler.

#### CLR representation and public identity gates

G# already synthesizes nominal fixed-buffer backing structs in
[`DeclarationBinder.Structs`](../../src/Core/CodeAnalysis/Binding/DeclarationBinder.Structs.gs).
They have a sized sequential layout and a restricted primitive element set.
They are useful emitter prior art, not arbitrary open-`T`, GC-tracked,
zero-length value arrays.

.NET inline arrays are stronger prior art. The
[.NET 10 runtime design](https://github.com/dotnet/runtime/blob/v10.0.0/docs/design/features/InlineArrayAttribute.md)
supports replicated generic element layout, including GC references, with
positive length and no explicit layout. Struct/runtime size limits still
apply. The [C# design](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-12.0/inline-arrays.md)
distinguishes writable, readonly and temporary access and checks span escape.
It supplies building blocks, not anonymous arbitrary-length CLR type identity.

Candidate choices need explicit bounds and rejection diagnostics for
unsupported element types, recursive layout, size overflow and excessive
value sizes. Length zero needs a distinct empty representation; applying
`InlineArray(0)` is invalid. Open `T`, nested carriers, GC layout, calling
conventions and code size need JIT and NativeAOT proofs. A large fixed value
may be more expensive than a reference plus a bounded copy. No performance
campaign was run. Default inline-array equality/hash also cannot be assumed
to supply Go equality; the runtime document requires overrides when used.

Most importantly, independently synthesized carriers are **nominal**.
Two libraries declaring identical `Shape.Array2<T>` structs do not share a
CLR type. Their `List` instantiations do not interoperate by shape
([assembly-qualified types](https://learn.microsoft.com/en-us/dotnet/api/system.type.assemblyqualifiedname?view=net-10.0),
[generic invariance](https://learn.microsoft.com/en-us/dotnet/standard/generics/covariance-and-contravariance)).
Deterministic generated names are necessary but insufficient.

No production canonical arbitrary-`N` mechanism is selected. A finite SDK-owned carrier
family proves only supported lengths. A shared compositional generic
encoding would need to prove canonical shape, layout, nesting and public
accessibility; a producer-owned shape manifest still needs a rule when two
independent producers export the same source shape. Explicit conversion
between nominal carriers cannot preserve invariant generic identity.
Do not claim structural CLR unification or silently expose different source
identities for the same `[N]T`.

Before acceptance, specify the canonical carrier owner and signature
encoding; import/reexport rules; foreign C# construction and element access;
generic constraints (`Array` versus `struct`); overload identity; reflection;
helper visibility; versioning; and deterministic implementation/reference
assembly parity. Length cannot depend on private fields or usable reference
bodies. A consumer built against `/refout` must select the same type and
bridges as one built against the implementation. A physical carrier ABI
would break old public array signatures; a `T[]` lowering might keep those
signatures but still needs a versioned cooperative semantic contract.
Neither scheme makes old binary callers value-aware.

#### Bounded runnable evidence, not a compiler prototype

A C#/.NET 10.0.401 probe ran with:

```sh
dotnet run --project .array-value-evidence/Probe/Probe.csproj --configuration Release
```

It used two isolated libraries, each declaring the same named
`[InlineArray(2)] struct Array2<T>` with one `T` field, plus a caller.
All ten assertions passed: zero default, generic value copy, `List` value
read, nested value copy, retained `ref`/`Span` through a whole-value swap,
boxing copy, generic `T[]` sharing, array-field sharing through a generic
struct copy, distinct cross-assembly carrier types and incompatible lists.
For the retained-location check, the caller saved `ref a[0]` and a span of
`a`, swapped `a,b`, then wrote 7 through the ref. `a[0]` and the span read 7;
`b[0]` retained 1.

These are bounded CLR observations, not G# implementation results.
The opposite generic outcomes discriminate a real value carrier from an
unchanged array reference. The two-assembly result demonstrates the identity
blocker; it does not solve it. The isolated research scaffold is not a
product dependency or a committed feature. ILVerify, NativeAOT, arbitrary
lengths, public/ref imports, escaped G# views and value-array protocols were
not run. Existing W2-W8 and W18-W25 retain their original status.

#### Committed bounded feasibility prototype (#5224)

[`ArrayValueFeasibilityTests`](../../test/Compiler.Tests/ArrayValueFeasibilityTests.gs)
runs the committed
[`Storage`](../../test/Compiler.Tests/Fixtures/ArrayValueFeasibility/Storage.cs.txt),
[`Locations`](../../test/Compiler.Tests/Fixtures/ArrayValueFeasibility/Locations.cs.txt)
and
[`Scenarios`](../../test/Compiler.Tests/Fixtures/ArrayValueFeasibility/Scenarios.cs.txt)
C# research inputs. The G# driver uses the existing Roslyn compilation and
collectible assembly-loading helpers. Every run deletes its fixture directory.
These definitions belong only to emitted test assemblies, not the G# SDK.
This is not the `.copy()` feature or source `[N]T` lowering.

**Canonical mechanism.** One shared fixture assembly owns three public generic
value definitions. For element `T`, the encoding is:

```text
C(T, 0) = Empty<T>
C(T, 1) = Leaf<T>                         // one T field
C(T, n) = Branch<T, C(T, floor(n/2)), C(T, n-floor(n/2))>
```

`Branch` contains its two child values, not a backing `T[]`. Three definitions
cover every supported length; there is no separately declared length carrier.
Static interface dispatch selects a child recursively and returns a field ref.
No pointer arithmetic, unsafe code, contiguous-layout assumption or fabricated
span is involved. Empty values have zero elements, not a zero-byte CLR layout
promise. Public generic arguments carry the shape in reference assemblies.

`Shape.Encode`, `Decode` and `Import` implement the rule and validate claims.
Import compares actual definition identity, recursive element identity, the
canonical split and the claimed count. The decoder rejects foreign definitions,
CLR arrays, empty-child noncanonical trees and false element/count claims.
Negative lengths and lengths above 32 fail explicitly.

The fixture caps each length at 32 and array nesting at two dimensions.
It admits `int`, `string`, `object`, an open generic parameter and nested
canonical carriers. Other concrete elements, pointers, byrefs, byref-like
values and deeper arrays are unsupported. Open `T` does not promise that all
closed substitutions pass import. The check must run again for a closed shape.
The executed layout domain is narrower than the admitted type domain:
all integer lengths 0-32, reference-element cases, and nested 2-by-2 values.
No exhaustive nested-size, struct-size, JIT ABI or GC-layout certification follows.

**Real independent exchange.** The encoder generates public C# signatures for
two libraries. Each compiles against the shared contract, without referencing
the other library. A third compiled client passes the first library's
`List<C(int,n)>` directly into the second library for every `n` from 0 to 32.
The consumer validates the imported canonical shape, every element and by-value
extraction independence. The client also decodes the producer's public open
generic return shape. This is typed invariant-generic exchange, not name comparison,
reflection invocation between list types or an element adapter.

The same client also exchanges open-generic, reference-element and nested
public signatures, preserves the list object, and writes through a public
carrier ref-return chain. Both runs pass: compilation against implementation
assemblies, and compilation against actual Roslyn-emitted reference assemblies
for the runtime and both libraries. Both execute with implementation assemblies.
The generator is prototype lowering, not a G# metadata importer.
All participants deliberately use the same shared assembly identity.
Version skew, duplicate owners, type forwarding and reexport policy remain open.

The copy scenario separately exercises uninformed generic duplication, `List`
extraction, nested values, boxing and reference-containing elements. Reference
objects remain shared while reference slots copy. A `T[]` control still shares.
Independent expected shapes for lengths 0, 1, 2 and 10 constrain the encoder;
the test does not rely only on encoder/decoder round trips.

**Retained locations.** `Place<T>` supports an explicitly promoted `Cell<T>`
or an exact CLR `T[]` element. Root creation captures the owner and index once.
Each access resolves an owner path afresh. Trusted pure ref-field projections
extend that path; they do not save a struct snapshot. The implementation stores
ordinary object/delegate references, never a heap field containing a stack ref.
It does not validate arbitrary user-supplied projection delegates.
The caller must capture effectful selections before constructing a pure path.

Writable views and exact element handles survive their creating method and
forced collections. Existing readonly views and handles see subsequent writes.
Whole-parent replacement and swap update the original destination seen through
earlier derived paths. Ordinary copied parents stay independent.
Tests also replace a carrier-array element, then write through a retained nested
element path without changing the neighbor or a by-value extraction.
An effectful owner selection and handle index each run once.

Readonly views and handles expose value reads, not ref returns, setters or a
writable upgrade. Reference-element readonly access remains shallow.
Writable handles are invariant in their referent type.
Invalid ranges, indices, noncanonical view storage, covariant array roots and
boxed value roots fail explicitly. A separate lexical `ref` test covers raw
borrows. There is no automatic local promotion, stack escape, async borrow,
native-slice integration, arbitrary class-field root or concurrency guarantee.
In particular, current `slice[T]` still requires exact `T[]` owners.

**Measured validation.** On .NET SDK 10.0.401 with the unchanged released
G# SDK pin 0.5.212:

```sh
dotnet build test/Compiler.Tests/Compiler.Tests.gsproj --configuration Release -graph
dotnet test test/Compiler.Tests/Compiler.Tests.gsproj --configuration Release --no-build --no-restore --filter 'FullyQualifiedName~ArrayValueFeasibilityTests' --logger 'console;verbosity=detailed'
```

The build passed with zero warnings/errors; all four theory cases passed.
The detailed output records SHA-256 hashes of emitted runtime, public/ref
libraries, clients and scenario assemblies before cleanup.
This is JIT evidence for the research implementation.

ILVerify 10.0.8 runs on the actual runtime, libraries and clients.
The client verifies without suppressions. Runtime and library verification is
**partial**: selected methods suppress `CallAbstract`/`Constrained` for static
interface calls and `ReturnPtrToStack` for Roslyn-emitted generic-struct ref
returns. The driver names the limited scopes. Scenario IL is not verified:
an unfiltered attempt reported readonly-address `StackUnexpected` in `Encoding`
and struct-field ref-return errors in generated projections. Those observations
are not a clean ILVerify result or a compiler defect attributed to gsc.
NativeAOT, other architectures and full strict verification remain gates.

ADR-0154 witnesses used temporary mutations of the prototype, not assertions
or nonexistent G# lowering. Each mutant compiled, executed and failed its
intended runtime observation using the same targeted test command above:

| Prototype mutation | Runtime observation that failed |
| --- | --- |
| In `EncodeCore`, insert `if (length == 10) return EncodeCore(element, 11);` before the zero case | `distinct canonical length 10`; both implementation/ref clients fail `exchange count` |
| Replace the cell-root return with `var snapshot = new Cell<T> { Value = cell.Value }; return new Place<T>(() => ref snapshot.Value);` | `escaped owner retained after GC` |
| Replace `ref array[index]` with `ref array[0]` in the array-root resolver | `array element and recursive path re-resolve` |

Source hashes changed for each mutant. The detailed test output also records
different emitted-runtime hashes. Every source was restored byte-for-byte.
The restored command passed all four cases. Compile errors and the initial
unfiltered verifier failures were not counted as mutation witnesses.

**Conclusion and remaining gates.** Shared compositional CLR definitions solve
the nominal identity problem for this finite domain. Explicit owner paths solve
the exercised escaping-location problem without turning ordinary copies into
aliases. Neither result selects a production ABI or accepts breaking semantics.
The full copy/store/default/nullability/conversion matrix, broad element and
size policy, public/ref import and tooling, deterministic production emission,
strict verification, AOT, promotion/permission rules, migration and versioning
still require implementation evidence and approval.
Existing `[5]T` and `[5]T{}` inference remains `[]T`.
ADR-0210 stays Proposed; #5208 and ADR-0191 admission gates remain open.

#### Migration, bootstrap and acceptance

1. **Semantic choice first.** Review this matrix and choose reference arrays,
   or approve a complete value contract with resolved identity and lifetime
   gates. A distinct opt-in value type remains an alternative if breaking
   existing `[N]T` is unacceptable; its syntax is not selected.
2. **Scoped conversions.** Keep `[]T` as the CLR interop anchor. Specify
   explicit checked foreign-array import, value-to-array materialization and
   separately permission/lifetime-checked views. Do not retain false-length
   casts or identity conversion of invariant foreign lists. Diagnose
   unsupported boundaries instead of adding implicit copy/view adapters.
3. **Migration evidence.** Inventory syntax and semantic uses, including
   embedded tests, public signatures, generic member slots, reflection,
   defaults, nil checks, retained aliases and cs2gs allocations. A migration
   analyzer/code fix should distinguish intended sharing from values; it
   cannot infer that intent from `[N]T` alone. Show diagnostics and before/
   after text for each conversion class. Do not mass-update expected output
   without a reviewed semantic witness.
4. **Release compatibility.** If breaking semantics is chosen, use a
   deliberately identified breaking release and metadata capability revision.
   Old binaries retain their old IL and array signatures. Recompiled clients
   must not silently treat them as value libraries. A temporary legacy mode
   is justified only with explicit assembly-level identity and a removal
   policy; per-file modes cannot safely disagree on a public shape.
   No transitional mode is selected here.
5. **N-1 bootstrap.** Implement using only features supported by the previous
   released `Gsharp.NET.Sdk`. Keep repository source on old-compatible forms
   until the feature is released. Move the pin in a separate PR, rebuild from
   a clean clone, then adopt new semantics in source/tests/tools. No unreleased
   pin or source exclusions. The small syntax census is not stage-2 evidence.
6. **Acceptance and admission are separate.** Semantic acceptance needs
   resolved public/ref identity, the full copy/store/default/conversion
   matrix and retained-owner rules. Implementation then needs ADR-0154
   witnesses, ILVerify, JIT/AOT, deterministic metadata, foreign and
   cross-assembly tests, formatter/IDE and migration tooling. Go admission
   additionally needs unchanged-Go differential runs, rejected neighbors,
   readable output and ADR-0191's four stages. Equality, named Go identity,
   panic behavior and audio no-inner-array performance remain independent
   proof obligations. A document merge proves none of them.

## Consequences

For the explicit-copy baseline (sections 1-7):

Positive:

- The shown example gets a short, type-preserving copy without a new type or
  a change to default sharing.
- The unchecked restated cast in the current idiom goes away for array copies.
- The copy vocabulary stays consistent: `.copy()` already means a new value of
  the same type with shallow copies for data types.
- A Go frontend gets a readable building block for fresh values. Existing APIs
  cover stores into existing arrays.

Negative and limits:

- Lookup-first admission means that a later extension named `copy` takes
  precedence over the intrinsic.
- The word `copy` can suggest Go's destination-preserving builtin to Go
  readers. Documentation must state "fresh copy".
- The operation does not validate lengths, deep-copy or make arbitrary generic
  or foreign code copy arrays. Each limit is stated above.
- Go assignment to existing arrays, nested arrays and slice growth still need
  frontend plans. Those plans can make output verbose.

Neutral:

- No metadata, ABI, runtime library or reference-assembly change.
- ADR-0191's fixed-array track keeps explicit operations as the compatible
  baseline and now evaluates a breaking value-array alternative. Genuine CLR
  value storage is the conditional research preference for automatic generic
  copying, not an accepted replacement.
- No SDK pin moves, and repository source cannot use the operation until a
  release that contains it becomes the pin.

## Alternatives considered

- **No language change (rank 2).** The strongest alternative. It is kept as a
  valid outcome rather than rejected. It leaves the unchecked cast and the
  missing shipped type-preserving copy.
- **`a.(value)` (rank 3).** Fairly coherent and collision-free. It needs new
  grammar and reads as a Go type assertion to the migration audience.
- **A shipped library extension.** It is the same as rank 2 with a public API
  name. It also works over generic `T Array`. It can coexist with rank 1, but
  it is a separate API decision.
- **Retype `Array.Clone()` for `[N]T`.** Rejected: it changes existing
  expression types and possibly overload resolution.
- **Range or slice copies (`a[..]`, `slice[T].FromArray(a).ToArray()`).**
  These copy but return `[]T` and lose `N` (W23).
- **A new value-array type (`value [N]T`) or automatic copying of `[N]T`.**
  Section 8 evaluates these separately from operation spelling. Automatic
  copying is worth serious consideration, but canonical identity and retained
  views remain unresolved. A distinct opt-in type could avoid breaking existing
  fixed arrays, at the cost of another category and its own interop rules.
- **Intrinsic-first `.copy()` for arrays.** Rejected: it would change the
  meaning of existing calls to extensions named `copy`.
- **A length-checked copy.** Not proposed. A same-type copy that throws for a
  false annotation would make the operation fallible and differ from
  `Array.Clone`. It can be a separate operation if a need is shown.
- **A new CopyInto construct.** Not proposed. `Array.Copy` with the static
  length covers the flat cases; a facility needs a demonstrated gap.
