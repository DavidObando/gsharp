# ADR-0187: Native `@GeneratedRegex` support

- **Status**: Accepted
- **Date**: 2026-09-19
- **Related**: ADR-0086 (P/Invoke `@DllImport` — establishes the `;` no-body
  marker on a `func` declaration as the universal, attribute-discriminated
  bodyless-declaration grammar, and explicitly designs it forward-compatible
  with a future source-generator-style attribute); ADR-0092 (`@LibraryImport`
  — the first consumer of that forward compatibility, and the ADR whose §4
  named the exact trigger for revisiting "no general source-generator
  pipeline"); ADR-0051 (property declarations — the auto-property
  backing-field synthesis this ADR reuses for cached state); ADR-0185
  (tuple-destructuring parameters — retired `__q`, the largest active
  synthetic-identifier family; this ADR retires `__generatedRegex_`, the
  family ADR-0185's own Context section named as second-largest); issue
  #4301 (this ADR's tracking issue); issue #3501 (self-migration roadmap,
  "zero synthetic identifiers" goal, Track A).

## Context

`tools/cs2gs`'s `TryTranslateGeneratedRegex`
(`Cs2Gs.Translator/CSharpToGSharpTranslator.Members.cs:291`) lowers a C#
`[GeneratedRegex(...)] partial Regex Foo();` declaration into three G#
members: a synthesized private cache field named `__generatedRegex_{name}`
holding a `Regex` built once from the attribute's arguments, and an ordinary
forwarding method `Foo() Regex { return __generatedRegex_Foo }`. This is a
genuine, tested, working translation — but it is exactly the kind of
synthetic-identifier escape hatch issue #3501's "zero synthetic identifiers"
goal is retiring family by family: ADR-0185 retired `__q` (23 code / 55 raw
occurrences, the largest active family) and named `__generatedRegex_` (7
occurrences) as the next-largest still standing.

Two ADRs already anticipated exactly this consumer:

- **ADR-0086 §1** established `;` as G#'s universal "no body" marker on a
  `func` declaration and said so explicitly: *"The same parser shape —
  annotated `func` with `;` body — accepts the source-generator-style
  `@LibraryImport` attribute when we add it. The discriminator is purely
  the attribute type."*
- **ADR-0092 §4** cashed that promise in for `@LibraryImport` and, in
  rejecting a general source-generator pipeline, named the precise trigger
  for revisiting: *"The only consumer would be `@LibraryImport`. Other CLR
  source generators (regex, JSON, COM) are out of scope for the language
  for the foreseeable future... We revisit the source-generator
  infrastructure if and when at least one additional consumer is
  identified."*

`@GeneratedRegex` is that consumer. This ADR gives it a native G# spelling
so cs2gs can stop synthesizing `__generatedRegex_*`.

### Verified against current source, not assumed

