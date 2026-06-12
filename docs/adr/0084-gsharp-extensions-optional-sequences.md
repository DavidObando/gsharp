# ADR-0084: `Gsharp.Extensions.Optional` and `Gsharp.Extensions.Sequences` — first idiomatic helper namespaces

- **Status**: Accepted
- **Date**: 2026-06-13
- **Phase**: Phase 6 (cleanup)
- **Related**: ADR-0082 (`Gsharp.Extensions` packaging convention and the
  per-file `import Gsharp.Extensions.Go` gate for the Go syntactic
  surface), ADR-0083 (Go-style built-ins under the same import gate),
  parent issue #706 (Oats cleanup), implementing issue #724, paired
  issues #722 / #723.

## Context

G# §5.12 calls for a "thin idiomatic helper layer" on top of the .NET
BCL that:

1. Reshapes BCL APIs that don't compose with G#'s type system
   (notably nullable references and `sequence[T]`).
2. Adds the small handful of iterator utilities .NET lacks
   (windowed / chunked / pairwise / interleave / safe terminals).
3. Gives samples a uniform "G#-shaped" feel — explicit `Sequences.*`
   builders, `T?` extension methods that match the rest of the
   language surface.

ADR-0082 (#722) already created a physical assembly,
**`Gsharp.Extensions.dll`**, bundled with `Gsharp.NET.Sdk` so every
G# project resolves it without an extra `<PackageReference>`. The
Go-flavored concurrency surface (ADR-0082) and the Go-style
built-ins (ADR-0083) live under `Gsharp.Extensions.Go` inside that
same assembly. This ADR pins the packaging convention and lays
down the first two non-Go namespaces in the same assembly:

- `Gsharp.Extensions.Optional` — extension methods on `T?`.
- `Gsharp.Extensions.Sequences` — static builders and extension
  transformers over `sequence[T]` / `IEnumerable<T>`.

The two are deliberately small, opt-in, dogfooding-first. They are
the seed for a longer-running stdlib track, not a hard freeze.

## Decision

### Packaging convention

- **One physical assembly**, `Gsharp.Extensions.dll`, shipped by
  `Gsharp.NET.Sdk` via the `_ExplicitReference` machinery already
  introduced in ADR-0082. No additional NuGet reference is required.
- **Authored under `src/Sdk/Gsharp.Extensions/`** as a single
  `Gsharp.Extensions.csproj`. The dogfooding goal (see "Known
  limitations" below) is to author every helper in G# itself; until
  the language gaps documented here are closed, the helpers in this
  ADR are authored in C# inside the same project as a documented
  escape hatch (§4 of the issue brief).
- **No auto-imports.** The `/noimplicitimports` compiler switch is
  irrelevant to `Gsharp.Extensions.*`: nothing under that root is
  ever auto-imported, even when implicit imports are enabled for
  the BCL. Each namespace must be brought in explicitly with
  `import Gsharp.Extensions.<Name>`. Rationale: the Extensions
  layer is opinionated and we never want it leaking into projects
  whose owners did not opt in to it.

### Namespace layout

The Extensions assembly is organised by *capability*, one namespace
per cluster:

- `Gsharp.Extensions.Optional` — operations on `T?`.
- `Gsharp.Extensions.Sequences` — sequence builders and
  transformers (lazy by default, terminals where they cannot be).
- `Gsharp.Extensions.Go` — Go-flavored surface (ADR-0082, ADR-0083).

Future helper namespaces follow the same recipe (`Strings`,
`Numbers`, `Result`, etc.). Cross-namespace helpers go in the
*lower* namespace; nothing under `Gsharp.Extensions.*` may auto-
import another `Gsharp.Extensions.*` namespace.

### Surface — `Gsharp.Extensions.Optional`

Reference-typed (`T : class`) extensions:

```
func [T, U]  (self T?) Map(f (T) -> U) U?
func [T, U]  (self T?) FlatMap(f (T) -> U?) U?
func [T]     (self T?) OrElse(default T) T
func [T]     (self T?) OrCompute(default () -> T) T
func [T]     (self T?) OrThrow(message string) T
func [T]     (self T?) IfPresent(action (T) -> void)
func [T]     (self T?) Filter(pred (T) -> bool) T?
```

Value-typed companions (`T : struct`) share the same names as the
reference-typed surface. The G# binder honours generic constraints
during overload resolution (ADR-0088 / issue #750), so `Map`,
`FlatMap`, `OrElse`, `OrCompute`, `OrThrow`, `IfPresent`, and
`Filter` each have two overloads with disjoint `where T : class` /
`where T : struct` constraints. The binder picks the right one
based on the receiver type. Prior to ADR-0088 the value-typed
overloads carried a `*Value` suffix as a workaround for the gap;
that suffix is gone.

### Surface — `Gsharp.Extensions.Sequences`

Static builders on `Sequences`:

```
func Range(start int32, count int32) sequence[int32]
func RangeStep(start int32, end int32, step int32) sequence[int32]
func Iterate[T](seed T, next (T) -> T) sequence[T]      // infinite
func Repeat[T](value T) sequence[T]                      // infinite
func Of[T](values ...T) sequence[T]
func Empty[T]() sequence[T]
```

Extension transformers on `sequence[T]`:

```
func [T] (self sequence[T]) Windowed(size int32) sequence[[]T]
func [T] (self sequence[T]) Chunked(size int32) sequence[[]T]
func [T] (self sequence[T]) Indexed() sequence[(int32, T)]
func [T] (self sequence[T]) Pairwise() sequence[(T, T)]
func [T] (self sequence[T]) Interleave(other sequence[T]) sequence[T]
```

Safe terminals:

```
func [T] (self sequence[T]) FirstOrNil() T?       // T : class | T : struct
func [T] (self sequence[T]) LastOrNil() T?        // T : class | T : struct
func [T] (self sequence[T]) SingleOrNil() T?      // T : class | T : struct
```

G#-shaped collectors:

```
func [T]       (self sequence[T])       ToSlice() []T
func [K, V]    (self sequence[(K, V)])  ToMap() map[K]V
func [T, K, V] (self sequence[T])       ToMap(keyFn (T) -> K, valueFn (T) -> V) map[K]V
```

### Performance — `AggressiveInlining`

Hot helpers are marked with
`[MethodImpl(MethodImplOptions.AggressiveInlining)]` so the JIT
inlines across the assembly boundary. The marked set, per the
issue brief:

- `Optional` (both `T : class` and `T : struct` variants):
  `Map`, `FlatMap`, `OrElse`, `OrCompute`, `IfPresent`, `Filter`.
- `Optional`: `OrThrow` is **not** marked — preserving the throw
  site in stack traces is more valuable than the inlining win.
- `Sequences`: `FirstOrNil` / `LastOrNil` / `SingleOrNil` plus the
  `*ValueOrNil` companions, `Indexed`, `Of`, `Empty`. Iterator-
  block methods (`Windowed`, `Chunked`, `Pairwise`, `Interleave`,
  `Range`, `RangeStep`, `Iterate`, `Repeat`) are **not** marked —
  their bodies expand to compiler-generated state machines that
  the JIT does not inline.

A reflection-based test
(`test/Extensions.Tests/AggressiveInliningTests.cs`) verifies that
the flag is emitted exactly on the methods listed above.

### Why no `Option<T>`?

G# already has structural nullable types (`T?`), the Elvis operator
(`?:`), null-safe member access (`?.`), the bang operator (`!!`),
smart casts (`if x is T y { ... }`), and the `nil` literal.
Introducing a wrapper `Option<T>` would compete with the existing
surface for no semantic gain and would force every user of the
Extensions layer to choose between two parallel representations of
absence. The Extensions helpers therefore operate directly on
`T?`, leaving the wrapper concept off the table.

### Why no `Result<T, E>` here?

The Extensions layer needs a story for error-channelled values
(network calls, parse failures, etc.) but `Result<T, E>` interacts
with the language's existing exception model, with `nil`, and with
async/iterator control flow in ways that warrant their own ADR.
We defer to a follow-up issue rather than ship a half-baked surface
here. Nothing in this ADR precludes adding `Gsharp.Extensions.Result`
later.

### Dogfooding goal

The strategic goal is to author every helper in G# itself. The
helpers in this ADR are authored in C# only because the language
parser and binder hit the gaps documented in "Known limitations"
below. Each gap is filed as its own Oats issue so the C# escape
hatch can be retired incrementally; when a helper can be expressed
in G# without regressing the public surface, it migrates.

## Known limitations / G# language gaps

The following gaps were discovered while authoring this ADR's
surface. Each one has been filed as a separate follow-up issue;
none is a blocker for shipping the helpers, because the C# escape
hatch under `src/Sdk/Gsharp.Extensions/*.cs` works today.

- **L1. Constraint-aware extension-method overload resolution.**
  ([issue #750](https://github.com/DavidObando/gsharp/issues/750))
  **Closed by ADR-0088.** The G# binder now reads each candidate's
  generic-parameter constraints (`where T : class`, `where T :
  struct`, `where T : new()`, base / interface bounds) and rejects
  candidates whose constraints are violated by the inferred type
  arguments. Surviving candidates are tie-broken by a specificity
  rule (`struct` > `class` > no constraint). This let the value-
  typed `Optional` and `Sequences` helpers collapse to the single-
  name surface listed above.
- **L2. Receiver clauses on generic / nullable receiver types.**
  ([issue #751](https://github.com/DavidObando/gsharp/issues/751))
  `LooksLikeReceiverClause()` in the parser only accepts an
  identifier or an `[N]T` / `[]T` receiver type. It rejects
  `(self T?)`, `(self sequence[T])`, and similar — which means
  every helper in this ADR has to be authored in C# (where the
  receiver shape is unconstrained). When the parser accepts these
  shapes, the helpers can migrate to native G# `.gs` sources.
- **L3. Native `?:` over nullable value types.**
  ([issue #752](https://github.com/DavidObando/gsharp/issues/752))
  The current
  emitter cannot lower the Elvis operator when the receiver is a
  nullable struct (`Nullable<T>`) — the `dup; brtrue` pattern it
  uses is invalid IL for boxed value-type stack slots. The
  `OrElse` / `OrCompute` helpers exist partly to give
  callers a safe surface today; `?:` over nullable value types is
  tracked separately.

When any of these gaps closes, the corresponding helpers should
migrate to native G# sources and the C# files under
`src/Sdk/Gsharp.Extensions/Optional/` and
`src/Sdk/Gsharp.Extensions/Sequences/` should be deleted as part
of that migration, not left behind as dead code.

## Consequences

- **Positive — uniform G# feel.** Samples that previously had to
  reach for `Enumerable.Range`, `FirstOrDefault`, or hand-rolled
  null-check chains now have a single Extensions surface that
  matches the rest of the language. The collectors (`ToSlice`,
  `ToMap`) project to G#'s native `[]T` and `map[K]V` instead of
  to BCL `T[]` and `Dictionary<K, V>`, removing a friction point
  in the tour and the standard-library reference.
- **Positive — dogfooding pressure.** Shipping a real assembly
  meant to be authored in G# creates direct compiler pressure to
  close L2 / L3 (L1 closed by ADR-0088). Each remaining gap is now
  a tracked issue with a concrete callsite waiting on its fix.
- **Positive — zero-friction adoption.** Because the assembly is
  bundled with the SDK and imports are explicit but trivial
  (`import Gsharp.Extensions.Optional`), the cost to a sample or
  user project is one line per namespace.
- **Neutral — single-name surface after ADR-0088.** Reference- and
  value-typed helpers now share one name set; the temporary
  duplication accepted in this ADR (the original L1 wart) is gone.
- **Neutral — assembly size.** The helpers are tiny (≈25 KB
  total) and AggressiveInlining is applied to the genuinely-hot
  paths only; no shipping-size regression is observable.

## Alternatives considered

1. **Ship `Option<T>` / `Result<T, E>` first.** Rejected: G# already
   has `T?` for the absence channel, and `Result` deserves its own
   ADR.
2. **Author everything in C# permanently.** Rejected: defeats the
   dogfooding goal. The C# files are escape hatches scoped to the
   open language gaps.
3. **Author everything in G# today and block on L1/L2/L3.** Rejected:
   would defer the public surface indefinitely. Issue #724 calls
   for a real surface in this PR; the language gaps are tracked
   separately.
4. **Auto-import `Gsharp.Extensions.Optional` whenever implicit
   imports are enabled.** Rejected: the Extensions layer is
   opinionated and we never want it leaking into projects that did
   not opt in.

## Migration

No migration required: this is an additive surface. Projects
adopt the namespaces by adding `import Gsharp.Extensions.Optional`
and/or `import Gsharp.Extensions.Sequences` to the relevant files.
