# ADR-0184: Definition-side `@UnscopedRef` — ref-safe-context of `this` in struct members

- **Status**: Proposed (flips to Accepted on merge; the decisions below were
  approved through the design-and-decision process that produced this ADR)
- **Date**: 2026-09-17
- **Amends**: [ADR-0058](0058-ref-safe-to-escape.md) §4 — corrects its
  "Follow-ups (completed): ✅ Full RSTE for `ref` returns and `[UnscopedRef]`
  enforcement" claim. Only a narrow `IsScoped`-clearing sliver had actually
  shipped; the ref-return half of the feature was never wired up. Also corrects
  ADR-0058's "Breaking changes" claim that `return this;` by value from a
  `ref struct` member matches C#'s default behaviour — it does not.
- **Related**: [ADR-0039](0039-byref-pointers-and-clr-interop.md) (by-ref
  pointers), [ADR-0056](0056-span-consumption-v1.md) (Span consumption),
  [ADR-0060](0060-ref-out-in-parameters.md) (`ref`/`out`/`in` parameters),
  [ADR-0181](0181-readonly-managed-reference-contracts.md) (readonly managed
  reference contracts), [ADR-0047](0047-attribute-syntax-and-declaration.md)
  (annotation syntax and attribute declaration),
  [ADR-0084](0084-gsharp-extensions-optional-sequences.md) §L5 (the
  type-identity-over-string-matching rule `KnownAttributes` cites for every
  recogniser in it; issue #835),
  [ADR-0182](0182-receiver-clause-is-always-extension.md) (every receiver clause
  is an extension); issues/PRs #376, #4265, #4288

## Context

G# has advertised `@UnscopedRef` as language surface since ADR-0058. It never
worked.

What ADR-0058 actually shipped was one line in `Binder.cs`: for a `ref struct`
instance method, set `ThisParameter.IsScoped = true` **unless** the declaration
carries an annotation whose text is `UnscopedRef`. That has three problems, each
independently fatal:

1. **It governs the wrong scope.** `IsScoped` restricts a value's
   *safe-to-escape* (the by-value GS0219 check). The thing `@UnscopedRef` exists
   to relax is the *ref-safe-context* of `this` — whether `return ref this.Total`
   is allowed. That check, `HasFunctionLocalRefScope`, read
   `p.IsScoped || p.RefKind == RefKind.None`, and a receiver's `RefKind` is
   always `None`, so the second disjunct was unconditionally `true`. Setting or
   clearing `IsScoped` changed nothing for a ref return. `@UnscopedRef` was inert
   for its entire stated purpose.

2. **Recognition was by spelling, not by type identity.** `HasUnscopedRefAnnotation`
   string-matched over the raw annotation syntax, which ADR-0084 §L5 exists to
   forbid: a user type named `UnscopedRef` would have been honoured, an alias
   would not, and — the observable symptom — the relaxation fired without
   `import System.Diagnostics.CodeAnalysis`, so the binder believed the member was
   annotated while the emitter wrote no `CustomAttribute` row at all. The
   existing test `RefSafeEscapeTests.RefStructMethod_WithUnscopedRef_ReturnsThis_IsLegal`
   was written that way and had been quietly producing GS0198 (`AttributeTypeNotFound`)
   for its entire life; its single `DoesNotContain(GS0219)` assertion could not
   see it.

3. **It was structurally unreachable for accessors.** Property and indexer
   accessors are constructed with `declaration: null` and never receive an
   attribute list of their own — only the `PropertySymbol` does — so a syntactic
   check over `function.Declaration.Annotations` returned `false` for every
   accessor that has ever existed. There was no property/indexer spelling.

Meanwhile the *consumer* side was already precise: issue #4265 added
`RefCapabilities.IsUnscopedRefIndexerGetter`, which reads
`System.Diagnostics.CodeAnalysis.UnscopedRefAttribute` off imported CLR metadata
(on the property row or the getter — C# emits it in either place) and correctly
refuses to forward such a member through a by-value receiver, matching C#'s
CS8166. Its own source comment names the gap: it exists to mirror "the same
intent `@UnscopedRef` signals for a native G# member" — a member gsc could not
actually express.

The gap surfaced concretely during self-migration. PR #4288 hit
`test/Core.Tests/Fixtures/UnscopedRefIndexerFixture.cs`, a C# `ref struct` whose
indexer getter returns `ref` into its own field. cs2gs translated it faithfully
and gsc rejected the result with GS0253, so `test/Core.Tests` went red on the
migration gate. With no way to close the language gap at the time, that PR
deleted the fixture file and re-created its source as a raw-string constant
compiled through Roslyn at test time. That kept the gate green, but it removed a
real `.cs` file from the migrated corpus to avoid a compiler limitation —
exactly the shape of workaround the self-migration policy tells contributors not
to reach for.

Two further findings from building this, which the pre-implementation design did
not anticipate:

- **The accessor-attribute drop was not the only cause.** cs2gs does silently
  drop C# accessor-level attributes (`PropertyAccessor` has no attribute slot at
  all), which is why the getter-level fixture lost its `[UnscopedRef]`. But the
  sibling fixture with `[UnscopedRef]` on the *property* translated the
  attribute correctly and gsc still rejected it — because of problem (1) above.
  Fixing cs2gs alone would not have restored the fixture.

- **The reported diagnostic was GS0253, not GS0254.** `this` is a
  `ParameterSymbol` whose `IsReadOnly` is derived from its `RefKind`, and a
  receiver's `RefKind` is `None`, so `RefCapabilities.IsReadOnlyStorage`
  classified every `this` as read-only storage. `return ref this.Total` therefore
  failed the *lvalue/readonly* gate and never reached the escape-scope check at
  all — the user got "the operand of 'return ref' must be an lvalue", which is
  both wrong (the CLR passes a struct's `this` as `ref S`; it is the most
  writable storage a member has) and unactionable.

## Decision

Implement definition-side `@UnscopedRef` properly, in nine parts, plus one
conformance fix.

### 1. Type-identity recognition, and the `import` that comes with it

`KnownAttributes` gains `IsUnscopedRef(Type?)`, `IsUnscopedRef(BoundAttribute?)`
and `HasUnscopedRef(ImmutableArray<BoundAttribute>)`, all comparing against
`typeof(System.Diagnostics.CodeAnalysis.UnscopedRefAttribute)` through
`ClrTypeUtilities.IsSameAs` like every other recogniser in that file.
`DeclarationBinder.HasUnscopedRefAnnotation` is deleted.

`@UnscopedRef` is now a real, type-resolved CLR attribute — not a
compiler-intrinsic name-only marker like `@SuppressDiagnostic` — so it requires
`import System.Diagnostics.CodeAnalysis` (or the fully-qualified spelling).
Without it the binder reports GS0198 and the member is not un-scoped. This is
the cost of the change and it is deliberate: it is also what makes the attribute
reach metadata.

### 2. `FunctionSymbol.HasUnscopedRef`

A computed property over the symbol's bound attribute list, not a stored flag.
The binder's ordering is `bind attributes → construct symbol → mutate flags →
SetAttributes`, and one call site only calls `SetAttributes` when the list is
non-empty, so anything eager is fragile. Computing also means the flag survives
every symbol-cloning site that copies `Attributes` (nullable-sequence iterator
specializations, lambda adapters, generic substitution) with no per-site change.

### 3. Implicit `scoped this`, widened to all structs

`Binder.cs` sets the receiver's implicit scoping for **every** struct receiver,
not only byref-like ones — matching C#, where every struct instance member's
`this` is `scoped ref S`. Two distinct facts are carried on two distinct flags:

- `ParameterSymbol.IsScoped` — the receiver's VALUE scope. Set when the member
  is not annotated, exactly as before.
- `ParameterSymbol.IsUnscopedRefReceiver` — the receiver's REF scope. Set when it
  is annotated, and read by `HasFunctionLocalRefScope`, whose parameter case
  becomes `p.IsScoped || (p.RefKind == RefKind.None && !p.IsUnscopedRefReceiver)`.

A dedicated flag rather than promoting the receiver's `RefKind` to `Ref`: the
latter would make every lambda inside a struct member trip GS9010 ("a `ref`
parameter cannot be captured by a closure"), which has nothing to do with this
feature.

The widening is a semantic no-op under this mechanism, and that is checked
rather than assumed: `IsScoped` on a receiver is read in exactly two places
(`HasFunctionLocalReferentScope` and `RefCapabilities.SelectEscapeArguments`),
both of which only ever look at byref-like values, and the third reader
(`HasFunctionLocalEscapeScope`) excludes the receiver outright under D1 below.

### 4. `this` is writable storage in every struct instance member (D2)

`RefCapabilities.IsReadOnlyStorage` exempts a value-type receiver parameter from
the read-only classification. This is not conditional on `@UnscopedRef` — the
CLR passes a struct's `this` as `ref S` in every instance member, annotated or
not. The assignment binder already carried this exemption for member writes
(`ExpressionBinder.ReceiverVariableIsThis`, issue #947); this makes the same fact
available to the static ref-capability classifiers, which have no
enclosing-function context and so need it on the symbol. A reference-type
receiver is deliberately not exempted: `IsReadOnlyValueReceiver` already
short-circuits on it, and exempting it would only widen `&receiver` on the
parameter slot for no reason.

After this, `@UnscopedRef` controls the escape-scope question and nothing else —
exactly C#'s split between "is this an lvalue at all" and "does the reference
escape too far". A genuinely read-only field (`let`) still fails the lvalue gate
with GS0253 whether the member is annotated or not.

### 5. GS0589, the CS8170 analogue

`return ref <expr>` whose reference is rooted at the enclosing member's own
receiver, from a member that is not annotated, reports a dedicated diagnostic
naming the remedy, rather than GS0254's "function-local storage" — which is
actively misleading here, since the storage in question belongs to the *caller*.
A reference rooted at a local still gets GS0254.

The design brief specified ordering this *before* the lvalue/readonly check so
the generic GS0253 could not mask it. That ordering is unnecessary once decision
4 lands: `this.<field>` then passes the readonly gate on its own and falls
through to the escape check naturally. GS0589 is therefore reported from inside
the escape-scope branch, and GS0253 is left alone so `return ref this.<letField>`
still reports the accurate readonly error.

### 6. GS0590, placement validation (D4)

`@UnscopedRef` is rejected, with a specific reason, on: a class member; a
`shared` (static) member or property; a receiver-clause function (ADR-0182 makes
every receiver clause an extension, whose receiver is an ordinary by-value
parameter — un-scoping it would hand out a reference into the extension's own
stack copy); a free function; an `init` accessor; and — per D4 — an `override`,
an explicit interface implementation, or an interface member. One descriptor
with a free-text reason, following the GS0360 (`@MarshalAs`) / GS9306
(`@ExtensionOwner`) convention.

The `override`/interface rejection is the C# CS9102 case and is explicitly
**deferred work, not a permanent rule**: honouring it would require matching the
ref-safe-context contract across a whole override chain, which this release does
not attempt. Note the check catches an *explicit* interface implementation; an
implicit one is not detected at declaration-binding time, and is left as a known
hole in the deferral rather than a claimed guarantee.

`@UnscopedRef` also requires no `unsafe` context (D3). It expresses a lifetime
contract the compiler then enforces; it does not weaken any check.

### 7. Real CLR attribute emission, both spellings

No emitter change is needed, and none was made. `EmitUserAttributes` writes
every bound attribute whose target matches to a `CustomAttribute` row, with no
allow-list and only six pseudo-custom attributes filtered — `UnscopedRefAttribute`
is not among them. The `func` spelling lands on the MethodDef, the `prop`/indexer
spelling on the PropertyDef. The IL is likewise already correct:
`TryLoadVariableAddress`'s `structThisParameter` case emits `ldarg.0` (not
`ldarga.0`) for a struct receiver, so `return ref this.Total` compiles to the
same `ldarg.0; ldflda; ret` sequence csc produces for
`[UnscopedRef] public ref int Slot() => ref this.total;`. Both facts are pinned
by a new emit test that reads the compiled assembly's metadata and IL back,
rather than trusting that the binder accepted the source. (`ldarga.0` here would
yield a pointer to the receiver's pointer slot — it would still compile and
still verify, and the returned reference would be garbage; that is why the test
asserts opcodes rather than "it compiled".)

### 8. Property and indexer spelling

G# spells the annotation once, on the property or indexer. The binder pushes it
down onto `GetterSymbol`/`SetterSymbol` after the property's attributes are
bound (which runs after the accessors are constructed), because accessors have
no attribute list of their own. This matches C#, which accepts `[UnscopedRef]`
on either the property or its `get` accessor and treats them equivalently — the
same two placements `RefCapabilities.IsUnscopedRefIndexerGetter` already reads
back out of imported metadata.

### 9. cs2gs accessor-attribute hoist

When translating a C# property or indexer whose accessor carries
`[UnscopedRef]`, and the member itself does not, cs2gs lifts it to the
member-level `@UnscopedRef`. Only `[UnscopedRef]` is hoisted — it is the one
attribute C# itself treats as equivalent in both placements. Any other
accessor-level attribute would mean something different on the property, so
those continue to be dropped.

A translation diagnostic for the general accessor-attribute drop was considered
and not added: `TranslationSeverity.Info` is consumed nowhere in the pipeline or
report, `Warning` is surfaced only for one hard-coded diagnostic id, and
`Unsupported` fails the gate. Reporting it usefully needs pipeline work that is
out of scope here; it is called out as a known silent drop instead.

### D1 (additional): GS0219 conformance fix

`return this;` **by value** from a `ref struct` instance method is legal, with or
without `@UnscopedRef`. ADR-0058 asserted the opposite and claimed it matched C#;
it does not. C# gives `this` a *ref*-safe-context that is function-local by
default and a *safe-to-escape* that is the caller's context — the value the
receiver holds was produced by, and outlives, the call. `HasFunctionLocalEscapeScope`
therefore excludes the receiver parameter from its `IsScoped` test.

This changes the expected outcome of two existing tests, and they are updated to
assert the correct rule rather than preserve the old one. A genuinely `scoped`
source is unaffected: returning a `scoped` parameter, or a local seeded from
one, is still GS0219, inside a struct member exactly as at top level.

### No caller-side changes

The caller-side treatment of an `[UnscopedRef]` member reached through a
by-value receiver (issue #4265's `IsUnscopedRefIndexerGetter` guard, CS8166's
analogue) is unchanged and still correct: it reads the attribute off metadata,
which native G# members now actually carry.

## Consequences

**What this unlocks**

- A G# struct or `ref struct` can expose a reference into its own instance
  state — `func`, `prop`, or indexer — which is the standard C# buffer/accessor
  idiom and was previously inexpressible.
- `test/Core.Tests/Fixtures/UnscopedRefIndexerFixture.cs` is restored as a real
  `.cs` file. It translates through cs2gs, the translated G# compiles, and the
  test project migrates — the workaround PR #4288 introduced is reverted, and
  the fixture goes back to being ordinary migrated corpus rather than a
  Roslyn-compiled string constant.
- Struct members that legitimately need a writable `this` no longer hit
  spurious read-only-storage rejections.
- The ADR-0084 §L5 violation is gone: recognition is by CLR type identity, and
  a migrated C# `[UnscopedRef]` round-trips through cs2gs, gsc and back out to
  metadata.

**What it costs**

- `@UnscopedRef` now requires `import System.Diagnostics.CodeAnalysis`. Source
  that relied on the bare spelling silently "working" gets GS0198 — which it was
  already getting; the difference is that the annotation no longer has any
  effect while unresolved, so the error now matters.
- Two existing tests change their expected outcome (the D1 conformance fix).
- `@UnscopedRef` on a shape where it means nothing is now an error (GS0590)
  rather than silently ignored.

**What it does NOT address**

- `override` and interface members (D4). Deferred, with an explicit diagnostic
  rather than silent acceptance. Implicit interface implementations are not
  detected.
- **`out` parameters and `ref`-to-`ref struct` parameters are not implicitly
  scoped.** C# scopes both by default; G# does not, which makes G# *less* safe
  than C# in that corner today. It is a separate, pre-existing gap with its own
  soundness argument to make and is deliberately untouched here — widening
  scoping rules and adding an escape hatch in the same change would make neither
  reviewable.
- No `unsafe` gate (D3), by decision, not by omission.

## Alternatives considered

**Keep PR #4288's `CSharpFixture` workaround.** Rejected. It keeps the gate
green by removing a real `.cs` file from the migrated corpus, which is the
"exclude the file to get green" move the self-migration policy explicitly calls
out as turning a visible failure into an invisible one. It also leaves the
language gap in place for every user, not just this fixture — and the gap is not
exotic: returning a reference into a struct's own storage is a routine C#
pattern with no G# equivalent.

**A new keyword instead of an attribute.** Rejected. The CLR contract *is*
`System.Diagnostics.CodeAnalysis.UnscopedRefAttribute` — it has to reach
metadata for a C# consumer (and for gsc's own `IsUnscopedRefIndexerGetter`) to
see it. A keyword would need lowering to that attribute anyway, would not
round-trip through cs2gs without a bespoke mapping, and would add surface for no
expressive gain. ADR-0047's model — a CLR-defined contract is spelled as an
annotation naming the real attribute type — already settles this.

**Give `ThisParameter` `RefKind.Ref` instead of a dedicated flag.** Rejected.
It is the more "honest" model of the CLR — a struct's `this` really is `ref S` —
but `RefKind.Ref` is load-bearing elsewhere: GS9010 rejects capturing a `ref`
parameter in a closure, so every lambda inside every struct instance method
would start failing. The dedicated `IsUnscopedRefReceiver` flag has zero blast
radius outside the one check that reads it.

**Gate `@UnscopedRef` behind `unsafe`.** Rejected (D3). It expresses a lifetime
contract the compiler then *enforces* — every use is still checked by the same
ref-safety analysis. C# requires no `unsafe` either. Requiring it would push
ordinary, safe accessor code into an unsafe context and devalue what `unsafe`
signals.

**New accessor-level annotation syntax (`get @UnscopedRef { ... }`).** Rejected.
It would mean new parser surface, a new slot on `PropertyAccessor` in both the
compiler and the cs2gs code model, and a new printer form — all to express
something C# already treats as equivalent to the member-level placement. The
member-level spelling plus a push-down to the accessors gets the same semantics
and the same metadata for none of that.

**Keep string-based recognition to avoid requiring the `import`.** Rejected.
It is precisely the ADR-0084 §L5 failure mode: a user type named `UnscopedRef`
would be honoured, an alias would not, and the binder and the emitter would
disagree about whether the member is annotated — the binder relaxing its checks
while no attribute reaches metadata, so a C# consumer of the assembly sees a
member with no contract at all. That divergence is worse than an `import` line.
