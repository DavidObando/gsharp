# ADR-0161: Retire the `=` named-argument separator; `=` in argument position is assignment

- **Status**: Accepted
- **Date**: 2026-08-11
- **Phase**: Phase 6 (cleanup) / Phase 9 (language depth)
- **Related**: ADR-0080 (deprecated `name = value`, GS0315), ADR-0032 (`.copy(field = value)` sugar), ADR-0047 (attribute argument lists), ADR-0121 (`throw` promoted from statement to expression — the precedent for widening an expression position), issue [#3350](https://github.com/DavidObando/gsharp/issues/3350), parent [#3347](https://github.com/DavidObando/gsharp/issues/3347), original deprecation issue #720 under parent #706

## Context

ADR-0080 deprecated the legacy `name = value` named-argument spelling in favour of the canonical
`name: value`, emitting `GS0315` as a one-release warning, and committed to a follow-up that would
"flip the diagnostic to an error and delete the parser branch". This is that follow-up — but it
resolves the token differently, and for a reason ADR-0080 could not have anticipated.

While auditing cs2gs's synthetic spills (#3347), the claim that "G# assignment is statement-only"
turned out to be **false**. It survives in several cs2gs comments, but the language has had
assignment as a full expression for some time: `ParseExpression()` delegates to
`ParseAssignmentExpression()`, the bound nodes are `Bound*AssignmentExpression`, and
`BoundAssignmentExpression.Type` is the assigned value's type. All of these compile and behave
correctly today, verified at runtime:

```gs
a = b = c = 5                              // chained
let x = (P = 5)                            // local initializer
return P = 7                               // return position
while (line = Next()) != nil { … }         // loop condition
if a && (x = 5) > 0 { … }                  // short-circuit operand
```

with the value being the **assigned** value — a property setter runs once and its getter is never
called — and a compound assignment yielding the combined value with no getter re-read.

Exactly one position rejects it, and only because of the legacy separator:

```gs
Console.WriteLine(P = 5)
// GS0246: Named argument 'P' does not match any parameter of 'WriteLine'.
// GS0315: Named argument 'P' uses the deprecated '=' separator (ADR-0080).
```

So the argument list is the last place in the grammar where `=` does not mean assignment, and the
only thing keeping it that way is a spelling already scheduled for removal.

## Decision

1. **`ParseArgumentsCore` no longer treats `IDENT =` as a named argument.** The lookahead accepts
   only `IDENT :`. `GS0315` and its parser branch are deleted.

2. **`=` in argument position is an ordinary assignment expression.** `f(x = v)` assigns `v` to `x`
   and passes the assigned value as a positional argument, consistent with every other expression
   position in the language and with C#.

   This differs from ADR-0080's stated plan, which was to reject `=` and recover by synthesising a
   `:`. Rejecting it would leave the argument list as a permanent carve-out in the expression
   grammar purely to protect a retired spelling. Since the deprecation warning has already run and
   in-tree usage is zero (see Migration), the carve-out buys nothing.

3. **The one genuinely ambiguous shape is diagnosed, not silently reinterpreted.** When an argument
   is a bare assignment whose target name matches a parameter name of the resolved callable —
   `Foo(timeout = 30)` where `Foo` has a `timeout` parameter and a `timeout` variable is in scope —
   the author almost certainly meant the old named-argument form. That case reports a dedicated
   error naming both spellings:

   > `'timeout'` names a parameter of the callee and is also assignable here. Use
   > `'timeout: value'` for a named argument, or `'(timeout = value)'` for an assignment.

   Every other shape binds normally: an unassignable or out-of-scope target is already an ordinary
   binder error, and a target that does not collide with a parameter name is unambiguous.

## Consequences

### Positive

- The argument list stops being a special case; `=` means assignment everywhere.
- cs2gs can emit a value-position assignment directly instead of spilling it into a `__spillN`
  temp, removing spill sites **C1**, **C2** and **C3** from #3347.
- The `#1723` "assignment inside a short-circuited operand" gap — which cs2gs reports as unsupported
  and *silently drops the write* — has no remaining language obstacle. That was always a cs2gs
  limitation; #3347 mis-attributed it to the language, and this ADR records the correction.

### Negative / residual risk

- A bare `f(name = value)` that was a named argument becomes an assignment. Point 3 catches the
  dangerous overlap; outside it, the target is either not in scope (a loud binder error) or is a
  real variable being deliberately assigned.
- Anyone suppressing `GS0315` via `<NoWarn>` will now see a hard failure instead. That is the
  intended end state of ADR-0080's grace period.

## Migration

A sweep of every in-tree `.gs` file found **zero** uses of the `=` named-argument form: ADR-0080's
step 1 already migrated samples, tests and docs to `:`. The only remaining references are in
`Issue720NamedArgumentEqualsDeprecatedTests`, which exists to test the deprecation itself and is
rewritten here to assert the new behaviour.

## Alternatives considered

- **ADR-0080's stated plan — reject `=` with an error, recover by synthesising `:`.** Loud and
  simple, but preserves the argument list as the lone position where `=` is not assignment, and so
  keeps blocking `f(x = v)` forever. Rejected because the thing it protects is being deleted.

- **Keep the deprecated form indefinitely and have cs2gs parenthesise (`f((x = v))`).** Zero risk
  and needs no language change. Rejected as the long-term answer for the reasons ADR-0080 already
  gave — two spellings for one construct is a standing parser tax on the hottest ambiguity surface
  in the grammar — though it remains a perfectly good interim spelling, and parenthesising stays
  legal and unambiguous.
