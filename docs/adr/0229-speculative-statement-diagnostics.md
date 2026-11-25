# ADR-0229: Speculative statement diagnostics are the diagnostics of the text with the statement inserted

- **Status**: Proposed
- **Date**: 2026-11-24
- **Phase**: Tooling
- **Issue**: [#6176](https://github.com/DavidObando/gsharp/issues/6176)
- **Related**: ADR-0225 (prefix bind and diagnostic finality, D6.7), ADR-0212 (semantic-query surface, `GetSpeculativeTypeInfo`), Oats `docs/notes/gsharp-incomplete-bind-design.md` §3 and §5.4

## Context

A host that generates G# (Oats seal-and-bind) asks at a statement boundary whether a candidate statement is legal, before it commits to the statement. ADR-0225 D6.7 deferred `SemanticModel.GetSpeculativeStatementDiagnostics(position, statement)`: bind a statement as if it were inserted at the position, and return its classified diagnostics and the locals that it declares.

`GetSpeculativeTypeInfo` binds an expression with a speculative binder: the scope at the position, no flow state, no diagnostics. A statement needs more than that:

- The narrowing state at the position decides diagnostics. With `p string?` narrowed by `if p != nil`, `let n int32 = p.Length` is legal; a binder without flow state reports it.
- The classification (ADR-0225) reads the prefix cut of the statement's tree and the provisional expressions of the bind (#6179). A statement parsed on its own has neither.
- The statement can change end-of-body and whole-program analyses: definite assignment, unreachable code, `GS0100`.

The oracle of #6176 is "the same result as `BindPrefix` with the statement inserted".

## Decision

`GetSpeculativeStatementDiagnostics` is that bind:

```gsharp
class SemanticModel {
    func GetSpeculativeStatementDiagnostics(position int32, statement StatementSyntax,
        cancellationToken CancellationToken = default(CancellationToken)) SpeculativeStatementResult
}

class SpeculativeStatementResult {
    prop Diagnostics ImmutableArray[ClassifiedDiagnostic]   // located in the statement
    prop DeclaredSymbols ImmutableArray[Symbol]             // declared in the statement, in scope after it
    prop SyntaxTree SyntaxTree                              // the bound tree: the text with the statement inserted
    prop StatementSpan TextSpan                             // the statement in that text
}
```

1. The text of the model's tree gets a line break, the statement's text and a line break at `position`.
2. For a prefix tree (the tree of a `PrefixBindResult`), the model's compilation with the new text in place of the tree (`WithReplacedSyntaxTree`) runs `BindPrefix` with the same `PrefixRemainder`, and the cut moves past the inserted text. `position` must be at or before the cut. For a complete tree, the new text is bound as a complete program, and every diagnostic is `Final`.
3. The result has the diagnostics located in the statement, in `GetDiagnostics` order, and the symbols of the scope after the statement whose declaration is in the statement.

Every analysis of a bind runs, flow analysis included, so the statement sees the flow state at the position and gets the finality of a prefix bind. The model's compilation does not change.

## Consequences

- A host gets the oracle by construction. On 60 samples, at 2 body statement boundaries each, in both modes, for 4 statements (960 checks), the result equals a bind of the inserted text from scratch: same ID, span, finality and reason.
- The cost is a bind of the text, not of the statement: on the samples, 5.1 ms at p50 and 13.6 ms at p95 (`GetSpeculativeTypeInfo`: 0.5 ms and 0.7 ms on the same machine). The bind does not reuse the declarations of the model's compilation.
- A diagnostic that the statement causes elsewhere (code after a `return` that becomes unreachable, a `GS0100` that a `return` removes) is not in the result, because its location is outside the statement. A host that needs it binds the text itself.

## Alternatives considered

- **A speculative statement binder** (generalize `BindSpeculativeExpressionType`). It is fast, but it has no flow state, so it reports false errors (the narrowed `p` above), and it has no prefix cut, so it cannot classify. Matching the oracle would need the flow state of the position and a synthesized cut, which is most of a bind.
- **Chained reuse** (`BindPrefix(..., previous)`, ADR-0225 D6.6). It needs a `PrefixBindResult` of a compilation with the same other trees, which a model does not have, and it retires that result's compilation. A host that holds the result can splice the text and call `BindPrefix` with `previous` itself.
