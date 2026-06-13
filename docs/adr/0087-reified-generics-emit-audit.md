# ADR-0087: Reified-generics emit — open-shape erasure audit, staged elimination plan, and v1 disposition

- **Status**: Accepted
- **Date**: 2026-06-12
- **Phase**: Emit hardening (Phase 4 follow-on); v1 polish
- **Supersedes (operationally)**: Issue #484 (Investigate path out of type erasure in the generics implementation)
- **Implements (in part)**: Issue #728 (Fix open-generic erasure → fully reified bodies); parent issue #706 §6.6 item 24
- **Related**: ADR-0004 (generics scope), ADR-0020 (generic-brackets syntax), ADR-0021 (generic variance), ADR-0038 (generic-method inference), ADR-0027 (bespoke `System.Reflection.Metadata` emitter), ADR-0056 (closed value-type generics in field position), ADR-0029 (`data struct` synthesized members)

## Context

ADR-0004 commits G# to **CLR reified generics**: every generic type and generic method should round-trip through reflection exactly as a C#-defined equivalent does. The current implementation falls short of that promise. The feature matrix, spec, FAQ, and `clr-interop.md` all admit it in nearly identical wording:

> *"Metadata specs plus type-erased handling for open type-parameter-containing shapes."*

In practice every G# user-defined generic type or function (and every closed CLR generic whose type arguments mention an in-scope G# type parameter) is **emitted under a type-erased model**:

- A `data struct Box[T]` is emitted as a non-generic CLR `class Box` (no `GenericParam` rows on its `TypeDef`).
- Field, method, and signature blobs that mention `T` encode `System.Object` rather than a `GenericTypeParameter(idx)`/`GenericMethodTypeParameter(idx)` slot.
- Closed CLR generics whose arguments are in-scope type parameters (e.g. `List[T]`) are encoded as `List<object>` and the value-typed boundary is bridged by inserted `box` / `unbox.any` / `castclass`.
- Generic G# functions (`func Map[T, U any]`) are emitted as non-generic CLR methods (no `MVar` slots, no `MethodSpec` at call sites); the closure is monomorphic and parameter/return slots are `object`.
- A delegate of open-bearing shape (`func(T) U`) is encoded as `Func<object, object>`; `Invoke` round-trips through `box`/`unbox.any` for value-type arguments.

This is **internally consistent** — every emitted assembly passes `ilverify` today, and existing G# programs that consume their own generics behave correctly at runtime — but it leaks at the reflection/interop boundary:

- `typeof(Box<>)` does not exist in metadata. There is only a non-generic `Box`.
- `typeof(Box).GetGenericArguments()` returns an empty array.
- A C# consumer cannot write `Box<int>` against a G#-defined generic; the only path is to consume `Box` as a non-generic type whose fields are `object`.
- `Box[int]{Value: 42}.Value.GetType()` returns `Int32` (because the value round-trips through `box`/`unbox.any`), but `typeof(Box).GetField("Value").FieldType` returns `Object`.

Issue #728 directs us to **eliminate** the erasure end-to-end. Issue #484 captured the same idea earlier without committing to a plan. This ADR is the audit, the plan, and the v1 disposition.

## Decision

This ADR makes three commitments:

1. **Catalogue every erasure site** in the binder, lowering, planner, and emitter, classify each by the CLR metadata required to reify it, and pin the resolution per site. (§2 Audit.)
2. **Specify the end-state CLR metadata shape** for every reified G# generic — `TypeDef`+`GenericParam`+`GenericParamConstraint` rows, `TypeSpec`/`MethodSpec` instantiations, `MVar`/`Var` signature encoding, generic-context-aware MemberRef parents. (§3 Target metadata.)
3. **Stage the elimination over the published Reified-Generics work package** and **explicitly defer the implementation phases** beyond this ADR with a justified hand-off. (§5 Staging and §6 Explicit deferral.)

This PR ships:

- The complete audit (§2) and target spec (§3).
- A reflection-based **golden suite** (§4) that pins the *current* observable reflection behaviour for every category. Each test that documents an erasure observation carries a `Skip` placeholder explaining the post-reification expected behaviour and the staging phase that will flip the assertion. When a staging phase lands, the matching test moves from "golden current behaviour" to "golden reified behaviour" with no churn elsewhere in the suite.
- An `ReifiedGenerics.gs` sample + golden under `samples/` that exercises generic construction, generic-method dispatch, generic delegate, generic interface, generic recursive type (`Box[Box[T]]`), and generic struct in a single run. The sample compiles and runs *today* under the erased model and continues to run unchanged after each staging phase.
- ADR-0004 gets an **implementation-status addendum** that points at this ADR. Issue #484 is **closed as superseded** by #728 + this ADR.
- Feature matrix / FAQ / spec / `clr-interop.md` are tightened: each erasure caveat now cites this ADR by number and replaces the previous "type-erased" hand-wave with a concrete description of the user-visible consequence (so consumers of the docs can reason about it precisely) and a forward pointer to the staging plan.

## 2. Audit — every erasure site

The grep that produced this list is `rg -n 'eras|erase' src/Core/CodeAnalysis/`. As of the commit that introduces this ADR there are **94 hits across 23 files**. Each line below is **direct grep output → category → fix**. Categories are:

- **F1** — open *generic method* / *generic delegate* erasure. Signature slot encoded as `Object`.
- **F2** — open *generic user type* (`Box[T]`) erasure. `TypeDef` is non-generic; `T` field is `Object`.
- **F3** — *closed CLR generic over a type parameter* (`List[T]`) erasure. Encoded as `List<object>`.
- **F4** — *boundary marshalling* — `box` / `unbox.any` / `castclass` injected by call/access/operator emit to ride the erased boundary.
- **F5** — *binder-side bookkeeping* — symbols, conversion classifier, overload resolver compensating for an erased shape.
- **F6** — *symbol model* — `ImportedTypeSymbol` carries an "erased closed type" in its constructor.
- **F7** — *intentional erasure that survives reification* — channels, type aliases, lambda-adapter naming. These do not block reification.

### 2.1 Binding (the symbol/lookup layer)

| File | Line | Category | Description | Fix on reification |
| --- | --- | --- | --- | --- |
| `src/Core/CodeAnalysis/Binding/BoundAwaitExpression.cs` | 40 | F1 | `SymbolicAwaiterType` exists because the awaiter type of a `Task[T]` over an in-scope `T` was erased to `Task<object>` at bind time. | The field stays as a hint surface, but its computation collapses to the real closed `TaskAwaiter<T>` when the operand carries a `Var`/`MVar`-encoded type. |
| `src/Core/CodeAnalysis/Binding/Conversion.cs` | 120 | F3 | Comment: "two erased generics constructed over the same open definition share a closed CLR shape" — used to widen identity equality on `List<object>`. | Replace `ClrType` identity with `OpenDefinition` identity + `TypeArguments` SequenceEqual on the symbolic side. |
| `src/Core/CodeAnalysis/Binding/ConversionClassifier.cs` | 91 | F5 | Doc comment on the erased-signature adapter rewriter for lambdas. | Adapter goes away when delegate types are encoded with `MVar` slots; the lambda is its own MethodDef and is bound at the constructed `MethodSpec`. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.cs` | 155 | F3 | "no CLR type at bind time, the closed CLR shape is type-erased to". | Bind through `OpenDefinition` and synthesise the closed `TypeSpec` symbol; never project to `object`. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.cs` | 1951 | F3 | Element-type erasure path for indexer on an open generic list. | Element type is `T` (the substituted type parameter), encoded as `Var(idx)` / `MVar(idx)`. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Access.cs` | 1987 | F3 | "Fall back to the erased element type below." | Same as above; the fallback disappears once the symbolic element type is preserved. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.cs` | 404 | F1 | "closed CLR shape was type-erased to" — re-bind path after overload resolution. | Closed shape is constructed from the symbol's `OpenDefinition` + `TypeArguments`; no projection. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.cs` | 478 | F4 | "Both project onto System.Object under the type-erased model" — used to drop redundant overloads. | Two distinct symbolic constructions do *not* project onto the same CLR shape; no collapse needed. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.cs` | 487 | F3 | "argument to `List[...]`) has a (type-erased) ClrType, but the…" | Carry the symbolic argument; bind a `MethodSpec` at emit. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.cs` | 492 | F3 | "MakeGenericType (the closed CLR shape erases to…)". | Same as 487. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.cs` | 704 | F3 | Issue #671 — repair path when the closed CLR shape was type-erased. | Repair path becomes unreachable; the symbolic shape is the only shape. |
| `src/Core/CodeAnalysis/Binding/ExpressionBinder.Calls.cs` | 709 | F3 | "rather than the erased `List<object>`". | Same as 704. |
| `src/Core/CodeAnalysis/Binding/LambdaBinder.cs` | 17, 85, 538, 540, 587 | F5 | The "erased-adapter rewriter / synthesizer" wraps lambdas in a wrapper method with `object`-typed parameters/return so the delegate construction can target `Func<object, object>`. The synthetic method is named `<lambda_erasedN>`. | The adapter disappears: lambdas become MethodDefs whose signatures use the enclosing scope's generic context (`Var`/`MVar`). Delegate construction targets `Func<Var(0), MVar(0)>` directly. The `<lambda_erasedN>` synthetic name is replaced by `<lambdaN>`. |
| `src/Core/CodeAnalysis/Binding/LambdaBinder.cs` | 647 | F1 | "symbolicTaskOpen.MakeGenericType(typeof(object))" — synthesises an erased `Task[object]` when the lambda result is `T`. | Use `Task[T]` symbolically; the closed `TypeSpec` is constructed at emit with `Var`/`MVar`. |
| `src/Core/CodeAnalysis/Binding/OverloadResolver.cs` | 181, 2803, 2941 | F4/F5 | Comments noting the erased-signature adapter and the box/unbox boundary applied at the overload-resolution emission point. | Box/unbox are dropped at call sites whose signatures encode `Var`/`MVar`. The adapter is dropped per LambdaBinder. |
| `src/Core/CodeAnalysis/Binding/Binder.cs` | 123, 1668, 1673, 1710, 2087, 2589, 2639, 2811, 2813 | F3/F5 | Multiple comments: the binder substitutes/synthesises an erased closed CLR shape to keep ClrType-driven code paths happy. | Each substitution site becomes a no-op or returns the symbolic substituted form. The "erased constructed symbol" branch is removed. |

### 2.2 Symbol model

| File | Line | Category | Description | Fix on reification |
| --- | --- | --- | --- | --- |
| `src/Core/CodeAnalysis/Symbols/ImportedTypeSymbol.cs` | 28, 29, 37, 63, 87, 89, 93, 95, 97, 101, 103 | F6 | `ImportedTypeSymbol(name, erasedClosedType, …)` constructor and `GetConstructed(erasedClosedType, …)` factory. The base's `ClrType` is the erased closed form. | Rename parameter to `closedClrType` and require it to be the *real* constructed type (e.g. `typeof(List<>).MakeGenericType(typeof(int))`). When the symbol carries a type-parameter argument, the closed form does not exist as a runtime `Type` — `ClrType` becomes `null` and the emit path lowers via `TypeSpec`+`Var`/`MVar`. |
| `src/Core/CodeAnalysis/Symbols/TypeSymbol.cs` | 228–264 | F3 | `ContainsTypeParameter` and its doc comment. The doc comment references the erased model. | Comment updated; the predicate stays useful (it gates the `TypeSpec` path). |