- **The parser needs no change.** `FunctionDeclarationSyntax.HasSemicolonBody`
  (`SemicolonBodyToken != null`) is set purely from the presence of `;`
  versus `{`, with **no dependency on which attribute (if any) is
  present** — confirmed by reading the parser and by
  `Issue758LibraryImportParserTests`, whose own doc comment says the parser
  "stays permissive and only checks the shape; semantic validation ... is
  reported by the binder." `@GeneratedRegex(...) private func Pattern()
  Regex;` therefore parses today, with zero grammar changes. The "parser"
  deliverable below is a regression test pinning this, not new grammar.
- **`@GeneratedRegex`'s named constructor-parameter arguments bind today
  with no changes.** `DeclarationBinder.Attributes.cs`'s generic
  `BindAttribute` captures a `name: expr` argument by whatever name the
  user wrote (`matchTimeoutMilliseconds:`, `cultureName:`), with no
  validation that the name matches a real property/field on the resolved
  attribute type — that validation only happens for attributes the emitter
  later writes out as a `CustomAttribute` row (via reflection against the
  real CLR type), which `@GeneratedRegex` never is (see Decision, "not a
  `CustomAttribute` row" below). Verified directly: binding
  `@GeneratedRegex("^[a-z]+$", RegexOptions.ExplicitCapture,
  matchTimeoutMilliseconds: 1000, cultureName: "")` produces a
  `BoundAttribute` with 2 positional and 2 named arguments and no
  extra diagnostics, exactly mirroring how `@DllImport`'s `EntryPoint:` /
  `CharSet:` already bind.
- **A bare NAME reference to a sibling `const` field is *not* accepted as
  an attribute argument today** — verified with a probe: `const PatternText
  string = "..."` followed by `@GeneratedRegex(PatternText)` reports
  GS0125 ("Variable 'PatternText' doesn't exist") from *inside* the
  attribute-argument binding context, independent of constant-folding.
  This is a pre-existing gap in the general attribute-argument binder, not
  something this ADR's binder work can fix locally. It matters because the
  reference `TryTranslateGeneratedRegex` fixture
  (`Cs2Gs.Tests/Fixtures/Issue3086GeneratedRegex/Program.cs`) has exactly
  this shape (`GitHubUrl.Pattern()` references a sibling `private const
  string PatternText`) — cs2gs's rewrite must inline the constant's
  *resolved value*, not print an identifier reference to the const field.
  See Decision §5.
- **`Regex.InfiniteMatchTimeout` need not be referenced symbolically.** It
  is defined as `TimeSpan.FromMilliseconds(-1)` (`-10000` ticks); calling
  `TimeSpan.FromMilliseconds(-1.0)` for the `matchTimeoutMilliseconds: -1`
  case produces a value-equal `TimeSpan` (compared by value everywhere it
  is observed — a `TimeSpan` is a value type, and the fixture's own
  `HasDefaultRegexSemantics`/`HasExpectedRegexSemantics` checks compare
  `MatchTimeout` by value, never by reference). This avoids needing a new
  "read an arbitrary imported static field with no user syntax" bound-node
  shape that does not otherwise exist in the compiler.

## Decision

### 1. Syntax — `@GeneratedRegex` as a third bodyless-`func` discriminator

`@GeneratedRegex(pattern[, options][, matchTimeoutMilliseconds: n |
cultureName: "..."])` is accepted by the same semicolon-bodied `func`
grammar ADR-0086 introduced and ADR-0092 reused — no new grammar, per the
verification above.

```gs
package P
import System.Text.RegularExpressions

class GitHubUrl {
    shared {
        @GeneratedRegex(
            "^https://(www\.)?github\.com/...",
            RegexOptions.ExplicitCapture,
            matchTimeoutMilliseconds: 1000)
        func Pattern() Regex;
    }
}

