# ADR-0170: Escaped identifiers (`$name`)

- **Status**: Accepted
- **Date**: 2026-08-28
- **Related**: issue #3610, issue #3501 (self-migration fixture-policy), issue #3461 (keyword sanitizer), ADR-0047 (annotations), ADR-0096 (`@MarshalAs` parameter annotations), ADR-0115 (cs2gs).

## Context

A CLR assembly may declare namespaces, types, or members whose metadata
names are G# keywords — C# spells them `@class`, `@defer`, `@params`.
G# had no identifier-escape mechanism, which breaks both directions of
CLR interop:

- **Consumption**: G# code cannot reference an imported type, member, or
  namespace literally named a G# keyword. Import aliasing could rescue
  type names, but nothing rescues member access (`obj.defer()`).
- **Declaration**: migrated G# (#3501) cannot declare a member whose
  metadata name is a keyword without renaming it — which changes the ABI
  (reflection, `InternalsVisibleTo`, cross-assembly consumers) and can
  collide with a legal neighbor (`defer` → `defer_` collides with a real
  `defer_`; the adversarial shapes are pinned by
  `tools/cs2gs/Cs2Gs.Tests/Issue3461ReservedMetadataFixtures.cs`).

The #3461 keyword sanitizer (rename `params` → `params_`) remains
correct for locals and parameters, where the metadata name does not
matter; it is lossy for metadata-visible surface.

## Decision

G# gains **escaped identifiers**: `$` immediately followed by an
identifier-start character spells an identifier whose name is the
characters after the `$`.

```gs
class $defer {                      // metadata name: "defer"
    prop Value int32 -> 19
}

package $class { ... }              // namespace segment "class"

func f($params JsonElement) { ... } // parameter named "params"

let d = $defer{}
Console.WriteLine(d.Value)
let n = nameof($defer)              // "defer"
```

### Semantics

1. **Purely a spelling.** An escaped identifier is *just* an identifier:
   `$Value` ≡ `Value` when `Value` is not a keyword (C#'s rule for
   `@id`). Escaping is legal-but-redundant on non-keywords; no keyword
   semantics ever leak through an escape. The formatter may normalize
   redundant escapes away; the compiler does not diagnose them.
2. **Positions.** Every name position accepts the escape: type, member,
   parameter, and local names; member access (`x.$defer`); qualified
   type segments; `package` declaration segments and `import` paths;
   `nameof`. Annotation *names* are excluded (an attribute class named
   `defer` is out of scope; revisit on demand).
3. **Metadata.** Symbols carry the unescaped name, so emitted metadata,
   reflection, and cross-assembly consumption see `defer` — ABI-faithful
   round-tripping falls out with no emitter work.
4. **Never keyword-classified.** The lexer produces an
   `IdentifierToken` for `$name` unconditionally; contextual-keyword
   commitments (e.g. `unmanaged` at a type-clause start) compare source
   text and therefore never fire for the escaped spelling.

### Spelling rationale (why `$`, and why not `@name` / `@"name"`)

- **`@name` (C#'s spelling) is rejected.** G#'s `@` is the annotation
  sigil, and annotations occupy two positions where the overload is a
  genuine ambiguity, not mere awkwardness: statement-leading
  annotations (ADR-0047 §2 — `@defer(x)` is byte-for-byte both an
  annotation with arguments and an invocation of an escaped-name
  function, distinguishable only by the *next* statement) and
  parameter-leading annotations (ADR-0096 — `@a b.c` parses both as a
  bare annotation `a` on parameter `b` typed `c` and as escaped
  parameter `a` of qualified type `b.c`). No known language overloads
  one sigil for both jobs: C# affords `@name` only because its
  attributes are `[Attr]`; Java/Kotlin/Swift use `@` for annotations
  and chose different escapes.
- **`@"name"` (Zig's spelling) is rejected** for readability: it reads
  as an annotated string literal.
- **Backticks are taken** by raw strings; **`#` is reserved** as the
  natural future directive sigil (the compiler API already threads
  preprocessor symbols); **`\`** reads as an escape character.
- **`$` is free and effectively pre-reserved.** Outside strings `$` has
  no meaning in G#; the string lexer's own comment reserves bare `$`
  "forward-compatible: future grammar may attach meaning to it". The
  spelling is a bare sigil, visually symmetrical with C#'s `@name`.

### Interaction with string interpolation

`$` retains its interpolation meaning *inside* string literals,
unchanged, and the two meanings compose:

- `"$defer"` interpolates the in-scope variable whose name is `defer` —
  including one declared as `var $defer = …` (interpolation resolves by
  name text).
- `"$$class"` remains literal text `$class` (the existing `$$` escape).
- `"${$class.Value}"` is the explicit hole spelling when an escaped
  identifier appears inside an interpolation expression.

### Lexing

In the main token dispatch, `$` followed by a letter or `_` consumes the
`$` and the identifier run. The token is an `IdentifierToken` whose
`Text` is the full source spelling (`"$defer"`, so spans, printing, and
round-tripping stay source-faithful) and whose `Value` is the unescaped
name (`"defer"`). A `$` not followed by an identifier-start keeps the
prior behavior (bad-character diagnostic), preserving room for future
grammar.

`SyntaxToken` gains `ValueText` (Roslyn's concept): the string `Value`
when present, else `Text`. Semantic consumers (binder, symbols,
lowering, emit) read names via `ValueText`; syntactic consumers
(printer, formatter, contextual-keyword commitments) keep `Text`.

### cs2gs policy (#3501)

The printer emits the escape **only for metadata-visible names** (public
or internal surface and anything reflection-reachable) whose names are
G# keywords; the #3461 sanitizer keeps renaming locals and parameters
where readability wins and metadata does not care. The reserved-metadata
fixtures re-enter the corpus once the translator side lands.

### Tooling

The language server's completion inserts the `$` escape automatically
when completing an imported member or type whose name is a G# keyword.
The formatter treats `$name` as an ordinary identifier token.

## Consequences

- Keyword-named CLR surface becomes both consumable and declarable from
  G#, closing the Issue3461 fixture-policy item on #3501.
- The lexer change is additive; no parser changes are needed — `$name`
  is an ordinary `IdentifierToken`, so every existing name slot accepts
  it structurally.
- The `Identifier.Text` → `Identifier.ValueText` migration in the
  semantic layers is behavior-preserving for all existing code
  (identifier tokens previously carried a null `Value`).

## Alternatives considered

- **Context-sensitive `@name`** — rejected (see spelling rationale).
- **`@"name"` quoted escape** — rejected for readability.
- **`CompiledName`-style attribute only** (F# precedent: declare
  `defer_`, emit metadata `defer`) — solves declaration but not
  consumption (member access has no alias point); may still be added
  later as a complement for G#-authored libraries wanting distinct
  source and CLR names.
- **Import aliasing only** — rescues type names, not member access.
- **Stay out (sanitizer renames as policy)** — lossy for public
  metadata; breaks ABI round-tripping, the project's positioning.
