# ADR-0034: Imported CLR interop — static members, writes, operators, conversions, overload resolution

- **Status**: Accepted
- **Date**: 2026 (this PR)
- **Phase**: Phase 7 follow-up to Phase 4 (constructable imported types) and Phase 6 (operators)
- **Related**: ADR-0026 (operator-by-name deferral — still applies to *declaring* operators on user types); ADR-0029 (data struct synthesized `==` / `!=`); execution plan §4 (imported types) and §6.5 (operators).

## Context

After Phase 4, GSharp could construct imported CLR types (`StringBuilder(16)`, `List[int]()`), call public instance and static methods, and read public instance properties / fields via `BoundClrPropertyAccessExpression`. Several gaps remained:

1. `ImportedClassSymbol.TryLookupMember` threw `NotImplementedException`, so `Int32.MaxValue`, `Math.PI`, `Console.Out`, etc. all diagnosed as missing.
2. There was no write path for instance properties / fields on imported types (`sb.Capacity = 32`).
3. There was no write path for static members (`Console.ForegroundColor = …`).
4. Constructor and method overload resolution was first-applicable-match by assignability: boxing, numeric widening, reference upcasts, and user-defined implicits did not participate in tie-breaking.
5. Operators against imported CLR types (`+` on `TimeSpan`, `==` on `Guid`, `<` on `DateTime`) all diagnosed — `op_*` static methods were never consulted.
6. `BindConversion` did not consult `op_Implicit` / `op_Explicit`, so cross-type assignments (`DateTimeOffset = DateTime`, `BigInteger = int`) all diagnosed too.

The execution plan and ADR-0026 separate two concerns: (a) *consuming* CLR operator and conversion semantics from GSharp source, and (b) *declaring* operators on GSharp-defined types. This ADR covers (a). (b) remains deferred under ADR-0026.

## Decision

Ship a single coordinated change covering five concerns, in this order, in one PR:

1. **Shared overload resolution.** A pure `OverloadResolution.TryResolve(IReadOnlyList<MethodBase>, argTypes)` function. Argument-to-parameter conversions are classified into a small enum (`Identity`, `NumericWidening`, `ReferenceUpcast`, `NullableWrap`, `BoxingToObject`, `UserDefinedImplicit`, `None`) and ranked by C# §7.5.3.2 "better function member" with ambiguity reported as a binder diagnostic. The same resolver is consumed by:
    - constructor calls on imported types (`Binder.TryBindClrConstructorCall`),
    - static and instance method calls on imported types (`ImportedClassSymbol.TryLookupFunction`, `Binder.BindAccessorCall`),
    - operator resolution (item 4 below),
    - conversion classification (item 5 below) via a `UserDefinedImplicitConversionLookup` hook.
