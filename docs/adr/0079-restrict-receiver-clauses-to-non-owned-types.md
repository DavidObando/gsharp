# ADR-0079: Restrict receiver-clause methods to non-owned types (warning)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Phase 6 (cleanup)
- **Related**: ADR-0019 (extension function declaration syntax), ADR-0024
  (methods-vs-extensions canonical style), ADR-0035 (user operator
  overloads), ADR-0078 (Kotlin/Swift-style type-declaration grammar).
  Parent issue #706, implementing issue #719.

## Context

ADR-0024 pinned a single syntactic shape for both extension functions and
same-package methods with receivers:

```gsharp
func (p Point) Distance() int32 { ... }
```

The binder decides which it is by looking at the receiver type's declaring
package:

- if the receiver type is declared in the same package as the function, the
  declaration binds onto the receiver's `StructSymbol.Methods` and is an
  instance method;
- otherwise it is an extension function.

Same-package methods with receivers consequently have **two valid
spellings**: the in-body form (`class C { func Distance() int32 { ... } }`)
and the receiver-clause form (`func (c C) Distance() int32 { ... }`). Both
shapes produce the same symbol, dispatch identically, and participate in
the same interface conformance and overload-resolution paths. Tooling
nonetheless needs a single canonical declaration site to drive go-to-
definition, hover, refactorings, and conformance reports — and humans
reading the source need a single mental model.

After ADR-0078 normalised the type-declaration head to Kotlin/Swift style,
the in-body form is the obvious canonical site. The receiver-clause form
remains essential for extension functions on types that the package does
not own (BCL primitives, imported CLR types, types declared by referenced
packages).

## Definition: owned type

A type is **owned** by a package if it is *declared in the same
compilation* as the receiver-clause function under consideration. Concretely:

- The receiver type resolves to a `StructSymbol` whose `PackageName` equals
  the current `PackageSymbol.Name`. (The binder already computes this
  predicate to route the declaration to the instance-method path.)
- Types imported from a referenced assembly (CLR primitives, BCL types,
  third-party libraries, other GSharp packages) are **not owned**.

Aliases (`type Count = int32`), interfaces, and other non-aggregate
receivers are out of scope for this ADR — they are already rejected with
`GS0224` (`ReportMethodReceiverMustBeStructOrClass`).

## Decision

Emit a **warning** (severity `Warning`, soft diagnostic — code `GS0314`)
whenever a receiver-clause function targets an owned struct or class.
The warning suggests moving the declaration into the type body. The
declaration continues to bind exactly as it does today: same symbol,
same emit, same dispatch.

The diagnostic text is:

> Receiver-clause methods are reserved for types this package does not
> own; declare `'<MethodName>'` as a member of `'<TypeName>'` instead
> (ADR-0079).

The diagnostic fires **once per declaration**, at the location of the
receiver type clause — not per call site. Cross-package, primitive, and
CLR receivers continue to bind as extension functions and are not warned.

### Exemption: operators

ADR-0035 requires receiver-clause syntax for `operator` declarations
(`func (a Vector2) operator +(b Vector2) Vector2 { ... }`). There is no
in-body operator form today, so `GS0314` does not fire on operators. The
parser synthesises `op_*`-prefixed identifiers for operator declarations,
so the binder skips the warning when the function name starts with `op_`.
Removing the operator exemption requires a separate ADR introducing an
in-body operator form.

## Severity and grace period

`GS0314` is a **warning** rather than an error to provide a one-release
grace period for existing GSharp code. Migration is mechanical for
classes (cut the receiver clause, paste the function head into the
class body), so no semantics change for consumers. The warning can be
suppressed per file via `<NoWarn>GS0314</NoWarn>` in a `.gsproj` or
`/nowarn:GS0314` on the command line; it can be promoted to an error
via `<WarningsAsErrors>` / `/warnaserror+:GS0314` for projects that
want to enforce the policy locally today.

Note that `struct`, `data struct`, and `inline struct` bodies currently
accept only field declarations (the parser rejects in-body methods on
value types — see ADR-0017 / the §3.B.3 binder). For owned structs the
warning therefore flags the receiver-clause form as deprecated even
though there is no in-body alternative today; users can either suppress
`GS0314` per-declaration / per-project, or migrate the data carrier
from `struct` to `class`. Extending in-body methods to structs is a
separate future ADR.

Escalation to error (and removal of the receiver-clause method form for
owned types entirely) is **out of scope** for this ADR and is a separate
future ADR / issue.

## Consequences

Positive:

- One canonical declaration site for owned-type instance methods. Hover,
  go-to-definition, and refactorings have a single answer.
- The receiver-clause form keeps a single, sharply-defined meaning:
  "function attached to a type my package does not own".
- Migration is purely a relocation; symbol identity, accessibility, and
  call-site behaviour are preserved.

Negative:

- Existing same-package receiver-clause methods emit a warning until they
  are migrated. The Oats sweep migrates the in-tree samples and tests in
  the same PR that lands this ADR.
- Two declaration shapes co-exist during the grace period.

Neutral:

- Operators remain on the receiver-clause form per ADR-0035.
- ADR-0024's binding rule (receiver-type ownership decides
  method-vs-extension) is preserved verbatim; this ADR only adds a
  diagnostic on top of it.

## Open follow-ups

- A future ADR/issue may escalate `GS0314` to an error, at which point
  the receiver-clause method path for owned types can be removed.
- An in-body operator form would let the operator exemption above be
  retired; deferred.
