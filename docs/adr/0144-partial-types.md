# ADR-0144: partial types (`partial` on class / struct / interface)

- **Status**: Accepted (implemented)
- **Date**: 2026-07-06
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0078 (aggregate declaration heads), ADR-0053 (`shared { }` static members), ADR-0140 (`shared { init { … } }`), ADR-0066 (deterministic top-level ordering), ADR-0105 (incremental rebind), ADR-0027 (bespoke compiler), ADR-0143 (cs2gs generator handling — companion), ADR-0145 (native generator host — companion), issue [#2201](https://github.com/DavidObando/gsharp/issues/2201)

## Context

Roslyn source generators add members to the **user's own** types via C# partial
classes. ADR-0145's native generator host emits translated `.gs` files under
`obj/` that must **augment** user-declared types (CommunityToolkit.Mvvm's
`[ObservableProperty]` generates a property *on the annotated field's class*).
G# today has no way to express this: a second declaration of a type name is a
hard `GS0102` "symbol already declared" error, and cs2gs works around the gap by
merging C# partial parts into one G# type at translation time (issue #1910) — an
option unavailable to a native G# build, where the generated part is a separate
source file compiled by gsc.

C# solves this with `partial`. The repo owner chose to add a first-class
`partial` modifier to G# — available to hand-written code too, mirroring the C#
mental model — over a generated-only augmentation mechanism (which would fork the
mental model and invent novel syntax usable only under `obj/`).

The compiler is well-positioned. `Binder.BindGlobalScope` already runs a
two-phase scheme: phase 1 declares a type **shell** per declaration
(`DeclareStructShell` → `scope.TryDeclareTypeAlias`, whose second registration of
a name reports `GS0102`); phase 2 binds each declaration's body into its symbol
via replace-style installers (`SetMethods`, `SetProperties`,
`SetStaticInitializerStatements`, …). The natural seam for partials is: **group
parts before phase 1, declare one shell from the primary part, run phase 2 once
per part with accumulating installers.** The emitter is driven entirely by bound
symbols (`Program.Structs`/`Interfaces`/`Enums`), using a declaration only as a
sequence-point/`.cctor` anchor — so one merged symbol yields one TypeDef
naturally.

## Decision

Add a contextual `partial` modifier to `class`, `struct`, and `interface`
declarations. Multiple `partial` declarations of the same type in the same
package are merged into one type symbol and emitted as one TypeDef.

### A. Syntax — `partial` is a contextual modifier

`partial` joins the existing contextual-identifier modifier family (`data`,
`inline`, `ref`, `unsafe` from ADR-0078): it is **not** a reserved word, adds
**no** new `SyntaxKind`, and requires **no** lexer change (so no coverage-matrix
churn). It is only special inside an aggregate declaration head, where the
trailing kind keyword disambiguates — `var partial = 1` and `func partial()`
keep working. It is accepted anywhere in the modifier run (the parser collects
modifiers in any order); canonical style places it immediately before the
aggregate keyword, preserving C# muscle memory:

```gsharp
// File: MainViewModel.gs (hand-written)
package App

@ObservableObject
public partial class MainViewModel : ObservableObject {
    func Describe() string { return "items: ${Items.Count}" }
}

// File: obj/gsgen/MainViewModel.Observable.g.gs (ADR-0145 output)
package App

public partial class MainViewModel {
    private var name string
    public Name string {
        get { return name }
        set { name = value; OnPropertyChanged("Name") }
    }
}
```

`partial` is allowed on `class` (including primary-constructor classes),
`struct` (including `data struct`), and `interface`. It is **rejected on `enum`**
(`GS0484`); it is unreachable for type aliases and delegates (they parse via the
`type` keyword path, so `partial type …` never matches an aggregate head).

Parser touch points: add `partial` to the modifier set scanned by
`TryDetectAggregateDeclarationHead`, add a `partialKeyword` arm to the modifier
loop in `ParseAggregateDeclarationCore` (with duplicate-modifier recovery), and
thread the token through the nested-type declaration path. A settable
`PartialKeyword` property + `IsPartial` on `StructDeclarationSyntax` and
`InterfaceDeclarationSyntax` (the existing `SealedKeyword`/`RefModifier`
extension pattern with `InvalidateCachedSpan()`) carries it — no new node type.

### B. Grouping and the duplicate-name rule (C# parity)

Declarations group by `(package, containing type or top-level, name)`. For a
group with more than one declaration:

- **All** declarations carry `partial` → they are parts of one type.
- **Any** declaration lacks `partial` while another has it → `GS0475` on each
  non-partial part (the analog of C# CS0260).
- **No** declaration is partial → today's `GS0102`, unchanged.

A single `partial` declaration with no siblings is legal (C# parity, and
essential: a generator may or may not add a part).

### C. Merge and consistency rules

Parts compose or must-agree as follows. New diagnostics are allocated after the
current maximum `GS0474`:

| Aspect | Rule | Diagnostic |
|---|---|---|
| Aggregate kind (`class`/`struct`/`interface`) | Identical on all parts | `GS0476` |
| Visibility | Agree where stated; a part may omit (effective = stated, default `public`) | `GS0477` |
| `open` / `sealed` | Union; `open` on one part and `sealed` on another conflicts | `GS0478` |
| `data`, `inline`, `ref` | Must appear on **every** part (they change how each part's own body binds) | `GS0479` |
| `unsafe` | Per-part (only that part's members bind in an unsafe context) | — |
| Generic parameters | Identical arity, **names**, order, and constraints | `GS0480` |
| Base class + base-ctor args | Base **class** may repeat only if identical; `: Base(args)` on at most one part | `GS0481` |
| Implemented interfaces | Union (duplicates collapse) | — |
| Primary constructor `(params)` | At most one part declares it | `GS0482` |
| Annotations `@Attr` | Union in part order | — |
| Members (fields, props, methods, events, `init(…)`) | Accumulate; existing collision codes (`GS0102`, `GS0264`, …) now apply across parts | existing |
| `deinit` | At most one across all parts | `GS0483` |
| `shared { }` blocks | Each part may have one; static members accumulate | existing |
| `shared { init { } }` (ADR-0140) | Concatenate in deterministic part order (§D); single `.cctor`, `beforefieldinit` cleared if any part has one | — |
| `partial enum` | Rejected at parse | `GS0484` |

New diagnostic messages:

- `GS0475` — "Missing 'partial' modifier on declaration of type '{name}'; another partial declaration of this type exists."
- `GS0476` — "Partial declarations of '{name}' must all be the same aggregate kind ('class', 'struct', or 'interface')."
- `GS0477` — "Partial declarations of '{name}' have conflicting accessibility modifiers."
- `GS0478` — "Partial declarations of '{name}' have conflicting 'open'/'sealed' modifiers."
- `GS0479` — "The '{modifier}' modifier must appear on every partial declaration of '{name}'."
- `GS0480` — "Partial declarations of '{name}' must have identical type parameter lists (including names and constraints)."
- `GS0481` — "Partial declarations of '{name}' have conflicting base clauses; only one part may supply base-constructor arguments and any repeated base class must match."
- `GS0482` — "Only one partial declaration of '{name}' may declare a primary constructor."
- `GS0483` — "Partial declarations of '{name}' declare more than one 'deinit'."
- `GS0484` — "'partial' is not valid on '{kind}'; only 'class', 'struct', and 'interface' declarations can be partial."

The `data`/`inline`/`ref` must-repeat rule is deliberately stricter than C#
(where `partial` composes freely); it can be relaxed later without breaking
existing code, and it keeps each part's body binding self-consistent.

### D. Deterministic part order

Parts order by `(source file path ordinal, span start)` — the same convention
`BindGlobalScope` already uses for cross-file top-level-statement ordering
(ADR-0066). The first part in this order is the **primary part**: it provides
the type symbol's anchor declaration (sequence points, `.cctor` anchor,
doc-comment host). Emitted member order is parts in this order, members in source
order within each part — so metadata is byte-stable regardless of how MSBuild
orders `@(Compile)` (which matters when generated `.g.gs` files under `obj/` join
the compilation).

### E. Binder mechanics — syntax-level merge (as built)

A pre-pass in `BindGlobalScope`, before shell declaration, merges each group of
`partial` parts into **one synthetic declaration node** and hands that single
node to the existing two-phase pipeline. `PartialTypeMerger.MergeStructs` /
`MergeInterfaces` (`src/Core/CodeAnalysis/Binding/PartialTypeMerger.cs`) group
the raw declarations by `(package, name)`, order the parts deterministically
(§D), validate head consistency (§B/§C, emitting `GS0475`–`GS0483`), and build a
single `StructDeclarationSyntax`/`InterfaceDeclarationSyntax` whose:

- members (`Fields`, `Properties`, `Events`, `Methods`, `Constructors`,
  `NestedTypes`, interface `StaticFields`) are **concatenated** across parts in
  part order;
- base classes / implemented interfaces are **unioned** (de-duplicated by dotted
  name), the base-constructor-argument part and primary-constructor part are the
  single part that supplies them, `deinit` is the single part that declares one;
- modifiers are composed per the §C rules (`open`/`sealed` unioned,
  accessibility/`data`/`inline`/`ref` validated, annotations unioned);
- `shared { }` blocks from every part are merged into one `SharedBlockSyntax`
  (static members concatenated, `init` blocks concatenated in part order,
  preserving ADR-0140 ordering);
- `SyntaxTree`, identifier, and brace tokens are the **primary part's** (so the
  type's own location and `packageByTree` lookup resolve to a real tree, and the
  emitter's sequence-point/`.cctor` anchor is the primary part).

`Binder.BindGlobalScope` then runs `DeclareStructShell` → `BindStructDeclarationBody`
(and the interface equivalents) **once** on the merged node, exactly as for a
lone declaration. The wiring is two one-line substitutions — the raw
`structDeclarations`/`interfaceDeclarations` enumerables are replaced by the
merged lists. **Nothing else changes**: the ~2 000-line body binder, every
`Set*` installer, `StructSymbol`/`InterfaceSymbol`, and the emitter are
untouched, because one merged node yields one shell, one symbol, and one TypeDef.
Cross-part member collisions (e.g. a field name declared in two parts) surface
through the body binder's existing duplicate detection (`GS0102`), since all
parts' members now live in one node.

This merge-the-syntax design was chosen over binding each part into a shared
symbol with accumulating installers (the higher-blast-radius alternative) because
two invariants make it sound: G# **imports are compilation-global** (`BindGlobalScope`
binds every tree's `ImportSyntax` into one shared scope), so a member body merged
from another file still resolves its type names; and G# **syntax nodes carry no
`Parent` reference**, so composing child nodes drawn from different parts/files
under one synthetic parent is safe — each child keeps its own `SyntaxTree`, so
diagnostics still point at the correct file and span.

**Nested partial types** are handled by the same merger recursively: when it
builds (or passes through) a type node, it merges the partial nested types in
that node's `NestedTypes` list, to any depth — so `partial class Outer`
contributing `partial class Inner` from two files yields a single merged `Inner`.

### F. Partial methods and properties are out of scope

Only **types** are partial in this ADR. C#-style partial-method hooks
(`partial void OnNameChanged(...)`) and partial properties are handled at the
generation/translation layer (ADR-0143 elides unimplemented hooks and keeps only
the implementing part; ADR-0145 back-translation does the same). A future ADR can
add source-level partial members if a native scenario demands them.

### G. Tooling

- **Go-to-definition** on a partial type returns **all** part locations. The
  merged node retains its source parts (`StructDeclarationSyntax.PartialParts` /
  `InterfaceDeclarationSyntax.PartialParts`, empty for a non-merged declaration),
  the definition computer maps each to its identifier location, and
  `textDocument/definition` returns an array (LSP permits `Location | Location[]`).
- **Document symbols** stay per-file — each file shows its own part; already
  computed from raw per-file syntax, so no change.
- **Incremental rebind** (ADR-0105): the body-only fast path cannot re-point a
  synthetic merged node from a single edited file, so any file containing a
  `partial` part **falls back to a full rebuild** (guarded in
  `IncrementalGlobalScopeReuse.ContainsUnsupportedConstruct`). Correct, and the
  full bind is already fast; a future optimization could re-point per-part.
- **cs2gs code model**: `Cs2Gs.CodeModel.TypeDeclaration` gains `IsPartial` and
  `GSharpPrinter` renders `partial` before the kind keyword — required so
  ADR-0145 can *emit* partial parts and so cs2gs can later emit parts directly.

### H. Emit

Expected near-zero change: the emitter consumes bound symbols, so one merged
symbol → one TypeDef with members in the §D order falls out. The audit confirms
`typeSym.Declaration` is used only as a sequence-point/`.cctor` anchor (the
primary part suffices) and that the merged `StaticInitializerStatements` drive a
single `.cctor`.

## Consequences

- Positive: unlocks ADR-0145 (generated `.gs` under `obj/` augmenting user
  types) with the same mental model as C#; hand-written code can also split large
  types across files.
- Positive (future simplification): cs2gs can stop merging C# partial parts at
  translation time (issue #1910) and emit one G# partial part per C# part,
  preserving file structure round-trip; ADR-0143 notes this.
- Neutral: no new reserved word — `partial` stays a valid identifier everywhere
  outside an aggregate head.
- Neutral: the syntax-level merge keeps the body binder, installers, symbols, and
  emitter untouched, so the regression surface is confined to the merger pre-pass
  and the diagnostics — the full Core and LanguageServer test suites pass
  unchanged. The single-`Location` definition response becomes `Location[]`, a
  small protocol-visible change clients must tolerate.
- Negative: the merger rebuilds a synthetic declaration node per partial group;
  the body-only incremental fast path is forgone for files containing partial
  parts (full rebuild instead — always correct).
- Constraint: stricter than C# on `data`/`inline`/`ref` (must-repeat),
  deliberately relaxable later.

## Alternatives considered

- **Generated-only augmentation** (`augment class Foo`, valid only under
  `obj/`). Rejected by the owner: forks the mental model from C#, is unusable by
  hand-written code, and invents novel syntax for no expressiveness gain.
- **Extension-members workaround** (generators emit extension functions instead
  of members). Rejected: cannot add state (fields), interface implementations, or
  properties *on* the type — which is exactly the CommunityToolkit.Mvvm contract.
- **Keep translation-time merging only** (the ADR-0145 host merges generated C#
  back into the user's `.gs` files or a shadow copy). Rejected: mutating user
  files breaks diffs and incrementality, and shadow-compiling whole files
  reintroduces the #1910 merge complexity inside every build.
- **Bind each part into a shared symbol with accumulating installers** (the
  originally-sketched §E). Rejected during implementation in favor of the
  syntax-level merge: it would require converting every replace-style `Set*`
  installer in the ~2 000-line body binder to accumulate, seeding cross-part
  duplicate detection, and making base-class / primary-constructor / type-param
  binding "set once" across parts — a large, error-prone surface. The syntax
  merge confines all partial logic to one pre-pass and leaves the binder,
  installers, symbols, and emitter untouched. It is sound only because imports
  are compilation-global and syntax nodes have no `Parent` (see §E).
