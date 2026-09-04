# ADR-0177: `catch` clause parity with C# — type-only clauses and `when` filters

- **Status**: Proposed
- **Date**: 2026-09-04
- **Related**: issue #3897 (family 1), issue #3501 (synthetic-identifier inventory), ADR-0176 (`rethrow`), ADR-0115 (cs2gs), issues #1724 / #2235 (filtered-catch fall-through), ECMA-335 I.12.4.2.5 (exception handling), C# §13.11.

## Context

Issue #3897 reported that cs2gs lowers C# multi-clause `try` statements into a
single G# catch plus a hand-rolled type-dispatch tree bound to a synthetic
`__caught` variable — 187 tokens over 164 clauses in the Oahu corpus — and that
this duplicates handler bodies and changes observable exception behaviour.

**Two of that issue's four premises were wrong, and correcting them shrinks
this ADR substantially.** Verified on `main` at `914ce5989`:

- **Multiple `catch` clauses already work end to end.** `TryStatementSyntax`
  holds an `ImmutableArray<CatchClauseSyntax>`, `ParseTryStatement` loops while
  `Current.Kind == CatchKeyword`, `BindTryStatement` loops over them, and
  `EmitCatchClauses` emits one `AddCatchRegion` per clause. A three-clause
  program compiles and dispatches correctly. #3897's claim that the language
  lacks them is false.
- **`rethrow` shipped in ADR-0176**, and cs2gs already emits it for the
  dispatch-tree fallthrough. #3897's family 1b is closed.

What remains is narrower and sharper:

### Gap 1 — no `when` filters, which is the *sole* cause of the dispatch tree

