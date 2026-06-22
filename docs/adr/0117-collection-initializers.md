# ADR-0117: Collection initializers — `List[T]{…}`, `HashSet[T]{…}`, `Dictionary[K,V]{…}`

- **Status**: Accepted
- **Date**: 2026-06-22
- **Phase**: v0.2 — language surface
- **Related**: ADR-0020 (Generic type-parameter brackets — Go-style `[T]`), ADR-0104 (Map type clause — canonical `map[K,V]`), issue #522 (object initializers `T(args){ Prop = v }`), ADR-0115 (C#→G# migration tool)
- **Issue**: [#479](https://github.com/DavidObando/gsharp/issues/479)

## Context

G# could already construct generic collections with explicit `Add`/indexer
statements:

```gsharp
var list = List[int32]()
list.Add(1)
list.Add(2)

var counts = Dictionary[string, int32]()
counts["one"] = 1
```

and it had a dedicated literal for its Go-flavored built-in map type
(`map[string,int32]{"a": 1}`, ADR-0104) and for arrays/slices
(`[]int32{3, 1, 2}`). It also supported generic **struct/class composite
literals** (`Result[int32, string]{ Ok: 5 }`, ADR-0020) and C#-style
**object initializers** on a constructor call (`Foo(args){ Prop = v }`,
issue #522).

What was missing was a *collection initializer* for arbitrary CLR
collection types — the analogue of C#'s
`new List<int>{1, 2, 3}` / `new Dictionary<K,V>{ ["a"] = 1 }`. The
owner's request (issue #479) was explicit: provide canonical G# support
for collection initializers, do a **design pass first**, and include a
**comprehensive study of Swift collection initializers**. Plausible
spellings such as `HashSet[int32]{1, 2, 3}` either failed to parse (the
brace was interpreted as a struct-literal field list and `1` is not a
field name) or, in the constructor-args case, risked surfacing an
internal-exception (GS9998) class of failure rather than a clean
diagnostic.

## Comprehensive study of Swift collection initializers

Swift expresses all three collection literals with a single bracket
syntax and resolves them entirely by **target typing** through three
`ExpressibleBy…Literal` protocols.

### 1. Array literals — `[a, b, c]`

A comma-separated, bracketed list. Any type conforming to
`ExpressibleByArrayLiteral` can be built from it:

```swift
let xs: [Int] = [1, 2, 3]          // Array<Int>
```

The protocol requirement is a single variadic initializer:

```swift
init(arrayLiteral elements: Element...)
```

### 2. Set literals — also `[a, b, c]`

Swift's `Set` is built from the **same** array-literal syntax; the only
difference is the *target type*. The literal `[1, 2, 3]` is an `Array`
or a `Set` purely as a function of context:

```swift
let a: Set<Int> = [1, 2, 3]        // set (deduplicated)
let b: [Int]    = [1, 2, 3]        // array
```

(`ExpressibleByArrayLiteral` is reused for sets; there is also a
lower-level `SetAlgebra` story, but the *literal* funnels through the
array-literal protocol.)

### 3. Dictionary literals — `[key: value, …]`

A comma-separated list of `key: value` pairs inside the same brackets,
backed by `ExpressibleByDictionaryLiteral`:

```swift
let d: [String: Int] = ["a": 1, "b": 2]

init(dictionaryLiteral elements: (Key, Value)...)
```

Note the colon-separated pair shape (`"a": 1`) — *not* an indexer
assignment.

### 4. Empty-collection literals and target typing

The empty forms `[]` (array/set) and `[:]` (dictionary) carry **no**
element information, so Swift requires the type from context:

```swift
let emptyArray: [Int]         = []
let emptySet:   Set<Int>      = []
let emptyDict:  [String: Int] = [:]
let x = []      // error: type of expression is ambiguous without more context
```

The whole model is **target-type-directed**: the literal's *shape*
(`[…]` vs `[…:…]`) selects between the array/set vs dictionary protocol,
and the *static target type* picks the concrete conforming type and the
element/key/value types. There is no syntactic mention of the type at
the literal site (`Set([1,2,3])` is the explicit-type escape hatch).

## Comparison with C\#

### Classic collection initializers (C# 3.0)

```csharp
var list = new List<int> { 1, 2, 3 };               // → list.Add(1); list.Add(2); …
var dict = new Dictionary<string,int> { { "a", 1 } }; // → dict.Add("a", 1)
var dict = new Dictionary<string,int> { ["a"] = 1 }; // → dict["a"] = 1   (indexer set)
```

Semantics are **method-directed**, the opposite of Swift: the target
type must expose a public `Add(...)` (and implement `IEnumerable`); each
element is lowered to an `Add` call. The `{ {k, v} }` nested-brace shape
is `Add(k, v)`; the `{ [k] = v }` shape is an indexer set (overwrite, no
duplicate-key throw). The type is named explicitly at the construction
site (`new List<int>`), and constructor arguments are allowed
(`new Dictionary<…>(StringComparer.OrdinalIgnoreCase){ … }`).

### C# 12 collection expressions

```csharp
int[] a = [1, 2, 3];
List<int> b = [1, 2, 3];
int[] c = [..a, 4, 5];   // spread
```

Target-typed and type-name-free at the literal site (closer to Swift),
with a spread operator `..`. There is *no* dictionary form yet.

### Where G# already sits

G# is a **Go-for-the-CLR**-rooted language with a Go-style, explicitly
*typed-at-the-site* literal tradition (`[]int32{…}`, `map[K,V]{…}`,
`Result[T]{Field: v}`). The type is always named before the brace. That
makes the **C# classic, method-directed** model — not Swift's invisible
target typing — the natural fit for G#: we keep naming the collection
type before the `{`, and we lower to `Add`/indexer calls. We borrow
Swift's clean **`key: value`** dictionary-pair spelling (which also
matches G#'s existing `map[K,V]{k: v}` and struct-literal `Field: value`
shapes) instead of C#'s heavier `{ {k, v} }` nested braces, and we keep
C#'s **`[k] = v`** indexer form for overwrite/expression-keyed entries.

## Decision

### 1. Canonical grammar

A collection initializer is a **generic collection construction**
followed by a brace-enclosed element list:

```text
CollectionInitializer ::= ConstructionTarget '{' CollectionElementList? '}'
ConstructionTarget    ::= identifier TypeArgList                 (* List[int32]      *)
                        | identifier TypeArgList '(' Arguments? ')'  (* Dictionary[K,V](cmp) *)
                        | identifier '(' Arguments? ')'           (* non-generic ctor + collection *)
CollectionElementList ::= CollectionElement (',' CollectionElement)* ','?
CollectionElement     ::= Expression                             (* bare:    1            *)
                        | Expression ':' Expression              (* keyed:   "a": 1       *)
                        | '[' Expression ']' '=' Expression      (* indexed: ["a"] = 1    *)
```

Examples — all three collection categories, with and without explicit
constructor arguments:

```gsharp
hs := HashSet[int32]{ 1, 2, 3 }
hs2 := HashSet[int32](){ 1, 2, 3 }                       // empty-parens form is equivalent
xs := List[int32]{ 1, 2, 3 }
d  := Dictionary[string, int32]{ "a": 1, "b": 2 }        // key: value (Swift-style pair)
d2 := Dictionary[string, int32]{ ["a"] = 1, ["b"] = 2 }  // [key] = value (C#-style indexer)
ci := Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ "Key": 5 }  // ctor args
```

The no-parentheses spelling `List[int32]{…}` is sugar for
`List[int32](){…}`: the parser synthesizes a zero-argument constructor
call as the initializer target.

### 2. Disambiguation from struct literals and object initializers

`Type[args]{…}` is shared with the **generic struct/class composite
literal** (`Result[int32,string]{ Ok: 5 }`). The parser decides by the
*first element's shape*, with no type information:

- empty `{}` or a leading `Identifier :` entry → **struct literal**
  (field list). Identifier-keyed dictionary entries must therefore use
  the `["x"] = v` indexed form; this keeps `Foo[…]{ x: y }` unambiguously
  a field initializer.
- a leading `[` (indexed entry), or any non-`Identifier :` first entry
  (a literal, a parenthesized expression, a bare identifier element,
  a `"str": v` pair, …) → **collection initializer**.

For the **constructor-args** form (`Type(args){…}` / `Type[args](args){…}`),
which shares the trailing-brace position with object initializers
(issue #522) and with a statement body, the parser requires an
unambiguous collection marker to avoid eating a following block: a
leading `[`, a single literal element, or a top-level `,`/`:` separator
inside the braces. An `Identifier =` first entry stays an **object
initializer**.

### 3. Semantics and lowering

A collection initializer binds to a `BoundBlockExpression` that:

1. evaluates the constructor call into a fresh synthetic local
   (`$collinit«n»`),
2. lowers each element in source order against that local:
   - **bare** `e` → `self.Add(e)`,
   - **keyed** `k: v` → `self.Add(k, v)`,
   - **indexed** `[k] = v` → indexer set `self[k] = v` (overwrite
     semantics; later duplicate keys win, matching C#'s indexed element
     initializer),
3. yields the local as the expression value.

Element, key, and value expressions are bound and converted to the
collection's element / `Add`-parameter / indexer types through the
ordinary overload-resolution and conversion machinery — the synthesized
`Add` call goes through the **same** accessor-call binder as a
hand-written `coll.Add(…)`, so generic-argument inference, params
expansion, user-defined conversions, and diagnostics are identical.

Because the lowering uses only pre-existing bound nodes
(`BoundBlockExpression`, `BoundVariableDeclaration`,
`BoundImportedInstanceCallExpression`, `BoundClrIndexAssignmentExpression`),
**both** the IL emitter and the tree-walking interpreter execute it with
no new bound-node kind, visitor, rewriter, or printer changes, and the
emitted IL is verifiable.

### 4. Diagnostics (no ICE)

A collection initializer applied to a type that is not a collection —
no accessible instance `Add` for the bare/keyed forms — reports the
dedicated **GS0369** ("Type 'X' cannot be initialized with a collection
initializer because it has no accessible 'Add' method or settable
indexer"). Indexed `[k] = v` entries flow through the existing indexer
machinery (GS0226 not-indexable / read-only). A non-collection target,
a missing `Add`, or a bad element/key/value type produces a clean
compile-time diagnostic — **never** the GS9998 internal-exception class
of failure that issue #479 warned about. (Indexer *declaration* on
user types remains out of scope and is tracked separately by issue #944;
nothing here depends on it.)

## Scope implemented in this PR

Fully implemented end-to-end (parser → binder/lowering → emit +
interpreter), with emit-and-run regression tests:

- sequence/list initializers — `List[T]{…}`,
- set initializers — `HashSet[T]{…}` (and the empty-parens form),
- dictionary initializers in **both** canonical spellings —
  `Dictionary[K,V]{ k: v }` and `Dictionary[K,V]{ [k] = v }`,
- the explicit-constructor-args form —
  `Dictionary[K,V](comparer){ … }` and `List[T](){ … }`,
- nesting (`List[List[int32]]{ List[int32]{1,2} }`), trailing commas,
  and generic value types (`Dictionary[string, List[int32]]{…}`),
- any CLR collection type exposing `Add` (`Queue`, `Stack`, `SortedSet`,
  `LinkedList`, …) works through the same path.

## Deferred (with rationale)

- **Target-typed, type-name-free literals** (Swift `[1,2,3]` / C# 12
  `[1,2,3]` with no type before the brace). G#'s entire literal tradition
  names the type at the site (`[]int32{…}`, `map[K,V]{…}`,
  `Result[T]{…}`); introducing an invisible-target-type literal is a
  separate, larger design (it interacts with overload resolution and
  `var` inference) and is intentionally out of scope. The named-type
  form is the canonical G# spelling.
- **Spread/`..` elements** inside the initializer. Orthogonal to the
  initializer shape; deferred to a future collection-expression ADR.
- **Identifier-keyed `{ x: y }` dictionary entries.** Reserved for
  struct-literal field initialization (see §2). Use `{ [x] = y }` for an
  identifier/expression key. This is a deliberate grammar choice, not a
  gap.
- **User-defined (non-CLR) collection types.** The `Add`/indexer
  resolution targets CLR collection types (`ClrType != null`). A
  user-declared G# class that wants collection-initializer support is a
  niche case; it reports GS0369 cleanly today and can be lifted later
  without a grammar change.
