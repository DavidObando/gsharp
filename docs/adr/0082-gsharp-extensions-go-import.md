# ADR-0082: Gate Go-flavored concurrency behind `import Gsharp.Extensions.Go`

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 6 (cleanup)
- **Related**: ADR-0022 (go / chan / select lowering — the surface
  this ADR gates), ADR-0002 (concurrency model), ADR-0023
  (async/scope as the production concurrency primitive),
  ADR-0028 (multi-file compilation units), parent issue #706
  (Oats cleanup), implementing issue #722, paired issue #723
  (Go-style built-ins gated by the same import), paired issue
  #724 (`Gsharp.Extensions.Optional` / `.Sequences` namespaces
  in the same shipped assembly).

## Context

ADR-0022 brought a Go-flavored concurrency surface to G#: the
`go` statement, the `chan T` type, the `ch <- v` send statement,
the `<-ch` receive expression, the `select` statement (with
`default`, receive, receive-bind, and send cases), the
`close(ch)` built-in, and the `make(chan T)` / `make(chan T,
capacity)` constructor. The surface is implemented over
`System.Threading.Channels` and shares lowering with the
`scope` block (ADR-0023).

§5.4 of the design plan promoted `scope` plus `async` / `await`
to the **production** concurrency surface for G#: it composes
with the BCL task model, integrates with `await for` over async
sequences, and supports structured failure propagation through
`scope` joins. The Go-flavored shapes remain valuable for
problem domains where they map naturally (fan-out producer /
consumer pipelines, ticker / select multiplexing), but they
should not be the default surface a learner is exposed to in
the very first sample.

The Oats cleanup pass (#706) is removing the legacy "Go is the
only way" framing across the language. Issue #722 closes the
loop by gating the syntactic forms behind an explicit per-file
opt-in. Without the opt-in, `go`, `chan T`, `<-`, `select`,
`close(ch)`, and `make(chan ...)` are rejected with an
actionable diagnostic pointing the user either at the import
they almost certainly forgot, or at the `scope` + `async` /
`await` production surface.

Two sibling issues piggy-back on the same import root:

- **#723** adds Go-style built-in functions (e.g. `len`, `cap`,
  `append`, `delete`, `print`-shaped helpers) behind the same
  `import Gsharp.Extensions.Go` namespace once a future ADR
  takes them off the implicit list. This ADR claims the namespace
  so #723 only needs to add new gated forms — not re-design the
  packaging.
- **#724** layers additional helper namespaces alongside
  `Gsharp.Extensions.Go` — `Gsharp.Extensions.Optional`,
  `Gsharp.Extensions.Sequences`, and so on — inside the **same**
  shipped `Gsharp.Extensions` assembly. The namespace hierarchy
  and packaging decisions here ensure those additions are
  mechanical (drop a class into a new namespace; consumers
  import as needed).

## Decision

### Packaging

A new physical assembly **`Gsharp.Extensions.dll`** ships with
the `Gsharp.NET.Sdk` NuGet. It lives next to the SDK targets and
the bundled compiler:

```
Gsharp.NET.Sdk.<version>.nupkg
├── Sdk/
├── build/
├── tools/
│   ├── compiler/    ← gsc + closure (ADR existing)
│   ├── extensions/  ← Gsharp.Extensions.dll (this ADR)
│   └── task/        ← BuildTask (ADR existing)
```

The SDK's `Gsharp.NET.Sdk.props` auto-appends the bundled
`Gsharp.Extensions.dll` to `@(_ExplicitReference)` for every
consumer project, so users **do not need** a `<PackageReference>`
of their own. The `import Gsharp.Extensions.Go` statement is
the user-visible opt-in surface — the assembly reference is an
implementation detail that mirrors the existing implicit
`mscorlib` reference (see `Gsharp.NET.Core.Sdk.targets`).

In the in-repo build, the project lives at
`src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj` (next to
`Gsharp.NET.Sdk` and `Gsharp.Templates`) and is added to
`GSharp.sln` so it builds with the rest of the repo. The
project targets `net10.0` to match the bundled compiler.

### Namespace hierarchy

`Gsharp.Extensions` is the root namespace. Sub-namespaces are
the per-extension import targets:

| Namespace | Purpose | Introduced by |
|---|---|---|
| `Gsharp.Extensions.Go` | Gates Go-flavored concurrency syntax and (later) Go-style built-ins | #722 (this ADR) / #723 |
| `Gsharp.Extensions.Optional` | `Option[T]` / `Result[T,E]` extension API | #724 |
| `Gsharp.Extensions.Sequences` | LINQ-shaped sequence helpers beyond the BCL | #724 |

Each sub-namespace ships at least one public type so an
`import Gsharp.Extensions.X` is meaningful at type-resolution
time, not only as a binder gate.

