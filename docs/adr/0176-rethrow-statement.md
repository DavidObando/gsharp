# ADR-0176: `rethrow` — a stack-trace-preserving rethrow statement

- **Status**: Accepted
- **Date**: 2026-09-03
- **Related**: issue #3897 (family 1b, `__caught`), issue #3501 (synthetic-identifier inventory), ADR-0115 (cs2gs), ADR-0174 (async lowering), ECMA-335 III.4.24 (`rethrow`) / III.4.31 (`throw`), C# §13.10.6.

## Context

The CLR distinguishes two operations that raise an existing exception object:

| IL | Effect on `Exception.StackTrace` | Where legal |
| --- | --- | --- |
| `throw` (`0x7A`) | **Reset** to the throw site | anywhere |
| `rethrow` (`0xFE 0x1A`) | **Preserved** — the original throw site survives | only lexically inside a catch handler |

G# had **no user-level spelling for the second one**. Verified on
`origin/main` at `70f22f762`:

- `ILOpCode.Rethrow` appears at **zero** emit sites in gsc. (Issue #3897 states
  the async-cancellation lowering emits one at
  `MethodBodyEmitter.Statements.cs:577`; that is wrong — the async path uses
  `ExceptionDispatchInfo.Capture(pendingException).Throw()`
  (`AsyncExceptionHandlerRewriter.cs`), which preserves the trace by a
  different mechanism. The gap is total, not partial.)
- The grammar had `ThrowStatementSyntax` (`throw <expr>`, operand mandatory)
  and `ThrowExpressionSyntax`. Neither can be written without an operand.

Two independent consequences:

1. **Hand-written G# cannot rethrow.** Any G# program that catches, inspects
   and re-raises an exception silently loses the original throw site. That
   degrades every crash report from such code.
2. **cs2gs's multi-clause `catch` lowering is lossy.** C# `try { } catch (A) { }
   catch (B) { }` lowers to a single G# catch plus a type-dispatch tree whose
   fallthrough was `throw __caught`. In C# an exception matching no clause is
   *never caught* and propagates intact; in the lowering it is caught and
   re-thrown, resetting the trace — across 164 catch clauses in the Oahu corpus
   alone.

## Decision

Add a statement-only keyword `rethrow`.

### Spelling

`rethrow`, a **hard keyword**, not C#'s bare `throw;`.

- **A bare `throw` is genuinely ambiguous in this grammar.** G# statements are
  not newline-terminated — the parser carries no newline sensitivity
  (`Parser.*` has no `IsOnNewLine`-style predicate), and `ParseThrowStatement`
  unconditionally calls `ParseExpression`. So
  ```
  catch (e Exception) {
      throw
      log(e)
  }
  ```
  would parse as `throw log(e)` — a silent meaning change, exactly the class of
  defect this ADR exists to remove. Disambiguating would require adding newline
  significance to statement termination, a far larger and riskier change.
- G# prefers explicit keywords over punctuation-sensitive forms and has no
  preprocessor to hide the difference.
- Reserving the word is cheap because ADR-0170 already gives every keyword an
  escape hatch: a CLR member or C# identifier named `rethrow` is spelled
  `$rethrow`. `SyntaxFacts.IsReservedIdentifier` derives from
  `GetKeywordKind`, so cs2gs's sanitizer picked this up with no further change.

`rethrow` is a **statement only**. There is no rethrow-expression: it never
produces a value, and C# likewise has no `throw;` in expression position.

### Semantics

`rethrow` re-raises the exception currently being handled by the **lexically
innermost enclosing `catch` clause**, emitting `ILOpCode.Rethrow`.

- A nested `try` **block** inside a catch handler introduces no new handler, so
  a `rethrow` in it still refers to the enclosing catch's exception.
- A nested `catch` **handler** does, so a `rethrow` inside it re-raises the
  inner exception. Both rules match the CLR and C#, and are pinned by executing
  tests.

### Legality and diagnostics

Two new errors (mirroring C#'s CS0156 and CS0724):

| ID | Condition |
| --- | --- |
| **GS0570** | No enclosing `catch` handler — including inside a lambda or local function declared in one. |
| **GS0571** | A `finally` clause nested between the `rethrow` and the enclosing `catch`. |

The lambda case is not pedantry: a lambda body is emitted as its **own
method**, so a `rethrow` there would emit `ILOpCode.Rethrow` outside any
handler — unverifiable IL. The binder hides the enclosing handler-region stack
while binding a nested function body (`StatementBinder.OutsideExceptionHandlers`,
applied to both the block-body and the arrow/block-expression lambda paths), so
those bodies report GS0570 instead.

A bare `finally` with no enclosing catch anywhere reports the plainer GS0570 —
there is no exception being handled at all, so GS0571's wording would be false.

### Async interaction

`AsyncExceptionHandlerRewriter` lifts a catch handler containing an `await`
**out of** the CLR protected region (the CLR forbids suspension inside a
handler). An `ILOpCode.Rethrow` in such a body would no longer be inside a
handler. The rewriter therefore converts a lifted handler's own `rethrow`
statements into `ExceptionDispatchInfo.Capture(e).Throw()` — the same stand-in
it already uses for the pending-exception path (issue #418), which also
preserves the original throw site. Rethrows inside a *nested* catch that stays
in place keep their real `rethrow`: the converter does not descend into nested
catch bodies.

## Alternatives rejected

- **Bare `throw`** — ambiguous in this grammar (above).
- **A contextual keyword** (`rethrow` recognised only at statement start) —
  avoids reserving the word, but makes `rethrow` mean different things
  depending on whether a local of that name is in scope, which is precisely the
  kind of silent-meaning-change this ADR removes. ADR-0170's `$rethrow` escape
  makes the hard-keyword cost small.
- **A library helper** (`ExceptionDispatchInfo.Capture(e).Throw()` written by
  hand) — already possible today, but verbose, allocating, and invisible to any
  future analyzer; it also does not give cs2gs a clause-for-clause target.

## Follow-ups (out of scope here)

The remaining suggestions in #3897 are deliberately **not** in this ADR:

- multiple `catch` clauses per `try` with `when` filters (the root fix for
  family 1, retiring `__caught` outright and fixing 1a duplication and 1c
  filter timing),
- variable-less `catch` (family 1d),
- an `async void`-shaped lowering in gsc (family 2),
- a typed range clause for `foreach` over non-generic `IEnumerable`
  (family 3).
