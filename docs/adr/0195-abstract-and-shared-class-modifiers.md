# ADR-0195: `abstract` and `shared` class modifiers

- **Status**: Proposed
- **Date**: 2026-10-02
- **Phase**: Phase 9 — language surface completeness (self-migration cut-over)
- **Related**: ADR-0017 (classes are sealed unless `open`); ADR-0053 (`shared`
  blocks); ADR-0078 (`sealed` = closed hierarchy, no CLR `Sealed` flag);
  ADR-0115 §B.4 / §B.11 (cs2gs class and static-member mapping — this ADR
  retires two of its "faithfully dropped" losses); ADR-0140 (`init { }` static
  initializer); ADR-0144 / ADR-0145 (partial types, source generators); issue
  \#987 (abstract members make a class abstract; GS0386–GS0388); issue \#4234
  (`@ExtensionOwner` hosts forced `abstract sealed`); issue
  [#4674](https://github.com/DavidObando/gsharp/issues/4674) (the migrated
  GSharp.Core changes the inheritance modifiers of its public types); parent
  issue [#3501](https://github.com/DavidObando/gsharp/issues/3501)
  (self-migration).

## Context

`GSharp.Core`'s public API is the ABI every G# analyzer binds to. A rebuilt,
migrated Core must expose the same CLR type shapes as the C#-built one, and the
metadata comparison in issue #4674 found two shapes G# has no way to say:

1. **An abstract class with no abstract member.** gsc sets
   `TypeAttributes.Abstract` only when the class's effective member set still
   contains an abstract member (issue #987). C# lets an author declare
   `abstract class BoundTreeWalker` with only concrete members to forbid
   instantiation, and Core does (`BoundTreeRewriter`, `BoundTreeWalker`,
   `GSharpSyntaxWalker`, and the abstract record `DocInline`). cs2gs could only
   drop the modifier (ADR-0115 §B.4, "the abstractness is intentionally
   dropped"), so these types came out instantiable.
2. **A static class.** The CLR spells it `abstract sealed`; the C# compiler
   emits no instance constructor. G# has no static class: cs2gs mapped one to a
   plain class whose members sit in a `shared { }` block (ADR-0115 §B.11), so
   the migrated type was instantiable (`IteratorMoveNextBodyBuilder{}`
   compiled) and no longer `abstract sealed`. 46 types in Core.

A heuristic in gsc ("a class that has only `shared` members is static") was
rejected: it would silently change the CLR shape and instantiability of existing
hand-written G# classes. The shape has to be declared.

## Decision

Two contextual class modifiers, spelled like `partial`, `unsafe` and `ref`
(identifiers that are modifiers only in an aggregate head, so a variable named
`abstract` or `shared` is unaffected). They may appear in any order among the
other head modifiers, on a top-level or a nested class.

### `abstract class`

```gs
abstract class BoundTreeWalker {
    func Walk(node BoundNode) { … }
}
abstract data class DocInline { … }
```

- Valid only on `class` (and `data class`); on `struct`, `enum` or `interface`
  it is an unexpected token, like the other misplaced modifiers.
- It **implies `open`**: the class is inheritable, its members may be `open`, and
  `protected` is allowed in it. `open abstract class` is accepted and means the
  same.
- It is emitted `TypeAttributes.Abstract` and never `Sealed`, whatever members
  the class declares. Abstract members are unchanged (issue #987); a class that
  has an unimplemented abstract member is still abstract without the modifier.
- It cannot be instantiated: `Foo()` is `GS0386` as before, and so is the
  composite literal `Foo{}` for a declared-abstract class (the literal path never
  checked abstractness; for a class that is abstract only through its members
  that gap is unchanged and tracked separately).
- The implicit default constructor of a declared-abstract class is `family`
  (C#'s default for an abstract class), not `public`.
- With `partial`, one part stating `abstract` makes the whole type abstract, as
  in C#.

### `shared class`

```gs
shared class IteratorMoveNextBodyBuilder {
    const Factor int32 = 3
    var calls int32

    func Build(x int32) int32 {
        calls = calls + 1
        return x * Factor
    }
}
```

`shared class` is the G# spelling of a C# `static class` (it was drafted as
`static class`; the maintainer chose `shared`, the word G# already uses for
static members, ADR-0053).

- **The body is the shared member list.** Every field, `const`, property, event
  and `func` declared directly in the body is a shared (static) member. There is
  no `shared { }` block inside a shared class; a non-shared class keeps its
  trailing `shared { }` block for its static members, which is by design.
  Nested types are declared in the body as in any class. Members call each other
  unqualified or through the class name.
- `init { … }` in the body is the static initializer (ADR-0140): in a shared
  class there is no instance constructor for `init(…)` to mean, so the block form
  is unambiguous.
- Valid only on `class`; on `struct`, `enum` or `interface` it is an unexpected
  token.
- It is emitted `abstract sealed` (the CLR's static class) and cannot be
  instantiated (`GS0386`). C# emits no constructor; gsc still plans a
  parameterless `.ctor` row, which it emits `private`, so it is not part of the
  type's API and the planned rows stay consistent.
- A shared class holds no instance state, so it cannot declare an `init(…)`
  constructor, a primary constructor, a `deinit` or a `shared { }` block of its
  own (`GS0617`), and it cannot have a base class or interface (`GS0619`).
  It cannot be combined with `open`, `sealed`, `abstract` or `data` (`GS0618`,
  reported on the conflicting modifier). `protected` is not allowed on its
  members (`GS0380`, it is not inheritable).
- With `partial`, **every part carries `shared`** (`GS0479` otherwise): a part is
  the body of the type, and `shared` decides what each part's members mean.
  A part contributed by a source generator (ADR-0145) is the exception that
  proves why: gsgen renders a shared class to the generator as a C# `static
  partial class`, so the generated C# part, back-translated against that stub,
  comes out a `shared partial class` part with its members flat.
- A class that hosts an `@ExtensionOwner`-routed extension method stays forced
  `abstract sealed` by the emitter (issue #4234); that rule is unchanged and
  agrees with this one.

### How gsc binds a shared class

The author's tree is kept as written (members in the class body) for the
language server, formatter and analyzers. Before binding, a normalization pass
gives the binder a copy whose body members sit in a shared block (made from the
class's own `shared` modifier and braces) and whose instance member lists are
empty, so the one binding path for a type's shared members is used. The pass
also reports `GS0617` and `GS0619`.

### cs2gs

A C# `abstract class`/`abstract record` is emitted `abstract class`/`abstract
data class` (no `open`). A C# `static class` is emitted `shared class` with its
members flat (no `shared { }` block), including nested static classes, every
part of a partial static class, and a C# static constructor as a flat `init { }`.
A non-static class keeps its trailing `shared { }` block. The two Info
diagnostics that recorded the dropped abstractness and the lost static no
longer fire.

### API surface

`StructDeclarationSyntax` gains `AbstractModifier`/`IsAbstract`,
`SharedModifier`/`IsShared` and `SharedInitializers`, additive public syntax
API. The symbol-level queries are `internal`.

## Consequences

- A migrated GSharp.Core keeps `abstract` on its four abstract types and
  `abstract sealed` on its 46 static classes; with the openness work in
  issue #4674 the migrated type headers match the C#-built ones.
- cs2gs output reads like the source: `abstract class`, `shared class`, with a
  static class's members flat.
- Two new modifiers-in-context to teach to editor grammars and documentation
  (`shared` was already highlighted). They do not reserve the words elsewhere.
- Hand-written G# gains a way to declare uninstantiable classes and static
  utility classes, but package-level functions remain the idiom for the latter.
- `GS0617`–`GS0619` are new diagnostics.

## Alternatives considered

- **Infer abstract/shared in gsc.** "Only `shared` members means static" changes
  the shape of existing classes; "no `open` members but `protected` means
  abstract" is arbitrary. Rejected: shape must be declared.
- **A `static class` modifier that keeps the members in a `shared { }` block**
  (the first draft of this ADR). It leaves the class body empty and the real
  members one block deeper, which reads unlike the C# it came from. The
  maintainer chose `shared class` with flat members.
- **Compiler-intrinsic annotations (`@AbstractClass`, `@StaticClass`),** the
  mechanism issue #4234 used for `@ExtensionOwner`. This avoids touching the
  grammar and the public syntax API, but it hides a type's central shape in an
  annotation. Rejected in favour of modifiers that sit where authors look for
  them.
- **Synthesize the shared block in the parser.** It would make the tree differ
  from the source for every consumer (spans, child order, the language server);
  the normalization pass does it for the binder only.
- **Require `open abstract`.** Redundant: an abstract class is never anything
  but inheritable.
