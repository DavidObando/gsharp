# ADR-0212: A semantic-query surface for the language server, and the home of server-only code

- **Status**: Proposed
- **Date**: 2026-10-24
- **Phase**: Compiler architecture (study roadmap item M10; design only, the
  implementation is the slice list of section 12, tracked under #5139)
- **Issue**: [#5139](https://github.com/DavidObando/gsharp/issues/5139)
- **Related**: [#2189](https://github.com/DavidObando/gsharp/issues/2189);
  [#5140](https://github.com/DavidObando/gsharp/issues/5140) (B1, the
  `BindingServices`/`BodyBinder` split, which owns the binder side);
  [#5134](https://github.com/DavidObando/gsharp/issues/5134) (M5,
  resolver-owned caches and language-server resolver disposal);
  [#5145](https://github.com/DavidObando/gsharp/issues/5145) (B5, resolver
  reuse across worker requests);
  [ADR-0105](0105-incremental-delta-binding-language-server.md) (the body
  cache and the body-only edit reuse),
  [ADR-0107](0107-cross-session-cold-start-cache-language-server.md) (the
  persisted type-name index),
  [ADR-0156](0156-gsi-emit-to-memory-execution.md) (REPL submissions),
  [ADR-0169](0169-gsharp-analyzer-framework.md) (`SemanticModel` and the
  analyzer framework),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md) and
  [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md)
  (nullability rules),
  [ADR-0154](0154-test-oracle-strength.md) (mutation evidence),
  [ADR-0203](0203-measured-compiler-throughput-and-bounded-parallelism.md)
  (worker-local binder state),
  [ADR-0208](0208-narrowing-as-flow-state-with-a-query.md) (narrowing as a
  query),
  [ADR-0209](0209-handle-backed-imported-symbols.md) (handle-backed imported
  symbols; its stage 6 names the language-server files this ADR migrates),
  [the compiler architecture and performance study](../compiler-architecture-and-performance-study.md)
  (section 5 "Where the batch path carries language-server and REPL weight",
  section 10 decision 6).

Line numbers in this document refer to `b038be414` unless stated.

## Context

### 1. The premise, corrected

Decision 6 of the study says the server-specific APIs in Core "exist because
member access is internal or private, so the server reached in". The
inventory behind this ADR finds that the reach-in is mostly not a visibility
problem. By [ADR-0006](0006-visibility.md) a G# top-level declaration is
public unless marked otherwise, so `Binder`, `BoundScope`, `BoundGlobalScope`,
`BoundProgram`, every `Bound*` node, `BoundBodyCache`,
`IncrementalGlobalScopeReuse`, `TypeMemberModel` and `ClrTypeUtilities` are
public at the CLR level and sit in the public-API snapshot
(`test/Core.Tests/Baselines/gsharp-core-public-api.txt`). The
`InternalsVisibleTo` grant to `GSharp.LanguageServer` (`src/Core/Core.gsproj:19`)
unlocks thirteen members in eleven groups (section 2, table 2c). `test/LanguageServer.Tests`
has no grant and still compiles against `BoundProgram`, `GetBoundNode` and
about fifteen `Bound*Expression` types.

The problem is therefore the shape of the surface, not its accessibility: the
server consumes implementation types (the bound tree, the global scope's raw
collections, the binder's static entry points, reflection `MemberInfo`s) and
re-implements binder logic over them (section 2, table 2d), and Core carries
the incremental-binding and submission machinery as public mutable state on
`Compilation` and as parameters threaded through `Binder` (section 3). The
work is to define the questions the server may ask, answer them inside Core
once, and move or hide what remains.

### 2. What the server asks, and how it asks today

**2a. Features and the semantic question each one needs.** Folding, selection
ranges, workspace symbols, test discovery and the type-clause snippets are
syntax-only and are not listed. "Model" is the server's own
`SemanticLookup.SemanticModel` (`src/LanguageServer/SemanticLookup.gs:99-1216`),
a parallel semantic model whose name collides with Core's.

| Feature | Semantic question | Answered today |
| --- | --- | --- |
| Hover | symbol at a token; its display string and documentation | `HoverComputer.ComputeHover` `:35-79` through `SemanticLookup.ResolveSymbol` `:1307` (the model, then `BoundSemantics.GetSymbol` `BoundSemantics.gs:41`, then syntactic fallbacks); member fallback `TryResolveGSharpMember` `:390-442` with `TypeMemberModel.LookupMember` |
| Hover (imported member) | the CLR member a token bound to | `BuildImportedClrModel` `:156-254`: `BoundSemantics.GetImportedMember` `:62` (a reflection `MemberInfo`), else `SemanticLookup.TryResolveInvokedImportedMethod` `:1345` (a whole-program scan by name and arity, a heuristic by its own comment), else `ResolveImportedClrType` `:1493` plus reflection |
| Hover (object initializer) | receiver type of an initializer member | `InferInitializerReceiverType` `:365` calls `Binder.TryInferExpressionType` (`Binder.gs:9230`), a speculative bind with a context the server rebuilds (`GetExpressionBindingContext` `:1460`) |
| Hover (overloads) | member group of a name | `CountOverloads` `:887-906` over `TypeMemberModel.GetMethods` and reflection |
| Completion (member access) | members of the receiver's type at a position | `TryComputeMemberCompletions` `:2013-2117`: `BoundSemantics.GetExpressionType` `:86`, else `TryInferExpressionType`; members from `TypeMemberModel.EnumerateMembers` and reflection (`:2330-2378`) |
| Completion (initializer) | settable members of the constructed type | `TryComputeObjectInitializerCompletions` `:1793-1848` (speculative bind) |
| Completion (names) | names visible at a position | `ComputeCompletions` `:1635-1747` lists every `GlobalScope` function, variable, struct and alias plus the enclosing function's syntactic parameters, keywords and four hard-coded primitives; no position-aware scope |
| Signature help | the member group of the callee | `ComputeSignatureHelp` `:1578-1627` scans text backwards for `(` and `,`, then `ResolveSymbol` on the callee token; one signature, no overload resolution |
| Definition | declaring syntax of the symbol at a token | `ComputeDefinitions` `:1236-1294`; fields and variables matched by name (`:1405-1446`), which ignores shadowing |
| Definition (other assembly) | source of an imported type or member | `ImportedClrMemberResolver` (361 lines, mirrors hover's reflection walk), `CrossAssemblyDefinitionResolver` (sibling project `GlobalScope` scans `:377-607`, PDB, then source-text search `:209-318`) |
| Type definition | declared or narrowed type of the expression at a position | `LspServer.ComputeTypeDefinition` `:1521-1560` through `BoundSemantics.GetExpressionType` |
| References, highlight, rename, linked editing, code lens | every reference to a symbol in the project | `SemanticLookup.FindReferences` `:1518` builds a reverse index by resolving every identifier token through the model (`SemanticModel.GetReferences` `:397-477`) |
| Diagnostics | parse, declaration, body, documentation and analyzer diagnostics of one file | `DocumentSyncHandler.BuildResult` `:103-210` assembles `syntaxTree.Diagnostics`, `GlobalScope.Diagnostics`, `BoundProgram.Diagnostics` through `Compilation.ApplySourceSuppressions`, `DocumentationValidator.Validate`, `GSharpAnalyzerDriver.Run` |
| Semantic tokens | symbol kind of every identifier | `SemanticTokensComputer.ClassifyIdentifier` `:361-391` through `ResolveSymbol` per identifier |
| Code actions | binding diagnostics in a range; whether a nullable fix applies | `CodeActionComputer.AppendNullabilityQuickFixes` `:97-131`; `NullabilityQuickFixes.TryGetNullableConversionTypes` `:244-306` parses the diagnostic message text to recover the types |
| Inlay hints | inferred type of a `let`; parameter names of a call | `InlayHintComputer` `:51-121` through `ResolveSymbol` |
| Implementation | structs implementing an interface | `LspServer.ComputeImplementation` `:1488-1519` scans `GlobalScope.Structs` |
| Cold start | the reference set's type-name index without a build | `ColdStartCache` with `ReferenceMetadataIndex` (`Symbols/ReferenceMetadataIndex.gs`) and `ReferenceResolver.ExportMetadataIndex`/`TryUseMetadataIndex` (`ReferenceResolver.gs:829-890`) |
| REPL completion and hover | the same questions in-process | `src/Repl/Engine/AnalysisBridge.gs` calls `CompletionComputer` and `HoverComputer`; `src/Repl/Repl.gsproj:43` references the server |

**2b. What the server consumes from Core, by tier.** Five files import
`GSharp.Core.CodeAnalysis.Binding`: `BoundSemantics.gs`, `SemanticLookup.gs`,
`HoverComputer.gs`, `ProjectState.gs`, `DocumentSyncHandler.gs`.
`SemanticModel.GetSymbolInfo` and `GetTypeInfo` are never called by the
server; `Compilation.GetSemanticModel` has one call site
(`BoundSemantics.gs:139`); `GetBoundNode` is called at four sites, never with
a cancellation token.

| Tier | Members | Where |
| --- | --- | --- |
| A. Intended public API | `Compilation(references, trees)`, `.SyntaxTrees`, `.References`, `.GetSemanticModel`, `.ApplySourceSuppressions`; `SemanticModel.GetDeclaredSymbol`, `.GetBoundNode`; `SyntaxTree`, `SourceText`, `SyntaxFacts`; the `Symbol` hierarchy, `.Declaration`, `.DeclaringSyntaxNodes`, `.GetDocumentation()`; `SymbolDisplay`; `AssemblyDocumentationProvider`; `GSharpAnalyzerDriver` | everywhere |
| B. Implementation types that are public by default | `Compilation.GlobalScope` (`.Functions`, `.Structs`, `.Interfaces`, `.Enums`, `.Delegates`, `.Variables`, `.TypeAliases`, `.Packages`, `.GetCumulativeImports()`, `.Diagnostics`); `Compilation.BoundProgram` (`.Functions`, `.Statement`, `.Structs`, `.Diagnostics`); about 25 `Bound*` node types; `Binder.TryInferExpressionType`; `BoundBodyCache`, `IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit`, `Compilation.BodyCache`/`.ReusedGlobalScope`/`.DirtyBodyTrees`; `ReferenceResolver.TryResolveType`/`.TryGetAssemblyPath`/`.ExportMetadataIndex`/`.TryUseMetadataIndex`; `ReferenceMetadataIndex`; `TypeMemberModel` (`LookupMember`, `GetMethods`, `EnumerateMembers`, `TryGetPropertyWithOwner`, ...); `ClrTypeUtilities.SafeGet*`; `Symbol.ClrType` (38 reads, ADR-0209 §1) | `SemanticLookup`, `HoverComputer`, `BoundSemantics`, `ProjectState`, `ColdStartCache`, `CrossAssemblyDefinitionResolver`, `ImportedClrMemberResolver`, `DocumentSyncHandler`, `CodeActionComputer`, `LspServer` |
| C. `internal` members (need the grant) | table 2c | `BoundSemantics`, `SemanticLookup` |

**2c. The `internal` members behind the grant** (thirteen members in eleven
rows; the `StaticQualifier*` row holds three).

| Member | Server site | Purpose |
| --- | --- | --- |
| `AssignmentTargetSyntaxFacts.UnwrapParentheses` (`Syntax/`) | `BoundSemantics.gs:338, 724, 782` | match parenthesized syntax to bound nodes |
| `SemanticModel.TryGetStaticTypeQualifier` (`SemanticModel.gs:180`) | `:367` | read the binder's static type-receiver decision for an `a.B` prefix |
| `BoundExpression.ImplicitConversionOperand` (`BoundExpression.gs:24`) | `:777` | recognise a binder-inserted conversion |
| `BoundExpression.LogicalCompletionOperand` (`:46`) | `:741` | unwrap to the underlying read |
| `BoundExpression.StaticQualifierType`/`StaticQualifierSyntax`/`StaticMemberSyntax` (`:163-173`) | `:393-397, 461-465` | prove a folded static read belongs to its qualifier |
| `BoundExpression.StaticConstantFieldRead` (`:178`) | `:391, 803, 840` | the field behind a constant-folded literal |
| `BoundExpression.StaticConstraintOwner` (`:183`) | `:519` | owner of a constrained static call |
| `BoundExpression.StaticEnumMember` (`:188`) | `:401, 802, 839` | the enum member behind a folded literal |
| `PropertySymbol.WithSignature` (`PropertySymbol.gs:225`) | `:836, 861` | a property at a constructed generic type |
| `TypeMemberModel.PropertyForBackingField` (`TypeMemberModel.gs:29`) | `:856` | backing-field read to its property |
| `TypeSymbol.GetWrappedTypes` (`TypeSymbol.gs:1407`) | `SemanticLookup.gs:2006` | walk a type clause beside its wrapper types |

Every one of these is a question about what a bound node *means*, asked by
the server because `GetSymbolInfo` does not answer it: `GetSymbolInfo`
returns the first `Symbol`-valued property of the outermost bound node and
unwraps same-syntax children (`SemanticModel.gs:129-162`), so a folded
constant, a static qualifier or a backing-field read comes back as nothing or
as the wrong symbol, and the server re-derives the answer from the node.

**2d. Binder logic re-implemented in the server.** `SemanticLookup.SemanticModel`
builds a declaration-token map by iterating `GlobalScope` and matching
members by name (`BuildModelUncached` `:1716-1938`); resolves implicit `this`
(`:479-555`) and member access from syntax (`:569-690`); reconstructs
`if let`/`while let`/for-range regions and shadowing (`:730-1040`); maps type
clauses to type symbols by walking both structures in parallel
(`MapTypeClauseReference` `:1995`); pairs bound locals with identifier tokens
through a reflection walk of the bound tree (`MapLocalVariables` `:2029`,
`FindBoundNodes` `:2488-2511`, `GetType().GetProperties()`); emulates import,
alias and implicit-`System` resolution (`GetCandidateTypeNames` `:1667`);
rebuilds the enclosing function and in-scope locals for a speculative bind
(`:1460-1482`). `BoundSemantics.gs:171-865` walks receiver chains from the
binder's anchor node, peels conversions and nil-unwraps, maps `?.` captures,
recognises slice plans by the synthetic local name `$$slice_src` (`:650-671`)
and proves static-member ownership (`:356-491`). `HoverComputer` and
`ImportedClrMemberResolver` resolve CLR receiver chains by reflection
(`:707-827`, whole file). None of this builds a `BoundScope` or calls
`MemberLookup`; all of it is interpretation of the bound tree that belongs
beside the binder that produced it.

### 3. What Core carries for the server and the REPL

| Piece | Lines | Consumer | Hook into the batch path |
| --- | ---: | --- | --- |
| `Binding/BoundBodyCache.gs`, `BoundBodyCacheKey.gs` | 253 | server (`ProjectState.gs:40, 242, 265, 318`) | `Compilation.BodyCache` (`Compilation.gs:217`) to `Binder.BindProgram(…, cache, dirtyTrees, …)` (`Binder.gs:7815`); `cache` and `dirtyTrees` are parameters on six `Bind*Body` methods and about 25 call sites (`:7910-8400, 8746-9089`); `BindBodyWithCache` (`:8618-8652`) returns early when `cache == nil`, so `gsc` never runs the cacheability walk but still builds the two closures per body |
| `Binding/IncrementalGlobalScopeReuse.gs` | 635 | server (`ProjectState.gs:420`) | `Compilation.ReusedGlobalScope` and `.DirtyBodyTrees` (`:238, 247`); `GlobalScope` returns the reused scope unless `HasNativeProtocols` (`:299-307`); nine `internal RepointDeclaration` methods on `FunctionSymbol`, `ConstructorSymbol`, `DeinitSymbol`, `PropertySymbol`, `EventSymbol`, `StructSymbol`, `InterfaceSymbol`, `FieldSymbol`, `ImportSymbol` exist only for it |
| `Binder.TryInferExpressionType` | 60 | server (`HoverComputer.gs:376, 1832, 2056`) | public static; builds a parent scope and a `Binder(parentScope, containingFunction)`, declares caller-supplied locals, binds and swallows every exception (`:9230-9276`) |
| Submission binding | about 990 | REPL (`src/Repl/Engine/EmittedSessionEngine.gs:283-292`) and the test oracle (`test/Shared/EmittedOracle.gs:148-151`, used by about 415 Core.Tests and 49 Interpreter.Tests files) | `Compilation.Submission` (`:280`) to `BindGlobalScopeCore` (`Binder.gs:6696-7597`: replayed imports, default package, trailing-value capture into `<Result>$$`, entry-point choice, 280 lines with the helpers `:7601-7755`); name resolution `:6182-6201`; `BoundScope.SubmissionImports` nil checks on four lookups (`BoundScope.gs:556, 606, 689, 769`); `ExpressionBinder.Assignments.gs:4883-5563` (about 495 lines: writes to prior-cell globals); `ExpressionBinder.Access.Accessor.gs:3309-3385`; `OverloadResolver.CallBinding.gs:521-535, 1421-1452, 3025-3080`; `BoundClrPropertyAccessExpression.IsReadOnlySubmissionGlobal` read by lowering and emit (`Emit/MethodBodyEmitter.MemberAccess.gs:1526-1894`) |
| `Binding/SubmissionImports.gs` (`SubmissionImports`, `SubmissionReference`, `SubmissionBindingOptions`) | 364 | REPL, test oracle | constructed by the consumer, read by the binding above |
| `Binding/SubmissionGlobalTypeProjection.gs` | 149 | REPL | `internal`; called from the submission write paths |
| `previous` chaining | about 80 | nobody | `BoundGlobalScope.Previous` (`BoundGlobalScope.gs:243`), the first parameter of its five constructors and of all six `Binder.BindGlobalScope` overloads; `GetCumulativeImports` (`:507-528`); `CreateParentScope` stack walk (`Binder.gs:11294-11343`); three `.Previous` loops in body binding (`:7933-7963, 8774-8780, 8833-8839`). No production or test caller passes a non-nil `previous`; `IncrementalGlobalScopeReuse` refuses chained scopes (`:97`); the REPL chains through emitted metadata, not through `Previous` |
| `Execution/InteractiveSessionHost.gs` (`InteractiveSessionHost`, `SubmissionRunResult`) | 219 | REPL only (`EmittedSessionEngine.gs:42-350`) | none; imports only `System.*` |
| `Symbols/ReferenceMetadataIndex.gs` and the resolver hooks | 311 + 80 | server (`ColdStartCache.gs`, `ProjectState.gs:530-551`) | `ReferenceResolver.warmNameIndex` (`:104-112`), `ExportMetadataIndex`/`TryUseMetadataIndex` (`:829-890`) |
| `Compilation` properties | about 45 | server, REPL | `BodyCache`, `ReusedGlobalScope`, `DirtyBodyTrees`, `Submission`, all public get/set, default `nil` |

Seven standalone files hold 1,931 lines; the embedded code is about 1,550
lines; about 3,500 lines of Core exist for the server and the REPL. `gsc`
(`src/Compiler`) references none of it. The REPL portion is also the test
oracle's seam, so "submission" is not server-only in the sense the study
used.

### 4. Lifetimes, threads and cancellation today

- **One funnel, one lock.** `ProjectState.GetCompilation` (`ProjectState.gs:223-269`)
  runs under `compilationLock`; `LspServer.gate` (`LspServer.gs:45`)
  serialises mutations, and reads run on pool threads (`ReadDocumentAsync`
  `:906-950`), so `GlobalScope`, `BoundProgram` and the server's model are
  touched concurrently.
- **Lazy binds are not single-flight.** `GlobalScope` and `BoundProgram`
  publish with `Interlocked.CompareExchange` (`Compilation.gs:327, 356`);
  concurrent first readers each bind and all but one result is discarded.
- **The incremental path mutates the predecessor.** `TryRepointBodyOnlyEdit`
  re-points the previous compilation's symbols at the new tree in place
  (`IncrementalGlobalScopeReuse.gs:318-352`) inside whichever reader thread
  next calls `GetCompilation()`. A reader still holding the previous
  `Compilation` sees symbols whose declaring syntax belongs to the new tree.
- **Binding cannot be cancelled from the server.** `Compilation` observes
  only `WorkBudget.CancellationToken` (`Compilation.gs:353`) and the server
  never sets `WorkBudget`; the cold bind runs to completion (about 17 s on a
  large workspace per `LspServer.gs:893-895`). LSP cancellation is checked
  between items in the computers and before a bind starts.
- **`AssemblyName` is never set** by the server although `Compilation.gs:249-262`
  says the server should set it before the first `GlobalScope` read, so
  friend-assembly (`InternalsVisibleTo`) visibility is evaluated with an empty
  consumer name.
- **Snapshot compilations share the body cache.** `GetCompilationForSnapshot`
  (`:288-321`) builds a throwaway compilation with the same `bodyCache`; its
  symbols are new objects, so every `TryReuse` misses the `ReferenceEquals`
  gate and every `Store` evicts the live compilation's entry for the same
  member (`BoundBodyCache.latestKeyByMember`), which the live compilation then
  re-stores.
- **The resolver is replaced, never disposed** (`ProjectState.gs:126-127,
  447-448, 469-470`); #5134 owns this.

### 5. Constraints

- **N-1.** Repository source uses only features the pinned release compiles;
  every signature in this ADR is ordinary source (classes, `ImmutableArray`,
  `CancellationToken`, `ConditionalWeakTable`, `Lazy`).
- **Public API snapshot.** `CorePublicApiSnapshotTests` pins the surface. An
  intentional change regenerates `gsharp-core-public-api.txt`
  (`GSHARP_UPDATE_GOLDENS=1`) and carries a release note. The ADR-0199
  allowance list permits nothing in this ADR; a removal and an addition are
  both plain snapshot diffs, reviewed as ABI changes. Every slice of section
  12 names its snapshot entries.
- **Analyzers keep the bound tree.** ADR-0169 exposes `GetBoundNode` and the
  `Bound*` nodes to analyzers; the GSA suite (`src/Analyzers`), cs2gs
  (`tools/cs2gs/Cs2Gs.Translator`, 23 files) and Core.Tests consume them.
  This ADR does not change their visibility; it removes the *server's* need
  for them.
- **ADR-0186 and ADR-0193.** A query that reads an imported member's type
  goes through `ClrNullability.Get*TypeSymbol` and the receiver-aware
  `MemberLookup.GetClr*TypeSymbol` readers; no new "is this nullable"
  computation; `PlatformTypeSymbol` and `NullableTypeSymbol` stay distinct in
  every result; speculative binding runs under `NullabilityOptions.Enter` as
  `Compilation.GlobalScope` does (`Compilation.gs:317`).
- **ADR-0208.** The type of an expression is the type the binder gave it;
  narrowing is already applied when the bound node is produced, and the
  flow-state query of ADR-0208 does not change what `GetTypeInfo` returns.
- **Representation preservation.** Every slice that touches `src/Core` keeps
  implementation, reference, PDB and XML output and diagnostics byte-identical
  on Core, Core.Tests and the pinned Oahu inputs (`build/compiler-bench.py`),
  with the `GSHARP_MEASURE_PHASES` JSON before and after.
- **ADR-0154.** Every new or changed behavioural test has a witness: red on
  the pre-change code or under a named product mutant.
- **#5140 owns `Binder.gs`.** B1 rewrites the constructor and the component
  wiring; a slice that edits `Binder.gs` internals lands after B1's first PR
  and moves the cache plumbing once, onto `BindingServices`.
- **ADR-0209 stage 6** lists `BoundSemantics`, `ImportedClrMemberResolver`
  and `SemanticLookup` as the server files that leave `System.Type`; the
  server slices here are where that happens, through symbols the queries
  return.

## Decision

### 6. The rule

The language server consumes `Compilation`, `SemanticModel`, the `Symbol`
hierarchy, `SymbolDisplay`, the documentation providers, the syntax layer and
the analyzer driver. It does not name `GSharp.Core.CodeAnalysis.Binding`, it
does not construct a `Binder`, and it does not read `Compilation.GlobalScope`
or `Compilation.BoundProgram`. Every semantic question in table 2a is a
method on `Compilation` or `SemanticModel`; every answer is a `Symbol`, a
`TypeSymbol`, a `Diagnostic` or an immutable collection of them. The
`InternalsVisibleTo` grant to `GSharp.LanguageServer` is removed when the last
member of table 2c has a public query (section 11). `Compilation.GlobalScope`
and `BoundProgram` stay public for analyzers and tests and are out of scope.

### 7. The query surface

Signatures are G#; every query takes a `CancellationToken` with a default.
Names follow Roslyn where Roslyn has the query, so that an analyzer author
and a cs2gs translation see familiar names (open question Q11).

**7a. `Compilation` (`Compilation/Compilation.gs`).** Successor factories
replace the three incremental properties.

```text
class Compilation {
    // Successor factories (section 8 gives the ownership rules).
    func ReplaceSyntaxTree(oldTree SyntaxTree, newTree SyntaxTree) Compilation
    func AddSyntaxTrees(trees ...SyntaxTree) Compilation
    func RemoveSyntaxTrees(trees ...SyntaxTree) Compilation
    // A one-shot variant for an unsaved buffer: never retargets this compilation's symbols,
    // never shares its body cache.
    func WithReplacedSyntaxTree(oldTree SyntaxTree, newTree SyntaxTree) Compilation

    // Diagnostics with source suppressions applied, the set gsc reports before emit.
    func GetDeclarationDiagnostics(cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[Diagnostic]
    func GetDiagnostics(cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[Diagnostic]

    // A declared type by its metadata name (package-qualified, nested types with `+`), or nil.
    func GetTypeByMetadataName(fullyQualifiedMetadataName string) TypeSymbol?

    // Unchanged: GetSemanticModel(tree), References, SyntaxTrees, AssemblyName, Submission, WorkBudget, Emit, ...
    // Removed from the public surface: BodyCache, ReusedGlobalScope, DirtyBodyTrees.
}
```

- `ReplaceSyntaxTree` is today's `TryBuildIncrementalCompilation_NoLock`
  (`ProjectState.gs:369-431`) moved into Core: same references, same options,
  the body-only edit test (`TryRepointBodyOnlyEdit`), the reused global scope
  and the dirty-tree set, and the body cache inherited from `this`. When the
  edit is not body-only the successor binds from scratch and still inherits
  the cache. `AddSyntaxTrees`/`RemoveSyntaxTrees` bind from scratch and
  inherit the cache. The body cache is created by the first successor factory
  call and never by a constructor, so `gsc` has none, exactly as today.
- `GetDiagnostics` returns `GlobalScope.Diagnostics` then
  `BoundProgram.Diagnostics` through `ApplySourceSuppressions`, then, when no
  error is present, the documentation diagnostics under
  `WarnOnMissingDocumentation`, exactly as `Emit`'s `PrepareForEmit` does
  (`Compilation.gs:620-631`); the order is the order `Emit` reports.
  `GetDeclarationDiagnostics` stops at the global scope. The server's own
  `DocumentationValidator.Validate(…, program.Functions.Keys, program.Structs, …)`
  call (`DocumentSyncHandler.gs:149-156`) goes with it. Analyzers stay with
  `GSharpAnalyzerDriver.Run(compilation, …)`, which already takes the
  compilation. `GetDiagnostics()` is also the warm-up the server runs after
  workspace discovery (`WorkspaceInitializer.gs:83-95` forces `BoundProgram`
  today).
- `GetTypeByMetadataName` answers the sibling-project lookup of
  `CrossAssemblyDefinitionResolver` (`:377-607` scans a sibling's
  `GlobalScope` for a type by package and name) by the name the emitter
  writes; it is the Roslyn query of that name. The implementation feature's
  "structs implementing an interface" scan (`LspServer.gs:1488-1519`) becomes a
  walk of the trees' type declarations through `GetDeclaredSymbol`, so no
  enumeration query is added.

**7b. `SemanticModel` (`CodeAnalysis/SemanticModel.gs`).** Existing queries
widen; five are added.

```text
class SemanticModel {
    // Existing. GetSymbolInfo now answers every case of table 2c: it returns the field or enum
    // member behind a folded constant read, the type behind a folded static qualifier, the
    // property behind a backing-field read (substituted at a constructed receiver), the member
    // behind an implicit conversion or a logical completion, and the owner of a constrained
    // static call. A parenthesized node answers for its operand.
    func GetSymbolInfo(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) SymbolInfo
    func GetTypeInfo(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) TypeInfo
    func GetDeclaredSymbol(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) Symbol?
    func GetBoundNode(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) BoundNode?   // analyzers; the server does not call it

    // New.
    func GetEnclosingSymbol(position int32, cancellationToken CancellationToken = default(CancellationToken)) Symbol?
    func LookupSymbols(position int32, name string? = nil, cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[Symbol]
    func LookupMembers(position int32, type TypeSymbol, name string? = nil, cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[Symbol]
    func GetMemberGroup(node SyntaxNode, cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[Symbol]
    func GetSpeculativeTypeInfo(position int32, expression ExpressionSyntax, cancellationToken CancellationToken = default(CancellationToken)) TypeInfo
    func GetDiagnostics(cancellationToken CancellationToken = default(CancellationToken)) ImmutableArray[Diagnostic]
}
```

- `GetSymbolInfo` for a name that bound to an imported member returns the
  imported member symbol (`ImportedFunctionSymbol`, the imported property,
  field or event symbol that `MemberLookup` produced); the server renders it
  through `SymbolDisplay` and `AssemblyDocumentationProvider.Resolve`. The
  server's `MemberInfo`-returning `GetImportedMember` goes; the residual
  `ClrType` reads in the server go with ADR-0209 stage 6.
- `GetTypeInfo(node).Type` is the bound expression's type, narrowed; the
  declared type of a variable is `GetDeclaredSymbol(declaration)` as a
  `VariableSymbol`'s `.Type`. `TypeInfo` gains no field.
- `GetEnclosingSymbol(position)` is the innermost function, accessor,
  constructor, struct, interface or global whose declaration contains
  `position`; `nil` at top level outside a declaration.
- `LookupSymbols(position, name)` returns the symbols a simple name resolves
  to at `position` in this tree: locals, pattern variables, `if let`/`while let`
  bindings, for-range variables, catch variables and lambda parameters whose
  scope contains `position` and whose declaration precedes it; the enclosing
  function's parameters; the enclosing type's members accessible without a
  receiver; globals, functions, types and aliases of the compilation visible
  through the file's imports; and, when `Compilation.Submission` is set, the
  prior submissions' members. One symbol per name: the innermost declaration
  shadows. Order: scope depth innermost first, then declaration order, so
  the result is deterministic. With `name` given, only that name. This is the
  scope reconstruction of `SemanticLookup.gs:730-1040` done over the bound
  blocks in Core, where the region structure is known, not re-derived.
- `LookupMembers(position, type, name)` returns the members of `type`
  accessible at `position` (visibility judged from `GetEnclosingSymbol` and
  the compilation's assembly name): source members through `TypeMemberModel`,
  imported members through `MemberLookup` with their types read through the
  ADR-0193 readers, inherited members included. The first implementation
  reproduces today's `TryComputeMemberCompletions` item set; extension
  members in scope are a follow-up (open question Q12).
- `GetMemberGroup(node)` returns the candidates a call or member-access name
  resolved among, in declaration order; signature help and the hover overload
  count consume it.
- `GetSpeculativeTypeInfo(position, expression)` binds `expression` as if it
  stood at `position`: the enclosing function from `GetEnclosingSymbol`, the
  locals from `LookupSymbols`, the file's imports, under
  `NullabilityOptions.Enter`. No diagnostic escapes; a failed bind returns
  `TypeInfo.None`. This replaces `Binder.TryInferExpressionType` and is the
  only place outside `Compilation` that constructs a binder; after #5140 it
  asks `BindingServices` for a body binder.
- `GetDiagnostics()` is `Compilation.GetDiagnostics` filtered to locations
  in this tree, preceded by the tree's parse diagnostics.

**7c. What is not added.** `FindReferences` stays in the server: it is a
workspace question (Roslyn answers it in Workspaces, not in `Compilation`),
and with `GetSymbolInfo` answering every identifier it is a loop over the
trees' identifier tokens. Cross-assembly definition stays in the server over
`ReferenceResolver.TryGetAssemblyPath` and the PDB locator; its symbol
identity question changes with ADR-0209 stage 6. The cold-start index stays
where it is (open question Q5).

### 8. Ownership, lifetimes, immutability, thread safety, cancellation

| Object | Owner | Lifetime | Mutability | Threads | Cancellation |
| --- | --- | --- | --- | --- | --- |
| `Compilation` | the host (the server's `ProjectState`, `gsc`, the REPL engine) | until superseded by a successor or dropped | options are set before the first query and never after (today's public setters stay; the server sets them only at construction, open question Q13); `GlobalScope`, `BoundProgram`, `DiagnosticSuppressions` and the semantic models are lazily built and published once | any thread may query; lazy builds become single-flight (a lock around the build, publication after it) so concurrent first readers wait instead of binding twice | the lazy builds run under `WorkBudget.CancellationToken`; a cancelled build publishes nothing and throws `OperationCanceledException` to every waiter; the next query builds again |
| successor `Compilation` from `ReplaceSyntaxTree`/`Add`/`Remove` | the host | as above | the successor copies every option of the predecessor (`References`, `Nullability`, `PlatformNilChecks`, `IsLibrary`, `Optimize`, `PreprocessorSymbols`, `ImplicitSystemImport`, `AssemblyName`, `Submission`, `Logger`, `DebugInformation`, `WarnOnMissingDocumentation`, `EmbeddedResources`) except `WorkBudget`, which the host sets on the successor before its first query because it owns the token. The predecessor is **retired**: `ReplaceSyntaxTree` may retarget the predecessor's symbols at the new tree (today's in-place repoint); a retired compilation still answers queries from state it already built, but symbol declaration spans of the edited file refer to the new tree, and a query that needs state it never built throws `OperationCanceledException` once its token is cancelled. The host that holds the predecessor is the one that called the factory, so it alone decides when readers may still use it (`ProjectState` replaces its cached compilation under `compilationLock` today) | as above | the host cancels the predecessor's `WorkBudget` token when it retires it, which releases any waiter on a bind that is no longer wanted |
| `WithReplacedSyntaxTree` result | the host | one request | never retargets the predecessor; no shared body cache | as above | as above |
| body cache (`internal`) | the compilation chain, created by the first successor factory | the chain | thread-safe (`ConcurrentDictionary`); O(members) by eviction of a member's previous key; soundness by `ReferenceEquals(entry.Member, member)` and the body hash, as ADR-0105 states | any body-binding thread | none needed |
| `SemanticModel` | its `Compilation` (`ConditionalWeakTable` per tree) | the compilation's | immutable after its index is built; the index is a `Lazy` (`ExecutionAndPublication`) | concurrent reads | each query checks its token before forcing the index; the index build runs under the first caller's token, and a cancelled build is not cached (the `Lazy` is replaced with a lock and a nullable field so an `OperationCanceledException` does not poison the model) |
| `Symbol` | its `Compilation` | the compilation's; a retired compilation's edited-file symbols are shared with the successor | immutable except `RepointDeclaration` during `ReplaceSyntaxTree` | read anywhere | n/a |
| query results | the caller | the caller's | `ImmutableArray`, `SymbolInfo`, `TypeInfo`: value-like; symbols are references into the compilation | n/a | n/a |

The server's `ProjectState` keeps its lock and becomes: `GetCompilation()`
returns the cached compilation or builds a successor through the factories;
`UpdateFile` cancels the predecessor's token; `GetCompilationForSnapshot`
calls `WithReplacedSyntaxTree`; nothing else in the server knows that a body
cache or a reused scope exists.

### 9. Where each piece goes

| Piece | Target home | Visibility | Snapshot entries affected (`gsharp-core-public-api.txt`) |
| --- | --- | --- | --- |
| `BoundBodyCache`, `BoundBodyCacheKey` | `src/Core/CodeAnalysis/Binding/Incremental/` | `internal`; `TryCreateKey` and the `Hits`/`Misses`/`Stores` counters, unused in production, deleted or `internal` for tests | remove `BoundBodyCache` (`:1696`), `BoundBodyCacheKey` (`:8387`), `Compilation.BodyCache` get/set (`:339, 365, 386`), the `BindProgram` overloads that take a cache (`:1467-1469`) |
| `IncrementalGlobalScopeReuse` | `Binding/Incremental/` | `internal`, called only by `Compilation.ReplaceSyntaxTree` | remove `IncrementalGlobalScopeReuse` (`:8081`), `Compilation.ReusedGlobalScope` get/set/property (`:341, 376, 388`), `Compilation.DirtyBodyTrees` get/set/property (`:359, 367, 399`) |
| nine `RepointDeclaration` methods | unchanged | `internal` | none |
| `Binder.TryInferExpressionType` | `SemanticModel.GetSpeculativeTypeInfo`; the `Binder` member is deleted | n/a | remove `:1470`; add the `SemanticModel` methods of 7b to the `SemanticModel` block (`:4249-4262`) |
| `Compilation` successor factories, diagnostics queries, `GetTypeByMetadataName` | `Compilation.gs` | public | add to the `Compilation` block (`:332-399`) |
| body-cache plumbing in `Binder` (parameters on six `Bind*Body` methods, about 25 call sites) | after #5140 PR 1: a `BodyBindingOptions(cache, dirtyTrees)` value on `BindingServices`, read by `BindBodyWithCache`; `Binder.gs` has no `cache` or `dirtyTrees` parameter | `internal` | the `BindProgram(globalScope, references)` overload stays public (open question Q2) |
| submission binding (section 3) | stays in Core, isolated: `Binder.Submissions.gs`, `ExpressionBinder.Submissions.gs`, `OverloadResolver.Submissions.gs`, `BoundScope.Submissions.gs`, each a partial of its class, reached through one `internal` door class `SubmissionBinding` whose methods take the scope and return `false` when `SubmissionImports` is nil; the nil checks in the hot paths (`BoundScope.gs:556-769`, `ExpressionBinder.gs:675-681`, `CallBinding.gs:521-535`) become one `SubmissionBinding.TryX(...)` call each | `internal` | none |
| `SubmissionImports`, `SubmissionReference`, `SubmissionBindingOptions`, `SubmissionGlobalTypeProjection` | `Binding/Submissions/` | public (the REPL and `EmittedOracle` construct them); projection stays `internal` | none (a folder move) |
| `previous` chaining | deleted: `BoundGlobalScope.GetCumulativeImports`, the `CreateParentScope` stack walk, the three `.Previous` loops; `BoundGlobalScope.Previous` stays and the `previous` parameters stay but a non-nil value is an `ArgumentException` | public | none now (open question Q2 covers the parameter) |
| `InteractiveSessionHost`, `SubmissionRunResult` | `src/Repl/Engine/` (assembly `gsi`) | n/a | remove `InteractiveSessionHost` (`:3980`), `SubmissionRunResult` (`:3986`) |
| `ReferenceMetadataIndex`, `ExportMetadataIndex`, `TryUseMetadataIndex` | unchanged (ADR-0107; ADR-0209 PR 1 moves the name index onto the set; study Q5 gives `gsc` the same index) | public | none |
| server: `SemanticLookup.SemanticModel`, `BoundSemantics`, `ImportedClrMemberResolver`, the reflection paths of `HoverComputer`, `GetExpressionBindingContext` | deleted or reduced to protocol mapping over the queries | n/a | n/a |

What this does to the counts (estimates; the slices report the measured
numbers): about 420 lines leave Core (`InteractiveSessionHost`, the `previous`
walks, `TryInferExpressionType`, the removed overloads and properties); about
890 lines (cache and reuse) and about 990 lines (submission binding) stay in
Core but leave the public surface and `Binder.gs`; `SemanticModel` grows by
an estimated 600 to 900 lines of general query code that analyzers and cs2gs
also get; the server loses an estimated 2,000 to 2,500 lines. The acceptance
criterion of #5139, "Core line count for server-only code down", is met for
the server-only code (the body cache, the reuse and the inference entry are
no longer server-only or no longer in Core); Core's total line count is
roughly flat, because the interpretation the server did moves into Core where
it belongs. The maintainer's "less code in Core" is met in the sense of less
*public* and less *special-cased* code; section 13 Q1 asks whether that is
the intended reading.

### 10. The binder side, coordinated with #5140

- The server never names `Binder`. After this ADR the only non-Core caller
  of `Binder.BindGlobalScope`/`BindProgram` is the test population of open
  question Q2.
- `GetSpeculativeTypeInfo` is the one consumer of binder construction
  outside `Compilation`. Before B1 it does what `TryInferExpressionType` does
  today (a `Binder(parentScope, containingFunction)`); after B1 PR 1 it asks
  `BindingServices.CreateBodyBinder(containingFunction, locals)` and B1's
  worker-local state rule (ADR-0203 §4) applies to it unchanged.
- The cache and dirty-tree plumbing moves once, after B1 PR 1, onto
  `BindingServices` as a `BodyBindingOptions` value, so B1 does not have to
  thread two extra parameters through its new constructor graph and this ADR
  does not rewrite call sites B1 is about to rewrite.
- The submission partials are extracted after B1 PR 1 for the same reason;
  they are file moves of existing methods plus one door class, and B1's
  component boundaries (expression, statement, declaration binders) are the
  partial boundaries used.
- `ContainsSyntheticBodySideEffects` is already behind `cache != nil`
  (`Binder.gs:8631-8636`); the two closures built per body for the cache go
  with the plumbing move, which `compiler-bench.py` should show as a small
  allocation drop and nothing else.

### 11. Gates

1. **Public API snapshot** regenerated in every slice that changes it, with a
   release-notes bullet naming the removed and added members.
2. **Binding reference gate.** A new `LanguageServer.Tests` test reads
   `GSharp.LanguageServer.dll` with `System.Reflection.Metadata` (the
   technique of `CorePublicApiSnapshotTests`) and asserts that no `TypeRef`
   row names a type in `GSharp.Core.CodeAnalysis.Binding`. It is added green
   in slice S2 with an allowance list of the types still referenced at that
   point; each later slice shrinks the list, and S7 empties it. A type that
   is not on the list and is referenced fails the test, so no slice can add a
   reach-in. The same test asserts that
   `GSharp.Core.dll` carries no `InternalsVisibleTo("GSharp.LanguageServer")`
   row after S7.
3. **`Binder.gs` gate** (S8): `grep -c -E 'submission|Submission|BoundBodyCache|dirtyTrees|GetCumulativeImports' src/Core/CodeAnalysis/Binding/Binder.gs` is 0; the `previous` parameter remains only in the public overload signatures and the one `ArgumentException`.
4. **Output parity** for every slice that touches `src/Core`: `build/compiler-bench.py`
   on the Core, Core.Tests and Oahu cells, byte-identical outputs and
   diagnostics, phase JSON attached to the PR.
5. **Server parity**: `build/lsp-soak.py` `compare` between the pre-slice and
   post-slice server on the same plan: zero new crashes, the `edit-*` step
   latencies not worse beyond run-to-run variation, and the counters
   `declarations.reuses` and the body-cache hit count equal on a fixed edit
   script (the `IncrementalDeltaBindingTests` scenarios driven through the
   server). `test/LanguageServer.Tests` and `test/Interpreter.Tests` green.
6. **ADR-0154 witness** per slice, named in section 12.

### 12. Slices

Each slice is one PR, behaviour-preserving unless marked, and independently
shippable in the order given. "After" names the merge it needs.

| # | Content | After | Acceptance beyond the gates | ADR-0154 witness (mutant) |
| --- | --- | --- | --- | --- |
| S0 | Move `InteractiveSessionHost` and `SubmissionRunResult` to `src/Repl/Engine/`; snapshot and release note | none | `Interpreter.Tests` green; `src/Core/CodeAnalysis/Execution` no longer mentions submissions | n/a (a move; the existing REPL tests are the oracle) |
| S1 | `Compilation.ReplaceSyntaxTree`, `AddSyntaxTrees`, `RemoveSyntaxTrees`, `WithReplacedSyntaxTree`, `GetTypeByMetadataName`; body cache and reuse `internal` under `Binding/Incremental/`; single-flight lazy builds; `ProjectState` and `CrossAssemblyDefinitionResolver` migrated (factories, no `BoundBodyCache`/`ReusedGlobalScope`/`DirtyBodyTrees`, no sibling `GlobalScope` scan); snapshot companion for the removed and added members | none | `IncrementalDeltaBindingTests` assert `Assert.Same(previous.GlobalScope, successor.GlobalScope)` on a body-only edit through `ReplaceSyntaxTree` and not through `WithReplacedSyntaxTree`; `declarations.reuses` equal before and after on the fixed edit script; snapshot compilations no longer evict live entries (new test over the hit counter, `internal` for tests); `CrossProjectDefinitionTests` green | drop the `ReferenceEquals(entry.Member, member)` gate in `TryReuse`: `BoundBodyCacheTests.SoundnessGate_Blocks_Reuse_Across_Different_Scope_Instances` goes red; skip the skeleton diff in the repoint: `IncrementalGlobalScopeReuseTests.SignatureEdit_IsRejected_ByReuse` and `IncrementalDeltaBindingTests.SignatureEdit_FallsBackToFullRebuild` go red |
| S2 | `GetSymbolInfo` answers table 2c (folded constants, static qualifiers, backing fields, substituted properties, conversions, completions, constrained owners, parentheses); `GetMemberGroup`; `BoundSemantics` reduced to calls into the model; the binding reference gate added with its initial allowance list | none | `Issue4989BoundReceiverTests` re-pointed at `GetSymbolInfo`/`GetTypeInfo` and green; the thirteen members of table 2c have no server caller | stop peeling `StaticConstantFieldRead` in `GetSymbolInfo`: `Issue4989BoundReceiverTests.Issue5035_BareConstantPrefix_PreservesExactMethodAndRange` goes red; return the unsubstituted property: `ObjectInitializerHoverCompletionTests.ComputeHover_OnClrInitializerProperty_ResolvesAgainstConstructedType` goes red |
| S3 | `GetEnclosingSymbol`, `LookupSymbols`; the server's scope reconstruction (`SemanticLookup.gs:479-1040`, `MapLocalVariables`, `MapTypeClauseReference`, `FindBoundNodes`) deleted; general completion, semantic tokens and the implementation feature over the queries | S2 | `SemanticLookupIfLetGuardTests`, `Issue4219GenericLocalRecursionTests`, `Issue4967NullCoalescingAssignmentHoverTests` and `CompletionHandlerTests` green through the queries; `BuildModelForTest` and the incremental model counters deleted with the model | end an `if let` region at the block end instead of the guard: `SemanticLookupIfLetGuardTests.Statement_GuardAndThenUses_ResolveToTheBinding_ElseAndAfterToTheOuterLocal` goes red; ignore declaration order in `LookupSymbols`: a new completion test (a local used before its declaration is not offered) goes red |
| S4 | `LookupMembers`; member completion, hover member fallback, `ImportedClrMemberResolver` and the reflection member walks replaced; imported member types through the ADR-0193 readers | S2 | `ObjectInitializerHoverCompletionTests`, `UnifiedMemberResolutionCharacterizationTests` and `CompletionHandlerTests` green with the same item sets; GSA0007 green | skip inherited members: `ObjectInitializerHoverCompletionTests.ComputeCompletions_InsideGSharpClassInitializerBlock_OffersInheritedAndOwnFieldsAndProperties` goes red; read a member type through `FromClrType`: `Adr0193NullabilityImportRuleTests` (Core.Tests) goes red |
| S5 | `GetSpeculativeTypeInfo`; `Binder.TryInferExpressionType` and `GetExpressionBindingContext` deleted; snapshot companion | S3 (for `LookupSymbols`); after #5140 PR 1 if it has merged, otherwise on the current constructor | `ObjectInitializerHoverCompletionTests` green | ignore the in-scope locals: a new test (an initializer whose receiver is a local declared in the enclosing body) goes red |
| S6 | `Compilation.GetDiagnostics`/`GetDeclarationDiagnostics` (with documentation diagnostics as `Emit` produces them), `SemanticModel.GetDiagnostics`; `DocumentSyncHandler` and `CodeActionComputer` over them; `WorkspaceInitializer` warms through `GetDiagnostics`; `ProjectState` sets `WorkBudget` with a per-compilation token cancelled on supersede | S1 | `DocumentSyncHandlerTests` green with identical diagnostic sets and order; a new test cancels a bind in flight and asserts the next query completes and the first waiter observed `OperationCanceledException` | drop the suppression filter from `GetDiagnostics`: `DocumentSyncHandlerTests.ComputeDiagnostics_HonoursSuppressDiagnosticForCompilerWarnings` goes red; drop the documentation pass: a new missing-documentation case goes red; publish a partially built scope on cancellation: the new cancellation test goes red |
| S6b | `ProjectState` sets `Compilation.AssemblyName` (**behaviour change**: friend-assembly members become visible in the server as they are in `gsc`); release note | S6 | a `LanguageServer.Tests` case over a reference with `InternalsVisibleTo` to the project reports no false GS diagnostic | revert the assignment: the new test goes red |
| S7 | Remove the `InternalsVisibleTo("GSharp.LanguageServer")` grant; binding reference gate allowance list empty; delete the dead server code (`SemanticLookup.SemanticModel`, remaining `Bound*` imports) | S2 to S6 | gate 2 green; `src/LanguageServer` has no `import GSharp.Core.CodeAnalysis.Binding` | n/a (the gate is the oracle) |
| S8 | Binder consolidation: submission partials and the `SubmissionBinding` door; `BodyBindingOptions` on `BindingServices`; the `previous` walks deleted and a non-nil `previous` rejected; `Binding/Submissions/` folder | #5140 PR 1 | gate 3; `compiler-bench.py` parity on the three cells; `Interpreter.Tests` and the `EmittedOracle` population green | make the door return `false` for a prior-cell global write: `Issue3251IndexAssignmentSubmissionGlobalTests` goes red; keep a `previous` loop: no test, the deletion is covered by the parity gate |

Sequencing: S0, S1 and S2 are parallel; S3 and S4 follow S2 and are parallel
with each other; S5 follows S3; S6 follows S1; S6b follows S6; S7 closes the
server side; S8 waits for #5140 PR 1 and is the only slice that edits
`Binder.gs`.

### 13. Open questions for the maintainer

1. **Submission binding stays in Core.** The REPL and the `EmittedOracle`
   seam (about 464 test files) need it, and its write paths produce bound
   nodes that lowering and emit read. This ADR isolates it (partials, one
   door) rather than moving it out. Alternative: a redesign in which prior
   cells are visible through ordinary static imports of their `<Program>`
   types, which would delete the read paths and leave only the write
   projection and the `<Result>$$` capture; it changes REPL shadowing rules
   and is its own ADR. **Recommendation: isolate now; file an issue for the
   static-import redesign and decide after B1.**
2. **`Binder.BindGlobalScope`/`BindProgram` stay public with their `previous`
   parameter.** 157 Core.Tests files, 11 cs2gs test files and one
   Extensions.Tests file call them directly; `Cs2Gs.Tests` has no
   `InternalsVisibleTo` grant. Internalising them is a 170-file test
   migration to `Compilation`. **Recommendation: keep them public in this
   ADR, reject a non-nil `previous` with `ArgumentException`, and file an
   issue to migrate the tests to `Compilation` and then internalise both
   with the `previous` parameter removed.**
3. **In-place retargeting of the predecessor's symbols** (section 8) versus a
   clone-based reuse that builds a new global scope sharing unchanged symbol
   objects. The clone is the clean model but needs symbol copy constructors
   for nine declaration kinds and a re-keying of the body cache.
   **Recommendation: keep the in-place repoint behind `ReplaceSyntaxTree`
   with the retirement rule stated, and re-evaluate after B1/B2.**
4. **Does the incremental machinery survive B1 and B2?** ADR-0105 was
   measured against a full re-bind that B1 (binder services) and B2 (body
   workers) will shorten. If `lsp-soak.py` `edit-*` latencies with the cache
   disabled are within variation of the enabled ones after B2, the 890 lines
   can go. **Recommendation: keep it behind the factory now (the factory
   makes removal a Core-only change) and measure after B2.**
5. **`ReferenceMetadataIndex` home.** It is server-only today, but ADR-0209
   PR 1 moves the name index onto `ReferenceImageSet` and study item Q5 gives
   `gsc` the same persisted index. **Recommendation: out of scope here;
   decided by the ADR-0209 and #5145 line.**
6. **`GetBoundNode` and the `Bound*` nodes stay public** for ADR-0169
   analyzers and cs2gs. The binding reference gate applies to the server
   assembly only. **Recommendation: yes.**
7. **Cancellation model.** A compilation-lifetime token (set by the host at
   construction, cancelled on supersede) with single-flight lazy builds,
   versus per-request tokens that would need partial results to be cached
   incrementally. **Recommendation: compilation-lifetime; a request token
   cancels only that request's wait.**
8. **`AssemblyName` in the server (S6b)** is a behaviour change that removes
   false diagnostics on friend-assembly internals and may reveal diagnostics
   `gsc` reports and the server hid. **Recommendation: do it, as its own PR
   with a release note.**
9. **Snapshot compilations stop sharing the body cache.** Today's sharing
   evicts live entries and never hits. **Recommendation: yes, in S1.**
10. **`LookupSymbols` returns one symbol per name** (innermost shadows),
    where Roslyn returns all candidates. Completion and name resolution need
    the resolved one; a "show shadowed" feature does not exist.
    **Recommendation: one per name; `GetMemberGroup` carries the overload
    sets.**
11. **Roslyn names** (`ReplaceSyntaxTree`, `AddSyntaxTrees`,
    `RemoveSyntaxTrees`, `LookupSymbols`, `GetEnclosingSymbol`,
    `GetMemberGroup`, `GetSpeculativeTypeInfo`) versus G#-specific ones.
    **Recommendation: Roslyn names where the semantics match; `WithReplacedSyntaxTree`
    is new because Roslyn has no one-shot variant.**
12. **Extension members in `LookupMembers`.** Today's member completion does
    not list them; adding them is a feature, not preservation.
    **Recommendation: not in S4; a follow-up issue once `LookupMembers` exists.**
13. **Freezing `Compilation` options after the first query.** Today every
    option is a public setter; a host that sets `Nullability` after reading
    `GlobalScope` gets inconsistent results. **Recommendation: not in this
    ADR; the server sets options only at construction, and a freeze (throw
    on set after the first lazy build) is a one-line follow-up with its own
    snapshot entry.**

## Consequences

### Positive

- The server asks semantic questions and gets symbols; about 2,000 lines of
  bound-tree interpretation, reflection member walks and scope reconstruction
  leave the server, and the thirteen `internal` reach-ins and the
  `InternalsVisibleTo` grant go with them.
- `SemanticModel` answers folded constants, static qualifiers, backing
  fields, member groups, position-based lookup and speculative binding for
  every consumer, so analyzers (ADR-0169) and cs2gs get the same answers the
  server gets.
- `Compilation`'s incremental state is a factory, not three public mutable
  properties; `BoundBodyCache` and `IncrementalGlobalScopeReuse` leave the
  public surface, and `Binder.gs` loses its cache plumbing, its submission
  branches and its dead `previous` walks (after B1).
- Lifetimes, threading and cancellation have a stated rule (section 8)
  instead of the implicit one the server relies on today; concurrent first
  readers no longer bind twice; the server can cancel a bind it no longer
  wants.
- The REPL's in-process completion and hover (`AnalysisBridge`) improve for
  free, and `LookupSymbols` includes prior-cell members when `Submission` is
  set.

### Negative

- Nine or ten PRs across Core, the server and the REPL, two of them
  sequenced behind #5140 PR 1; each snapshot-changing slice carries a release
  note.
- Core's total line count stays roughly flat (section 9): the interpretation
  moves rather than disappears, and submission binding stays in Core.
- The in-place repoint remains a mutation of a live object graph until Q3 is
  revisited.
- S6b changes diagnostics the server shows on friend-assembly code (to match
  `gsc`).

### Neutral

- `gsc` output and the batch binding path are unchanged by construction;
  `compiler-bench.py` parity is a gate on every Core slice.
- `GetBoundNode`, `Compilation.GlobalScope` and `BoundProgram` keep their
  public visibility for analyzers and tests.
- The cold-start cache, cross-assembly definition and `FindReferences` keep
  their current shape; ADR-0209 and #5134/#5145 own the parts of them that
  change.
- A Proposed design ADR carries no release-notes bullet, as ADR-0208 and
  ADR-0209 did not; the implementing slices carry theirs.

## Alternatives considered

- **A `GSharp.Workspaces` assembly that receives the server-only code and an
  `InternalsVisibleTo` grant.** Rejected: it moves the reach-in one assembly
  over and keeps the server consuming bound nodes and the global scope's raw
  collections; the body cache and the repoint need symbol internals and would
  need a wider grant, not a narrower one.
- **Make `Binder`, `BoundScope` and `MemberLookup` the supported surface.**
  Rejected: it freezes implementation types that #5140 is about to
  restructure, and it is the opposite of decision 6.
- **Roslyn-style immutable incremental compilation (`ReplaceSyntaxTree` that
  shares declaration tables without mutation, red/green trees).** Rejected
  for now: the study found no batch-compile gain from incremental parse, and
  the clone-based reuse of Q3 is the smallest step toward it; the factory
  names are chosen so that the implementation can change underneath.
- **Delete the incremental machinery now and rely on B1/B2.** Rejected until
  measured (Q4): the server's per-keystroke latency on large workspaces is
  what ADR-0105 bought, and B1/B2 have not landed.
- **Move submission binding out of Core behind an "ambient scope provider"
  interface.** Rejected for this ADR: the write paths produce
  `BoundClrPropertyAssignmentExpression` nodes with submission-specific flags
  that lowering and emit read, and the test oracle depends on the seam;
  isolation inside Core is the behaviour-preserving step, and the
  static-import redesign (Q1) is the real simplification.
- **Leave the server's parallel semantic model and only fix the thirteen
  internals by making them public.** Rejected: it keeps two semantic models
  with one name, keeps the heuristics of table 2d (whole-program scans by
  name, declaration by name ignoring shadowing, message-text parsing) and
  widens the public surface instead of narrowing it.

## References and reproducibility

- Site inventories were taken by reading the files named in sections 2 to 4
  at `b038be414`; line numbers refer to that commit. Counts: `wc -l` over
  `src/LanguageServer` (15,931 lines in 38 files) and the seven Core files of
  section 3 (1,931 lines); direct `Binder.BindGlobalScope`/`BindProgram`
  callers by `grep -rl` over `test/` and `tools/` (157 Core.Tests, 11 cs2gs,
  1 Extensions.Tests, 1 LanguageServer.Tests comment).
- Snapshot line numbers refer to `test/Core.Tests/Baselines/gsharp-core-public-api.txt`
  at the same commit.
- Study tables: section 5 ("Where the batch path carries language-server and
  REPL weight") and section 10 decision 6 of
  `docs/compiler-architecture-and-performance-study.md`.
- Measurement tools: `build/compiler-bench.py` (batch parity and phase
  JSON), `build/lsp-soak.py` (`plan`, `run`, `compare`; latency and crash
  record per LSP request).