class InstanceRegexOwner {
    @GeneratedRegex("^[a-z]+$")
    public func LowercaseWords() Regex;
}
```

Unlike `@DllImport`/`@LibraryImport` — which are only accepted on a
top-level `func` or a `shared`-block static method, and explicitly reject
instance methods (ADR-0086 §1, GS0326) — `@GeneratedRegex` **is** accepted
on an ordinary instance method, because real `[GeneratedRegex]` partial
methods commonly are instance methods (`InstanceRegexOwner.LowercaseWords`
above). The discriminator dispatch therefore has two call sites in the
binder (mirroring where P/Invoke's own dispatch lives): the `shared`-block
static-method path (`DeclarationBinder.Structs.cs`, alongside
`PInvokeBinder.TryAttachPInvokeMetadata`), and — newly, for this ADR — the
ordinary instance-method path, which previously treated *every*
semicolon-bodied instance method unconditionally as an abstract open-class
member (issue #987). Attribute binding is hoisted a few lines earlier in
that instance-method path so `@GeneratedRegex` is visible on
`methodSymbol.Attributes` before the abstract-method check runs; this is a
narrow, verified-safe reordering (regression-tested: an ordinary bodyless
instance method with no recognized attribute still reports GS0388 exactly
as before).

### 2. Semantic contract — mirrors `TryTranslateGeneratedRegex` exactly

The authoritative reference for every rule below is cs2gs's own
`TryTranslateGeneratedRegex`, which is not directly reusable (it extracts
from Roslyn `AttributeData`; gsc extracts from its own bound
`BoundAttribute` arguments) but is semantically definitive:

- `pattern`: required positional string constant. Missing, empty, or
  non-constant → **GS0593**.
- `options`: optional positional `RegexOptions`; defaults to `0` (`None`)
  when omitted. Extracted as the underlying `int32` bit value — gsc's
  attribute binder folds an enum-typed constant to its underlying integer
  (verified by probe), so no symbolic `RegexOptions` type resolution is
  needed at all.
- `matchTimeoutMilliseconds`: optional (named, or third positional when the
  boxed value is an `int`); `-1` denotes infinite. **Absent** means the
  two-argument `Regex(string, RegexOptions)` constructor is used, so the
  process-wide default match timeout (`AppContext` switch
  `REGEX_DEFAULT_MATCH_TIMEOUT`) applies — exactly like real
  `[GeneratedRegex]`-generated code, and exercised end-to-end by a
  compile-and-run test that sets the switch before first use.
- `cultureName`: optional (named, or third positional when the boxed value
  is a `string`); only affects the *validation* gate below — it never
  participates in the constructed `Regex(...)` call, matching
  `TryTranslateGeneratedRegex`'s own `constructionArguments` (which never
  threads `cultureName` through either).
- **Culture-sensitive `IgnoreCase` restriction (GS0595).** A pattern that
  uses `IgnoreCase` (explicitly, or via an inline `(?i)`/`(?im)` option
  group — the inline-scanning logic is ported verbatim from
  `PatternEnablesInlineIgnoreCase`/`InlineOptionsEnableIgnoreCase`) without
  `RegexOptions.CultureInvariant`, or with an explicit non-empty
  `cultureName`, cannot be lowered to a cached `Regex` without changing
  matching semantics (a cached instance has no per-call culture to vary).
  Reported as a real gsc diagnostic — the fixture's own `ReportUnsupported`
  translation-time marker becomes a proper compile error here.
- **Compile-time construction probe (GS0596).** Beyond the two checks
  above, the binder eagerly constructs `Regex(pattern, options[,
  matchTimeout])` — literally, at gsc's own compile time — inside a
  `try`/`catch (ArgumentException)`. This catches BOTH a malformed pattern
  (regex syntax errors) and an unsupported `RegexOptions` bit combination
  (e.g. `ECMAScript | Singleline`, which `Regex`'s own `ValidateOptions`
  rejects) with one mechanism, using the *runtime's own* validation instead
  of reimplementing it — and reports the failure as a diagnostic instead of
  letting a malformed declaration throw a `TypeInitializationException` out
  of the emitted type's `.cctor` at first use. This is the "unsupported
  combination of options" diagnostic the design asked for; a bespoke
  options-compatibility table was not written because the CLR already has
  one and gsc's compile-time host can just ask it.
- **A bodyless method with no recognized discriminator attribute** still
  reports GS0325 (`SemicolonBodyRequiresDllImport`) on the top-level/
  `shared`-block paths, or GS0388 (`AbstractMethodRequiresOpenClass`) on
  the instance-method path — both pre-existing checks, now also
  suppressed by a recognized `@GeneratedRegex`. GS0325's message text is
  deliberately left unchanged (it already understated its own scope before
  this ADR — `@LibraryImport` also satisfies it — and this ADR does not
  expand that pre-existing inaccuracy's blast radius).

### 3. Emission — ADR-0051's backing-field shape, not ADR-0092's two-method shape

`@LibraryImport` synthesizes a second, *stateless* hidden method (an inner
blittable P/Invoke) because its job is marshalling, not caching.
`@GeneratedRegex` needs the opposite: one piece of **cached state**,
computed once, returned unchanged on every call — precisely the shape
ADR-0051 already solved for a bodyless `prop Name Type` auto-property
(a private, `CompilerGenerated`-equivalent backing field, never printed in
G# source). This ADR reuses that shape instead of inventing a third one:

- **Backing field.** `FunctionSymbol.GeneratedRegexBackingField` — a
  `FieldSymbol` named `<Name>k__BackingField` (ADR-0051's own naming
  convention; there is no realistic collision risk since a same-name
  `@GeneratedRegex` method is already rejected as a duplicate overload
  before this fires), typed as the function's own return type (`Regex`),
  `Accessibility.Private`, and — critically — **always `static`, even when
  the annotated function is an ordinary instance method.** Real
  `[GeneratedRegex]` semantics are that the compiled pattern carries no
  per-instance state, so the cache is a static-lifetime value behind an
  instance method exactly as much as behind a static one. This is the one
  fact every test in this ADR's suite that touches an instance-method
  declaration is built to prove: two different receiver instances of the
  same class must return the *same* `Regex` object reference from an
  instance-method `@GeneratedRegex` call.
- **Field emission.** `TypeDefEmitter.EmitStructGeneratedRegexBackingFields`
  walks `structSym.Methods.Concat(structSym.StaticMethods)` and emits a
  `Static | Private` `FieldDef` for each `IsGeneratedRegex` function,
  mirroring `EmitStructStaticPropertyBackingFields` immediately above it.
  The corresponding row MUST also be counted in
  `ReflectionMetadataEmitter.PlanFieldRows`'s per-type running total (the
  same running total that already counts auto-property/event/static-field/
  const-field backing rows) — omitting this, exactly like the pre-existing
  comment about omitting const fields warns, under-reserves the `FieldDef`
  range and silently reattributes the row to the *next* `TypeDef`, which
  `ilverify` reports as `[FieldAccess]: Field is not visible` rather than
  as a planning-time error. (This was caught empirically during
  implementation — see the emit-test discussion below — not derived from
  reading the planner alone.)
- **Field initialization — eager, in the `.cctor`, not lazy.** The backing
  field's `new Regex(pattern, options[, TimeSpan.FromMilliseconds(n)])`
  value is built directly as bound-tree nodes with no synthesized syntax
  and no new `BoundNodeKind` (mirroring ADR-0092's own "no new
  `BoundNodeKind`" consequence): a `BoundClrConstructorCallExpression`
  against the real `System.Text.RegularExpressions.Regex` constructor
  (resolved via reflection through the existing `Emit.BclMember` helper,
  the same mechanism async-state-machine synthesis already uses for
  "compiler needs to call a BCL member with no user source"), with a
  `BoundClrStaticCallExpression` against `TimeSpan.FromMilliseconds` for
  the optional timeout argument. This expression is merged into
  `StructSymbol.StaticFieldInitializers` — the *same* dictionary an
  ordinary `shared { let x = ... }` field's initializer lives in — so it
  runs as part of the *one* `.cctor` a type gets, in the same declared
  order as everything else, through the existing bound-tree
  `MethodBodyEmitter` pipeline with zero new IL-emission code. Two
  deliberate rejections here, expanded in Alternatives:
  - **Not lazy** (no `if (field == null) field = new Regex(...)`): a
    null-check-and-assign is racy under concurrent first calls and can
    return two different `Regex` instances to two threads racing the first
    call — violating the "same instance on every call" contract this
    ADR's own emit tests assert. Eager `.cctor` initialization has no such
    race (the CLR serializes type initialization), and it is what cs2gs's
    own `TryTranslateGeneratedRegex` *already ships* today (a `let` field
    with an initializer expression) — this ADR's native path matches
    behavior the corpus already depends on, rather than introducing a new
    one.
  - **Not a second, independent `.cctor`-assembly mechanism.** A type has
    exactly one `.cctor`; `ConstructorBodyEmitter.EmitStaticConstructorBodyBytes`
    already owns building its one `BoundBlockStatement` body from
    `StaticFieldInitializers` plus `ConstFields` plus any `shared { init {
    ...} }` block. Emitting the `Regex` construction as raw IL in a
    *separate* pass would need its own merge/ordering logic against
    whichever of those the type also happens to have — genuinely new
    complexity for no benefit over reusing the dictionary that already
    exists for exactly this purpose. (This required one additional fix
    beyond populating the dictionary: `EmitStaticConstructorBodyBytes`'s
    own loop walked only `typeSym.StaticFields`, so it never *found* a
    generated-regex backing field's dictionary entry even after the
    dictionary held it correctly — fixed by adding a second loop over
    `IsGeneratedRegex` functions, alongside the existing `StaticFields`
    loop, in the same method.)
- **Method body.** The annotated function's body is synthesized as a
  single `return <backing field>` (`BoundFieldAccessExpression` with a
  `null` receiver — the same shape an ordinary static field read binds to)
  — registered directly into the `functionBodies` map at the point the
  binder would otherwise either treat a bodyless method as abstract
  (instance-method path) or register an empty P/Invoke-style block
  (`shared`-block path), so no source body is ever required or expected.
- **Not a `CustomAttribute` row.** Like `@DllImport`/`@LibraryImport`/
  `@MarshalAs`/`@MethodImpl` before it, `@GeneratedRegex` is added to
  `KnownAttributes.IsPseudoCustomAttribute` — it is fully consumed by the
  binder and emitter, so writing it out as a `CustomAttribute` on the
  emitted method would be a duplicate, misleading reflection view (exactly
  the ADR-0086 §6 / ADR-0092 §6 rationale, extended here).

### 4. Diagnostics (new)

Following the GS0360 (`@MarshalAs`) / GS9306 (`@ExtensionOwner`) "one
attribute, many shape rejections" convention this repo already uses,
rather than growing a wide numbered block the way ADR-0086/ADR-0092 did
(their v1 surface had many more independently-nameable knobs than
`@GeneratedRegex` does):

| ID | Severity | Message | Anchor |
|---|---|---|---|
| GS0593 | Error | `@GeneratedRegex` on '{0}' requires a non-empty constant string as its `pattern` argument. | The `@GeneratedRegex(...)` annotation. |
| GS0594 | Error | `@GeneratedRegex` is not valid on '{0}': {1}. | The function identifier (or body, for "must not have a body"). |
| GS0595 | Error | `@GeneratedRegex` on '{0}' combines `IgnoreCase` with culture-sensitive matching; cannot be lowered to a cached `Regex`. | The `@GeneratedRegex(...)` annotation. |
| GS0596 | Error | `@GeneratedRegex` on '{0}' is not valid: {1} (the runtime `Regex` construction probe's own message). | The `@GeneratedRegex(...)` annotation. |

GS0594 is the free-text "many shape rejections" diagnostic: a real body, a
parameter list, a generic function, an async function, an extension
function, a `ref`-returning function, or a return type other than
`System.Text.RegularExpressions.Regex` all route through it with a
different `reason` string, mirroring `DllImportInvalidFunctionShape`
(GS0326)'s own shape.

### 5. cs2gs consumer

`TryTranslateGeneratedRegex` is rewritten to emit the native form directly:

```gs
@GeneratedRegex(pattern, options, matchTimeoutMilliseconds: n)
private func Name() Regex;
```

instead of synthesizing `__generatedRegex_{name}` (a manual cache field) +
a forwarding method. The `pattern` argument is always the **resolved
constant string value**, never an identifier reference to a sibling
`const` field — required by the verified gap above (a bare const-field
name is not accepted as an attribute argument today), and no loss of
fidelity versus the pre-existing translation, which already fully resolved
`pattern` to its constant value on the C# side before ever reaching G#
codegen (`attribute.ConstructorArguments[i].Value`, a Roslyn compile-time
constant) — cs2gs was never printing the identifier `PatternText` into G#
source either; it only used the *name* to synthesize a readable G# cache
field name, which no longer exists to name. The `options`/
`matchTimeoutMilliseconds`/`cultureName` extraction logic
(`PatternEnablesInlineIgnoreCase` and friends) is unaffected — it still
runs on the C# side to decide whether the culture-sensitive-`IgnoreCase`
case should be reported (now via `context.ReportUnsupported`, since the
underlying construct is native and the migration itself is still
unsupported when the culture restriction applies — gsc's own GS0595 would
also catch a mistranslation, but rejecting at cs2gs time gives a clearer
migration-tool diagnostic).

## Known limitations

This ADR replicates real `[GeneratedRegex]`'s **observable behavior and
caching contract** — `Match`/`IsMatch`/`Options`/`MatchTimeout`/reference
identity across calls all behave correctly, verified end-to-end by this
ADR's own emit tests — but it does **not** replicate the deeper feature
the real C# source generator exists to provide: **compile-time-specialized
matching**.

Verified directly against the real generator's actual output (`dotnet new
console`, a `[GeneratedRegex]` partial method, `<EmitCompilerGeneratedFiles>
true</EmitCompilerGeneratedFiles>`, then reading the `.g.cs` file under
`generated/System.Text.RegularExpressions.Generator/`): for a pattern like
`[GeneratedRegex(@"^[^@\s]+@[^@\s]+\.[^@\s]+$", RegexOptions.IgnoreCase)]`,
Roslyn's generator does not emit anything resembling `new Regex(pattern,
options)`. It emits a `Regex`-derived subclass —
`EmailRegex_0 : Regex`, one per attributed method — whose constructor
still sets `pattern`/`roptions`/`internalMatchTimeout` for introspection
(`.ToString()`, `.Options`, `.MatchTimeout` all still work, which is why
this ADR's plain-`Regex` approach is contract-compatible), but whose
*matching* is driven by a hand-specialized `RegexRunnerFactory` /
`RegexRunner` pair implementing that ONE pattern's algorithm as ordinary,
straight-line C#: a generated `TryMatchAtCurrentPosition` method with
character-class bitmask lookups, `while` loops walking the input span, and
`goto`-based backtracking bookkeeping — no interpreted opcode loop, no
runtime `Regex` engine invoked at all. Schematically:

```csharp
file sealed class EmailRegex_0 : Regex
{
    // ...ctor sets pattern/options/timeout for introspection...

    private sealed class RunnerFactory : RegexRunnerFactory
    {
        protected override RegexRunner CreateInstance() => new Runner();

        private sealed class Runner : RegexRunner
        {
            protected override void Scan(ReadOnlySpan<char> text) { /* ... */ }

            private bool TryMatchAtCurrentPosition(ReadOnlySpan<char> inputSpan)
            {
                // Specialized to THIS pattern: character-class bitmask
                // tests, `while` scanning loops, `goto`-based backtrack
                // bookkeeping — the same kind of specialization
                // RegexOptions.Compiled performs via runtime
                // Reflection.Emit, but generated ahead of time as
                // ordinary C# source instead.
                ...
            }
        }
    }
}
```

This is functionally the same class of optimization `RegexOptions.Compiled`
already does at runtime (via `Reflection.Emit`), except shifted to
*compile time* as ordinary generated source — which is precisely what
makes it AOT-friendly (no runtime codegen needed) and is the real
generator's primary motivation, not an incidental detail. G#'s emitted
`Regex(pattern, options[, timeout])` still runs through the BCL's ordinary
*interpreted* matching engine every time — no per-pattern specialization,
no AOT benefit beyond "no attribute-driven code generation happens at
gsc's own compile time" (which was never the bottleneck; regex matching
performance was).

Building real compile-time regex-to-specialized-matcher generation would
mean reimplementing a substantial slice of `System.Text.RegularExpressions`'s
own regex-compiler internals inside gsc — disproportionate to pursue now,
by the same reasoning this ADR's own Alternatives section already applies
elsewhere (see "Full partial-method / partial-property language support"
and "A general source-generator pipeline" below). It does not block this
ADR's actual goal: retiring `__generatedRegex_` (issue #3501's
zero-synthetic-identifiers goal) does not require matching-engine parity,
only observable-behavior parity, which is what shipped. A future ADR could
revisit this if G# ever needs AOT-published regex-heavy workloads to match
real `[GeneratedRegex]`'s throughput — no such need is known today.

## Alternatives considered

### 1. Full partial-method / partial-property language support — rejected

C#'s `[GeneratedRegex]` rides on the general `partial` keyword and method
declaration shape. G# has no `partial` keyword at all; building general
partial-method (or partial-property) support just to host this one
attribute would be enormously disproportionate — the ENTIRE value this
ADR needs from "partial" is "a declaration with no body, discriminated by
an attribute," which ADR-0086's `;`-body grammar already provides for two
other attributes. Rejected for the same proportionality reason ADR-0092 §4
gave for not building a general source-generator pipeline: no second
consumer would exist for general partial-method support today, and the
narrow `;`-body mechanism already does everything actually needed.

### 2. A general source-generator pipeline — rejected, citing ADR-0092 §4

ADR-0092 §4 explicitly named the trigger for revisiting "no general
source-generator infrastructure": *at least one additional consumer
identified, and the wrapper logic complex enough that bound-tree rewriting
becomes the simpler implementation.* The first half of that trigger just
fired (`@GeneratedRegex` is the additional consumer) — but the second half
did not: this ADR's entire emission delta is one new binder helper
(`GeneratedRegexBinder`, ~500 lines, structurally parallel to
`PInvokeBinder`), one new emit method
(`EmitStructGeneratedRegexBackingFields`, ~25 lines, structurally parallel
to `EmitStructStaticPropertyBackingFields`), a ~15-line addition to field-
row planning, and a ~15-line addition to `.cctor` body assembly. None of
that required syntax-tree rewriting, a new `BoundNodeKind`, or a
"generator-introduced symbols" surface visible to the rest of the binder
(the concern ADR-0092 §4 raised about decoupling a wrapper into a separate
pass). The dispatch is a direct attribute-type check plus emit-time
dispatch, exactly like `@DllImport`/`@LibraryImport` already are. Building
generator infrastructure now would be paying a large one-time cost this
ADR's actual implementation never needed — reevaluate again only if a
*third* consumer (JSON, COM) turns out to need genuine bound-tree rewriting
that this narrow-attribute-dispatch pattern cannot express.

### 3. Lazy backing-field initialization (`field ??= new Regex(...)`) — rejected

Considered because it is what some hand-decompiled real `[GeneratedRegex]`
output superficially resembles, and it defers the `Regex` construction
cost until first use rather than at type-load. Rejected because a bare
null-check-and-assign has no synchronization: two threads racing the first
call to the same `@GeneratedRegex` method could each observe `field ==
null`, each construct their own `Regex`, and return two *different*
object references — silently violating the cross-instance/cross-call
reference-identity contract this ADR's own tests assert (and that real
`[GeneratedRegex]`'s actual generated code — which uses a
`LazyInitializer`-style helper, not a bare null-check — is careful to
preserve). Eager `.cctor` initialization has no such race window (CLR type
initialization is serialized per-type), and matches what cs2gs's existing,
shipped-and-tested translation already does (a `let` field with an
initializer expression) — this ADR's native path does not change any
already-depended-upon behavior.

### 4. Raw-IL `.cctor` injection at emit time, bypassing the bound tree — rejected

Explored as the "more P/Invoke-like" option, since P/Invoke's own
`ImplMap`/two-method emission is itself raw-IL-adjacent (no new
`BoundNodeKind`, direct `System.Reflection.Metadata` calls). Rejected once
it became clear a CLR type has exactly **one** `.cctor`, and
`ConstructorBodyEmitter` already owns assembling that one `.cctor`'s
*entire* content (static field initializers, runtime-initialized consts,
and any `shared { init { ... } } ` block) from a single
`BoundBlockStatement`. A raw-IL injection path would need its own logic to
interleave with whichever of those a `@GeneratedRegex`-bearing type also
happens to have — solving, from scratch, exactly the ordering/merging
problem `StaticFieldInitializers` already solves. Feeding the same
dictionary that already exists for this purpose is strictly simpler, and
it is what shipped: `BoundClrConstructorCallExpression`/
`BoundClrStaticCallExpression` nodes merged into
`StructSymbol.StaticFieldInitializers`, consumed by the existing
`MethodBodyEmitter` pipeline with no new IL-emission code at all.

## Tests

- **Parser**: a regression test confirming
  `@GeneratedRegex(...) private func Name() Regex;` parses with no
  diagnostics and no grammar change (the parser is attribute-agnostic —
  see Context).
- **Binder** (`Issue4301GeneratedRegexBinderTests`, 15 cases): the static
  and instance well-formed shapes; GS0593 (missing pattern, non-constant
  pattern); GS0594 (parameters, wrong return type); GS0595 (explicit
  `IgnoreCase` without `CultureInvariant`, inline `(?i)` without
  `CultureInvariant`, and the negative control — `IgnoreCase |
  CultureInvariant` binds clean); GS0596 (an invalid `RegexOptions`
  combination, and a non-`-1` negative timeout); `-1` timeout binds
  clean; named-argument `matchTimeoutMilliseconds:` binding; and two
  regressions pinning that the pre-existing GS0325/GS0388 fallbacks for an
  unrecognized bodyless declaration are unaffected by this ADR's changes
  to their call sites.
- **Emit** (`Issue4301GeneratedRegexEmitTests`, 6 cases, real
  compile-and-run programs verified under `ilverify`): a static
  `@GeneratedRegex` method returns the same cached `Regex` instance on
  every call; an **instance**-method `@GeneratedRegex` returns the same
  cached instance across two different receiver instances (the
  cross-instance identity contract this whole ADR exists to preserve);
  explicit `RegexOptions`/`matchTimeoutMilliseconds` round-trip onto the
  constructed `Regex`'s own `Options`/`MatchTimeout` properties; `-1`
  produces a `MatchTimeout` value-equal to `Regex.InfiniteMatchTimeout`;
  omitting the timeout argument picks up the process-wide
  `AppContext`-switch default; and the emitted backing `FieldDef` is
  `private static`.
