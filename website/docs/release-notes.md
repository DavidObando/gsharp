---
title: "Release notes"
draft: false
---

# Release notes

G# is pre-1.0. The repository's version base is currently `0.4`, and product versions are derived by Nerdbank.GitVersioning from that base and the Git commit. Until the project reaches a stable compatibility promise, release notes should be read as implementation status notes rather than a long-term compatibility contract.

## Unreleased (0.5 line)

### Breaking changes

- **`chan T` is respelled `chan[T]`** (ADR-0174 D2). The element type moves inside brackets like `sequence[T]` and `map[K, V]`; `in chan[T]` / `out chan[T]` are the receive-only / send-only handles (`ChannelReader<T>` / `ChannelWriter<T>`), `chan[T]?` is a nullable channel and `chan[T?]` a channel of nullable — the `(chan T)?` grouping carve-out is gone. The legacy spelling is rejected with `GS0567`, which names the exact replacement.
- **`make(chan T[, n])` is retired** in favour of `chan[T]()` (rendezvous — capacity 0, Go's unbuffered channel), `chan[T](n)`, and `Chan.Unbounded[T]()` (the wave-1 behavior of `make(chan T)`, now named). `GS0566` names the replacement per site; note the semantic change for the no-capacity form.
- **`close(ch)` is retired** in favour of the member `ch.Close()` (`GS0566`). Closing twice throws (Go's panic); `Dispose()` is the idempotent close, so `using let` works. `len(ch)` / `cap(ch)` become `ch.Length()` / `ch.Capacity` on a channel you constructed.
- **Receiving from a closed channel no longer raises and swallows `ChannelClosedException`** — the zero value is delivered directly (about 400× faster on that path).
- **`import Gsharp.Extensions.Go` is gone** (ADR-0174 D13): the concurrency syntax is the language, the namespace and its marker type are deleted, and the gate diagnostics `GS0316` / `GS0317` are retired. The concurrency library lives in the implicitly imported `Gsharp.Concurrency` namespace (`/noimplicitimports` disables it).
- **`len`, `cap`, `append`, and `delete` are retired** (ADR-0174 D13). A call reports `GS0566` naming the member replacement for that site: `xs.Length`, `m.Count`, `m.Remove(k)`, `ch.Length()` / `ch.Capacity`; `append` has no member spelling — a slice is a fixed CLR array, so keep a growable `List[T]` and `.Add`; `cap` on a slice is removed outright (its capacity was its length). A user-defined function of the same name is an ordinary call.

### Added

- **`await` is legal in a plain `func`, and colours it** (ADR-0174 D4's `await g()` row, issue #3954). Awaiting makes the awaiting function suspending, so colourless Go-style code can await an ordinary `Task`/`ValueTask` without becoming `async func`. Where inference may not change a signature — an entry point, an `open`/`override`/interface member, an accessor, a constructor, an operator, an iterator, a function literal, an `unsafe` or `fixed` body — `GS0574` asks for `async func` (an observable `Task[R]`) or `suspend func` (implicitly awaited, `R`). `GS0132` keeps only the case where no enclosing function exists.
- **An awaitable means in G# what it means in C#.** The compiler awaits for you only where the *syntax* is a channel operation — `ch <- v`, `<-ch`, `select`, channel `for..in` — never because a library method returns a task. `ReceiveBatch`/`SendBatch` are ordinary `ValueTask[int32]` calls: write `await ch.SendBatch(items)`, and `.AsTask()` on one names the task exactly as in C#.
- `Gsharp.Runtime.Channels`: a C#-authored channel runtime bundled with the SDK (`tools/channels/`) and auto-referenced by every project. `Chan<T>` is a rendezvous-capable `Channel<T>` subclass with Go-exact close semantics, a two-value receive, batch transfer, and the transactional `select` waiter protocol; `gsc` copies it beside an emitted program that references it.
- Directional channel types and the D2 operation matrix: foreign BCL channels, readers, and writers flow into `chan[T]` / `in chan[T]` / `out chan[T]` with no adapter.
- `GS0548` (advisory: `chan[T]()` is a rendezvous channel), `GS0549`/`GS0550` (send/receive through the wrong directional handle), `GS0554` (a channel-receive binding form with the wrong number of targets), `GS0555` (`while let v = ch` where a receive was meant).
- **`go { … }`** (ADR-0174 D14): the block form of `go` spawns the block as a goroutine, capturing the enclosing locals (per iteration for a `for … in` variable) — `go func() { … }()` without the ceremony.
- **`scope` is completed** (ADR-0174 D5/D6): every `go` inside a scope reports to the scope's frame (no `Task` per goroutine); the block binds an implicit `ctx` (`Gsharp.Concurrency.Context`) that the first goroutine failure cancels promptly; exit follows the documented precedence table (`ScopeException` with the cause first, a failing body rethrown unwrapped) and, inside a suspending function, is awaited rather than blocked. A nested scope's `ctx` is linked to the enclosing one (`ctx.Parent`), and `return` from inside a scope still counts as returning on every path. A free `go` outside any scope is fail-fast on an unhandled exception (`GoroutineRuntime.UnhandledGoroutineException` to observe).
- **A small concurrency library** (ADR-0174 D9): `after(d)` and `tick(d)` are selectable timers — `case <-after(d)` is the timeout arm, and a select receive arm now accepts anything selectable, not only a channel — and `merge(a, b, …)` fans several channels into one receive-only channel that closes when the last input does. They live in the implicitly imported `Gsharp.Concurrency` namespace and are called by bare name; a program that declares its own `after` keeps its own.
- **Batch channel operations and `chunks`** (ADR-0174 D10). A channel handle gains `TryReceiveBatch`/`TrySendBatch` (a `Span[T]`, never waits) and `ReceiveBatch`/`SendBatch` (a `Memory[T]`, can park, and returns a `ValueTask[int32]` you `await` like any other — issue #3954 — a destination that survives a park cannot be ref-like). `chunks(ch, n)` reads a channel in batches: `for batch in chunks(input, 1024)` is ordinary channel iteration where `batch` is a `ReadOnlyMemory[T]` that the receiver owns, so one lock acquisition and one park are amortized across the batch. A batch cut short by a close or a cancellation returns the count it moved rather than throwing, so a retry cannot duplicate elements. `GS0562` warns when the channel is a rendezvous, where batching is correct but pointless.
- **`async let`** (ADR-0174 D15): `async let name = expr` starts `expr` as a child of the enclosing `scope` and binds `name` to its eventual result, read as `await name`. Both children of two `async let` bindings run concurrently; the binding is a value of type `R`, never a handle, so a spawn cannot outlive the block that owns it. A binding you never read has its child cancelled and joined at block exit, and a failure nobody read still reaches the block's `ScopeException` rather than being dropped; a failing child does not cancel its siblings. New diagnostics: `GS0551` (no enclosing `scope`), `GS0559` (never awaited), `GS0569` (read without `await`).
- **Three more `select` arm shapes** (ADR-0174 D8). Every arm may carry a `when` guard, evaluated once when the select is entered; a false guard keeps its arm out of the select entirely, which is how G# spells Go's "set the channel to `nil` to disable this case". `case await task` and `case let v = await task` let a `Task` or `Task[T]` race the channels on the same waiter. `case cancelled` replaces Go's `case <-ctx.Done()`: the ambient context's cancellation becomes an arm instead of an unwind. New diagnostics: `GS0556` (a guard that is not a `bool`), `GS0557` (a `cancelled` arm with no context to observe, so it would be unreachable), and `GS0564` (one channel both sent to and received from by the same select). Cancellation also now reaches a `select` written in a callee with no `scope` of its own, through the caller's context.
- **`select` is rebuilt on one registered waiter** (ADR-0174 D8): arms are attempted in uniform-random order like Go's, so two ready arms are both chosen instead of the first one written always winning; a select with no ready arm registers on every arm at once and parks the state machine rather than blocking a thread on `Task.WhenAny`; and winning *is* the transfer, so a value can no longer be stolen between choosing an arm and running it. A `select` inside a cancelled `scope` unwinds.
- **Cancellation unwinds parked channel operations** (ADR-0174 D7): a receive, send, or channel loop inside a `scope` parks on that block's `ctx`, so the first goroutine failure collapses siblings that are waiting on a channel instead of leaving them parked. An operation that already committed keeps its value — cancellation wins only before the transfer. Hosts can retune the budgets and observe the diagnostics through `Gsharp.Concurrency.GsharpRuntime` (`DeferGraceBudget`, `ScopeStallTimeout`, `DeferGraceExpired`, `ScopeStalled`). Cancellation crosses calls: a suspending function receives the caller's context as a trailing optional parameter, so an operation inside a callee unwinds with the caller's scope. Declaring `ctx Context` in a signature uses that parameter instead, and a C# consumer calls the signature as written or passes a `Context` explicitly.
- **`defer` cleanup is shielded** (ADR-0174 D7): a deferred body runs under a cancellation-immune context, so cleanup that drains a channel or signals completion still runs while the block around it unwinds. A grace budget bounds it (`GSHARP_DEFER_GRACE_MS`, five seconds by default) so cleanup cannot hold cancellation up forever; `GsharpRuntime.DeferGraceExpired` reports an abandoned one. Cleanup outside any scope costs nothing.
- **Suspension is inferred** (ADR-0174 D4): a plain `func` that performs a channel operation, or calls a function that suspends, is compiled as a suspending function — a `ValueTask[R]` state machine labelled `[Suspending]` — with no keyword, as a fixed point over the call graph. Go-shaped pipelines keep their shape and stop holding threads. Inference stops at `async func`, `open`/`override`/abstract methods, interface members and their implementations, constructors, accessors, operators, P/Invoke, iterators, `Dispose`, and function literals; a call to a suspending function from one of those blocks through the runtime's root bridge and warns with `GS0558`. Every emitted G# method that suspends now returns `ValueTask`/`ValueTask[R]` instead of `R` — a binary change for C# callers of such functions.
- **`suspend func`** (ADR-0174 D4, the declared form): a suspending function compiles to a `ValueTask[R]`-returning state machine on the pooling builder, carries `[Suspending]`, and is awaited implicitly by every G# call site — callers write `let v = take(ch)` and see `R`; an explicit `await take(ch)` is accepted as the same thing. From a function that is neither suspending nor `async` the call blocks the thread and `GS0558` warns; the entry point is the silent root. Inference of suspension for plain `func` follows in a later step of Phase 3.
- **Debugging through suspension** (ADR-0174 P3-8): every async or suspending kickoff carries `[AsyncStateMachine]` and `[DebuggerStepThrough]`, so `Environment.StackTrace` and debuggers name the logical function instead of `<f>d__1.MoveNext`, and the Portable PDB carries the async-method-stepping blob (yield/resume offsets per await) that lets a debugger step over a parked channel receive onto the next source line. **Fixed:** bodies rewritten by the compiler — every `async func` body, and now every suspending one — carried no line information at all, so breakpoints inside them never bound; each source line of such a body now maps into the state machine.
- **Channel operations inside an `async func` suspend instead of blocking** (ADR-0174 D4, first step): a receive, two-value receive, send, `for v in ch`, or `while let v = <-ch` in an `async func` (or async lambda / `async sequence`) parks the state machine, not a thread — hundreds of parked receives no longer pin thread-pool threads. A channel operation inside a `lock` body keeps the blocking lowering (the monitor is thread-affine).
- **Observable completion** (ADR-0174 D3): the two-value receive `let (v, ok) = <-ch` (or `v, ok = <-ch`) distinguishes a delivered zero value from a closed channel; `while let v = <-ch { … }` and `for v in ch { … }` loop until the channel is closed. A `chan[T?]` element that is `nil` is delivered, not mistaken for close.

## 0.4

The fourth pre-1.0 line focuses on **sound defaults, expressive control flow, and faithful CLR interop**. Collection zero values are now usable without hidden nulls, pattern matching works directly in boolean and loop conditions, rectangular CLR arrays have native syntax, and explicit extension receivers preserve extension semantics for owned types and enums. Tooling adds synchronized-map support, clearer REPL display, and `dotnet watch` hot reload.

### Highlights

- **Sound collection zero values.** Initializer-less maps, slices, fixed arrays, rectangular arrays, and sequences receive usable empty instances, including collection fields nested through structs. Channels remain explicit: globals and fields require `make(chan T)`, while locals use definite-assignment analysis and nullable channels use `(chan T)?`.
- **Richer conditions and blocks.** Boolean `is` accepts the full pattern grammar, including constant, type, property, relational, list, and composed patterns. `while let` introduces a narrowed, body-scoped binding that is re-evaluated before each iteration. General block expressions can contain declarations and statements before their trailing value.
- **Native rectangular arrays.** `[,]T`, `[,,]T`, and higher ranks preserve CLR type identity. `[rows, columns]T` allocates storage, flat initializers use row-major order, and `a[i, j]` supports reads, writes, compound assignment, address-taking, null-conditional access, iteration, and interop.
- **Cleaner extension declarations.** `func extension (receiver T) Name()` explicitly declares an extension for an owned type or enum without turning it into an instance member.
- **Migration fidelity.** `cs2gs` now emits native block expressions, rectangular arrays, multi-target storage assignment, `if let` / `while let` bindings, native `is` pattern variables, explicit extensions, and value-position assignments instead of synthetic spill-heavy rewrites.

### Added

- Full patterns in `value is pattern` and `value !is pattern`, with type-plus-property composition and narrowed right-hand `and` patterns.
- Pattern variables in boolean `is` (ADR-0166): `value is string text && text.Length > 3`, `value is { Length: > 0 } text`, `box is { Value: Dog d }`, `values is [1, ..rest]`, and the guard idiom `if !(value is string text) { return }` followed by uses of `text`. Variables are scoped to the regions where the match is known to have happened; `Type name` designations are also accepted in `switch` arms. `cs2gs` preserves C# `is` pattern syntax and names for these shapes instead of hoisting `__spillN` temporaries.
- `while let name = nullableExpression { ... }`, including multiple bindings and normal labeled `break` / `continue` behavior.
- General value-producing block expressions such as `{ let x = compute(); x + 1 }`.
- Native rectangular array types, allocation, initialization, indexing, iteration, nullable forms, metadata, and expression-tree support.
- Explicit extension receiver clauses through `func extension`.
- Map iteration through `for key, value in map` or `for entry in map`.
- `Gsharp.Extensions.Sync.SyncMap[K,V]` for goroutine-safe shared maps with atomic `Update`.
- Structural display of plain user values in the REPL while preserving their emitted CLR `ToString` behavior.
- `dotnet watch` hot reload for SDK projects.

### Changed

- The `as` operator now has nullable result type `T?`; use `if let`, keep the nullable value, or apply `!!` when a prior check guarantees success.
- The deprecated `name = value` named-argument spelling is removed. Use `name: value`; `=` in an argument is an ordinary assignment expression.
- Multi-target assignment accepts all writable storage forms, including fields, properties, indexed elements, nested members, and pointer dereferences.
- Nil comparison is available for every reference-backed built-in type. Comparisons against bare non-null collection types are diagnosed as statically constant.
- Legacy `print`, `input`, and `rnd` built-ins and the `string(T)` conversion are removed; use CLR APIs and explicit formatting/conversion methods.
- The website specification, guides, tutorials, feature matrix, diagnostics catalogue, bridges, and tooling pages now describe the complete 0.4 surface without implementation-tracker references outside the design-decision index.
- The Docusaurus site cuts a new `0.4` snapshot from the live docs. The version dropdown lists `0.4`, `0.3`, and `Next`.

### Fixed

- Generic delegate, enclosing-generic, function-pointer, method-group, map, imported override, XML documentation, channel capture, boxing, and tuple-return emission now preserve the source type and storage semantics across compilation boundaries.
- Null-conditional delegate invocation, nullable-flow analysis, rejected-call diagnostics, interpolation spans, and source-migration output are aligned with the emitted behavior.

### Known limitations

- A non-empty rectangular-array initializer requires constant non-negative dimensions and a flat row-major element list.
- Pattern variables introduced by a boolean `is` pattern (`value is string text`, ADR-0166) are read-only and are in scope only where their match is known to have happened; C# forms that rely on full definite-assignment data flow (for example a variable read after a `while` whose exit depends on the pattern) report `GS0532`.

## 0.3

The third pre-1.0 line is a **breadth-and-interop** release. The language gains a large batch of C#-parity expression and declaration constructs, an `unsafe` pointer surface, `partial` types, and anonymous-object literals. Tooling adds the `cs2gs` C#→G# migration tool and the `gsgen` Roslyn source-generator host for native G# projects. The language server gains incremental binding, an incremental semantic-model pipeline, and a cross-session cold-start cache. This release also cuts a fresh `0.3` docs snapshot from the live docs and retires the `0.2` snapshot.

### Highlights

- **Unsafe pointer surface.** An `unsafe` context now supports unmanaged raw pointers `*T`, `stackalloc [n]T` producing either safe `Span[T]` or unsafe `*T` storage, the `fixed` pinning statement, the `unmanaged` type-parameter constraint, `sizeof(T)`, and pointer compound-assignment and cast lowering.
- **New expression and statement forms.** Throw expressions, value-producing increment and decrement expressions `++` / `--`, from-end indexes `^n`, standalone `System.Range` values such as `1..3`, expression-bodied members via `->`, general `goto` / labels, collection initializers `List[T]{…}` / `HashSet[T]{…}` / `Dictionary[K,V]{…}`, and inferred-type arrow lambdas with statement-block bodies.
- **New declaration forms.** `partial` classes, structs, and interfaces; anonymous-object literals `object { … }`; nested type declarations; user-defined conversion operators `operator implicit` / `operator explicit`; user indexer members `prop this[i int32] T { get; set }`; the `shared { init { … } }` static-initializer block; static imports through `import Ns.Type`; and top-level `private` mapping to IL `assembly` / internal.
- **`cs2gs` C#→G# migration.** The new translator lowers C# source to canonical G#, with construct coverage, gap triage, and a build-time strategy that reproduces generated code rather than freezing it. See the new [cs2gs tooling page](./tooling/cs2gs.md).
- **Source generators for native G#.** The `gsgen` host runs Roslyn analyzers and generators against native G# projects. `gsc /analyzer:<asm>` spawns `gsgen` as a sibling before compiling. A shared resx codebehind generator emits `Resources.Designer.gs`.
- **Language-server performance.** Incremental binding, instance-keyed semantic-model memoization, a cross-session cold-start cache, completion-as-you-type triggering, and unified member resolution reduce repeated work across binder and LSP flows.
- **Diagnostics catalogue extended.** v0.3 adds diagnostics through the `GS04xx` range. The [Diagnostics reference](./ref/diagnostics.md) is reconciled against the compiler source and lists the current per-ID cause and fix detail.

### Added

- **Null-coalescing operator respelled `??`.** The null-coalescing operator is `a ?? b`. The earlier `?:` spelling is retired in that role; `cond ? a : b` remains the ternary expression.
- **Runtime array allocation `[n]T`.** A length-bearing `[n]T` allocates a zero-initialised array at runtime, complementing array literals.
- **Nullable array-element spelling.** `[]T?` is an array of nullable elements; `[]?T` is a nullable array.
- **Nullable function-type spelling.** Nullable function types are spelled and displayed with the appropriate parenthesisation.
- **Expression-tree lambda conversions.** A lambda converts to `Expression[TDelegate]` where the target demands an expression tree.
- **Delegate return-type covariance.** Delegate return types can be covariant, including lambda target-typing on CLR method calls.
- **Predefined type aliases as static-member receivers.** Friendly numeric aliases can be used as receivers for static member access.
- **Assembly-attribute parity with C#.** Assembly-level attributes are accepted with C#-equivalent behavior.
- **Collection spreads.** Array, slice, and CLR collection initializers accept `...source`, preserving lexical evaluation order and applying ordinary element conversions.
- **Safe structural projections.** Compatible public object shapes project into safely constructible concrete targets; `Target{ ...source, Member: override }` provides explicit object-spread mapping.
- **Explicit interface qualifier clauses.** Methods, properties, indexers, events, and static interface members can use `(IFace)` to provide distinct implementations without source-visible mangled names.
- **User-defined compound-assignment operators.** Classes and structs can declare in-place `operator +=` and related one-operand, void-returning instance operators.

### Changed

- **C#-compatible numeric conversions.** Numeric literal narrowing and widening, plus implicit numeric promotion at call sites, now align with C# behavior.
- **Unannotated imported reference types are nullable by default.** Imported reference types without nullable annotations bind as nullable.
- **`char` bitwise and shift operators promote to `int32`.** Enum `==` / `!=` comparisons against the integer literal `0` are also permitted.
- The website spec, feature matrix, diagnostics reference, CLR-interop reference, guides, tour, tutorials, and tooling docs were refreshed to match compiler ground truth for the 0.3 surface; a new `cs2gs` tooling page was added.
- The Docusaurus site cuts a new `0.3` snapshot from the live docs and retires the `0.2` snapshot. The version dropdown lists `0.3` and `Next`.

### Fixed

- Extensive `cs2gs` translator hardening across nullability promotion, extension-call lowering, deconstruction and indexer targets, pattern binding, named-argument lowering, and source-generator-shaped constructs.
- Numerous `gsc` binder, emitter, and interpreter correctness fixes across imported generic interface methods, nullable value-tuple boxing, `data class` equality and `with`, overload resolution, async lambda inference, and smart-cast narrowing.

### Known limitations

- `gsc --help` advertises `/implicitimports[+|-]`; the `+` / `-` suffix form is not currently accepted by the Release parser. Use `/noimplicitimports`.
- Migration coverage in `cs2gs` is still expanding. C# source generators are reproduced at build time rather than translated, and some constructs remain on the gap-triage backlog.

## 0.2

The second pre-1.0 line is a syntax-and-ergonomics release. The parser, binder, and emitter absorb substantial additions; several legacy Go-flavored spellings are retired in favour of canonical G# forms; and the native-interop and default-interface-method surfaces ship end-to-end. This release also formally introduces docs versioning: the `0.1` snapshot is removed and a fresh `0.2` snapshot is cut from the live docs.

### Highlights

- **New language surface.** `while` / `do…while` loops with labeled `break` / `continue`; `if let` / `guard let` / `while let` smart-cast bindings; null-coalescing compound assignment `??=`; null-conditional indexing `a?[i]`; arrow lambdas `x => body`; canonical `(T1, T2) -> R` function-type clauses; lambda binding-type inference; Kotlin/Swift-style type-declaration grammar; if-as-expression completion; smart-cast extensions; discriminated-union enum payloads; `default(T)` and target-typed bare `default`; variadic `...T` parameters in function and anonymous function-type clauses; `class` / `struct` / `init()` constraint flag spellings; default-interface methods; reified generics; `Gsharp.Extensions.Optional` and `Gsharp.Extensions.Sequences`; friendly numeric type aliases; and the canonical map type clause `map[K,V]`.
- **Removals and migrations.** Legacy spellings now produce focused, span-accurate diagnostics with canonical replacements so IDE quick-fixes can patch most migrations in one edit.
  - `type` keyword for type declarations (`type Foo struct { … }` → `struct Foo { … }`).
  - `record` keyword, replaced by `data class` or `data struct`.
  - `:=` short variable declaration, replaced by `let` / `var`, with diagnostic `GS0305`.
  - `name = value` named-argument separator, replaced by `name: value`, with diagnostic `GS0315`.
  - `func(T) R` legacy function-type clause, replaced by `(T) -> R`, with diagnostic `GS0303`.
  - Go-flavored `map[K]V` type clause, replaced by `map[K,V]`, with diagnostic `GS0366`.
  - `static func` on interface methods is removed. Static-virtual interface members now live inside the interface `shared { … }` block. A body-less `func` inside that block is an abstract static-virtual slot; a `func` with a body is the default. Static private helpers also move into the `shared { … }` block as `private func`, while instance private helpers stay directly in the interface body. The old `static func …` shape now produces a parser error, and `GS0330` fires when a non-`func` member appears inside an interface `shared { … }` block.
- **Body-less `func` now requires `;`.** A `func` declaration without a `{ … }` block is terminated by the universal no-body marker `;`. This already held for P/Invoke (`func getpid() int32;`) and now also applies to abstract interface methods and abstract static-virtual slots inside an interface `shared { … }` block. A body-less interface `func` missing its `;` reports `GS0368`; a `func` carrying a body still takes no `;`.
- **Native interop end-to-end.** P/Invoke via `@DllImport`, source-generator-shaped `@LibraryImport`, struct and class marshalling, `ref` / `out` / `in` parameter marshalling, function-pointer marshalling, and `@MarshalAs` parameter overrides are supported.
- **Go-flavored concurrency moved behind an opt-in import.** `go`, `chan`, `select`, channel send and receive, `make(chan T)`, and the built-ins `len`, `cap`, `append`, `make`, and `delete` now require `import Gsharp.Extensions.Go`. Diagnostics `GS0316` / `GS0317` point at the missing import.
- **Tooling polish.** LSP completion understands async-shaped types such as `async (T) -> R` and `async sequence[T]`; `textDocument/codeAction` offers nil-related quick fixes; and `null` now produces a `nil` "did you mean" diagnostic `GS0273`.
- **Diagnostics catalogue extended.** v0.2 introduces `GS0273` and `GS0288`–`GS0366`. The [Diagnostics reference](./ref/diagnostics.md) has the per-ID cause and fix detail.

### Added

- **Friendly numeric type aliases.** `int`, `uint`, `long`, `ulong`, `short`, `ushort`, `byte`, `sbyte`, `float`, and `double` are accepted everywhere a type name is accepted, as a strict superset on top of the canonical width-bearing names (`int32`, `uint32`, …). The alias resolves to the canonical `TypeSymbol` at the binder, so diagnostics, `typeof`, `nameof`, hover, and emitted IL always print the canonical spelling. Canonical names remain preferred in documentation and public library APIs; aliases are appropriate inside function bodies and local code. Aliases are reserved type names, so `type int = string` and equivalents are rejected with `GS0102`.
- **Null-conditional indexing `a?[i]`.** `a?[i]` evaluates receiver `a` exactly once. If it is `nil`, the whole expression yields `nil`; otherwise the result is the indexed value lifted to the nullable form of the indexer's return type. It works on arrays, slices, maps, and CLR indexers on both emit and interpreter paths. Chained forms (`h?.Data?[i]?.c`) short-circuit on the first nil. The new token `?[` is recognized only when `[` immediately follows `?`, preserving `cond ? [arr] : [arr]` ternary parses. Diagnostics `GS0300` and `GS0301` cover non-nullable receivers and assignment left-hand sides.
- **Documentation comments.** Markdown-authored `///` documentation comments round-trip losslessly to CLR XML doc. Hover renders merged documentation for both G# declarations and imported CLR APIs. New warnings include `GS0227`, `GS0228`, `GS0229`, `GS0230`, and `GS0231`.
- **Named delegate types.** `delegate Name(...) ` declares a real CLR `MulticastDelegate`-derived type so C# consumers see a conventional handler type and G# events can carry first-class custom delegate types. Diagnostics `GS0233`–`GS0234` cover invalid forms.;
- **`ref` / `out` / `in` parameters.** Declaration-site and call-site ref-kind modifiers are supported, including inline `out var` / `out let` / `out _` declarations. Diagnostics `GS0235`–`GS0243` cover the rules. Passing a value to an `in` parameter without writing `in` at the call site is warning `GS0242` rather than a silent spill.
- **Ref-aliasing locals.** `let ref m = arr[i]` and `var ref v = c.Field` produce locals whose IL slots are `T&` and alias another lvalue. Diagnostics `GS0256`–`GS0258` cover invalid aliases.
- **Ref returns.** `func f(...) ref T { return ref <expr> }` is supported. Diagnostics `GS0248`–`GS0255` cover escape rules, async and iterator bans, and override matching.
- **Conditional ref-arguments.** The narrow `ref cond ? a : b` form is supported inside ref-kind argument payloads. Diagnostics `GS0260`–`GS0262` cover invalid forms.
- **Generalized ternary expression.** `cond ? a : b` is now a normal expression. `GS0259` is retired in value contexts; `GS0263` covers "no common type" failures.
- **Method overloading and optional parameters.** User G# functions can carry overload sets that differ by parameter types or ref-kinds, and optional parameters can use compile-time-constant defaults. Diagnostics `GS0264`–`GS0267` cover invalid overloads and defaults.
- **Named arguments at call sites.** `Foo(timeout: 30, retries: 3)` works for free functions, user methods, user constructors, extension functions, inherited CLR methods, and delegate `Invoke`. Diagnostics `GS0244`–`GS0247` cover invalid usage. The legacy `name = value` form is deprecated this release with diagnostic `GS0315`; migrate `.copy(...)` and attribute argument lists alongside ordinary call sites.
- **`scoped` parameter modifier.** `scoped` constrains a `ref struct` or managed-pointer parameter from escaping, enforced by `GS9004` / `GS9006`.
- **`data struct` synthesis completed.** Every `data struct` synthesizes `Equals(object)`, `Equals(T)`, `GetHashCode()`, `ToString()`, `op_Equality`, `op_Inequality`, and `Deconstruct(...)`. Hand-written versions are rejected with `GS0232`.
- **Editor features.** Hover for CLR XML docs, live pull-based diagnostics, CodeLens reference counts on members of structs, interfaces, and enums, implicit `this` for properties, methods, and events, hover for `this`, bare static-member access from instance methods, chained-member hover, and six VS Code color themes inspired by the G# logo: Ember, Magma, and Synthwave in dark and light variants.
- **`:=` short variable declaration removed.** Every binding site now requires `let` for immutable bindings or `var` for mutable bindings. The lexer still recognizes `:=` so the parser can emit `GS0305` with context-sensitive migration suggestions such as `x := 1` → `let x = 1`, `for i := 0 ... 10` → `for i in 0 ... 10`, and `case v := <-ch` → `case let v = <-ch`.

### Changed

- The website spec, feature matrix, FAQ, bridges page, guide pages, and design-decisions index were refreshed to match compiler ground truth. Outdated statements such as "Parameters do not have default-value syntax" and "Named arguments — Partial" were rewritten.
- The repo `docs/lexical.md` block-comment paragraph is corrected, and a documentation-comments subsection was added.
- The VS Code TextMate grammar adds contextual keywords (`data`, `inline`, `record`, `delegate`, `event`, `prop`, `init`, `shared`, `scoped`, accessor names `get` / `set` / `add` / `remove` / `raise`, and ref-kinds `ref` / `out`), operators (`:=`, `?.`, `??`, `?` / `:`, `!!`, `...`, `=>`), an `@Annotation` scope, and a `///` documentation-comment scope with `@tag` highlighting. The VS Code snippet set was rewritten to match current grammar.
- The Docusaurus site cuts a new `0.2` snapshot from the live docs and retires the `0.1` snapshot. The version dropdown lists `0.2` and `Next`; the `0.1` URL space is no longer served.

### Fixed

- Numerous IL-emit, determinism, language-server, and editor hardening rounds improve CLR verification, byte-for-byte reproducibility, property access, CodeLens accuracy, and stale-tree handling.

### Known limitations

- Full ref-safe-to-escape analysis is partial; `GS0257` is reserved for a future pass.
- Unsupported async state-machine emit shapes continue to report `GS0190`.

## 0.1

The `0.1` version base identifies the first pre-1.0 line. This is not a dated stable release announcement; it summarizes the major capabilities implemented in the repository at that point.

### Language and libraries

- Packages, imports, import aliases, top-level declarations, and multi-file or multi-package compilation.
- Width-bearing primitive names such as `int32`, `uint64`, `float32`, and `float64`, plus `bool`, `char`, `string`, `object`, `decimal`, `nint`, `nuint`, and `void`.
- Nullable `T?` types with `nil`, `?.`, `??`, and `!!`.
- Structs, classes, interfaces, enums, `data struct`, `record` as a `data struct` alias, and `inline struct` value wrappers.
- Generic functions and types with square-bracket type parameters and arguments, constraints, method inference, and CLR variance support where applicable.
- Fixed arrays, slices, maps, tuples, function values, delegates, `sequence[T]`, `async sequence[T]`, and iterator `yield` support.
- Control flow including `if`, `for`, `for in` or `range` forms, switches, switch expressions, `try`, `catch`, `finally`, `throw`, `using`, and `defer`.
- Go-shaped concurrency with `go`, `scope`, channels, channel send and receive, `make(chan T)`, `close`, and `select`.
- `async func`, `await`, async lambdas, awaitable-shape support, and `await for` over async sequences.
- CLR interop for imported constructors, methods, overload resolution, fields, properties, indexers, events, delegates, extension methods, optional CLR arguments, operators, conversions, attributes, and generic types.

### Tooling

- `gsc` compiler driver with immediate execution when no `/out:` is supplied and saved managed executables or libraries with `/out:`.
- Managed PE and metadata emission without Roslyn, optional reference assemblies, target-framework-aware reference resolution, runtime configuration output, and Portable PDB support.
- MSBuild SDK support through `Gsharp.NET.Sdk`, `.gsproj` projects, `dotnet build`, `dotnet run`, templates, and SDK-side response-file invocation.
- VS Code extension and language server support for diagnostics, hover, definitions, references, symbols, formatting, completions, signature help, rename, code actions, CodeLens, semantic tokens, inlay hints, and debugging integration.
- Stable diagnostic IDs in the `GS####` form, with warning suppression and warning-as-error controls.

### Pre-1.0 notes

- The language is still evolving; source compatibility may change before a stable release.
- Some surfaces are intentionally documented as current implementation behavior rather than final specification guarantees.
- The Playground page exists, but browser-hosted execution is deferred.

## Future release-note format

Use reverse chronological order. Each version entry should identify the version and, when a real release process exists, its date. Do not invent dates or version numbers; derive versions from the repository's release process. Write for end users: describe what changed, what it means, and any migration steps they should take.

```md
## X.Y.Z

Short summary of the release.

### Added

- New language, tooling, documentation, or interop capabilities users can try.

### Changed

- Behavior changes, breaking changes, renamed features, or migration notes.

### Fixed

- Short grouped quality notes for user-visible correctness, diagnostics, emit, interpreter, or tooling improvements.

### Known limitations

- Important limitations users should know before upgrading.
```
