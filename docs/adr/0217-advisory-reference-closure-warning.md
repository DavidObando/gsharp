# ADR-0217: Advisory reference-closure warning under global promotion

- **Status**: Accepted
- **Date**: 2026-10-28
- **Phase**: Compiler diagnostic policy
- **Related**: [#5493](https://github.com/DavidObando/gsharp/issues/5493), maintainer comment 6476262235

## Context

The compiler reports `GS9100` when imported metadata has unavailable assembly dependencies.
It skips the affected members and continues binding the program.
An unused imported signature does not establish that the program needs its dependency.

Global warning promotion stopped compilation before binding could establish this distinction.
The maintainer directed that `GS9100` is advisory and must not break ordinary builds.

## Decision

Global `/warnaserror` and `/warnaserror+` leave `GS9100` as a warning.
This exception belongs in the shared driver diagnostic policy, not individual applications or SDK reference selection.
Other warnings retain global promotion.

Explicit `/warnaserror:GS9100`, `/warnaserror+:GS9100`, and `/gsdiag:GS9100=error` still reject an incomplete reference closure.
Suppression and explicit demotion retain their existing precedence.
The SDK continues forwarding these options without adding suppression.

Unavailable types and members still produce their ordinary binding errors when used.
The compiler must not substitute guessed assemblies or emit a program after an error.

## Consequences

Ordinary warnings-as-errors builds can compile programs that do not use unavailable metadata surfaces.
Users can still enforce complete reference closure explicitly.
SDK incremental-reference tests must select `GS9100` explicitly when closure rejection is their witness.
Reference ordering, dependency membership invalidation, and emitted-code semantics do not change.

## Alternatives considered

- Suppress `GS9100` in each migrated application: rejected because the diagnostic remains useful.
- Inject packages absent from the restore graph: rejected because it changes dependency provenance.
- Exempt every warning from global promotion: rejected because real diagnostics must retain their policy.