cs2gs already translates clause-for-clause. It falls back to merging clauses
into one catch **only** when a clause has a `when` filter *and* an overlapping
later sibling (`TranslateTry`'s `mergeStartIndex` / `HasOverlappingLaterSibling`
path, added for #2235). That fallback is why `DoctorService.gs` contains the
`catch (Exception ex)` handler body twice.

The reason it must merge is a genuine semantic gap. In C#, when a clause's type
matches but its filter returns **false**, matching *continues to the next
sibling clause*. There is no way to express "this handler declines, try the
next one" with G#'s current catch-plus-`rethrow`, because a rethrow escapes the
whole `try`. So cs2gs cannot lower the shape faithfully clause-by-clause, and
merges instead.

The merged form is correct in what it computes, and lossy in how:

- **Handler bodies are duplicated** — once per path through the dispatch tree.
- **Filters run after unwinding, not during the first pass.** A CLR filter is
  evaluated in pass one, *before* any `finally` between the throw site and the
  handler runs. Catch-then-test unwinds first. This is observable: an outer
  filter or a `finally` that mutates state sees a different order, and a crash
  dump taken inside a filter still shows the original frames.

### Gap 2 — a type-only `catch` is not missing, it is a silent trap

`ParseCatchClause` reads a **mandatory identifier** followed by an **optional
type clause** — exactly inverted from C#, where the type is required and the
name optional. So the C# spelling parses as a G# *untyped* catch that binds a
variable whose name happens to be the type's name:

```gs
try {
    throw FormatException("not an InvalidOperationException")
} catch (InvalidOperationException) {        // binds a variable named `InvalidOperationException`
    Console.WriteLine("caught")              // …and catches everything
}
```

Verified: this prints `caught`. A C# developer writing a narrow catch silently
gets a catch-all, with no diagnostic. That is the same class of silent
meaning-change ADR-0176 rejected a contextual `rethrow` to avoid, except it is
already in the language.

The untyped `catch (name)` form that creates the ambiguity has **zero uses**
anywhere in the repository — samples, tests, migrated corpus and all — against
395 typed `catch (name Type)` clauses.

## Decision

Bring `catch` to C# parity along three axes. The emitter is already most of the
way there: `EmitCatchClauses` handles a null `clause.Variable` by emitting
`pop`, and `ControlFlowBuilder` (the BCL type gsc already uses) exposes
`AddFilterRegion` alongside the `AddCatchRegion` in use today.

### A. Clause forms

| Form | Meaning |
| --- | --- |
| `catch (e Type)` | typed, bound. Unchanged — the 395 existing clauses keep working. |
| `catch (Type)` | typed, **unbound**. New meaning. |
| `catch` | catch-all, unbound. Equivalent to `catch (Exception)`. New. |
| `catch (name)` | **retired.** |

`catch (X)` resolves `X` as a *type*. If no such type is in scope it is an
error — the existing undefined-type diagnostic, reported at `X`. It never
silently falls back to binding a variable. This makes the reinterpretation of
existing code loud rather than silent, and with zero occurrences of the retired
form, no existing G# source changes meaning.

Bare `catch` is listed as new because it genuinely is: ADR-0115 §B states that
a C# `catch { }` "becomes an untyped `catch { }`", but that form does not
parse — `ParseCatchClause` matches an open parenthesis unconditionally, and
cs2gs in fact synthesizes `catch (e Exception)` for it. ADR-0115's paragraph
should be corrected when this ships.

Retiring `catch (name)` rather than keeping both is what removes the ambiguity;
keeping it would require deciding `catch (Foo)` by whether a type named `Foo`
happens to be in scope, which makes meaning depend on unrelated imports.

### B. `when` filters

```gs
catch (e IOException) when e.HResult != 0 { … }
catch (IOException) when IsTransient() { … }
catch when ShouldReport() { … }
```

Parsing reuses the existing `ParseOptionalWhenGuard(bodyFollows: true)` — the
same contextual-`when` helper switch arms use (#991), so `when` stays a
contextual identifier and existing variables named `when` keep working.

`BoundCatchClause` gains a `Filter` expression (nullable, must be `bool`).
Emit uses a real CLR filter region:

```
filterStart:  <filter expr>          ; 1 = handle, 0 = decline
              endfilter
handlerStart: <store or pop exception>
              <handler body>
              leave endLabel
ControlFlow.AddFilterRegion(tryStart, tryEnd, handlerStart, handlerEnd, filterStart)
```

The exception object is on the stack on entry to the filter, exactly as it is
on entry to a handler. Because this is a genuine filter region and not a
lowering, the semantics below come from the CLR rather than from generated
code.

### C. Runtime semantics — match C#, by construction

- Clauses are matched **top to bottom**; the first whose type matches *and*
  whose filter returns true handles the exception.
- A filter returning false **continues to the next sibling clause**. This is
  the capability whose absence forces cs2gs to merge.
- Filters run in the **first pass**, before intervening `finally` blocks.
- An exception thrown *inside* a filter is swallowed and treated as a decline,
  per ECMA-335 and C#.
- An exception matching no clause is **never caught** — it propagates with its
  stack trace intact, and no `rethrow` is synthesized.

### D. Restrictions and diagnostics

| ID | Condition | C# analogue |
| --- | --- | --- |
| **GS0572** | `await` (or any suspension point) inside a filter expression. | CS7094 |
| **GS0573** | A catch clause is unreachable — an earlier unfiltered clause already catches its type. | CS0160 |

`await` in a filter is not a style rule: the CLR forbids suspending inside a
filter region, so there is no lowering. A filtered clause whose *handler* body
awaits stays legal — `AsyncExceptionHandlerRewriter` already lifts such
handlers out of the protected region, and ADR-0176 already defined how a
`rethrow` in a lifted handler becomes `ExceptionDispatchInfo.Capture(e).Throw()`.
The filter itself is not lifted, because it must keep running in pass one.

GS0573 only fires for an earlier clause with **no** filter; a filtered clause
never fully covers its type, which is precisely why C# permits a later clause
of the same type after a filtered one.

`rethrow` inside a filter is GS0570 (ADR-0176) — a filter is not a handler.

### E. cs2gs

With filters expressible, `TranslateTry` emits clause-for-clause
unconditionally. The following are deleted, not adapted:

- the `mergeStartIndex` / `HasOverlappingLaterSibling` merge path (#2235),
- `AllocateSyntheticCatchBinder` and every `__caught` name,
- the synthesized `rethrow` fallthrough — no longer reachable, because an
  unmatched exception is simply never caught.

C# `catch (T)` maps to G# `catch (T)`, and bare C# `catch` to bare G# `catch`,
so the translated text stops inventing names the author never wrote. This
retires family 1 of #3897 outright and removes 187 of the corpus's synthetic
tokens.

## Consequences

**Positive.** Retires the largest synthetic-identifier family in #3501's
"zero `__`-prefixed identifiers" goal. Removes a silent wrong-semantics trap
from the language. Removes handler-body duplication and makes filter timing
correct by delegating to the CLR instead of reproducing it. Gives hand-written
G# a capability it lacked, useful independently of translation. Unblocks
faithful translation of the `catch (X) when (…)` idiom that is common in
retry, logging and cancellation code.

**Negative.** `catch (name)` is a breaking change — mitigated by zero
occurrences and a loud error. Filter regions are new emit surface: filter
blocks have their own stack-depth and `endfilter` rules, and `ilverify`
coverage must be extended to them. `when` remains contextual, so a filter
expression starting with an identifier named `when` needs the same care switch
guards already take.

**Neutral.** ADR-0176's `rethrow` is unaffected and remains the way to re-raise
from a handler; this ADR reduces how often cs2gs needs it, not what it means.

## Alternatives considered

- **Keep the dispatch tree, hoist the duplicated body into a local function.**
  Fixes duplication only. Filter timing stays wrong and `__caught` survives, so
  it addresses the symptom #3897 leads with and not the cause.
- **Decide `catch (Foo)` contextually** by whether a type `Foo` is in scope.
  Makes meaning depend on imports; rejected for the reason ADR-0176 rejected a
  contextual `rethrow`.
- **Require a discard binder, `catch (_ Type)`, instead of a type-only form.**
  Unambiguous and a smaller parser change, but it is not C# parity, leaves the
  C# spelling silently meaning catch-all, and makes cs2gs keep inventing a name
  for every unnamed C# clause.
- **Filters as sugar for the existing lowering** (`catch (e T) { if !filter {
  rethrow } … }`). Cheap, but `rethrow` escapes the whole `try` rather than
  declining to the next clause, so it reproduces the exact bug #2235 worked
  around — and still cannot express fall-through.

## Verification plan

Executing tests, since every claim above is about runtime behaviour:

1. **Type-only catch is narrow** — the trap program above must stop catching
   `FormatException`; pre-change it prints `caught`.
2. **Fall-through on false filter** — `catch (A) when false` followed by
   `catch (A)`: the second clause runs.
3. **First-pass ordering** — a `finally` between throw site and handler appends
   to a log; the filter observes the log *before* the `finally` entry.
4. **Throwing filter declines** — a filter that throws does not propagate that
   exception and does not handle the original.
5. **Unmatched exception keeps its stack trace** — the frame of the original
   `throw` survives a `try` whose clauses all decline.
6. **Nested/async** — a filtered clause whose handler awaits still works; a
   `rethrow` in it behaves per ADR-0176.
7. **Diagnostics** — GS0572 on `await` in a filter, GS0573 on an unreachable
   clause, GS0570 on `rethrow` in a filter.
8. **cs2gs** — Oahu corpus re-run reports **zero** `__caught` occurrences and
   `DoctorService.gs` contains its handler body exactly once, with all four
   stages still green.
