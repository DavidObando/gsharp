# ADR-0231: Conditional inclusion and intrinsic symbol queries

- **Status**: Accepted
- **Date**: 2026-11-24
- **Phase**: Language semantics / compiler configuration
- **Related**: [ADR-0047](0047-attribute-syntax-and-declaration.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0175](0175-scoped-diagnostic-suppression.md),
  [ADR-0225](0225-prefix-bind-diagnostic-finality.md),
  [ADR-0230](0230-scoped-conditional-symbol-definitions.md),
  issue [#6101](https://github.com/DavidObando/gsharp/issues/6101)

## Context

ADR-0230 defines scoped symbol state and project inputs.
Programs also need to query that state and exclude code requiring unavailable APIs.
These are different operations.
An ordinary `if` binds both arms even when its condition is constant.
Constant folding does not make an unavailable API valid.

The maintainer selected `@defined("NAME")` instead of `defined("NAME")`.
The sigil distinguishes compiler syntax from a call to a user function.
The maintainer approved implementation on November 24, 2026.
Acceptance is not a claim that existing published compilers implement the contract.

## Decision

### 1. One symbol environment

Both features consume ADR-0230's effective symbol state and symbol-name validator.
They do not maintain independent symbol sets.
Names are case-sensitive.
No runtime reflection, value-bearing symbols, macros, or textual directives are introduced.

### 2. Intrinsic expression query

Introduce the primary expression:

```text
@defined("NAME")
```

It accepts exactly one string literal under ADR-0230's name rules.
It produces a constant `bool` using effective state at its original source position.
It is valid wherever a constant boolean expression is valid.
No user function, variable, attribute, or type lookup participates.
An ordinary user function called `defined` remains callable as `defined(...)`.
The lexer and parser recognize the intrinsic only in expression position.
It is not a CLR attribute and emits no runtime call or metadata.

```gsharp
const verbose = @defined("DEBUG")
let level = if @defined("DEBUG") { 3 } else { 1 }
```

Ordinary `if` keeps its existing binding rules.
Both arms must be valid G# with resolvable names and valid types.
Do not make binding depend on whether a constant came directly from `@defined`.
Extracting a condition into a local must not change whether unavailable code is checked.

### 3. Conditional inclusion

Introduce compiler-intrinsic `@If(predicate)` and its `IfAttribute` alias.
Permit the following predicate grammar:

```text
predicate = @defined("NAME")
          | true
          | false
          | !predicate
          | predicate && predicate
          | predicate || predicate
          | (predicate)
```

Use ordinary boolean precedence.
Recognize predicates directly from syntax before declaration collection.
Do not bind predicate names, constants, operators, or function calls.
Validate the complete predicate, including short-circuited operands.

Reject arbitrary calls, plain `defined(...)`, bare symbols, string predicates,
constant references, `==`, `!=`, and other operators.
Require exactly one positional argument and at most one inclusion annotation per owner.
Combine conditions with `&&` rather than stacking annotations.
Malformed predicates require errors at their original source locations.

### 4. Inclusion uses inherited state

The inclusion condition of a node sees its strict ancestors' symbol annotations and compilation defaults.
It does not see define/undefine annotations on the same node.
A file inclusion condition sees compilation defaults only.

First determine whether an ancestor is active.
Then evaluate a node's inclusion condition using inherited state.
Only active nodes supply their own overrides to descendants.
This top-down rule has no binding or constant-evaluation cycle.

```gsharp
@UndefineSymbol("FAST")
func Example() {
    @DefineSymbol("FAST")
    @If(@defined("FAST")) {
        Unavailable()
    }

    @DefineSymbol("FAST") {
        @If(@defined("FAST")) {
            Available()
        }
    }
}
```

The first conditional block is inactive: it cannot enable itself.
The inner conditional block is active because its parent defines `FAST`.
No warning is required merely because the same node mentions a symbol in both annotations.
The specified inherited-state rule is authoritative.
An ordinary `@defined` expression inside an active body sees that body's own applicable overrides.

### 5. Eligible positions and scopes

Permit inclusion on:

- Files through `@file:If(...)`.
- Types, aliases, delegates, and nested types.
- Functions, constructors, operators, destructors, fields, properties, and events.
- Enum members.
- Local functions and local `let`, `var`, or `const` declarations.
- Ordinary annotated blocks.

Reject inclusion on parameters, generic parameters, individual accessors, imports,
base-list entries, switch arms, individual attribute applications, and other executable statements.
Assembly, module, return, and other explicit targets are invalid.
The file form follows ADR-0230's file-header placement.

An annotated block remains an ordinary block.
It does not export locals or extend their lifetime beyond its closing brace.
Use inclusion directly on a local declaration when the local must belong to the enclosing scope.

```gsharp
func Run() {
    @If(@defined("TRACE"))
    let timer = Stopwatch.StartNew()

    Work()

    @If(@defined("TRACE")) {
        Log(timer.Elapsed)
    }
}
```

There are no sibling `@Else` or `@ElseIf` annotations.
Write explicit mutually exclusive predicates.

```gsharp
@If(@defined("WINDOWS"))
func ReadSecret(name string) string? {
    return NativeVault.Read(name)
}

@If(!@defined("WINDOWS"))
func ReadSecret(name string) string? {
    return Environment.GetEnvironmentVariable(name)
}
```

Exactly one declaration participates.
Ordinary duplicate-declaration diagnostics apply if conditions activate conflicting declarations.

### 6. Inactive code

Inactive source must parse.
Retain syntax diagnostics, source spans, comments, and the original syntax tree.
This is semantic conditional inclusion, not lexical exclusion.

Inactive nodes:

- Contribute no declarations, overloads, partial parts, enum members, or documentation entries.
- Are not bound, flow-analyzed, captured, lowered, or emitted.
- Export no assignments, nullability facts, pattern variables, or definite-assignment facts.
- Contribute no `yield`, suspension, or inferred iterator/async classification.
- Produce no semantic diagnostics from their bodies or ordinary attributes.

Validate inclusion predicate syntax even inside inactive ancestors.
Do not resolve other inactive annotations.
An inactive file contributes no imports or executable top-level statements.
Removing inactive enum members affects subsequent implicit values.
Users requiring stable public enum values must write explicit values.

Reflection sees active declarations only.
The intrinsic inclusion annotation produces no metadata.
Generic type arguments do not change inclusion; decisions depend on lexical configuration, not instantiation.

### 7. Compiler and editor integration

Maintain one active-code view owned by the compilation.
Its answers depend on syntax-tree identity and the compilation's base symbols.
A tree shared by two compilations can have different active nodes.
Do not place evaluated activity in a syntax-tree-only or process-global cache.

All semantic declaration enumeration, statement binding, iterator classification,
documentation emission, and metadata discovery must use the shared activity decision.
Do not filter only method-body binding while still registering inactive declarations.
Keep ordinary syntax enumeration available to the formatter and syntax tools.

Annotation edits and base-symbol changes invalidate dependent bindings.
Body-only edits that change an active `yield` must invalidate signature classification too.
Full, incremental, prefix, and speculative binding must agree.
Semantic queries on inactive source return no bound symbol or type.
The language server uses project symbols and marks inactive source without inventing semantic diagnostics.
Formatting preserves and formats both active and inactive syntax.

### 8. Compatibility limits and translation

Inactive text must be valid syntax supported by the compiler parsing it.
This feature cannot hide newer syntax from an older parser.
It cannot split type headers, base lists, argument lists, expressions, or unmatched braces.
It does not reproduce C# lexical preprocessing.

cs2gs continues to translate the selected active C# configuration.
It must not claim to reconstruct inactive branches without their semantic models.
ADR-0230's symbol-state preservation solves #6101 independently of conditional inclusion.
Any configuration-portable translation mode remains separate work.

### 9. Validation and rollout

Supply ADR-0154 RED/GREEN or product-mutant witnesses for:

- Intrinsic boolean results, constant contexts, case sensitivity, and ordinary `defined` function coexistence.
- Ordinary `if` checking both arms regardless of constant query results.
- Exclusive same-signature declarations and unavailable APIs in inactive code.
- Nearest define/undefine state, strict-parent inclusion, and inactive-file imports.
- Invalid predicates in inactive ancestors and retained syntax diagnostics.
- Conditional locals, block lifetime, flow facts, enum values, and partial types.
- Inactive `yield`, captures, deferred effects, and incremental classification changes.
- One tree used with two compilation symbol sets.
- Driver/SDK inputs, editor activity, semantic-model answers, and formatter fixed points.
- Deterministic emitted behavior and metadata with no inactive executable effects.

Tests for new syntax use input strings compiled by the in-tree compiler.
Compiler source remains compatible with the specified published N-1 compiler.
Release supporting compiler and tooling first.
Adopt that release through a separate SDK-pin PR before repository source uses the new constructs.
Do not weaken the existing #6101 differential or merge its correction while the consumer remains incorrect.

## Consequences

Queries are visibly compiler syntax and cannot collide with ordinary user functions.
Conditional inclusion supports unavailable platform APIs without changing ordinary `if`.
The model composes with file, declaration, and block symbol overrides.

Declaration collection, flow, editor semantics, and incremental caches must share activity decisions.
Inactive code remains a syntax responsibility.
The language does not gain textual preprocessing or automatic multi-configuration translation.

## Alternatives considered

- **Plain `defined(...)`:** can collide with user-declared functions.
- **Ordinary `if` skips binding for intrinsic conditions:** makes type checking depend on expression spelling and refactoring.
- **String predicate language:** adds a second parser and awkward diagnostic offsets.
- **Transparent blocks:** makes local scope and disposal depend on annotation spelling.
- **Sibling else annotations:** couples inclusion to adjacency rather than explicit conditions.
- **Own-node definitions enable inclusion:** permits self-enabling declarations and obscures evaluation order.
- **Physical syntax-tree deletion:** loses source identity needed by formatting and editor tools.
- **Lexical preprocessing:** exceeds this story's scoped semantic model.
