# ADR-0230: Scoped conditional symbol definitions

- **Status**: Accepted
- **Date**: 2026-11-24
- **Phase**: Language semantics / compiler configuration / translation
- **Issues**: [#6231](https://github.com/DavidObando/gsharp/issues/6231),
  [#6101](https://github.com/DavidObando/gsharp/issues/6101)
- **Related**: [ADR-0047](0047-attribute-syntax-and-declaration.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0175](0175-scoped-diagnostic-suppression.md),
  [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md),
  [ADR-0225](0225-prefix-bind-diagnostic-finality.md),
  issues [#6033](https://github.com/DavidObando/gsharp/issues/6033)
  and [#6100](https://github.com/DavidObando/gsharp/issues/6100),
  draft PR [#6102](https://github.com/DavidObando/gsharp/pull/6102)

## Context

G# already has a compilation-wide `Compilation.PreprocessorSymbols` set.
ADR-0047 makes `ConditionalAttribute` calls depend on that set.
Source files cannot currently define or undefine symbols.
The compiler driver and SDK do not currently forward `/define:` or `DefineConstants`.

Correcting conditional-call elision exposes the cs2gs integration defect in #6101.
A C# source file can enable a conditional call that generated G# incorrectly omits.
The translator must preserve that decision without changing public attribute metadata.
Delegate conversion is not a general solution: it can copy a mutable struct receiver.

G# uses scoped annotations instead of textual preprocessor directives.
ADR-0175 supplies the annotated-block syntax.
ADR-0186 supplies the closer semantic precedent: the nearest lexical annotation overrides the compilation default.
Diagnostic suppression's additive, case-insensitive rules do not fit conditional symbols.

This ADR defines symbol state.
[ADR-0231](0231-conditional-inclusion-and-symbol-queries.md) defines queries and conditional inclusion using the same state.
The maintainer approved implementation on November 24, 2026.
Acceptance specifies the contract; it does not claim these features are released.

## Decision

### 1. Symbols and the effective state

A conditional symbol is a case-sensitive compile-time name.
It is not a variable, constant declaration, type, or runtime value.
It has no storage and does not participate in ordinary name lookup.

The compilation-wide set supplies the base state.
The raw compiler adds no implicit symbols.
An absent symbol is undefined.

For each symbol, the nearest enclosing definition or undefinition determines its state.
If no enclosing annotation names that symbol, use the base state.
An annotation naming one symbol does not reset other symbols.
Leaving a scope restores the enclosing state.
This is a lexical rule, not dynamic scope.

There is no reset-to-base or exact-set annotation.
These operations are not necessary for the define/undefine contract.

### 2. Source spelling and placement

Introduce two compiler-intrinsic annotations:

```text
@DefineSymbol("NAME", ...)
@UndefineSymbol("NAME", ...)
```

They require no runtime assembly and produce no custom-attribute metadata.
Recognize the bare names and their `Attribute`-suffixed aliases before ordinary attribute lookup.
Qualified user-defined attribute names do not acquire these intrinsic semantics.

Permit the annotations on:

- A source file through the new `file` target.
- A type declaration, including each separate partial-type part.
- A function, constructor, property, accessor, field, or event declaration.
- A local function or local `let`, `var`, or `const` declaration.
- An ordinary annotated block.

Local-function placement requires extending the parser's existing statement-annotation acceptance.
The current parser accepts annotated blocks and local variable declarations, but rejects annotations before local functions.

The scope is the annotated declaration or block, including its initializers and nested bodies.
For example, a local-variable annotation covers its initializer, not later sibling statements.
Annotations do not propagate through symbol references or from a base type to a derived type.
They do not change a declaration's visibility, storage, or lifetime.

Reject them on parameters, generic parameters, enum members, return targets, and non-block executable statements.
Only `@file:` is an explicit target for these intrinsics.
Ordinary declaration and block forms have no target qualifier.

File annotations appear after `package` and `import` clauses, before the first declaration or top-level statement.
They may be interleaved with existing assembly and module annotations in that leading annotation section.
Their scope is the whole syntax tree.
An empty file can carry them.
A misplaced file annotation is an error.

This extends ADR-0047's closed target set with `file` for these two intrinsics only.
It does not permit arbitrary CLR attributes on files.

### 3. Arguments and diagnostics

Each annotation takes one or more string literals naming symbols.
Literal arguments keep scope discovery independent of constant-expression binding and symbol state.
General constant expressions and named arguments are not accepted.

After string-literal decoding, a name must be a nonempty identifier under G# identifier-character rules.
The spelling must not contain an `@` escape prefix or whitespace.
`true` and `false` are reserved and cannot name symbols.
Keyword-shaped names otherwise belong to the separate conditional-symbol namespace.
Matching uses ordinal case-sensitive comparison without case folding or Unicode normalization.
Unsupported C# identifier encodings must produce a translation diagnostic, not a silently changed symbol.

Repeating a definition or undefinition on the same node is harmless.
Defining and undefining the same name on one node is an error, regardless of annotation order.
Definition of one name and undefinition of another are independent.
Unknown names are valid because the symbol namespace has no declaration registry.

Malformed arguments, conflicting annotations, invalid targets, and misplaced file annotations require compiler errors at the offending source location.
Allocate diagnostic IDs during implementation; do not reuse unrelated attribute diagnostics for symbol-state errors.

### 4. Example and lexical boundaries

This example requires a compiler that implements this ADR:

```gsharp
import System
import System.Diagnostics

@file:DefineSymbol("TRACE")

@Conditional("TRACE")
func Log(message string) {
    Console.WriteLine(message)
}

@UndefineSymbol("TRACE")
func Quiet() {
    Log("omitted")

    @DefineSymbol("TRACE") {
        Log("included")
    }

    Log("omitted again")
}

func Main() {
    Log("included by the file definition")
    Quiet()
}
```

An annotated block remains an ordinary variable scope.
It can change local visibility and `using` or `defer` lifetime exactly as an unannotated block can.
Do not introduce transparent blocks for translation.

Calls inside lambdas, local functions, expression trees, async bodies, and deferred bodies use their original lexical source position.
Invoking such code from another symbol scope does not change its decision.
Partial declarations retain their own source-file state; combining their symbols must not combine their symbol environments.
REPL submissions likewise have independent syntax-tree scopes.
File annotations in one submission do not modify later submissions' base options.

### 5. Conditional calls and the shared query

Amend ADR-0047's conditional-call rule to use the effective state at the call's source position.
When a method has multiple conditional symbols, any defined symbol keeps the call.
Use the common source/imported attribute and override query from the conditional-call correction.
Do not add separate symbol calculations for static, instance, extension, base, or imported calls.

A retained call has ordinary dispatch and receiver-storage semantics.
Its receiver and arguments execute under the ordinary evaluation rules.
An omitted call evaluates neither receiver nor arguments.
It exports no operand assignments, nullability postconditions, or definite-assignment facts.
Existing rules for checking omitted operands remain unchanged.

Decide elision before lowering and retain that decision on the bound invocation.
Walkers, flow analysis, suspension completion, async/defer lowering, expression-tree lowering, and emission consume the same decision.
Do not recompute it from rewritten or absent syntax.
Compiler-generated invocations that represent a source call retain that call's original decision.

The caller's state controls elision, not the method declaration's symbol environment.
Preserve the callee's `ConditionalAttribute` metadata.
Neither symbol annotations nor their active sets are emitted.
This ADR does not change method-group semantics or implement conditional attribute classes.

### 6. Compiler, SDK, and editor inputs

Add these proposed csc-style compiler options:

```sh
gsc '/define:TRACE;FEATURE_X' /d:DEBUG Program.gs
```

Both options add symbols to the base set.
Repeated options accumulate.
Accept comma and semicolon separators, trim surrounding whitespace, and preserve case.
Reject a missing value; warn and ignore individual invalid names.
Use the same symbol-name validator as source annotations.
Do not use the diagnostic-ID parser, which folds case.
Response-file and direct command-line forms must agree.

The SDK and Bootstrap SDK forward evaluated `DefineConstants` through the same options.
Their property adapter accepts the conventional comma, semicolon, and whitespace-separated list.
Quote response-file values so list separators and whitespace survive argument parsing.
Include the normalized symbol set in compilation inputs and incremental-build fingerprints.
The language server must consume the same project/response-file state as the driver.
REPL and embedding callers can supply base state through compilation options.

This ADR does not add implicit `TRACE`, configuration, or target-framework symbols to the G# SDK.
Forward any symbols already supplied by evaluated project properties.
Csc-compatible option spelling is not a promise of C# SDK implicit defaults.
Any new implicit defaults require an explicit SDK policy and compatibility assessment before release.
In particular, assess `Debug`/`Trace` call behavior before releasing the imported-call correction in #6102.

### 7. Translation contract

cs2gs preserves the effective C# state for every conditional call in the selected source configuration.
Read that state from the Roslyn syntax tree and its parse options.
Reuse the existing conditional-symbol state index instead of scanning directives again for each call.
Resolve conditional symbols through the callee and its applicable overridden declarations.
Include invocations in initializers, lambdas, expression bodies, and nested expressions, not only expression statements.

For a translated file with one source environment:

1. Collect every conditional-symbol name relevant to its translated calls.
2. Emit `@file:DefineSymbol(...)` for names defined in the source environment.
3. Emit `@file:UndefineSymbol(...)` for relevant names undefined in that environment.
4. Sort names ordinally and omit empty annotations.

Explicit undefinitions prevent destination project flags from re-enabling calls omitted in C#.
Unused source symbols need not appear.
Do not union symbol sets from different source files.
Do not erase public conditional metadata or convert direct calls to delegates.

Translation must preserve origin environments when it moves or combines source bodies.
A generated file header is sufficient only when its relevant original environments agree.
Otherwise retain separate files or use an eligible narrower declaration scope with explicit overrides.
If a transformation cannot express the original environments faithfully, report a translation error.
Do not silently choose one source environment for combined code.

The existing removal of omitted expression-statement calls can remain.
Calls retained in generated syntax must still receive the original source decision.
This contract describes translation of one selected configuration, not later configuration switching of generated output.
It does not recover inactive C# syntax or extend the existing conditional-compilation translation policy.

Require a target SDK that implements the annotations.
For an older or unknown target compiler, diagnose required unsupported output rather than silently printing unusable syntax.
Tests may explicitly target the in-tree compiler.
Production generated-project support must be gated on a released SDK capability.

### 8. Implementation, validation, and release order

Keep one position-aware effective-symbol query shared by every caller.
A syntax-tree scope map can reuse ADR-0186's enclosing-span lookup pattern.
Build syntax-derived overrides without resolving declarations or binding annotation expressions.
Retain scope ownership so a consumer can distinguish an annotated node's inherited state from overrides on that node.
ADR-0231 consumes inherited state for inclusion and position state for expressions.
Cache only syntax-derived overrides by tree identity.
Keep compilation defaults in the compilation configuration, not a process-global cache.
An edit to annotations or base symbols must invalidate every binding that depended on the changed state.
Cross-tree dependencies still follow the compiler's ordinary invalidation rules.
Full and prefix binding must answer consistently at the same source position.
Synthesized syntax must retain source provenance or an already-decided call state.
Order diagnostics and generated annotation lists independently of hash iteration order.

Implementation must include focused ADR-0154 discrimination evidence for:

- Nearest define/undefine precedence, independent names, multiple OR symbols, and case sensitivity.
- File isolation, partial declarations, nested bodies, initializers, and REPL submission isolation.
- Direct, imported, instance, extension, base/override, conditional-access, and mutable-struct receiver calls.
- Once-only enabled effects and absent receiver/argument effects, including flow, async, defer, and expression trees.
- Argument and placement diagnostics with exact source locations.
- Real driver `/define:` and `/d:` behavior, response files, SDK incremental rebuilds, and matching editor diagnostics.
- Unchanged public conditional metadata and byte-identical repeated emissions.
- The unchanged #6101 native-C# differential, plus destination flags opposed by source-file undefinitions.
- Multi-file and relocated-source translation, deterministic output, and explicit old-target rejection.

This ADR alone does not implement or unblock #6102.
Keep its genuine consumer failure and review finding open until integration passes.

Implement compiler and tooling changes in G# with the specified published N-1 SDK.
Feature examples belong in test input strings until the pinned SDK supports them.
Coordinate compiler support, driver/SDK propagation, and the conditional-call correction so the consumer is correct before merge.
Never merge #6102 while waiting for a later translator correction.
Version-gate generated output until a supporting SDK is published.
After release, move the repository pin in a separate clean-clone/fixpoint-validated PR.
Do not change source inventory, SDK versions, or test expectations to make the feature build.

## Consequences

G# gains file-, declaration-, and block-scoped symbol state without a textual preprocessor.
The same model serves handwritten code, embedding, project configuration, and cs2gs output.
It preserves direct call semantics and public CLR metadata.

The parser needs a restricted `file` target.
Binding, incremental compilation, SDK tasks, editor inputs, and translation must agree on one symbol environment.
Generated output requires explicit target-version support.
This ADR does not promise C# configuration-portable generated source.

ADR-0231 specifies symbol queries and conditional declaration inclusion.
Macros and lexical token exclusion remain outside both ADRs.

## Alternatives considered

- **Enable-only annotations:** cannot represent a source `#undef` overriding a project-defined symbol.
- **Union-only scope rules:** cannot disable an outer definition in an inner scope.
- **Blocks only:** introduce variable/lifetime boundaries and cannot cover every initializer or declaration position.
- **Compilation-wide union of source symbols:** changes behavior between files with different symbol states.
- **Per-call unconditional annotation:** bypasses the useful symbol model and does not express undefined source state by itself.
- **Delegate lowering:** can copy mutable receivers and change dispatch or observable state.
- **Metadata erasure:** changes the public contract seen by downstream CLR consumers.
- **C# textual preprocessing:** expands the feature beyond symbol state and conflicts with the scoped-annotation direction.
