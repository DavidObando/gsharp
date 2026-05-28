# Emit pipeline

GSharp has two execution backends. The interpreter (`Evaluator`) walks the bound tree in-process and is what powers the REPL and most language tests. The emit pipeline produces standalone managed PEs that load and run under any compatible .NET runtime. This document describes the emit pipeline only; the interpreter remains the canonical reference for language semantics, but compiling to disk is now the production path for `dotnet build`.

```
.gs source ──► Lexer ──► Parser ──► Syntax tree
                                       │
                                       ▼
                                     Binder ──► BoundProgram
                                       │
                                       ▼
                                    Lowerer ──► BoundProgram (lowered)
                                       │
                                       ▼
                          ReflectionMetadataEmitter ──► PE stream
                                       │
                                       ▼
                          gsc.dll writes <name>.dll + .runtimeconfig.json
                                       │
                                       ▼
                          MSBuild (via Gsharp.NET.Sdk) wraps the whole thing
```

## Components

| Layer | Type | Responsibility |
| --- | --- | --- |
| Syntax | `GSharp.Core.CodeAnalysis.Syntax.*` | Tokenization + parsing into a tree of `SyntaxNode`s. |
| Binding | `Binder`, `BoundScope`, `BoundProgram` | Resolve names, type-check, lower, synthesize a top-level entry-point method (C# 9-style). |
| Emit | `ReflectionMetadataEmitter` | Walk the lowered `BoundProgram` and write a PE using `System.Reflection.Metadata.Ecma335` directly — no Roslyn dependency at runtime. |
| Compiler driver | `gsc` (`src/Compiler`) | Parse command-line args (`/out`, `/r`, `/target`, `/targetframework`, response files), produce the PE, and write `<name>.runtimeconfig.json` for executable outputs. |
| MSBuild SDK | `Gsharp.NET.Sdk` | Wire `CoreCompile` into `Microsoft.NET.Sdk` so `.gsproj` files participate in the standard build pipeline. The SDK's task DLL is `netstandard2.0`; the compiler payload is `net10.0` invoked as `dotnet gsc.dll`. |

## Async / iterator lowering pipeline

Async methods, async lambdas, sync iterators (`sequence[T]`), and async iterators (`IAsyncEnumerable[T]`) require a state-machine transformation before IL emission. This lowering runs inside `Compilation.LowerForEmit`, after binding and before `EmitAssembly`. The entry point is `AsyncStateMachineRewriter.Rewrite` (for async methods/lambdas) or the sibling `IteratorRewriter` / `AsyncIteratorRewriter` (for sync/async iterators respectively).

### Pass ordering (async methods and async lambdas)

Inside `AsyncStateMachineRewriter.Rewrite`, the bound body is transformed through a fixed sequence of passes:

1. **`AsyncExceptionHandlerRewriter`** — rewrites `try`/`catch`/`finally` blocks containing `await` into a form the state machine can resume into (spec §8).
2. **`SpillSequenceSpiller`** — lifts `await` expressions out of compound sub-expressions into spill-sequence temporaries, ensuring each await is at statement level.
3. **`RefInitializationHoister`** — decomposes `ref` locals that span await points into addressable fields.
4. **`AsyncCaptureWalker`** — walks the rewritten body to compute the hoist set (locals and parameters that live across await points).
5. **State-machine rewriter** — synthesizes the `IAsyncStateMachine` struct, builder field, state field, hoisted-local fields, and the `MoveNext()` body. The **MoveNext body rewriter** is a sub-pass that converts each `await` into a yield/resume pair with state transitions, and inserts sequence-point markers.

### Sync and async iterators

`IteratorRewriter` (sync) and `AsyncIteratorRewriter` (async) run as siblings of the async-state-machine rewriter in `LowerForEmit`. They produce **class** state machines (not structs) because the iterator object serves as both `IEnumerable[T]` and `IEnumerator[T]` for the first enumeration. Each `yield` statement becomes a `current = value; state = K; return true` transition in the generated `MoveNext()`.

### Sequence-point markers

The MoveNext body rewriter inserts `AwaitYieldPoint` (before suspending) and `AwaitResumePoint` (at the resume label) markers. Today these emit as single `nop` IL bytes — placeholders for a future PDB writer that will map them to source-level sequence points for debugger step-through.

### Nested-type layout

All synthesized state-machine types nest privately inside their kickoff method's declaring type, following the Roslyn convention for debugger and reflection discovery:

- Top-level functions: state machine nests inside `<Program>`.
- Lambdas with captures: state machine nests inside the closure class.

The typedef ordering within the module is:

```
<Module>
├── Interfaces
├── Classes
│   ├── <Program>
│   │   └── <async-method-SM>d__N (struct, nested)
│   ├── SyncIterator_SM (class, nested in declaring type)
│   └── AsyncIterator_SM (class, nested in declaring type)
├── Structs
│   └── (async-lambda struct SMs nested in closure class)
└── Nested SMs follow their enclosing type's row
```

### Design references

- [ADR-0023](adr/0023-async-state-machine.md) — async state-machine strategy and implementation summary.
- [ADR-0040](adr/0040-sequence-type-and-yield.md) — `sequence[T]` type alias and `yield` statement.

## Portable PDB / debug-info pipeline

When `/debug` is on, `ReflectionMetadataEmitter` collaborates with a sibling
`PortablePdbEmitter` (`src/Core/CodeAnalysis/Emit/PortablePdbEmitter.cs`) to
produce standards-conformant [Portable PDB](https://github.com/dotnet/runtime/blob/main/docs/design/specs/PortablePdb-Metadata.md)
symbols alongside the PE. Both emitters share the same `MetadataBuilder`
contract, so the PE and PDB tables stay token-synchronised without an
intermediate model.

```
BoundProgram (lowered) ─► ReflectionMetadataEmitter ─┐
                                                     ├─► PE stream
                                                     │   + DebugDirectory
                                                     ▼   (CodeView + PdbChecksum + Reproducible + EmbeddedPortablePdb)
                          PortablePdbEmitter ──► PDB stream (sidecar or embedded)
```

The PDB writer is invoked by `Compilation.EmitAssembly` whenever
`DebugInformation.Format` is `Portable` or `Embedded`:

1. **Document table** — `PortablePdbEmitter.GetOrAddDocument(SyntaxTree)`
   deduplicates `Document` rows by normalised path and stamps each one with
   GSharp's language GUID (`4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00`) and a
   SHA-256 of the source bytes.
2. **MethodDebugInformation** — `RecordMethod` captures per-method sequence
   points, the local-variable list (with compiler-generated locals tagged
   `DebuggerHidden`), the IL byte-size, and the `StandAloneSignature` token
   for the local signature.
3. **LocalScope / LocalVariable / ImportScope** — emitted from the per-method
   data captured above. Today the lowering flattens nested blocks, so each
   method gets a single root `LocalScope` covering its full IL length;
   per-`import` scopes follow once the binder exposes the resolved import
   set on the symbol model.
4. **CustomDebugInformation** — `EmbeddedSource`, `SourceLink`, and
   `CompilationOptions` rows are emitted according to the `/embed`,
   `/sourcelink:` and (always-on) compilation-options policies documented in
   [`debug-info.md`](debug-info.md).
5. **Serialize** — `PortablePdbEmitter.Serialize` returns the assembled PDB
   blob and its `BlobContentId`. `ReflectionMetadataEmitter` wires that
   `ContentId` into the PE's `IMAGE_DIRECTORY_ENTRY_DEBUG` via
   `DebugDirectoryBuilder` so the in-PE `CodeView.Guid` matches the PDB
   metadata header's `Id` field.

The full surface — language GUID, `CustomDebugInformation` kinds, sequence-
point semantics, PE debug-directory entries, compiler flags, and SDK
property mapping — is the subject of [`docs/debug-info.md`](debug-info.md).
The end-to-end policy decisions (embed-by-default, SHA-256, deterministic
content id) are recorded in
[ADR-0048](adr/0048-portable-pdb-emit.md).

## Entry-point synthesis

GSharp supports C# 9-style top-level statements. The binder lowers a file's top-level statements into a single hidden `MethodSymbol` (logically `<TopLevel>$.<Main>$(string[] args)`). The emitter marks that method as the assembly entry point. An explicit `func Main()` is supported and takes precedence; mixing both in the same compilation is an error. See [`Gsharp-design-v0.1.md`](../design/Gsharp-design-v0.1.md) for the language-level contract.

## Cross-TFM emit

The emitter is hosted in `gsc.dll`, which itself targets `net10.0`. Without special care, every emitted assembly would reference `System.Private.CoreLib, Version=10.0.0.0` regardless of the requested `TargetFramework`, and any non-net10.0 output would fail to load with `FileNotFoundException`.

To produce assemblies that match the requested TFM, the compiler routes reference assemblies through `ReferenceResolver`:

- `ReferenceResolver.WithReferences(paths)` loads the user-supplied reference assemblies into an isolated `System.Reflection.MetadataLoadContext`. The gsc host's trusted-platform-assembly list is appended as a *fallback* — user paths come first in the `PathAssemblyResolver`, so target-ref-pack BCL assemblies (`System.Runtime.dll`, `System.Console.dll`, etc.) shadow the host copies.
- `Type` instances handed back from the resolver carry the target framework's assembly identities (e.g. `System.Console, Version=8.0.0.0` for a `net8.0` build).
- `ReferenceResolver.GetCoreType("System.Object")` / `"System.String"` is the entry-point the emitter uses to seed primitive type references, rather than calling `typeof(object)` / `typeof(string)` which would bind to the gsc host's `System.Private.CoreLib`.
- `ClrTypeUtilities.AreSame` and `ClrTypeUtilities.IsAssignableByName` compare `Type`s by `FullName` so the binder and emitter work even when types come from different reflection contexts. Reference-equality (`==`) and `Type.IsAssignableFrom` only work within a single context.

The end-to-end correctness of this pipeline is gated by [`build/multitarget-e2e.sh`](../build/multitarget-e2e.sh), which builds and runs the HelloWorld sample for every TFM in `TARGET_FRAMEWORKS` and asserts the expected stdout.

## Where Roslyn fits in

The emit path does **not** depend on Roslyn — `ReflectionMetadataEmitter` writes PE bytes directly via `System.Reflection.Metadata`, and v1.0 ships on this path. [ADR-0027](adr/0027-roslyn-fork-decision.md) records the decision to close the Roslyn-fork track (issue #51) as `wontfix` for v1.0; NuGet-distributable libraries and full cross-language debugger support (Portable PDB, Source Link, embedded sources) are delivered by extending the bespoke emitter rather than by adopting Roslyn. The vendored Roslyn submodule that previously lived at `src/Roslyn` and the dependent `src/CodeAnalysis/` stub project were removed in the follow-up PR called out by ADR-0027; the fork repo (`DavidObando/gsharp-roslyn`) is preserved out-of-tree in case any of the four triggers in issue #51 (analyzer `ISymbol` interop, shared Roslyn workspaces, in-GSharp source generators, shared metadata-import at scale) materialises post-v1.0.

## Interpreter vs. emit

The in-process `Evaluator` remains the canonical reference for language semantics and is still the default execution backend for the REPL and most language tests. The emit pipeline mirrors its lowering behavior for any construct it supports; if the two ever disagree, the interpreter is treated as authoritative. Both paths share the `Binder`, `BoundProgram`, and lowering stages — only the final code-generation step differs.

## File map

| Path | What lives there |
| --- | --- |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | PE emitter. |
| `src/Core/CodeAnalysis/Emit/PortablePdbEmitter.cs` | Portable PDB emitter (Document, MethodDebugInformation, LocalScope, CustomDebugInformation). |
| `src/Core/CodeAnalysis/Symbols/ReferenceResolver.cs` | Reference-assembly loading + core-type lookup. |
| `src/Core/CodeAnalysis/Symbols/ClrTypeUtilities.cs` | Cross-context `Type` comparison helpers. |
| `src/Core/CodeAnalysis/Compilation/Compilation.cs` | Threads the resolver from `Compilation` through to the emitter. |
| `src/Compiler/Program.cs` | `gsc` command-line driver, response-file expansion, runtimeconfig.json generation. |
| `src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Core.Sdk.targets` | MSBuild `CoreCompile` override that invokes `gsc.dll` via the SDK's build task. |
| `src/Sdk/Gsharp.NET.Sdk/BuildTask.cs` | MSBuild task that materializes a response file and shells out to `dotnet gsc.dll`. |
