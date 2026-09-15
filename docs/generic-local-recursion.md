# Generic local recursion regions (#4219, first milestone)

Consecutive `let Name[T, ...] = func (...) ... { ... }` declarations form a
generic declaration region. Signatures (including constraints, parameter
modifiers/defaults and declared return types) bind before any member body.
Each body uses its own type parameters and the same registered function
symbols. Comments and whitespace do not interrupt a region.

```gsharp
let first[T] = func(value T, depth int32) T {
    if depth == 0 { return value }
    return second(value, depth - 1)
}
let second[U] = func(value U, depth int32) U {
    return first[U](value, depth)
}
Console.WriteLine(first(42, 3))
```

## Visibility and compatibility

- A region starts at its first declaration and ends at the next other
  statement or source-file boundary. Calls in member bodies, their nested
  bodies, and subsequent statements can see every member.
- Statements before the region cannot see its new names. They still resolve
  existing outer names normally; a missing function remains GS0130.
- This does **not** hoist ordinary `let`/`var` variables or delegate cells.
  Ordinary forward-referencing function literals still fail; mutable
  self-recursion still observes rebinding.
- Existing function overload lookup remains unchanged: outer overloads
  participate, distinct signatures are allowed, and identical applicable
  outer/inner signatures remain ambiguous (GS0266), not implicitly shadowed.
  Same-scope duplicate signatures and function/variable name collisions are
  GS0102. Regions in nested blocks use those blocks' lexical scopes; a region
  itself does not introduce another scope.
- Direct calls use generic methods and MethodSpec instantiations, not
  unbound-generic delegates. Non-generic class/struct/interface lexical hosts retain
  private/protected accessibility via nested static method hosts; no host
  object is allocated by these calls.

## Deliberate boundaries

Members must remain non-capturing (GS0463) and use only their own type
parameters (GS0468 for enclosing-parameter references). Capturing and mixed
generic/delegate recursion groups are not enabled. Enclosing generic
environment reification belongs to #4223/#4221. Existing validation,
async/iterator restrictions and definite-return diagnostics still apply.
Generic by-ref type inference is unchanged: the qualified `in`/`out`/variadic
regressions supply explicit type arguments when the type parameter occurs only
behind a by-reference parameter. This milestone does not claim broader
generic-call inference parity.

An owner-independent helper in a generic class can still use only its own type
parameters, including public accesses through a closed construction. Accesses
that implicitly require enclosing generic slots are rejected with GS0468.
The ordinary accessibility checker evaluates unsupported direct helpers in
their emitted program-host domain, so private/protected member references
(including constructors and function pointers) receive the existing access
diagnostics. Late-resolved method groups and nested literals needing an
unsupported generic lexical host receive GS0586 instead of producing
inaccessible or malformed IL. Non-generic interface owners use the same nested
static hosts as non-generic classes/structs, preserving private access and
interface-accessor compatibility. Non-generic nested
classes within generic enclosing types do not bypass these enclosing-generic-
context restrictions.

Ref-returning literals are **not** enabled by this milestone. Their syntax,
callable/delegate identity, metadata, conversions, invocation, alias-preserving
consumption, lifetime/escape checks and tooling form a separate end-to-end
workstream, coordinated with #4224. Readonly refs remain distinct (#4220).
This is not full C# local-function or ref-return parity.

## Translation and qualification

cs2gs recursion and hoisting graphs compare original declaration symbols,
while actual calls retain constructed type arguments. An excluded member
(generic, ref-returning, variadic or ref/out/in) keeps its entire cycle off
the nullable-function-local scheme, including cycles with an otherwise
eligible subcycle. Existing synthetic lift fallbacks remain in place.
No lift-counter baseline or unrelated default-parameter lift policy changes.

Regression coverage includes two/three-member emitted cycles, explicit and
inferred type arguments, changed instantiations, constraints, lexical
boundaries, nested regions, signature modifiers/defaults, existing safety
diagnostics, editor navigation/signature help, formatter round trips and
emitted submissions. `samples/GenericLocalRecursion.gs` participates in real
compiler execution and the existing IL verification conformance gate.
