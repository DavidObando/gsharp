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
    // D6.6: reuses the declarations and unchanged bodies of the previous cut
    func BindPrefix(tree SyntaxTree, cut int32, options PrefixBindOptions, previous PrefixBindResult?,
                    cancellationToken CancellationToken = default(CancellationToken)) PrefixBindResult
}

class SemanticModel {
    func GetExpectedType(position int32, cancellationToken CancellationToken = default(CancellationToken)) TypeSymbol?
}

class SyntaxTree {
    shared func ParseExpression(text string) ExpressionSyntax?
    shared func ParseStatement(text string) StatementSyntax?
}
```

- `PrefixRemainder.Nothing` means that nothing follows the cut. Any declaration can still follow.
- `PrefixRemainder.KeepDeclarations` means that the declarations after the cut in the host's tree follow. The bind removes the text from the cut to the end of the member that contains the cut. When the cut is in the top-level statements, it also removes the later top-level statements and keeps the later declarations.
- `BindPrefix` does not change the compilation. The result holds a new compilation, built as `WithReplacedSyntaxTree` builds one. The new compilation does not share the host's body cache and does not re-point symbols, so it cannot retire the host's compilation. A chained bind (D6.6) gives its compilation a body cache of its own.
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
| `out` parameter not assigned at exit (`GS0238`) | definite assignment of functions and function literals | `FutureDependent` (`rest-of-body`) when the body is open and the exit falls through its end, or when a return passes a `try` that is open; a completed `return` is final |
| `goto` to an undefined label (`GS0469`) | the label checks of member bodies, function literals, lambdas, rich anonymous methods, static initializer blocks and the top-level statements | `FutureDependent` (`rest-of-body`) when the body is open; for a static initializer block also when the type can get a later part; for the top-level statements when a later top-level statement can follow (with `Nothing`, or with the cut in the top-level statements) |
| A type misses an interface or abstract member (`GS0187`, `GS0320`, `GS0387` and the static-virtual and conflicting-default reports; a mismatch or a duplicate stays final) | each type in `VerifyInterfaceImplementations` and `VerifyAbstractMethodImplementations` | `FutureDependent` (`rest-of-type`) when the type or one of its partial parts is open, or with `Nothing` when the type is partial (a later part can follow) |
| `try` without `catch` or `finally` (`GS0118`), `fallthrough` in the final arm (`GS0533`), a switch statement that is not exhaustive (`GS0178`) | the statement binder | `FutureDependent` (`rest-of-statement`) when the `try` or `switch` is open, or when the `try` is the last construct before the cut (a `catch` can follow) |
| A partial method without an implementing part (`GS0609`) | the partial-method merger | `FutureDependent` (`rest-of-type`) with `Nothing`: a later part can implement it |
| A switch *expression* without a `default` arm (`GS0176`), not exhaustive (`GS0177`), or with arms that do not unify (`GS0179`) | the switch-expression binder | `FutureDependent` (`rest-of-statement`) when the switch expression is open; the arm checks only when no target type fixes the result type |
| Overload resolution and argument checks (`GS0144`, `GS0151`, `GS0154`, `GS0266`, the variadic, type-argument, named-argument, by-reference and base-constructor reports) | the overload funnel of `DiagnosticBag`, with the callee of the innermost call that the binder resolves | the premise of a failed lookup of the callee (D6.5): `later-declaration` for a simple-name callee, `later-member` for a member callee; `Final` for a local or a parameter of a function type |
| A diagnostic of an argument that the chosen candidate types: the conversion of the argument, or a diagnostic inside a function literal, lambda, `nil` or other argument without a type of its own | the call frames of `DiagnosticBag` | the premise of the call's callee, as above (D6.5) |
| An operator that is not defined (`GS0128`, `GS0129`) | the operator reports of `DiagnosticBag` | `FutureDependent` (`later-member`) with `Nothing`: a later receiver-form `operator` (ADR-0035) can declare it for any operand type, built-in types included |
| A missing conversion (`GS0155` and the implicit form) to or from a type of this compilation | the conversion reports of `DiagnosticBag` | `FutureDependent` (`later-declaration`) with `Nothing`: a later `func operator implicit` (ADR-0120) can declare it |
| `guard let` else block does not exit (`GS0297`), `async let` never awaited (`GS0559`) | the statement binder | `FutureDependent` (`rest-of-body`) when the else block or the `scope` block is open |
| Unknown simple name (`GS0125`, `GS0130`, `GS0113`, and `GS0157` for a name used as a type receiver) | the failed-lookup reports of `DiagnosticBag` | `FutureDependent` (`later-declaration`) when a later declaration can declare the name; otherwise final |
| Unknown member (`GS0158`, `GS0159`) | the failed-lookup reports of `DiagnosticBag` | `FutureDependent` (`later-member`) with `Nothing`; `Final` with `KeepDeclarations` |
| A lexer diagnostic of a token that the cut left unfinished (an unterminated string, comment, character literal or interpolation hole; the lexer states it when it reaches the end of its input), or a parse diagnostic before the cut that the host's tree does not report | `BindPrefix` | `Artifact` (`cut`): text after the cut can complete the token, or the seal caused the diagnostic |
| A diagnostic that ends with a name, keyword or number at the cut (`val` of `val/*cut*/ue`) | `BindPrefix` | `FutureDependent` (`rest-of-statement`) with `Nothing`, and with `KeepDeclarations` when the word goes on after the cut |
| A diagnostic in the text that the bind removed (at or after the cut, before the kept text; with `Nothing` or when nothing is kept, everything at or after the cut, also when the host's text ends there) | `BindPrefix` | `Artifact` (`cut`) |
| A diagnostic located on a construct that is open at the cut (the whole span of a call whose argument list the seal closed) | `BindPrefix` | `FutureDependent` (`rest-of-statement`) |
| A diagnostic in kept text that the host's compilation does not report | `BindPrefix` | `FutureDependent` (`rest-of-body`): it depends on the removed text |
| Every other diagnostic | | `Final` |

"A later declaration can declare the name" is true in these cases:

- `Nothing`: always. A simple-name lookup ends in the file scope, and a declaration after the cut can add a top-level function, type or global.
- `KeepDeclarations` with the cut in the top-level statements: always, because a later top-level `var` is a statement and the bind removes it.
- `KeepDeclarations` with the cut in a member: only in a function literal or lambda of the open member. Such a body can use a local that a later statement declares (`let first = func () { second() }; let second = …`). A plain statement cannot use a later local.

"A later declaration can declare the member" is true with `Nothing`, and false with `KeepDeclarations`, also when the cut is in the top-level statements. A later receiver function (`func (v T) Name()`) can satisfy an earlier `x.Name()` on any receiver type, imported types included, and so can a later member of an open or partial type. With `Nothing` this includes a static member of an imported class: a later source type with the same simple name hides the imported type (`import System` and a later `class Console` with a shared `WriteLin` compile with gsc 0.5.698).

The failed-lookup premise reads the prefix cut from an ambient value (`PrefixBindingContext`, an `AsyncLocal`, as `NullabilityOptions` does). `Compilation` sets it for the declaration and body binds when one of its trees is a prefix tree. A failed lookup in any tree can depend on a declaration after the cut, so the premise is a property of the compilation, not of the tree that holds the reference.

This is not an ID list. The same ID gets different finalities at different sites (a `GS0159` is future-dependent with `Nothing` and final with `KeepDeclarations`; a `GS0100` is future-dependent for an open body and final for a closed one). A new ID that a binder reports under a premise gets the premise. A report that states no premise is final by default. The tests check the samples and the shapes in this table, but they cannot find a new report that misses its premise in a shape that the samples do not contain.

### D4. Complete programs do not change

Every premise is conditional on a prefix tree. A tree from `SyntaxTree.Parse` has no sealed tokens and no prefix cut, so no premise holds and no diagnostic gets a stamp. `Diagnostic` keeps the finality in internal members. `Properties` does not change.

### D5. Scope and open constructs

`Scope` is `SemanticModel.LookupSymbols(cut)` on the prefix tree. The sealed tokens sit at the cut, and the locals of the open blocks are in scope there. `SemanticModel` treats a region that a sealed token closes as open at the cut, also when a real `}` of an inner block ends just before the cut. `OpenConstructs` lists the construct that owns each sealed token, innermost first. A body of a declaration reports the declaration, its symbol and, for a function, its return type. A function literal that initializes a local reports the literal, its function and its return type; another literal reports neither. A type body whose closing brace the host's tree does not have is sealed like any open construct.

### D6. Deviations from the Oats design note

1. **No `SealedAtCut` parser mode with suppressed diagnostics.** The note proposed that the parser close every construct at end of input without "expected `}`" errors. This ADR seals at the token level instead, so the parser does not change. Parse errors that the seal causes are reported and classified `Artifact`. A construct without a delimiter (an `if` header before its `{`) is not in `OpenConstructs`. `OpenConstruct.ExpectedType` is the return type of an open function body only; an open argument list has no parameter type yet (that needs `GetExpectedType`).
2. **`Artifact` covers parse diagnostics that the seal causes, not only diagnostics after the cut.** In `KeepDeclarations`, a diagnostic in kept text is not an artifact.
3. **Unknown members of imported types are not always final.** The note made a member of an imported type final. A later receiver function can declare an instance member of any type, and member lookup reads receiver functions. A later source type can also hide an imported type of the same name. With `Nothing`, every unknown member is therefore `FutureDependent` (`later-member`); with `KeepDeclarations` it is final. A host that expects neither later receiver functions nor hiding types can treat `later-member` as final.
4. **`KeepDeclarations` is not final for every unknown name.** The note made it final because all later declarations are present. Later top-level statements and later statements of the open member are not present, and a function literal can use a later local.
5. **Overload resolution** (#6078). An overload or argument failure has the premise of a failed lookup of its callee. The binder pushes a call frame when it resolves a call (a simple-name call, a member call, a base call). The overload reports read the innermost frame. A report outside a frame, or in a function literal of a call, gets the simple-name premise, which holds whenever the member premise holds. With `Nothing`, every failure is `FutureDependent`: a later overload of a source function, a later member of an open or partial type, a later receiver function, or a later type that hides an imported type can add a candidate. A static call of an imported class also stays `FutureDependent` with `Nothing`. Its failure is reported as an unknown member (`GS0159`), and a later source type of the same simple name hides the imported class (a later `class Math` removes the `GS0159` of `Math.Max(1)`). The note and #6078 made it final; D6.3 rules it out. With `KeepDeclarations`, a failure is final, except for a simple-name callee in the top-level statements or in a function literal of the open member, as for an unknown name. A call of a local or a parameter of a function type is final: no later text changes its signature, and a later local of the same name in the same block is a redeclaration. The exception is a call in a function literal (in any member before the cut with `Nothing`, in the open member with `KeepDeclarations`): a later local of the same name in the literal's block can shadow the callee, so it gets the `later-declaration` premise. A candidate also types its function literal arguments and converts each argument. A report while the binder resolves a call gets the call's premise when it is the conversion of an argument, or when it is inside an argument that has no type of its own (a function literal, `nil`, a collection, a conditional). A function literal's frame passes such a report to the call around it. The premise is stamped when the binder reports, so a body that the cache serves (D6.6) keeps it. Instance calls of a closed, non-partial source type are `FutureDependent` with `Nothing` as a conservative choice: a later receiver function of the same name did not remove the report in the tests. Two related families have the same kind of premise: an undefined operator (a later receiver-form `operator`, also on `string` and `int32`) and a missing conversion that involves a type of this compilation (a later `func operator implicit`).
6. **Reuse for successive cuts** (#6079). The overload with `previous` builds the prefix compilation as `previous.Compilation.ReplaceSyntaxTree(previous.SyntaxTree, prefixTree)` when the previous result comes from a compilation with the same other trees, the same reference resolver, the same options and the same `PrefixRemainder`. Otherwise it binds from scratch. `ReplaceSyntaxTree` reuses the global scope when the two prefix trees differ only in member bodies (ADR-0105 phase 2), and binds from scratch otherwise. For a prefix tree, the skeleton of the body-only check gives the open body the text that the bind removed after the cut, so that two cuts in one body have the same skeleton. When both prefix trees have the same host text, the spans of the unchanged bodies do not move, so the edited tree is not marked dirty and the body cache (ADR-0105 phase 1, which a chained prefix compilation enables; a bind without `previous` does not pay for one) serves every body whose text did not change; the open body misses its hash and binds again. Reuse retires `previous.Compilation` (ADR-0212 §7a). A body served from the cache keeps the syntax nodes of the previous prefix tree, so a semantic-model query on `result.Compilation` answers for the open member and for the declarations, and can answer nothing for a node in another member body. The classified diagnostics, the scope and the open constructs are the same as without `previous`. A file with top-level statements or a partial type, or whose declarations report a diagnostic, never reuses the global scope (the limits of `IncrementalGlobalScopeReuse`). The test plan compares the two binds at successive statement boundaries of 145 samples, in both modes, with the top-level statements moved into a function.
7. **Library-host members** (#6079). `SemanticModel.GetExpectedType` answers the parameter type of an argument slot when every candidate agrees (the member group when the compilation records it, the called function otherwise), the declared type of a variable initializer, the return type of a `return` (the declared return type of a function literal or of the function; none in a lambda, in a literal without a declared return type, or in an `async` or suspending function), and the variable type of an assignment. The header of a function literal or lambda gets the type of its context; its body starts another context. `GetDeclaredSymbol` of a function literal answers its function. `SyntaxTree.ParseExpression` (with the expression grammar, so a function literal and a block expression parse) and `ParseStatement` parse a fragment on its own and return `null` when the text is not exactly one expression or statement. `GetDeclaredSymbol` answers for a `ParameterSyntax` and a `VariableDeclarationSyntax`, and `GetSymbolInfo` of a call of a source type's `init` answers the chosen constructor's function. `SemanticModel.GetSpeculativeStatementDiagnostics`, `GetSymbolInfo` of an imported constructor, `Diagnostic.Phase` and a `LookupMembers` cache are not in this change (see Follow-ups). `PrefixBindResult` also has `SyntaxTree`, so that a host can query the prefix tree.

## Consequences

- A host gets the finality of each diagnostic from the binder, and a reason it can use for its own policy.
- On the samples, cut at up to 30 statement boundaries each (3922 checks in both modes), no final diagnostic is missing from the complete file at the same ID and span. Before the premises, 370 were.
- For each sample, `BindPrefix` at the end of the text with `KeepDeclarations` reports exactly `GetDiagnostics()`, all final. For the 194 programs in `samples/` and the Core test data, `GetDiagnostics()` gives the same ID, span, severity, message, property count and additional-location count before and after the change.
- The cost of a check is the cost of a plain bind of the prefix text plus the scope query. On the samples (3922 checks, scope included), `BindPrefix` takes 2.5 ms at p50 and 9.8 ms at p95. A plain `Compilation(...).GetDiagnostics()` of the same prefix texts takes 2.3 ms and 8.8 ms on the same machine.
- The `DiagnosticBag` failed-lookup, overload, operator and conversion reports read one `AsyncLocal` value. A call binding pushes a call frame only in a prefix bind; outside one it reads the same `AsyncLocal` value once.
- Reuse (D6.6): on the 145 samples in member form, 2818 cuts in both modes, a bind with `previous` took 2.1 to 2.4 ms at p50 and 4.0 to 4.4 ms mean, against 4.2 to 4.6 ms and 6.2 to 6.8 ms for a bind from scratch (two runs on a shared machine). A bind from scratch is the same code path as before this change. 2444 of the 2460 chained binds reused the declarations.

## Alternatives considered

- **An ID list in the host** (S1). It cannot generalize: the same ID is final at one site and future-dependent at another.
- **`Diagnostic.Properties["finality"]`.** It is visible to every host, so it would change the diagnostics of the prefix compilation for hosts that compare properties. The internal members keep `Properties` as it is; `ClassifiedDiagnostic` is the public form.
- **A text seal in the compiler.** A text seal changes positions after the cut and needs a placeholder statement, which can make code unreachable.
- **A post-pass over the diagnostics.** A post-pass does not know the lookup scope or the receiver of a failed lookup.

## Follow-ups

- A call that succeeds before the cut can resolve to a later, better overload after it. A diagnostic of the call's result (`let x int32 = F(1)` with `F(object) string`) is then removable, but no premise states it.
- Reuse of the global scope for a file with top-level statements, the main shape of the samples (D6.6).
- `GetSpeculativeStatementDiagnostics`, `GetSymbolInfo` of an imported constructor, the cost of `LookupMembers`, and `Diagnostic.Phase` (D6.7).
