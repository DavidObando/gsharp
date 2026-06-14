# ADR-0083: Gate Go-style built-ins behind `import Gsharp.Extensions.Go`

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 6 (cleanup)
- **Related**: ADR-0082 (Go-flavored concurrency surface gated behind
  the same import — this ADR extends that gate to the built-in
  function surface), ADR-0022 (`go` / `chan` / `select` /
  `close(ch)` / `make(chan T)` lowering — the cluster the built-in
  gate inherits its packaging from), parent issue #706 (Oats
  cleanup), implementing issue #723, paired issues #722
  (ADR-0082, merged) and #724 (`Gsharp.Extensions.Optional` /
  `.Sequences` namespaces in the same shipped assembly).

## Context

ADR-0082 (#722) introduced the per-file `import Gsharp.Extensions.Go`
gate for the Go-flavored *syntactic* concurrency surface: the `go`
statement, the `chan T` type clause, the `<-` send and receive
operators, the `select` statement, the `close(ch)` built-in, and
the `make(chan T[, capacity])` constructor. The §"For #723 and
#724" subsection of that ADR explicitly defers the matching
**built-in function** surface — `len`, `cap`, `append`, `delete`,
plus `make` — to this issue, on the same import root, reusing the
same `BinderContext.IsGoExtensionsImported` predicate.

The remaining built-ins are Go-style, not Go-only:

- `len(x)` returns the length of arrays, slices, strings, maps,
  and channels.
- `cap(x)` returns the capacity of slices and channels.
- `append(s, e)` grows-and-copies a slice.
- `delete(m, k)` removes a key from a map.
- `make(T)` / `make(T, n)` / `make(T, n, m)` is the constructor
  for `chan T`, `map[K,V]`, and `[]T` (only the `chan T` shape is
  currently implemented in the parser — see "Scope" below).
- `close(ch)` marks a channel-writer complete. ADR-0082 already
  gates `close`.

Each of these has a clean .NET-idiomatic alternative for the
common cases:

| Built-in | Receiver | .NET idiom |
|---|---|---|
| `len(arr)` / `len(s)` | array / slice / string | `.Length` |
| `len(map)` | map | `.Count` |
| `delete(map, k)` | map | `.Remove(k)` |
| `append(s, e)` | slice | no zero-cost equivalent (see "append"); recommend `List[T].Add` for the mutable-list shape |
| `cap`, `close`, `make(chan ...)` | channel / slice | no clean alternative — the user really wants the import |

Without the gate, the built-ins are ambient — they shadow any
user identifier named `len` / `cap` / `append` / `delete` /
`make` and they steer newcomers toward writing Go-style code by
default. The §5.4 promotion of `scope` + `async` / `await` to the
production concurrency surface (ADR-0082, restated) is undermined
if the *non-concurrency* Go-style surface stays ambient: a
beginner writing `len(arr)` is one step away from `make(chan T)`
in the same idiom.

The ergonomic cost of putting the built-ins behind the same
import is low: every existing sample that uses any of these
already lives next to channel samples that need the import
anyway, and the new GS0317 diagnostic names the exact .NET
alternative for receiver-types where there is one — so users who
do not want the Go surface get a one-edit migration instead of
losing functionality.

## Decision

### What is gated, and what is not

The following **built-in identifiers** require
`import Gsharp.Extensions.Go` in the same compilation unit. Each
gated site reports **GS0317** anchored at the built-in identifier
token. The diagnostic message names the built-in and, when there
is a clean .NET-idiomatic replacement, also names the
replacement.

| Built-in | Gate site | Diagnostic |
|---|---|---|
| `len(x)` | `TryBindIntrinsicCall` "len" / "cap" case | GS0317 |
| `cap(x)` | `TryBindIntrinsicCall` "len" / "cap" case | GS0317 |
| `append(s, e)` | `TryBindIntrinsicCall` "append" case | GS0317 |
| `delete(m, k)` | `TryBindIntrinsicCall` "delete" case | GS0317 |
| `close(ch)` | `TryBindIntrinsicCall` "close" case | **GS0316** (per ADR-0082) |
| `make(chan T[, capacity])` | inner `chan` clause via `BindTypeClause` | **GS0316** (per ADR-0082) |

`make(chan T)` and `close(ch)` deliberately stay on the GS0316
("channel surface") message because they are part of the same
concurrency cluster as `go` / `chan` / `<-` / `select`: a user
who only writes one of those forms and forgets the import
should see a single, consistent message pointing at the import
they need, not two different diagnostics for two different
built-ins in the same cluster. See "Deconfliction with `close`"
below.

The other shapes of `make` (`make([]T, n)` for slices and
`make(map[K,V])` for maps) are not currently supported by the
parser (see ADR-0020 §"Open questions"). When they are added,
they will reuse the gate site established here — the binder
helper `ReportIfGoBuiltinImportMissing` already exists and the
GS0317 message template already accepts arbitrary built-in
names. This ADR pins that future addition behind the same
import.

### Diagnostic GS0317

A single error-severity diagnostic for the built-in cluster.

| ID | Severity | Message template |
|---|---|---|
| `GS0317` | Error | `` '`<name>`' is provided by `Gsharp.Extensions.Go`. Add `import Gsharp.Extensions.Go` or call '`<suggestion>`' directly (ADR-0083). `` |

When the built-in has no documented .NET-idiomatic alternative
(`cap`, future `make` shapes), the message falls back to the
import-only variant:

`` '`<name>`' is provided by `Gsharp.Extensions.Go`. Add `import Gsharp.Extensions.Go` (ADR-0083). ``

The suggestion table is implemented in
`BinderContext.GetGoBuiltinSuggestion(string builtin, TypeSymbol receiverType)`:

| Built-in | Receiver | `GetGoBuiltinSuggestion` returns |
|---|---|---|
| `len` | `MapTypeSymbol` | `.Count` |
| `len` | `ArrayTypeSymbol` / `SliceTypeSymbol` / `string` | `.Length` |
| `len` | (other / error) | `.Length` (most common case) |
| `delete` | (any) | `.Remove(k)` |
| `append` | (any) | `List[T].Add` |
| `cap`, `close`, `make` | (any) | `null` — import-only |

The diagnostic is anchored at the built-in identifier token (so
IDE quick-fix surfaces the right span). The binder fires GS0317
**once per offending site** so users get an exhaustive list per
build.

### Deconfliction with `close`

`close(ch)` and `make(chan T)` already report **GS0316** when
the import is missing (ADR-0082 sites, unchanged by this ADR).
This ADR explicitly *does not* double-gate them: the binder
contains exactly one gate per offending site, the one that fired
first. The rationale is twofold:

1. **One identifier, one diagnostic.** A user writing
   `close(ch)` without the import sees one GS0316 today, and
   continues to see exactly one GS0316 after this ADR ships.
   Adding GS0317 would be a regression in signal-to-noise for
   no benefit — the suggested fix (the import) is identical.
2. **The channel cluster wants its own message.** `close` /
   `make(chan T)` are part of the channel surface; the GS0316
   wording specifically frames the `scope` + `async` / `await`
   alternative for that surface. The GS0317 wording specifically
   frames the `.Length` / `.Count` / `.Remove(k)` alternative
   for the value-oriented built-ins. Mixing them would dilute
   both.

The regression-tests in `Issue723GoBuiltinsImportGateTests`
explicitly assert that `close(ch)` and `make(chan T)` keep
firing GS0316 and never fire GS0317.

### Library backing

The `Gsharp.Extensions.Go` namespace remains backed by the
single marker type `Gsharp.Extensions.Go.GoExtensions` that
ADR-0082 introduced. None of the built-ins gated in this ADR
move to library extension methods today — they remain
compiler-resolved by `TryBindIntrinsicCall`, because:

- `len` / `cap` / `append` / `delete` lower to dedicated bound
  nodes (`BoundLenExpression`, `BoundCapExpression`,
  `BoundAppendExpression`, `BoundMapDeleteExpression`) that the
  emit pipeline already knows how to compile into IL.
  Re-routing through extension-method dispatch would lose the
  shape information the lowering relies on.
- `make(chan T)` is a contextual parser shape, not a method
  call. The library cannot back it without re-introducing the
  shape into the language as a method-callable form.
- `close(ch)` is a single-call helper that already maps onto
  `ChannelWriter<T>.Complete()` in lowering; the import gate is
  enough to make the form opt-in without rewriting emit.

The `Gsharp.Extensions.Go.GoExtensions` marker type stays
public so the namespace round-trips through `System.Type`-based
import resolution. Future Go-style helpers that *are*
library-backed (e.g. a `chan T` builder facade or a "go-like
ticker" helper) will land on this same marker type as static
extension methods, gated by the same import.

### Recovery

For every gated built-in, the binder reports GS0317 and then
continues binding the form as if the import were present. The
bound tree is identical whether the import is present or not —
only the diagnostic differs. This guarantees:

- One GS0317 per offending site (no cascade onto "undefined
  `BoundLenExpression`" or similar).
- Subsequent shape diagnostics (e.g. GS0117 "Built-in 'len'
  cannot be applied to a value of type 'int32'") still fire so
  the user fixes everything in one pass. The regression test
  `GateRecovery_DoesNotSwallowShapeDiagnostic` enforces this.
- Emit / interpreter behaviour is unchanged.

### Per-file scope, `/noimplicitimports`, packaging

All three policies are inherited verbatim from ADR-0082:

- The gate is **per compilation unit**
  (`SyntaxTree`), not per package and not project-wide.
  `BinderContext.IsGoExtensionsImported` walks the file's own
  imports.
- The import is **always opt-in** regardless of
  `/noimplicitimports`. There is no project-level escape hatch.
- The library lives in the existing `Gsharp.Extensions.dll`
  bundled in `Gsharp.NET.Sdk` under `tools/extensions/` — no
  new project, no new NuGet, no new MSBuild plumbing. The
  marker class `Gsharp.Extensions.Go.GoExtensions` already
  makes the namespace resolvable.

## Consequences

### For users

- Every `.gs` file that currently uses `len`, `cap`, `append`,
  or `delete` now needs `import Gsharp.Extensions.Go`. The
  in-repo `samples/Slices.gs` is migrated in the same PR (it
  exercises slices and `append`, both Go-flavored shapes —
  adding the import is the canonical fix for that sample's
  pedagogical intent).
- Programs that work only with .NET BCL collection APIs
  (`array.Length`, `dict.Count`, `dict.Remove(k)`,
  `list.Add(...)`) are unaffected.
- IDE quick-fix will surface the import as a fix-it on GS0317
  once tooling implements the existing missing-import fixer
  for the new diagnostic.

### For the compiler

- No new `BoundNodeKind`, no new lowering, no new emit path,
  no new parser productions. The gate is purely a binder
  pre-check inside the existing `TryBindIntrinsicCall` cases.
- One new diagnostic id (GS0317) and one new binder helper
  (`BinderContext.ReportIfGoBuiltinImportMissing`, paired with
  a static `GetGoBuiltinSuggestion` table).
- `Gsharp.Extensions.dll` is unchanged (the built-ins remain
  compiler-resolved).
- `BoundNodeKindExhaustivenessTests` is unaffected: no new
  bound-node kinds.

### For #724 and future additions

This ADR completes the pattern ADR-0082 established for the
`Gsharp.Extensions.Go` import gate. New gated forms (Go-style
helpers that surface as built-ins) follow the same recipe:

1. Add the gate at the end of the operand-binding step inside
   `TryBindIntrinsicCall`.
2. Call `binderCtx.ReportIfGoBuiltinImportMissing(...)`.
3. Add a row to the `GetGoBuiltinSuggestion` table for any
   .NET-idiomatic alternative.
4. Update `Issue723GoBuiltinsImportGateTests` (or its sibling)
   with a missing-import case and a with-import case.

`#724`'s sibling namespaces (`Gsharp.Extensions.Optional`,
`Gsharp.Extensions.Sequences`) follow the same packaging
pattern but with their own per-namespace import predicates;
this ADR does not pre-commit them to GS0317. They get their
own diagnostic ids in the GS03xx block as they land.

## Migration plan

1. The compiler ships GS0317 in error severity from day one
   (no warning-then-error grace period). There is no out-of-tree
   downstream consumer that would require a warning grace
   period. ADR-0082 already taught the ecosystem to expect this
   class of gate.
2. `samples/Slices.gs` gets `import Gsharp.Extensions.Go`
   prepended after its `package` declaration. The sample
   intentionally retains the Go-flavored shapes because it
   exists to demonstrate slices and `append`.
3. Spec, tour, concurrency guide, and feature matrix all call
   out the import as required for the Go-style built-ins and
   cross-link to ADR-0082 / ADR-0083.
4. The new `samples/GoBuiltinsGated.gs` exercises every gated
   built-in under the import end-to-end and participates in
   the regular `SampleConformance` harness.

## Alternatives considered

- **Land GS0317 as a warning first, error in the next release.**
  Rejected for the same reason ADR-0082 rejected the
  warning-then-error path: there is no out-of-tree consumer
  base to migrate, and a warning leaves the §5.4 promotion of
  `scope` + `async` / `await` half-done.
- **Move `len` / `cap` / `append` / `delete` into library
  extension methods on the respective receivers (`SliceExtensions`,
  `MapExtensions`, …).** Rejected: each built-in lowers to a
  shape-aware bound node today, and the emit / interpreter
  pipelines depend on those nodes. Re-routing through extension
  methods would lose information without ergonomic benefit (the
  user-visible name and gate would be identical).
- **Re-use GS0316 for every built-in.** Rejected: GS0316's
  wording is channel-cluster-specific ("use `scope` + `async` /
  `await` instead"). The non-channel built-ins want
  receiver-specific suggestions (`.Length`, `.Count`,
  `.Remove(k)`, `List[T].Add`) that the GS0316 template cannot
  carry without diluting the channel message. The two
  diagnostics share the same `IsGoExtensionsImported`
  predicate, so the mechanism is unified; only the message
  differs.
- **Split each built-in into its own diagnostic id
  (GS0317–GS0321).** Rejected: every gated built-in has the
  same root cause (missing `import Gsharp.Extensions.Go`) and
  the same recovery (add the import). One id with a
  per-built-in / per-receiver message is the right grain.
