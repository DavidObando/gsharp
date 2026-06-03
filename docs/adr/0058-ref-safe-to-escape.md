# ADR-0058: Ref-safe-to-escape analysis — `scoped`, `[UnscopedRef]`, and ByRef escape rules

- **Status**: Accepted
- **Date**: 2026-06-03
- **Phase**: Phase 8 — ref-safety follow-up (issue #376)
- **Related**: #367 / #371 / #373 (GS0219, user `ref struct`), #376 (tracking issue), ADR-0039 (by-ref pointers `&`/`*`, `ByRefTypeSymbol`), ADR-0056 (Span consumption v1)

## Context

ADR-0039 (by-ref pointers) deferred the full two-level escape-analysis model from C# 11 (`ref-safe-to-escape` / `safe-to-escape`, `scoped`, `[UnscopedRef]`) to a follow-up, adopting a simpler V1 rule: *by-ref values cannot escape their declaring scope*. ADR-0039 §4 specified three concrete restrictions:

1. A `ByRefTypeSymbol` (`*T`) local cannot be captured by a lambda.
2. A function cannot return a `ByRefTypeSymbol` value.
3. A field of a class or struct cannot have `ByRefTypeSymbol` type.

These restrictions (diagnostics GS9004 / GS9006) were defined in `DiagnosticBag` but never wired up in the binder. Issue #376 tracks completing this work and adding the richer ref-safety model.

## Decision

Implement the two-tier ref-safety model in a single phase, combining the missing ADR-0039 checks with the `scoped` modifier and `[UnscopedRef]` attribute.

### 1. Terminology

| Term | Meaning |
|---|---|
| `safe-to-escape` (STE) | The outermost scope from which a *value* of a by-ref-like (`ref struct`) type may be legally observed. |
| `ref-safe-to-escape` (RSTE) | The outermost scope from which a managed *reference* (`*T` / `ByRefTypeSymbol`) may be legally observed. |
| **Caller scope** | The return position — the value/reference can safely leave the current function. |
| **Function-local scope** | The current function body — the value/reference must not be returned or stored in a field. |

### 2. ByRef (`*T`) lifetime rules — implement ADR-0039 §4 (GS9004 / GS9006)

The conservative V1 rules remain: **all** managed-reference values have function-local RSTE. Concretely:

- **GS9004 – cannot return**: A function may not return an expression whose type is `ByRefTypeSymbol`. The callee's stack frame (containing the pointed-to variable) is invalid after the function returns.
- **GS9004 – cannot capture**: A lambda/closure may not close over a local variable of `ByRefTypeSymbol` type. The enclosing scope might outlive the managed pointer's referent.
- **GS9004 – cannot hoist**: A local variable of `ByRefTypeSymbol` type may not be declared inside an `async` function or an iterator (the state-machine field would extend the managed reference's lifetime across suspension).
- **GS9006 – cannot be a field**: A struct or class field may not have `ByRefTypeSymbol` type; CLR metadata encodes `ELEMENT_TYPE_BYREF` only in parameter and local-variable signatures, not in field signatures.

By-ref *parameters* received from callers are legitimate; the rules above apply to values produced *inside* the current function.

### 3. `scoped` modifier

The `scoped` contextual keyword may be placed immediately before a parameter identifier (or before a local variable declaration identifier) to restrict the STE / RSTE of that binding to function-local scope. It is matched by identifier text, consistent with how `ref`, `data`, `inline`, and `record` are contextual in G#.

**Syntax:**
```gsharp
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length  // s itself cannot be returned; s.Length (int32) can
}
```

**Binder semantics:**

- `ParameterSyntax.IsScoped` is true when the `scoped` modifier token is present.
- `ParameterSymbol.IsScoped` mirrors the syntax flag.
- When a function's return type is a by-ref-like type, the binder validates that the returned expression does not directly reference a `scoped` parameter.
- In G# V1 this is a direct-reference check: `return scopedParam` is rejected; a value derived from a `scoped` parameter through indexing or property access is not tracked (full data-flow STE analysis is deferred).

**Local `scoped`:**

The `scoped` modifier on a local variable declaration is parsed but has no additional binder enforcement in V1 beyond its role as documentation intent. Full local-STE propagation is deferred.

### 4. `[UnscopedRef]` attribute

`System.Diagnostics.CodeAnalysis.UnscopedRefAttribute` applied to a `ref struct` instance method relaxes the default assumption that `this` has function-local RSTE, allowing the method to return `this` by reference. In G# V1:

- The attribute is recognized and its presence is documented.
- No binder enforcement is added yet; the attribute is treated as informational metadata. Full RSTE analysis for struct members' implicit `this` parameter is deferred.

### 5. Diagnostic summary

| ID | Trigger |
|---|---|
| GS9004 | Returning a `*T` value; capturing a `*T` local in a closure; declaring a `*T` local in an `async` function or iterator. |
| GS9006 | Declaring a struct or class field with `*T` type. |
| GS0219 (extension) | Returning a `ref struct` value that directly references a `scoped` parameter. |

### 6. STE / RSTE deferred to a follow-up

Full data-flow tracking of `safe-to-escape` and `ref-safe-to-escape` scopes (covering initializer-derived lifetimes, constructor expressions, struct member access, nested field reads) and full `[UnscopedRef]` enforcement remain deferred. The `scoped` modifier and `[UnscopedRef]` attribute are surfaced now so user code can use the syntax; the binder enforces only the direct-parameter-return case.

## Consequences

**New capabilities:**
- User code can annotate parameters with `scoped` to document and enforce that a ref struct parameter will not escape.
- Managed-pointer (`*T`) escape scenarios that previously compiled silently now produce clear diagnostics.
- The `[UnscopedRef]` attribute can be applied to struct methods; it round-trips to metadata.

**Breaking changes:**
- Any code that returned a `*T` (ByRefTypeSymbol) value, captured one in a closure, or declared a `*T` field now fails with GS9004 / GS9006. Such code was memory-unsafe and was never supported; the diagnostics surface an existing correctness gap.
- Returning a `scoped` ref struct parameter now fails with GS0219. This is a new restriction; previously the binder accepted such returns without checking.

**Existing test impact:**
- No existing tests exercise ByRef return, ByRef closure capture, or ByRef fields (the diagnostics were unreachable). All 2 000+ existing tests continue to pass.

## Follow-ups

- Full data-flow STE propagation through initializers, constructors, and member access.
- Full RSTE for `ref` returns and `[UnscopedRef]` enforcement.
- `scoped ref` compound modifier (currently only `scoped` on value parameters is checked; `scoped` on a `*T` parameter restricts RSTE in the full model).
- `scoped` on local variable declarations (enforcement).
