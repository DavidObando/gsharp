# ADR-0195: `abstract` and `static` class modifiers

- **Status**: Proposed
- **Date**: 2026-10-02
- **Phase**: Phase 9 — language surface completeness (self-migration cut-over)
- **Related**: ADR-0017 (classes are sealed unless `open`); ADR-0053 (`shared`
  blocks); ADR-0078 (`sealed` = closed hierarchy, no CLR `Sealed` flag);
  ADR-0115 §B.4 / §B.11 (cs2gs class and static-member mapping — this ADR
  retires two of its "faithfully dropped" losses); issue #987 (abstract members
  make a class abstract; GS0386–GS0388); issue #4234 (`@ExtensionOwner`
  hosts forced `abstract sealed`); issue
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
   emits no instance constructor. G# has no static class: cs2gs maps one to a
   plain class whose members sit in a `shared { }` block (ADR-0115 §B.11), so
   the migrated type is instantiable (`IteratorMoveNextBodyBuilder{}` compiles)
   and is no longer `abstract sealed`. 46 types in Core.

A heuristic in gsc ("a class that has only `shared` members is static") was
rejected: it would silently change the CLR shape and instantiability of existing
hand-written G# classes. The shape has to be declared.

## Decision

Two contextual class modifiers, spelled like `partial`, `unsafe` and `ref`
(identifiers that are modifiers only in an aggregate head, so a variable named
`abstract` or `static` is unaffected). They may appear in any order among the
other head modifiers.

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

### `static class`

```gs
static class IteratorMoveNextBodyBuilder {
    shared {
        const Factor int32 = 3
        func Build(x int32) int32 { return x * Factor }
    }
}
```

- Valid only on `class`. It is **additive to `shared`**: the members stay in
  the `shared { }` block (ADR-0053), so a migrated static class keeps the shape
  ADR-0115 §B.11 already produces and only gains the head modifier.
- It is emitted `abstract sealed` (the CLR's static class) and cannot be
  instantiated (`GS0386`). The placeholder default `.ctor` gsc still emits is
  `private`, so it is not part of the type's API; C# emits none.
- A static class declares only `shared` members and nested types:
  an instance field, method, property, event, `init` constructor, `deinit` or
  primary constructor is `GS0617`; a base class or interface clause is `GS0619`.
- It cannot be combined with `open`, `sealed`, `abstract` or `data`
  (`GS0618`, reported on the conflicting modifier).
- With `partial`, one part stating `abstract` or `static` makes the whole type
  so, as in C#; parts need not repeat it (unlike `data`, `inline` and `ref`,
  `GS0479`). A part contributed by a source generator (ADR-0145, the gsgen
  output of a `[GeneratedRegex]` partial class) cannot know the other parts'
  modifiers, so requiring agreement would reject a migrated
  `static partial class`.
- A class that hosts an `@ExtensionOwner`-routed extension method stays forced
  `abstract sealed` by the emitter (issue #4234); that rule is unchanged and
  agrees with this one.

### cs2gs

A C# `abstract class`/`abstract record` is emitted `abstract class`/`abstract
data class` (no `open`), and a C# `static class` is emitted `static class` with
its members in `shared { }`. The two Info diagnostics that recorded the dropped
abstractness no longer fire.

### API surface

`StructDeclarationSyntax` gains `AbstractModifier`/`IsAbstract` and
`StaticModifier`/`IsStatic`, additive public syntax API. The symbol-level
queries are `internal`.

## Consequences

- A migrated GSharp.Core keeps `abstract` on its four abstract types and
  `abstract sealed` on its 46 static classes; with the openness work in
  issue #4674 the migrated type headers match the C#-built ones.
- cs2gs output reads like the source: `abstract class`, `static class`.
- Two new keywords-in-context to teach to editor grammars and documentation.
  They do not reserve the words elsewhere.
- Hand-written G# gains a way to declare uninstantiable classes and static
  utility classes, but package-level functions remain the idiom for the latter.
- `GS0617`–`GS0619` are new diagnostics.

## Alternatives considered

- **Infer abstract/static in gsc.** "Only `shared` members means static" changes
  the shape of existing classes; "no `open` members but `protected` means
  abstract" is arbitrary. Rejected: shape must be declared.
- **Compiler-intrinsic annotations (`@AbstractClass`, `@StaticClass`),** the
  mechanism issue #4234 used for `@ExtensionOwner`. This avoids touching the
  grammar and the public syntax API, but it hides a type's central shape in an
  annotation and reads unlike the C# it came from. Rejected in favour of modifiers
  that sit where authors look for them.
- **Replace `shared { }` by static members declared directly in a `static
  class`.** A larger language change than migration needs, and it would move
  every migrated static class's members; deferred. This ADR keeps `shared`.
- **Require `open abstract`.** Redundant: an abstract class is never anything
  but inheritable.
