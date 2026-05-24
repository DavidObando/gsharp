# ADR-0038: Type-argument inference for imported open generic methods

- **Status**: Accepted
- **Date**: 2026 (this PR)
- **Phase**: Stream F follow-up — closes the generic-method follow-up tracked in ADR-0034 and ADR-0037
- **Related**: ADR-0034 (imported CLR interop — shared `OverloadResolution`), ADR-0037 (numeric tie-breaking)

## Context

ADR-0034 introduced the shared `OverloadResolution.Resolve` covering CLR constructors, imported static and instance method calls, operators, and conversions. Generic CLR methods were partially supported: a call only bound when the user wrote explicit type arguments (`Enumerable.Repeat[int](7, 3)`). Calling the same method with inferable arguments (`Enumerable.Repeat(7, 3)`) diagnosed "unable to find function" because the resolver matched candidates by their open parameter types (`TResult`, `int`) and rejected anything that involved a generic parameter.

The numeric-ranking ADR (0037) and the original CLR-interop ADR both explicitly tracked "generic-method overload resolution for imported open-generic methods … still requires explicit type arguments" as a follow-up. This ADR closes that.

A second, latent emit bug was uncovered while writing the round-trip test: `BoundImportedCallExpression` and `BoundImportedInstanceCallExpression` used `GetMethodReference` directly, which produces a plain `MemberRef` to the open method definition. Constructed generic methods (whether produced from inference or from explicit type arguments) need a `MethodSpecification` per ECMA-335 II.23.2.15 to encode the type-argument vector. The `GetMethodEntityHandle` wrapper that does this already existed but was only used by a couple of newer call sites.

## Decision

Add **first-phase input-type inference** to the resolver, in line with the C# §7.5.2 input-type subset, and route the resulting closed `MethodInfo` through the existing applicability + ranking pass. Switch the imported-call emit sites to `GetMethodEntityHandle` so the produced PE always uses a `MethodSpec` when the called method is a constructed generic.

### Inference algorithm

For each candidate that is a `MethodInfo` with `IsGenericMethodDefinition`:

1. Walk the (parameter type, argument CLR type) pairs and collect bounds on each method type parameter.
2. Unification handles:
   - **Bare generic parameters** (`T`) — record the argument type; on a later visit, keep the more general type if one is assignable from the other; conflict otherwise.
   - **Arrays** (`T[]`) — unwrap the array and recurse on the element.
   - **ByRef** (`out T` / `ref T`) — peel the byref and recurse.
   - **Constructed generic types** (`IEnumerable<T>`, `Dictionary<TKey, TValue>`) — walk the base-class chain and interface table of the argument type looking for a closed instantiation of the same open definition, then recurse pairwise on the type arguments.
3. If every method type parameter received a bound, call `mi.MakeGenericMethod(typeArgs)` inside a `try/catch (ArgumentException)` to catch constraint violations (`where T : struct`, `where T : new()`, interface constraints).
4. The resulting closed `MethodInfo` is fed back to the existing applicability + better-function-member pass exactly as a normally-resolved candidate would be — including numeric tie-breaking (ADR-0037), so an inferred `T = int` competes correctly against widening candidates.

Bounds are keyed by `Type.Name` (e.g. `"T"`, `"TResult"`). Within a single method's generic parameter table this is unambiguous because `GetGenericArguments()` and the parameter-type walk reference the same `Type` objects.

### Emit fix

`EmitExpression` for `BoundImportedCallExpression` and `BoundImportedInstanceCallExpression` now calls `GetMethodEntityHandle`, which inspects `IsGenericMethod && !IsGenericMethodDefinition` and wraps the open `MemberRef` in a `MethodSpecification` whose signature carries the constructed type arguments. No evaluator change was needed — `MethodInfo.Invoke` already accepts a closed generic method built by `MakeGenericMethod`.

## Consequences

- `Enumerable.Repeat(7, 3)`, `Enumerable.Empty<T>()` called with a context that pins `T`, `Enumerable.Range(...)` chained with inferable continuations, `List<T>.Add(item)` on `List<int>` (already worked; receiver pins T), `Dictionary<TK,TV>.TryGetValue(key, out value)` (receiver pins both), and similar idioms now bind without explicit type arguments.
- The emitter change also fixes a latent bug: code that previously bound through the explicit-type-argument path was emitting an open-method call without a `MethodSpec`, which produced PEs that ran in the interpreter but failed at JIT with `InvalidProgramException`. Any such code now runs end-to-end.
- The applicability + better-function-member rules apply post-inference, so an inferred candidate can still lose to a non-generic overload that fits more tightly. Ambiguity diagnostics remain hard errors.

## Alternatives considered

- **Second-phase output-type inference** (using the return-type context — `let xs IEnumerable[int] = Enumerable.Empty()`). Deferred. It requires plumbing target-type context into the resolver and reasoning about delegate-return inference, which the binder does not currently support.
- **Lambda / delegate output-type inference** (the heart of LINQ — `xs.Select(x => x + 1)` infers `R` from the lambda body). Deferred. It requires deferring the lambda's parameter typing until inference picks the input types and then re-binding — a much larger restructure of the lambda binder.
- **Variance and `dynamic` rules.** Out of scope; GSharp has no `dynamic` and our reference-conversion classifier does not yet model variance for delegates / `IEnumerable<out T>`.
- **Fixing-with-multiple-bounds (the full §7.5.2.11 algorithm).** Replaced with a pragmatic "keep the more general of the two on conflict, hard-fail when neither is assignable from the other". This handles the common-base-class case and matches C# behaviour for the inference shapes GSharp can currently express.

## Follow-ups

- Second-phase return-type-context inference.
- Lambda / delegate output-type inference (would unlock natural LINQ chains).
- Variance-aware reference conversion classification.
- C# §7.5.3.5 expression-aware numeric ranking (literal `int` → `byte` / `short` preference).