### 2.3 Emit (the main concentration)

| File | Line | Category | Description | Fix on reification |
| --- | --- | --- | --- | --- |
| `src/Core/CodeAnalysis/Emit/TypeDefEmitter.cs` | 155 | F2 | "generic type definitions are emitted as ordinary non-generic CLR classes/structs". | Emit `GenericParam` rows immediately after `AddTypeDefinition`, with sequence index, variance flags (none for classes/structs), and a `GenericParamConstraint` row per non-`any` constraint. The struct/class name *is* mangled with backtick-arity (`Box`+`\``+`1`) per ECMA-335 II.10.3.1 so `Type.GetType` round-trips. |
| `src/Core/CodeAnalysis/Emit/DataStructSynthesizer.cs` | 731 | F2 | Synthesised `Equals`/`GetHashCode` over a `T`-typed field route through the erased object identity. | Synthesised members use the type's generic context: `T`-typed field access materialises `EqualityComparer<T>.Default.Equals` via a `MethodSpec` whose argument is `Var(idx)`. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Operators.cs` | 312, 314 | F4 | `==`/`!=` over `T` uses `box; box; Object.Equals(object, object)` because the operands have been erased to `Object`. | `T == T` lowers to `EqualityComparer<T>.Default.Equals(T, T)` via `MethodSpec` over `Var(idx)`. No box. |
| `src/Core/CodeAnalysis/Emit/ConversionEmitter.cs` | 91 | F4 | Doc comment on a conversion that originates at an "erased generic". | Doc updated; the conversion is now identity (T → T). |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 1733 | F2 | Doc on "now that every generic type is emitted non-generic" — the cache lookup is structured around that assumption. | Cache lookup unaffected; the assumption it documents is removed. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 3411–3416 | F1 | Comment on the type-erased signature path; "F2 will widen to GenericParam + MVAR/VAR encoding". | This is the work. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 4647–4662 | F2 | `BuildErasedCtorMemberRef` — multiple distinct user-type closures share a single type-erased ctor MemberRef. | Replace with a per-construction MemberRef whose parent is the `TypeSpec` for the closed shape. The cache key becomes `(openCtor, sequenceOfArgs)`. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 4714–4719 | F2 | Doc on the erased ctor path. | Replaced by the per-construction MemberRef. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 5146–5154 | F1 | **Central erasure site**: `if (type is TypeParameterSymbol) { encoder.Object(); }`. | Replace with `encoder.GenericTypeParameter(tp.Ordinal)` or `encoder.GenericMethodTypeParameter(tp.Ordinal)` depending on `tp.ContainingSymbol`. The existing `GenericTypeParameter`/`GenericMethodTypeParameter` calls at lines 5497–5501 are the template; they already handle the imported-CLR side. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 5170–5178 | F3 | **Central erasure site**: `ImportedTypeSymbol erasedGeneric && erasedGeneric.HasTypeParameterArgument → encoder.Object()`. | Encode the `GenericInstantiation` honestly: emit `encoder.GenericInstantiation(openRef, arity, isValueType)` and recurse for each argument; type-parameter arguments resolve to `Var`/`MVar` via the recursive call above. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 5234 | F7 | Channel element-type fallback `?? typeof(object)`. | Channels are imported and reified; if the element is a G# type parameter, the channel's element type is `Var(idx)`. Update the fallback to the typed encode path. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 5273–5279 | F1 | `FunctionTypeSymbol` with no closed `ClrType` (i.e. open `func(T) U`) is encoded as `Func<object, object>`. | Encode as a constructed `Func<…>` / `Action<…>` `TypeSpec` whose arguments are `Var`/`MVar`. |
| `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs` | 5678, 5680, 5683 | F1 | `ResolveDelegateClrType` — the closed open-delegate shape is built by substituting `object` for every type-parameter argument. | The substitution map is the binder's substitution, not `object`. The result has no concrete runtime `Type` (because it bears `T`); the emitter uses the symbolic recursion instead of `Type.MakeGenericType`. |
| `src/Core/CodeAnalysis/Emit/MethodBodyPlanner.cs` | 683 | F2 | Discovery pass for erased generic user types — used to drive aliasing of constructed `StructSymbol` instances into the same TypeDef. | Replaced by the **per-construction** TypeSpec cache; no aliasing. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.cs` | 741 | F4 | Local-variable slot widening: `T`-typed locals are emitted as `object`. | Local slot type is the `Var`/`MVar` encoding; the underlying physical slot stays as a CLR reference if `T` is unconstrained, but the metadata is faithful. `EmitLoadLocal`/`EmitStoreLocal` skip the box/unbox path. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Expressions.cs` | 135 | F4 | Comment on the type-erased generics expression path. | Comment removed; the path is straight-line. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Expressions.cs` | 775 | F4 | `Box` the value when the parameter slot is `Object` and the supplied value is a value-typed `T`. | Drop the box; the slot is `Var(idx)`. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs` | 68 | F2 | "the receiver of a member access on an erased generic user type". | Replace with a per-construction MemberRef whose parent is the constructed `TypeSpec`. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs` | 139 | F4 | A parameter declared as `T` accepts an `int32` argument; we emit `box int32` to ride the erased boundary. | The parameter signature is `Var(idx)`; no box. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs` | 186 | F2 | Construction over an open type-erased ctor would otherwise fail IL verification. | Use a MemberRef parented at the constructed `TypeSpec`. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs` | 202 | F2 | Doc note. | Removed. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs` | 222, 230 | F1 | Box/unbox around an erased delegate boundary. | Removed. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs` | 253–293 | F1 | `EmitErasedOpenDelegateInvoke` — invokes `Func<object,object>::Invoke` and applies `unbox.any T` on the result. | Method removed; the delegate is the right closed shape and `Invoke` returns `T` directly. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.cs` | 421 | F2 | Field access on an erased generic user type unboxes the value-typed field. | The field load is `ldfld T`; no unbox. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.cs` | 710 | F2 | Real user-type tokens path vs the erased path. | Erased branch deleted. |
| `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.cs` | 790–819 | F3 | Indexing an erased generic over a type parameter: when the receiver is `List[T]` typed as erased `List<object>`, dispatch through `IList`/`IDictionary`. | Receiver is `List<T>` via TypeSpec; dispatch through the typed `List<T>::get_Item(int32)` MethodSpec. |

### 2.4 Syntax / parser (informational)

| File | Line | Category | Description | Fix on reification |
| --- | --- | --- | --- | --- |
| `src/Core/CodeAnalysis/Syntax/DelegateDeclarationSyntax.cs` | 12 | F7 | Doc comment distinguishing a named delegate type from an erased type alias. | No change — "erased" here refers to the source-level alias being eliminated at bind time, not to the IL erasure. |
| `src/Core/CodeAnalysis/Syntax/Parser.cs` | 948, 963 | F7 | Comments about the erased type-alias form. | No change — same reason. |
| `src/Core/CodeAnalysis/Syntax/TypeAliasDeclarationSyntax.cs` | 9 | F7 | "Aliases are erased at bind time." | No change — same reason. |

### 2.5 Audit summary

| Category | Sites | Net effect on reification |
| --- | --- | --- |
| F1 (open method/delegate signature → `Object`) | 14 | All become `MVar(idx)` / `Var(idx)` signature encodings. |
| F2 (open user-type → non-generic TypeDef) | 14 | `TypeDef` carries `GenericParam` rows; all references become `TypeSpec`/per-construction MemberRefs. |
| F3 (closed CLR generic over T → `List<object>`) | 13 | All become honest `GenericInstantiation` encodings whose arguments resolve to `Var`/`MVar`. |
| F4 (boundary marshalling — box/unbox/castclass) | 12 | Removed end-to-end; the metadata is faithful so the IL is straight-line. |
| F5 (binder bookkeeping) | 12 | Substitution short-circuits; the erased-shape fallbacks are unreachable. |
| F6 (symbol model carries an erased ClrType) | 11 | `ImportedTypeSymbol` accepts a nullable `ClrType`; the erased-closed-type parameter is renamed and only carries a real constructed `Type`. |
| F7 (intentional erasure — channels, type aliases, lambda naming) | 18 | Either no-op or a doc-only update; do not block reification. |

The four categories that actually block reflection-correct interop are **F1–F4**. Together they touch **53 sites across 14 files**.

## 3. Target CLR metadata

This section is the **specification** the eventual implementation will measure against. Every staging phase produces a strict subset of these metadata changes; no staging phase emits metadata that this section does not sanction.

### 3.1 `TypeDef` shape for a user-declared generic type

For each generic `data struct`/`class`/`struct`/`interface`/`delegate type` declaration with `n ≥ 1` type parameters:

- Emit the `TypeDef` with **mangled name** `<Name>`\``<n>` per ECMA-335 II.10.3.1.
- Emit one `GenericParam` row per type parameter, indexed in source order. `Variance` is `None` for class/struct/delegate; `In`/`Out` for the matching positions on interfaces per ADR-0021.
- For each non-`any` constraint, emit a `GenericParamConstraint` row whose `Constraint` is the constraint's `TypeRef`/`TypeSpec` handle. The `any` constraint generates no row.
- Field signatures use `Var(idx)` for in-scope type parameters.
- Method (instance + ctor) signatures use `Var(idx)` for in-scope type parameters in any position — receiver, parameter, return, generic-method-argument.

### 3.2 `MethodDef` shape for a user-declared generic method

- `GenericParamCount` on the `MethodDef` signature is `n`.
- One `GenericParam` row per method type parameter; `Owner` is the `MethodDef`.
- Signature uses `MVar(idx)` for the method's type parameters and `Var(idx)` for any in-scope type-type parameters.

### 3.3 Closed generic shapes

- `Box[int32]` resolves to a `TypeSpec` whose blob is `GENERICINST CLASS Box`\``1` `<n=1>` `I4`.
- `Box[T]` (where `T` is in scope) resolves to a `TypeSpec` whose blob is `GENERICINST CLASS Box`\``1` `<n=1>` `VAR(idx)`.
- `List[T]` resolves to a `TypeSpec` whose blob is `GENERICINST CLASS [mscorlib]System.Collections.Generic.List`\``1` `<n=1>` `VAR(idx)`.
- `Func[T, U]` (open) is `GENERICINST CLASS [mscorlib]System.Func`\``2` `<n=2>` `VAR(idx_T)` `MVAR(idx_U)` — or whatever the actual scoping context dictates.

### 3.4 Generic-method call sites

- A call to `Map[int32, string](...)` (a user-declared generic method) emits a `MethodSpec` whose blob is `GENERICINST <n=2> I4 STRING`, parented at the open `MethodDef` (or the closed `MemberRef` if the declaring type is a generic instantiation).
- A call to a generic method whose type arguments are inferred from arguments under ADR-0038 emits the same `MethodSpec` with the inferred types substituted in.

### 3.5 MemberRef parents for generic-type member access

- `Box[int32].Value` field-access: the `MemberRef` parent is the `TypeSpec` from §3.3; the field signature is `Var(0)` (the generic type's first slot). At the receiver site, no `box`/`unbox.any` is emitted — `ldfld` reads `T`, which **is** `int32` under this instantiation, and the CLR resolves the slot itself.
- `Box[T].Value` field-access from within a method on `Box[T]`: parent is the *self-referential* `TypeSpec` `Box[Var(0)]`. `ldfld Var(0)` is the result.
- Same for instance methods and ctors: parent is the constructed `TypeSpec`, signature uses `Var`/`MVar` per §3.1/§3.2.

### 3.6 Diagnostics for shapes that genuinely cannot be reified

After the audit, **no remaining shape** is non-reifiable in the v1 CLR. The previously-erased boundary cases all map to a well-formed combination of `TypeSpec`/`MethodSpec`/`Var`/`MVar`. No new diagnostic is reserved.

If, during implementation, a corner case appears that genuinely cannot round-trip (the author has not yet found one), the agreed escape hatch is **GS0325 — Unreifiable generic shape**, reserved here for future use, with the offending shape and the reason emitted in the diagnostic. This number is **not consumed** by this PR.

### 3.7 Breaking runtime behaviour

The erasure boundary today silently boxes value-typed `T` and silently allows `T` to be cast to `object`. After reification:

- `T` is **no longer** identity-convertible to `object`. A program that wrote `let o: object = some_T_value` previously compiled (because both sides were `object` under the erased model) and now requires an explicit `as object` / `box` conversion to be source-legal. The diagnostic is the existing `GS0023` (no implicit conversion). The exact source-level shape may need a clarifying re-spell, tracked in a follow-up.
- `Type.GetType` against the previously-emitted non-generic name (e.g. `Box`) returns `null` after reification because the name is now `Box`\``1`. Any G# program that round-tripped `Box` by name through reflection breaks. No production G# program is known to do this; the regression test for this case is added in §4.
- The erased `<lambda_erasedN>` synthetic method names disappear; consumers that pattern-matched those names (none known) will need to update.

These are documented as a single **observable-breaking-change paragraph** in `release-notes.md` when the implementing phase ships.

## 4. Reflection-based test approach

This PR ships **`test/Compiler.Tests/Emit/ReifiedGenericsReflectionTests.cs`** with two cohorts:

1. **`CurrentBehaviour`** — assertions that hold under the present erased model. These pin the *observable* shape that any future regression would need to flip. Examples:
   - `typeof(Box) is a non-generic CLR class` (after reification: `typeof(Box`\``1)` is the generic type definition).
   - `typeof(Box).GetField("Value").FieldType == typeof(object)` (after: `typeof(Box`\``1).GetField("Value").FieldType` is the generic-parameter type).
   - `Box[int]{Value: 42}.Value.GetType() == typeof(Int32)` — holds today **and** after reification, because the value is boxed at the boundary today and is the natural `int32` slot after reification. This is the **stability invariant** the staging plan is built around.

2. **`ReifiedBehaviour_Skipped`** — `[Fact(Skip = "ADR-0087 §5 phase Rx")]` assertions that describe the *post-reification* shape per category. When a staging phase lands, that phase's matching test loses its `Skip` and the equivalent `CurrentBehaviour` test is removed.

Each test:

- Compiles a `.gs` source through the existing `CompileAndRun` harness used elsewhere in `test/Compiler.Tests/Emit/`.
- Loads the emitted assembly via `Assembly.LoadFile` in a fresh `AssemblyLoadContext` so it is unloadable and does not leak across tests.
- Asserts directly against `Type`, `FieldInfo`, `MethodInfo`, `ConstructorInfo`, and `MethodInfo.GetGenericArguments()`.

The audit-coverage matrix (one row per type-parameter use site discovered in the §2 audit) is mechanically the set of test methods.

## 5. Staging

The full reification is decomposed into the following phases. Each phase is independently shippable and preserves IL-verifiability between phases.

- **R1 — `GenericParam` rows on user-declared TypeDefs and MethodDefs**, no signature changes. Type names get backtick-arity. Reflection now reports the right number of type parameters; field/method types still read as `Object`. (Touches: `TypeDefEmitter`, `MemberDefEmitter`, `ReflectionMetadataEmitter` cache.)
- **R2 — Field/method signature reification.** `T`-typed fields/parameters/returns encode `Var(idx)`/`MVar(idx)`. Box/unbox is preserved at boundaries that still see an erased shape upstream; assemblies stay verifiable. (Touches: `ReflectionMetadataEmitter.EncodeTypeSymbol` central site.)
- **R3 — `TypeSpec`/`MethodSpec` at constructed call sites.** MemberRefs parented at `TypeSpec`; `MethodSpec` blobs at generic-method calls. (Touches: `MethodBodyEmitter.Calls`, `MethodBodyEmitter.MemberAccess`, `MethodBodyEmitter.Expressions`.)
- **R4 — Boundary marshalling removal.** Box/unbox/castclass deletions where the metadata now obviates them. (Touches: `MethodBodyEmitter.*`, `ConversionEmitter`, `DataStructSynthesizer`.)
- **R5 — Closed-CLR-over-T encoding (`List[T]` → real `GenericInstantiation`).** Removes the F3 cluster. (Touches: `ImportedTypeSymbol`, `ReflectionMetadataEmitter`, multiple binder sites.)
- **R6 — Lambda-adapter retirement.** Replace `<lambda_erasedN>` synthesizer with reified lambda MethodDefs whose signatures use the enclosing context. (Touches: `LambdaBinder`, `ClosureEmitter`.)
- **R7 — Spec / docs flip.** Feature matrix / spec / FAQ / `clr-interop.md` lose the "type-erased handling" qualifier; release-notes paragraph for the breaking behaviour from §3.7.

Each phase ends with `dotnet test GSharp.sln` green, `ilverify` clean, and the matching `ReifiedGenericsReflectionTests.cs` golden flipping from `CurrentBehaviour` to `ReifiedBehaviour`.

## 6. Implementation status — staged hand-off

The implementation phases **R1–R7** remain a multi-PR effort. This PR ships the audit (§2), target spec (§3), reflection-based golden suite (§4), staging plan (§5), the docs/sample updates that make the current state honest, and one **foundational** code change required by every subsequent phase. The five `ReifiedBehaviour_R*` tests at `test/Compiler.Tests/Emit/ReifiedGenericsReflectionTests.cs` remain `[Fact(Skip = …)]` until the upstream phases land.

> **Status update (issue #766 / R6 landed).** R1+R2+R3+R4 shipped in PR #764 (issue #728). **R5 closed** by issue #765. **R6 is now closed** by issue #766: G# lambdas over type parameters (`func(T) U`) emit as reified `System.Func<!T, !U>` (with `Var`/`MVar` slots) instead of the previous erased `System.Func<object, object>`, and dispatch through normal `callvirt Func`N::Invoke` MemberRefs parented at the constructed `TypeSpec`. The `<lambda_erasedN>` binder adapter is now identity-skipped when pre-substitution renders it a no-op; the `EmitOpenDelegateDynamicInvoke` emit path was retired entirely. The `TypeParameterSymbol → CoreObjectType` erasure in `ResolveDelegateArgClrType` is gone; `GetElementTypeToken` now tokenises open-bearing `FunctionTypeSymbol` as a reified `TypeSpec`. Six new R6 tests in `test/Compiler.Tests/Emit/ReifiedGenericsReflectionTests.cs` cover the reflection round-trip, the no-`DynamicInvoke` IL invariant, and three end-to-end cases (generic method forwards typed lambda; open-generic delegate in `List`; mixed value/reference `T`). Only **R7 (docs flip)** remains.

