# ADR-0182: A receiver clause always declares an extension; retire the `extension` contextual keyword

- **Status**: Accepted
- **Date**: 2026-09-15
- **Supersedes**: ADR-0165 (explicit extension receiver clauses)
- **Amends**: ADR-0019 (extension function declaration syntax), ADR-0024
  (methods-vs-extensions canonical style), ADR-0079 (restrict receiver
  clauses to non-owned types)
- **Related**: ADR-0029, ADR-0035, ADR-0115; issues #706, #719, #2821,
  #3357; parent issue #4240

## Context

ADR-0024 gave the receiver-clause form `func (r T) M() R` an
ownership-dependent meaning: a method when `T` is owned by the current
package, an extension otherwise. ADR-0079 nudged owned-type receiver-clause
methods toward the in-body form with a soft warning (`GS0314`) but stopped
short of an error, leaving the receiver-clause spelling as a second, live
way to declare an owned instance method. Same-package non-aggregate
receivers (enums, interfaces, non-struct aliases) were rejected outright
with `GS0103` — there was no way to declare a C# extension on an owned
enum, since enums have no in-body method form to fall back to.

ADR-0165 patched the enum gap and the "must stay separate from an owned
type's real members" gap by adding a contextual `extension` marker after
`func`: `func extension (r T) M() R` forces extension binding regardless of
ownership or aggregate kind. It worked, but it reintroduced exactly the
kind of ambient contextual keyword the language has been retiring
elsewhere (`:=`, the `=` named-argument separator, the `delegate` type-alias
spelling) — and it collided with ordinary use. The website's Trail sample
uses `extension` as an ordinary parameter name (`let extension string? =
...`); the Prism grammar and the VS Code TextMate grammar both had to carve
out a special case so that identifier didn't render as a keyword. That
friction is what prompted revisiting the design (issue #4240) rather than
just fixing the grammars.

The deeper issue: ADR-0079 already reserved a way out. Its "Open
follow-ups" section named the exact move — "escalation to error (and
removal of the receiver-clause method form for owned types entirely) is a
separate future ADR/issue" — but didn't take it, because at the time enums
had no owned-instance-method alternative to escalate *to*. ADR-0165 solved
the enum problem by making the receiver clause forceable into extension
mode. This ADR finishes the job ADR-0079 deferred: make that forcing
unconditional, so the marker becomes redundant and can be dropped.

## Decision

**A receiver-clause function declaration always declares an extension.**
Ownership of the receiver type no longer selects the binding: whether `T`
is a BCL primitive, a type from another package, or a class/struct/enum
the current package owns, `func (r T) M() R` binds exactly like today's
non-owned case — parameter zero is the receiver, the declaration
participates in extension overload resolution and generic inference, it
does not enter the receiver type's own method table, and it emits as the
same CLR `[Extension]`-tagged static method ADR-0019 already defined.

**Instance methods on an owned class or struct are declared in the type
body, with no receiver-clause alternative.** There is no longer an
unmarked receiver-clause spelling that means "instance method" — `GS0314`
and the two-spellings problem it was warning about both disappear, because
the receiver-clause form no longer has that meaning to warn about.

**The `extension` contextual keyword is retired.** Since every receiver
clause is now an extension, the marker carries no information. `func
extension (r T) M() R` is a **retired spelling**: the parser recognizes the
shape (same lookahead ADR-0165 added), reports a dedicated migration error,
and recovers by parsing the declaration as an ordinary receiver-clause
extension — one clean diagnostic, no cascade, and the rest of the pipeline
sees a well-formed extension exactly as if `extension` had been dropped.
`extension` reverts to being an ordinary identifier everywhere else: `func
extension(x int32) int32 { ... }` (a plain function named `extension`) and
`func (s string) extension() string { ... }` (an extension method named
`extension`) are unaffected — the retired-spelling detection only fires
when `extension` is immediately followed by a syntactically complete
receiver-clause shape, exactly as ADR-0165's lookahead already
distinguished.

**Same-package non-aggregate receivers (enums, interfaces, non-struct
aliases) are permitted.** `GS0103` retires along with `GS0314`: it existed
only to reject same-package non-aggregate receivers under the old
ownership-dependent rule, and that rule is gone. A same-package receiver of
any kind is treated exactly like a cross-package or CLR receiver — this is
what lets `func (c Color) Rank() int32` on an owned `enum Color` compile
without any marker.

**Operators are the one carve-out, and it is unchanged from ADR-0079.**
`func (a T) operator +(b T) T { ... }` has no in-body spelling — ADR-0079
exempted operators from `GS0314` for exactly this reason, and that
exemption stands. An operator's receiver clause keeps ownership-based
routing: when the receiver is an owned struct/class, the operator attaches
to that type (participates in the type's own operator/static-method table,
exactly as today); otherwise it is an extension operator. This is narrower
than ADR-0165, which let `func extension (owned) operator ...` force even
an owned-type operator into extension mode — that capability is not
carried forward. An "extension operator" distinct from the owning type's
own operator overloads has no CLR/C#-recognized meaning; nothing in the
language exercised it, and removing it lets operators keep working exactly
as they did before ADR-0165 without inventing a replacement spelling for a
combination nothing needed. A future in-body operator form (ADR-0079's
other open follow-up) is unaffected by this decision and remains
out of scope here.

### Migration and compatibility

Two spellings change meaning or disappear; both get a clean diagnostic
rather than a silent reinterpretation:

1. **`func extension (r T) M() R`** (the ADR-0165 marker) → retired-spelling
   error (new diagnostic, below) at parse time. Fix: delete the `extension`
   word; the declaration keeps its exact current meaning and emission.
2. **`func (r T) M() R` where `T` is an owned class/struct** (the ADR-0079
   `GS0314`-warned spelling) → **changes meaning silently at the source
   level**: it compiled as an instance method (dispatch through `T`'s
   method table, participates in interface conformance and `override`,
   can read private members) and now compiles as an extension (static
   dispatch, parameter-zero receiver, no interface conformance, no private
   access). Interface-conformance loss, `override` loss, and private-member
   access are all compile errors under the new binding — visible
   immediately. The dangerous case is a receiver-clause method that
   **mutates a field on an owned struct receiver**: under instance-method
   binding the receiver was implicitly by-ref (`this`); under extension
   binding parameter zero is an ordinary by-value parameter, so the
   mutation now silently applies to a throwaway copy instead of the
   caller's struct, with no diagnostic. (This hazard is not new — it is
   exactly what already happens for any receiver-clause struct extension on
   a non-owned type today; owned struct receivers now inherit the same
   behavior instead of being exempt from it.) Because ADR-0079's Oats sweep
   already migrated every in-tree same-package receiver-clause method to
   the in-body form when `GS0314` shipped, this repository has no surviving
   instance of the hazard; the risk is scoped to source outside this tree
   that never migrated off the warned spelling. The release notes call out
   the struct-mutation hazard explicitly so anyone updating past this ADR
   knows to grep for receiver-clause methods on owned value types before
   upgrading.

