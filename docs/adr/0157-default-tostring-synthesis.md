# ADR-0157: Default pretty-printing for user types — display-side, not synthesized

- **Status**: Accepted — 2026-08-06
  ([#3208](https://github.com/DavidObando/gsharp/issues/3208); implemented in
  the same change — `src/Repl/Engine/ReplValueFormatter.cs`, wired at the
  three REPL echo sites and pinned by `Adr0157ReplValueFormatterTests`)
- **Date**: 2026-08-06
- **Phase**: Language surface / REPL ergonomics (ADR-0156 Phase 3
  semantic-alignment follow-up)
- **Related**: [#3208](https://github.com/DavidObando/gsharp/issues/3208)
  (this question), [#3204](https://github.com/DavidObando/gsharp/issues/3204)
  (decided: plain types keep CLR `ToString` semantics, no soft deprecation),
  [#3163](https://github.com/DavidObando/gsharp/issues/3163) /
  [#3176](https://github.com/DavidObando/gsharp/issues/3176) (campaign
  tracking), ADR-0029 (`data` struct synthesized members — the existing
  opt-in), ADR-0025 (`record` keyword alias), ADR-0032 (`data` ergonomics),
  ADR-0156 (one emitted semantics everywhere), ADR-0034 (imported CLR
  interop); precedent issues
  [#2896](https://github.com/DavidObando/gsharp/issues/2896) (user
  `override func ToString` on plain structs),
  [#2361](https://github.com/DavidObando/gsharp/issues/2361) (transparent
  user takeover of the synthesized data ToString),
  [#2338](https://github.com/DavidObando/gsharp/issues/2338) (data-class
  inheritance re-override), [#2363](https://github.com/DavidObando/gsharp/issues/2363)
  (zero-field data types)

## Context

Issue [#3204](https://github.com/DavidObando/gsharp/issues/3204) closed the
last rendering divergence of the evaluator era: the retired tree-walking
evaluator gave every plain struct a record-style `Name(Field=...)` rendering
that the emitted program never had. The owner's decision was to keep **CLR
semantics** — a plain struct or class without a `ToString` override prints its
CLR type name — with no soft deprecation. That decision stands; the follow-up
question filed as [#3208](https://github.com/DavidObando/gsharp/issues/3208)
is the general language question this ADR answers: should G# synthesize a
default pretty-printing `ToString()` for user structs and classes,
transparently overridable, the way C# records do?

Three facts about the current codebase frame the answer.

**1. The records-style opt-in already exists, completely.** ADR-0029's `data`
modifier (with the `record` alias, ADR-0025) synthesizes the full value-type
member set as *real emitted overrides* —
`Equals(object)`, `Equals(T)`, `GetHashCode`, `ToString`
(`Name(F1=v1, F2=v2)` via `Convert.ToString` invariant-culture),
`op_Equality`/`op_Inequality`, `Deconstruct` — in
`src/Core/CodeAnalysis/Emit/DataStructSynthesizer.cs`. The transparent-
override model #3208 names is already implemented there: a user-declared
`ToString` on a `data` type simply takes over the synthesized slot with
identical vtable attributes (#2361,
`DataStructSynthesizer.HasUserToStringOverride` +
`IsDataObjectOverrideFinal`), and data-class hierarchies re-override
correctly, non-final while open (#2338). Separately, any *plain* struct or
class may declare `override func ToString() string` and it dispatches
correctly everywhere, including BCL-initiated virtual calls (#2896, #3116).

**2. Emitted synthesis is row-planned, per-type, and paid forever.**
`ReflectionMetadataEmitter.PlanClassMethods`/`PlanStructMethods` reserve
MethodDef rows in fixed order that must agree 1:1 with what
`DataStructSynthesizer` later emits; the #2361 (user-ToString skip) and #2363
(zero-field / no-Deconstruct skip) special cases show what every conditional
synthesized member costs in planner/emitter agreement surface. The metadata
itself is not free either: the spike below measures **+1,024 bytes of PE**
for one two-field struct's data-member set (ToString is one of its seven
members) — paid by every compiled assembly, whether or not anything is ever
printed, and multiplied across every user type under an always-on rule.

**3. The actual pain is the REPL echo, and the echo is one line of code.**
Post-#3204, `Cell.Value` holds the live emitted value and the echo is
`cell.Value.ToString()` (`src/Repl/Screens/ReplScreen.cs:316`,
`src/Repl/Compat/GSharpRepl.cs:32`, and the sidebar's
`Truncate(value.ToString(), 20)` in
`src/Repl/Engine/EmittedSessionEngine.cs:134`). A user who types
`Point{X: 1, Y: 2}` into gsi sees `gsi1.Point` — correct CLR semantics,
useless feedback. This is precisely the problem Roslyn interactive solved
**display-side**: csi never touched C#'s `ToString` semantics; its
`ObjectFormatter` pretty-prints submission results structurally at echo time.

## Decision

**Do not synthesize a default `ToString` for plain structs and classes.
Emitted semantics stay CLR-aligned, exactly as #3204 decided; `data` (and
`override func ToString`) remain the two existing opt-ins for a real emitted
override. The REPL echo gap is closed display-side: a reflection-based value
formatter in the REPL (working name `ReplValueFormatter`,
`src/Repl/Engine`) renders a value structurally when — and only when — its
runtime type has no `ToString` override below `object`/`ValueType`, and
defers to the real override otherwise.** This is the "competing smaller
design" named in #3208, recommended here as the primary one.

The formatter replaces the raw `ToString()` call at the three echo sites
(`ReplScreen`, compat `GSharpRepl`, the `EmittedSessionEngine` sidebar
values). Nothing in `Core`, the emitter, the language spec, or any emitted
assembly changes; `gsc` output is byte-identical before and after.

### Rendering contract (tool-level, explicitly not a spec guarantee)

The format is **diagnostics-only**: it may change in any release, is never
part of the language specification, and programs must not parse it. This is
the key liberty the display-side placement buys — an emitted `ToString` would
freeze these answers into every compiled assembly forever. The contract the
spike validates:

- **Trigger**: the runtime type's resolved public parameterless `ToString`
  is declared by `object` or `System.ValueType` — i.e. nothing anywhere in
  the hierarchy overrides it. Synthesized `data` members, user
  `override func ToString`, primitives, enums, and imported CLR overrides
  all win transparently by construction (they *are* overrides), matching
  CLR virtual dispatch with no special-casing.
- **Shape**: G# composite-literal syntax, `Name{Member: value, ...}` — the
  echo of `Point{X: 1, Y: 2}` is `Point{X: 1, Y: 2}`, keeping the transcript
  close to round-trippable input (and distinct from the `data` family's
  emitted `Name(F=v)` shape, so the two sources of rendering are
  distinguishable at a glance).
- **Members**: public instance fields, then public readable non-indexer
  properties, in metadata order; a throwing property getter renders
  `<error>` rather than aborting the echo. Non-public state is never shown
  (accessibility answer: public-only).
- **Nesting/depth**: recursive, depth-capped (spike: 4), eliding deeper
  values as `...`.
- **Reference cycles**: reference values already on the current rendering
  path elide as `...` — handled with one identity set in the formatter,
  something an emitted per-type `ToString` cannot do without runtime
  cycle-tracking machinery in every type.
- **Collections**: values with no override that implement `IEnumerable`
  render element-wise, capped (spike: 8) with a trailing `...`.
- **`nil`**: renders as the G# keyword `nil`; strings render quoted; other
  overridden types render via `Convert.ToString` invariant culture (the same
  convention `DataStructSynthesizer` compiled in).
- **Inheritance**: no emitted member exists, so there is no slot/re-override
  question; the formatter reflects over the *runtime* type, which naturally
  includes inherited public fields. Data-class hierarchies keep ADR-0029's
  already-solved emitted behavior (#2338).
- **Interop**: unchanged, by construction. A G# plain class consumed from C#
  behaves exactly like the equivalent C# class (`string.Format`,
  interpolation, debugger, logging); only `data` types expose synthesized
  overrides — which is today's contract and matches the C# records
  precedent one-to-one (`class`/`struct` plain, `record` synthesized).
- **Cost**: zero metadata; measured ~5 µs per echo (spike), paid once per
  cell render, only in the REPL.

One scoping knob stays open for tuning: whether the trigger applies to
*any* override-less value (Roslyn's `ObjectFormatter` posture — also
improves override-less imported CLR types) or is restricted to types from
session/user assemblies. The implementation ships the general trigger, as
the spike validated and this ADR recommends, with the throwing-getter guard
as the safety net; it may be tightened later if real sessions surface
pathological BCL shapes (the format is diagnostics-only, so tightening is
not a compatibility event).

### What this deliberately leaves alone

- `EmittedOracle.ValueText` and all test oracles keep raw `ToString`
  semantics — the oracle mirrors product semantics, not display sugar.
- `gsc`-compiled programs, the LSP, and the debugger see no change.
- The `data` modifier keeps its meaning: *the* opt-in for value semantics as
  a set (equality + hash + rendering + deconstruction), not a rendering
  flag.

## Evidence — feasibility spike

`test/Interpreter.Tests/Adr0157PrettyDisplaySpikeTests.cs` (trait
`Category=Adr0157Spike`, excluded from no gates, run via
`dotnet test test/Interpreter.Tests --filter "FullyQualifiedName~Adr0157"`)
proves the recommended mechanism end-to-end with **zero product changes**,
over values produced by real emitted execution (`test/Shared/EmittedOracle`):

| Case | Result |
|---|---|
| Plain two-field struct | today's contract pinned (`ToString` slot is `ValueType`'s, echo is the CLR type name — #3204), formatter renders `Point{X: 1, Y: 2}` |
| `data struct` | emitted override confirmed on the type itself (interop-visible), formatter defers: `Point(X=1, Y=2)` |
| `override func ToString` on a plain struct | formatter defers: `tag:11` |
| Nested class + `nil` field | `Node{Name: "root", Next: Node{Name: "leaf", Next: nil}}` |
| Reference cycle (`a.Next = b; b.Next = a`) | terminates: `Node{Name: "a", Next: Node{Name: "b", Next: ...}}` |
| `[]int32` small / 12 elements | `[1, 2, 3]` / capped `[1, 2, 3, 4, 5, 6, 7, 8, ...]` |

Measurements (Debug, .NET 10, Apple Silicon; all 7 tests green):

- **Formatter latency**: 5.1 µs per `Format` call steady-state
  (1,000 iterations, nested two-node graph) — three orders of magnitude
  below the ~47 ms per-submission cost ADR-0156 measured, i.e. free at echo
  time.
- **Metadata cost of the rejected always-on alternative**: one identical
  program compiled with `struct Point` vs `data struct Point`:
  2,560 → 3,584 bytes PE (**+1,024 bytes** for the seven synthesized
  members, of which `ToString` is one). An always-on rule pays a per-type
  slice of this in every assembly for every user type, plus the
  planner/emitter row-agreement surface, independent of whether anything is
  ever printed.

The formatter prototype (~130 lines including the contract's guards) lives
in the spike as `SpikeValueFormatter`; the accepted implementation is
`src/Repl/Engine/ReplValueFormatter.cs`, wired at the three echo sites,
with behavioral pins (including the ADR-0154 reverted-hunk witness) in
`test/Interpreter.Tests/Adr0157ReplValueFormatterTests.cs`. The spike file
stays untouched as ADR evidence, per the ADR-0156 precedent.

## Consequences

- The REPL echo becomes useful for plain types (`Point{X: 1, Y: 2}` instead
  of `gsi1.Point`) with no change to language semantics, emitted metadata,
  interop surface, or spec obligations.
- #3204's decision is preserved intact: emitted CLR semantics *are* the
  language behavior; the pretty rendering is visibly a tool affordance and
  can evolve (colorization, truncation tuning, dictionary rendering) without
  compatibility process.
- The `data`/plain distinction keeps carrying meaning: users who want a real,
  interop-visible, stable `ToString` say `data` (or write the override) —
  both already implemented, tested, and inheritance-correct.
- The C#-alignment invariant survives: a G# type and its C# equivalent
  behave identically from either side of the interop boundary. No new
  divergence class is created one campaign after ADR-0156 eliminated the
  last one.
- Cost: a small REPL-side formatter to maintain (rendering-contract tests
  live with it); REPL echo and compiled `Console.WriteLine(p)` output differ
  for plain types — the same deliberate asymmetry csi/fsi/Python REPLs have,
  and the emitted behavior is always one `data` keyword away.
- If the owner later wants language-level synthesis after all, nothing here
  forecloses it: the formatter simply starts deferring to the new overrides
  by construction (its trigger is "no override exists").

## Alternatives considered

### Always-on synthesized `ToString` for every user type without one (records-style, emitted)

The primary design named in #3208: emit a real override so interop,
interpolation, and the debugger all see pretty output. Rejected:

- **It re-creates the divergence class G# just paid to eliminate.** A G#
  `class Point` and the equivalent C# `class Point` would observably differ
  (`string.Format`, interpolation, logging, debugger) — the same
  "G# quietly renders differently" property #3204 retired, moved from the
  evaluator into permanent emitted metadata. C# deliberately reserves
  synthesis for `record`; G# already mirrors that split with `data`.
- **It erases the `data` distinction.** `data`'s contract is value semantics
  as a coherent set. Plain types acquiring the rendering member alone
  creates a third, half-value category (pretty printing, reference
  equality), and the modifier's rendering benefit silently vanishes.
- **The rendering contract becomes spec, permanently.** Field order, depth,
  cycles (unsolvable in per-type emitted code without runtime tracking
  machinery — the spike's cycle case), collections, accessibility, and
  format stability would all need normative answers frozen into compiled
  assemblies. Display-side, every one of these is a revisable tool choice.
- **Per-type, always-paid cost.** Measured +1,024 bytes PE for one
  two-field struct's synthesized set; a ToString-only variant still pays a
  MethodDef row, IL body, and user-string blobs per type, plus the
  `PlanClassMethods`/`PlanStructMethods` row-agreement surface (#2361/#2363
  show its maintenance shape), plus trimming/AOT surface for members nothing
  may ever call.

### Opt-out synthesis (always-on minus an escape attribute)

All of the above, plus new attribute surface whose only purpose is undoing a
default the user never asked for. Rejected.

### A new opt-in modifier/attribute for ToString-only synthesis

Rejected as redundant surface: the opt-in space is already occupied twice —
`data` for the full synthesized set and `override func ToString` for exactly
one method (a two-field one is a one-liner arrow function). A third opt-in
adds grammar, binder, planner, and docs cost without new capability.

### REPL-display formatting scoped to session assemblies only

A narrower trigger than the recommended "no override anywhere" rule.
Retained as an implementation knob rather than the decision: the general
rule is simpler, matches Roslyn `ObjectFormatter` behavior, benefits
override-less imported CLR types, and the throwing-getter guard plus depth
and element caps bound the risk. The implementation PR may tighten this if
real sessions surface pathological BCL shapes.

### Do nothing (status quo)

Keeps `gsi1.Point` as the echo for the most common beginner-visible case in
the tool most used to answer "what does this expression do". Rejected: the
fix is small, display-only, and reversible.
