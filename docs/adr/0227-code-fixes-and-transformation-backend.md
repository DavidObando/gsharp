# ADR-0227: Code fixes, a span-edit transformation backend and a diagnostic-delta gate

- **Status**: Accepted (provisional decisions on the open questions, see "Decisions"; the maintainer may revise them)
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
- The computer reads syntax, declaration, body and analyzer diagnostics of the document. Today `DocumentSyncHandler` runs `GSharpAnalyzerDriver.Run` in its debounced phase and converts the result to LSP diagnostics at once; it keeps no Core diagnostics. Phase 1 keeps the analyzer diagnostics of the last run for each document version, so the computer does not run the analyzers again.
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

## Decisions (provisional; the maintainer may revise them)

The maintainer did not answer the open questions before implementation. These defaults apply until the maintainer changes them:

- **Q1.** `SyntaxEditor` is in `GSharp.Core.CodeAnalysis.Syntax`, with the tree.
- **Q2.** Code-fix providers are separate types. `GSharpAnalyzerHost` loads them from the analyzer assemblies.
- **Q3.** The default gate is `NoNewDiagnostics`: offer a fix only when its pattern applies and the edit adds no new diagnostic. Errors and warnings count. Compiler and analyzer diagnostics count alike. `PhaseAware` is allowed only for fixes of parse errors. `NetImprovement` is available, not the default.
- **Q4.** In phase 1 the language server runs the full gate only on data-defined fixes. Measure before the gate is extended.
- **Q5.** `Diagnostic.Suggestions` is accepted, for phase 3.
- **Q6.** The location of a command-line FixAll is deferred. It is not implemented.
- **Q7.** The program interpreter and its JSON schema are in a separate assembly, not in Core (D6).
- **Q8.** `let` → `var` for locals is `MachineApplicable`.
- **Q9.** GS9308 is the ID for "code-fix provider failed".

## Open questions for the maintainer (answered provisionally above)

- **Q1. Layering of the editor.** Is `SyntaxEditor` in `GSharp.Core.CodeAnalysis.Syntax` (with the tree) or in `CodeFixes`? The proposal puts the text types in `Text` and the editor in `CodeFixes`.
- **Q2. Provider discovery.** Do code-fix providers ship in analyzer assemblies and load through `GSharpAnalyzerHost`, or in separate assemblies with their own host? The proposal reuses the analyzer host.
- **Q3. The exact IntelliCode rule.** Does "removes existing diagnostics or at least adds none" mean `NoNewDiagnostics`, or `NoNewDiagnostics` or `NetImprovement`? Do warnings count, or only errors? Do analyzer diagnostics count? Is `PhaseAware` acceptable for parse-error fixes?
- **Q4. The gate in the language server.** Should the language server gate hand-written built-in fixes too, at the cost of a bind for each candidate, or only data-defined fixes? The proposal gates data-defined fixes only, until the phase-2 budget is measured.
- **Q5. `Diagnostic.Suggestions` (D2 option b).** Accept it for phase 3, and accept the change at report sites?
- **Q6. A command-line FixAll.** Should unattended `MachineApplicable` fixes be in `gsfmt --fix`, a `gsc` switch, or neither?
- **Q7. Data-defined programs in Core.** Should the program interpreter and its JSON schema be in `GSharp.Core` (so Oats needs no other assembly), or in a separate assembly that Oats also references?
- **Q8. Applicability of `let` → `var`.** The proposal makes it `MachineApplicable` for locals. A reassignment can be the bug and the `let` the intent. Is `MaybeIncorrect` preferred?
- **Q9. New diagnostic ID.** Is GS9308 acceptable for "code-fix provider failed"?
