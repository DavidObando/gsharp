# ADR-0225: Bind an incomplete tree and classify each diagnostic as final or future-dependent

- **Status**: Proposed
- **Date**: 2026-11-17
- **Phase**: Tooling
- **Issue**: [#6075](https://github.com/DavidObando/gsharp/issues/6075)
- **Related**: ADR-0212 (semantic-query surface, `ReplaceSyntaxTree`, single-flight builds), ADR-0223 (compiler-as-library surface), ADR-0105 (bound-body cache), Oats `docs/notes/gsharp-incomplete-bind-design.md` and `docs/spikes/S1-oracle.md`

## Context

Oats S2 checks a model's G# while the model generates it ("seal and bind"). After each statement, the decoder asks the compiler two questions: is the text so far legal, and what is in scope at this point? If the text is not legal, the decoder rolls back the statement. The program is incomplete at that point. The current function, its enclosing type and the rest of the file do not exist yet (generation from left to right), or exist only after the hole (a fill-in edit).

A host can only fake this with text. It cuts the source, appends a placeholder and the closing delimiters, and binds the result as a complete program. The Oats S1 spike built that sealer and measured it on the 148 samples: 2.1% of the cuts get a false-positive error, at about 2 ms for each check. The method has three problems that only the compiler can correct:

1. **The host cannot tell why a diagnostic is reported.** A diagnostic of a prefix is *final* when every completion of the prefix reports it. It is *future-dependent* when a later declaration or statement can remove it: a call to a function that is declared further down, a class that does not implement its interface *yet*, "not all code paths return". S1 had to learn an ID list from data. The list generalizes badly: one ID is final at one site and future-dependent at another.
2. **The seal causes diagnostics.** A `}` can close a construct whose header is incomplete, and a `try` block closed at the cut has no `catch`. Only the position of the diagnostic tells these artifacts apart.
3. **Each check is a full bind.** The seal changes the text, so each check is a new compilation.

## Decision

### D1. Surface

The members are additive. All new types are in `GSharp.Core.CodeAnalysis`.

```gsharp
enum DiagnosticFinality { Final, FutureDependent, Artifact }
enum PrefixRemainder { Nothing, KeepDeclarations }

class PrefixBindOptions {
    init(remainder PrefixRemainder, includeScope bool = true)
    prop Remainder PrefixRemainder
    prop IncludeScope bool
}

class ClassifiedDiagnostic {
    prop Diagnostic Diagnostic
    prop Finality DiagnosticFinality
    prop Reason string          // "", "later-declaration", "later-member", "rest-of-body",
                                // "rest-of-type", "rest-of-statement", "cut"
}

class OpenConstruct {
    prop Kind SyntaxKind        // the construct whose delimiter is open; a body reports its declaration
    prop Symbol Symbol?         // the function of an open body, the type of an open type body
    prop ExpectedType TypeSymbol?   // the return type of the function of an open body
}

class PrefixBindResult {
    prop Diagnostics ImmutableArray[ClassifiedDiagnostic]   // in GetDiagnostics order
    prop OpenConstructs ImmutableArray[OpenConstruct]       // innermost first
    prop Scope ImmutableArray[Symbol]                       // LookupSymbols(cut), when requested
    prop Compilation Compilation                            // the compilation that was bound
    prop SyntaxTree SyntaxTree                              // the prefix tree
}

class Compilation {
    func BindPrefix(tree SyntaxTree, cut int32, options PrefixBindOptions,
                    cancellationToken CancellationToken = default(CancellationToken)) PrefixBindResult
}
```

- `PrefixRemainder.Nothing` means that nothing follows the cut. Any declaration can still follow.
- `PrefixRemainder.KeepDeclarations` means that the declarations after the cut in the host's tree follow. The bind removes the text from the cut to the end of the member that contains the cut. When the cut is in the top-level statements, it also removes the later top-level statements and keeps the later declarations.
- `BindPrefix` does not change the compilation. The result holds a new compilation, built as `WithReplacedSyntaxTree` builds one. The new compilation has no body cache and does not re-point symbols, so it cannot retire the host's compilation.
- The host's tree can end at the cut or continue after it. Positions in the result are positions in the host's text.

The classes are plain classes, not `data class` types, so the public API snapshot does not get generated equality and `Deconstruct` members.

### D2. The parser seals the cut

`BindPrefix` parses the host's text again in prefix mode. The lexer reads the text before the cut. For each delimiter that is open at the cut (`{`, `(`, `[`, `?[`), innermost first, the token stream gets a zero-width closing token at the cut. The token is missing and has the internal flag `IsSealedAtCut`. With `KeepDeclarations`, the kept tokens follow, at their original positions.

The tokens keep their positions in the source text, so the prefix tree and the host's tree agree on every position before the cut. The host writes no seal and no placeholder statement. Because the seal adds no statement, it cannot make code unreachable.

A construct is *open* when its last token is a sealed token. The binder uses this one test for function bodies, types, `try` statements, `switch` statements, `guard let` else blocks and `scope` blocks.

### D3. The binder states the premise when it reports

The rule is: a diagnostic is final unless its premise can still change. The binder knows the premise when it reports the diagnostic, so it states the premise there. A premise is a finality and a reason. `DiagnosticBag` stamps the premise on the diagnostic when it creates it. A copy after `Add` would break the reference identity that the bag tracks (duplicate and rebind suppression, the parser's last-GS0005 check).

| Family | Where the binder states it | Finality |
|---|---|---|
| Not all code paths return (`GS0100`) | member bodies, rich anonymous methods, lambdas | `FutureDependent` (`rest-of-body`) when the body is open; otherwise final |
| `out` parameter not assigned at exit (`GS0238`), `goto` to an undefined label (`GS0469`) | definite assignment; the label check of a member body | `FutureDependent` (`rest-of-body`) when the body is open |
| Interface and abstract members not implemented (`GS0187`, `GS0320` and the other reports of the two verification passes) | each type in `VerifyInterfaceImplementations` and `VerifyAbstractMethodImplementations` | `FutureDependent` (`rest-of-type`) when the type is open |
| `try` without `catch` or `finally` (`GS0118`), `fallthrough` in the final arm (`GS0533`), a switch statement that is not exhaustive (`GS0178`) | the statement binder | `FutureDependent` (`rest-of-statement`) when the `try` or `switch` is open |
| A partial method without an implementing part (`GS0609`) | the partial-method merger | `FutureDependent` (`rest-of-type`) with `Nothing`: a later part can implement it |
| `guard let` else block does not exit (`GS0297`), `async let` never awaited (`GS0559`) | the statement binder | `FutureDependent` (`rest-of-body`) when the else block or the `scope` block is open |
| Unknown simple name (`GS0125`, `GS0130`, `GS0113`, and `GS0157` for a name used as a type receiver) | the failed-lookup reports of `DiagnosticBag` | `FutureDependent` (`later-declaration`) when a later declaration can declare the name; otherwise final |
| Unknown member (`GS0158`, `GS0159`) | the failed-lookup reports of `DiagnosticBag` | `FutureDependent` (`later-member`) when a later declaration can declare the member; `Final` for a static member that the code names on an imported class |
| A parse diagnostic before the cut that the host's tree does not report | `BindPrefix` | `Artifact` (`cut`): the tokens before the cut are the same, so the seal caused it |
| A diagnostic in the text that the bind removed (at or after the cut, before the kept text) | `BindPrefix` | `Artifact` (`cut`) |
| A diagnostic located on a construct that is open at the cut (the whole span of a call whose argument list the seal closed) | `BindPrefix` | `FutureDependent` (`rest-of-statement`) |
| A diagnostic in kept text that the host's compilation does not report | `BindPrefix` | `FutureDependent` (`rest-of-body`): it depends on the removed text |
| Every other diagnostic | | `Final` |

"A later declaration can declare the name" is true in these cases:

- `Nothing`: always. A simple-name lookup ends in the file scope, and a declaration after the cut can add a top-level function, type or global.
- `KeepDeclarations` with the cut in the top-level statements: always, because a later top-level `var` is a statement and the bind removes it.
- `KeepDeclarations` with the cut in a member: only in a function literal or lambda of the open member. Such a body can use a local that a later statement declares (`let first = func () { second() }; let second = …`). A plain statement cannot use a later local.

"A later declaration can declare the member" is true with `Nothing`, and false with `KeepDeclarations`, also when the cut is in the top-level statements. A later receiver function (`func (v T) Name()`) can satisfy an earlier `x.Name()` on any receiver type, imported types included, and so can a later member of an open or partial type. A static member that the code names on an imported class is final in both modes: the binder states this where the static-call and static-member lookups of an imported class fail. A static lookup on a source type that falls back to its imported base keeps the `later-member` premise, because the source type can still declare the member.

The failed-lookup premise reads the prefix cut from an ambient value (`PrefixBindingContext`, an `AsyncLocal`, as `NullabilityOptions` does). `Compilation` sets it for the declaration and body binds when one of its trees is a prefix tree. A failed lookup in any tree can depend on a declaration after the cut, so the premise is a property of the compilation, not of the tree that holds the reference.

This is not an ID list. The same ID gets different finalities at different sites (a `GS0159` for an instance call is future-dependent with `Nothing`; for a static call of an imported class it is final). A new ID that a binder reports under a premise gets the premise. A report that states no premise is final by default. The tests check the samples and the shapes in this table, but they cannot find a new report that misses its premise in a shape that the samples do not contain.

### D4. Complete programs do not change

Every premise is conditional on a prefix tree. A tree from `SyntaxTree.Parse` has no sealed tokens and no prefix cut, so no premise holds and no diagnostic gets a stamp. `Diagnostic` keeps the finality in internal members. `Properties` does not change.

### D5. Scope and open constructs

`Scope` is `SemanticModel.LookupSymbols(cut)` on the prefix tree. The sealed tokens sit at the cut, and the locals of the open blocks are in scope there. `OpenConstructs` lists the construct that owns each sealed token, innermost first. A body of a declaration reports the declaration, its symbol and, for a function, its return type.

### D6. Deviations from the Oats design note

1. **No `SealedAtCut` parser mode with suppressed diagnostics.** The note proposed that the parser close every construct at end of input without "expected `}`" errors. This ADR seals at the token level instead, so the parser does not change. Parse errors that the seal causes are reported and classified `Artifact`. A construct without a delimiter (an `if` header before its `{`) is not in `OpenConstructs`. `OpenConstruct.ExpectedType` is the return type of an open function body only; an open argument list has no parameter type yet (that needs `GetExpectedType`).
2. **`Artifact` covers parse diagnostics that the seal causes, not only diagnostics after the cut.** In `KeepDeclarations`, a diagnostic in kept text is not an artifact.
3. **Unknown members of imported types are not always final.** The note made a member of an imported type final. A later receiver function can declare an instance member of any type, and member lookup reads receiver functions. With `Nothing`, an unknown instance member is therefore `FutureDependent` (`later-member`). Only a static member of an imported class is final. A host that does not expect later receiver functions can treat `later-member` as final.
4. **`KeepDeclarations` is not final for every unknown name.** The note made it final because all later declarations are present. Later top-level statements and later statements of the open member are not present, and a function literal can use a later local.
5. **Overload resolution.** The note made an overload or argument failure future-dependent when the candidates include source functions of an open scope. This ADR does not classify these; they are final. A later overload or receiver function can remove such a diagnostic with `Nothing`. This is a follow-up.
6. **No reuse.** Each `BindPrefix` binds the prefix compilation from scratch. The cost is the cost of a plain bind of the prefix (see Consequences). Per-member body reuse inside the edited tree is a follow-up.
7. **Deferred members.** `SemanticModel.GetSpeculativeStatementDiagnostics`, `SemanticModel.GetExpectedType`, `SyntaxTree.ParseExpression` and `SyntaxTree.ParseStatement` are not in this change. `PrefixBindResult` also has `SyntaxTree`, so that a host can query the prefix tree.

## Consequences

- A host gets the finality of each diagnostic from the binder, and a reason it can use for its own policy.
- On the samples, cut at up to 30 statement boundaries each (3922 checks in both modes), no final diagnostic is missing from the complete file at the same ID and span. Before the premises, 370 were.
- For each sample, `BindPrefix` at the end of the text with `KeepDeclarations` reports exactly `GetDiagnostics()`, all final. For the 194 programs in `samples/` and the Core test data, `GetDiagnostics()` gives the same ID, span, severity, message, property count and additional-location count before and after the change.
- The cost of a check is the cost of a plain bind of the prefix text plus the scope query. On the samples (3922 checks, scope included), `BindPrefix` takes 2.9 ms at p50 and 11.2 ms at p95. A plain `Compilation(...).GetDiagnostics()` of the same prefix texts takes 2.6 ms and 9.8 ms on the same machine.
- The `DiagnosticBag` failed-lookup reports read one `AsyncLocal` value. Other reports do not change.

## Alternatives considered

- **An ID list in the host** (S1). It cannot generalize: the same ID is final at one site and future-dependent at another.
- **`Diagnostic.Properties["finality"]`.** It is visible to every host, so it would change the diagnostics of the prefix compilation for hosts that compare properties. The internal members keep `Properties` as it is; `ClassifiedDiagnostic` is the public form.
- **A text seal in the compiler.** A text seal changes positions after the cut and needs a placeholder statement, which can make code unreachable.
- **A post-pass over the diagnostics.** A post-pass does not know the lookup scope or the receiver of a failed lookup.

## Follow-ups

- Overload-resolution and argument diagnostics with `Nothing` (D6.5).
- End-of-construct checks that this ADR does not cover: labels of a lambda body or of the top-level statements, and the exhaustiveness of a switch expression that is open at the cut.
- Per-member body reuse for successive cuts of one member (D6.6).
- `GetSpeculativeStatementDiagnostics`, `GetExpectedType`, `ParseExpression` and `ParseStatement` (D6.7).
- The smaller asks of the Oats note: `GetDeclaredSymbol` for parameters and local declarations, `GetSymbolInfo` for constructor calls, the concurrency contract (ADR-0223 D5), the cost of `LookupMembers`, and `Diagnostic.Phase`.
