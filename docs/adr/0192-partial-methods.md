# ADR-0192: partial methods (`partial` on a `func` member)

- **Status**: Accepted (implemented)
- **Date**: 2026-09-19
- **Phase**: Phase 9 — language surface completeness
- **Related**: ADR-0144 (partial types — the direct precedent, whose
  `PartialTypeMerger` pre-pass this ADR extends rather than duplicates, and
  whose §F explicitly deferred partial members to "a future ADR … if a native
  scenario demands them"); ADR-0086 §1 (the universal `;` no-body marker, and
  GS0325 — the convention for an unsatisfied body-less declaration); ADR-0092
  (`@LibraryImport`, the other body-less-declaration precedent); ADR-0145
  (native source-generator host — the consumer that motivates this);
  ADR-0023 / ADR-0174 D4 (`async` / `suspend`, why G# treats function colour as
  part of a partial method's signature); ADR-0122 (`unsafe`); issue
  [#4301](https://github.com/DavidObando/gsharp/issues/4301) (retire the
  `__generatedRegex_` synthetic-identifier family), parent issue
  [#3501](https://github.com/DavidObando/gsharp/issues/3501) (self-migration,
  zero synthetic identifiers).
- **Related but explicitly out of scope**: PR #4326's ADR-0187 proposes a
  *native* `@GeneratedRegex` implementation inside gsc via narrow
  attribute-dispatch on a `;`-bodied `func`. That is a separate, independent
  effort. This ADR neither depends on it nor modifies it, and the language
  feature here is useful whether or not it lands. ADR-0187 explicitly rejects
  general partial-method support; Alternative 1 below records that disagreement
  and answers it rather than eliding it. (This ADR also deliberately skips
  diagnostic codes GS0593–GS0596, which PR #4326 has claimed on its own branch —
  see §E.)

> **Numbering note.** `main`'s highest ADR at the time of writing is 0186, and
> PR #4326 uses 0187 on its own branch. 0192 was assigned by the repo owner to
> leave room for both, after two numbering collisions earlier in the same
> session.

## Context

### The immediate motivation

Issue #4301 is one entry in #3501's "zero synthetic identifiers" programme: it
asks cs2gs to stop minting `__generatedRegex_<name>` identifiers. Those exist
because cs2gs cannot translate C#'s `[GeneratedRegex]` pattern natively, so
`TryTranslateGeneratedRegex` rewrites it into a cached `Regex` instance behind
a synthetic field name.

A prior investigation established that the *right* fix is not a better
rewrite but ADR-0145's `gsgen`: run the **real** Roslyn `[GeneratedRegex]`
generator against a G# project and translate its output back to G#, which
yields full parity — including the compile-time-specialized matching engine
(nested private classes overriding `RegexRunnerFactory`/`RegexRunner`,
`goto`-driven backtracking, span slicing), not merely a cached `Regex`. A
feasibility spike confirmed the actual generated C# translates and binds
through cs2gs's existing translator, after two small gsc fixes landing
separately (issue #4331 / PR #4334).

### The blocker: G# has no partial-method syntax

ADR-0144 gave G# `partial` on `class`, `struct`, and `interface`, and §F
explicitly scoped **members** out. That was the right call at the time: the
generator scenario ADR-0144 served (CommunityToolkit.Mvvm's
`[ObservableProperty]`) is one where a generator **adds new members** to a
user's type. Partial types are exactly the right shape for that.

`[GeneratedRegex]` needs the opposite shape. Its C# form is:

```csharp
public partial class Validators
{
    [GeneratedRegex(@"^\d{3}-\d{4}$")]
    private static partial Regex PhonePattern();   // user writes this
}

// generated:
partial class Validators
{
    private static partial Regex PhonePattern() => _PhonePattern.Instance;   // generator writes this
    // … plus the nested runner classes
}
```

Two declaring parts of **the same method**, merged into one: a user-written
part carrying the attribute and no body, and a generator-written part carrying
the real body. No amount of partial-*type* support expresses that — the two
parts are not two different members, they are two halves of one.

This shape is not specific to regex. It is the standard C# source-generator
member contract, used by JSON source generation, MVVM command generation,
`[LibraryImport]`, logging generators, and more. G# needs it as a general
language feature, not as a `@GeneratedRegex` special case.

### Why the compiler is well-positioned

ADR-0144 §E built `PartialTypeMerger`: a pre-pass in `Binder.BindGlobalScope`
that groups a type's parts, validates their heads, and **concatenates their
member lists** into one synthetic declaration node, which then runs through the
ordinary two-phase shell/body pipeline once. Crucially, that means: **by the
time the binder proper runs, the two parts of a partial method — even from
different files — are already two entries in the same `Methods` array.**

Collapsing two entries into one is a much smaller job than merging two
independently-bound symbols. That is the whole design.

## Decision

Add a contextual `partial` modifier to `func` members of a `partial class` or
`partial struct`. A partial method has exactly one **declaring** part and
exactly one **implementing** part; they are merged into one declaration, one
`FunctionSymbol`, and one MethodDef.

### A. Syntax — `partial` is a contextual modifier, and `;` is still the no-body marker

`partial` joins the contextual-identifier modifier family exactly as ADR-0144
§A established for types: **no** new `SyntaxKind`, **no** lexer change, **no**
reserved word. It is special only when the modifier run it starts terminates in
`func`, so `var partial = 1`, `func partial()`, and a field named `partial` all
keep working.

The declaring part reuses **ADR-0086 §1's universal `;` no-body marker**
rather than inventing a new "no body" spelling. This is the same marker
`@DllImport`, `@LibraryImport`, interface method signatures, and
`open func F() R;` abstract members already use — partial methods are the
fourth user of one mechanism, not a fourth convention.

```gsharp
// File: Validators.gs (hand-written)
package App
import System.Text.RegularExpressions

partial class Validators {
    shared {
        @GeneratedRegex("^\\d{3}-\\d{4}$")
        private partial func PhonePattern() Regex;      // declaring part
    }
}

// File: obj/gsgen/Validators.Regex.g.gs (ADR-0145 output)
package App
import System.Text.RegularExpressions

partial class Validators {
    shared {
        private partial func PhonePattern() Regex {     // implementing part
            return PhonePatternImpl.Instance
        }
    }
}
```

`partial` composes with every other `func` modifier in **any order** —
`public partial func`, `partial async func`, `async partial func`,
`unsafe partial func`, `partial unsafe async func` — matching ADR-0144 §A's
order-independence for type modifiers. Canonical style places it immediately
before `func`.

**Where it is allowed:**

| Position | Allowed? | Notes |
|---|---|---|
| `func` member of a `partial class` / `partial struct` | **yes** | The feature. |
| `func` inside that type's `shared { }` block | **yes** | The motivating scenario is static. |
| `func` member of a nested `partial` type | **yes** | Handled by the same recursion. |
| `func` member of a **non-partial** type | no — `GS0601` | C# CS0751's analogue. |
| Top-level `func` | no — `GS0600` | There is no type to be a part of. |
| Interface method signature or interface `shared { }` slot | no — `GS0600` | See §F. |
| `prop`, `event`, `init`, `deinit`, field | no — `GS0600` | See §F. |

Parser touch points: a `PartialModifier` settable token + `IsPartial` on
`FunctionDeclarationSyntax` (the existing `UnsafeModifier` pattern, with
`InvalidateCachedSpan()`); a `partial` probe in the class/struct member loop,
the `shared { }` loop, both interface member loops, and `ParseMember`; and one
shared `FunctionModifierRunEndsInFunc(offset)` lookahead that the existing
`unsafe` / `async` / accessibility probes now route through, because those
probes used to hard-code `Peek(n) == func` and `partial` may now sit between
them and the keyword.

`PartialModifier` is deliberately **not** `[SyntaxChildIgnore]`: the token must
take part in child enumeration so the declaration's `Span` covers it and tree
walks see it.

### B. The zero-implementation rule — G# diverges from C#, deliberately

This is the ADR's most consequential choice.

**C#'s rule**, for a partial method with no implementing part:

- A `void` (and `private`, no `out` params) partial method is **elided
  entirely** — the method is not emitted, and every *call* to it is deleted.
  This is the "optional generator hook" idiom (`partial void OnNameChanged(…)`).
- Anything else (a return type, accessibility, `out` params) is a **compile
  error**, because there is nothing to return.

**G#'s rule: an unimplemented partial method is always an error (`GS0602`).**

The reasoning is consistency with G#'s existing treatment of body-less
declarations, not novelty. Every other way to write a body-less `func` in G#
is either *satisfied by something* or *diagnosed*:

| Body-less form | What satisfies it | Diagnostic when nothing does |
|---|---|---|
| `@DllImport func F() R;` (ADR-0086) | an unmanaged entry point | `GS0325` |
| `@LibraryImport func F() R;` (ADR-0092) | a generated marshalling stub | `GS0325` |
| interface `func F() R;` (ADR-0018) | an implementing type | interface-implementation errors |
| `open func F() R;` in an `open` class | an overriding member | `GS0388` when the shape is wrong |

There is no G# precedent for "compile it away, and delete its call sites too".
That behaviour is a real semantic hole — a typo in the implementing part's
signature silently turns a method call into a no-op — and C# only tolerates it
because the idiom predates its own source-generator ecosystem. Introducing it
as a **new** convention for body-less declarations, when every existing one
agrees, would be the inconsistent choice.

Consequences of requiring an implementation:

- The G# rule is **uniform**: `void` and non-`void` partial methods behave
  identically. C#'s rule requires the author to know which of two regimes their
  method falls under.
- The "optional hook" idiom is not expressible. This costs nothing for the
  motivating scenario (`[GeneratedRegex]`'s generator always emits), and cs2gs
  already handles it at the translation layer: ADR-0143 elides unimplemented
  C# hooks and keeps only the implementing part, and ADR-0145's
  back-translation does the same. Those layers are unchanged by this ADR.
- If a genuine native need for optional hooks appears, it can be added later as
  an **opt-in** spelling without breaking any code this rule admits — whereas
  starting with silent elision and tightening later would be a breaking change.

`GS0602` is anti-cascade: the surviving declaring part is still handed to the
binder, so callers of the method bind normally, and both `GS0325` and `GS0388`
are suppressed on a `partial` body-less declaration so the user sees the one
error that is actually theirs.

### C. Where attributes live

**Attributes are the union of both parts, in part order with the declaring
part first.**

This matches C#'s own partial-method rule — the combined attributes of the
defining and implementing declarations — and it matches ADR-0144 §C's
annotation-union rule for type parts, so partial types and partial methods do
not disagree.

**Exception, deliberate: parameter-level annotations are *not* unioned; they
must match on both parts (§D).** C# does union parameter attributes. G# does
not, for two reasons. Mechanically, the merged node takes the implementing
part's `ParameterSyntax` nodes verbatim, so unioning would mean rebuilding
those nodes — real cost for a case the motivating scenario does not have
(`[GeneratedRegex]` methods take no parameters). Semantically, a parameter
annotation like `@AllowNull` is part of the contract callers see, which is the
same reasoning that makes `async`/`suspend` a must-match aspect (§D) rather
than an implementation detail. This is pinned by a test so a future relaxation
to C#'s union rule is a conscious change, not an accident.

The declaring part is where an author naturally writes the attribute
(`@GeneratedRegex(...)` describes the contract, not the implementation), and
the union rule means a generator-written implementing part **never has to
restate it**. This is the load-bearing property for issue #4301, and it is
tested by reflecting on the emitted method at runtime, not by inspecting the
syntax tree.

Each part's annotations bind in **their own file's** import scope, because
composed child nodes retain their own `SyntaxTree` — the invariant ADR-0144 §E
already established and relies on.

### D. Merge and consistency rules

The two parts must describe the same method. Rules, and the reasoning where G#
differs from C#:

| Aspect | Rule | Reasoning |
|---|---|---|
| Return type | Identical (normalized source text) | Same textual convention ADR-0144 §E uses for base clauses / type-parameter lists. `int32` vs `Int32` is a mismatch — stricter than name resolution, relaxable later. |
| `ref` / `ref readonly` return | Identical | Part of the calling contract. |
| `async` / `suspend` | **Identical on both parts** | **Diverges from C#**, which lets only the implementing part say `async`. In G# function colour is observable in the signature: `async func F() int32` presents `Task[int32]` to callers (ADR-0023) and `suspend` awaits implicitly (ADR-0174 D4). If only one part stated it, the two parts would describe different signatures. |
| Type parameters | Identical names, order, constraints | Mirrors GS0480 for types. |
| Accessibility | Agree **where stated**; a part may omit (effective = the stated one) | ADR-0144 §C's rule for type parts, applied unchanged. |
| `open` / `override` | Identical presence | Both are part of the vtable contract. |
| Parameters | Identical count, and each parameter identical as normalized text — name, `ref`/`out`/`in`/`scoped`/`params` modifiers, default value, **and annotations** | **Stricter than C#** on two counts: C# only *warns* (CS8826) on differing parameter names, and it *unions* parameter attributes rather than requiring them on both parts. A G# caller may pass an argument by name, and a parameter annotation such as `@AllowNull` is part of the contract callers see — so both belong to the signature the two parts must agree on. See §C for the mechanical half of the reason. |
| `unsafe` | Union | Per-part in ADR-0144 §C, but the merged node carries ONE signature: if either part's signature was written in an unsafe context (raw `*T` parameters), the merged node must bind in one. |
| Annotations | Union, declaring part first | §C. |
| Explicit-interface qualifier, receiver clause | Identical | Prevents silent divergence; see §F for why neither is a supported partial shape. |

All mismatches report `GS0604` with a short description of the aspect, at the
implementing part's identifier.

**Which method is which.** The grouping key is `(name, generic arity,
parameter types)`. Parameter types are essential: `partial func F(x int32);`
and `partial func F(x string) { … }` are two *different overloads*, each an
unmatched part — keying on the name alone would pair them and then report a
signature conflict the user never wrote. Within the key, a declaration's own
type-parameter names are substituted positionally (`!0`, `!1`, …) so
`Echo[T](value T)` and `Echo[U](value U)` group together and their differing
spellings surface as the precise `GS0604` type-parameter-list error rather
than as two unmatched parts.

**Part ordering and metadata stability.** The merged method takes the
**declaring** part's position in the member list. This is both what a reader of
the hand-written file expects and what keeps emitted member order stable when
the implementing part arrives from a generated file whose `@(Compile)` position
MSBuild may vary — the same concern ADR-0144 §D addresses for type parts.

### E. Diagnostics

| ID | Message |
|---|---|
| `GS0600` | `'partial' is not valid here; only a 'func' member of a 'partial class' or 'partial struct' may be partial.` |
| `GS0601` | `Partial method '{0}' must be declared inside a 'partial class' or 'partial struct'.` |
| `GS0602` | `Partial method '{0}' has no implementing part; every partial method declared in G# must be implemented by exactly one part with a body.` |
| `GS0603` | `Partial method '{0}' must have exactly one signature-only declaring part and one implementing part with a body, but found {1} declaring part(s) and {2} implementing part(s).` |
| `GS0604` | `Partial declarations of method '{0}' disagree on {1}.` |

`GS0603` covers every other malformed part shape — two bodies, two signature-only
parts, an implementing part with no declaring part (C# CS0759's analogue) —
with counts, rather than spending a code on each. `GS0602` gets its own code
because the zero-implementation rule (§B) is the one a user is most likely to
hit and most likely to want to key tooling on.

**Why the block starts at GS0600, not GS0593.** `main`'s highest code is
GS0592, but the in-flight PR #4326 has already claimed GS0593–GS0596 on its own
branch. Allocating "the next number" would have produced a merge-time
collision. The gap is deliberate and leaves headroom.

`GS0601` is reported by the merger rather than the parser because the parser
cannot know: the aggregate's own `partial` token is attached only *after* its
member list has been parsed.

### F. Scope limitations

**Partial properties** (a real C# 13 feature) are **out of scope**. They are a
natural and cheap future extension precisely because the mechanism generalizes:
the merger's declaring/implementing pairing, consistency validation,
annotation union, and part-count diagnostics are not method-specific — a
partial property would need an accessor-shape consistency rule and the same
collapse applied to `Properties` / `SharedBlock.Properties`. Until then
`partial prop` is `GS0600`, not a confusing parse cascade.

**Partial methods on interfaces** are out of scope. C# permits them
(partial interfaces since C# 8), but a G# interface method signature is
*already* body-less and *already* expects its implementation elsewhere, so
splitting it into a declaring and an implementing part has no meaning here.
`partial interface` as a **type** remains legal (ADR-0144); only its members
cannot be partial.

**`partial` on `init` / `deinit` / events / fields** is out of scope and
`GS0600`.

**Extension (receiver-clause) and explicit-interface-qualifier partial methods**
are not a supported shape; the consistency check compares both clauses so the
two parts cannot silently diverge if one is written anyway.

**Incremental rebind** needs no new guard: ADR-0144 §G already forces any file
containing a `partial` **type** onto the full-rebuild path, and a partial
method requires a partial type, so it is covered for free.

**cs2gs `GSharpPrinter`** deliberately does **not** learn to print `partial` on
a `func` in this ADR. That is consumer-side work — see "Follow-on work".

### G. Binder mechanics — as built

`PartialMethodMerger` (`src/Core/CodeAnalysis/Binding/PartialMethodMerger.cs`)
is the member-level analogue of `PartialTypeMerger`, and runs immediately after
it, over the declarations that pre-pass returns:

- It runs over **every** returned declaration, not only merged ones — a lone
  `partial class` may carry both parts of a method itself (C# allows this and
  so does G#), and a **non**-partial type carrying a `partial func` is the
  `GS0601` case.
- It recurses into `NestedTypes`, and covers both `Methods` and
  `SharedBlock.Methods`.
- For each group it validates the part shape (§B/§D) and, on a well-formed
  pair, builds one replacement declaration from the **implementing** part: its
  `SyntaxTree` — and therefore the file-scoped import scope its body and
  signature bind in — its signature tokens, and its body, plus the unioned
  annotations and any modifier only the declaring part states.
- On a malformed group it keeps exactly **one** surviving part (preferring an
  implementing one) so callers still bind and the existing duplicate-overload
  check (`GS0264`) does not pile a second, less informative error on top.
- The merged node records its declaring part (`FunctionDeclarationSyntax.DeclaringPart`),
  which doubles as the **idempotency guard**: the merger normalizes
  declarations in place, and the same syntax tree is bound more than once (the
  LSP rebinds; a test may compile one tree twice), so an already-merged method
  must be passed through rather than re-grouped as a lone implementing part.

**Nothing else changes.** The ~2 000-line body binder, every `Set*` installer,
`FunctionSymbol`, and the emitter are untouched, because one merged node yields
one shell member, one symbol, and one MethodDef — the same leverage ADR-0144
§E bought for types.

### H. Emit

Near-zero change, as predicted, and verified rather than assumed: the emit test
compiles a real two-file program through `gsc`, runs `ilverify` on the output,
executes it, and has the program reflect over its own metadata to assert that
exactly **one** `Loud` method exists and that it carries the `@Obsolete`
written only on the declaring part. A second metadata test asserts that a
`private` stated only on the declaring part really does produce a
`MethodAttributes.Private` method — proof the merged node carries the declaring
part's modifiers rather than silently defaulting.

## Consequences

- **Positive**: unblocks the gsgen path for `[GeneratedRegex]` (issue #4301) and,
  more generally, every C# source-generator member contract — JSON source
  generation, MVVM command generation, logging generators — since they all use
  this same two-part shape.
- **Positive**: hand-written G# gains the ability to separate a method's
  contract from its implementation across files, with the same mental model as
  C#.
- **Neutral**: no new reserved word; `partial` stays a valid identifier
  everywhere outside a modifier run that ends in `func` or an aggregate keyword.
- **Neutral**: the regression surface is confined to the merger, the new
  diagnostics, and the widened modifier lookahead. The widened lookahead is a
  strict superset of the old `Peek(n) == func` checks (it additionally accepts
  runs containing `partial`, which were previously errors), so no previously-legal
  program changes meaning.
- **Negative, known**: **tooling on the declaring part degrades until follow-on
  #5 lands.** The bound `FunctionSymbol`'s declaration is the merged node — the
  *implementing* part's tokens — so hover, go-to-definition, and
  find-references anchored on the **declaring** part's signature resolve to no
  symbol. This is the member-level version of the gap ADR-0144 §G closed for
  types with `PartialPartLocations`, and the merged node already retains
  `DeclaringPart`, so closing it is a definition-computer change with no
  binder work. Diagnostics are unaffected: `GS0602`/`GS0603` are reported at the
  declaring part's own identifier location.
- **Negative / deliberate**: the C# "optional generator hook"
  (`partial void OnFoo()` with no implementation) is not expressible in G#
  source. Handled at the cs2gs/gsgen translation layer, unchanged (§B).
- **Constraint**: stricter than C# on parameter names and on `async`/`suspend`
  placement. Both are deliberate (§D) and relaxable later without breaking
  existing code.

## Alternatives considered

### 1. A narrow "just enough for `[GeneratedRegex]`" special case — rejected

Teach gsc (or gsgen) to recognize the specific `@GeneratedRegex`-annotated
body-less `func` and pair it with a generated body, without a general `partial`
member modifier.

> **This alternative is not hypothetical, and this ADR is on the losing side of
> it elsewhere.** PR #4326's ADR-0187 proposes exactly this narrow
> attribute-dispatch mechanism and *explicitly rejects* general partial-method
> support, on the grounds that "no second consumer would exist for general
> partial-method support today, and the narrow `;`-body mechanism already does
> everything actually needed." That disagreement is recorded here honestly
> rather than papered over — and it is not a conflict: the two efforts are
> independent, and neither blocks the other.

Rejected here for two reasons ADR-0187's framing does not weigh:

- **There are second consumers, and they are the norm rather than the
  exception.** The declaring-part/implementing-part shape is the *standard* C#
  source-generator member contract, not a regex peculiarity: JSON source
  generation, MVVM command generation, and logging generators all use it. Every
  one of them arrives through the same ADR-0145 gsgen path, and every one of
  them needs this and nothing more. A narrow mechanism is dead weight the moment
  the second pattern appears.
- **The general feature is not meaningfully bigger to build.** The entire merge
  is one pre-pass over declarations that ADR-0144's existing partial-type
  mechanism has *already* placed in the same member list. A special case would
  still need the pairing, the signature validation, and the attribute union —
  just gated on one attribute name.

It would also fork the mental model: G# authors could not write by hand the
pattern that generated G# code uses.

### 2. Bind each part into a shared symbol with accumulating installers — rejected

Declare the method symbol from the declaring part, then have the implementing
part install its bound body onto that existing symbol.

Rejected for the same reason ADR-0144 §E rejected the equivalent design for
types, and more sharply here: it would require the body binder to distinguish
"install a body onto an existing symbol" from "create a symbol", seed
cross-part duplicate detection, and make return-type / parameter binding
"set once" across parts. The syntax-level merge confines the whole feature to
one pre-pass and leaves the binder, installers, symbols, and emitter
untouched — which is exactly what the test results show.

### 3. Mirror C# exactly on zero implementation parts (silent elision) — rejected

Elide an unimplemented `void` partial method and its call sites; error on
anything else.

Rejected: it would be G#'s fourth and only inconsistent convention for a
body-less declaration (§B), it introduces a genuine semantic hole (a signature
typo silently deletes call sites), and it is the harder direction to change
later — silence can be tightened only by breaking code, whereas an error can be
relaxed into an opt-in elision spelling at any time. The idiom it enables is
already handled one layer up, in cs2gs (ADR-0143) and gsgen (ADR-0145).

### 4. A generated-only member-augmentation spelling (`augment func …`) — rejected

The member-level analogue of the `augment class Foo` idea ADR-0144 already
rejected for types, and rejected here for the same reasons the owner gave
there: it forks the mental model from C#, is unusable by hand-written code, and
invents novel syntax for no expressiveness gain.

### 5. A dedicated `extern`-style keyword for the declaring part — rejected

Give the declaring part its own body-less spelling instead of reusing `;`.

Rejected on ADR-0086 §1's own reasoning, which rejected `extern` for P/Invoke:
`;` is already the **universal** no-body marker for every body-less `func`, and
a new keyword would introduce a one-of-a-kind body-shape grammar fork for no
gain. The declaring part is discriminated by `partial`, not by its body marker —
exactly as a P/Invoke stub is discriminated by its attribute.

### 6. Group partial-method parts by name alone — rejected

Simpler key, no parameter-type normalization.

Rejected on a concrete failure: `partial func F(x int32);` and
`partial func F(x string) { … }` are two distinct overloads, each an unmatched
part. A name-only key pairs them and then reports a signature conflict the user
never wrote — manufacturing the mismatch it then complains about. This is the
same defect class as issue #3907's `PartialTypeMerger.GroupByKey` arity bug,
and it is covered by its own test.

## Follow-on work (explicitly NOT part of this ADR)

1. **cs2gs `GSharpPrinter`**: render `partial` on a `func` so cs2gs and gsgen
   can *emit* partial parts (the type-level equivalent landed with ADR-0144 §G).
2. **gsgen wiring**: have ADR-0145's generator host translate real
   `[GeneratedRegex]` output into a G# implementing part against a user-written
   declaring part.
3. **Retire `TryTranslateGeneratedRegex`'s `__generatedRegex_` family** once (1)
   and (2) land — the actual close of issue #4301.
4. **Partial properties** (§F), if a native scenario asks for them.
5. **Tooling**: go-to-definition on a partial method returning *both* part
   locations, the member-level analogue of ADR-0144 §G's
   `PartialPartLocations`. The merged node already retains `DeclaringPart`, so
   this is a definition-computer change only.