2. **Static + instance member parity.** `TryLookupMember` returns the declared static `FieldInfo` / `PropertyInfo`; `const` (literal) fields are inlined at bind time as `BoundLiteralExpression`. The existing `BoundClrPropertyAccessExpression` is extended to accept a `null` receiver so both static and instance reads share the same shape — the emitter branches on `Receiver == null` to choose `ldsfld` / `call get_X` vs. `ldfld` / `callvirt get_X`. A new `BoundClrPropertyAssignmentExpression` carries writes and yields the assigned value (it re-reads the member after the store, mirroring `BoundClrIndexAssignment`).
3. **(Deferred) Event subscription via `+=` / `-=`.** Today `+=` desugars at parse time to `x = x op rhs` and only accepts a bare identifier LHS. Routing `obj.Click += handler` to `EventInfo.AddEventHandler` requires a `FieldAssignmentExpressionSyntax` that carries the operator token. Stream B′ — out of scope for this PR.
4. **Operators on imported CLR types.** `BoundBinaryOperator.Bind` and `BoundUnaryOperator.Bind` fall through to `ClrOperatorResolution.TryResolveBinary` / `TryResolveUnary` when no built-in match exists. Candidates are collected from each operand's CLR type (and its base chain), deduped by identity (`ClrTypeUtilities.AreSame`), and ranked by `OverloadResolution`. Resolution lowers to new nodes — `BoundClrBinaryOperatorExpression` / `BoundClrUnaryOperatorExpression` — both of which carry the resolved `MethodInfo`. Interpreter dispatches via `MethodInfo.Invoke(null, …)`. Emitter emits operands then `call` to the method reference. `==` / `!=` on reference-typed imports with no `op_Equality` continue to fall back to `object.Equals` (ADR-0029). `&&` / `||` against imported types stay deferred pending `op_True` / `op_False` lowering.
5. **User-defined / imported conversions.** A new `BoundClrConversionCallExpression` carries `(Source, MethodInfo, Type)`. `BindConversion` calls `ClrOperatorResolution.TryResolveConversion` when `Conversion.Classify` returns `!Exists` — searching `op_Implicit` on source then target, and `op_Explicit` on the same when `allowExplicit: true`. The same lookup is wired into `OverloadResolution.UserDefinedImplicitConversionLookup` so an `op_Implicit` participates in better-function-member tie-breaking. Interpreter: `MethodInfo.Invoke`. Emitter: emit source, then `call` to the conversion method.

GSharp-side `operator` keyword (declaring `operator +` on a user type) is **explicitly out of scope** for this PR. It is tracked separately — see ADR-0026 and the Stream-D follow-up note in `docs/coverage-matrix.md`.

## Consequences

- Programs that previously diagnosed "operator is not defined for types" against imported types now bind cleanly — `TimeSpan + TimeSpan`, `DateTime - TimeSpan`, `Guid == Guid`, `BigInteger * BigInteger`, etc. The interpreter and the emitter both honor the resolved `op_*` method.
- Static-member reads (`Int32.MaxValue`, `Math.PI`, `Console.Out`) and writes (`Console.ForegroundColor = …`) work on both backends.
- Instance-property writes on imported types (`sb.Capacity = 32`) work on both backends.
- Conversions like `var dto DateTimeOffset = dt` or `var b BigInteger = 42` succeed when an `op_Implicit` exists; explicit casts can additionally consume `op_Explicit`.
- A few programs that previously compiled under the first-match overload resolver may now report ambiguity. The test corpus was updated where the resolver intent is unambiguous (using constructors instead of `TimeSpan.FromSeconds(int)`, which has int→long and int→double both at NumericWidening). C#-style "more specific numeric target wins" is intentionally **not** implemented yet — callers must add an explicit cast or pick a typed overload.
- The CLR round-trip is preserved: emitted assemblies invoke `op_Addition` / `op_Implicit` etc. by the standard CLR name, so the result is consumable from any other CLR language.

## Alternatives considered

- **Per-operator built-in tables for popular BCL types.** Rejected — does not scale to NuGet types, and would duplicate the CLR's own `op_*` metadata.
- **Pattern-match the C# spec exactly for numeric overload ranking.** Partially rejected for this PR — the existing classifier covers the common cases; full §7.5.3.2 tie-breaking on numeric widening chains is a follow-up.
- **One ADR per stream (A–E).** Rejected as noise — the streams are mutually reinforcing (overload resolution underpins both operators and conversions), and the docs are simpler with a single combined ADR.

## Follow-ups

- Stream B′: event subscription via `+=` / `-=` (parser-side `FieldCompoundAssignmentExpressionSyntax`).
- Stream D: `operator` keyword on GSharp-defined types (supersedes ADR-0026). Requires lexer/parser surgery, symbol routing to CLR `op_*` names, emit as `static specialname`, and a dispatch table in the interpreter.
- Numeric tie-breaking: implement the full "better numeric target" rule (int → long preferred over int → double).
- Generic-method overload resolution: imported open-generic methods (`Enumerable.Select<T,R>`) still require explicit type arguments.