No analyzer/diagnostic can distinguish "receiver-clause method on an owned
struct that mutates a field" from "receiver-clause method on an owned
struct that doesn't" without full body analysis, so this ADR does not add
one; the compile-time errors for interface/override/private-access
mismatches are the primary safety net, and the release notes are the
secondary one.

### New diagnostic

`GS0587` (Error) — **retired explicit-extension-receiver spelling**:

> The `extension` keyword before a receiver clause is retired; every
> receiver clause now declares an extension. Remove `extension` (ADR-0182).

Fires once, at the `extension` token, whenever the parser recognizes the
ADR-0165 shape (`extension` immediately followed by a complete receiver
clause). Parsing recovers by treating the declaration exactly as if
`extension` had not been written.

### Retired diagnostics

- `GS0103` (`MethodReceiverMustBeStructOrClass`) — retired. Its sole
  purpose was rejecting same-package non-aggregate receivers under the
  ownership-dependent rule this ADR removes.
- `GS0314` (`ReceiverClauseOnOwnedType`) — retired. Its sole purpose was
  warning about the two-spellings-for-one-meaning problem that no longer
  exists once the receiver-clause form has exactly one meaning.

Both IDs are reserved and must never be reused (`DiagnosticIdUniquenessTests`
enforces this, same as the ADR-0174 retirements `GS0316`/`GS0317`).

## Consequences

Positive:

- One rule for the entire receiver-clause grammar: it always means
  extension. No ownership lookup, no aggregate-kind check, no marker to
  learn.
- `extension` is once again an ordinary identifier everywhere. The website
  Prism grammar and the VS Code TextMate grammar drop their carve-out; the
  Trail sample's `extension` parameter highlights like any other
  identifier.
- Owned enums and owned classes/structs get the same extension capability
  non-owned types always had, with no special syntax.
- cs2gs's ADR-0165-specific special case (`RequiresExplicitExtensionReceiver`,
  which decided when to print the now-retired `extension` marker) is deleted
  outright: whenever cs2gs prints a receiver-clause `func` for a C# extension
  method, it is now the same plain form regardless of receiver ownership or
  kind. This is separate from cs2gs's independent, pre-existing choice
  (issue #2821, `CanLowerOwnedExtension`) to translate certain eligible
  owned-type C# extension methods into genuine in-body G# instance members
  instead of a receiver-clause extension at all — that lowering is a
  translation-style decision unrelated to the retired marker, and this ADR
  does not change it.
- Two diagnostics (`GS0103`, `GS0314`) and the two-spelling ambiguity they
  policed are gone rather than merely suppressed.

Negative:

- Source written against ADR-0079's warned spelling (an owned-type
  receiver-clause method that was never migrated to in-body) silently
  changes binding, with the struct-mutation hazard described above for the
  subset that mutates receiver fields. Mitigated by: this repository has no
  such source (migrated at ADR-0079 time); the change is called out in
  release notes; and every other consequence of the meaning change
  (interface conformance, `override`, private access) fails loudly at
  compile time.
- The "extension operator on an owned type" combination ADR-0165 allowed
  (`func extension (owned) operator ...`) has no replacement spelling. No
  in-tree or known use exercised it.

Neutral:

- Operators are unaffected in practice: the canonical, unmarked operator
  declaration on an owned type (the overwhelming majority of existing
  operator declarations, since there was never an in-body operator form)
  binds exactly as before.
- ADR-0024's core insight — one syntactic shape, `func (r T) Name(...)`,
  for every receiver-based declaration — is preserved. This ADR removes the
  *branch* on ownership, not the shape.

## Follow-ups

- An in-body operator form remains a separate, unstarted ADR (open since
  ADR-0079); it does not block this change and this ADR does not attempt
  it.
- Editor/tooling updates (Prism, TextMate, docs) are tracked as
  implementation work for this ADR rather than a future follow-up — see
  the issue #4240 acceptance criteria.
