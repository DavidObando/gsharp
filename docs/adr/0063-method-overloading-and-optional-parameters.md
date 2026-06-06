# ADR-0063: Method overloading and optional parameters

- **Status**: Proposed
- **Date**: 2026-06-06
- **Phase**: Phase 9 — language depth / call binding
- **Related**: ADR-0034 (imported CLR interop); ADR-0037 (numeric tie-breaking); ADR-0038 (generic method inference); ADR-0017 (method virtuality); ADR-0019 (extension functions); ADR-0024 (methods vs. extensions canonical style); ADR-0060 (`ref`/`out`/`in` parameters)

## Context

G# already consumes overloaded CLR APIs successfully. Imported methods and constructors flow through `OverloadResolution.Resolve(...)`, which already knows how to rank candidates, infer generic type arguments, respect named arguments, and permit omitted trailing optional parameters when the target member comes from CLR metadata. This means the *consumer-side* semantics for overloading and optional parameters mostly already exist.

What G# does not yet support cleanly is the *declaration-side* of the same model for user code.

Today, several core data structures treat a user-defined callable name as if it could map to only one symbol:

- `BoundScope.TryDeclareFunction` stores top-level functions by name, so a second `func Parse(...)` is diagnosed as a duplicate declaration.
- `StructSymbol.TryGetMethod(...)` and `InterfaceSymbol.TryGetMethod(...)` return a single `FunctionSymbol`, not an overload set.
- `BoundMethodGroupExpression` represents one method, not a same-name candidate group.
- `Binder.TryReorderUserCallArguments(...)` explicitly assumes every user-defined parameter must be supplied because user-defined callables have no default values.

This leaves G# in an awkward asymmetry relative to the CLR target it compiles to: imported .NET APIs can expose natural overload families such as `Console.WriteLine`, but G# packages cannot author the same shape themselves.

The missing feature is particularly visible now that G# already has named arguments, `ref`/`out`/`in` parameter distinctions, generic method inference, constructors, same-package receiver methods, extension functions, and CLR metadata/documentation-id generation. Any design for overloading and optional parameters therefore has to align with those existing implementation choices rather than pretending the language starts from a blank slate.

## Decision

G# adopts CLR-style method overloading and trailing optional parameters for user-defined callables.

The design has two linked parts:

1. **Overload sets**: multiple same-name callables may coexist in the same declaration space when their signatures differ.
2. **Optional parameters**: a callable parameter may declare a default value, permitting certain trailing arguments to be omitted at the call site.

The feature applies to user-defined top-level functions, in-body methods, same-package receiver methods, extension functions, constructors declared with `init(...)`, and interface methods. It does **not** apply in v1 to lambdas, property accessors, indexers, or delegate type declarations.

### 1. Signature identity

A callable's overload identity is:

- containing declaration space,
- member name,
- generic arity,
- callable parameter count,
- each callable parameter's type,
- each callable parameter's `ref`-kind (`value`, `ref`, `out`, `in`), and
- for methods, whether the callable is static/instance as already determined by its declaration form.

A callable's return type, parameter names, accessibility, and default values are **not** part of overload identity.

Consequences:

- Two declarations that differ only by return type remain illegal.
- Two declarations that differ only by parameter names remain illegal.
- Two declarations that differ only by default values remain illegal.
- Two declarations that differ by parameter `ref`-kind are distinct overloads, consistent with ADR-0060 and CLR signature identity.
- Documentation IDs remain parameter-list-based; optional defaults do not affect the DocID, but overloads become distinguishable because their parameter types/ref-kinds differ.

### 2. Surface syntax for optional parameters

A parameter may include a default-value clause after its type:

```gsharp
func Open(path string, mode FileMode = FileMode.Open, share FileShare = FileShare.Read) FileHandle { ... }
```

Grammar sketch:

```ebnf
parameter = identifier ellipsis? type_clause ('=' constant_expression)?
```

`=` is chosen because parameter declarations in G# already use the `name type` order, so the natural place for a default is after the type. This also avoids overloading the call-site `:` named-argument spelling with a declaration-side meaning.

### 3. Optional-parameter restrictions

In v1, an optional parameter must satisfy all of the following:

1. Its default value is a compile-time constant representable in CLR parameter metadata: numeric literal, `bool`, `char`, `string`, enum constant, or `nil` for a nullable/reference-compatible parameter.
2. It is not marked `ref`, `out`, or `in`.
3. It is not variadic (`...`).
4. It is not the receiver parameter of a receiver method or extension function.

Optional and required parameters may therefore be interleaved. A call is applicable if every required parameter receives an argument and every unsupplied parameter is optional.

These restrictions are deliberate. They preserve faithful CLR emission (`Optional`/`HasDefault` plus a Constant row) while keeping omitted-argument lowering purely compile-time. Non-constant defaults, defaults that reference earlier parameters, and `default(T)`-style generalized expressions are deferred.

### 4. Call-site semantics

Optional parameters are **call-site sugar**. When binding a call that omits optional arguments, the binder synthesizes explicit bound constant expressions for each unsupplied optional parameter slot, just as it already does for imported CLR optional parameters.

