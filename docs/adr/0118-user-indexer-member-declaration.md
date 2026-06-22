# ADR-0118: User indexer-member declaration — `prop this[i int32] T { get; set }`

- **Status**: Accepted
- **Date**: 2026-06-22
- **Phase**: v0.2 — language surface
- **Related**: ADR-0051 (Property declarations — `prop Name T { get; set }`), ADR-0020 (Generic type-parameter brackets — Go-style `[T]`), ADR-0087 (Constructed generic user-type method references), ADR-0115 (C#→G# migration tool), issue #507 (member index assignment)
- **Issue**: [#944](https://github.com/DavidObando/gsharp/issues/944)

## Context

G# already supports index **access** on built-in and CLR types — array /
slice indexing (`xs[i]`), the Go-flavored map indexer (`m[k]`), and CLR
indexers on imported types (`list[0]` on `List[T]`, `d["k"]` on
`Dictionary[K,V]`). It also supports index **assignment** through those
same targets (`xs[i] = v`, `m[k] = v`, `d["k"] = v`; issue #507).

What was missing was a way for a **user-defined** G# type to *declare* an
indexer member — the analogue of C#'s `public T this[int i] => …`. A
type could expose a list internally but not present an `obj[i]` surface
of its own:

```gsharp
class Repo[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    // …no way to write `repo[0]`…
}
```

Worse, the most plausible spelling — reusing the `prop` keyword with a
`this[…]` name — did not merely fail to parse cleanly; on a **generic**
enclosing type it **crashed the compiler** with an internal exception:

```gsharp
prop this[index int32] T { get { return _items[index] } }
```

```text
error GS9998: ArgumentNullException: Value cannot be null. (Parameter 'key')
```

### Root cause of the ICE

`prop this[index int32] T` was parsed as an *ordinary* property named
`this` whose type clause was the malformed `[index int32]` (the parser
read `[` as the start of an array/map type). That produced a
`TypeClauseSyntax` with a **null** type-name identifier. When the binder
later resolved that type clause it called `Binder.LookupType(null)`. For
a **generic** enclosing type (`Repo[T]`) the lookup first probes the
in-scope type-parameter dictionary — `CurrentTypeParameters.TryGetValue(null)`
— and `Dictionary<string,…>` throws `ArgumentNullException ("key")` on a
null key. The non-generic case happened to dodge the dictionary and
produced (noisy) diagnostics instead, which is why the crash was
generic-only. The defect is therefore twofold: (1) no grammar for the
member, and (2) a missing null-name guard on the lookup path that turns a
parse-recovery artifact into an ICE.

The C#→G# migration tool (ADR-0115) had already discovered and filed this
gap (`Repository<T>.this[int index]`), emitting a
`translation-unsupported` record rather than risking the crash.

## Decision

### 1. Canonical grammar

A user indexer is declared with the **existing `prop` keyword**, with the
property *name* replaced by the contextual `this` followed by a
bracketed parameter list. This is the spelling proposed in issue #944 and
is the natural extension of the ADR-0051 property grammar:

```text
PropertyDecl   ::= 'prop' ( identifier | IndexerName ) TypeClause PropertyBody?
IndexerName    ::= 'this' '[' IndexerParam (',' IndexerParam)* ']'
IndexerParam   ::= identifier TypeClause
PropertyBody   ::= '{' PropertyAccessor* '}'
PropertyAccessor ::= ('get' | 'set' ('(' identifier ')')?) (Block | ';')?
```

```gsharp
class Repo[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }

    prop this[index int32] T {            // get-only indexer
        get { return _items[index] }
    }
}
```

```gsharp
class Grid {
    private var _cells []int32 = make([]int32, 16)
    prop this[i int32] int32 {            // get/set indexer
        get { return _cells[i] }
        set { _cells[i] = value }
    }
}
```

Rationale for reusing `prop this[…]` rather than inventing a new keyword:

- It mirrors C#'s `this[…]` mental model and **exactly** the form named
  in the issue, so it reads naturally to the C#/Swift audience and is the
  obvious target for the cs2gs translator.
- It keeps the bracket spelling consistent with index **access**
  (`xs[i]`) and with G#'s generic/array bracket tradition.
- It reuses the entire ADR-0051 accessor grammar (`get`/`set`, optional
  `set(name)` parameter rename, bodies) verbatim — no new accessor
  syntax, printer, or binder shape.

The `index` (or any) parameter name is the source name by which the
accessor bodies refer to the index; the setter value is `value` by
default (renamable via `set(v) { … }`), identical to ordinary
properties.

### 2. Semantics

An indexer is a **default member** of its type. It lowers to the standard
CLR shape:

- a `PropertyDef` named **`Item`** whose property signature encodes the
  index parameter types and the element (value) type;
- a `get_Item(<index params>)` accessor and/or a
  `set_Item(<index params>, value)` accessor, both `SpecialName |
  HideBySig` instance methods, linked to the `Item` property via
  `MethodSemantics`;
- a type-level
  `System.Reflection.DefaultMemberAttribute("Item")` so that the CLR,
  C#, and reflection (`Type.GetDefaultMembers()`, `PropertyInfo` with
  index parameters) all recognise the property as the indexer.

The accessor bodies see the index parameters and `this` (and the
receiver's fields/properties by bare name) exactly like an instance
method body. For a **generic** enclosing type (`Repo[T]`) the indexer
element type and parameter types may mention the type parameters; the
accessors and call sites resolve through the existing constructed
generic user-type machinery (ADR-0087: method references parented at the
constructed `TypeSpec`, signatures encoded with `!0`).

### 3. Access binding — `obj[i]` / `obj[i] = v` on a user type

When the target of an index expression is a user-defined type
(`StructSymbol`) that declares an indexer:

- `obj[i]` binds to a call of the indexer's getter
  (`obj.get_Item(i)`), modelled as a `BoundUserInstanceCallExpression`
  whose receiver is `obj`, method is the indexer's `get_Item`
  `FunctionSymbol`, and (for generic enclosing types) result type is the
  substituted element type.
- `obj[i] = v` binds to a call of the indexer's setter
  (`obj.set_Item(i, v)`), likewise a `BoundUserInstanceCallExpression`,
  with `v` converted to the indexer's element type. As an expression it
  yields the assigned value (consistent with the existing
  `BoundClrIndexAssignmentExpression` behavior).

Reusing `BoundUserInstanceCallExpression` means the indexer access path
inherits — for free — the IL emitter, the tree-walking interpreter, the
slot planner, generic `TypeSpec`/`MethodSpec` parenting, and value-vs-
reference `call`/`callvirt` selection. No new bound-node kind, visitor,
rewriter, or printer is introduced for access.

### 4. Emit

The indexer is a `PropertySymbol` with `IsIndexer = true` and an index
`Parameters` list, stored in the type's ordinary `Properties` collection.
Emit generalises the existing property-accessor emission:

- `get_Item` / `set_Item` accessor `MethodDef`s are emitted through the
  same `EmitFunction` pipeline as any computed-property accessor, now
  carrying the index parameters (getter) and index-params-plus-`value`
  (setter). They are named `get_Item`/`set_Item` and marked
  `IsSpecialName`. Their `MethodDef` handles are registered in
  `MethodHandles` so the `BoundUserInstanceCallExpression` access sites
  resolve (including the constructed-generic `TypeSpec`-parented
  `MemberRef`).
- the `Item` `PropertyDef` signature is encoded with the index
  parameters (`PropertySignature.Parameters(n, return, params)`).
- a single `DefaultMemberAttribute("Item")` custom attribute is emitted
  on the type.

The emitted IL is `peverify`/ILVerify-clean and round-trips: the type's
indexer is consumable from C# as a normal indexer.

### 5. Diagnostics (no ICE — ever)

Two layers guarantee the GS9998 internal-exception class is eliminated:

1. **Direct guard.** `Binder.LookupType` now treats a `null`/empty type
   name as "unresolved" and returns `null` (yielding the ordinary
   GS0113 "type doesn't exist" diagnostic) instead of indexing a
   dictionary with a null key. This removes the *entire* ICE class for
   any parse-recovery artifact that produces a null type name, not just
   the indexer case.
2. **Grammar.** The indexer member now parses to a first-class shape, so
   the mis-parse that produced the null type name no longer occurs for
   the canonical form.

Unsupported/malformed indexer shapes report focused diagnostics rather
than crashing:

- an indexer with **no parameters** (`prop this[] T`) → **GS0370**
  ("An indexer must declare at least one parameter").
- an indexer with **no accessor body** (auto-indexer `prop this[i int32] T`
  with no `{ … }`, or empty/abstract accessors) → **GS0371** ("An indexer
  must declare a `get` and/or `set` accessor with a body").

## Scope implemented in this PR

Fully implemented end-to-end (parser → symbol → binder → lowering →
emit + interpreter), with emit-and-run regression tests:

- **get-only** indexer on a **generic** class — the issue #944 `Repo[T]`
  repro: `Add` items, read `repo[0]`, assert the value.
- **get/set** indexer on a non-generic class: write via `obj[i] = v`,
  read back via `obj[i]`.
- **non-generic get-only** indexer.
- index access binding for both read and write to the declared indexer,
  including inside the type's own methods.
- the old crashing shape now compiles and runs — **no GS9998**.

## Deferred (with rationale)

- **Multi-parameter indexer *access*** (`obj[i, j]`). The index-access
  grammar (`IndexExpressionSyntax`) carries a *single* index expression,
  so `obj[i, j]` is not parseable today. The indexer **declaration**
  grammar and emit accept one-or-more parameters (forward-compatible,
  and valid for CLR/interop consumers), but a multi-parameter indexer is
  not callable from G# until the access grammar grows a comma-separated
  index list. Single-parameter indexers — the overwhelmingly common case
  and the issue repro — are fully supported for declaration **and**
  access. This is a grammar limitation on the access side, not an emit
  gap.
- **Overloaded indexers** (several `Item` properties differing by index
  type). G# has no indexer overload resolution yet; a type declares at
  most one indexer (a second reports GS0046 "already declared"). Liftable
  later without a grammar change.
- **`open`/`override` virtual indexers.** Indexers follow the same
  accessor-attribute defaults as computed instance properties; explicit
  virtual-indexer overriding across a class hierarchy is out of scope for
  this ADR.
