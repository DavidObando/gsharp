# ADR-0146: Anonymous-object literal (`object { ... }`, Kotlin-style)

- **Status**: Accepted (revised under issue #2243 — hard-breaking redesign of the unreleased issue #2224 shape)
- **Date**: 2026-XX-XX
- **Implementation amendment**: 2026-09-21 — aligned rich-object binding and construction with accepted ADR-0189
- **Related**: ADR-0029 (`data struct`/`data class` synthesized members — Equals/GetHashCode/ToString/Deconstruct/op_Equality contract the `data object` variant reuses verbatim); ADR-0051 (auto-property backing-field/accessor emission); ADR-0078 (declaration-head spelling); ADR-0115 (cs2gs C#→G# construct mapping, §B.4 tuple lowering this feature supersedes for anonymous objects); ADR-0141 (expression-tree lambda conversions and their construct restrictions, GS0473); ADR-0189 (literal-site rich-object inference, lexical capture, and construction planning)
- **Implementation**: Issues [#2224](https://github.com/DavidObando/gsharp/issues/2224), [#2243](https://github.com/DavidObando/gsharp/issues/2243), and [#4329](https://github.com/DavidObando/gsharp/issues/4329); see `AnonymousTypeCache` (`src/Core/CodeAnalysis/Binding/AnonymousTypeCache.cs`), `BindAnonymousClassExpression` (`src/Core/CodeAnalysis/Binding/ExpressionBinder.Literals.cs`), rich shell/plan synthesis (`SynthesizeAnonymousClassDeclaration` and `BindRichAnonymousObject` in `src/Core/CodeAnalysis/Binding/Binder.cs`), generated-rich constructor stores (`src/Core/CodeAnalysis/Emit/ConstructorBodyEmitter.cs`), `ParseAnonymousClassExpression` (`src/Core/CodeAnalysis/Syntax/Parser.cs`), and `TranslateAnonymousObjectCreation` (`tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.cs`).

## Context

Issue #2224 shipped a first, deliberately minimal anonymous-class literal — just enough to unblock cs2gs-translated EF Core migrations. Its shape was `object { let Name Type = expr, let Age Type = expr }`: comma-separated members, each with a **mandatory** type annotation, and no support for methods, events, interfaces, or base classes. That feature was never released.

Issue #2243 replaces it with a richer, Kotlin-inspired design. Because #2224 was never released, this is an intentional **hard-breaking** change: the comma-separated, type-mandatory shape is removed entirely, not preserved for back-compat.

The new requirements:

1. Members are separated the way the rest of the language separates statements — by newline or semicolon — **not** by comma.
2. Field types are **optional**: `let Name = "David"` infers the type from the initializer, exactly like an ordinary `let` local; `let Flag bool = true` keeps the explicit-type-wins behavior.
3. `object : Interface { ... }` and `object : Base(args) { ... }` let an anonymous object implement an interface or extend a base class, overriding/implementing members.
4. Anonymous objects may declare fields, properties, methods, and events — but **not** `init` or `deinit`.
5. A `data object { ... }` variant carries value semantics (Equals/GetHashCode/ToString/Deconstruct) and supports `mydata with { Name = "Amelia" }`.
6. Kotlin-style visibility narrowing: a local/private binding keeps full access to custom members; a public/protected binding narrows the exposed type to the declared supertype (or the top reference type `object` if none).

## Decision

### Syntax

The literal is a primary expression in one of these shapes:

```gsharp
// field-only (types inferred or explicit, freely mixed)
let myData = object {
    let Name = "David"
    let Language = "GSharp"
    let Flag bool = true
    let Number int = 42
}

// implementing an interface
let listener = object : MouseListener {
    func onClick() { Console.WriteLine("Button clicked!") }
    func onHover() { Console.WriteLine("Button hovered!") }
}

// extending a base class (with base-constructor arguments)
let dog = object : Animal("Fluffy") {
    override func SaySomething() string -> "woof!"
}

// value-semantics variant, supporting `with`
let mydata = data object { let Name = "David"; let Language = "GSharp" }
let otherData = mydata with { Name = "Amelia" }
```

`object` is a contextual identifier (also the universal reference-type name). It is recognized as the lead-in to this literal only in the precise `object {` or `object :` shape, optionally preceded by the `data` contextual keyword (`data object`). `IsAnonymousClassLiteralStart` in `Parser.cs` encodes this one/two-token lookahead; every other position (a bare `object` type name, `object` as an ordinary identifier) continues to lex and parse exactly as before. Members are separated by newline or an explicit `;` — the same convention ordinary class/struct bodies use — and commas are no longer accepted.

New/revised syntax nodes: `AnonymousClassExpressionSyntax` (the literal — now carrying an optional `data` keyword, an optional `: Base(args), IFace...` clause, and an ordered `ImmutableArray<SyntaxNode> Members`) and `AnonymousClassMemberInitializerSyntax` (a field member, `let`/`var` with an **optional** type clause). Method members reuse `FunctionDeclarationSyntax` and event members reuse `EventDeclarationSyntax` verbatim, so no new member-node kinds — and no new `SyntaxKind` values — were introduced.

### Binding: a two-path (split) architecture

The central design decision is that anonymous objects fall into two structurally different categories, each mapped to the emission pipeline that already exists for it:

**(a) Field-only objects** (`object { ... }` / `data object { ... }` with only field members, no methods, events, or base type) are synthesized at the symbol level by `AnonymousTypeCache`, keyed by the ordered `(name, type-identity)` shape so identical shapes unify within a compile pass. This is the value-type path carried over from #2224:

- A `data object` synthesizes a `StructSymbol` with `IsData = true` whose members are **public readonly fields**. It binds to `BoundStructLiteralExpression`, so `DataStructSynthesizer`'s `Equals`/`GetHashCode`/`ToString`/`Deconstruct`/`op_Equality` and the `with`-copy lowering (`LowerCopyOrWith`, which enumerates `structType.Fields`) work unchanged.
- A plain `object` synthesizes a `StructSymbol` with `IsData = true` whose members are **get-only auto-properties** (each with a private readonly backing field) and binds to `BoundConstructorCallExpression`. The property shape is required so reflection-based consumers that look for `PropertyInfo` (EF Core's model builder, `ClrPropertyGetterFactory`, most reflection ORMs) recognize the members. `IsData = true` is retained even for the plain variant so `ReflectionMetadataEmitter` reserves a `newobj`-callable primary-constructor row for the property-only type.

Each field member's type is bound via the same type-clause binder used for `let`/`var` (`Binder.BindTypeClause`); when the type clause is **omitted**, the type is inferred from the converted initializer expression, exactly as `StatementBinder.BindVariableDeclaration` infers an ordinary `let x = expr`. Declared type wins when present.

**(b) Rich objects** (any object with a base type, an interface, a method, or an event member) use a synthetic class shell named `<>AnonClass{n}` and reuse the ordinary named-class symbol, verification, and metadata-emission pipeline. The pre-pass in `Binder.BindGlobalScope` (`CollectRichAnonymousObjectDeclarations` → `SynthesizeAnonymousClassDeclaration`) predeclares that shell and records stable syntax→symbol identity so recursive references, generic owner parameters, interface verification, virtual/`override` checking, and repeated binding/emission see one declaration.

ADR-0189 replaced the original relocation semantics. Field initializers and base-constructor arguments are now bound at the **literal site**, omitted rich-field types are inferred there, and member bodies bind against their original lexical scope. Free variables become private hidden capture state; mutable variables share managed cells with sibling closures. The completed `RichAnonymousObjectPlan` supplies one ordered constructor argument vector containing captures, base arguments, and snapshot values. A generated-rich-object constructor/store plan initializes hidden capture/snapshot state before the selected base constructor while leaving ordinary named-class constructor ordering unchanged. Unsupported borrowed, by-ref, pointer, scoped, or ref-like retention receives a diagnostic instead of an illegal heap field.

The literal therefore binds to a `BoundConstructorCallExpression` over the constructed synthetic shell with the planned arguments—not a zero-argument construction over relocated expressions. Missing interface members and invalid overrides still use the same diagnostics as named classes, while the literal-site inference/capture and pre-base store plan are dedicated rich-object binding/emission steps.

The synthesized class is a **reference type** (`IsClass`), matching Kotlin's anonymous objects, which is the correct target now that methods, events, interface implementation, and base-class inheritance — all class features — are in scope.

Because the rich map is populated during `BindGlobalScope` but completed during the separate `BindProgram` pass, the syntax→symbol map is snapshotted onto `BoundGlobalScope.RichAnonymousClassMap` and rehydrated onto the program scope. Completed plans and generated method bodies are registered during body binding; incremental body reuse is bypassed for bodies containing rich literals so those side effects are reconstructed on every program bind. `BoundProgram.Structs` is the union of user-declared structs, field-only `AnonymousTypeCache` symbols, and synthesized rich class shells.

### Diagnostics

- **GS0485** — `init`/`deinit` members are rejected inside an anonymous object (they are explicitly out of scope for this feature).
- **GS0486** — historical rich-field explicit-type diagnostic. ADR-0189
  (accepted and implemented on 2026-09-20) replaces this limitation with
  literal-site inference and `GS0605` for genuinely uninferable shapes.

Interface-implementation and invalid-`override` errors reuse the existing named-class diagnostics unchanged, since rich objects go through the named-class binder.

### Entry-point return-type inference fix

`InferTopLevelEntryPointReturnType` (which scans top-level statements for `return` shapes to type the synthesized `<Main>$`) descended into the method bodies of an `object { ... }` literal and mistook a member method's `return`/expression-body `->` for a top-level return — inferring a non-void entry point, which then dropped its trailing `ret` and produced invalid IL. The walker now stops at `AnonymousClassExpressionSyntax` boundaries (parallel to how it already stops at lambda boundaries), since those members' returns belong to the synthesized members, not to `<Main>$`.

### cs2gs translator

C# anonymous types (`new { A = x, B = y }`) are always property-only with no methods, events, or inheritance, so cs2gs only needed the member-separator change: `TranslateAnonymousObjectCreation` / `GSharpPrinter` now emit `object { let A T = x; let B T = y }` (semicolon-separated) instead of the old comma-separated form. The translator deliberately prints each inferred C# property type for deterministic cross-language output even though native G# literals also permit omission and inference. Member-name inference, expression-tree `NewExpression.Members` `PropertyInfo` handling, and the `!!` non-null-forgiveness skip are otherwise unchanged from #2224.

## Deviations and deferrals

1. **Kotlin visibility narrowing is now implemented.** G# named function/method return types (like fields and properties) are always explicit, with exactly one existing exception: the `-> expr` expression-bodied shorthand (ADR-0131) treats an *omitted* return-type clause as `void`, evaluating `expr` as a discarded statement. This design adds a second, narrow exception: when the omitted-type arrow body is *exactly* an anonymous-class literal — `func make() -> object { ... }` / `func make() -> object : Base { ... }` (recognized at parse time by `Parser.IsAnonymousClassLiteralStartAfterArrow`, mirroring the existing literal lead-in check) — the declaration is value-returning, and its return type is inferred from the literal instead of defaulting to void:
   - **Local/private/internal declarations** (and, unaffected by this feature at all, a `let`/`var` local bound directly to the literal) retain the actual synthesized anonymous type, so custom fields/methods/events stay reachable.
   - **Public/protected declarations** — a public API boundary — narrow the exposed return type to the literal's declared supertype (the `: TypeName` clause) if present, or to the universal top type `object` (`TypeSymbol.Object`) if absent, so a caller cannot reach the anonymous type's custom members through the call result. Every other return-type-omitted declaration (any shape other than a bare arrow-returned anonymous-class literal) is untouched and still resolves to `void`, so this is additive, not a behavior change to ADR-0131.

   Any *explicitly*-typed declaration (a function/method/property whose return type is spelled out, e.g. `func make() SomeInterface { ... }`) already got this narrowing "for free" before this change: the declared type, not the richer literal type, is what the call expression resolves to, via ordinary return-type conversion. The new machinery only had to cover the *omitted*-type case, since that is the only place a full, un-narrowed anonymous type could otherwise leak across a public/protected boundary.

   **Implementation**: `DeclarationBinder.InferAnonymousClassLiteralReturnType` is the single, reusable hook, called from every named-function/method return-type computation site (free functions, instance methods, static methods) right after `bindReturnTypeClause`/`resolveAccessibility`. For the private/internal "retain full type" branch, it looks up the literal's already-synthesized class in `RichAnonymousClassMap` — populated by the ADR-0146 rich-anonymous-object pre-pass, which runs before any function/method declaration is bound, so the type is guaranteed to already be available. This only covers *rich* literals (a base/interface clause, a method, or an event); a field-only literal's type is synthesized lazily during body binding (via `AnonymousTypeCache`), so it is not yet known at declare time and this narrow return-type-inference path falls back to `object` for that shape — a `let v = object { ... }` local binding (never touched by this narrowing) is the way to keep full access to a field-only anonymous literal from a private/internal function; only field-only literals returned as the sole body of an omitted-type-return **private** function are affected by this residual limitation, and public/protected field-only returns are unaffected since they always narrow to `object` regardless. No other property/field surface in G# supports omitted-type inference today, so no other hook point was needed (deviation 2 below and ADR-0131 both keep property/field types mandatory).

   The placeholder test (`AnonymousClassExpressionTests.PublicApiBoundary_NarrowsToDeclaredSupertypeOrObject`) is no longer skipped and asserts the public/no-supertype case; `PublicApiBoundary_WithDeclaredSupertype_NarrowsToThatSupertype`, `PrivateFunction_ReturningAnonymousClassLiteral_RetainsFullAccess`, and `LocalVariable_BoundDirectlyToAnonymousClassLiteral_RetainsFullAccess` cover the declared-supertype, private, and local-binding cases respectively.

2. **Historical: rich anonymous objects required explicit field types
   (GS0486).** ADR-0189 lifts this deviation by binding rich initializers at the
   literal site and inferring heap-storable field types. `GS0605` now covers
   ambiguous/untyped/ref-like cases.

3. **Historical: rich initializers and base arguments had to be self-contained.** The original issue #2243 implementation relocated those expressions into the synthesized top-level declaration. ADR-0189 (accepted and implemented on 2026-09-20) replaces that behavior with literal-site binding, lexical capture, inferred snapshot fields, and an ordered generated constructor/store plan. Enclosing locals and admitted persistent managed handles are supported; borrowed, scoped, pointer, and ref-like retention remains deliberately rejected.

4. **Interface members are implemented with plain `func`, not `override`.** This follows G#'s existing named-class convention (using `override` for an interface method is GS0183); base-class overrides do use `override`, and the base class/method must be `open`. This is the language's existing rule, not a new restriction, and the desugar relies on it.

5. **Cross-pass shape unification** (carried over from #2224): identical field-only shapes appearing in both the `BindGlobalScope` and `BindProgram` passes unify separately (two individually-correct synthesized types) rather than as one.

6. **`data object` `ToString()`** follows ADR-0029's Kotlin-style format (`Name(F1=v1, F2=v2)`), reusing the existing synthesized `ToString` rather than C#'s `{ F1 = v1 }` anonymous-type format.

## Consequences

Positive:

- The richer design is fully functional end-to-end (verified by runtime tests that compile, emit, load, and execute G# programs): field inference, interface implementation callable through both the anonymous and interface-typed references, base-class override, `data object` value equality / `ToString` / `with`-copy, event members, and the init/deinit / missing-impl / invalid-override diagnostics.
- Rich objects reuse named-class symbols, interface/override verification, and ordinary type/member metadata emission. ADR-0189 adds only the dedicated machinery required for literal-site inference/capture, stable plan registration, and generated pre-base snapshot/environment stores; it does not globally change named-class construction.
- `data object` reuses the entire ADR-0029 synthesized-member contract verbatim.
- The field-only path preserves the #2224 EF Core scenario (property-only anonymous types with populated `NewExpression.Members`) unchanged.
- No new `SyntaxKind`/`BoundNodeKind` values were introduced, so the coverage-matrix golden is unaffected.

Negative / follow-ups:

- **Kotlin visibility narrowing is implemented** (deviation 1), with one residual, documented limitation: a **field-only** anonymous literal returned (via the omitted-return-type arrow shorthand) from a **private/internal** function falls back to `object` rather than its full synthesized type, since that shape's type is not yet known at declare time; a `let`/`var` local binding is unaffected and always retains full access.
- ADR-0189 (2026-09-20) lifts the rich-field inference and lexical-capture
  deviations, including literal-site base arguments and generated pre-base
  snapshot/environment stores.
- The split between a value-type field-only path and a reference-type rich path means two structurally identical-looking literals (`object { let A int = 1 }` vs `object : I { ... }`) synthesize different kinds of CLR type; this is intentional (Kotlin semantics differ by capability) but worth noting for future readers.
