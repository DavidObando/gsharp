# ADR-0071: `if let` / `guard let` bindings for nullable narrowing

- **Status**: Accepted
- **Date**: 2026-06-11
- **Phase**: Phase 9 — language depth / flow analysis ergonomics
- **Related**: ADR-0001 (nullable reference types), ADR-0069 (Kotlin-style smart cast), parent [#706](https://github.com/DavidObando/gsharp/issues/706) (control-flow polish), this ADR [#708](https://github.com/DavidObando/gsharp/issues/708), superseded [#696](https://github.com/DavidObando/gsharp/issues/696)

## Context

G# already lets a programmer narrow a nullable receiver by writing the canonical
nil-guard:

```gs
func Speak(name string?) {
    if name != nil {
        Console.WriteLine(name.Length)    // name binds at `string` here
    }
}
```

The infrastructure for this lives in `BinderContext.NarrowedVariables` and the
classifier helpers `TryClassifyNilGuard` / `TryClassifyTypeTestNarrowing` /
`TryClassifyBoolCallNarrowing` (ADR-0069 added the `is`/`!is` axis on top of
the same mechanism). Reads of a narrowed variable carry a `NarrowedType` that
overrides the variable's declared type for member lookup, overload resolution,
conversion, and IL emit (`unbox.any` / `castclass` are inserted only when the
representations differ).

What the existing surface does **not** give the programmer is a way to bind
the narrowed value to a **fresh name** at the test site. This matters when:

1. The nullable expression is not a bare variable — the programmer has to
   spell `let v = lookup(); if v != nil { … v … }` so the narrowing has a
   variable to attach to. With three or four bindings in sequence (parse a
   header, look up a session, decode a payload) the boilerplate dwarfs the
   payload.
2. The early-exit ("guard") shape uses an awkward double-negative
   (`if v == nil { return }` to lift `v` to non-nil in the rest of the
   function). The Swift `guard let v = expr else { return }` form spells the
   same control flow in the positive direction and binds `v` at type `T`
   directly.

Issue [#708](https://github.com/DavidObando/gsharp/issues/708) asks G# to add
both shapes; issue [#696](https://github.com/DavidObando/gsharp/issues/696)
asked for the `guard` half independently and is closed as superseded by this
ADR's combined surface.

## Decision

Add two new statement forms whose left-hand side is a *binding*
(`let name = expr`) rather than a *condition*:

```ebnf
IfLetStmt     ::= 'if' LetBinding (',' LetBinding)* Block ('else' Block)?
GuardLetStmt  ::= 'guard' LetBinding (',' LetBinding)* 'else' Block
LetBinding    ::= 'let' identifier TypeClause? '=' Expression
```

Each `LetBinding`'s right-hand side must bind to a **nullable type** `T?`. The
new local introduced on the left-hand side is bound at the underlying type `T`
(non-null) in the region where the binding is in scope. Both shapes accept
multiple comma-separated bindings; later bindings are evaluated only when
prior bindings produced a non-nil value (Swift-style short-circuit).

### `if let`

```gs
if let s = TryParse(input) {
    Console.WriteLine(s.Length)         // s : string  (declared T = string)
} else {
    Console.WriteLine("not parseable")
}
```

The bound name `s` lives only in the then-block. The else-block does **not**
see it. The bound tree shape is

```
{
    let s string? = TryParse(input)
    if s != nil { <then with s narrowed to string> } else { <else> }
}
```

with the existing nil-guard narrowing path producing `s.NarrowedType = string`
inside the then-branch. No new bound node is introduced — the lowering is
expressed purely in terms of `BoundVariableDeclaration`, `BoundIfStatement`,
and `BoundBlockStatement`.

Multiple bindings without an `else` arm nest:

```
if let a = e1, let b = e2 { body }
=>
{
    let a T1? = e1
    if a != nil {
        let b T2? = e2
        if b != nil { body }
    }
}
```

Multiple bindings **with** an `else` arm use a synthesized `bool` flag so the
else-block appears in the bound tree exactly once:

```
{
    var __ifLet_matched_<pos> = false
    let a T1? = e1
    if a != nil {
        let b T2? = e2
        if b != nil {
            __ifLet_matched_<pos> = true
            body
        }
    }
    if !__ifLet_matched_<pos> { else }
}
```

The flag is set *before* the body so an early `return`/`throw`/`break`/
`continue` inside the body never observes a partial match.

### `guard let`

```gs
func Process(input string?) {
    guard let s = input else { return }
    Console.WriteLine(s.Length)         // s : string for the rest of Process
}
```

`guard let` binds the new name into the **enclosing block's scope** — exactly
the lifetime the `let` keyword would give it if it were written at the
statement position guard-let occupies. The else-block must terminate the
enclosing scope (`return`, `throw`, `break`, `continue`, or any block whose
last statement does so; an `if/else` qualifies only when both arms exit).
Failing this requirement reports **GS0297**.

The bound shape is a flat sequence interleaved into the enclosing block:

```
guard let a = e1, let b = e2 else { exit }
=>
let a T1? = e1
if a == nil { exit }
let b T2? = e2
if b == nil { exit }
```

Each `if … nil` carries the same else-frame the existing nil-guard classifier
produces, and the existing early-exit lift
(`StatementBinder.ApplyEarlyExitNarrowings`) promotes those frames into the
enclosing block's persistent narrowing frame. The result is that `a` is
typed `T1` and `b` is typed `T2` for every subsequent statement in the
enclosing block, with zero new infrastructure.

To make this work without adding a new "split statement" type, `guard let` is
recognized at the call site of `BindBlockStatements` alongside the existing
specials (`defer`, `using`, `await using`): when the binder sees a
`GuardLetStatementSyntax`, it appends each declaration / nil-check pair
directly into the enclosing statement builder rather than returning a single
`BoundStatement`. The else block is bound **once** and shared (by reference)
across the duplicated nil-check arms — at runtime only one copy executes,
because the first failing binding exits the scope.

### Diagnostics

- **GS0296** *error* — the right-hand side of an `if let` / `guard let`
  binding is not of nullable type. The binding is rejected; subsequent
  diagnostics still fire so the user gets a complete picture.
- **GS0297** *error* — the `guard let` else-block does not unconditionally
  exit the enclosing scope. The binder still binds the body; downstream uses
  of the narrowed local fail with their usual member-lookup diagnostics.

Both diagnostics are reported at the binder, not the parser, so the surface
spelling stays uniform regardless of where in the binding chain the error
appears.

### Type clause

A binding may carry an explicit type clause: `if let s string = expr`. The
declared type is the underlying (non-null) `T`; the binder applies the
narrowing relative to it. An explicit nullable type (`if let s string? = …`)
is rejected as it defeats the purpose of the form — the existing
`let s = …` already covers that case.

### Interaction with smart-cast (ADR-0069)

The new locals introduced by `if let` and `guard let` are
`LocalVariableSymbol` instances, so every ADR-0069 invariant applies
unchanged:

- An `is`/`!is` test inside an `if let`-then-block further narrows the new
  local exactly the way it would narrow any other local.
- An `is`/`!is` test after a `guard let` narrows the locally-extended binding
  on top of the underlying nullable-strip narrowing.
- Reassigning the new local inside its region drops the narrowing per the
  existing `InvalidateNarrowingsForAssignedVariables` rule.

The two axes compose through the existing `MergeNarrowingFrames` helper
without further work.

### Reserved keyword: `guard`

`guard` becomes a reserved keyword. A grep across `samples/`, `website/`, and
the in-tree language conformance suites finds zero uses of `guard` as an
identifier, so the change is purely additive. This matches the precedent
ADR-0070 set for `do` and `while` (reserved rather than contextual so
downstream tooling — highlighter, formatter, completion — treats the keyword
uniformly).

`let` remains the existing reserved keyword; no change is needed to recognize
`if let` / `guard let` headers.

## Considered alternatives

- **C# pattern syntax (`if (expr is T name) { … }`)** — already partially
  available through the ADR-0069 `is` operator, but only at the expression
  level on a value already in a variable. Adding a binding *declaration*
  to the pattern grammar would require new pattern syntax and a new pattern
  binder node. The Swift surface composes more cleanly with `&&` chains,
  multiple bindings, and the existing early-exit lift.
- **`if (let name = expr) { … }`** (Rust-2018) — adds parentheses for no
  ergonomic gain over the Swift surface and conflicts with the existing
  parenthesized expression syntax.
- **Reusing `if init; cond` with an implicit nil-check** — `if let s = expr; s != nil` would technically lower to the same shape, but it forces every caller
  to re-spell the condition and burdens the binder with disambiguating the
  *missing* condition. The Swift surface is the established idiom for this
  shape; adopting it directly is cheaper than inventing one.
- **No `guard let`; only `if let`** — would leave the early-exit case as
  awkward as it is today (`if let s = expr {} else { return }` does not bind
  `s` in the rest of the function). The Swift surface explicitly chose two
  forms because they serve different scopes; G# does the same.
- **Allow `guard let` else to *omit* the exit and instead make the rest of
  the function unreachable on the absent path** — would surface a different
  diagnostic (unreachable-after-guard) instead of GS0297 and would make the
  contract harder to read at the source site. Rejected; matching Swift's
  requirement that the else exits is the clearer rule.
- **Bind the new name at the *nullable* type and rely solely on the
  narrowing path** — works, but at the source site reads strangely (the
  programmer wrote `let s = …` and expected `s : T`, not `T?`). The bound
  tree still uses the nullable type for the storage; only the user-observed
  type at every read site is `T`, which is exactly what the existing
  narrowing path does. The user-facing model is "the new name is `T`".

## Migration impact

Purely additive. No existing program changes its meaning, because

1. `if let` was previously a parse error after `if`.
2. `guard` was not a keyword (and is not used as an identifier in any
   in-tree source); adding it is invisible to programs that did not use
   the name.
3. The bound tree shapes produced for the new forms are identical to what
   a programmer could write by hand today, so the emit and interpreter
   paths pick them up automatically.

No `BoundNodeKind` is added by this ADR, so the bound-tree machinery
(`BoundTreeRewriter`, `BoundTreeWalker`, `BoundNodePrinter`,
`SpillSequenceSpiller`, `EmitExpression`, and the
`BoundNodeKindExhaustivenessTests` allowlists) requires no updates beyond
the new `SyntaxKind` entries.
