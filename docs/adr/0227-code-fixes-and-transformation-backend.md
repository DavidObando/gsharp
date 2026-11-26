# ADR-0227: Code fixes, a span-edit transformation backend and a diagnostic-delta gate

- **Status**: Implemented (phases 1–3 in #6122, #6135, #6138, #6139, #6141, #6143, #6144 and #6145; implementation notes in #6146; the maintainer accepted the decisions on Q1–Q9 on 2026-11-20)
- **Date**: 2026-11-18
- **Phase**: Tooling
- **Issue**: Refs [#6119](https://github.com/DavidObando/gsharp/issues/6119)
- **Related**: ADR-0099 (LSP nil quick fixes), ADR-0115 (cs2gs, C#→G# mapping), ADR-0169 (analyzer framework, "code-fix framework" deferred), ADR-0212 (semantic-query surface, §6 rule, §7a successor factories), ADR-0223 (compiler-as-library surface), ADR-0225 (prefix bind, `Properties` kept unchanged), ADR-0027 (no Roslyn in the compiler), issue #6070 (shared resolver state), Oats `docs/research/reports/Gated code transformation expert system.md`

## Context

G# has analyzers (ADR-0169), but it has no code fixes. ADR-0169 deferred "a code-fix framework (the language server's `CodeActionComputer` is the natural hook)". The maintainer decided that G# gets code actions driven by diagnostics and analyzers, and a backend that transforms trees. This ADR designs both. It does not implement them.

### 1. What exists today

**Language server.** `src/LanguageServer/CodeActionComputer.gs` handles `textDocument/codeAction` (`LspServer.gs:609`). It returns two kinds of action:

- *Sort imports* (`refactor.rewrite`). It sorts the text of the `ImportSyntax` members by ordinal string order and replaces the import block with one text edit.
- *Nullability quick fixes* (`quickfix`, ADR-0099), in `NullabilityQuickFixes.gs`. The computer reads `GetBodyDiagnostics` and then `GetDeclarationDiagnostics` of the compilation, keeps the diagnostics of the current file whose span overlaps the request range, and switches on the ID:
  - GS0158: `.` → `?.`. It finds the smallest `AccessorExpressionSyntax` whose right part covers the diagnostic. It then decides from syntax only that the receiver "looks nullable": a `?.` chain, a `nil` literal, or a name whose declaration's type-clause text ends with `?`. The edit replaces the dot token.
  - GS0154, GS0155, GS0156, GS0274: `expr` → `(expr ?? <default>)` and `expr` → `(expr!!)`. The provider **parses the diagnostic message text** for the two quoted type names, because the diagnostic has no structured data. It skips the literal `nil`.

The protocol model is a subset of LSP. `CodeActionParams` has `textDocument` and `range`, but no `context`, so the client's diagnostics and the `only` filter are not read. `CodeAction` has `title`, `kind` and `edit`, but no `diagnostics`, `isPreferred` or `data`. There is no `codeAction/resolve`, and the server declares only `quickfix` and `refactor.rewrite`. The enumerator skips syntax diagnostics and analyzer diagnostics. Each action computes its edit eagerly.

**Syntax tree.** The parser drops whitespace and comment tokens (`Parser.gs:132-138`). Only documentation comments are kept, in a side list. Nodes hold a `SyntaxTree` reference, the parent index is a dictionary on the tree, and the tree is immutable after `Parse` (ADR-0223 D5). There is no trivia, no `SyntaxRewriter`, no `SyntaxFactory`, no `ReplaceNode`, and no public `With*` member. `GSharpSyntaxWalker` reads only. Some tokens are synthesized by the parser (`SyntaxToken.IsSynthesized`) and have a zero-width span. `BoundTreeRewriter` exists, but it rewrites bound trees for lowering, not source.

**Text.** `SourceText` has no `WithChanges`, and Core has no `TextChange`. The only edit type is `GSharp.Formatting.TextEdit(Span, NewText)` in the formatter assembly.

**gsfmt.** `GSharpFormatter.Format(SourceText)` and `Format(SourceText, TextSpan)` return a `FormatResult` with line edits. The range form formats the whole file and keeps the edits on the lines of the range. The formatter re-lexes the text to recover comments and blank lines. It **returns no text when the parse has any error** (`GSharpFormatter.gs:884`).

**cs2gs printer.** `tools/cs2gs/Cs2Gs.CodeModel` has an output-only G# emit AST (about 140 `GNode` classes) and `GSharpPrinter`, which prints canonical G# and keeps attached comments. The project references `src/Core`. It has no positions and no path from a parsed G# tree to the model.

**Diagnostics.** `Diagnostic` has `Descriptor`, `AdditionalLocations` and `Properties` (ADR-0169). The compiler's report funnel (`DiagnosticBag.Report`, `DiagnosticBag.gs:526`) uses the `(location, id, severity, message)` constructor. So every compiler diagnostic has a `nil` descriptor and empty `Properties`, and its message arguments are lost after formatting. Oats S1 saw empty `Properties` and `AdditionalLocations` on all 79 sampled diagnostics. ADR-0225 decided not to put new data in `Properties`, because hosts compare it.

**Speculation.** `SemanticModel.GetSpeculativeTypeInfo(position, expression)` binds one expression in context and reports no diagnostic. `Compilation.WithReplacedSyntaxTree(old, new)` returns a one-shot compilation that binds from scratch and does not change the original. `Compilation.ReplaceSyntaxTree(old, new)` reuses the global scope for a body-only edit, but it **retires** the predecessor: it re-points its symbols at the new tree. `Compilation.BindPrefix` (ADR-0225) binds a prefix of the tree.

### 2. Consumers

1. **The language server** (`textDocument/codeAction`), and through it the VS Code and Visual Studio clients.
2. **In-process hosts** that link `GSharp.Core` (ADR-0223), first the Oats harness. Oats links only `GSharp.Core.dll` from the `Gsharp.Compiler` package. It wants to list the fixes for a diagnostic, apply one deterministically to source text, and check the result again. It also keeps a knowledge base of transformation programs. Some are written by hand, and some are mined or synthesized from repeated edits (PROSE/Refazer style).
3. **A gate on suggestions.** When the maintainer led IntelliCode, a suggested transformation was shown only when its pattern applied to the code being edited and applying it removed existing diagnostics or at least added none. The backend must compute that diagnostic delta cheaply. A warm Oats check costs 2–8 ms for each single-file program.

### 3. The first fixes

The Oats S0 dev split gives the most frequent C#-isms that local models write (issue #6119; counts are dev tasks whose first error was this one). ADR-0115 gives the G# spelling of each.

| C#-ism | Diagnostic | Tasks |
| --- | --- | --- |
| `new T(...)` | GS0125 "Variable 'new' doesn't exist." | 40 |
| `let` local assigned again | GS0127 "Variable '{0}' is read-only and cannot be assigned to." | 27 |
| `null` | GS0273 "'null' is not a literal in G#. Did you mean 'nil'?" | 17 |
| `or` / `and` / `not` in an expression | GS0125 "Variable 'or' doesn't exist." | 10 |

### 4. Constraints

- Oats links only `GSharp.Core`. Listing, applying and checking must work in Core with no other assembly. `GSharp.Formatting` is above Core, so Core cannot call gsfmt.
- ADR-0212 §6: the language server uses only public Core API. New types are public and enter the API snapshot (`test/Core.Tests/Baselines/gsharp-core-public-api.txt`).
- ADR-0027: no Roslyn in `GSharp.Core`. Roslyn's Workspaces code-fix types cannot be reused.
- Output must be deterministic: no hash order in the order of fixes or edits.
- Oats code is mostly broken code. A design that needs a clean parse (gsfmt, a model printed from a clean tree) cannot be the only path.

## Decision

All new types are in the namespace `GSharp.Core.CodeAnalysis.CodeFixes` in `GSharp.Core`, except the text types of D1. They are plain classes, not `data class` types, for the same reason as ADR-0225 D1.

### D1. Tree editing model: span edits on the original text, then a re-parse

**Recommendation: option B.** A fix is a set of text changes on token and node spans of the original `SourceText`. The backend applies the changes and parses the result again. Formatting is an optional step of the host.

The parsed tree has no trivia, but the `SourceText` keeps all of it. An edit that replaces only the tokens that change cannot remove a comment that is outside those tokens. Most fixes in section 3 change one token. So span edits keep comments and give minimal diffs for the fixes that matter now, at a small fraction of the cost of option A.

New text types in `GSharp.Core.CodeAnalysis.Text`:

```gsharp
class TextChange {
    init(span TextSpan, newText string)
    prop Span TextSpan
    prop NewText string
}

partial class SourceText {
    // The changes refer to positions in this text. They must not overlap.
    // Two insertions at one position keep their order in the array.
    // The new text keeps FileName (the document identity) and has no RawBytes, because the
    // bytes on disk no longer match it (the PDB emitter checksums RawBytes).
    func WithChanges(changes ImmutableArray[TextChange]) SourceText
}
```

The editor that providers use:

```gsharp
class SyntaxEditor {
    init(tree SyntaxTree)
    prop OriginalTree SyntaxTree

    func ReplaceToken(token SyntaxToken, newText string)
    func ReplaceNode(node SyntaxNode, newText string)
    func RemoveToken(token SyntaxToken)            // also removes one following space on the same line
    func RemoveNode(node SyntaxNode)
    func InsertBefore(nodeOrToken SyntaxNode, text string)
    func InsertAfter(nodeOrToken SyntaxNode, text string)

    // The source text of a node, comments and line breaks inside it included.
    // Use it to move or wrap a subtree without losing its inner comments.
    func OriginalText(node SyntaxNode) string

    // Marks the text that an edit inserted as a placeholder (Applicability.HasPlaceholders).
    func MarkPlaceholder(insertedText TextSpan)

    func GetChanges() ImmutableArray[TextChange]  // sorted by position, then by call order
}

// One SyntaxEditor for each tree of a compilation (phase 2).
class MultiDocumentEditor {
    func EditorFor(tree SyntaxTree) SyntaxEditor
}
```

Rules:

1. A change refers to the original tree only. A provider never edits the result of another edit. Composition is the job of FixAll (D3).
2. An edit on a synthesized or missing token is an error (`InvalidOperationException`). The token has no source text. A provider edits the real token next to it.
3. `ReplaceNode` replaces the text from the first real token to the last real token of the node. Comments inside that span are lost unless the new text contains `OriginalText` of the inner nodes. A provider uses the smallest node or token that the fix changes.
4. Overlapping changes in one editor are an error. Two insertions at one position are allowed and keep their order.
5. Providers write new code as G# text. Phase 1 has no `SyntaxFactory`. The backend parses the result, so a fragment that does not parse is visible in the delta (D4).

**Formatting.** The language server can run `GSharpFormatter.Format(text, span)` on the lines that a fix changed, when the result parses with no error. If gsfmt fails or the result has a parse error, the server sends the unformatted edit. Core never formats. Oats can call gsfmt itself if it references `GSharp.Formatting`. Phase-1 fixes produce formatted text without gsfmt, so the step is off by default for them.

**Options considered:**

| Option | Comments kept | Minimal diff | Works on broken code | Cost |
| --- | --- | --- | --- | --- |
| A. Full-fidelity red/green tree with trivia, `ReplaceNode`, `SyntaxFactory`, `NormalizeWhitespace` | yes, by construction | yes | yes | Very high. The parser, about 160 node classes, the generated child accessors, span caches, the parent index and gsfmt all change. Memory grows for every compilation, also in `gsc`. |
| **B. Span edits + re-parse + optional gsfmt** | yes outside the edited tokens; inside a replaced node only through `OriginalText` | yes | yes | Low: two text types, an editor, a re-parse per candidate. |
| C. cs2gs `Cs2Gs.CodeModel` + `GSharpPrinter` | only comments attached to model nodes | no, it prints the whole unit | no, it needs a model built from a clean tree | It lives in `tools/` and references Core, so Core cannot reference it. A parse-tree → model converter for 140 node kinds does not exist. |

Option C is rejected for fixes. The printer is a whole-unit, output-only printer (ADR-0115 §A states that the compiler tree and the emit AST have different contracts). A fix that prints the whole file from a model changes every line that is not in canonical form, and it cannot run on code that does not parse. The printer stays useful to cs2gs.

Option A stays possible later. D1's public types do not depend on how the tree stores trivia: `SyntaxEditor` can later produce its changes from a trivia-aware tree. Phase 4 has a gate for that decision (see Phasing).

### D2. Fixes, providers and registration

```gsharp
enum Applicability {
    MachineApplicable,   // correct with no review; a host can apply it unattended
    MaybeIncorrect,      // probably what the user wants; needs review; can change behavior
    HasPlaceholders,     // contains placeholder text the user must replace; never applied unattended
    Unspecified          // the provider does not know; treated as MaybeIncorrect
}

class CodeFix {
    prop Title string
    prop EquivalenceKey string           // same key = same kind of fix; FixAll groups by it
    prop Applicability Applicability
    prop Diagnostics ImmutableArray[Diagnostic]   // the diagnostics this fix is for
    prop ProviderId string               // stable name of the provider or program

    // Computes the changes. Lazy, so a list that is not gated can show titles first and
    // compute edits in codeAction/resolve. A gated fix computes its changes at list time
    // (the gate needs them) and caches them. The result for one input is always the same.
    func GetChanges(cancellationToken CancellationToken = default(CancellationToken)) FixChanges
}

class FixChanges {
    prop Documents ImmutableArray[DocumentChanges]   // ordered by file path, ordinal
}

class DocumentChanges {
    prop Tree SyntaxTree                    // the original tree
    prop Changes ImmutableArray[TextChange] // positions in Tree.Text
    prop Placeholders ImmutableArray[TextSpan]  // spans in the changed text, for HasPlaceholders
}

abstract class GSharpCodeFixProvider {
    abstract prop FixableDiagnosticIds ImmutableArray[string]
    abstract func RegisterCodeFixes(context CodeFixContext)
    // nil: no FixAll. The default is the batch fixer of D3.
    open func GetFixAllProvider() FixAllProvider? -> FixAllProvider.Batch
}

class CodeFixContext {
    prop Diagnostic Diagnostic
    prop Tree SyntaxTree
    prop Compilation Compilation
    prop SemanticModel SemanticModel        // created on first read
    prop CancellationToken CancellationToken
    func CreateEditor() SyntaxEditor
    // A fix in the diagnostic's tree. The editor can mark placeholder spans (HasPlaceholders).
    func RegisterFix(title string, equivalenceKey string, applicability Applicability,
                     compute (SyntaxEditor) -> void)
    // A fix that changes more than one tree of the compilation (phase 2).
    func RegisterFix(title string, equivalenceKey string, applicability Applicability,
                     compute (MultiDocumentEditor) -> void)
}
```

**Registration.** `CodeFixRegistry` holds the providers, in a fixed order:

1. The built-in providers in Core, for compiler IDs (GS####). They register first, in source order.
2. Providers loaded from analyzer assemblies. A provider class has `@GSharpCodeFixProvider` and a parameterless constructor. `GSharpAnalyzerHost` loads it from the same assemblies as the analyzers, sorted by assembly name and then by type name.
3. Providers that a host adds with `CodeFixRegistry.Add(provider)`. This is how Oats adds its programs (D6). Code fixes must not depend on attribute discovery only.

A provider names the IDs that it fixes. An analyzer does not declare fixable IDs: the fix side declares them, as in Roslyn, so an analyzer and its fixes can ship in different assemblies. The registry rejects a provider whose `FixableDiagnosticIds` is empty. A provider that throws is isolated: the service drops its fixes and reports GS9308 ("code-fix provider failed"; the next free ID after GS9307), like GS9302 for analyzers.

**Service.** `CodeFixService` is the single entry point for both consumers:

```gsharp
class CodeFixService {
    init(registry CodeFixRegistry)
    func GetFixes(compilation Compilation, diagnostic Diagnostic, ct CancellationToken) ImmutableArray[CodeFix]
    func GetFixes(compilation Compilation, tree SyntaxTree, span TextSpan, ct CancellationToken) ImmutableArray[CodeFix]
    func Apply(fix CodeFix, ct CancellationToken) ImmutableArray[SyntaxTree]   // re-parsed trees
    func ComputeDelta(compilation Compilation, fix CodeFix, options DeltaOptions, ct CancellationToken) DiagnosticDelta
    func FixAll(scope FixAllScope, equivalenceKey string,
                options FixAllOptions, ct CancellationToken) FixAllResult
}

// The targets of a FixAll. The factories are the only constructors.
class FixAllScope {
    shared {
        func Document(compilation Compilation, tree SyntaxTree) FixAllScope
        func Project(compilation Compilation) FixAllScope
        func Solution(compilations ImmutableArray[Compilation]) FixAllScope   // handled in the given order
    }
    prop Kind FixAllScopeKind      // Document | Project | Solution
    prop Compilations ImmutableArray[Compilation]
    prop Tree SyntaxTree?          // Document scope only
}
```

Fix order is deterministic: by diagnostic position, then registry order, then registration order inside the provider.

**Compiler diagnostics.** Compiler IDs get fixes from built-in providers, as analyzer IDs do. The existing fixes parse message text because the funnel discards data. Phase 1 changes the funnel so that a compiler diagnostic keeps its `DiagnosticDescriptor` and its message arguments:

```gsharp
partial class Diagnostic {
    prop MessageArguments ImmutableArray[string]   // the formatted arguments, in order; empty when unknown
}
```

`Descriptor` becomes non-nil for compiler diagnostics. `Properties` does not change (ADR-0225). The bag's de-duplication (`DiagnosticBag.gs:685-705`) compares location, additional locations and `Properties`, not the descriptor, and the new member is not added to it. The analyzer driver reads `Descriptor.IsEnabledByDefault` (`GSharpAnalyzerDriver.gs:221`) on analyzer diagnostics. **Verified (phase 1):** `GetDiagnostics()` gives the same ID, severity, span, message, property count and additional-location count before and after the change for 1644 diagnostics: every `.gs` file in `samples/` and the Core test data (194 files), plus the 327 broken programs of the Oats S0 dev repair log. Severity configuration copies the diagnostic with `WithSeverity`, which keeps the new member.

**Structured fix-its on the diagnostic.** Some report sites already know the fix (GS0273 names `nil`; "did you mean" messages name a symbol). Options:

- (a) Put the fix in `Properties`. Rejected, for the reason of ADR-0225: hosts compare `Properties`.
- (b) Add `Diagnostic.Suggestions ImmutableArray[DiagnosticSuggestion]`, where a suggestion is `(Message, Changes ImmutableArray[TextChange], Applicability)`, like a rustc suggestion. A built-in `SuggestionFixProvider` turns each suggestion into a `CodeFix`. The binder must not compute expensive suggestions on the hot path, so a site adds a suggestion only when the data is already at hand.
- (c) No fix-it field; providers only.

**Recommendation: (c) in phase 1 and (b) in phase 3.** Providers are enough for the first fixes, and (b) needs a change at each report site. When (b) exists, `gsc` can print suggestions and Oats gets the fix-it field that S1 found empty.

### D3. FixAll and conflicts

`FixAllScope` (D2) is `Document` (one tree of one compilation), `Project` (one compilation) or `Solution` (a list of compilations that the host gives). The service handles the compilations one by one, in the given order.

The default `FixAllProvider.Batch` works like Roslyn's batch fixer:

1. Collect the diagnostics in scope whose ID a provider with the equivalence key fixes.
2. Compute every fix against the **original** snapshot. Keep the fixes with the equivalence key.
3. Sort the changes of each document by start position, then by diagnostic order.
4. Keep a change set only when none of its changes overlaps a change set already kept. A fix with more than one change is kept or dropped as a whole. Two insertions at one position conflict, unless they come from one fix.
5. Apply the kept changes in one `WithChanges` call for each document, and parse again.

`FixAllResult` reports the applied fixes, the dropped fixes with the reason (`Overlap`, `ProviderFailed`, `ApplicabilityFiltered`, `DeltaRejected`), and the new trees. `FixAllOptions` has:

- `MinimumApplicability`. The default is `MachineApplicable` for unattended hosts. The language server passes `MaybeIncorrect` when the user starts a FixAll.
- `MaxRounds`. The default is 1. With N > 1 the service runs FixAll again on the result, to pick up fixes that a conflict dropped, until no fix applies or N rounds end. Each round recomputes diagnostics.
- `Gate`. An optional delta policy (D4) on the whole result.

### D4. The diagnostic-delta gate

```gsharp
class DiagnosticDelta {
    prop Removed ImmutableArray[Diagnostic]     // before, not after
    prop Added ImmutableArray[Diagnostic]       // after, not before
    prop Persisting ImmutableArray[Diagnostic]  // in both; spans in the new text
    prop TargetRemoved bool                     // every diagnostic in CodeFix.Diagnostics is removed
    prop ParseOnly bool                         // true when the check stopped after the parse stage
    prop Elapsed TimeSpan
}

class DeltaOptions {
    prop Analyzers ImmutableArray[GSharpDiagnosticAnalyzer]   // run before and after; default empty
    prop StopOnNewSyntaxError bool      // default true
    // The host's severity policy (/nowarn, /warnaserror, .editorconfig), applied to every
    // diagnostic before and after: it returns the diagnostic with its effective severity, or
    // null to drop it. Default: the identity. Core applies source suppressions itself.
    prop DiagnosticFilter (Diagnostic) -> Diagnostic?
}
```

**Scope of the comparison.** The delta compares the diagnostics of the **whole compilation** before and after the **complete** edit set of the fix (or of the FixAll result), with every edited tree replaced at once. A declaration change in one file can break a caller in another file, so the edited tree alone is not enough. Diagnostics are matched within the same document. Each edited document has its own span map; an unedited document has the identity map.

**Matching.** A diagnostic before and a diagnostic after match when the ID, the effective severity and the message are equal and the span maps across the changes. A severity change (for example a warning that `/warnaserror` promotes) is a removal plus an addition. A position before the first change keeps its value. A position after a change moves by the length difference of the changes before it. A span that intersects a change has no mapped span; it matches a diagnostic after with the same ID, severity and message whose span intersects the changed region. Each diagnostic matches at most one other, in position order. The result is a fact. The consumer decides the policy.

**Computation.**

1. Apply the changes and parse the new text. `SyntaxTree.Parse` is cheap compared with a bind.
2. Compare syntax diagnostics. If a new syntax error exists and `StopOnNewSyntaxError` is set, return with `ParseOnly = true`. No bind is done.
3. Otherwise bind a snapshot compilation with every edited tree replaced, and read all its diagnostics. Phase 1 adds `Compilation.WithReplacedSyntaxTrees(pairs)`, the multi-tree form of `WithReplacedSyntaxTree`: it binds from scratch, has no body cache and does not re-point symbols. **Never use `ReplaceSyntaxTree`**: it retires the host's compilation.
4. If `Analyzers` is not empty, run the analyzer driver with those analyzers on both compilations.

The "before" diagnostics come from the host's compilation and are computed once for each request, not once for each candidate.

**Cancellation.** The token of a `GetDiagnostics` call cancels only the caller's wait, and a successor compilation does not inherit `WorkBudget`. So the service gives each snapshot compilation its own `CompilationWorkBudget` whose token is the request token, before its first query. The service binds the candidate on the calling thread and waits for it, so a cancelled request leaves no candidate bind running. Cancellation never reaches the host's compilation.

**Cost.** Step 3 is a full bind of a new compilation. For an Oats single-file program this is one warm check (2–8 ms). In a large project it is the cost of binding the project. Phase 2 adds a body-local speculative bind: when all changes are in one function body, bind only that body against the existing global scope, without re-pointing symbols. This is the `GetSpeculativeStatementDiagnostics` follow-up of ADR-0225 D6.7, generalized to a body. It applies only when the changes are inside one body and the signature of the enclosing member is unchanged, so no other body can see the change. Otherwise it falls back to step 3.

**Resolver sharing.** A snapshot compilation uses the host compilation's `ReferenceResolver` and the same assembly name. #6070 is a hazard between compilations with *different* assembly names on one resolver. Compilations with one assembly name on one resolver are what the ADR-0223 D5 stress test (`Adr0223SharedResolverStressTests`) checked. The service takes no lock of its own. A host whose resolver also serves compilations with other assembly names must keep its ADR-0223 D5 serialization: it holds that serialization from the construction of the snapshot compilation to its last query, or it gives `DeltaOptions` an isolated resolver. In phase 1 the language server checks the candidates of one request one after another, inside the request's existing project scope. The phase-1 LSP work verifies that no other request can use a resolver of another assembly name concurrently, and uses an isolated resolver for gate checks if it cannot verify that.

**Budget.** Targets, to measure before the gate is on by default in the language server:

- Oats: the delta of one candidate costs at most one warm check of the program (p95).
- Language server: a `codeAction` request that gates up to 8 candidates finishes in 100 ms at p95 on the repository samples, with the phase-2 body path. A request that would exceed the budget gates the candidates in order and returns the ungated rest as follows: hand-written built-in fixes are shown, data-defined fixes (D6) are not.

**Policies.** `DeltaPolicy` is a small set of named predicates over a `DiagnosticDelta`:

- `NoNewDiagnostics`: `Added` is empty.
- `RemovesTargetNoNewErrors`: `TargetRemoved` and no error in `Added`.
- `NetImprovement`: `Removed` is not empty and the error count goes down.
- `PhaseAware`: when every target is a syntax diagnostic, judge only syntax diagnostics. Body diagnostics that the fix makes reachable do not count against it.

The default policy is the IntelliCode rule: the pattern applies and the edit adds no new diagnostic (`NoNewDiagnostics`). Errors and warnings count, and compiler and analyzer diagnostics count alike (decision Q3). A fix of a parse error often unmasks bind errors that the parse error hid, and a strict rule then rejects a correct fix. So `PhaseAware` is allowed, but only for a fix whose targets are all parse errors. `NetImprovement` stays available to hosts, but it is not the default.

### D5. Applicability

Every `CodeFix` has an `Applicability` (D2). The provider sets it, and it states the provider's knowledge, not the gate's result. Rules:

- `MachineApplicable` only when the fix is correct for every input that the guard accepts. The provider must be conservative, as rustc tells lint authors.
- A fix that can change runtime behavior (`!!`, a default value, a mutability change of a field) is at most `MaybeIncorrect`.
- A fix with placeholder text is `HasPlaceholders` and lists the placeholder spans.
- A host can lower the applicability of a fix, never raise it. Oats lowers a mined program to `MaybeIncorrect` until the program has its evidence (the report's 30-distinct-task rule).

Use in the language server:

- `isPreferred = true` for the one `MachineApplicable` fix of a diagnostic.
- `HasPlaceholders` becomes a snippet edit where the client supports `SnippetTextEdit` (LSP 3.18). Otherwise the server sends the text with the placeholder and selects it.
- An unattended FixAll (a future `gsfmt --fix` or `gsc` switch) applies `MachineApplicable` only.

### D6. Data-defined transformations

**In scope, as a provider kind (phase 3), in a separate assembly** (decision Q7): `GSharp.CodeAnalysis.Transformations`, which references `GSharp.Core`. Core keeps the provider API that the interpreter implements. Oats references the extra assembly. The backend must host fixes that are not hand-written providers, because Oats keeps a knowledge base of mined and synthesized programs. A `TransformationProgram` is data:

```gsharp
class TransformationProgram {
    prop Id string                      // stable; also the equivalence key
    prop Version string                 // content hash of the canonical JSON form
    prop Trigger ProgramTrigger         // diagnostic IDs, and an optional message-argument match
    prop Pattern SyntaxPattern          // a tree pattern with named captures
    prop Guard ImmutableArray[GuardPredicate]   // all must hold
    prop Edits ImmutableArray[EditOperation]
    prop Applicability Applicability    // the maximum; a host can lower it
    prop Provenance ProgramProvenance   // HandWritten | Mined | Synthesized, source, evidence counts
}
```

- **Trigger.** Programs are code fixes: each has at least one diagnostic ID, and the pattern is anchored at the diagnostic. Refactorings without a diagnostic are out of scope for programs. They need a refactoring registration with a syntax anchor, which a later ADR can add.
- **Pattern.** A node kind with child constraints, and a capture name on any sub-pattern. A token constraint matches kind and text. A wildcard matches any node. A pattern is anchored at the node or token that the trigger diagnostic covers, so the matcher does not walk the whole tree.
- **Guard.** Predicates over captures. Syntax facts: kind, token text, missing token, parent kind, same line. Semantic facts through public `SemanticModel` queries only: the symbol kind of a name, a local declared with `let`, the type of an expression (`GetTypeInfo`, `GetSpeculativeTypeInfo`), whether a name resolves to a type, a reference type or a value type. The list is closed. A predicate that a program names but the backend does not know makes the program invalid at load time.
- **Edit operations.** `ReplaceToken(capture, text)`, `Replace(capture, template)`, `Delete(capture)`, `InsertBefore(capture, template)`, `InsertAfter(capture, template)`. A template is text with `${capture}` slots, which take the `OriginalText` of the capture. A move is a delete and an insert. These are the update, delete, insert and move operations of Refazer's edit language, on G# nodes.
- **Interpreter.** `ProgramFixProvider(programs)` is a `GSharpCodeFixProvider`. It matches, checks the guards and turns the edits into `SyntaxEditor` calls. It is pure and deterministic. The canonical form is JSON with a published schema, so Oats can store, hash, diff and freeze programs, as its pre-registration requires.

The pattern language is deliberately small. It has no loops and no arbitrary code. A transformation that needs more is a hand-written provider. Persisted mined programs had very low precision without a held-out filter (Overwatch: 0.58%). So the backend records provenance and evidence, and every data-defined fix goes through the delta gate. Precision thresholds are the host's policy, not the compiler's.

### D7. Language server wiring

- `CodeActionParams` gets `context` (`diagnostics`, `only`, `triggerKind`).
- `CodeAction` gets `diagnostics`, `isPreferred` and `data`. The server declares `resolveProvider: true` and handles `codeAction/resolve`. For a gated fix, the list request computes the edit and runs the gate; resolve returns the cached edit. For a fix that is not gated, the list request computes only the title, and resolve computes the edit.
- Kinds: `quickfix` for fixes, `source.fixAll.gsharp` for a document FixAll of `MachineApplicable` fixes, `refactor.rewrite` for sort imports.
- The computer reads syntax, declaration, body and analyzer diagnostics of the document. Today `DocumentSyncHandler` runs `GSharpAnalyzerDriver.Run` in its debounced phase and converts the result to LSP diagnostics at once; it keeps no Core diagnostics. Phase 1 caches analyzer diagnostics keyed on the `Compilation` object and the analyzer set (keyed by reference, in a `ConditionalWeakTable`), not on the document version. A compilation snapshot is immutable and changes whenever any file of the project changes, and the analyzer set is replaced when the project's analyzer configuration changes, so a cross-file edit or an analyzer change makes a new key. A document version alone is not safe: another file or the analyzer configuration can change while the version stays the same. The computer runs the analyzers only when a provider fixes one of their IDs.
- `NullabilityQuickFixes` moves to Core as built-in providers. The language server keeps only the protocol mapping. Sort imports stays in the server as a refactoring, because it is not a diagnostic fix.
- **Versions.** `CodeActionParams.textDocument` is a `TextDocumentIdentifier` with no version, and `DocumentContent` keeps none today. Phase 1 adds the client's version to `DocumentContent`, captured with the text in one step when `didOpen` or `didChange` stores the snapshot. The computer records that version in `data` for each document that a fix edits. Resolve returns no edit if any of those versions is not current. The edit is a versioned `WorkspaceEdit.documentChanges` (`TextDocumentEdit` with `OptionalVersionedTextDocumentIdentifier`) for every edited document, so the client rejects an edit that became stale after the response. The server falls back to `changes` only when the client does not declare `workspaceEdit.documentChanges`.

### D8. First fixes (phase 1)

Each provider has a syntax guard and, where the table says so, a semantic guard. **Verified parse shapes (phase 1):**

- `return new T(x)` is two statements: `return new` (a name, GS0125 on `new`) and the call `T(x)`. Removing the token `new` and its space gives `return T(x)`. A construction has no symbol in `GetSymbolInfo` and has the constructed type in `GetTypeInfo`; a function call has a symbol. `new S(1)` for a struct also reports GS0155 and has no type, so it gets no fix.
- `a or b` and `a and b` are three statements; GS0125 is on the word. In a pattern the words are combinators and report nothing.
- `not a` reports GS0125 on `not`. `not (a and b)` reports GS0130 ("Function 'not' doesn't exist") on `not`, and GS0005 twice and GS0125 for `and`. Replacing `and` removes all three.
- GS0127 is reported on the operator token (`=` or `+=`); a compound assignment parses as `EventSubscriptionExpression`.

| Fix | Trigger | Guard | Edit | Applicability |
| --- | --- | --- | --- | --- |
| `null` → `nil` | GS0273 | the token text is `null` | `ReplaceToken` | MachineApplicable |
| `new T(...)` → `T(...)` | GS0125 with argument `new` | the next real token on the same line starts a name that resolves to a reference type | `RemoveToken(new)` | MachineApplicable |
| `new S(...)` for a value type | GS0125 with argument `new` | the name resolves to a struct | none in phase 1: G# needs `S{Field: v}` (ADR-0115 B.16), which needs the member order | — |
| `let` → `var` | GS0127 | the target resolves to a local declared with `let` in this tree | `ReplaceToken(let → var)` at the declaration | MachineApplicable |
| `let` field → `var` field | GS0127 | the target is a field | `ReplaceToken` | MaybeIncorrect (changes the type's surface) |
| `a or b`, `a and b` → `\|\|`, `&&` | GS0125 with argument `or` / `and` | an expression position, not a pattern: `or`, `and` and `not` are contextual pattern keywords (`Parser.Patterns.gs:159-192`) | `ReplaceToken` | MachineApplicable |
| `not x` → `!x` | GS0125 or GS0130 on `not` | as above | remove `not` and its space, insert `!` before the next token; no parentheses, because the parser has not attached the operand to `not` | MaybeIncorrect |
| nullability fixes of ADR-0099 | GS0158, GS0154/0155/0156/0274 | as today, but read `MessageArguments`, not the message text | as today | MaybeIncorrect |

GS0127 is reported at the assignment, but the edit is at the declaration. The provider needs the declaration of a local symbol. **Verified (phase 1):** the public path exists. `GetSymbolInfo` on the assignment (or on the target name of a compound assignment) gives the `LocalVariableSymbol`, and its `DeclaringSyntaxNodes` holds the identifier token of the declaration, whose parent `VariableDeclarationSyntax` has the `let` keyword. No new API is needed.

Integer-cast fixes (GS0156 `int64` → `int32`, 28 tasks) need an expected-type query and are in phase 2.

## Phasing

**Phase 1: backend, API, LSP, delta gate, first fixes.**

- `TextChange`, `SourceText.WithChanges`, `SyntaxEditor` (D1).
- `CodeFix`, `Applicability`, `GSharpCodeFixProvider`, `CodeFixRegistry`, `CodeFixService` with `GetFixes`, `Apply` and `ComputeDelta` (full-bind path) (D2, D4).
- `Diagnostic.MessageArguments` and a non-nil `Descriptor` for compiler diagnostics (D2).
- The fixes of D8 and the moved nullability fixes.
- LSP: `context`, `diagnostics`, `isPreferred`, `data`, resolve, all diagnostic sources (D7).
- The full delta gate is available to Oats through `ComputeDelta`. In the language server, every fix gets the parse-only stage of the gate (D4 step 2: no new syntax error, no bind). The full gate is on in the server only for data-defined fixes, which arrive in phase 3, and for others after the phase-2 budget is measured (Q4).

**Phase 2: FixAll and the fast path.**

- Batch FixAll at all three scopes, `source.fixAll.gsharp`, `MaxRounds` (D3).
- The body-local speculative bind for the delta, and the LSP budget measurement (D4).
- Integer-cast fixes, and fixes for analyzer IDs (GSA0004–GSA0007 where a fix is mechanical).
- Snippet edits for `HasPlaceholders`.
- Multi-document fixes (`MultiDocumentEditor`), for example a `let` field used from another file.

**Phase 3: data and suggestions.**

- `TransformationProgram`, its JSON schema and `ProgramFixProvider` in `GSharp.CodeAnalysis.Transformations` (D6).
- `Diagnostic.Suggestions` and `SuggestionFixProvider` (D2 option b).
- A command-line FixAll for `MachineApplicable` fixes (`gsfmt --fix` or a `gsc` switch; open question Q6).

**Phase 4: decision gate on trivia.** Measure, on the fixes that exist then, how many edits lose a comment, and how many providers write `OriginalText` composition by hand. If the loss or the code is significant, write an ADR for a trivia-preserving tree (option A). Otherwise keep option B.

## Testing

All tests obey ADR-0154: each new test fails on the code before the change.

- **Golden fix tests.** A verifier like `GSharpAnalyzerVerifier`: marked source in, expected source out. `VerifyFix(provider, before, after, equivalenceKey?)` checks that the fix applies, the result is exactly `after`, and the target diagnostic is gone. `VerifyNoFix(provider, source)` checks the guards. Each fix in D8 has a case with a comment next to and inside the edited span.
- **FixAll tests.** Several diagnostics in one document and across two files. Overlapping fixes where the first in order wins and the other is reported as `Overlap`. Determinism: the same result in 20 runs, and the same result with the files given in reverse order.
- **Delta tests.** One case for each policy of D4: a fix that removes the target, one that adds an error, one that adds a syntax error (parse-only exit), and a parse-error fix that unmasks a bind error (`PhaseAware` accepts it, `NoNewDiagnostics` rejects it). A test that `ComputeDelta` does not change the host's compilation: its symbols, diagnostics and body cache are the same after the call.
- **Editor tests.** Edits on synthesized and missing tokens throw. Overlap throws. Insertions at one position keep order. `OriginalText` keeps inner comments.
- **Program tests (phase 3).** Each guard predicate, the JSON round trip, the content hash, and an unknown predicate rejected at load time.
- **LSP tests.** Extend `test/LanguageServer.Tests/CodeActionHandlerTests.gs`: `context.only` filtering, resolve, `isPreferred`, stale versions, and the moved nullability fixes with the same titles and edits as today.
- **Performance.** A benchmark of `ComputeDelta` on the repository samples and on the Oats dev programs, which reports p50 and p95 against the budgets of D4.

## Implementation notes (phases 1–3)

The implementation follows the decision, with these differences and results:

- **Compiler suggestions replace one provider.** GS0273 (`null` → `nil`) is a `Diagnostic.Suggestions` entry at its report site (D2 option b), not a provider. GS0302 (`->` switch arm → `:`) also has a suggestion. `CodeFixService` offers suggestions before provider fixes.
- **Names.** A fix that edits several trees uses `CodeFixContext.RegisterMultiDocumentFix` and `MultiDocumentEditor`. `FixAll` takes a nullable equivalence key: `null` takes the first fix of each diagnostic (used by `source.fixAll.gsharp`). `FixAllDocument.GetChanges()` gives one change between the common prefix and suffix of the texts.
- **FixAll conflicts.** Two changes of different fixes conflict when they share a character, or when an insertion touches the other change.
- **Editor guards.** The editor rejects a token whose text is not the source text at its span (parser-generated tokens of desugared forms), and a node that borrows tokens of another node (payload-enum cases). `SyntaxNode.FindToken` returns the smallest real token at a position.
- **Language server.** `source.fixAll.gsharp` runs only when the request's `only` asks for it. Analyzer diagnostics are computed only when a provider fixes one of the analyzers' IDs, and are cached per compilation snapshot.
- **Programs edit only their captures.** A program cannot express an edit at a declaration that the pattern does not reach, such as `let` → `var` at the declaration of a reassigned variable. That fix stays a provider.
- **Semantic-model gaps (closed).** `GetSymbolInfo` on an implicit-receiver field assignment answered the `this` parameter (#6126), and the receiver of a member access that reports GS0158 had no symbol or type (#6127). Both are fixed in the semantic model: an assignment answers the variable, field or property it writes (also for `this.N = 1`, `c.N = 1`, `N += 1` and a bare auto-property write), and the receiver of a failed member access keeps its symbol and type. The `let` → `var` provider, the program interpreter and the GS0158 `?.` fix now take the semantic model's answer first. The `?.` fix decides from the receiver's type, not from the spelling of a declaration with the receiver's name, and declines the target of a compound assignment. The identifier tokens of an assignment answer too: the target (`N` in `N = 1` or `c.N = 1`) and the receiver of a member write (`c` in `c.N = 1`, also when the write fails GS0158). Three more gaps are closed the same way. Expressions inside a function literal answer as in a function body (#6149); in an expression-bodied literal (`() -> c.N`) the expression answers, not the block and `return` the binder wraps it in. A call that fails to bind keeps the arguments it bound, whatever the error (#6150), and its receiver (#6151, GS0159 included) on its `BoundErrorExpression` (`FailedArguments`, `FailedReceiver`), as a failed member access keeps its receiver; only the semantic-model index visits them. The binder records the last bound value of each argument of a call, keyed by the argument as the argument list holds it: the expression dispatch, the `ref`/`out` argument bind (a conditional reference, an inline declaration) and the function-literal binders all record, so a literal bound against a candidate's delegate type is kept too, and hands it to the error when the call completes (`BinderContext.RecordCallArgument`/`CompleteCall`). A call completes at its call-binding entry point, with its receiver, and again when the expression of its syntax finishes binding (`CompleteCallSyntax`), which covers paths that bypass the entry points (a call through a tuple element, the unified instance/static selection of a Color Color receiver); an indirect call (`(f)(x)`) completes with its callee, a call the binder synthesizes over source expressions (the `Add` of a collection initializer) declares its arguments before it binds them (`ExpectCallArguments`), and the error is found through the block a native-slice receiver is saved in, also when the failed call is an operand and drops the records of a call that binds. Nothing is re-bound, so diagnostics do not change. The index walks each failed call once, though with member groups recorded an inner failed call is reachable both as an inner failed call and as a failed argument. The callee of a failed call through a function value (`f(x, 2)`, with `f` a local, a parameter, a field or a property of function or delegate type) keeps its load as `FailedCallee`, anchored at its identifier, and answers as in a call that binds (#6189). The binder records how to build the load where it commits to the variable or member (`BinderContext.RecordCallCallee`) and builds it only when the call fails, dropping the load's diagnostics; the call completes it with its arguments at the call-binding entry points, and in `CompleteCallSyntax` otherwise. A member function value called through a receiver (`c.G(x)`, `c.G?(x)`, a CLR delegate `c.D(x)`) inherits the call's anchor, so the binder names the invoking call's identifier on the load (`BoundExpression.CalleeIdentifier`, not a tree child), and the index answers that identifier with the load when the call binds; another call of the chain with the same name (`c.G(x).G()`, `c.G.Invoke(x).G()`, `d.G?.G(x)`) answers its own method. A failed call keeps the callee as a call that binds prepares it: a nullable value called with `?(...)` without its narrowing, any other checked as a delegate invocation target (which unwraps a platform type), and a member only once the binder commits to invoking it. Such a call that binds and is not the end of its expression (`c.G(x).ToString()`) answers `G` too (#6197), and so does an inaccessible member (`c.H(x)`, GS0472). A call through a function value whose argument list does not analyse (a named argument given twice, GS0245) keeps its callee as well (#6199): the direct path records the variable that the name resolves to, and the member path resolves the member as a call with no arguments would and drops that resolution's diagnostics, so the layout report stays the only one. A failed call through a platform-typed member function value (`c.G(x, 2)` with `@Oblivious var G`) binds as a CLR delegate and reports GS0131. The name node of a member access, at the end or in the middle of a chain (`B` of `A.B` and of `A.B.C`), answers the member and the type of the access up to that name, as its identifier does, and an inner accessor of a chain answers as its terminal (#6217). The model still answers nothing for an argument the binder never bound: an untyped function literal argument that waits for the target type of an overload the call never selects, or the arguments of a call that fails before it binds them (an explicit type argument that does not resolve, `c.M[Nope](x)`, or an indirect call of a nullable function value without `?(...)`, `(f)(x, 2)`; the receiver or callee answers). It also answers nothing for an argument whose implicit conversion fails (`f("s")` with `f` of type `(int32) -> int32`), which the bound call holds as an error (#6190). Only there do the providers fall back: `let` → `var` and the interpreter to `LookupSymbols` and the variable's declared type, and the `?.` fix to the receiver's declared type clause.
- **Deferred, then done.** The body-local speculative bind (#6128), snippet edits for `HasPlaceholders` fixes (#6129), and packaging of `GSharp.CodeAnalysis.Transformations` (#6130). See "Implementation notes (follow-ups)".
- **Extra fix.** GS0156 between two numeric types (the sized integers, `nint`, `nuint`, `char`, the floating types and `decimal`) gets `Convert to 'T'`, which writes `checked(cast[T](expr))` (`MaybeIncorrect`). The fix applies only to a name, a member access of names, or one of these in parentheses, whose type is the source type of the diagnostic. It declines a constant, because `checked` evaluates a constant conversion at compile time, and an out-of-range constant would then be a compile error. It also declines the operand of a compound assignment (the cast would change the operator's result), and range bounds. Inside a function literal body it applies as in a function body, since the semantic model answers there (#6149). An integer, `char` or `decimal` conversion out of range throws at run time instead of changing the value. A floating-point conversion does not throw: `float64` → `float32` gives infinity for a value beyond the `float32` range, even under `checked`.
- **`let` → `var` rules.** The provider declines member assignments (GS0127 can name the member or a read-only receiver of value type), parameters and instance fields of an inline struct. A field declared in another file gets a fix that edits that file. A bare field assignment gets the fix through the symbol of the assignment.
- **FixAll order.** Changes apply in source order: by file name, then by position.
- **FixAll in the language server.** `source.fixAll.gsharp` keeps the default `MinimumApplicability` (`MachineApplicable`), not `MaybeIncorrect` as D3 says. So it applies no numeric conversion and no field fix. With a `null` equivalence key, FixAll takes the first fix of each diagnostic and then filters it by applicability. When that first fix is filtered out, a later fix of the same diagnostic is not tried.
- **Data-defined fixes in the language server.** A fix from a transformation program gets the full delta, and a built-in fix gets the syntax-only check. The full gate runs the project's analyzers before and after the edit, under their time budget. It fails when an analyzer threw or ran out of time in either run, because such an analyzer reported only part of its diagnostics. `source.fixAll.gsharp` runs the full gate on the combined batch when it holds a data-defined fix. A copy made by `WithLowerApplicability` keeps the data-defined mark. A resolved code action is found by an opaque id in a cache per document version.
- **Program validation.** The schema and the loader share the structural rules. A non-delete edit needs a `template`. `argumentEquals` needs `argumentIndex`. The comparison guards (`textEquals`, `kindIs`, `symbolKind`, `declaredWith`, `typeIs`) need a `value`, and `sameLine` needs `other`. The loader checks more than the schema, so a program that the schema accepts can still fail to load. Every capture that a guard or an edit names must exist in the pattern, a capture name appears once, and the `other` of `sameLine` must differ from its `capture`. `sameLine` also applies to `ancestor` edges. `isNullable` asks whether the type itself is nullable. A name lookup uses the semantic name (`$c` names `c`). It runs only for an unqualified name, never for a member name in a chain. `constructsReferenceType` rejects calls of function values and accepts type aliases. The built-in `Remove 'new'` provider follows the same rules.
- **Compiler bugs found.** `LookupSymbols` on a `let` whose initializer is an `if` expression (#6140), and an internal error for `OrderBy` with a key selector and a `StringComparer` (#6142). The implementation avoided both. #6140 was a `for … in` loop over a collection the binder could not iterate: the loop's body was not bound, so the semantic model had no declarations there (the conformance test compiles the language server's sources without their references). The fix binds that body, and `ResolveCodeAction` uses the original inline `if` expression again. #6142 was not caused by `OrderBy` with a comparer: the 0.5.698 parser read the nested indexer followed by member access in `compilation.SyntaxTrees[ranked[rank]].Text` as a generic type name (#6071), and the resulting error expression reached emit without a diagnostic. #6121 fixed that parse on `main`, so the `OrderBy` ranking is restored in `BatchFixer`; until the pinned compiler includes #6121, the tree is read into a local before `.Text`.

**Measured** before the numeric fix was narrowed to simple operands (so the `GS0156.NumericConversion` count is an upper bound for the merged provider), over the 327 broken programs of the Oats S0 dev repair log, with the built-in providers and suggestions, in one process at low priority while another benchmark ran:

| Measure | Result |
| --- | --- |
| Programs with at least one fix | 78 of 327 |
| Fixes | 118 |
| Fixes that pass `NoNewDiagnostics` | 112 |
| First error of the program fixed and accepted | 67 programs |
| Warm check (`GetDiagnostics`), p50 / p95 | 4.85 ms / 21.5 ms |
| Full-bind delta of one fix, p50 / p95 | 4.9 ms / 21.1 ms |
| Fixes whose edit removes a comment | 0 of 118 |

By key: `GS0156.NumericConversion` 64 (64 accepted), `GS0125.DropNew` 17 (15), `GS0127.LetToVar` 13 (13), `LogicalWord.or` 12 (12), `LogicalWord.and` 5 (1), `GS0273.UseNil` 4 (4), `LogicalWord.not` 3 (3). The delta costs about one warm check, which meets the Oats budget of D4.

**Phase 4 decision.** None of the 118 measured fixes lost a comment. Those fixes come from the built-in providers and suggestions, which edit tokens or compose `OriginalText`. Transformation programs were not measured. A `delete` of a captured node drops the comments inside it. A `replace` keeps the comments of every capture that its template writes with `${capture}`, because the slot copies the capture's source text, and drops the comments in the parts of the node that the template leaves out.

Hand-written `OriginalText` composition is small. Three built-in fixes compose it: the two nullability fixes that wrap an operand (`?? default` and the parenthesized form), and the numeric conversion. Each is one interpolated expression around one operand, with no trivia handling of its own. The program interpreter composes it in one place, the `${capture}` slot, for every program. Neither the measured loss nor this code is significant, so option B stays. Revisit option A when programs that delete or partly replace nodes holding comments are in use, or when a provider makes structural rewrites of such nodes.

## Implementation notes (follow-ups)

**Body-local check (#6128).** `DeltaOptions.BodyLocalBind` (default `true`) lets the delta bind only the edited function body. The result is the full check's result; the check binds the whole compilation whenever that is not shown. It applies when:

- the fix edits one document, every change is strictly between the braces of one top-level function or class or struct method, and the tree has the same skeleton (the text with every member body blanked) after the edit, so no declaration, signature, attribute, import or top-level statement changes;
- every analyzer that runs is body-local in scope (see "Body-local analyzers" below), the compilation is not a submission or a prefix bind, and its declarations and bodies are already bound;
- the member is not a P/Invoke stub, a nullable-sequence specialization, async or suspending, and has no inferred return type.

The check binds the declared body and the edited body, each in a body pass of its own over the compilation's declarations, with copies of the synthesis registries, so the host compilation does not change. The pass of the declared body must report exactly the diagnostics that the compilation's bind recorded for the member (`BoundProgram.BodyDiagnostics`); otherwise the pass is not the compilation's pass and the check falls back. The diagnostics after the edit are the compilation's: the parse diagnostics of the new tree, the declaration diagnostics, the other bodies' diagnostics with spans moved by the edit, the new body's diagnostics, and the documentation diagnostics when no error is left. The snapshot's source suppressions apply to every group after it is relocated, the documentation group included. A diagnostic outside the body that touches a change makes the check fall back.

An edit inside a body can still change what other code reports. The check falls back when:

- the call-effect summary of the member changes, or has a cycle. The narrowing of every caller reads it, through the callee's body syntax. The summary is computed with the edited body in place of the declared one, direct and with overrides, each under a root that takes no sequence and under one that does: the analysis merges the effects of deferred-enumeration callbacks only when the root of the traversal takes a sequence, so a caller of either kind must see the same summary before and after the edit (#6162, below). The bind of each body starts with empty summary caches.
- for a struct or class member, the edit changes whether the body takes a reference to a member name. The narrowing scans every body of the type for that.
- the edit changes whether the member provably returns a non-nil value. The narrowing of a caller reads the callee's body for that proof.
- the edit changes whether the body writes the name of a callable field of a declared type. The call-effect analysis reads the field's initializer only while no tree writes that name.
- either body has a `yield`, an anonymous object, a `Create` call (comparer factories), `adapt` or a deferred LINQ operator. A whole-program syntax scan of the binder or the declaration pass reads these from every body.
- the bind of either body asks for a synthesized ref-kind delegate, or adds an anonymous type, an adapter or a native protocol operation, whose names depend on the order of the full pass.
- either body names a function that suspends, has a suspension point or calls a suspending function, so the suspension inference can change or the bind meets its marks.
- the managed-reference, ref-struct-liveness or rendezvous-batch analysis reports on either body.
- the suspension rewrite that the bind runs after every body is bound (`SuspendingCallRewriter`) reports on the edited body: an await in a `lock` body or nested in a `go` operand, an await or a blocking bridge where the member does not suspend, a `case cancelled` arm without a context. The collector of suspension points skips a `lock` body, so such an await is not a suspension fact.
- the program's bind reported, in the declared body, a diagnostic that the member's body bind did not record (a later pass reported it, and the check does not run that pass again).

`Adr0227BodyLocalDeltaTests` checks the two paths against each other: every fix of the ADR-0227 fix corpus (alone, inside class methods and across files), four synthetic edits of each function body of that corpus and of the repository samples, and one test per fallback. It compares Removed, Added, Persisting and AddedSyntax as sorted multisets of document, ID, severity, span, message, additional locations and suggestion count, and the flags. Another test binds the body-local path several times on a compilation with a body cache, then checks that the compilation, a fresh compilation and a `ReplaceSyntaxTree` successor report what a fresh compilation reports.

**Measured** with warm checks, in Release, in one process at low priority while another benchmark ran, the delta of each candidate computed both ways on the same baseline. The project compilations had one explicit resolver.

| Corpus | Candidates | Body-local | Full delta p50 / p95 | Default delta p50 / p95 | Body-local only p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| Oats S0 dev repair log, 304 distinct broken programs (built-in fixes) | 50 | 26 | 6.8 ms / 13.7 ms | 6.0 ms / 16.9 ms | 4.3 ms / 10.1 ms (the full delta of the same 26: 6.4 ms / 10.1 ms) |
| `src/LanguageServer` (37 files), one statement inserted at the start of a function body, 30 edits | 30 | 17 | 797 ms / 1676 ms | 44 ms / 981 ms | 22 ms / 97 ms |
| `src/Core` (814 files), the same edit, 6 edits | 6 | 1 | 34.1 s / 41.1 s | 32.5 s / 39.7 s | 0.26 s |

A warm check costs 7.9 ms / 24.1 ms for the Oats programs, 1.8 s for `src/LanguageServer` and 22.3 s for `src/Core`. For a single-file program the body-local check costs about what the full check costs, because it binds two bodies in two passes and the program is small; the p95 of the two is about the same. For a project it is one to two orders of magnitude cheaper when it applies. The Oats fallbacks: 18 deferred LINQ calls, 3 parse-only exits, 2 call-effect changes, 1 async member. The project fallbacks: deferred LINQ calls (8), cross-body syntax (5), cycles in the call-effect summary (3), summaries that depend on the caller (2). No candidate gave a different delta.

The 50 candidates are fewer than the 118 of the phase-1–3 measurement. That measurement ran before the numeric conversion was narrowed to simple operands, and over the 327 records rather than the 304 distinct programs; how the difference splits between the two was not measured.

**The snapshot's resolver.** A compilation without explicit references binds against a default resolver, which depends on the assemblies that the process has loaded when it is made. The snapshot of the full check made its own, so on an unedited `src/Core` it reported four `GS0113` errors fewer than the compilation it was compared with, once the process had loaded `System.Threading.Channels`. The language server's compilation of a document without a project and a `Compilation(tree)` given to `CodeFixService` have no explicit references, so the gate could compare unlike things there. `WithReplacedSyntaxTree(s)` now gives the snapshot the resolver that the compilation's declaration bind chose, when the compilation has no explicit references; an edit that changes nothing then has an empty delta.

**Call-effect summaries per root (#6162).** A call-effect summary can depend on the root of the traversal that computes it: the effects of a deferred-enumeration callback count only when the root takes a sequence (`VisitingChainAcceptsEnumerable`). The caches in `BindingServices` were keyed by function only, so a summary computed under one root was reused under every other, and the narrowing of a member (and the GS0158 and definite-assignment diagnostics that follow from it) depended on which members were bound before it. Each cache now has one slot for each answer: the root's answer is fixed when a top-level traversal starts and selects the slot of every summary that the traversal reads or stores. Every traversal reads what a traversal from its own root computes from empty caches, so the result does not depend on bind order, on the parallel body bind (whose workers start with caches of their own) or on the body-local check. `Issue6162CallEffectSummaryRootOrderTests` binds the same files in every rotation and in reverse, and one class with its members in two orders; it fails before the change. The full-bind diagnostics of `src/LanguageServer` and `src/Core`, in file order and in reverse file order, are the same before and after the change. One expectation of `Adr0227BodyLocalDeltaTests` changed: an edit of a wrapper `K` that stops calling `G` removed a GS0158 in `Caller`, which calls `G` directly and takes no sequence. That GS0158 existed only because `Pre` was bound first and cached `G`'s summary under `K`, which takes a sequence; `Caller` now reads `G`'s summary under its own root and keeps the narrowing before and after the edit. The body-local check no longer falls back when a traversal asks whether its root takes a sequence; it compares the member's summaries under both answers instead.

**Body-local analyzers (#6165).** An analyzer declares its scope in `Initialize` with `AnalysisContext.ConfigureScope(AnalyzerScope)`. `AnalyzerScope.Compilation` is the default. `AnalyzerScope.MemberBody` states that the analyzer registers only bound-node and bound-body actions, that what it reports from the actions on one function body depends only on that body and the declarations, not on another body, and that its messages and properties do not depend on where the body sits in the file (a kept diagnostic of another body keeps its message when the edit moves its span, as compiler diagnostics do). An analyzer that declares `MemberBody` and registers any other action (syntax node, syntax tree, semantic model, symbol, compilation start, end or compilation) counts as compilation-wide. Registrations alone do not show locality (a syntax-node action can look up another declaration, as `RewriterClonePreservationAnalyzer` does), so the scope is an opt-in. Syntax-node actions are left out because their context needs a `SemanticModel` of the edited tree, which binds the snapshot compilation, the cost that the check avoids.

When every analyzer of `DeltaOptions.Analyzers` is body-local, the body-local check runs them:

- the baseline's analyzer run records, for each report (an analyzer can report one `Diagnostic` object from several bodies), the function or field whose body's dispatch made it;
- the check runs the analyzers on the declared body, bound speculatively, and requires the diagnostics that the baseline recorded for the member; otherwise it falls back;
- it runs them on the edited body and keeps the baseline's other analyzer diagnostics with their spans moved by the edit, and applies the snapshot's source suppressions after the move (a diagnostic of the new body can sit at the member's name in the old text);
- it falls back when an analyzer of the baseline or of either run threw, ran out of time or reported an unsupported ID (GS9300, GS9302, GS9304), when an analyzer diagnostic of another dispatch is inside the declared body, and when a kept diagnostic touches the edit;
- with a time budget (`AnalyzerOptions.TimeBudgetMilliseconds`), it falls back unless every analyzer stays well under the budget (#6183, below).

The speculative bodies are anchored as the program's bind anchors its bodies (ADR-0169), at the declaration before and after the edit. A compilation-wide analyzer, alone or with body-local ones, keeps the full-bind fallback. The contexts of a run on one body give the compilation and the owning symbol from before the edit. The symbol's declaration holds the old body, while everything in it outside the body is unchanged. So an analyzer of `MemberBody` scope reads the body from its context (the bound body or node and their syntax), not through `OwningFunction.Declaration.Body`, and does not read other bodies through the compilation. A copy of the symbol with the new declaration would break symbol identity for the analyzer and for the declarations, so the check gives none. `Adr0227BodyLocalDeltaTests` compares the two paths with two body-local analyzers (one reports every bound node by kind and span, one reports each body's statement count at the member's name, outside the body) over the fix corpus, the synthetic body edits and the samples, and has tests for a compilation-wide analyzer, a mixed set, a mislabeled analyzer, an analyzer that throws on the new body, an edit beside a suppressed member and of the suppressed member itself, and an analyzer that reports one diagnostic object from every body.

**Measured after #6162 and #6165**, with the harness of the #6128 measurement (Release, warm, low priority while another benchmark ran, both deltas of each candidate on one baseline, 0 mismatches in every row), on the same inputs before (main) and after. The project rows bind a copy of each project's sources.

| Corpus | Analyzers | Body-local before / after | Full delta p50 / p95 after | Default delta p50 / p95 before / after | Body-local only p50 / p95 before / after |
| --- | --- | --- | --- | --- | --- |
| Oats S0 dev repair log (built-in fixes) | none | 26 / 26 of 50 | 10.2 ms / 20.4 ms | 8.3 ms / 22.5 ms / 9.4 ms / 24.7 ms | 4.8 ms / 17.4 ms / 5.8 ms / 17.4 ms |
| `src/LanguageServer`, 30 body edits | none | 17 / 19 of 30 | 933 ms / 2550 ms | 60 ms / 1229 ms / 31 ms / 939 ms | 29 ms / 155 ms / 23 ms / 150 ms |
| `src/Core`, 6 body edits | none | 1 / 1 of 6 | 46.7 s / 59.4 s | 33.7 s / 39.4 s / 45.9 s / 61.9 s | 0.31 s / 0.36 s |
| `src/LanguageServer`, 30 body edits | one body-local analyzer (reports every call) | 0 / 19 of 30 | 1171 ms / 3434 ms | full delta / 54 ms / 1712 ms | - / 36 ms / 187 ms |
| `src/Core`, 6 body edits | the same | 0 / 1 of 6 | 49.7 s / 55.8 s | full delta / 46.5 s / 55.0 s | - / 0.39 s |

The two `src/LanguageServer` hits that the caller-dependent fallback of #6156 cost are back; the other fallbacks are unchanged (deferred LINQ calls, cross-body syntax, cycles in the call-effect summary). Before #6165 any analyzer made the check bind the whole compilation. The `src/Core` rows vary with the load of the machine (its warm check was 26 s in both runs, and the full-bind diagnostics, in file order and reversed, are the same before and after); compare within a row.

**Analyzer time budgets (#6183).** The budget limits the time that each analyzer spends in its callbacks over the whole run, and the full run disables an analyzer that goes over it with GS9302. A run on one body starts a clock of its own, so it cannot report that GS9302. The baseline's analyzer run now records the time of each analyzer (`AnalyzerRun.Elapsed`). The time of the full run after the edit is about the baseline's time, less the declared body, plus the new body, so the baseline's time plus the new body's time is more than it. The check keeps the body-local path only when that sum, for each analyzer, is not more than half the budget (`BodyLocalDelta.TimeBudgetMarginFactor` = 2). It checks the baseline's time alone before the speculative bind, and the sum after the run on the new body. Times change from run to run, by JIT, GC and load, so the full run would have to take twice the time of the sum before its GS9302 could differ. Otherwise the check falls back to the full bind, which gives the budget's own result. The bound cannot cover every difference between the runs: for example, a full run on the snapshot can rebuild semantic-model indexes that the baseline found already built. So a full run can still report a GS9302 that the body-local check does not. GS9302 depends on wall-clock time and not on the edit, and a second full run of the same edit can differ in it too. The full gate of the language server treats GS9302 as a run that it cannot verify (`PassesFullGate`). The body-local result is not such a run: the analyzers finished on the edited body, and the baseline gives their complete results for the other bodies. No analyzer code runs while the check holds the compilation's build gate: an analyzer can query a semantic model, whose index takes the same gate, and the gate is not reentrant. The analyzers initialize before the gate is taken, and they run on the two bodies after it is released; the check then makes sure that no successor retired the compilation meanwhile, and falls back if one did. The language server's full gate (budget 2000 ms) now uses the body-local path for data-defined fixes when its body-local analyzers take less than 1000 ms. `Adr0227BodyLocalDeltaTests` checks a 60-second budget with the body-local path, a baseline whose time for one analyzer is set above half the budget with the fallback, the same times without a budget with the body-local path, the boundary of the sum, and an analyzer that builds the semantic-model index of another file only for the new body, with and without a budget (it deadlocked when the analyzers ran under the gate); each compares the delta with the full bind's.

**The repository's analyzers (#6184).** `NullabilityFunnelAnalyzer` (GSA0007) declares `AnalyzerScope.MemberBody`. It registers only a bound-body action, reads the body from its context, and reads only the declarations of the owning member (its attributes and containing type), so its reports on one body depend on that body alone. The declaration waited for a bootstrap SDK whose `GSharp.Core` has `ConfigureScope` (0.5.793, #6227), because the internal analyzers build against the SDK's `GSharp.Core`. `NullabilityFunnelBodyLocalTests` checks that an edit in one body of a Core-namespace program takes the body-local path, reports the new GSA0007, keeps the other body's GSA0007, and gives the delta of the full check.

**Snippet edits (#6129).** When the client declares `workspace.workspaceEdit.snippetEditSupport` (LSP 3.18) and applies `documentChanges`, a change that holds a placeholder of a `HasPlaceholders` fix becomes a `SnippetTextEdit`: `{range, snippet: {kind: "snippet", value}}`, with each placeholder a tab stop `${n:text}`, numbered in document order. A backslash escapes `$`, `}` and `\` in the fixed text and in the placeholder text. A change without a placeholder stays a `TextEdit`. Without that capability, or without `documentChanges` (where a snippet edit is not allowed), the server sends plain text. A placeholder that is not inside the new text of one change gives the document plain edits.

**Placeholders for clients without snippet edits (#6164).** A workspace edit cannot select text, so D5's "selects it" is replaced: the server chooses placeholder text that binds. A client with `window/showDocument` also gets the selection (#6185, below). For a client that does not get snippet edits, the fix keeps its own text when the edit adds no error (checked with a delta of the compilation's diagnostics). Otherwise each placeholder becomes a target-typed `default` with a comment that names it, `default /* TODO: text */` (`default /* TODO */` when the text could end the comment), when that edit adds no error. When neither binds, for example a placeholder in a type position, the fix keeps its own text. The syntax gate and, for a data-defined fix, the full gate then check the chosen edit, so the edit that the client gets, and that a lazy client resolves, is the one that was gated. A snippet client gets the tab stops as before.

**Placeholder selection for clients without snippet edits (#6185).** A client that declares `window.showDocument.support` (LSP 3.16) can select text after an edit, through a command. When such a client gets no snippet edits, a fix whose chosen edit has a placeholder gets the command `gsharp.selectPlaceholder` on its code action, and the server advertises that command in `executeCommandProvider`. The client runs the command after it applies the edit. The argument gives the document, the range of the first placeholder (in document order, in the first document that has one) in the text after the edit, and the placeholder's text. The server then sends `window/showDocument` with `takeFocus` and that range as the selection, and does not wait for the reply. It finds the open document by its path, as the edit of another open document does (D7), and sends the request only when that document holds the placeholder's text at the range. The command is computed with the edit in the list request, so a lazy client gets it before it resolves the edit; a resolve that gives no edit (a stale action) also removes the command. An empty or out-of-range placeholder span gives no command. A snippet client, and a client without `window/showDocument`, get no command and no `executeCommandProvider`, as before. `Adr0227SnippetEditTests` checks the command and its range for direct and lazy clients, the capability detection and advertisement, the clients that get no command, and, over JSON-RPC, the `window/showDocument` request and its selected range.

**Operands of a failed operator expression (#6187).** An operator expression that fails to bind keeps its operands on its `BoundErrorExpression`, as a failed call keeps its arguments (#6150). An operand that bound is kept in `FailedOperands`. An operand that is a failed call, or that wraps one, gives the call's records (`FailedChildren`), as before. This applies to these forms:

- a binary expression, whatever its error (a failed operand, or no operator for the operand types);
- a unary expression;
- a conditional expression (the condition and both branches);
- a compound assignment or increment that has no operator.

For a compound assignment, the error keeps the original target read, not the temporary that holds a postfix value. It also keeps the value and the initializers of the temporaries that hold the receiver and the indices of an element, rectangular or multi-index indexer target. The multi-index indexer binder keeps those initializers on any failed value, so a plain assignment such as `g[a, b] = Use(x, x)` keeps them on the value's error too. An error that the binder creates for this has no syntax. An error that already had syntax (some binary, element and native-slice errors) keeps it. Only the semantic-model index visits the operands: walkers and rewriters do not. Nothing is re-bound, so diagnostics do not change. In `Use(x) + Use(x, x)`, where `Use` takes one argument, the `x` of `Use(x)` and the call `Use(x)` answer their symbol and type. `Issue6187FailedOperatorOperandTests` checks this and that the diagnostics are the same as before. The model still answers nothing for the index of a native-slice element in a failed operator expression (`s[x] + c`), because the binder anchors the element block at the index syntax.

**Packaging (#6130).** `GSharp.CodeAnalysis.Transformations` is a NuGet package next to `GSharp.CodeAnalysis.Analyzers.Testing`, with the same layout: the assembly, the README and the icon, and also the JSON schema under `schema/`. Like the testing package, it has no dependency on a `GSharp.Core` package: Core is not a package of its own, and the host supplies it (the SDK and `Gsharp.Compiler` carry it). `build/release-publish.py` expects the package and its symbols. `TransformationsPackageTests` keeps a public API snapshot (`test/Core.Tests/Baselines/gsharp-transformations-public-api.txt`) and checks the contents and the dependencies of the package that the build packs.

## Consequences

- G# gets one fix mechanism for compiler and analyzer diagnostics, for the language server and for library hosts.
- Oats can list, apply and check fixes in process with `GSharp.Core` only. It registers data-defined programs through `GSharp.CodeAnalysis.Transformations` (phase 3).
- Compiler diagnostics keep their descriptor and arguments. Providers stop parsing message text.
- The public API snapshot grows by the types of D1, D2, D4 and, in phase 3, D6.
- Span edits do not keep a comment that is inside a replaced node unless the provider composes `OriginalText`. Phase 1 fixes edit single tokens, so this does not occur for them.
- The full-bind delta costs one bind for each candidate until phase 2. Until then the language server runs only the parse-only stage on its fixes, so a phase-1 fix in the editor can add a bind error. The golden tests of each built-in fix cover that risk.
- A mined program can be wrong. The gate bounds the harm, but it cannot show that an edit is wanted. Applicability and the host's evidence rules do that.

## Alternatives considered

- **A trivia-preserving red/green tree first (option A).** Rejected for now: the cost is out of proportion to the first fixes, which edit one token. D1 keeps the option open, and phase 4 decides it with data.
- **Reuse the cs2gs emit AST and printer (option C).** Rejected: output-only, whole-unit printing, no parse-to-model path, needs code that parses, and Core cannot reference `tools/`.
- **Format every fix with gsfmt.** Rejected as a requirement: gsfmt returns nothing when the code has a parse error, and Oats code often has one. It stays an optional step of the host.
- **Fix-it data in `Diagnostic.Properties`.** Rejected for the reason of ADR-0225: hosts compare `Properties`.
- **Fixes in the language server only.** Rejected: Oats cannot use them, and the existing ones already have to guess types from message text.
- **Roslyn's code-fix types through a projection.** Rejected by ADR-0027 and ADR-0169.
- **Rewrite through bound trees (`BoundTreeRewriter`).** Rejected: bound trees are lowered and have no source text, so the edit cannot go back to the user's source.

## Decisions (accepted by the maintainer, 2026-11-20)

The maintainer did not answer the open questions before implementation, so these were applied as provisional defaults. The maintainer accepted them after implementation:

- **Q1.** `SyntaxEditor` is in `GSharp.Core.CodeAnalysis.Syntax`, with the tree.
- **Q2.** Code-fix providers are separate types. `GSharpAnalyzerHost` loads them from the analyzer assemblies.
- **Q3.** The default gate is `NoNewDiagnostics`: offer a fix only when its pattern applies and the edit adds no new diagnostic. Errors and warnings count. Compiler and analyzer diagnostics count alike. `PhaseAware` is allowed only for fixes of parse errors. `NetImprovement` is available, not the default.
- **Q4.** In phase 1 the language server runs the full gate only on data-defined fixes. Measure before the gate is extended.
- **Q5.** `Diagnostic.Suggestions` is accepted, for phase 3.
- **Q6.** The location of a command-line FixAll is deferred. It is not implemented.
- **Q7.** The program interpreter and its JSON schema are in a separate assembly, not in Core (D6).
- **Q8.** `let` → `var` for locals is `MachineApplicable`.
- **Q9.** GS9308 is the ID for "code-fix provider failed".

## Open questions for the maintainer (answered in "Decisions")

- **Q1. Layering of the editor.** Is `SyntaxEditor` in `GSharp.Core.CodeAnalysis.Syntax` (with the tree) or in `CodeFixes`? The proposal puts the text types in `Text` and the editor in `CodeFixes`.
- **Q2. Provider discovery.** Do code-fix providers ship in analyzer assemblies and load through `GSharpAnalyzerHost`, or in separate assemblies with their own host? The proposal reuses the analyzer host.
- **Q3. The exact IntelliCode rule.** Does "removes existing diagnostics or at least adds none" mean `NoNewDiagnostics`, or `NoNewDiagnostics` or `NetImprovement`? Do warnings count, or only errors? Do analyzer diagnostics count? Is `PhaseAware` acceptable for parse-error fixes?
- **Q4. The gate in the language server.** Should the language server gate hand-written built-in fixes too, at the cost of a bind for each candidate, or only data-defined fixes? The proposal gates data-defined fixes only, until the phase-2 budget is measured.
- **Q5. `Diagnostic.Suggestions` (D2 option b).** Accept it for phase 3, and accept the change at report sites?
- **Q6. A command-line FixAll.** Should unattended `MachineApplicable` fixes be in `gsfmt --fix`, a `gsc` switch, or neither?
- **Q7. Data-defined programs in Core.** Should the program interpreter and its JSON schema be in `GSharp.Core` (so Oats needs no other assembly), or in a separate assembly that Oats also references?
- **Q8. Applicability of `let` → `var`.** The proposal makes it `MachineApplicable` for locals. A reassignment can be the bug and the `let` the intent. Is `MaybeIncorrect` preferred?
- **Q9. New diagnostic ID.** Is GS9308 acceptable for "code-fix provider failed"?