For **this PR**, `Gsharp.Extensions.Go` contains a single
marker type — `public static class GoExtensions` — whose
presence makes the namespace resolvable. #723 fleshes it out
with the Go-style built-in surface.

### What is gated, and what is not

The following **syntactic** forms require
`import Gsharp.Extensions.Go` in the same compilation unit. Each
gated site reports GS0316 anchored at the indicated token; the
human-readable form name is the diagnostic message's `<form>`
placeholder.

| Form | Anchor token | Reported `<form>` |
|---|---|---|
| `go expr` statement | the `go` keyword | `go` |
| `chan T` type clause (params, returns, vars, `make(chan T)`, …) | the `chan` keyword | `chan` |
| `<-ch` receive expression | the `<-` operator | `<- (receive)` |
| `ch <- value` send statement | the `<-` operator | `<- (send)` |
| `select { … }` statement | the `select` keyword | `select` |
| `close(ch)` built-in call | the `close` identifier | `close` |

The `make(chan T)` / `make(chan T, capacity)` constructor is
covered through the inner `chan` type-clause gate — the `chan`
trigger is what users actually need the import for, and a
single `chan` GS0316 per `make` site is less noisy than two
diagnostics at the same source span. The constructor is still
called out as a triggering shape in user-facing documentation
(spec, tour, concurrency guide) and in the GS0316 reference
entry so it is discoverable, but it shares the `chan` anchor
rather than emitting a separate `make(chan)` diagnostic.

The following stays in the **production** concurrency surface
and is **not** gated:

- The `scope { … }` structured-concurrency block.
- `async func` declarations and the `await` prefix operator.
- `await for v in src` async iteration.
- `sequence[T]` / `async sequence[T]` and `yield`.
- Direct use of `System.Threading.Tasks.Task` / `Task[T]` via
  ordinary CLR interop.

`scope` deliberately remains ungated even though it composes
with `go` in the gated samples: `scope` by itself (joining a
set of `Task`-returning awaitables) is the production surface
the §5.4 promotion targets.

### Diagnostic GS0316

A single error-severity diagnostic:

| ID | Severity | Message template |
|---|---|---|
| `GS0316` | Error | `` '`<form>`' is provided by `Gsharp.Extensions.Go`. Add `import Gsharp.Extensions.Go` or use `scope` + `async`/`await` instead (ADR-0082). `` |

`<form>` is the actual triggering identifier — `go`, `chan`,
`<-` (with the `(send)` / `(receive)` qualifier where the
operator is ambiguous), `select`, `close`, or `make(chan)`.
The diagnostic is anchored at the keyword / operator token (so
IDEs underline the right span).

The binder fires GS0316 **once per offending site** so users
get an exhaustive list per build, not just the first
occurrence. Recovery binds the form as if the import were
present, so downstream diagnostics about the *meaning* of the
form (e.g. "send target is not a channel") still surface and
no cascade collapses on the first GS0316.

When a symbol named `go`, `chan`, `select`, `close`, or `make`
exists in scope (e.g. a user function `func close(x int32)
…`), GS0316 still fires for the **syntactic** forms because
the parser already resolved the keyword path before name
resolution sees it. Symbol names that collide are independent
of the gate.

### `/noimplicitimports` interaction

`Gsharp.Extensions.Go` is **always** opt-in regardless of
`/noimplicitimports`. The compiler never auto-adds
`import Gsharp.Extensions.Go`, and `/noimplicitimports`
continues to only control the implicit `import System` seed.
There is no per-project flag to flip the gate off — the user
either imports `Gsharp.Extensions.Go` per file or sees
GS0316.

Rationale: the gate exists to make Go-flavored concurrency a
deliberate choice. A project-level escape hatch would defeat
the §5.4 promotion of `scope` + `async` to the production
surface, by re-establishing Go syntax as ambient.

### Per-file scope

The gate is per **compilation unit** (per `SyntaxTree`), not
per package and not project-wide. The `ImportSymbol.Declaration`
back-reference identifies which `SyntaxTree` declared each
import. The binder checks
`imp.Target == "Gsharp.Extensions.Go" && imp.Declaration?.SyntaxTree == triggeringForm.SyntaxTree`.

Per-file matches the existing import lookup model: each `.gs`
file declares its own imports. ADR-0028's multi-file packages
do not collapse import sets across files.

A file that imports `Gsharp.Extensions.Go` but never uses any
gated form is **allowed** with no diagnostic. The compiler
does not emit "unused import" diagnostics for any import
today; that policy stays. Tooling may later surface it as an
IDE hint, but not as a compile diagnostic.

### Recovery

For every gated site, the binder reports GS0316 and then
continues binding the form as if the import were present. The
bound tree the rest of the pipeline sees is therefore
identical whether the import is present or not — only the
diagnostic differs. This guarantees:

- One GS0316 per offending site (no cascade onto
  "undefined `BoundGoStatement`" or similar).
- Subsequent type / shape diagnostics (e.g. "send target is
  not a channel") still fire so the user fixes everything in
  one pass.
- Emit / interpreter behaviour is unchanged — the bound tree
  is unchanged.

## Consequences

### For users

- Every `.gs` file that currently uses `go`, `chan T`, `<-`,
  `select`, `close(ch)`, or `make(chan T)` needs one new line:
  `import Gsharp.Extensions.Go`. Existing samples ship with
  the import added.
- Programs that use only `scope` + `async` / `await` are
  unaffected. This is now the default G# concurrency surface a
  learner encounters first.
- IDE auto-complete will surface the import as a quick-fix on
  GS0316 once tooling implements the existing
  "missing-import" fixer for the new diagnostic.

### For the compiler

- No new `BoundNodeKind`, no new lowering, no new emit path.
  The gate is purely a binder pre-check. `BoundGoStatement`,
  `BoundChannelSendStatement`, `BoundChannelReceiveExpression`,
  `BoundSelectStatement`, `BoundChannelCloseExpression`, and
  `BoundMakeChannelExpression` are unchanged.
- One new diagnostic id (GS0316) and one new binder helper
  (`Binder.IsGoExtensionsImported`). The helper is a linear
  scan over `scope.GetDeclaredImports()` filtered by
  `Target == "Gsharp.Extensions.Go"` and the per-tree match.
  Linear is fine: import lists are tiny (single-digit count
  per file in every existing sample).
- One new bundled assembly (`Gsharp.Extensions.dll`),
  referenced from `Gsharp.NET.Sdk.props` via
  `<_ExplicitReference>` so it is visible to gsc without a
  `<PackageReference>`. The assembly is intentionally tiny —
  marker types only for now — and grows in #723 / #724.

### For #723 and #724

This ADR fixes the packaging and the naming convention so the
sibling issues are mechanical:

- **#723** adds Go-style built-ins behind the same
  `import Gsharp.Extensions.Go` gate. The binder helper this
  ADR introduces (`IsGoExtensionsImported`) is reused
  verbatim; the new gate sites live in the same
  `TryBindIntrinsicCall` and friends. The diagnostic GS0316
  is reused, parameterized on the built-in's identifier.
- **#724** adds new namespaces (`Gsharp.Extensions.Optional`,
  `Gsharp.Extensions.Sequences`) **inside the same**
  `Gsharp.Extensions.dll`. The SDK already references the
  assembly; #724 only needs to add new public types under new
  sub-namespaces and (optionally) add similar gated forms
  with new diagnostic ids.

## Migration plan

1. The compiler ships GS0316 in error severity from day one
   (no warning-then-error grace period). All Go-flavored
   samples in the repo are updated in the same PR. There is
   no out-of-tree downstream consumer at this stage that
   would require a warning grace period.
2. Each existing Go sample gets `import Gsharp.Extensions.Go`
   prepended after its `package` declaration:
   - `samples/Channels.gs`
   - `samples/GoScope.gs`
   - `samples/Select.gs`
   - `samples/AsyncGoScopeJoin.gs`
   - `samples/PortScan.gs`
   - `samples/AsyncTask.gs`
   - `samples/AsyncValueReturns.gs`
   Goldens for each sample are byte-identical (the import is
   silent at runtime).
3. A new sample `samples/GoChannelsGated.gs` (paired with
   `samples/GoChannelsGated.golden`) demonstrates the import
   end-to-end and is the first sample a reader sees when
   navigating to "Go-style channels in G#".
4. The spec, tour, concurrency guide, and feature matrix all
   call out the import as a required line and frame the
   Go-flavored shapes as opt-in.

## Alternatives considered

- **No gate, just deprecation tag.** Rejected: doesn't move
  the default surface away from Go-flavored shapes, just
  decorates them. The §5.4 promotion needs the syntactic
  forms to *fail* without an explicit acknowledgement.
- **Project-level MSBuild flag.** Rejected: an ambient flag
  re-establishes Go syntax as the default surface for
  projects that flip it. Per-file imports keep the choice
  visible at every call site.
- **Folding `Gsharp.Extensions.Go` into the existing implicit
  `System` import seed.** Rejected: that defeats the whole
  point of the gate. The implicit `System` seed exists for
  pure ergonomic reasons (`Console`, `String`); making
  `chan` and `select` ambient pulls in concurrency surface
  by default again.
- **Splitting `chan` and `select` into separate imports.**
  Rejected: the three forms — `go`, `chan` + `<-` + `select`
  + `close` + `make(chan)`, and (future) Go-style built-ins —
  are one cluster from the user's perspective. One import
  matches Go's mental model and matches what tooling
  quick-fixes will offer.
