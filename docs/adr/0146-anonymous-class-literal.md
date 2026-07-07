# ADR-0146: Anonymous-class-literal expression (`interface { ... }`)

- **Status**: Accepted
- **Date**: 2026-XX-XX
- **Related**: ADR-0029 (`data struct`/`data class` synthesized members — Equals/GetHashCode/ToString/Deconstruct/op_Equality contract this feature reuses verbatim); ADR-0078 (declaration-head spelling); ADR-0115 (cs2gs C#→G# construct mapping, §B.4 tuple lowering this feature supersedes for anonymous objects); ADR-0141 (expression-tree lambda conversions and their construct restrictions, GS0473)
- **Implementation**: Issue [#2224](https://github.com/DavidObando/gsharp/issues/2224); see `AnonymousTypeCache` (`src/Core/CodeAnalysis/Binding/AnonymousTypeCache.cs`), `BindAnonymousClassExpression` (`src/Core/CodeAnalysis/Binding/ExpressionBinder.Literals.cs`), `TranslateAnonymousObjectCreation` (`tools/cs2gs/Cs2Gs.Translator/CSharpToGSharpTranslator.cs`)

## Context

cs2gs previously lowered a C# anonymous object creation (`new { A = x, B = y }`) to a G# positional tuple literal `(x, y)` (ADR-0115 §B.4), because G# had no anonymous-type construct of its own. This broke real-world translated code in two ways:

1. **Tuple literals are illegal inside G# expression-tree lambdas** (GS0473, ADR-0141), while C# anonymous types are legal there. Any C# code using `new { ... }` inside a `Expression<Func<...>>`-typed lambda — the canonical case being EF Core's `HasKey(x => new { x.Id, x.Alias })` / `HasIndex(...)` fluent configuration — became illegal G# after translation, even though the source C# compiled fine.
2. **The lowering lost named-member structure.** `x.Id` became `x.Item1`; this is semantically wrong for any code that depends on the real member name (EF Core's key/index selectors inspect the projected member names via the expression tree, not just positional shape).

The repo owner's explicit design direction (issue comment) was: give G# a first-class anonymous-class-literal expression, `interface { Name = "Foo", Age = 42 }`, reusing the `interface` keyword in expression position (G# already uses `interface` as a type-declaration keyword; the two uses are unambiguous by lookahead — see Decision). gsc must synthesize a real backing type per distinct member shape (name + type, order-sensitive), unifying identical shapes within one compile pass — the same "structural type identity, real synthesized CLR type" model Roslyn uses for its own `<>f__AnonymousType0<...>` types.

## Decision

### Syntax

`interface { Name1 = expr1, Name2 = expr2, ... }` is a primary expression. Disambiguation from the existing type-declaration form (`interface Name { ... }`) is by one-token lookahead: a type declaration always requires an identifier immediately after `interface`; `interface` directly followed by `{` is unambiguously the anonymous-class-literal form. No further context is needed.

New syntax nodes: `AnonymousClassExpressionSyntax` (the literal) and `AnonymousClassMemberInitializerSyntax` (`Name = value`, modeled on the existing `FieldInitializerSyntax` but using `=` instead of `:`).

### Binding: reuse of `data class` (ADR-0029), not a new type-symbol kind

Rather than introducing a new `TypeSymbol`/`BoundNodeKind` pair, an anonymous-class literal is bound as a **synthesized `StructSymbol`** with `IsData = true`, `IsClass = false` (a value type — see Deviations below), and public readonly fields matching each member, reusing the **existing** `BoundStructLiteralExpression` / `BoundNodeKind.StructLiteralExpression` bound node. This means the entire ADR-0029 synthesized-member pipeline (`Equals`/`GetHashCode`/`ToString`/`Deconstruct`/`op_Equality`, driven off `StructSymbol.Fields`) and the emitter's `Program.Structs`/`IsData`-gated TypeDef/field/ctor planning apply with **zero emitter code changes**.

`AnonymousTypeCache` (`internal sealed class`, `GSharp.Core.CodeAnalysis.Binding`) is a per-compile-pass cache keyed by the ordered `(name, type-identity)` shape (via the existing `FunctionTypeSymbol.AppendIdentityKey` helper, already used for tuple/function-type identity). `GetOrCreate` synthesizes a `StructSymbol` named `<>AnonymousType{n}` (Roslyn-style, `Declaration: null`) on first use of a shape and returns the cached one on subsequent uses of the *same* shape within the pass — this is the "unify identical shapes" requirement.

The cache lives on `BoundScope` (`GetAnonymousTypeCache()`, walking to the scope chain's root), so every `Binder` sharing one root scope shares one cache. Because `Binder.BindGlobalScope` and `Binder.BindProgram` are two separate passes, each deriving its own scope chain from the same `BoundGlobalScope`, `BoundProgram.Structs` is the union of: `globalScope.Structs` (user-declared) + `globalScope.AnonymousTypes` (captured at the end of `BindGlobalScope`) + the `BindProgram`-phase cache's symbols (captured at the end of `BindProgram`). See Deviations for the known limitation this union introduces.

### `interface { ... }` inside expression-tree lambdas (the actual GS0473 fix)

`ExpressionTreeRestrictionValidator` (ADR-0141) previously had no allow-case for `BoundStructLiteralExpression`, so it fell through its default catch-all and reported GS0473 for *any* struct literal inside an expression-tree lambda — including our new anonymous-class literal. A case validating each member initializer's value expression (mirroring the existing object-initializer allowance) was added; struct/anonymous-class literals are now legal inside expression trees, matching C#'s treatment of both `new { ... }` and object-initializer expressions.

`ExpressionTreeLowerer` (which lowers a bound expression tree into `System.Linq.Expressions` factory calls) also had no case for `BoundStructLiteralExpression`. A `BuildStructLiteralExpression` method was added, lowering to `Expression.New(ctor, args)` — exactly like the existing `BuildUserConstructorExpression` does for an explicit constructor call — since the synthesized primary constructor's parameter order always matches `Initializers` order (both are built directly off `StructSymbol.Fields`).

### cs2gs translator

`TranslateAnonymousObjectCreation` now emits an `AnonymousClassLiteralExpression` G# code-model node (`interface { Name = value, ... }`) instead of a `TupleLiteralExpression`. Member names follow C#'s own anonymous-type name-inference rule: the explicit `Name = expr` form uses `Name` directly; otherwise the name is inferred from the source expression (a bare identifier, or the last segment of a member access — e.g. `new { x.Id }` names the member `Id`).

Because member names are now preserved, the previous `TranslateMemberAccess` rewrite of a named anonymous-type member access to a positional `.ItemN` (added for the tuple lowering) is removed — `x.Id` now stays `x.Id`. The existing "skip `!!` non-null-forgiveness for anonymous-type receivers" rule (the receiver is a G# value type and can never be null) is retained, updated only in wording (anonymous-class literal, not tuple).

## Deviations from a literal C#-parity reading of the issue

Two simplifications were made in favor of maximal reuse of the existing `data class`/`data struct` pipeline (ADR-0029) rather than adding new emitter machinery. Both are safe for the reported EF Core scenario (equality/shape-based projection, not reference identity) but are documented here as known, deliberate trade-offs:

1. **Members are public readonly fields, not auto-properties.** C#'s anonymous types expose real get-only properties (`PropertyInfo`); ADR-0029's synthesizer is driven entirely off `StructSymbol.Fields` (`FieldInfo`), with no property-based path. Reflection-heavy consumers that specifically require `PropertyInfo` (rather than `FieldInfo`) when inspecting a projection's shape could observe a difference. Not yet verified against a real EF Core `PropertyInfo`-based code path — flagged as a follow-up risk.
2. **The synthesized type is a value type (`IsClass: false`), not a reference type.** C#'s anonymous types are classes. `DataStructSynthesizer`'s `Equals`/`GetHashCode` emission assumes a value-type struct (its own internal asserts guard `!structSym.IsClass`) and does not yet support a reference-type `data class` target; using `IsClass: true` was tried first and produced silently-wrong `==` results (boxing/unboxing mismatch), so `IsClass: false` was chosen instead. This gives value (not reference) semantics — acceptable for shape/equality-based LINQ and EF Core projection use, but a caller relying on reference identity of an anonymous value across two variables would observe a difference from C#.
3. `ToString()` follows ADR-0029's existing Kotlin-style format (`Name(F1=v1, F2=v2)`), not C#'s anonymous-type format (`{ Name = v1, Age = v2 }`) — again, no new emitter code, reusing the existing synthesized `ToString` verbatim.

### LSP hover / completion

Because the anonymous-class literal binds to a real `StructSymbol`, member-access hover and dot-completion (`x.Name`) work automatically through the existing struct-member hover/completion code paths — no changes were needed there. The one gap addressed: hovering a *variable* of an anonymous-class type showed only the synthesized type's unnameable name (`<>AnonymousType0`), with no way to see its shape (the type has no source declaration to separately hover). `SymbolDisplay.FormatType` gained a case recognizing a synthesized anonymous `StructSymbol` (via its `<>AnonymousType` name prefix and null `Declaration`) and rendering its member shape inline (`{ Name: string, Age: int32 }`), exactly parallel to the existing `TupleTypeSymbol` case that expands `(T1, T2)` inline for the same "no separate declaration to hover" reason.

## Consequences

Positive:

- Fixes the reported EF Core migration scenario: `HasKey`/`HasIndex`/`CreateTable` shape selectors translated from C# no longer hit GS0473, and named-member access (`x.Id`) is preserved end-to-end.
- Zero emitter changes: the entire feature rides on ADR-0029's existing synthesized-member contract and the emitter's existing `Program.Structs`/`IsData` planning.
- Structural unification within a compile pass matches the issue's explicit ask and Roslyn's own anonymous-type caching model.

Negative / follow-ups:

- The two deviations above (fields not properties; value type not reference type) are real semantic differences from C# anonymous types. If they surface as real interop problems, `DataStructSynthesizer` would need a reference-type (`IsClass: true`) synthesis path, which is out of scope for this change.
- Identical anonymous shapes appearing in both the `BindGlobalScope` and `BindProgram` binding passes (top-level statements vs. function/method bodies) currently unify separately (two distinct but individually-correct synthesized types) rather than as one — a narrow, documented limitation, not the EF Core scenario (which lives entirely inside method bodies).
