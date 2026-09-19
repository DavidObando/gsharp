# ADR-0190: Native shared-storage slices and explicit CLR array interoperability

- **Status**: Accepted
- **Date**: 2026-09-19
- **Phase**: Native managed-array slice core implemented; optional composition deferred
- **Issue**: [#4328](https://github.com/DavidObando/gsharp/issues/4328)
- **Related**: [ADR-0188](0188-heap-storable-managed-references.md),
  [ADR-0189](0189-capturing-anonymous-objects-and-structural-interface-adaptation.md),
  [ADR-0016](0016-slice-storage.md),
  [ADR-0042](0042-async-sequence-type-clause.md),
  [ADR-0170](0170-escaped-identifiers.md),
  [ADR-0159](0159-magic-collection-zero-values-and-nil-comparison.md),
  [ADR-0174](0174-goroutines-and-channels-wave-2.md),
  [ADR-0181](0181-readonly-managed-reference-contracts.md),
  [ADR-0154](0154-test-oracle-strength.md)
- **Effect**: Extend ADR-0016 with a distinct native slice category,
  not replace its existing array ABI. Extend ADR-0159's default/nullability
  classification for that category. Preserve ADR-0174's retired built-ins.
  Existing CLR-array representations remain unchanged.

## Acceptance and implementation amendment — September 19, 2026

The maintainer approved this design on **2026-09-19**, after requesting the
contextual **`readonly slice[T]`** spelling and endpoint-based `Subslice`
instance / imported `Slice` extension distinction. PR #4332 deliberately kept
all three capability proposals Proposed. Acceptance belongs to this feature's
implementation, not that documentation-only PR. ADR-0188 and ADR-0189 remain
Proposed and are not dependencies of the bounded core below.

Implemented contracts:

- `slice[T]` and `readonly slice[T]` are ordinary nominal constructed value
  types, `Gsharp.Values.Slice<T>` and `ReadOnlySlice<T>`, in the single
  SDK-shipped `Gsharp.Runtime.Values` assembly. Compiler recognition checks
  the assembly/type identity and required runtime surface. It reuses the
  imported-generic symbol and MemberRef machinery, **not** `SliceTypeSymbol`,
  `object` public signatures, or context-dependent representations.
- Native literals, canonical empty defaults, nullable containers/elements,
  invariant type arguments, readonly modifier positions and `ref readonly`
  precedence, generic/source-defined elements, fields, closures, async value
  storage, implementation metadata and `/refout` are supported.
  `array[T]` is exactly the existing `[]T` CLR-array type; `[N]T` retains its
  existing reference-backed meaning.
- Native range/index lowering saves the descriptor before evaluating
  operands. Range normalization happens after written bounds have evaluated.
  Native method calls also save the receiver before argument evaluation,
  including `Append` and explicit `Subslice` calls.
  It calls known `Subslice` methods, independently of extension imports.
  The runtime's four-argument `Subslice(lo,hi,lowerFromEnd,upperFromEnd)`
  overload is the normalization entry point used by the compiler.
  Element refs and nested value-field writes address retained array storage;
  compound writes save the location and do not reevaluate the receiver/index.
- Factories, observations, capacity limiting, append/reallocation, overlapping
  copy/self-append, clear, clone, explicit array copies, permission weakening,
  span/memory access, exact-array checks, whole-owner recovery, and array-backed
  memory admission implement the matrices below. Empty custom-owner/string
  memory is rejected before BCL empty-memory normalization can erase its owner.
  Sharing does not widen or drop element nullability. Symbolic static `out`
  inference and `[NotNullWhen(true)]` owner recovery preserve these annotations.
- Equality/hashing compare owner identity and all descriptor bounds, normalizing
  the default owner to `Array.Empty<T>()`. Native G# equality requires the same
  declared permission kind; write `.AsReadOnly()` to compare across kinds.
  The CLR types expose same-kind operators and ordinary implicit permission
  conversion; C# applies its own normal conversion/overload rules.
- Enumeration saves a descriptor and reads current logical elements. Native
  list-pattern rest captures are shared native views. CLR-array range and
  list-pattern copies, imported arrays, and cs2gs's C# array output are unchanged.
- The .NET 10 SDK, direct driver, REPL, bootstrap SDK and package layout ship
  the same runtime. Missing/incompatible support is GS0600; native element/type
  restrictions are GS0601; readonly element stores are GS0603. Formatter,
  display/completion, code-model/printer and the nominal C# type mapper use
  the two-token readonly spelling.

Explicit boundaries:

- A write whose selected element/value-field location must survive suspension
  is rejected with **GS0602** (and existing ref-liveness diagnostics where
  applicable). Saving/reconstituting an owner/index across suspension is not
  falsely presented as implemented. Slices themselves are heap-storable, and
  segment-local element borrows and spans use the existing lifetime rules.
- Persistent handles (ADR-0188), interface adaptation (ADR-0189), arbitrary
  memory owners, pooling/disposal, Go nil/panic semantics, native Go fixed-value
  arrays, and go2gs are deferred/outside this capability. Native buffer literals
  currently take individual positional elements; use `AppendRange` for ranges.
- The existing ILVerify 10.0.8 `ReturnPtrToStack` limitation also rejects
  Roslyn's bare `ref Slice<T>` / `ref readonly ReadOnlySlice<T>` parameter
  forwarders. Tests independently reproduce it with Roslyn and pin the G#
  forwarding bodies to exactly `ldarg.0; ret`, identical byref parameter/return
  types, and no locals. Only those named forwarding methods use the repository's
  existing method-scoped exception; all other emitted slice methods are verified
  without suppressions. No real IL failure is ignored.

Evidence is executable in `NativeSliceLanguageTests`, `NativeSliceRuntimeTests`,
`NativeSliceFormattingTests`, `NativeSliceCompletionTests`,
`NativeSliceRuntimeLayoutTests`, and `NativeSliceTranslationTests`.
The offline [`NativeSlices.gs`](../../samples/NativeSlices.gs) witness uses a
real value `StereoFrame`, shared subranges and nested writes; its warmed-up
100,000-iteration processing loop allocates **zero bytes**. Runtime allocation
tests likewise require zero allocations for view creation and in-capacity
append, with a predeclared five-second/100,000-operation sanity budget on the
macOS/.NET 10 validation host. Raw-array, BCL-memory and explicit-copy observations
are informational, not a speedup claim or a portable benchmark guarantee.

Discrimination evidence (ADR-0154): a deliberately applied runtime mutant
batch replacing shared views with array clones, ignoring capacity limits,
admitting covariance, exposing subrange owners, sharing `Clone`, clearing spare
storage, indexing to Capacity, and iterating the first element made **nine**
runtime tests fail. A second batch returning empty values for invalid bounds
made **all five** bounds rows fail. Both batches were fully reverted and the
same checks passed. During implementation, the language witnesses also failed
on duplicated nested-element index evaluation, nullable-element widening,
cross-permission equality, and misparsed parenthesized readonly types before
their respective fixes. Generic equality and permission-weakening tests also
killed actual erased-`object` operator/nullable-constructor MemberRefs with
`StackUnexpected`; those IL errors were fixed, not suppressed.
The code-model snapshot change is one reviewed new
`NativeSliceTypeReference` entry, not acceptance of unrelated golden drift.

The original rationale and selected semantic matrices follow; references to
proposal-stage gates below are historical context, resolved by this amendment.

The ordinary-name/escape-precedence amendment merged with #4332 on September
19, 2026 is also implemented. Source/imported lowercase generic types, explicit
aliases, escaped identifiers, wrong arities, failed constraints and ambiguous
imports have discriminating compiler tests. Generic import ambiguity uses the
existing GS0547 diagnostic rather than a first-import or native fallback.
Formatter escapes are retained, and cs2gs qualifies runtime native types when
ordinary names at the C# binding site would shadow the aliases.

## Context

At the inspected compiler snapshot, `88f4c4ad8`, the source forms `[]T` and
`[N]T` lower to CLR `T[]`. The current
[reference specification](../../website/docs/ref/spec.md) and ADR-0016 describe
that representation. In
[BindArraySlice](../../src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.MemberLookup.cs),
lines 3168-3200 at that snapshot, range slicing allocates a destination and
calls `Array.Copy`. This is a deliberate copying contract, not a defect to
"fix" by changing every existing range expression.

The consumer motivating this proposal is cliamp at `4dee32c`:

- [gapless.go](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/gapless.go)
  passes `samples[n:]` to the next streamer and expects writes in the original
  buffer.
- [eq.go](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/eq.go)
  changes channels within each caller-owned stereo frame.
- [live_prefetch.go](https://github.com/bjarneo/cliamp/blob/4dee32c6c967cb2cc6069196e40cd3ff397deb3f/player/live_prefetch.go)
  copies frames into a ring buffer and then changes channels in output frames.
  Sharing the outer buffer must not accidentally make a frame assignment share
  a separate inner array.

These are useful requirements for ordinary media, parser, and network code.
Application-specific `GoSlice[T]` wrappers would hide a general language need.
Conversely, CLR array identity is essential to imported APIs and cs2gs.

The [Go specification](https://go.dev/ref/spec#Slice_types) supplies a useful
precedent: slices share backing arrays, carry separate length/capacity, and
support capacity-limited subslices. This proposal adopts those storage ideas,
not Go's entire type/default/exception system. Go array values are a separate
problem; see the translation boundary below.

## Decision

**Add `slice[T]` as a compiler-known, heap-storable value descriptor over a
managed array, and `readonly slice[T]` as its read-only-access counterpart.
Keep `[]T` as an exact CLR array. Add `array[T]` as an explicit spelling for
that same existing array representation.**

This is the recommended additive path, not a temporary mode that changes
`[]T` according to project flags. A future proposal could retire a spelling,
but this ADR neither schedules nor authorizes an ABI-changing reinterpretation.
Resolved native types have the same CLR identity across mixed-version
assemblies; ordinary-name lookup and shadowing are specified below.

The spellings and members below describe the selected contracts, implemented
as recorded in the acceptance amendment above.

### 1. Source and library surface

```gsharp
// Proposed native slice surface.
import Gsharp.Values

var samples = slice[int32]{10, 20, 30}
var tail = samples[1..]
tail[0] = 99
// samples[1] == 99; samples.Length == 3; tail.Length == 2.

var work = slice[int32].Create(2, 8)
var sibling = work
work = work.Append(7)
// work.Length == 3; sibling.Length == 2.
// sibling[0..3][2] == 7, because both descriptors retain that capacity.

var isolatedGrowth = work.Slice(0, work.Length, work.Length)
isolatedGrowth = isolatedGrowth.Append(8)
// Growth must use different backing storage.

let raw = array[int32]{1, 2, 3}
let shared = slice[int32].FromArray(raw)
let view readonly slice[int32] = shared.AsReadOnly()
let copied = shared.ToArray()
```

The minimal source/library surface is:

| Proposed operation | Contract |
| --- | --- |
| `slice[T]{elements...}` | Allocate and initialize elements in lexical order; length = capacity = element count |
| `slice[T].Create(length, capacity)` | Validate `0 <= length <= capacity`; allocate `capacity` CLR-default elements |
| `slice[T].FromArray(array)` | Explicit sharing of the entire exact array; length = capacity = array length |
| `.Length`, `.Capacity`, `.IsEmpty` | Descriptor observations, not dynamic collection counts |
| `s[lo..hi]` / `.Subslice(lo, hi)` / `.Slice(lo, hi)` | Share storage; `hi` is an exclusive endpoint, not a count; `.Slice` is an extension facade |
| `.Subslice(lo, hi, max)` / `.Slice(lo, hi, max)` | Share storage with capacity limited by exclusive endpoint `max` |
| `.Append(value)` | Return the resulting descriptor; never resize the receiver descriptor in place |
| `.AppendRange(source)` | Append a slice/read-only slice's current logical range; return a descriptor |
| `.CopyTo(destination)` | Copy `min(source.Length, destination.Length)` elements; return that count |
| `.Clear()` | Write CLR-default elements in the logical range; retain descriptor and capacity |
| `.Clone()` | Independent backing, shallow element copy, capacity = length |
| `.ToArray()` | Explicit independent, exact-length CLR array copy |
| `.AsReadOnly()` | Same range/capacity, fewer permissions; no element copy |
| `.AsSpan()`, `.AsMemory()` | Borrowed span or heap-storable memory of the logical range only |
| `.TryGetArray(out result)` | Succeed only for a whole-array descriptor as specified below |

`readonly slice[T]` exposes observations, slicing, `CopyTo`, `ToArray`,
read-only span/memory access, and `Clone` producing a mutable independent copy.
It does not expose append, clear, writable refs, or a writable backing array.
No implicit `IEnumerable[T]`-to-slice conversion enumerates user code. An
explicit future sequence factory is ordinary library work, not necessary here.

`make`, `append`, `len`, `cap`, and `delete` remain retired under ADR-0174.
`.Append` is a member on a new type, not restoration of the old built-in.
`List[T]` remains appropriate for an independently growing collection.

#### Type modifier, not a second magic identifier

Use a contextual two-token type form, following
[ADR-0042's `async sequence[T]`](0042-async-sequence-type-clause.md).
The existing parser handles that precedent in
[Parser.TypeClauses.cs](../../src/Core/CodeAnalysis/Syntax/Parser.TypeClauses.cs),
`ParseAsyncPrefixedTypeClause`; directional `in chan[T]` / `out chan[T]`
provide another modifier-plus-magic-type example.

```ebnf
NativeSliceType = ["readonly"] "slice" "[" TypeClause "]" ["?"] .
```

`readonly` selects the read-only native slice type only when followed by
`slice[` in a type-clause position. It remains contextual, not a newly reserved
word. The form works in local/field/parameter/return annotations, generic
arguments, tuples, and other existing type-clause positions. Formatters,
diagnostics, completion, and symbol display use `readonly slice[T]`; the
joined spelling is not an additional magic alias. This does not reserve a
user-defined identifier named `readonlySlice`.

#### Ordinary names take precedence over native aliases

`slice` and `array` are currently ordinary identifiers; existing code can
declare or import generic types with those names. The new aliases must not
silently retarget such references. Preserve ordinary visible type/type-alias
lookup first, including its normal scope, arity, accessibility, and ambiguity
rules. A visible ordinary type or alias claiming the name prevents native
fallback: wrong arity, failed constraints, or ambiguous imports remain the
ordinary diagnostic, not a reason to reinterpret the spelling as a native
type. Only an unescaped, otherwise unclaimed `slice[T]` or `array[T]` acquires
the native meaning.

Qualified names always use ordinary lookup; native behavior then follows the
resolved runtime assembly/type identity, not a matching short name. When a
user type shadows the aliases, the runtime spellings
`Gsharp.Values.Slice[T]` / `Gsharp.Values.ReadOnlySlice[T]` and the existing
exact-array `[]T` spelling remain explicit alternatives.
[ADR-0170](0170-escaped-identifiers.md)'s `$slice[T]` and `$array[T]` force
ordinary identifier lookup and never request a native alias; an unresolved
escaped name stays unresolved. Formatters must not remove an escape when
doing so would change that classification.

```gsharp
// Existing named-type behavior must survive the new aliases.
class slice[T] { var Value T }
let first = slice[int32]{Value: 1}
let second = $slice[int32]{Value: 2}  // the same user-declared type
// Proposed native runtime, explicitly selected despite that shadowing:
let native = Gsharp.Values.Slice[int32].Create(2, 4)
let raw = []int32{1, 2}
```

`readonly slice[T]` is admitted only when its `slice[T]` denotes the native
slice category. If ordinary lookup selects an unrelated user type, report
that the modifier requires the native slice and point to the explicit
`Gsharp.Values.ReadOnlySlice[T]` spelling. It does not adapt an arbitrary
same-named type. An escaped `$readonly` is an ordinary identifier, not this
modifier.

The parser must preserve enough original name/escape information for binding
to make this choice, instead of committing every `IdentifierToken` followed
by brackets to a new intrinsic. The same rule reaches literals, constructor
and static-member expressions, and type clauses; ordinary generic function
and value lookup must not be hijacked. Native-specific literal validation
happens only after selecting the native type. Generated code uses qualified
runtime spellings when a source declaration/import would shadow an alias.

| Proposed spelling | Meaning |
| --- | --- |
| `readonly slice[T]` | `Gsharp.Values.ReadOnlySlice<T>` |
| `readonly slice[T]?` / `(readonly slice[T])?` | Nullable read-only descriptor |
| `readonly slice[T?]` | Non-null descriptor whose elements may be null |
| `List[readonly slice[T]]` | Read-only descriptor as an ordinary generic argument |
| `ref readonly slice[T]` | Existing readonly-borrow modifier applied to a mutable-element slice descriptor |
| `ref (readonly slice[T])` | Writable borrow of a read-only-element descriptor slot |
| `ref readonly (readonly slice[T])` | Readonly borrow of a read-only-element descriptor slot |

Existing `ref readonly` parsing keeps priority; parentheses distinguish a
borrow's permissions from the element permissions of the descriptor it
references. The new modifier does not change `let`, borrowed-reference
lifetime, deep immutability, or the mutability of sibling aliases.

There is no implemented `readonly map[K,V]` magic type in the inspected
checkout. Its `map[K,V]` remains `Dictionary<K,V>`-backed and may convert to
implemented interfaces such as `IReadOnlyDictionary<K,V>`; that is not a
`ReadOnlyDictionary<K,V>` type alias. This ADR adds neither `readonly map`
nor a general-purpose `readonly T` modifier. Such forms require their own
representation and conversion decisions.

### 2. Representation, ownership, and type identity

The proposed public ABI is `Gsharp.Values.Slice<T>` and
`Gsharp.Values.ReadOnlySlice<T>` in one SDK-shipped assembly
`Gsharp.Runtime.Values`. The same small assembly hosts ADR-0188's types if
that proposal is accepted. This names a proposed addition, not an existing
project. It must follow the SDK's existing runtime-reference/versioning
machinery, without depending on the compiler or channel scheduler.

#### Why retain `Slice<T>`, and how to spell its methods

Keep the proposed runtime names `Gsharp.Values.Slice<T>` and
`Gsharp.Values.ReadOnlySlice<T>`. The source modifier changes the language
spelling, not those nominal CLR names. `Span<T>` would suggest the BCL's
borrowed, byref-like abstraction rather than this heap-storable descriptor
with independent append capacity.

The historical record found for this review does not establish the specific
claim that .NET renamed `Slice<T>` to `Span<T>` because enumerables had
`Slice()` methods. For example,
[dotnet/corefxlab#19](https://github.com/dotnet/corefxlab/pull/19) already used
`Span` on March 4, 2015, while
[dotnet/corefxlab#296](https://github.com/dotnet/corefxlab/pull/296), titled
"Adding yet another Slice<T>" on October 7, 2015, described competing
implementations and contained `Span.cs`. These are evidence of experimentation,
not a verified rename rationale.

There is a concrete authoring constraint:
[C# CS0542](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0542)
rejects an ordinary member named `Slice` declared inside a type named
`Slice<T>`. This is a C# declaration rule, not evidence of a CLR-wide collision
with methods on unrelated enumerable types. Do not require a C# implementation
to declare that otherwise-invalid instance member.

Use public `.Subslice(lo, hi)` / `.Subslice(lo, hi, max)` instance methods on
both runtime descriptor types. Provide allocation-free `.Slice(...)` extension
overloads in `Gsharp.Values.SliceExtensions` forwarding to those methods,
preserving the source examples above. They use ordinary extension lookup:
G# imports `Gsharp.Values`, and C# uses that namespace. Native `s[lo..hi]`
lowering calls the known `Subslice` member directly and does not depend on an
extension import. No exception to ordinary extension precedence or ambiguity
rules is introduced.

Both method spellings keep this proposal's exclusive-endpoint arguments;
they do not silently adopt
[Span<T>.Slice(start, length)](https://learn.microsoft.com/en-us/dotnet/api/system.span-1.slice).
The native-type lowering must therefore bypass the generic span-like
`Slice(start, length)` convention. C# consumers can always call `Subslice`
directly, and G# users can use range syntax. This keeps the desired type name
without requiring same-name member declarations or a rename to `Span`.

#### Descriptor layout and identity

`Slice<T>` is a normal readonly CLR value type with private immutable fields:

```text
T[]? owner; int offset; int length; int capacity
```

`ReadOnlySlice<T>` has the same conceptual state, without exposing writable
operations. Neither is a `ref struct`. No field stores a CLR managed byref.
The GC keeps the owner alive and tracks it if moved. Slicing retains the
**whole array**, including elements outside the visible range. No pooling,
disposal, permanent pinning, unmanaged owner, or ownership transfer is implied.

For an ordinary non-default descriptor:

```text
0 <= offset <= owner.Length
0 <= length <= capacity <= owner.Length - offset
```

The all-zero descriptor denotes the canonical empty slice. Operations normalize
its absent owner to `Array.Empty<T>()` when an actual array is needed; default
creation and slicing need not allocate. A zero-length view into a nonempty
owner still retains that owner, offset, and capacity. It is not normalized away.

Descriptor assignment, argument passing, and returning copy the descriptor;
they do not copy elements. The length of a caller's slice is not changed by a
callee appending to its own copy. References to objects contained in elements
are copied shallowly, just as struct fields containing references are.

Both native slice kinds are invariant in `T`, including nullable element
annotations for writable access. They exclude managed-byref, byref-like,
pointer, and `void` elements in the initial safe surface. An unconstrained
ordinary CLR type parameter is usable; a parameter permitting byref-like
instantiation is not. Metadata contains the real constructed runtime type,
not `SZARRAY` plus an attribute hoping consumers infer different semantics.
`array[T]` is different: its metadata is exactly `SZARRAY T`, identical to `[]T`.

Public signatures never switch between slice, span, and array because of escape
analysis. Reflection sees `Slice<int>`, not `int[]`. A slice boxed as `object`
is a boxed descriptor, not its owner. Runtime `is` checks do not synthesize
conversions or inspect elements.

### 3. Bounds, evaluation order, and exceptions

For native slices, range syntax is capacity-aware:

```text
s[lo..hi]          requires 0 <= lo <= hi <= s.Capacity
                   yields (owner, offset+lo, hi-lo, capacity-lo)
s.Slice(lo,hi,max) requires 0 <= lo <= hi <= max <= s.Capacity
                   yields (owner, offset+lo, hi-lo, max-lo)
```

Omitted `lo` is zero; omitted `hi` is the saved **Length**, not Capacity.
From-end `^n` resolves against saved Length. Thus `s[0..s.Capacity]` is an
explicit extension, whereas `s[..]` does not expose spare elements. Negative
from-end operands and results outside the above inequalities are invalid.
Ordinary element indexing always requires `0 <= i < Length`, including
index-from-end forms; `s[^0]` is not an element.

The receiver descriptor is evaluated and saved once, followed by each written
bound left-to-right. Then bounds are normalized and checked before any backing
access. For `Subslice` and its `Slice` extension facade, all argument
expressions run before validation as with a normal call. No failed first bound
skips evaluation of an otherwise reached later argument. A throwing receiver or
argument stops subsequent evaluation.
Arithmetic checks must not use overflowing `offset + hi` as validation.

Invalid element indices throw `IndexOutOfRangeException`; invalid slice bounds
or factory arguments throw `ArgumentOutOfRangeException` after argument
evaluation. Checked append-length overflow throws `OverflowException` before
any write. Allocation failure propagates the allocator's exception. These
are selected G#/.NET contracts, not Go panic messages.

For writes and compound assignments, save the receiver and index, perform the
location check, and use that same element location throughout the operation.
Do not compute an index twice or redo a source-local lookup after evaluating
the right-hand side. Suspending right-hand sides require saving an owner/index
descriptor and reconstituting a short-lived address, not storing a raw byref
in a state machine. A compound assignment also saves the old element value at
the normal read point before evaluating its right-hand side; reacquiring the
address after suspension must not re-read that value. A first implementation
must diagnose unsupported suspending lvalue forms rather than change their
evaluation order.

### 4. Append, overlapping copies, and reference stability

`Append` first evaluates receiver and value. `AppendRange` evaluates and saves
both descriptors before inspecting lengths or writing. If the required length
fits Capacity, append writes after the old Length in the **existing owner** and
returns a descriptor with the increased Length and unchanged Capacity.
Other descriptors can observe those writes if their ranges include them.
Ignoring the return value does not extend a variable's Length, although it can
still mutate shared spare storage.

If required length exceeds Capacity, allocate an exact-`T[]` owner with capacity
at least the required length; copy the old logical elements; append new
elements; return an offset-zero descriptor. Do not copy the unexposed spare
range. The growth heuristic may change with runtime versions and is not a
language promise. No particular Go growth factor is claimed.

`CopyTo` and in-capacity `AppendRange` have memmove-style overlapping behavior:
the copied values are those in the source range immediately before that copy
starts. Reuse the BCL's overlap-safe array/span machinery; do not implement an
unconditionally forward element loop. This is not an atomic snapshot with
respect to competing threads. All validation and required allocation occur
before destination mutation; element assignment invokes no user-defined
conversions or setters.

Growth does not retarget existing views, spans, borrowed element refs, or
ADR-0188 persistent element handles. They continue to identify old storage.
If spare capacity is shared, two separate appends can overwrite the same spare
slot; slice semantics do not serialize them or make either descriptor unique.

### 5. Addressable elements and readonly permissions

A native indexer denotes the actual array element. Loading it into a by-value
local makes an ordinary `T` copy. Assigning an entire element replaces that
slot. A nested mutable value-type field write, such as `frames[i].Left *= g`,
loads the element address and updates that field; it must not mutate a
temporary `T` copy. Ref-returning indexer metadata and existing
`RefCapabilities` are reused for G#/C# consistency.

`let s = ...` prevents rebinding `s`; it does not make the referenced elements
readonly. `readonly slice[T]` is the explicit permission-limited view. It returns
readonly element refs and propagates readonlyness through value fields.
Non-readonly struct calls through it use ADR-0181's defensive-copy rules.
Objects reached through reference-valued elements can still mutate, and other
writable aliases may exist. There is no deep immutability or exclusivity.

Borrowed refs/spans remain subject to existing escape and suspension checks.
ADR-0188 can add `managed(s[i])`, which snapshots this owner and absolute index
after the Length check. Slices themselves do not depend on persistent-reference
support. Capturing a slice under ADR-0189 copies a descriptor for an explicit
initializer, or shares the lexical descriptor variable for a binding capture;
those are intentionally different operations.

### 6. Default, nullable, equality, and iteration

`slice[T]` and `readonly slice[T]` are non-null value types. Omitted
initialization and explicit CLR `default` both produce usable empty descriptors. This is
consistent with ADR-0159's non-null intent, while avoiding an allocation.
`slice[T]?` is `Nullable<Slice<T>>`; `readonly slice[T]?` is
`Nullable<ReadOnlySlice<T>>`. A `?` inside either type's brackets instead
permits nullable elements. Nil comparisons on a bare native slice are rejected
as value-type comparisons; existing `[]T` nil comparison and warning behavior
is unchanged.

`Create` initializes elements using CLR defaults. In particular, allocating
reference-valued elements does not manufacture non-null objects. This retains
ADR-0159's documented element-default limitation rather than inventing a
different zero-initialization policy under the word "native."

Equality and hashing use **descriptor identity**, not element comparison:
owner reference identity, offset, Length, and Capacity must match. Canonical
default empties compare as descriptors over `Array.Empty<T>()`; a separately
allocated empty owner can remain distinct. Permission conversion preserves
the location/range, but equality operators compare descriptors of the same
declared kind; explicit conversion permits comparison across kinds.
`IEquatable<T>` and `GetHashCode` agree. Element mutation does not change the
hash. An explicit sequence comparison is required for content equality.

Iteration saves a descriptor once, iterates its saved Length, and reads each
current element by value as visited. It has no collection-modification version
check. Reassigning the source slice variable does not change that iteration;
mutating the shared elements can affect subsequent reads. Native list-pattern
length tests use Length; a rest binding is a native shared view, not an array
copy. Patterns and iteration do not reveal Capacity implicitly.

### 7. Interoperability matrix

| Source -> target | Selected conversion |
| --- | --- |
| `[]T` <-> `array[T]` | Identity, including exact `T[]` metadata and existing array covariance rules |
| Imported C# `T[]` -> `array[T]` | Identity; never imported as native `slice[T]` |
| `array[T]` -> `slice[T]` | Explicit `FromArray`; share after exact runtime-array-type check |
| `slice[T]` -> `readonly slice[T]` | Permission weakening; descriptor copy, no element copy |
| `slice[S]` -> `slice[T]` | No variance, implicit element conversion, or hidden projection |
| `slice[T]` -> `array[T]` | No implicit conversion; `ToArray` copies explicitly |
| Whole `slice[T]` -> exact owner | `TryGetArray` succeeds only if offset = 0 and Length = Capacity = owner.Length |
| `slice[T]` -> `Memory[T]` | Explicit `.AsMemory()` sharing exactly Length |
| `slice[T]` -> `Span[T]` | Explicit `.AsSpan()` sharing exactly Length; borrowed lifetime rules |
| Readonly slice -> read-only memory/span | Same range with readonly access |
| `Memory[T]` -> `slice[T]` | Explicit `TryFromMemory`; array-backed only, Capacity = supplied memory length |
| `Span[T]` -> persistent slice | No sharing conversion; explicit copying factory only |
| Current `[N]T` -> native slice | Explicit array-sharing operation, retaining current reference-backed fixed-array semantics |
| CLR rectangular/non-SZ array -> native slice | Unsupported initially; no flattening or hidden copy |

`TryFromMemory` uses supported BCL array-segment recovery, then applies the
same exact-array check as `FromArray`; a custom memory owner is a failed
conversion, not a covert allocation. Its read-only counterpart accepts only
recoverable array-backed read-only memory. No writable conversion from a
read-only source is provided.

For a covariant CLR array such as `string[]` held in an `object[]` variable,
`slice[object].FromArray` throws `ArrayTypeMismatchException`, including for an
empty source. A non-null, exact runtime `T[]` is required; a null input throws
`ArgumentNullException`. Both readonly and writable native array factories
use this initial restriction. It avoids pretending a covariant array supports
arbitrary writable `ref T` and keeps native owners invariant. Nullable outer
arrays must be narrowed or handled explicitly; element nullability is carried
through generic arguments rather than discarded by the sharing conversion.

`TryGetArray` never returns a larger owner for a subrange. Failure returns false
and a null out result. A caller needing arbitrary sharing must accept
slice/memory/span. Copy-in/copy-out is not an implicit substitute: aliases,
exceptions, and intermediate observations can distinguish it.

The [Microsoft memory/span guidance](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
distinguishes heap-storable memory from borrowed spans. It does not provide
native append capacity semantics or transfer ownership to a slice. This ADR
deliberately limits owners rather than designing another memory-manager API.

### 8. Rejected programs and diagnostics

```gsharp
// Proposed examples: each line marked ERROR is rejected.
let s = slice[int32]{1, 2}
AcceptClrArray(s)                    // ERROR: explicit sharing/copy decision required
let wider slice[object] = strings    // ERROR if strings is slice[string]
let bad slice[Span[int32]]           // ERROR: byref-like element cannot be stored
let missing slice[int32] = nil       // ERROR: use slice[int32]? for absence
let ro = s.AsReadOnly()
ro[0] = 5                           // ERROR: readonly element
let saved = slice[int32].FromSpan(stackSpan) // ERROR: no persistent sharing
```

Diagnostics identify the exact source/target representations, not just
"cannot convert collection." Bounds errors remain runtime errors except where
existing constant-expression diagnostics prove failure. Assign fresh IDs at
implementation time; do not reuse retired built-in diagnostics for new
unrelated failures.

### 9. Compiler, metadata, and migration work

Introduce separate native slice type recognition without silently repurposing
the existing array-backed `SliceTypeSymbol`. Update type substitution,
nullability, common-type inference, addressability, pattern binding,
constructor/literal binding, and well-known runtime references together.
Identity recognition uses assembly/type identity, not a user type named
`Slice`. Keep `BindArraySlice` on the exact-array path; add a descriptor-view
path with its own bounds lowering that calls `Subslice` directly. Parse the
contextual `readonly slice` form at every type-clause entry point and preserve
its distinction from `ref readonly`; do not recognize the type by concatenating
tokens into a new keyword.

Use normal generic MemberRefs and the existing ref-return/indexer emitter.
Native element reads and writes must survive lowered async, compound
assignment, and nested value-element paths. Implementation and `/refout`
assemblies expose identical runtime types and nullability/ref metadata.
The runtime assembly version is a dependency of public slice APIs; missing or
incompatible runtime support is an actionable compiler/loader failure, never
a fallback to arrays.

cs2gs continues to emit `[]T`, or canonicalizes it to `array[T]` after that
spelling is supported. C# `T[]?`, nullable elements, `new T[n]`, array covariance,
reflection, range copies, list-pattern rest copies, and public array signatures
remain exact-array operations. C# `Memory<T>` and `Span<T>` stay those types.
No global cs2gs rewrite changes C# ranges into native views.

Migration is therefore opt-in:

1. Existing code compiles with its current meanings.
2. Buffer-oriented APIs can explicitly change signatures to `slice[T]`, an
   intentional CLR binary break at that API boundary.
3. A copied range becomes `nativeRange.Clone()` or `.ToArray()` when converting
   code whose original isolation matters.
4. Imported array-only APIs stay visibly copy-based or require a whole-array
   sharing check; they do not acquire invented slice overloads.

The implementation release must update the reference spec, diagnostic catalog,
formatter/LSP/type display, SDK runtime resolution, code model, examples, and
cs2gs printer together, following the
[compatibility policy](../compatibility-and-stability.md). This document-only
proposal does not edit those accepted contracts ahead of implementation.

### 10. Go translation boundary and fixed arrays

The translator still has specific obligations:

- Preserve nil versus non-nil empty slices explicitly, for example with
  `slice[T]?` plus helper operations that give nil the source-required
  length/slicing/append behavior. A native non-null empty default is not Go nil.
- Lower built-ins to members and checked temporaries; map bounds failures to
  the chosen Go panic/recover support rather than claiming CLR exceptions are
  already equivalent.
- Preserve source evaluation and integer-width rules; native endpoints are
  `int32`. Do not assume a particular growth heuristic or use descriptor
  equality as Go slice equality.
- Preserve element value copies. Current G# `[N]T` remains array-backed;
  `slice[[2]float64]` therefore does **not** solve Go `[][2]float64`.

For an incremental cliamp experiment, generate a small ordinary value
`StereoFrame` with two `float64` fields and mechanically lower fixed indices
and full-frame assignment to that struct. The outer `slice[StereoFrame]`
then has shared subranges and value-copy frames without per-frame arrays.
Dynamic `[N]T` indexing, addressability, nested fixed arrays, equality, and
public fixed-array APIs require either an explicit generated value-array
lowering with tests or a separate native value-array proposal. Reject an
unsupported case; do not silently translate it to a reference-valued array.
That bounded translator step is not a new application-wide Go slice runtime.

## Consequences

Positive:

- Shared views, cheap descriptor copies, capacity-limited growth, and correct
  nested value mutation become native, reusable language operations.
- Exact CLR array identity survives unchanged, including cs2gs and libraries
  that were compiled before this proposal.
- Slices can live in fields, closures, generic collections, and state machines
  without changing representation by context.

Costs and constraints:

- A new public runtime value type and compiler-known surface need coordinated
  versioning. G# now has two intentionally distinct buffer representations.
- Small views can retain large owners. Append into spare storage is visible to
  aliases; readonly views do not remove that sharing.
- G# nullability, exceptions, equality, and fixed arrays remain observably
  different from Go. A mechanical translator must account for those boundaries.
- Neither descriptor copying nor shared element access is synchronization.

## Alternatives considered

1. **Change `[]T` immediately.** Compact syntax, but breaks imported-array
   identity, published metadata, range-copy code, and cs2gs. Rejected in favor
   of an additive type with explicit migration.
2. **Use `Memory[T]` or `ArraySegment[T]` directly.** Good BCL interoperability,
   but neither directly supplies the selected independent capacity/append
   contract. Reuse them at boundaries, not as silently different semantics.
3. **Use `Span[T]` everywhere.** Appropriate inside synchronous hot paths,
   not for ordinary heap storage. Modern ref-like generics do not make a span
   heap-storable; see the
   [runtime addendum](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Ecma-335-Augments.md#byreflike-generics).
4. **Use `List[T]` or application `GoSlice[T]` wrappers.** The former has
   collection-object rather than copied-descriptor length semantics; the latter
   makes a general capability translator-specific.
5. **Switch representation using escape analysis.** Rejected as a public type
   or semantic rule. Local optimizations are welcome only when all alias,
   exception, equality, and ABI observations are preserved.

## Staged implementation and validation

The acceptance amendment above records implementation and measurement evidence.

1. **Identity and interoperability foundation.** Land `array[T]`, native
   runtime type identity, defaults/nullability, SDK references, literal creation,
   indexing, range views, and readonly access. Validate a cross-assembly
   G#/C# producer-consumer pair before adding growth.
2. **Complete bounded slice core.** Add capacity-limited slicing, append,
   overlap-safe copying, memory/span interop, pattern/iteration semantics, and
   the offline stereo-buffer witness. This stage is useful without either
   sibling proposal.
3. **Optional composition.** Add persistent element handles under ADR-0188 and
   captured/forwarded slice APIs under ADR-0189 when their contracts are ready.
   Do not block simple slice use on a universal ownership or proxy framework.

Discriminating conformance scenarios:

| Scenario | Required observation / wrong implementation it catches |
| --- | --- |
| Mutate `s[1..][0]` | Original element changes; catches old range-copy lowering |
| Copy descriptor, append within capacity | Old Length unchanged, shared spare write visible |
| Append after capacity limiting | Old views unchanged; catches ignoring the limit |
| Overlapping `CopyTo` in both directions and self-append | Exact expected sequence; catches forward-only loops |
| Retain element alias, grow/reassign slice, force GC | Alias still reaches old owner; catches retargeting |
| Zero-length view at nonzero offset with spare capacity | Capacity and later reslicing retained |
| Side-effecting/throwing bounds and RHS | Exact event trace; catches repeated or reordered evaluation |
| Nullable container versus nullable element; CLR defaults | Correct presence and metadata, not just successful parsing |
| `readonly slice[T]` in generic/tuple/ref type positions | Correct modifier binding, canonical display, and `ReadOnlySlice<T>` metadata |
| Range syntax, `Subslice`, and imported `.Slice` extension | Same endpoints, capacity, and exceptions in G#/C#; no same-name C# member requirement |
| Struct element field write versus value-local mutation | Backing write in first case, independent copy in second |
| Covariant array, subrange-to-array, memory-owner mismatch | Explicit failure, not hidden copying |
| G#/C# and `/refout` round-trip | Exact runtime type and ref/nullability contract |
| Existing cs2gs array/range/pattern corpus | Same outputs, array identity, and exceptions |

Apply ADR-0154: record a failing pre-feature or deliberately mutated product
witness for every new contract. Measure allocation counts and throughput
against raw arrays, BCL memory views, and explicit copies. Before accepting
performance results, require no per-slice allocation, no per-frame allocation
in the stereo witness, and no append allocation when capacity suffices;
declare machine/runtime-specific throughput budgets in the implementation PR.
No numeric speedup is asserted here.

## Remaining decisions and rollout gates

- Ratify the contextual `slice[T]`, `readonly slice[T]`, and `array[T]`
  lookahead/literal grammar with formatter, modifier-precedence, and imported
  generic-name collision tests. Preserve the two-token readonly spelling.
- Confirm the `Subslice` instance / `Slice` extension surface in C# and G#,
  including explicit namespace import and ordinary extension ambiguity behavior.
- Validate the runtime package identity and target-framework availability
  against all supported SDK modes before freezing public signatures.
- Verify bounds/exception traces and ref-return metadata through both
  implementation and reference assemblies before enabling public native APIs.
- Track fixed-value arrays independently. An end-to-end cliamp fidelity claim
  is blocked until its stereo-frame and other fixed-array cases are handled,
  even if this slice proposal is implemented perfectly.
