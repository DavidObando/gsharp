# ADR-0108: Delegate return-type covariance and lambda target-typing on CLR method calls

- **Status**: Accepted
- **Date**: 2026-06-20
- **Phase**: Phase 5 — generics & dogfooded core
- **Closes**: Issue #908 (arrow lambda with covariant body type rejected on CLR method calls)
- **Related**: ADR-0105/0106 (incremental binding); the lambda/delegate
  target-typing work in #889 (arrow lambdas as `System.Action`/void
  delegates), #891 (lambdas as named/extension-method arguments), #893
  (func-literal trailing-return IL)

## Context

When a G# value is passed where a delegate type (`Func<...>` / `Action<...>`)
is expected, the supplied function literal must be convertible to that
delegate. Two compounding gaps made an otherwise-valid call fail:

1. **No delegate return-type covariance.** Overload resolution required a
   lambda's inferred function type to match the delegate parameter
   essentially exactly. A function returning a *derived/implementing*
   type was rejected where one returning the *base/interface* was wanted,
   even though the conversion is reference-preserving and sound. So even
   the explicit literal

   ```gs
   RootCommandFactory.Create(func() NullLoggerFactory { return NullLoggerFactory.Instance })
   ```

   failed with `GS0159` against a `Func<ILoggerFactory>` parameter,
   despite `NullLoggerFactory : ILoggerFactory`.

2. **CLR method calls did not target-type lambda arguments.** Delegate
   target-typing of a lambda argument (binding the lambda against the
   parameter's delegate type so its return type is *pinned* rather than
   inferred from the body) was wired only into the constructor call path.
   Plain CLR static/instance method calls bound the arrow lambda with its
   natural, body-derived return type before resolution, so

   ```gs
   RootCommandFactory.Create(() -> NullLoggerFactory.Instance)
   ```

   inferred `() -> NullLoggerFactory` and never matched
   `Func<ILoggerFactory>`.

The combination meant the arrow form never bound on CLR calls, and the
explicit form only worked when the return type was spelled as the exact
interface. C# accepts both: delegate creation allows reference covariance
on the return type, and lambdas are target-typed from the parameter.

## Decision

Both gaps are closed, matching C#/CLR delegate semantics (reference
conversions only).

1. **Delegate return-type covariance in conversion classification.** A new
   `ImplicitConversionKind.DelegateReturnCovariance` is recognised when
   classifying a function-typed value against a delegate parameter whose
   parameter lists match and whose return type is a base class or
   implemented interface of the source's return type (a
   reference-preserving upcast). It is ranked *worst* among implicit
   conversions so an exact return-type match always wins betterness.
   Delegate signatures are read cross-context-safely — via the delegate's
   `Invoke` method and, as a fallback, the closed `Func`/`Action` generic
   arguments — so the classification works even when the delegate type
   originates from a different `MetadataLoadContext`. Only class→base and
   class→interface reference upcasts are accepted; **no** value-type,
   boxing, or other variant conversions are permitted. The explicit
   func-literal form then flows through the existing erased-adapter path
   that converts the produced return value, yielding valid IL for the
   constructed delegate.

2. **Lambda target-typing on CLR static and instance method calls.** The
   accessor-call binding path now collects candidate delegate parameter
   lists from the applicable static, instance, and extension method
   candidates and target-types arrow-lambda arguments against them (the
   same `BindCallArgumentWithDelegateTargetTyping` mechanism previously
   limited to constructors). The arrow lambda's return type is pinned from
   the parameter's delegate return type rather than inferred from the body
   expression, so `() -> TDerived()` binds directly against `() -> TBase`.

### Incidental cross-context correctness fixes

Reproducing #908 surfaced two latent `MetadataLoadContext` (MLC) bugs that
this change also fixes, because the covariance check exercises cross-MLC
type relationships:

- `ClrTypeUtilities.IsAssignableByName` no longer trusts a spurious
  cross-MLC `Type.IsAssignableFrom == false`; it falls through to the
  by-name base/interface walk so genuinely-assignable types across MLCs
  are recognised.
- The `FunctionTypeSymbol` cache is cleared on `ReferenceResolver.Dispose`,
  preventing disposed-MLC types from resurfacing in a later compilation
  (which previously raised `ObjectDisposedException`).

## Consequences

### Positive

- Both `() -> derivedValue` and `func() Derived { return derivedValue }`
  bind against a `Func<Base>` parameter on CLR **static** and **instance**
  methods, with valid, ilverify-clean IL that executes correctly at
  runtime.
- G# delegate conversions now align with C#/CLR reference covariance, so
  C# reference samples that rely on it port verbatim.
- The two MLC fixes harden cross-assembly binding generally, beyond this
  feature.

### Negative / trade-offs

- `DelegateReturnCovariance` adds a special-case ranked conversion. It is
  deliberately ranked last so it can never shadow an exact match, but it
  is one more entry a maintainer must keep in mind when reasoning about
  overload betterness.
- Candidate delegate-parameter collection on accessor calls does a little
  extra work to pre-resolve target types before binding lambda arguments;
  the cost is bounded by the candidate set and only paid when a lambda
  argument is present.

### Out of scope

- Delegate **parameter-type** contravariance (a lambda accepting a base
  parameter where a derived is expected) is not addressed here; only
  return-type covariance. A follow-up ADR can extend the classifier if
  demand surfaces.
- Generic variance on user-defined delegate types beyond the BCL
  `Func`/`Action` family is unchanged.

## Test coverage

- `test/Compiler.Tests/Emit/Issue908DelegateReturnCovarianceEmitTests.cs`
  — arrow lambda and explicit-derived-return func literal, each passed to
  a CLR static method and a CLR instance method expecting `Func<TBase>`
  with a `TDerived` body (e.g. `Func<Stream>` satisfied by `MemoryStream`).
  Each compiled assembly is run through ilverify and executed; the runtime
  output is asserted.

## Alternatives considered

- **Require an explicit `as` cast on the body** (`() -> derived as Base`).
  Rejected: it is the existing workaround, is noisy, and diverges from C#.
- **Only fix target-typing (gap 2) and rely on exact match.** Rejected: it
  would leave the explicit `func() Derived { ... }` form broken and would
  not handle cases where the body's natural type is more derived than the
  delegate return type.
- **A general variant-conversion table.** Rejected as over-broad for this
  issue and a risk to soundness; the change is scoped to reference-
  preserving delegate return covariance.

## References

- C# spec, *Delegate compatibility* and *Method group / anonymous-function
  conversions* (reference covariance on delegate return types).
- ECMA-335 — delegate `Invoke` signature and reference-conversion rules.
- Issue #908 — original report, repro, and root-cause analysis.