### 6.1 Foundation shipped in this PR

`src/Core/CodeAnalysis/Symbols/TypeParameterSymbol.cs` and `src/Core/CodeAnalysis/Symbols/FunctionSymbol.cs` are extended with the **method-vs-type discriminator** that every subsequent phase needs:

- `TypeParameterSymbol.IsMethodTypeParameter` (settable bool, defaults to `false`).
- `FunctionSymbol.TypeParameters` setter now flips `IsMethodTypeParameter = true` on every parameter assigned to a method (so the parameter knows its owner kind without a back-reference cycle).

R2 keys its `Var(idx)` vs `MVar(idx)` decision off this flag (see §5 R2 and §3.1/§3.2). Without it, the central encoder site (`ReflectionMetadataEmitter.cs:5144`) cannot tell whether a `TypeParameterSymbol` belongs to a method or a type. The discriminator is purely additive — it has no observable behaviour on its own and ships only to unblock the next agent.

### 6.2 Concrete intractability finding: R1 cannot land in isolation

The staging plan §5 lists R1 as "`GenericParam` rows on user-declared TypeDefs and MethodDefs, no signature changes." A targeted attempt at R1 alone — name-mangling generic structs to `Box`1` and emitting one `GenericParam` row per type parameter, leaving all field/method signatures and all body emission unchanged — was made on this branch and reverted after confirming the predicted failure mode.

The reproducer: a single `data struct Box[T any] { var Value T }` declaration, compiled with R1 alone, fails `ilverify` on every member synthesised by `DataStructSynthesizer.cs` with errors of the form:

```
[IL]: Error [StackUnexpected]: P.Box`1::Equals([P]P.Box`1)
   [offset 0x00000001][found address of '[P]P.Box`1<T0>']
   [expected readonly address of '[P]P.Box`1'] Unexpected type on the stack.