This means:

- The callee does not inspect “was an argument omitted?” at runtime.
- After argument-to-parameter mapping is established, omitted slots behave exactly as if the caller had written the default constant explicitly.
- Changing a default value is a source-compatible but binary-behavioral change in the same way it is in C#: already-compiled callers continue to pass the old substituted constant until recompiled.

### 5. Named arguments and omission rule

Named arguments continue to reorder into parameter order before final applicability checks.

In v1, any optional parameter may be omitted. Omission is therefore not restricted to a trailing suffix: after argument mapping, every unbound parameter position is filled from its declared default value, provided that parameter is optional.

Examples:

```gsharp
func Draw(width int32, height int32 = 0, color string = "black") { ... }

Draw(10)                         // ok: omits [height, color]
Draw(10, color: "red")          // ok: substitutes default for height
Draw(width: 10, height: 20)      // ok: omits [color]
Draw(width: 10, color: "red")   // ok: substitutes default for height
```

This intentionally goes beyond the current imported-member implementation strategy. The binder's user-defined call path — and ideally the shared overload-resolution machinery — should be generalized from prefix/suffix omission to true per-parameter argument mapping.

### 6. Overload resolution model

User-defined overloads reuse the existing CLR-oriented overload-resolution concepts rather than inventing a separate ranking system.

For a candidate set with the same name, the binder:

1. collects all same-name user-defined candidates in the applicable declaration space,
2. filters candidates by arity, generic arity, named-argument compatibility, `ref`-kind compatibility, and optional-parameter applicability,
3. performs generic inference where needed (reusing ADR-0038 behavior),
4. inserts required implicit conversions,
5. ranks the remaining candidates using the existing better-function-member rules, including ADR-0037 numeric tie-breaking, and
6. breaks remaining ties in favor of the candidate that expands the fewest optional parameters.

If no unique best candidate exists, the binder reports an ambiguity diagnostic.

This specifically means that a user-defined overload family and an imported CLR overload family behave the same way from the caller's point of view.

### 7. Member lookup precedence

This ADR does **not** change the existing precedence between real methods and extension functions.

For member-call syntax `x.Foo(...)`:

1. resolve against instance/static members on the receiver type (including inherited members and user-defined overload sets),
2. only if no viable member candidate exists, consider extension functions,
3. then continue with existing CLR/imported fallback behavior.

Extension functions therefore remain lower priority than real members, even if an extension overload would otherwise be applicable.

### 8. Overrides and interface implementation

Overloading does not change the override model from ADR-0017: an `override` still targets exactly one inherited base method, matched by same name and same signature.

For interface implementation and overrides:

- overload families may exist on the interface/base type,
- the implementing/overriding declaration must match exactly one inherited member by signature,
- default values are **not** part of the matching signature,
- an override or interface implementation may omit the default clause or repeat the inherited default, but it may not change the default value.

The binder normalizes defaults from the introducing declaration so the overload slot remains stable and metadata emitted for the implementation stays consistent with the visible contract.

### 9. Constructors

User-defined constructors declared with `init(...)` participate in overload sets and may declare trailing optional parameters under the same rules.

Example:

```gsharp
type FileStream class {
    init(path string)
    init(path string, mode FileMode = FileMode.Open)
}
```

Constructor overload resolution uses the same candidate-selection rules as ordinary calls.

### 10. CLR emission

For user-defined overloads, CLR emission mostly becomes *less* special: same-name methods with different signatures already map naturally to distinct MethodDef rows.

For optional parameters, the emitter stamps the chosen parameter rows with:

- `ParameterAttributes.Optional`,
- `ParameterAttributes.HasDefault`, and
- a Constant row carrying the encoded default value.

This gives C#, reflection, and any other CLR consumer the same omission behavior they already have for C#-authored optional parameters.

Because optional defaults are call-site-substituted in both G# and C#, cross-language behavior remains aligned:

- a G# caller of a G# method substitutes the constant during binding,
- a C# caller of the emitted method reads the constant from metadata and substitutes it during C# compilation,
- reflection sees the parameter as optional and exposes the default value.

Defaults outside the CLR Constant-table model are intentionally rejected in v1 so the metadata contract remains lossless and unsurprising.

### 11. Symbol-model changes

Implementing this ADR requires the user-defined callable lookup model to move from “name → single symbol” to “name → overload set”. Concretely:

- `BoundScope` function storage becomes name → immutable array/list of `FunctionSymbol`.
- `StructSymbol` / `InterfaceSymbol` same-name method lookup returns overload groups rather than a single `FunctionSymbol`.
- `BoundMethodGroupExpression` becomes an overload-set carrier so later binding can choose a best candidate.
- duplicate-declaration diagnostics compare full signature identity, not just the member name.
- interface-conformance and override validation search within a same-name overload family for an exact-signature match.

This is the minimum architectural change needed to make user-defined lookup structurally resemble the already-working CLR/imported path.

### 12. Diagnostics

