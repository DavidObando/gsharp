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
  `Gsharp.Extensions.proj`. The dogfooding goal (see "Known
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
func [K, V]    (self sequence[(K, V)])  ToMap() map[K,V]
func [T, K, V] (self sequence[T])       ToMap(keyFn (T) -> K, valueFn (T) -> V) map[K,V]
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

G# already has structural nullable types (`T?`), the null-coalescing operator
(`??`, originally `?:` — see ADR-0116), null-safe member access (`?.`), the bang operator (`!!`),
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
  **Parser-side closed.** `LooksLikeReceiverClause()` previously
  only accepted an identifier or an `[N]T` / `[]T` receiver type;
  the scanner now reads any balanced bracket region as the
  candidate type clause, so `(self T?)`, `(self sequence[T])`,
  `(self map[K,V])`, `(self (int32, string)?)`, and arbitrary
  combinations are recognised by the parser and the function
  retains its extension-method status. The binder + emit pipeline
  also accept call-site dispatch when the receiver is *closed*
  (concrete) — `string?`, `(int32, string)`, `[]int32?`,
  `map[string,int32]`. **Binder-side closed by
  [issue #773](https://github.com/DavidObando/gsharp/issues/773).**
  `BoundScope.TryLookupExtensionFunction` now falls back to
  receiver-type unification when the fast-path exact-equality
  match fails, so a call site like `arr.MyFirst(99)` resolves to
  `func (self IEnumerable[T]) MyFirst[T any](fb T) T` by inferring
  `T = int32` from the call-site receiver type. `InferTypeArguments`
  / `SubstituteType` were extended with cases for
  `SequenceTypeSymbol` and `AsyncSequenceTypeSymbol`, and the
  metadata emitter now encodes an open `sequence[T]` /
  `async sequence[T]` parameter slot as
  `GENERICINST<IEnumerable\`1><MVar>` /
  `GENERICINST<IAsyncEnumerable\`1><MVar>` so the produced IL
  passes verification end-to-end. The remaining gap blocking the
  full dogfooded port —
  [issue #775](https://github.com/DavidObando/gsharp/issues/775)
  (G# spelling for `class` / `struct` / `init()` constraints) — is
  **closed by ADR-0097**. The new bracket-position flag spelling
  (`[T class]`, `[T struct]`, `[T init()]`, plus combinations like
  `[T class init()]`) maps directly to the matching
  `GenericParameterAttributes` flag bits at emit time, and the
  binder's `BoundScope.TryLookupExtensionFunction` now filters
  same-name unifiable extensions by constraint and prefers the
  most specific surviving candidate (`struct > class > none`) so
  the canonical `Map[T class]` / `Map[T struct]` overload pair
  dispatches correctly without renaming.
  [issue #774](https://github.com/DavidObando/gsharp/issues/774)
  (open-receiver iteration erases element type to `object`) is
  **closed** — the binder now maps an open `IEnumerable[T]` /
  `sequence[T]` / `Dictionary[K, V]` receiver to a symbolic
  enumerator whose `Current` returns `T` (or the symbolic
  `KeyValuePair[K, V]`), the lowerer threads those symbolic
  element types through the `for v in self` reduction, and the
  reflection-metadata emitter encodes the enumerator's `MoveNext`
  / `Dispose` against their non-generic declaring interfaces while
  keeping `get_Current` / `get_Key` / `get_Value` substituted with
  the symbolic generic arguments so the produced IL verifies.
  A separate, smaller emit gap surfaced while writing the
  IL-verified emit tests for #773: an extension with an
  unconstrained `(self T?)` receiver type compiles cleanly *only*
  when the body avoids comparing `self` to `nil` or unwrapping
  with `!!`, because the type-erased emit cannot statically choose
  between the reference-typed `T` and value-typed `Nullable<T>`
  shapes. The binder + interpreter accept the full surface; the
  emit-side body-lowering fix lives with the open-receiver
  workstream — once the dogfooded port lands it will need both an
  explicit `[T class]` overload (no-op for `Nullable<T>`) and an
  explicit `[T struct]` overload (HasValue-aware lowering), at
  which point each path is statically chosen and the emit fix
  becomes mechanical.
- **L3. Native `??` over nullable value types.**
  ([issue #752](https://github.com/DavidObando/gsharp/issues/752))
  **Closed.** Issue #519 introduced the HasValue-based lowering
  for value-type `Nullable<T>` LHS in the `??` emit path; issue
  #752 finished the job by switching the non-null branch's unwrap
  from `Nullable<T>::get_Value()` to the cheaper
  `GetValueOrDefault()` (no boxing, no callvirt, no redundant
  throw path) and by giving the coalesce its own scratch slot
  separate from the receiver-spill slot so `(v ?? 0).ToString()`
  emits verifiable IL. The `Optional` and `Sequences` samples
  now use `??` directly on `int32?` receivers; the `OrElse` /
  `OrCompute` helpers remain available for deferred / computed
  fallbacks but are no longer the only safe surface.

When any of these gaps closes, the corresponding helpers should
migrate to native G# sources and the C# files under
`src/Sdk/Gsharp.Extensions/Optional/` and
`src/Sdk/Gsharp.Extensions/Sequences/` should be deleted as part
of that migration, not left behind as dead code.

- **L5. SDK ↔ Extensions bootstrap cycle.**
  ([issue #792](https://github.com/DavidObando/gsharp/issues/792))
  **Build-system side closed.**
  The bootstrap was the *last* infrastructure prerequisite for
  authoring `Gsharp.Extensions` in G#: `Gsharp.NET.Sdk` ships
  `Gsharp.Extensions.dll` inside its NuGet (`tools/extensions/`) and
  auto-references it from every consumer `.gsproj`, so a G#-authored
  `Gsharp.Extensions.gsproj` would self-reference at build time. The
  new `src/Sdk/Gsharp.NET.Sdk.Bootstrap/` ships a single `.targets`
  file that is *equivalent* to the consumer SDK in every respect
  (same `BuildTask`, same `CoreCompile` shape, same `gsc.dll`
  invocation) except that it deliberately *omits* the
  `Gsharp.Extensions.dll` auto-reference — and resolves `gsc.dll` +
  the BuildTask DLL from in-tree `out/bin/$(Configuration)/...` so it
  needs no packed stage-0 NuGet. A `.gsproj` for `Gsharp.Extensions`
  can therefore consume the bootstrap without participating in the
  cycle.
  In parallel, the reflection metadata emitter
  (`ReflectionMetadataEmitter.cs`) now stamps
  `[System.Runtime.CompilerServices.ExtensionAttribute]` on every
  G#-authored extension method's MethodDef *and* on the `<Program>`
  TypeDef that hosts it, so C# / F# call-site lookup (ECMA-334
  §13.6.9) sees `.Map(...)` / `.FlatMap(...)` / etc. as proper
  extension methods. Without that emit, the existing C# test surface
  (`test/Extensions.Tests/*.cs`) would not bind against a G#-built
  `Gsharp.Extensions.dll`.
  **Source-port side: deferred.** While porting `Optional.gs` and
  `Sequences.gs` it became clear that the public API surface still
  hits several smaller, previously undocumented G# language gaps —
  ~~generic-method type-parameter threading through generic
  instance-method calls (`List[T]().ToArray()` returns `object[]`
  inside a generic shared method)~~ (closed by issue #794), ~~no
  `default(T)` expression~~ (closed by issue #795 / ADR-0100), no
  `params` parameter declaration, ~~no `==` between `(T) -> T` /
  `sequence[T]` values and `nil`~~ (closed by issue #796), ~~no
  `[MethodImpl(...)]` annotation parsing inside `shared { }` blocks~~
  (closed by issue #797),
  ~~no `yield` inside a shared-static method that returns
  `IEnumerable[T]`~~ (closed by issue #798 — binder + CFG side).
  Each is filed as a focused follow-up. The C#
  escape hatch under `src/Sdk/Gsharp.Extensions/Optional/` and
  `src/Sdk/Gsharp.Extensions/Sequences/` remains in place; the
  Extensions test suite (107 tests) continues to run against it
  unchanged. Once those follow-ups close the actual G# port becomes
  mechanical — the bootstrap + `[Extension]` emit make it a flag
  flip rather than an infrastructure project.

  Issue #794 specifically closed the first follow-up bullet: when a
  receiver carries symbolic type arguments (`ImportedTypeSymbol`
  with `OpenDefinition` + `TypeArguments`, the #313 / #671
  shape), every instance call and property read on that receiver
  now reprojects through the open declaring type's signature so the
  result symbol carries the in-scope `T` / `K` / `V` rather than the
  type-erased `object`. `List[T]().ToArray()` is `[]T`,
  `Dictionary[K, V]().Keys` is `ICollection[K]`, and
  `List[T]().Add(v)` binds when `v` is typed `T` (the binder
  treats type-parameter args as `object` for overload resolution
  against an erased receiver). The fix lives at the binder layer
  only — no `BoundNodeKind` was added, and emit/IL-verify run
  green end-to-end through the existing #765 / R5 reified-generics
  path.

  Issue #796 closed the fourth follow-up bullet: the binder's
  `IsNullCompare` arm (in `BoundBinaryOperator.cs`) previously
  accepted `== nil` / `!= nil` only when the non-null side was a
  `NullableTypeSymbol` (`T?` wrapper). Function-typed
  (`(T) -> R` / legacy `func(T) U` / `DelegateTypeSymbol`) and
  sequence-typed (`sequence[T]` / `asyncSequence[T]`) values are
  managed references at the CLR layer but have no `T?` spelling in
  the language, so the guard rejected the only legal way to spell
  "is this delegate / iterable nil?". The arm now accepts
  `FunctionTypeSymbol`, `DelegateTypeSymbol`,
  `SequenceTypeSymbol`, and `AsyncSequenceTypeSymbol` on the
  non-null side; emit falls through to the generic `ldnull; ceq`
  shape (verifier-clean for any managed reference). No new
  `BoundNodeKind` was introduced; the change is a single predicate
  extension.

  Issue #797 closed the fifth follow-up bullet: the shared-block
  member loop in `Parser.ParseSharedBlock` did not call
  `ParseAnnotations()`, so a leading `@MethodImpl(...)` on a
  shared-static method was reinterpreted as the start of a field
  declaration and rejected. The fix mirrors the instance-member
  surface in `ParseAggregateDeclaration`: each iteration now parses
  any leading `@Foo` lead-ins (ADR-0047 §3) and forwards the
  collected list via `.WithAnnotations(memberAnnotations)` onto the
  resulting field / method / property / event syntax node. The
  binder side already consumed `syntax.Annotations` on every shared
  member (see `DeclarationBinder` shared-block paths), so the bound
  symbols now carry the annotation and the emitter writes the
  expected `CustomAttribute` rows on the MethodDef / FieldDef /
  PropertyDef. Unlocks the `Sequences.Range` / `Optional.Map` port
  hot-path marking with `[MethodImpl(AggressiveInlining)]`.

  Issue #798 closed the sixth follow-up bullet (binder side): a
  `yield` statement inside a generic iterator — including a
  shared-static method that returns `IEnumerable[T]` / `sequence[T]`
  / `IAsyncEnumerable[T]` / `async sequence[T]` — surfaced as
  `GS0136 Function 'yield' doesn't exist` (when reached through
  the compile path) or `GS9998 Unexpected statement: YieldStatement`
  (when reached through the gsc no-output / interpreter path via
  `ControlFlowGraph.Create`). Root cause was two-fold and not
  actually shared-static-specific: (a) `StatementBinder.GetIteratorElementType`
  read only `function.Type.ClrType`, which is type-erased to
  `IEnumerable<object>` for an `ImportedTypeSymbol` constructed
  over an in-scope `T` (#313), so `yield v` (where `v: T`) failed
  with `GS0155 Cannot convert type 'T' to 'object'`; (b)
  `ControlFlowGraph.GraphBuilder.Build`'s second statement switch
  did not list `BoundNodeKind.YieldStatement` in its fall-through
  arm, causing the GS9998 crash. The fix honors
  `ImportedTypeSymbol.TypeArguments[0]` for the IEnumerable /
  IEnumerator / IAsyncEnumerable / IAsyncEnumerator open
  definitions, mirrors the open-T handling for
  `AsyncSequenceTypeSymbol` (whose `ClrType` is null for open T)
  across `Binder.IsIteratorReturnType` /
  `IsAsyncIteratorReturnType` / `IsAsyncSequenceReturnType`,
  `StatementBinder.GetIteratorElementType`, and both the sync and
  async iterator rewriters' `IsAsyncIteratorFunction` /
  `GetAsyncIteratorElementType` predicates, and adds
  `BoundNodeKind.YieldStatement` to the CFG fall-through.
  Shared-static iterators that yield concrete (non-generic-method)
  values now bind, lower, emit verifier-clean IL, and execute
  through the interpreter.

  Issue #810 closed the seventh and final §L5 follow-up bullet
  (emit side): fully open-generic iterators
  (`func Empty[T any]() IEnumerable[T] { for v in []T{} { yield v } }`)
  bound correctly after #798 but the synthesized state-machine class
  was not generic, so its hoisted-field signatures referenced the
  outer method's MVar slots from inside a class context where no
  MVars exist. The state-machine class is now reified over a
  matching set of class-level type parameters mirroring the outer
  method's (`<Empty>d__1`1<T>`, the same shape Roslyn emits), and
  an emit-time outer-method-TP → class-TP remap on the
  reflection emitter rewrites every field-signature and method-body
  TP encoding inside SM-member emit boundaries to land on the
  class's `Var(idx)` instead of the outer method's `MVar(idx)`.
  The kickoff body constructs the SM through
  `StructSymbol.Construct(smClass, [methodTPs])` so the `newobj`
  token names `<Empty>d__1`1<MVar(0)>`. `IEnumerable` /
  `IEnumerator` interface implementations on the SM are encoded as
  TypeSpecs over the element type so `IEnumerable`1<!0>` flows
  through the remap correctly. The structural-unification engine
  used to build MethodSpec rows for generic-method calls now
  unifies `sequence[T]` / `async sequence[T]` / `T?` return shapes
  so calls like `Sequences.Empty[int32]()` (no parameters mention
  T) infer correctly from the return type alone. End-to-end
  verifier-clean emit for `Empty[T]`, `Of[T]`, `Range[T]`,
  `Iterate[T]`, `Repeat[T]` across both `IEnumerable[T]` and
  `sequence[T]` returns is now covered by
  `test/Compiler.Tests/Emit/Issue810OpenGenericIteratorEmitTests.cs`.
  The G#-source port of `Gsharp.Extensions.Sequences` itself
  remains deferred: the public API surface still requires `params`
  parameters on shared-class methods (variadic is currently
  top-level-only per ADR-0101 / GS0146), ~~`(K, V)` value-tuple
  return shapes on extension methods (`Indexed` / `Pairwise`)~~
  (closed by issue #813), and ~~`T?` overload disambiguation for
  the `*OrNil` reference-vs-value splits~~ (closed by issue #814)
  — neither of the latter two were in scope for #810. The C# escape
  hatch under `src/Sdk/Gsharp.Extensions/Sequences/` stays in
  place for the remaining `params` follow-up; the emit fix unblocks
  anyone who wants to author non-variadic, non-tuple G# iterators
  in their own projects today.

  Issue #813 closes the value-tuple return-shape gap left by #810.
  Iterators whose element type is a tuple — `func Indexed[T]()
  sequence[(int32, T)] { yield (idx, v) }` and
  `func Pairwise[T]() sequence[(T, T)]` — now bind, emit
  verifier-clean IL, and execute. The root cause was that
  `TupleTypeSymbol` (the symbol backing
  `System.ValueTuple<…>` for G# tuple literals) was absent from
  every "contains a type parameter?" predicate the iterator emit
  path consults: `TypeSymbol.ContainsTypeParameter` (the master
  helper used by `ImportedTypeSymbol.HasTypeParameterArgument` to
  decide whether a generic instantiation needs reified-generic
  routing), the state-machine rewriter's
  `ContainsOuterMethodTypeParameter`, and the method-body planner's
  interface-implementation row predicate. Without these cases an
  `IEnumerable[(int32, T)]` return type was type-erased to
  `IEnumerable<object>` at emit time even though the binder had
  computed the correct element-type signature. The fix also
  threads `TupleTypeSymbol` through `Binder.SubstituteType` (so
  closing `T = int32` replaces the inner element-type slot), the
  `IsValueTypeSymbol` / `GetElementTypeToken` emit helpers (the
  latter delegating to the pre-existing `GetTupleTypeSpec`), the
  structural unifier for method-spec rows (so an actual
  `System.ValueTuple<int, int>` argument matches a formal
  `(int32, T)` parameter), the parser's `yield (...)` lookahead
  (a `yield (a, b)` tuple literal previously failed
  `LooksLikeYieldExpression` and fell back to call-expression
  parsing), and the conversion classifier (a fully closed
  `IEnumerable[(int32, string)]` return type resolves to the
  imported CLR `ValueTuple<,>` instantiation, so the assignability
  check between a tuple literal's `TupleTypeSymbol` and the
  recovered imported type now succeeds as identity when the
  closed CLR backings agree). Coverage:
  `test/Core.Tests/CodeAnalysis/Binding/Issue813TupleSequenceReturnBindingTests.cs`
  for the binder (six tests across 2/3-arity, nested tuple, and
  `sequence` / `IEnumerable` return shapes),
  `test/Compiler.Tests/Emit/Issue813TupleSequenceReturnEmitTests.cs`
  for the IL-verified end-to-end path (eight tests closing
  `T = int32` and `T = string` on both `sequence` and `IEnumerable`
  return shapes), and
  `test/Interpreter.Tests/Issue813TupleSequenceReturnInterpreterTests.cs`
  for tree-walking parity at the closed instantiation.

  Issue #814 closes the third remaining §L5 bullet: same-name
  overload pairs that are distinguished *only* by `[T class]` vs
  `[T struct]` constraints (the exact shape required by
  `Sequences.FirstOrNil` / `LastOrNil` / `SingleOrNil`) now bind,
  emit verifier-clean IL, and execute through both the compiler and
  the interpreter. ADR-0088 (#750) added the constraint-aware
  filter for *imported* methods and ADR-0097 (#775) gave G# the
  syntactic spelling, but the emit side encoded `T?` as bare
  `!!T` (so even with `T : class` the `ldnull` → `T` shape was
  rejected by ilverify, and with `T : struct` the `Nullable<T>`
  semantics were lost outright). The fix encodes
  `NullableTypeSymbol(TypeParameterSymbol)` as
  `GENERICINST Nullable<MVAR/VAR>` whenever the underlying TP
  carries `HasValueTypeConstraint` (driving both `EncodeTypeSymbol`
  and `GetElementTypeToken` to land on a `Nullable<!!T>` TypeSpec),
  threads the `nil` → `Nullable<TP>` literal conversion through the
  same `BoundDefaultExpression` lowering used for closed
  nullables (so `EmitDefault` materialises a `ldloca; initobj`
  pair instead of the unverifiable `ldnull`), and synthesises a
  TypeSpec-parented `Nullable<!!T>::.ctor(!0)` MemberRef (cached
  per open TP) so the value-type lift of a concrete `T` value into
  `T?` resolves correctly under instantiation. The interpreter side
  re-routes `MethodInfo.Invoke` / `PropertyInfo.GetValue` whenever
  the literal declaring type is unassignable from the receiver's
  runtime type — the lowered `for v in self` loop carries the
  symbolic `IEnumerable<object>::GetEnumerator` MethodInfo, but
  `int[]` does not implement `IEnumerable<object>` (CLR array
  covariance is reference-only), so the new
  `ResolveMethodForReceiver` / `ResolvePropertyOrFieldForReceiver`
  helpers walk the receiver's generic interface map to find the
  matching closed `IEnumerable<int>` / `IEnumerator<int>` member.
  Coverage:
  `test/Core.Tests/CodeAnalysis/Binding/Issue814OrNilOverloadTests.cs`
  for the binder + interpreter (eight tests covering both `class`
  and `struct` resolution across all three `*OrNil` helpers,
  diagnostic for unconstrained call sites, and end-to-end
  tree-walking execution), and
  `test/Compiler.Tests/Emit/Issue814OrNilOverloadEmitTests.cs`
  for the IL-verified emit path (eight tests, all `IlVerifier.Verify`
  clean).

  Issue #806 closes §L5 end-to-end (source side): `Gsharp.Extensions`
  ships in idiomatic G#. `Optional.gs`, `Sequences.gs`, and
  `SequenceExtensions.gs` replace the C# escape hatches under
  `src/Sdk/Gsharp.Extensions/Optional/` and
  `src/Sdk/Gsharp.Extensions/Sequences/`; `Gsharp.Extensions.proj`
  now consumes the `Gsharp.NET.Sdk.Bootstrap` build-time SDK landed
  by #792, so the same `gsc.dll` + `BuildTask` invocation that any
  user `.gsproj` exercises now compiles the stdlib itself. The
  emitter required four targeted fixes to make dogfooding viable:
  (1) `<Program>` host TypeDefs are emitted as `sealed abstract`
  (the C# "static class" shape) so C# extension-method discovery
  (`MemberLookup.IsStaticClass`) finds them when a consumer writes
  `import Gsharp.Extensions.Sequences`; (2) `MethodImpl` pseudo-attributes
  (`@MethodImpl(MethodImplOptions.AggressiveInlining)`) now OR into
  the MethodDef `ImplFlags` field instead of being silently dropped,
  preserving the hot-path inlining intent the C# baseline relied on;
  (3) `IsCoreLibBaseType` was extended to route the open-generic
  collection interfaces (`IEnumerable`, `IEnumerator`,
  `IEnumerable<T>`, `IEnumerator<T>`, `IAsyncEnumerable<T>`,
  `IAsyncEnumerator<T>`, `IDisposable`) plus `Nullable<T>` and
  `ValueTuple<…>` through `System.Runtime` instead of the host's
  `System.Private.CoreLib`, so cross-context type refs in iterator
  SMs and `T?` MemberRefs resolve under the BuildTask
  `MetadataLoadContext`; (4) `StateMachineEmitter` now packages each
  iterator state machine under its declaring function's package
  (`plan.Function.Package?.Name ?? hostPackage?.Name`) rather than
  the host's `<Program>`, so a multi-namespace assembly like
  `Gsharp.Extensions` (which hosts Optional, Sequences, and Go
  side-by-side) emits each SM under the right `<Program>` parent
  and runtime metadata lookup (`MethodAccessException`) stops crossing
  package boundaries. Open Nullable-over-TP member binding gained a
  dedicated branch in `ExpressionBinder.Access` so the struct-receiver
  overloads of the `*OrNil` helpers — which use `self.HasValue` /
  `self.Value` on a `Nullable<T>` where T is an open value-type-
  constrained TP — bind without falling through the closed-Nullable
  ClrType path. The `IteratorRewriter.GetIteratorElementType`
  fast-path now compares `OpenDefinition` by `FullName` instead of
  CLR reference identity (the `typeof()` pattern fails across
  `MetadataLoadContext`), so open-generic iterator-return-type
  recovery works on the BuildTask side too. End-to-end coverage:
  all 104 tests in `test/Extensions.Tests/` run against the G# port
  unchanged; `test/Compiler.Tests/SampleConformanceTests` exercises
  `samples/GsharpExtensionsMixed.gs` / `GsharpExtensionsOptional.gs`
  / `GsharpExtensionsSequences.gs` end-to-end through the same
  `gsc.dll` invocation real users see. Residual gaps (filed as
  separate Oats follow-ups) — open-T `== nil` lowering for
  reference-class TPs in `Optional.Map` / `FlatMap` (`ldnull` vs
  `T` ilverify mismatch), open-T `Queue<T>.Dequeue()` discard
  spuriously inserting `unbox.any !T`, and
  `Enumerable.Empty[T]()` returning `Object[]` for open T (now
  **closed by #833** — open-T generic-method calls preserve the
  symbolic return type; `Empty[T]` in `Sequences.gs` has been
  restored to the inlined `return Enumerable.Empty[T]()` shape) —
  were routed around in the G# source (use `List[T]` over
  `Queue[T]`, retain the `class`/`struct` constraint split that
  maps each helper to the right lowering, suppress the
  consumer-side `CS8602` with a pragma — **the `CS8602` pragma is
  now closed by #834**, which makes the reflection metadata
  emitter stamp `[NullableAttribute]` /
  `[NullableContextAttribute]` for `T?` reference parameters and
  returns so C# consumers with `nullable enable` see the
  annotation directly) so the runtime behaviour matches the C#
  baseline; ilverify is dirty on those remaining methods only.
  The bootstrap is no longer hypothetical: it builds the stdlib
  it ships.

## Consequences

- **Positive — uniform G# feel.** Samples that previously had to
  reach for `Enumerable.Range`, `FirstOrDefault`, or hand-rolled
  null-check chains now have a single Extensions surface that
  matches the rest of the language. The collectors (`ToSlice`,
  `ToMap`) project to G#'s native `[]T` and `map[K,V]` instead of
  to BCL `T[]` and `Dictionary<K, V>`, removing a friction point
  in the tour and the standard-library reference.
- **Positive — dogfooding pressure.** Shipping a real assembly
  meant to be authored in G# creates direct compiler pressure to
  close the open language gaps. Each gap is tracked with a
  concrete callsite waiting on its fix. **All four originally
  documented language gaps are closed**: L1 closed by ADR-0088, L3
  closed by issue #752, L2's parser side closed in the PR for
  #751, L2's binder side closed by #773, the open-receiver
  iteration emit gap closed by #774, and the G# spelling for
  `class` / `struct` / `init()` constraints closed by ADR-0097
  (#775). **The SDK ↔ Extensions bootstrap cycle (L5) is now
  broken and exercised end-to-end by issue #806**:
  `src/Sdk/Gsharp.NET.Sdk.Bootstrap/` ships a build-time-only mirror
  of the consumer SDK that compiles `.gs` sources against the in-tree
  `gsc.dll` + BuildTask *without* the `Gsharp.Extensions.dll`
  auto-reference, and the reflection metadata emitter now stamps
  `[System.Runtime.CompilerServices.ExtensionAttribute]` on every
  G#-authored extension method's MethodDef and on its containing
  (now `sealed abstract`) `<Program>` TypeDef so the existing C#
  test surface against `Gsharp.Extensions.dll` binds against the
  G#-built replacement. The actual source-side port of `Optional`
  and `Sequences` is in (`src/Sdk/Gsharp.Extensions/Optional/Optional.gs`,
  `Sequences/Sequences.gs`, `Sequences/SequenceExtensions.gs`); the
  C# escape hatch is removed; the 104 `test/Extensions.Tests/` tests
  run against the G#-emitted stdlib unchanged.
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