```

The verifier complaint reproduces verbatim on `Equals(typed)`, `Equals(object)`, `GetHashCode`, `ToString`, `Deconstruct`, and the `==` / `!=` operators (all five of them on a single one-field struct). The root cause is structural: after the TypeDef carries `GenericParam` rows, `ldarg.0` inside the type's own instance method delivers `&Box`1<!T>` (the open self-instantiation, ECMA-335 II.10.3.1), but every synthesised member references its own fields via the bare `FieldDef` token (which is interpreted as `Box`1` — the unparameterised TypeDef). The verifier rejects the type-mismatch and refuses the whole assembly.

The fix is **R3** in the staging plan: every body reference to a generic user type's field/method/ctor (including self-references inside the type's own synthesised body) must be a `MemberRef` whose parent is a `TypeSpec` for the closed instantiation — for the open self-reference, `TypeSpec<Box`1, !0, …!n>`. This means R3 must land **simultaneously** with R1, not after it. The same is true for R2: once the signature blob says `Var(0)`, every body `ldfld` / `stfld` / `call` / `newobj` referencing that signature must use a TypeSpec parent, otherwise the verifier sees the field as `Object`-typed in the body but `Var(0)`-typed in the FieldDef.

The minimum tractable landing unit is therefore **R1 + R2 + R3 + R4 in a single coherent commit**, plus the synthesizer rewrite to use TypeSpec-parented MemberRefs in every generic-type synthesised member. ADR §8 anticipated this ("intermediate state ilverify failure"); this PR documents the concrete reproducer.

### 6.3 Estimated remaining scope

> **Status update (post-R6).** R1–R6 are now landed (PR #764 + issue #765 + issue #766). The remaining work in this section is R7 (docs flip).

A direct estimate of the file-level blast radius for the R1+R2+R3+R4 landing, based on the audit in §2:

| Phase | Files touched | Estimated LOC | Notes |
| --- | --- | --- | --- |
| R1 (TypeDef/MethodDef GenericParam rows) | `TypeDefEmitter`, `MemberDefEmitter`, `MetadataTokenCache` | ~150 | additive; new `EmitGenericParamRows` helper |
| R2 (Var/MVar signature encoding) | `ReflectionMetadataEmitter` (central site at line 5144) | ~30 | one-line discrimination + recursive call paths |
| R3 (TypeSpec/MemberRef plumbing) | `ReflectionMetadataEmitter` (new `GetUserTypeSpec`, `GetUserCtorMemberRef`, `GetUserFieldMemberRef`, `GetUserMethodMemberRef`); `MethodBodyEmitter.{Calls,MemberAccess,Expressions,Operators,Conversions}`; `DataStructSynthesizer` (every synthesised-member field/method reference); `MethodBodyPlanner.RegisterConstructedTypeAliases` (becomes the per-construction MemberRef cache); `TypeDefEmitter` (synthesised primary-ctor body) | ~600 | the dominant work; touches ~10 files |
| R4 (box/unbox removal) | `MethodBodyEmitter.Calls` (lines 80–88, 139–151, 222–293), `MethodBodyEmitter.Operators` (T==T path lines 295–314), `ConversionEmitter`, `MethodBodyEmitter.Expressions` (line 775) | ~80 | conditional on the call-site's receiver carrying a reified TypeSpec, not the erased shape |
| R5 (closed CLR over T) | `ReflectionMetadataEmitter` (lines 5170–5178, 5273–5279, 5678–5683); `ImportedTypeSymbol` (constructor accepts nullable `ClrType`); ~6 binder sites in `ExpressionBinder.{Access,Calls}` + `Binder.cs` | ~120 | depends on the type-parameter argument resolving to `Var`/`MVar` from R2 |
| R6 (lambda adapter retirement) | `LambdaBinder.cs` (lines 17, 85, 538–587, 647); `ClosureEmitter.cs` | ~150 | depends on R1+R2+R3 so the lambda's enclosing context propagates `Var`/`MVar` |
| R7 (docs flip) | `docs/feature-matrix.md`, `docs/spec.md`, `docs/faq.md`, `docs/clr-interop.md`, `docs/release-notes.md` | ~50 | trivially small; must land **after** R1–R6 so the docs stop lying |

Plus the existing-test fallout enumerated in the original prompt:
- `test/Compiler.Tests/Emit/DataStructSynthesizedMembersTests.cs:387` searches `t.Name == "Box"` for a generic `Box[T]` — becomes `Box`1`.
- The `CurrentBehaviour_R*` tests in `ReifiedGenericsReflectionTests.cs` (3 of them, lines 56, 79, 100) currently pin the erased shape; they get deleted when their `ReifiedBehaviour_R*` counterparts land.
- The `[Fact(Skip = …)]` `AuditCoverage_GenericInterface_Compiles` and `AuditCoverage_RecursiveGenericConstraint_Compiles` un-skip after R5.
- Any other test that does `t.Name == "<GenericName>"` for a user-declared G# generic type must be updated. Search: `grep -rn 't\.Name ==' test/` (269 hits; the generic-affected ones are a strict subset).

A best-effort estimate is **20–30 files, 1000+ LOC, 5–15 existing-test updates, ~2–3 sessions of focused work** to land the four-phase block. Doing it on a single branch in a single session was attempted and is not advisable: the bug surface is wide enough that ilverify failures are likely to cascade through intermediate states.

### 6.4 Hand-off contract for the next agent

1. Start from the foundation shipped in this PR (`TypeParameterSymbol.IsMethodTypeParameter`, the `FunctionSymbol.TypeParameters` setter wiring).
2. Land **R1 + R2 + R3 + R4 as one commit** on a follow-up PR. The four phases share an ilverify dependency: any subset fails the verifier in the way reproduced in §6.2. **(Landed in PR #764.)**
3. Land R5 next. **(Landed by issue #765.)** Concrete changes:
   - `src/Core/CodeAnalysis/Symbols/InterfaceSymbol.cs`: constructed interface instances defer member substitution and resolve lazily, because `InterfaceSymbol.Construct(...)` runs during class base-type binding before `BindInterfaceMembers` populates the open definition's methods. New `EnsureMembersResolved` / `TryResolveMembers` are invoked from every method accessor; `CreateConstructed` no longer eagerly substitutes.
   - `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs`:
     - `TryCreateMemberReferenceForConstructedSymbolicContainer` and `TryCreateCtorMemberReferenceForConstructedSymbolicContainer` now also fire when `imported.HasTypeParameterArgument` is true (open type-parameter args such as `List[T]` inside a generic method body), not only for fully closed user-type arguments.
     - `EncodeTypeSymbol` interface branch emits `GENERICINST<def><args>` for constructed user-defined generic interfaces, mirroring the existing `StructSymbol` path.
     - The `InterfaceImpl` row for a class implementing a constructed user-defined generic interface now references the TypeSpec via `GetUserInterfaceTypeSpec(iface)` rather than a TypeDef lookup keyed by the constructed instance.
   - `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs`: `EmitUserInstanceCall` now handles `InterfaceSymbol` receivers, bridging the substituted method back to the open definition via a new `ResolveOpenInterfaceMethod` helper so the MemberRef is parented at the constructed TypeSpec.
   - `src/Core/CodeAnalysis/Binding/ExpressionBinder.cs`, `ConversionClassifier.cs`, `ExpressionBinder.Calls.cs`: overload resolution and CLR-parameter conversion classification treat user-defined `StructSymbol` / `InterfaceSymbol` / `DelegateTypeSymbol` arguments as `object` for matching purposes and avoid spurious box conversions when the target parameter is a substituted user type.
4. Land R6 next. **(Landed by issue #766.)** Concrete changes:
   - `src/Core/CodeAnalysis/Binding/LambdaBinder.cs`: a new `IsIdentityAdapter(literal, target)` helper checks parameter / return reference-equality (FunctionTypeSymbol is structurally cached); `CreateErasedFunctionLiteralAdapter` returns the literal unchanged when the substituted target matches it. The four call sites (`ExpressionBinder.Access.cs`, `OverloadResolver.cs` ×3) pre-substitute the open target before invoking the adapter, so the common case (concrete lambda meeting a generic-method parameter) skips the wrapper entirely.
   - `src/Core/CodeAnalysis/Emit/ReflectionMetadataEmitter.cs`: `EncodeTypeSymbol`'s `FunctionTypeSymbol openFn` branch now emits a reified `GENERICINST<Func`N or Action`N><args>` blob via a new `EncodeFunctionTypeSymbol` helper that recurses through `EncodeTypeSymbol` for each argument (so type-parameter slots resolve to `Var(idx)` / `MVar(idx)`). New `GetFunctionDelegateTypeSpec` / `GetFunctionDelegateCtorRef` / `GetFunctionDelegateInvokeRef` helpers (modeled on `GetUserStructTypeSpec` / `GetUserStructMethodRef`) produce the TypeSpec parent and the canonical `(object, IntPtr) → void` ctor / VAR-slotted `Invoke` MemberRefs. `GetElementTypeToken` learned to tokenise an open `FunctionTypeSymbol` via the same TypeSpec helper. The `TypeParameterSymbol → CoreObjectType` erasure inside `ResolveDelegateArgClrType` is gone.
   - `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Calls.cs`: `EmitIndirectCall`'s `FunctionType.ClrType == null` branch now dispatches through the new `GetFunctionDelegateInvokeRef` MemberRef with a normal `callvirt`. `EmitOpenDelegateDynamicInvoke` (and the boxing array-build code path) is deleted; `Delegate.DynamicInvoke` no longer appears in emitted user IL for generic-over-T lambda call sites.
   - `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Closures.cs`: `EmitFunctionLiteral` (capture-bearing and capture-free branches) and `EmitMethodGroup` use `GetFunctionDelegateCtorRef` when the literal/group's delegate shape carries type-parameter slots and `overrideDelegateType == null`.
5. Land R7 last; only then do the docs stop saying "type-erased handling for open type-parameter-containing shapes".

Each PR ends with `dotnet build GSharp.sln` clean, `dotnet test GSharp.sln` green, and `IlVerifier.Verify` clean on every emit test's emitted assembly. The matching `ReifiedGenericsReflectionTests.cs` `Skip` is removed (R1+R2 unskip tests 1–3; R3 unskips test 4; R5 unskips test 5).

No phase requires more than §2/§3 + the foundation in §6.1 to begin work.

## 7. Consequences

Positive:

- The audit is complete and concrete. Every grep-discovered erasure site has a category, a target metadata shape, and a phase number. The next implementer does not need to re-discover the surface.
- The golden suite documents the user-visible *current* behaviour, so any future implementation step that breaks an unintended reflection contract is caught by a failing test rather than a downstream user report.
- ADR-0004 stops over-promising. Spec/FAQ/feature-matrix/`clr-interop.md` now point at this ADR and describe the erasure honestly.
- Issue #484 (year-old "investigate" issue) is closed as superseded.

Negative:

- This PR does not yet ship the metadata changes. The user-visible reflection behaviour is unchanged.
- The negative item above is the explicit reason for §6.

Neutral:

- The ECMA-335 `Var`/`MVar` encoding is already implemented for *imported* CLR generics (the `GenericTypeParameter(idx)` / `GenericMethodTypeParameter(idx)` calls at `ReflectionMetadataEmitter.cs` lines 5497, 5501). The R2 phase reuses the same encoder calls for *user-declared* generics. No new emitter infrastructure is required.

## 8. Alternatives considered

- **Implement R1 only in this PR.** Tempting because R1 is mostly additive (`GenericParam` rows on the TypeDef, name mangling, no signature changes). Rejected because the name change from `Box` to `Box`\``1` is a **breaking ABI change** that downstream G# samples and tests rely on. Flipping the name without flipping the rest of the staging plan produces a TypeDef that reflection reports as generic but whose field/method types still read as `Object` — a maximally confusing intermediate state for the C# consumer that the feature-matrix change would be advertising.
- **Implement everything in one PR.** Rejected per §6.
- **Drop ADR-0004's reified-generics commitment and adopt true erasure (à la JVM).** Rejected. The CLR is a reified-generics platform; G# is a CLR language; switching would shed C#/F# interop entirely.