This ADR requires three diagnostic classes:

1. **Duplicate overload signature**: same-name declaration already exists with the same signature (including `ref`-kinds, excluding defaults).
2. **Invalid optional parameter declaration**: non-trailing default, unsupported default-value expression, optional `ref`/`out`/`in`, or optional variadic parameter.
3. **Ambiguous overload resolution**: multiple candidates remain equally good after inference/conversion/optional-parameter ranking.

Existing diagnostics for duplicate simple names, bad named arguments, and failed conversion remain in place and should be reused where the condition has not changed.

## Examples

### User-defined overloads

```gsharp
func Parse(text string) int32 { ... }
func Parse(text string, style NumberStyle) int32 { ... }
func Parse(text ReadOnlySpan[char]) int32 { ... }
```

### `ref`-kind as part of signature

```gsharp
func Visit(value string)
func Visit(ref value StringBuilder)
```

These are distinct overloads because the callable parameter shapes differ.

### Optional parameters with overload families

```gsharp
func Connect(host string, port int32 = 5432)
func Connect(uri Uri)
```

`Connect("db")` picks the first overload and substitutes `5432`; `Connect(uri)` picks the second.

## Consequences

Positive:

- G# can author the same ergonomic API shapes it already consumes from the BCL and other CLR libraries.
- The proposal reuses existing implementation investments: named arguments, generic inference, numeric tie-breaking, optional imported-parameter lowering, and CLR metadata/documentation-id machinery.
- Same-name receiver methods, constructors, interface members, and top-level functions all converge on one call-binding story.

Negative:

- Binder and symbol-table internals become more complex because “lookup by name” is no longer enough for user-defined callables.
- Sparse optional-argument omission requires the call binder and overload-resolution pipeline to track argument-to-parameter mapping by slot, not just by a contiguous supplied prefix.
- Default values inherit the usual CLR caveat that changing a default does not retroactively affect already-compiled callers.

Neutral:

- Return-type-only overloading remains unsupported, matching CLR method identity and avoiding a whole class of contextual-typing ambiguities.
- Default values are part of the callable contract surface but not part of its overload signature.

## Alternatives considered

1. **Overloading without optional parameters.** Rejected because the binder/emitter work overlaps heavily, and G# already has imported optional-parameter behavior worth reusing.
2. **Optional parameters without overloading.** Rejected because it would preserve the asymmetry where user code can omit imported arguments but cannot model the usual overloaded-vs-defaulted API trade-off itself.
3. **Make defaults runtime-evaluated inside the callee body.** Rejected because it diverges from CLR/C# semantics, breaks metadata round-tripping, and complicates evaluation ordering.
4. **Restrict v1 to trailing-only omission.** Rejected because G# already has caller-side named-argument reordering, and a trailing-only rule would make optional parameters feel artificially weaker than the CLR/C# model users already know. If a parameter is optional, callers should be able to omit it and fill it by name independently of position.
5. **Include default values in signature identity.** Rejected because CLR signatures do not, documentation IDs do not, and it would make benign default changes source-breaking for overload declaration.

## Rollout plan

1. Generalize user-defined callable storage and lookup to overload sets.
2. Extend parameter syntax/symbols to carry optional-default metadata.
3. Reuse and widen the existing overload-resolution engine for user-defined candidates, replacing prefix/suffix omission assumptions with explicit parameter-slot mapping.
4. Update override/interface validation to search overload families by exact signature.
5. Emit CLR optional-parameter metadata and expand tests for overload lookup, ambiguity, sparse optional omission, named arguments, constructor overloads, interface matching, and metadata round-tripping.

### Status (post-implementation)

The initial implementation landed in PR #498. Items 1–5 above are all implemented in `Binder.cs`, `BoundScope.cs`, `StructSymbol.cs`, `InterfaceSymbol.cs`, and `ReflectionMetadataEmitter.cs`. The following follow-up gaps that were briefly deferred have since been closed:

- Instance-method call sites (`BindUserInstanceCall`) now perform overload selection by argument signature instead of "first by name."
- Method-group → delegate conversion preserves the full overload set and final selection happens in `BindConversion` against the target delegate signature.
- Multiple explicit `init(...)` constructors per class are now supported end-to-end (binding, overload resolution, emission, evaluation).
- Override-by-signature matching now correctly handles base classes that declare same-name overloads.
- Optional parameters are now accepted on free functions, instance methods, static methods, interface methods, explicit constructors, primary constructors, delegate declarations, and function literals (lambdas). Property accessors and indexers have no user-declared parameter list that admits defaults.

## References

- `src/Core/CodeAnalysis/Binding/OverloadResolution.cs`
- `src/Core/CodeAnalysis/Binding/Binder.cs`
- `src/Core/CodeAnalysis/Binding/BoundScope.cs`
- `src/Core/CodeAnalysis/Symbols/StructSymbol.cs`
- `src/Core/CodeAnalysis/Symbols/InterfaceSymbol.cs`
- `src/Core/CodeAnalysis/Documentation/SymbolDocumentationIdProvider.cs`
