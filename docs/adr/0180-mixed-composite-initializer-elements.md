# ADR-0180: Mixed initializers with explicit receiver member designators

- **Status**: Accepted
- **Date**: 2026-09-13
- **Amended**: 2026-09-14 -- explicit `.Member:` designators replace speculative member/key reclassification.
- **Phase**: v0.2 -- language surface (ADR-0117 follow-on)
- **Related**: ADR-0117 (collection initializers), ADR-0148 (structural projections), ADR-0079 (owned methods), ADR-0159 (sound collection zero values), ADR-0156 (emitted execution), issue #3160 (spread).
- **Issue**: [#3785](https://github.com/DavidObando/gsharp/issues/3785)

## Context

Declarative trees commonly combine properties with an `Add(Node)` method.
Requiring a `Children: { ... }` wrapper at every level adds nesting and a
framework-specific convention to otherwise ordinary typed construction.
Mixed initializers remove that wrapper without introducing builders,
attributes, implicit string-to-node conversions, or a UI-specific runtime.

There are two independent ambiguities to resolve:

1. Does `...source` project members or enumerate content?
2. Does `Identifier: value` assign a member or insert a key/value pair?

ADR-0148 and ADR-0117 already answer the first syntactically:
`Type{ ...source }` is structural projection, while a leading spread in a
call-headed collection initializer, `Type(){ ...source }`, enumerates content.
Explicit call parentheses do **not** answer the second question.

The initial implementation tentatively parsed
`Type(){ ...source, Identifier: value }` as a member literal, then used type
lookup and member-existence checks to fall back to collection initialization.
That rule was not backward-compatible:

```gsharp
let Capacity = "b"
let values = SortedList[string, int32](){ ...pairs, Capacity: 2 }
```

An existing `Add(Capacity, 2)` became a `Capacity` property assignment.
Checking writability cannot fix the writable-property case. A member added
by a library update, or a local key variable renamed without changing its
value, must not change the operation performed by existing source.
Furthermore, a tentative member-only parse cannot preserve arbitrary later
keyed/indexed entries for binder fallback.

This amendment supersedes that tentative parse, `SourceCallTarget` fallback,
and `AllKeyedEntriesAreMembers` / `AllKeyedEntriesAreClrMembers` policy.

## Decision

### A. Syntax selects the operation; binding validates it

The canonical mixed form extends the existing call-headed collection
initializer with an explicit receiver member designator:

```gsharp
Container(layout){
    .Width: 320.0,
    .Padding: 12.0,
    Text("Account"),
    ...rows,
    .Height: 100.0,
}
```

```text
CallInitializer       ::= CallTarget '{' CallElementList? '}'
CallElementList       ::= CallElement (',' CallElement)* ','?
CallElement           ::= '.' Identifier ':' InitializerValue
                        | '...' Expression
                        | '[' Expression ']' '=' Expression
                        | Expression (':' Expression)?
InitializerValue      ::= Expression | '{' CallElementList? '}'
```

`CallTarget` retains the existing constructor/function-call expression,
including arguments, generic arguments, and qualification. Empty and
non-empty constructor argument lists use the same rules. Ordinary call
resolution still applies: this syntax does not invent a constructor
overload or make an otherwise invalid `Type()` call valid.

| Element | Operation on the initializer receiver |
|---|---|
| `.Member: value` | Field/property initialization |
| `expression` | `Add(expression)` |
| `...source` | Evaluate once, enumerate once, `Add` each item |
| `key: value` | `Add(key, value)` |
| `[key] = value` | Indexer assignment |

These meanings do not depend on element order, member existence, or
whether the call names a type or a factory. An unmarked identifier key is
always an expression in this family, including when it names a target member:

```gsharp
SortedList[string, int32](){
    ...pairs,
    Capacity: 2,      // Insert the key held by variable Capacity.
    .Capacity: 20,    // Set the receiver's Capacity property.
}
```

`.Identifier:` is recognized only at an initializer-element boundary. It
does not introduce general implicit-receiver expressions or `.Method()`
calls. A misspelled `.Capcity:` produces a member diagnostic, never a
keyed-insertion fallback.

### B. Preserve existing initializer families

| Existing spelling | Meaning |
|---|---|
| `Point{ X: 1, Y: 2 }` | Member literal |
| `Target{ ...source, X: 1 }` | Structural projection with an explicit override |
| `List[T](){ ...source }` | Content enumeration |
| `Dictionary[K, V](){ ...pairs, key: value }` | Content enumeration and keyed insertion |
| `Type(args){ Member = value }` | Existing object initializer |
| `List[T]{ first, ...rest }` | Existing collection initializer with synthesized empty call |

The no-parentheses member family gains content elements after its first
member, preserving the concise form:

```gsharp
Container{ Width: 320.0, child, ...rows, Height: 100.0 }
```

Its ordered elements are `Identifier: InitializerValue`, bare expressions,
and non-leading content spreads. A leading no-parentheses structural spread
continues to allow only member overrides, first-and-at-most-once as ADR-0148
requires. Indexed/keyed collection entries are not added to this member family.

This does not reclassify old constructor-call object initializers beginning
with `Identifier =`. Unmarked `Identifier:` entries in a call-headed
collection initializer remain keys; authors use `.Identifier:` for members.
Body-header brace suppression remains in effect.

### C. One ordered sequence per existing syntax family

`StructLiteralExpressionSyntax.Elements` remains an ordered
`SeparatedSyntaxList<StructLiteralElementSyntax>` containing
`FieldInitializerSyntax` and `StructLiteralContentElementSyntax`.
The latter wraps either a bare expression or a
`SpreadElementExpressionSyntax`. The filtered `Initializers` compatibility
view retains original member/separator tokens, including a trailing comma
when the final source element is a member. Structural projection keeps its
distinct leading-spread fields.

Call-headed mixed initializers stay `CollectionInitializerExpressionSyntax`.
Its existing ordered `Elements` list additionally admits
`MemberCollectionElementSyntax`, which owns a dot token and a
`FieldInitializerSyntax`. Existing expression, keyed, and indexed element
nodes remain unchanged. The call is not discarded, tentatively re-read as a
type name, or reconstructed from a fallback member list.

Children, separators, spans, parents, and traversal order are defined by the
actual source tree. Formatting and editor features must handle the explicit
member node; generic traversal alone does not establish member resolution.

### D. Construction, lexical effects, and sound initial storage

1. Evaluate the ordinary construction/factory expression once.
2. Establish mandatory G# zero-value invariants for freshly default-constructed
   value storage, before any user initializer element can observe it.
3. Execute every user element against one synthesized receiver local, in
   lexical order, then yield that local.

A member value or content argument is evaluated at its own lexical position.
A spread source is evaluated once and enumerated once at its position;
empty sources do nothing, and multiple spreads remain independent.
Exceptions stop execution before later elements. No transaction, rollback,
or delayed publication guarantee is introduced.

Zero-value reconstruction is not an extra evaluation of source field
initializers. For example, in:

```gsharp
Basket{ Tag: 0, child, Items: MakeItems() }
```

an earlier `Add(child)` must see a sound empty non-null slice/map field
where required by ADR-0159, not a raw CLR null. `MakeItems()` must still run
later, at its source position. A skipped, side-effectful declaration
initializer must not be invoked merely to obtain that zero value.

Reuse `MagicCollectionZeroValue` and existing cross-assembly field markers.
Source value literals, imported semantic aggregates, and plain imported
value types must agree. Actual explicit or synthesized constructors own
their initialization: do not overwrite their field values with empty
instances. Do not reset objects returned by factories. Nullable fields
retain their existing nil defaults. Members-only literals retain their
existing evaluation and omitted-field behavior.

### E. Ordinary member and collection binding

Explicit member entries use shared object-initializer assignment binding:
normal field/property lookup, accessibility, setter checks, target typing,
and inherited/imported member projection. `.Member: { ... }` populates the
existing member collection through its `Add`/indexer operations, including
readable get-only collection members, rather than replacing it.

Content entries reuse existing `BindCollectionAddCall` and spread lowering.
Owned G# `Add` methods and imported CLR methods use the existing collection
contract, overload resolution, generic inference, optional/variadic
arguments, and conversions. The collection-interface `Add` support already
used by dictionary spreads remains available.

An initializer containing only member entries does not require `Add`.
Duplicate member designators are diagnosed, independently of keyed entries
with the same spelling. Indexed overwrite behavior and keyed `Add`
duplicate-key behavior remain distinct. Missing/inaccessible/unwritable
members remain member errors. Missing collection capability uses GS0369;
ambiguity and bad arguments use ordinary call/conversion diagnostics.
The shared assignment binder also rejects previously missed source `let`
field writes instead of emitting unverifiable post-constructor stores.

There is no new bound-node kind or runtime support. Both executable emission
and REPL execution consume the existing bound block, assignment, and call
nodes. Under ADR-0156 the REPL is emitted execution, not a separate
tree-walking interpreter.

### F. Scope

Supported: the existing member-first no-parentheses form and call-headed
mixed initialization with `.Member:`, including valid empty/non-empty,
generic, qualified, nested-construction, and factory-call targets.

Not introduced: a new constructor-resolution policy, type-parameter
construction/member capabilities beyond existing support, statement-style
`if`/`for` child elements, implicit string-to-node conversion, magic member
names, or additional spread operators. The pre-existing type-parameter
member-literal content limitation remains a diagnosed follow-up, not a
silent omission.

## Acceptance criteria

Every row is a merge criterion, not optional follow-up coverage. Named test
fixtures below live under `test/`; the shared cases run through both host
paths. A broad suite count is not a substitute for these exact behaviors.

| Area | Required regression and executable coverage |
|---|---|
| Stable key/member meaning | `Issue3785MixedCompositeInitializerEmitTests`: `Capacity` stays insertion on `SortedList`; `Count` stays insertion on `Dictionary`; renaming keys does not alter meaning; a dotted member and same-named key coexist |
| Complete element grammar | `Issue3785MixedCompositeInitializerParserTests` and emit tests: mixed identifier/expression keys, indexed writes, members, bare elements, spreads, and trailing separators remain in source order |
| Construction | Emit tests: empty/non-empty and named constructor arguments, qualified CLR/source calls, static/instance factories evaluated once, generic/nested children, and member access after initialization |
| Observable order | `Shared/Issue3785MixedInitializerCases`: constructor arguments precede construction; `Add` observes state before/after later member writes; effectful sources are evaluated/enumerated once; multiple and empty spreads |
| Sound storage | Emit tests and `Issue3329CrossAssemblyStructLiteralEmitTests`: omitted and later-explicit slices/maps in source structs and imported plain/data structs; skipped field-initializer effects stay skipped; actual/synthesized constructor contents are not reset |
| Binding and diagnostics | `Issue3785ExplicitMemberInitializerBindingTests`, `Issue3785ImportedParamsAddBindingTests`, and emit tests: member-only targets need no `Add`; missing/read-only/inaccessible/duplicate members do not become keys; ambiguous `Add`, invalid conversions, optional/params calls, lambda target typing, and user conversions |
| Compatibility and syntax fidelity | Parser tests and `Issue1675SyntaxNodeChildEnumerationTests`: members-only literals, leading structural projection, legacy object/collection syntax, token identity, trailing comma, parent/span/traversal fidelity |
| Formatting and editor support | `Issue3785MixedInitializerFormattingTests` and `Issue3785InitializerHoverCompletionTests`: formatting preserves tokens and is idempotent; completion/hover resolve explicit members, including incomplete input, without mistaking keys or value expressions for members |
| Host agreement | Compiler emit tests and `Issue3785MixedInitializerEmittedOracleTests` assert the same shared outputs; compiler fixtures verify emitted IL |
| User documentation | The language reference and `samples/MixedInitializers.gs` describe/exercise the canonical spelling; its golden output is checked |

## Consequences

The feature removes wrapper nesting with ordinary typed operations, and its
meaning is stable under key-variable renaming and target API growth.
Preserving the existing syntax families avoids an unrelated AST migration,
while shared lowering avoids a second assignment or collection protocol.

The cost is an explicit dot on members in call-headed mixed initializers,
and the existing distinction between structural and content spread remains
visible through parentheses. The concise member-first form and canonical
call form are intentionally different spellings, with the distinction fully
syntactic and documented.

## Alternatives considered

- **Member-existence or applicability-based reclassification:** rejected.
  A library change can alter existing behavior, and diagnostics become
  whole-literal reinterpretations instead of errors in the selected operation.
- **`.Member = value`:** equally unambiguous, but `.Member:` retains the
  existing literal convention. Only one explicit-member spelling is added.
- **A dedicated `Type() init { ... }` block:** possible, but adds another
  construct and a contextual-keyword compatibility problem without being
  necessary for the motivating case.
- **Unmarked `Member = value` as a universal mixed marker:** rejected;
  assignment expressions and the existing first-assignment object family
  already occupy that syntax.
- **A second spread operator:** does not solve member/key ambiguity.
  `...` and the existing construction marker suffice.
- **Parallel lists, a universal initializer AST, builders, or reflection:**
  unnecessary. Ordered elements in the existing families and shared ordinary
  binding/lowering provide the feature.
- **Do nothing:** safe, but retains the repeated collection-wrapper convention.
